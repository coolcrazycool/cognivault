import { describe, expect, it, vi } from 'vitest';
import type { QdrantAuthFetch, QdrantAuthHttpResponse } from '../qdrant-auth.js';
import { QdrantAuthError, QdrantTokenProvider, resolveQdrantAuthUrl } from '../qdrant-auth.js';

const AUTH_URL = 'https://vectordb.example:6433/auth';
const USERNAME = 'tuz-cognivault';
const PASSWORD = 'sup3r-s3cr3t-d0main-p@ss';
const REFRESH_SKEW_MS = 300_000;
const HOUR_MS = 3_600_000;

/** Encodes a JWT-shaped token; only the payload matters, the signature is filler. */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ typ: 'JWT', alg: 'HS256' })}.${encode(payload)}.c2lnbmF0dXJl`;
}

/** A token that expires `seconds` after `nowMs`. */
function jwtExpiringAt(nowMs: number, seconds: number): string {
  return jwt({ sub: USERNAME, exp: Math.floor(nowMs / 1000) + seconds });
}

interface Harness {
  provider: QdrantTokenProvider;
  fetchImpl: ReturnType<typeof vi.fn>;
  sleeps: number[];
  setNow: (ms: number) => void;
}

/** Builds a provider over a scripted transport, a movable clock and a fake sleep. */
function makeProvider(
  responses: Array<QdrantAuthHttpResponse | Error>,
  startNowMs = 1_000_000_000_000,
): Harness {
  let nowMs = startNowMs;
  const sleeps: number[] = [];
  let call = 0;

  const fetchImpl = vi.fn(async (): Promise<QdrantAuthHttpResponse> => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (next instanceof Error) {
      throw next;
    }
    if (next === undefined) {
      throw new Error('no scripted response');
    }
    return next;
  });

  const provider = new QdrantTokenProvider({
    authUrl: AUTH_URL,
    username: USERNAME,
    password: PASSWORD,
    timeoutMs: 5_000,
    refreshSkewMs: REFRESH_SKEW_MS,
    fetchImpl: fetchImpl as unknown as QdrantAuthFetch,
    now: () => nowMs,
    retryBaseDelayMs: 100,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });

  return {
    provider,
    fetchImpl,
    sleeps,
    setNow: (ms: number) => {
      nowMs = ms;
    },
  };
}

function ok(body: unknown): QdrantAuthHttpResponse {
  return { status: 200, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

describe('resolveQdrantAuthUrl', () => {
  it('defaults to /auth on the QDRANT_URL origin', () => {
    expect(resolveQdrantAuthUrl({ QDRANT_URL: 'https://host.example:6433' })).toBe(
      'https://host.example:6433/auth',
    );
  });

  it('drops any path from QDRANT_URL when deriving the default', () => {
    expect(resolveQdrantAuthUrl({ QDRANT_URL: 'https://host.example:6433/some/path' })).toBe(
      'https://host.example:6433/auth',
    );
  });

  it('prefers an explicit QDRANT_AUTH_URL — IAM may live on its own port', () => {
    expect(
      resolveQdrantAuthUrl({
        QDRANT_URL: 'https://host.example:6433',
        QDRANT_AUTH_URL: 'https://host.example:6533/auth',
      }),
    ).toBe('https://host.example:6533/auth');
  });
});

describe('QdrantTokenProvider', () => {
  it('exchanges credentials for a token and caches it until the skew window', async () => {
    const now = 1_700_000_000_000;
    const token = jwtExpiringAt(now, 3600);
    const { provider, fetchImpl } = makeProvider([ok({ result: { token } })], now);

    expect(await provider.getToken()).toBe(token);
    expect(await provider.getToken()).toBe(token);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, body] = fetchImpl.mock.calls[0] as [string, string];
    expect(url).toBe(AUTH_URL);
    expect(JSON.parse(body)).toEqual({ username: USERNAME, password: PASSWORD });
  });

  it('reads the live IAM shape {"result":{"token":…}} and takes expiresAt from exp', async () => {
    const now = 1_700_000_000_000;
    const token = jwtExpiringAt(now, 3600);
    const { provider } = makeProvider([ok({ result: { token } })], now);

    expect(await provider.getToken()).toBe(token);
    expect(provider.expiresAt).toBe(Math.floor(now / 1000) * 1000 + 3600 * 1000);
    expect(provider.expirySource).toBe('jwt-exp');
  });

  it('renews once the cached token enters the skew window', async () => {
    const now = 1_700_000_000_000;
    const first = jwtExpiringAt(now, 3600);
    const second = jwtExpiringAt(now + HOUR_MS, 3600);
    const harness = makeProvider(
      [ok({ result: { token: first } }), ok({ result: { token: second } })],
      now,
    );

    expect(await harness.provider.getToken()).toBe(first);

    // Still outside the skew window — cache holds.
    harness.setNow(now + HOUR_MS - REFRESH_SKEW_MS - 1_000);
    expect(await harness.provider.getToken()).toBe(first);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);

    // Inside the skew window — a new token is minted.
    harness.setNow(now + HOUR_MS - REFRESH_SKEW_MS + 1_000);
    expect(await harness.provider.getToken()).toBe(second);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent cold-cache calls into one HTTP request', async () => {
    const now = 1_700_000_000_000;
    const token = jwtExpiringAt(now, 3600);
    const { provider, fetchImpl } = makeProvider([ok({ result: { token } })], now);

    const tokens = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);

    expect(tokens).toEqual([token, token, token, token, token]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('mints again after an in-flight renewal settled (single-flight is not sticky)', async () => {
    const now = 1_700_000_000_000;
    const first = jwtExpiringAt(now, 3600);
    const second = jwtExpiringAt(now + HOUR_MS, 3600);
    const harness = makeProvider(
      [ok({ result: { token: first } }), ok({ result: { token: second } })],
      now,
    );

    await harness.provider.getToken();
    harness.setNow(now + HOUR_MS);
    expect(await harness.provider.getToken()).toBe(second);
  });

  describe('tolerant response parsing', () => {
    const now = 1_700_000_000_000;
    const token = jwtExpiringAt(now, 3600);

    const shapes: Array<[string, unknown]> = [
      ['{"result":{"token":…}} — the live IAM envelope', { result: { token } }],
      ['{"data":{"token":…}} — an alternative envelope', { data: { token } }],
      ['{"token":…}', { token }],
      ['{"access_token":…}', { access_token: token }],
      ['{"accessToken":…}', { accessToken: token }],
      ['{"jwt":…}', { jwt: token }],
      ['{"id_token":…}', { id_token: token }],
      ['{"value":…}', { value: token }],
      ['{"Access-Token":…} — separators and case ignored', { 'Access-Token': token }],
      ['{"result":{"access_token":…}} — envelope plus alias', { result: { access_token: token } }],
    ];

    for (const [name, body] of shapes) {
      it(`recognises ${name}`, async () => {
        const { provider } = makeProvider([ok(body)], now);
        expect(await provider.getToken()).toBe(token);
      });
    }

    it('recognises a bare token body (not JSON at all)', async () => {
      const { provider } = makeProvider([ok(token)], now);
      expect(await provider.getToken()).toBe(token);
    });

    it('recognises a JSON string body', async () => {
      const { provider } = makeProvider([ok(JSON.stringify(token))], now);
      expect(await provider.getToken()).toBe(token);
    });

    it('prefers `token` over the other candidates', async () => {
      const other = jwtExpiringAt(now, 60);
      const { provider } = makeProvider([ok({ result: { value: other, token } })], now);
      expect(await provider.getToken()).toBe(token);
    });

    it('reports the top-level key NAMES and no values on an unknown shape', async () => {
      const secretish = 'some-unexpected-value';
      const { provider } = makeProvider(
        [ok({ ticket: secretish, sessionId: secretish, expiresIn: 3600 })],
        now,
      );

      const err = await provider.getToken().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(QdrantAuthError);
      const authError = err as QdrantAuthError;
      expect(authError.code).toBe('TOKEN_NOT_FOUND');
      expect(authError.message).toContain('ticket');
      expect(authError.message).toContain('sessionId');
      expect(authError.message).not.toContain(secretish);
      expect(authError.detail).toBeUndefined();
    });

    it('names the envelope keys when {"result":{}} carries no token', async () => {
      const { provider } = makeProvider([ok({ result: {} })], now);

      const err = (await provider.getToken().catch((e: unknown) => e)) as QdrantAuthError;
      expect(err).toBeInstanceOf(QdrantAuthError);
      expect(err.code).toBe('TOKEN_NOT_FOUND');
      expect(err.message).toContain('result keys: (none)');
    });

    it('names the nested keys of an error envelope', async () => {
      const message = 'Wrong credentials for user';
      const { provider } = makeProvider([ok({ status: { error: message } })], now);

      const err = (await provider.getToken().catch((e: unknown) => e)) as QdrantAuthError;
      expect(err).toBeInstanceOf(QdrantAuthError);
      expect(err.code).toBe('TOKEN_NOT_FOUND');
      expect(err.message).toContain('status');
      expect(err.message).not.toContain(message);
    });

    it('rejects a 2xx body that is neither JSON nor a token', async () => {
      const { provider } = makeProvider([ok('<html>login page</html>')], now);

      const err = (await provider.getToken().catch((e: unknown) => e)) as QdrantAuthError;
      expect(err.code).toBe('INVALID_RESPONSE');
    });
  });

  it('falls back to a one-hour lifetime when the payload has no exp', async () => {
    const now = 1_700_000_000_000;
    const token = jwt({ sub: USERNAME });
    const { provider } = makeProvider([ok({ result: { token } })], now);

    await provider.getToken();
    expect(provider.expiresAt).toBe(now + HOUR_MS);
    expect(provider.expirySource).toBe('default-ttl');
  });

  it('falls back to a one-hour lifetime for an opaque, non-JWT token', async () => {
    const now = 1_700_000_000_000;
    const { provider } = makeProvider([ok({ result: { token: 'opaque-token-value' } })], now);

    await provider.getToken();
    expect(provider.expiresAt).toBe(now + HOUR_MS);
    expect(provider.expirySource).toBe('default-ttl');
  });

  describe('failures', () => {
    it('fails immediately on 401 without retrying, and never echoes the password', async () => {
      const body = '{"status":{"error":"Wrong credentials"}}';
      const { provider, fetchImpl, sleeps } = makeProvider([{ status: 401, body }]);

      const err = (await provider.getToken().catch((e: unknown) => e)) as QdrantAuthError;
      expect(err).toBeInstanceOf(QdrantAuthError);
      expect(err.code).toBe('HTTP_ERROR');
      expect(err.status).toBe(401);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);

      expect(err.message).not.toContain(PASSWORD);
      expect(err.detail ?? '').not.toContain(PASSWORD);
      expect(err.detail).toContain('Wrong credentials');
    });

    it('redacts the password if the server ever echoes it back', async () => {
      const { provider } = makeProvider([{ status: 400, body: `bad password: ${PASSWORD}` }]);

      const err = (await provider.getToken().catch((e: unknown) => e)) as QdrantAuthError;
      expect(err.detail).not.toContain(PASSWORD);
      expect(err.detail).toContain('***');
    });

    it('truncates a huge error body to ~300 characters', async () => {
      const { provider } = makeProvider([{ status: 400, body: 'x'.repeat(5_000) }]);

      const err = (await provider.getToken().catch((e: unknown) => e)) as QdrantAuthError;
      expect((err.detail ?? '').length).toBeLessThanOrEqual(301);
    });

    it('retries 5xx up to three attempts with growing backoff, then gives up', async () => {
      const { provider, fetchImpl, sleeps } = makeProvider([{ status: 500, body: 'boom' }]);

      const err = (await provider.getToken().catch((e: unknown) => e)) as QdrantAuthError;
      expect(err).toBeInstanceOf(QdrantAuthError);
      expect(err.code).toBe('HTTP_ERROR');
      expect(err.status).toBe(500);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      // Two waits between three attempts — and nothing actually slept.
      expect(sleeps).toEqual([100, 200]);
    });

    it('retries 429 as well', async () => {
      const now = 1_700_000_000_000;
      const token = jwtExpiringAt(now, 3600);
      const { provider, fetchImpl } = makeProvider(
        [{ status: 429, body: 'slow down' }, ok({ result: { token } })],
        now,
      );

      expect(await provider.getToken()).toBe(token);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('retries transport failures and surfaces them as TRANSPORT_FAILED', async () => {
      const { provider, fetchImpl } = makeProvider([new Error('ECONNREFUSED')]);

      const err = (await provider.getToken().catch((e: unknown) => e)) as QdrantAuthError;
      expect(err.code).toBe('TRANSPORT_FAILED');
      expect(err.detail).toContain('ECONNREFUSED');
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('lets a later call retry after a failed exchange', async () => {
      const now = 1_700_000_000_000;
      const token = jwtExpiringAt(now, 3600);
      const { provider } = makeProvider(
        [
          { status: 500, body: 'boom' },
          { status: 500, body: 'boom' },
          { status: 500, body: 'boom' },
          ok({ result: { token } }),
        ],
        now,
      );

      await expect(provider.getToken()).rejects.toBeInstanceOf(QdrantAuthError);
      expect(await provider.getToken()).toBe(token);
    });
  });
});
