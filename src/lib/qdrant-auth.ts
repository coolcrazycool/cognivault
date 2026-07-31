import { request } from 'node:https';
import type { QdrantTlsMaterial } from './qdrant-tls.js';

/**
 * JWT acquisition for Platform V Vector DB — the Sber wrapper around Qdrant that
 * answers on the "external Qdrant" endpoint.
 *
 * It is NOT raw Qdrant: there is no UI, the transport is mTLS-only, and requests to
 * the database are authorised by a JWT rather than by an `api-key`. The token comes
 * from a separate IAM service:
 *
 *   POST <authUrl>  Content-Type: application/json
 *   {"username": "<ТУЗ>", "password": "<пароль доменного пользователя>"}
 *   → 200 {"result":{"token":"eyJ0eXAiOiJKV1Q…"}}
 *
 * and is then sent to the database as `Authorization: Bearer <token>`.
 *
 * PORT. Confirmed on the live stand: IAM answers on the DATABASE port (6433), so the
 * `${origin(QDRANT_URL)}/auth` default is correct there. Older Vector DB (< 2.0.0)
 * puts IAM on 6533 (REST) / 6534 (gRPC), hence `QDRANT_AUTH_URL` stays configurable.
 *
 * TRANSPORT. Deliberately `node:https` with explicit TLS material instead of `fetch`:
 * the global `tls.connect` interception (qdrant-tls.ts) is scoped to the QDRANT_URL
 * host:PORT, so it does NOT fire when IAM lives on a different port. Passing the
 * certificate here makes both layouts work identically. When the ports do coincide,
 * the interceptor merely re-applies the same material — harmless.
 *
 * SECRETS. The password, the token and the key material must never reach a log line
 * or an error message. Error `detail` carries a truncated response body with any
 * verbatim occurrence of the password redacted; the token is only ever described by
 * its length and expiry.
 */

/** Vendor default when the token carries no `exp`: "время жизни токена — 1 час". */
const DEFAULT_TOKEN_TTL_MS = 3_600_000;

/** Attempts per token request (the first one plus two retries). */
const DEFAULT_MAX_ATTEMPTS = 3;

/** Base backoff between retries; doubles each attempt. */
const DEFAULT_RETRY_BASE_DELAY_MS = 500;

/** How much of a failing response body is quoted back in an error. */
const DETAIL_MAX_CHARS = 300;

/**
 * Response fields tried, in order, when looking for the token. `token` comes first
 * because that is what the live stand returns. Matching is case-insensitive and
 * ignores `_` / `-`: `access_token`, `accessToken` and `Access-Token` are one key here.
 */
const TOKEN_KEYS = [
  'token',
  'access_token',
  'accessToken',
  'jwt',
  'id_token',
  'idToken',
  'value',
] as const;

/**
 * Qdrant wraps every REST payload in `{"time":…,"status":…,"result":…}`, and IAM is no
 * exception — the observed answer is `{"result":{"token":"eyJ0eXAiOiJKV1Q…"}}`. The
 * envelope is unwrapped BEFORE the key candidates are tried, otherwise the search hits
 * `result` as an object and finds nothing.
 */
const ENVELOPE_KEYS = ['result', 'data'] as const;

/** A bare-string body is accepted as the token only if it looks like an opaque token. */
const BARE_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{8,}$/;

export type QdrantAuthErrorCode =
  /** The HTTP request never produced a response (DNS, TLS, timeout, socket). */
  | 'TRANSPORT_FAILED'
  /** IAM answered with a non-2xx status. */
  | 'HTTP_ERROR'
  /** A 2xx body that is neither JSON nor a bare token. */
  | 'INVALID_RESPONSE'
  /** A parsed body with no recognisable token field. */
  | 'TOKEN_NOT_FOUND';

/**
 * Failure of the IAM token exchange. `detail` may quote the response body (truncated,
 * password-redacted); it never contains the password, the token or key material.
 */
export class QdrantAuthError extends Error {
  constructor(
    readonly code: QdrantAuthErrorCode,
    message: string,
    readonly detail?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'QdrantAuthError';
  }
}

/** Raw HTTP result of the token exchange. Injectable so tests need no real mTLS. */
export interface QdrantAuthHttpResponse {
  status: number;
  body: string;
}

/** Performs `POST authUrl` with a JSON body. Injectable for tests. */
export type QdrantAuthFetch = (url: string, body: string) => Promise<QdrantAuthHttpResponse>;

export interface QdrantTokenProviderOptions {
  /** Full IAM endpoint, e.g. `https://host:6533/auth`. */
  authUrl: string;
  /** Technical account (ТУЗ). */
  username: string;
  /** Domain password of that account. Never logged. */
  password: string;
  /** Per-request timeout for the token exchange, ms. */
  timeoutMs: number;
  /** Renew this long before expiry. */
  refreshSkewMs: number;
  /** mTLS material; `undefined` means system trust store and no client certificate. */
  tlsMaterial?: QdrantTlsMaterial;
  /** Override the HTTP transport (tests). */
  fetchImpl?: QdrantAuthFetch;
  /** Clock, ms since epoch (tests). */
  now?: () => number;
  /** Attempts per token request, retries included (default 3). */
  maxAttempts?: number;
  /** Base retry backoff, doubling per attempt (default 500 ms). */
  retryBaseDelayMs?: number;
  /** Injectable sleep so retry tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

interface CachedToken {
  token: string;
  /** Absolute expiry, ms since epoch. */
  expiresAtMs: number;
  /** Whether `expiresAtMs` came from the JWT `exp` or from the 1 h fallback. */
  source: 'jwt-exp' | 'default-ttl';
}

/** 429 and 5xx are transient; every other 4xx is a verdict. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function defaultSleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Case/separator-insensitive key identity: `Access-Token` → `accesstoken`. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/** A plain, non-array object — the only shape worth searching for keys. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Unwraps the Qdrant response envelope: `{"result":{…}}` (or `{"data":{…}}`) yields the
 * inner object, anything else yields the value untouched. One level only — the token
 * sits directly inside `result`.
 */
function unwrapEnvelope(payload: unknown): unknown {
  const record = asRecord(payload);
  if (record === undefined) {
    return payload;
  }
  for (const key of ENVELOPE_KEYS) {
    const inner = asRecord(record[key]);
    if (inner !== undefined) {
      return inner;
    }
  }
  return payload;
}

/** First non-empty string value stored under one of `TOKEN_KEYS`, at this level only. */
function pickTokenField(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (record === undefined) {
    return undefined;
  }

  const strings = new Map<string, string>();
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && value.trim() !== '') {
      const normalized = normalizeKey(key);
      if (!strings.has(normalized)) {
        strings.set(normalized, value.trim());
      }
    }
  }

  for (const candidate of TOKEN_KEYS) {
    const hit = strings.get(normalizeKey(candidate));
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

/**
 * Finds the token in a parsed IAM response.
 *
 * Order: bare string → inside the `result`/`data` envelope (the shape the live stand
 * returns) → flat top level, kept as a fallback in case another IAM build answers
 * without the envelope.
 */
function extractToken(payload: unknown): string | undefined {
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  const unwrapped = unwrapEnvelope(payload);
  return pickTokenField(unwrapped) ?? (unwrapped === payload ? undefined : pickTokenField(payload));
}

/** Key NAMES of a parsed body — for diagnostics. Values are never included. */
function describeShape(payload: unknown): string {
  if (payload === null) {
    return 'null';
  }
  if (Array.isArray(payload)) {
    return `array(${payload.length})`;
  }
  const record = asRecord(payload);
  if (record === undefined) {
    return typeof payload;
  }

  const keys = Object.keys(record);
  const top = keys.length > 0 ? `object keys: ${keys.join(', ')}` : 'object with no keys';

  // Name the envelope's own keys too, otherwise `{"result":{}}` reports just "result".
  for (const key of ENVELOPE_KEYS) {
    const inner = asRecord(record[key]);
    if (inner !== undefined) {
      const innerKeys = Object.keys(inner);
      return `${top}; ${key} keys: ${innerKeys.length > 0 ? innerKeys.join(', ') : '(none)'}`;
    }
  }
  return top;
}

/**
 * Expiry from the JWT `exp` claim (seconds → ms). The payload is decoded, NOT
 * verified — only the database validates the signature; we just need the deadline.
 * Returns `undefined` for anything unparseable.
 */
export function parseJwtExpiryMs(token: string): number | undefined {
  const segments = token.split('.');
  if (segments.length < 2) {
    return undefined;
  }
  const payload = segments[1];
  if (payload === undefined || payload === '') {
    return undefined;
  }
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const exp = (parsed as { exp?: unknown }).exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) {
      return undefined;
    }
    return Math.trunc(exp * 1000);
  } catch {
    return undefined;
  }
}

/**
 * The IAM endpoint: `QDRANT_AUTH_URL` when set, otherwise `/auth` on the QDRANT_URL
 * origin. An explicit value is required whenever IAM listens on its own port (6533 on
 * Vector DB < 2.0.0).
 */
export function resolveQdrantAuthUrl(cfg: {
  QDRANT_URL: string;
  QDRANT_AUTH_URL?: string;
}): string {
  if (cfg.QDRANT_AUTH_URL !== undefined && cfg.QDRANT_AUTH_URL !== '') {
    return cfg.QDRANT_AUTH_URL;
  }
  return `${new URL(cfg.QDRANT_URL).origin}/auth`;
}

/**
 * Mints and caches the Platform V Vector DB JWT.
 *
 * - `getToken()` hands back the cached token while more than `refreshSkewMs` of its
 *   lifetime remains, and mints a new one otherwise;
 * - concurrent callers during a renewal share ONE in-flight request (single-flight);
 * - the expiry comes from the token's own `exp`, falling back to one hour.
 */
export class QdrantTokenProvider {
  private readonly authUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly refreshSkewMs: number;
  private readonly fetchImpl: QdrantAuthFetch;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  private cached: CachedToken | undefined;
  private inFlight: Promise<CachedToken> | undefined;

  constructor(opts: QdrantTokenProviderOptions) {
    this.authUrl = opts.authUrl;
    this.username = opts.username;
    this.password = opts.password;
    this.refreshSkewMs = opts.refreshSkewMs;
    this.fetchImpl = opts.fetchImpl ?? createHttpsAuthFetch(opts.timeoutMs, opts.tlsMaterial);
    this.now = opts.now ?? Date.now;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Absolute expiry of the cached token (ms since epoch); `undefined` before the first one. */
  get expiresAt(): number | undefined {
    return this.cached?.expiresAtMs;
  }

  /** Whether the cached expiry is the token's own `exp` or the 1 h fallback. */
  get expirySource(): 'jwt-exp' | 'default-ttl' | undefined {
    return this.cached?.source;
  }

  /** A token valid for at least `refreshSkewMs` more. Mints a new one when needed. */
  async getToken(): Promise<string> {
    const cached = this.cached;
    if (cached !== undefined && cached.expiresAtMs - this.now() > this.refreshSkewMs) {
      return cached.token;
    }
    const fresh = await this.refresh();
    return fresh.token;
  }

  /**
   * Single-flight renewal: the first caller starts the exchange, everyone arriving
   * while it is in flight awaits that same promise instead of hammering IAM.
   */
  private refresh(): Promise<CachedToken> {
    const pending = this.inFlight;
    if (pending !== undefined) {
      return pending;
    }
    const promise = this.requestToken()
      .then((token) => {
        this.cached = token;
        return token;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    this.inFlight = promise;
    return promise;
  }

  /** One token exchange, retrying 429/5xx up to `maxAttempts` times. */
  private async requestToken(): Promise<CachedToken> {
    const body = JSON.stringify({ username: this.username, password: this.password });
    let lastError: QdrantAuthError | undefined;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      let response: QdrantAuthHttpResponse;
      try {
        response = await this.fetchImpl(this.authUrl, body);
      } catch (err: unknown) {
        // Network-level failures are always worth another attempt.
        lastError = new QdrantAuthError(
          'TRANSPORT_FAILED',
          `Qdrant IAM request to ${this.authUrl} failed`,
          this.redact(err instanceof Error ? err.message : String(err)),
        );
        if (attempt < this.maxAttempts - 1) {
          await this.sleep(this.retryBaseDelayMs * 2 ** attempt);
        }
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        const error = new QdrantAuthError(
          'HTTP_ERROR',
          `Qdrant IAM ${this.authUrl} answered ${response.status}`,
          this.redact(response.body),
          response.status,
        );
        // 400/401/403 will not change on retry — the credentials are simply wrong.
        if (!isRetryableStatus(response.status)) {
          throw error;
        }
        lastError = error;
        if (attempt < this.maxAttempts - 1) {
          await this.sleep(this.retryBaseDelayMs * 2 ** attempt);
        }
        continue;
      }

      return this.toCachedToken(response.body);
    }

    throw (
      lastError ??
      new QdrantAuthError('TRANSPORT_FAILED', `Qdrant IAM request to ${this.authUrl} failed`)
    );
  }

  /** Turns a 2xx body into a cached token, deriving the expiry from `exp`. */
  private toCachedToken(rawBody: string): CachedToken {
    const trimmed = rawBody.trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Not JSON — the vendor may hand back the bare token.
      if (BARE_TOKEN_PATTERN.test(trimmed)) {
        return this.withExpiry(trimmed);
      }
      throw new QdrantAuthError(
        'INVALID_RESPONSE',
        `Qdrant IAM ${this.authUrl} returned a body that is neither JSON nor a token`,
        this.redact(trimmed),
      );
    }

    const token = extractToken(parsed);
    if (token === undefined) {
      // Names only: the values are password-adjacent and must not be logged.
      throw new QdrantAuthError(
        'TOKEN_NOT_FOUND',
        `Qdrant IAM ${this.authUrl} returned no recognised token field ` +
          `(tried ${TOKEN_KEYS.join(', ')}); response ${describeShape(parsed)}`,
      );
    }
    return this.withExpiry(token);
  }

  private withExpiry(token: string): CachedToken {
    const exp = parseJwtExpiryMs(token);
    if (exp !== undefined) {
      return { token, expiresAtMs: exp, source: 'jwt-exp' };
    }
    return { token, expiresAtMs: this.now() + DEFAULT_TOKEN_TTL_MS, source: 'default-ttl' };
  }

  /** Truncates a body for diagnostics and blanks any verbatim password echo. */
  private redact(text: string): string {
    const withoutPassword = this.password.length > 0 ? text.split(this.password).join('***') : text;
    return withoutPassword.length > DETAIL_MAX_CHARS
      ? `${withoutPassword.slice(0, DETAIL_MAX_CHARS)}…`
      : withoutPassword;
  }
}

/**
 * Default transport: `node:https` with the TLS material passed explicitly, so it works
 * whether or not IAM shares a port with the database (see the module header).
 */
function createHttpsAuthFetch(
  timeoutMs: number,
  material: QdrantTlsMaterial | undefined,
): QdrantAuthFetch {
  return (url, body) =>
    new Promise<QdrantAuthHttpResponse>((resolve, reject) => {
      const target = new URL(url);
      const req = request(
        {
          hostname: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          timeout: timeoutMs,
          ca: material?.ca,
          cert: material?.cert,
          key: material?.key,
          passphrase: material?.passphrase,
          rejectUnauthorized: material?.rejectUnauthorized ?? true,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );

      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
      req.write(body);
      req.end();
    });
}
