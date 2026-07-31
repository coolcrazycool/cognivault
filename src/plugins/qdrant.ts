import type { QdrantClientParams } from '@qdrant/js-client-rest';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { resolveDimensions } from '../lib/embedding.js';
import { QdrantTokenProvider, resolveQdrantAuthUrl } from '../lib/qdrant-auth.js';
import { buildQdrantTlsMaterial, describeQdrantTls, installQdrantTls } from '../lib/qdrant-tls.js';
import { TenantQdrantClient } from '../lib/tenant-qdrant-client.js';

declare module 'fastify' {
  interface FastifyInstance {
    createTenantQdrant: (userId: string) => TenantQdrantClient;
    purgeUserVectors: (userId: string) => Promise<void>;
  }
}

export const COLLECTION_NAME = 'cognivault';

/**
 * Version of the `@qdrant/js-client-rest` dependency. Hardcoded on purpose:
 * importing package.json would require JSON import assertions in ESM.
 * Keep in sync with the version range in package.json.
 */
const QDRANT_CLIENT_VERSION = '1.17.0';

/** Largest tolerated minor-version gap between client and server before warning. */
const MAX_MINOR_SKEW = 1;

type PayloadFieldSchema = Parameters<QdrantClient['createPayloadIndex']>[1]['field_schema'];

const TEXT_INDEXES = ['text', 'title', 'section_path'] as const;

const TEXT_INDEX_SCHEMA: PayloadFieldSchema = {
  type: 'text',
  tokenizer: 'multilingual',
  lowercase: true,
};

const PAYLOAD_INDEXES: Array<{ field: string; type: 'keyword' | 'integer' }> = [
  { field: 'path', type: 'keyword' },
  { field: 'tags', type: 'keyword' },
  { field: 'project', type: 'keyword' },
  { field: 'status', type: 'keyword' },
  { field: 'type', type: 'keyword' },
  { field: 'chunk_index', type: 'integer' },
];

/**
 * Qdrant answers "index already exists" differently across versions (409 status or a
 * plain message), so probe both shapes before deciding an error is benign.
 */
function isAlreadyExistsError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const candidate = err as { message?: unknown; status?: unknown; statusCode?: unknown };
  if (candidate.status === 409 || candidate.statusCode === 409) {
    return true;
  }
  return typeof candidate.message === 'string' && /already exists/i.test(candidate.message);
}

/**
 * Create a payload index if it is missing. Idempotent: "already exists" is silently
 * ignored. Any other failure is logged but never thrown — a missing index degrades
 * search quality, it must not prevent the service from starting.
 */
async function ensurePayloadIndex(
  client: QdrantClient,
  field: string,
  fieldSchema: PayloadFieldSchema,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    await client.createPayloadIndex(COLLECTION_NAME, {
      field_name: field,
      field_schema: fieldSchema,
    });
  } catch (err: unknown) {
    if (isAlreadyExistsError(err)) {
      return;
    }
    log.error({ err, field }, 'Failed to create Qdrant payload index');
  }
}

/** Parse "1.16.3" into { major: 1, minor: 16 }; undefined when unparseable. */
function parseVersion(version: string): { major: number; minor: number } | undefined {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return undefined;
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Log the Qdrant server version at startup and warn on client/server skew.
 * Never fatal — an unreachable version endpoint must not block startup.
 */
async function logServerVersion(client: QdrantClient, log: FastifyBaseLogger): Promise<void> {
  try {
    const info = await client.versionInfo();
    const qdrantVersion = info.version;
    log.info({ qdrantVersion, clientVersion: QDRANT_CLIENT_VERSION }, 'Connected to Qdrant');

    const server = parseVersion(qdrantVersion);
    const clientVer = parseVersion(QDRANT_CLIENT_VERSION);
    if (!server || !clientVer) {
      return;
    }
    if (
      server.major !== clientVer.major ||
      Math.abs(server.minor - clientVer.minor) > MAX_MINOR_SKEW
    ) {
      log.warn(
        { qdrantVersion, clientVersion: QDRANT_CLIENT_VERSION },
        'Qdrant server/client version skew — API incompatibilities are possible',
      );
    }
  } catch (err: unknown) {
    log.warn({ err }, 'Could not determine Qdrant server version');
  }
}

/**
 * Which authentication scheme the client uses. Safe to log — it names the mode, never
 * the credential.
 *
 *  - `api-key` → a raw Qdrant with a static key;
 *  - `iam`     → Platform V Vector DB: username/password are exchanged at the IAM
 *                endpoint for a JWT sent as `Authorization: Bearer …`;
 *  - `none`    → no credentials (local development, in-cluster Qdrant).
 */
export type QdrantAuthMode = 'api-key' | 'iam' | 'none';

/**
 * Pick the authentication scheme. The two credentialed modes are mutually exclusive
 * (config validation rejects having both).
 *
 * HTTP Basic used to live here and is gone on purpose: Platform V Vector DB ignores it
 * outright — the server answered 401 "Must provide an API key or an Authorization
 * bearer token" to `Authorization: Basic`, exactly as it does to no header at all.
 */
function resolveAuthMode(): QdrantAuthMode {
  if (config.QDRANT_API_KEY) {
    return 'api-key';
  }
  if (config.QDRANT_USERNAME && config.QDRANT_PASSWORD) {
    return 'iam';
  }
  return 'none';
}

/**
 * Build the Qdrant client options for the chosen scheme:
 *  - `api-key` → the client's own `apiKey` param; it sets the `api-key` header itself
 *    and NO `Authorization` header is added;
 *  - `iam`     → `Authorization: Bearer <jwt>` minted by the IAM service;
 *  - `none`    → no credentials at all.
 *
 * On `apiKey` the client derives `this._https = https ?? typeof apiKey === 'string'`,
 * but a `url` immediately overrides the scheme from the URL itself, so an `https://`
 * QDRANT_URL is unaffected and the `https` param stays untouched (we never pass it).
 * The only leftover is a `console.warn` about an insecure connection when QDRANT_URL
 * is plain `http://` — accurate, and harmless for local development.
 *
 * NEVER log the returned object — it carries the api key in `apiKey` and the JWT in
 * `headers.Authorization`.
 */
function buildClientParams(mode: QdrantAuthMode, token?: string): QdrantClientParams {
  const params: QdrantClientParams = {
    url: config.QDRANT_URL,
    timeout: config.QDRANT_TIMEOUT_MS,
    // Client 1.17 vs server 1.16 makes the client print an incompatibility warning on
    // every start. We probe and log the server version ourselves (`logServerVersion`),
    // so the built-in check is pure noise.
    checkCompatibility: false,
  };

  if (mode === 'api-key') {
    params.apiKey = config.QDRANT_API_KEY;
    return params;
  }

  if (mode === 'iam' && token !== undefined) {
    params.headers = { Authorization: `Bearer ${token}` };
  }

  return params;
}

/**
 * The live client. `QdrantClient` freezes its headers at construction time, so a
 * renewed token cannot be pushed into an existing instance — the client is REPLACED
 * instead, and everything that talks to Qdrant reads `holder.current` at call time.
 */
interface QdrantClientHolder {
  current: QdrantClient;
}

/** Retry interval after a failed renewal — short, because the old token is expiring. */
const TOKEN_REFRESH_RETRY_MS = 30_000;

/** Never schedule a renewal tighter than this, so a bad clock cannot spin the loop. */
const MIN_TOKEN_REFRESH_DELAY_MS = 1_000;

/**
 * When to renew: `refreshSkewMs` before the token expires, clamped to a floor. An
 * unknown expiry (no cached token yet) also collapses to the floor.
 */
export function nextRefreshDelayMs(
  expiresAtMs: number | undefined,
  nowMs: number,
  skewMs: number,
): number {
  if (expiresAtMs === undefined) {
    return MIN_TOKEN_REFRESH_DELAY_MS;
  }
  return Math.max(MIN_TOKEN_REFRESH_DELAY_MS, expiresAtMs - nowMs - skewMs);
}

/** Log-safe token description: length and expiry only, never the token itself. */
function describeToken(
  token: string,
  provider: QdrantTokenProvider,
): { tokenLength: number; expiresAt: string | undefined; expirySource: string | undefined } {
  const expiresAtMs = provider.expiresAt;
  return {
    tokenLength: token.length,
    expiresAt: expiresAtMs === undefined ? undefined : new Date(expiresAtMs).toISOString(),
    expirySource: provider.expirySource,
  };
}

async function qdrantPlugin(fastify: FastifyInstance): Promise<void> {
  const dimensions = resolveDimensions(config);

  // Must precede the client and its first connection: the REST client ships its own
  // undici Agent, so the only reachable seam is `tls.connect` (see qdrant-tls.ts).
  installQdrantTls(config, fastify.log);

  const authMode = resolveAuthMode();

  // IAM mode mints the first token BEFORE the client exists — an unreachable IAM must
  // fail startup loudly, exactly as an unreachable Qdrant already does.
  let tokenProvider: QdrantTokenProvider | undefined;
  let token: string | undefined;
  if (authMode === 'iam') {
    const authUrl = resolveQdrantAuthUrl(config);
    tokenProvider = new QdrantTokenProvider({
      authUrl,
      username: config.QDRANT_USERNAME ?? '',
      password: config.QDRANT_PASSWORD ?? '',
      timeoutMs: config.QDRANT_TIMEOUT_MS,
      refreshSkewMs: config.QDRANT_TOKEN_REFRESH_SKEW_MS,
      tlsMaterial: buildQdrantTlsMaterial(config),
    });
    token = await tokenProvider.getToken();
    fastify.log.info(
      { qdrantAuthUrl: authUrl, ...describeToken(token, tokenProvider) },
      'Obtained Qdrant IAM token',
    );
  }

  const holder: QdrantClientHolder = {
    current: new QdrantClient(buildClientParams(authMode, token)),
  };
  // Startup work runs on this snapshot: the token was just minted, so it cannot expire
  // before the collection setup below finishes. Everything long-lived reads
  // `holder.current` instead.
  const client = holder.current;

  // Log MODES only — never the api key, the token, the params object, cert paths or
  // the key passphrase.
  fastify.log.info(
    {
      qdrantUrl: config.QDRANT_URL,
      qdrantAuth: authMode,
      qdrantTimeoutMs: config.QDRANT_TIMEOUT_MS,
      ...describeQdrantTls(config),
    },
    'Qdrant client configured',
  );

  if (tokenProvider !== undefined) {
    startTokenRefresh(fastify, tokenProvider, holder, authMode);
  }

  await logServerVersion(client, fastify.log);

  // Check if collection exists; create if not (idempotent restarts)
  const { collections } = await client.getCollections();
  const exists = collections.some((c) => c.name === COLLECTION_NAME);

  if (exists) {
    // Vector size is fixed at creation; switching embedding providers/models with
    // a different dimension requires a fresh collection and re-index.
    const info = await client.getCollection(COLLECTION_NAME);
    const vectors = info.config?.params?.vectors;
    const existingSize = typeof vectors === 'object' && vectors ? vectors.size : undefined;
    if (typeof existingSize === 'number' && existingSize !== dimensions) {
      throw new Error(
        `Qdrant collection "${COLLECTION_NAME}" has vector size ${existingSize}, but the ` +
          `active embedding provider produces ${dimensions}. Recreate the collection and ` +
          're-index after changing EMBEDDING_PROVIDER/model.',
      );
    }
  }

  if (!exists) {
    await client.createCollection(COLLECTION_NAME, {
      vectors: {
        size: dimensions,
        distance: 'Cosine',
      },
    });

    // Create payload indexes for filtering
    for (const { field, type } of PAYLOAD_INDEXES) {
      await ensurePayloadIndex(client, field, type, fastify.log);
    }
  }

  // Create full-text indexes for lexical search — idempotent (safe on restart)
  for (const field of TEXT_INDEXES) {
    await ensurePayloadIndex(client, field, TEXT_INDEX_SCHEMA, fastify.log);
  }

  // Create user_id keyword index — idempotent (safe on restart)
  await ensurePayloadIndex(client, 'user_id', 'keyword', fastify.log);

  // Purge legacy vectors without user_id payload
  await client.delete(COLLECTION_NAME, {
    wait: true,
    filter: {
      must: [{ is_empty: { key: 'user_id' } }],
    },
  });
  fastify.log.info('Purged legacy vectors without user_id');

  // Expose factory for tenant-scoped Qdrant clients — raw client stays internal.
  // Reads `holder.current` on every call, so a renewed token is picked up without
  // any coordination: the factory runs per request, never once at startup.
  fastify.decorate('createTenantQdrant', (userId: string) => {
    return new TenantQdrantClient(holder.current, userId);
  });

  // Expose purge function for user removal cleanup
  fastify.decorate('purgeUserVectors', async (userId: string) => {
    await holder.current.delete(COLLECTION_NAME, {
      wait: true,
      filter: { must: [{ key: 'user_id', match: { value: userId } }] },
    });
  });
}

/**
 * Keeps the Bearer token fresh. The timer fires `QDRANT_TOKEN_REFRESH_SKEW_MS` before
 * expiry, asks the provider for a token (which renews, since the cached one is inside
 * the skew window) and swaps in a client built with the new header.
 *
 * `unref()` keeps the timer from holding the event loop open; `onClose` clears it so a
 * closed app leaves nothing behind. A failed renewal is logged and retried shortly —
 * it must never take the process down, the current token is usually still valid.
 */
function startTokenRefresh(
  fastify: FastifyInstance,
  provider: QdrantTokenProvider,
  holder: QdrantClientHolder,
  authMode: QdrantAuthMode,
): void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const schedule = (delayMs: number): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void renew();
    }, delayMs);
    timer.unref();
  };

  const renew = async (): Promise<void> => {
    try {
      const fresh = await provider.getToken();
      holder.current = new QdrantClient(buildClientParams(authMode, fresh));
      fastify.log.info(describeToken(fresh, provider), 'Refreshed Qdrant IAM token');
      schedule(
        nextRefreshDelayMs(provider.expiresAt, Date.now(), config.QDRANT_TOKEN_REFRESH_SKEW_MS),
      );
    } catch (err: unknown) {
      fastify.log.error({ err }, 'Failed to refresh Qdrant IAM token — retrying shortly');
      schedule(TOKEN_REFRESH_RETRY_MS);
    }
  };

  fastify.addHook('onClose', async () => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  });

  schedule(nextRefreshDelayMs(provider.expiresAt, Date.now(), config.QDRANT_TOKEN_REFRESH_SKEW_MS));
}

export default fp(qdrantPlugin, { name: 'qdrant', dependencies: [] });
