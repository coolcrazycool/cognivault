import type { QdrantClientParams } from '@qdrant/js-client-rest';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { BM25_VECTOR_NAME, DENSE_VECTOR_NAME } from '../lib/bm25.js';
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

/**
 * The name everything at runtime talks to. Since the hybrid rework this is an ALIAS,
 * not a collection: point traffic (search/query/upsert/delete) goes through it, so a
 * future re-index can build a new physical collection and repoint the alias atomically.
 */
export const COLLECTION_NAME = 'cognivault';

/**
 * The physical collection the alias points at. Bump this (and re-index) whenever the
 * schema changes incompatibly — the previous collection stays untouched as the
 * rollback path.
 */
export const PHYSICAL_COLLECTION = 'cognivault_v2';

// Vector names come from the module that also builds the sparse vectors — the schema
// declared here and the vectors written at index time must never drift apart.
export { BM25_VECTOR_NAME, DENSE_VECTOR_NAME };

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

/**
 * `is_tenant` tells Qdrant to co-locate points of one user on disk, which is exactly
 * how every request filters. Only valid on a keyword index.
 */
const USER_ID_INDEX_SCHEMA: PayloadFieldSchema = {
  type: 'keyword',
  is_tenant: true,
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
  collection: string,
  field: string,
  fieldSchema: PayloadFieldSchema,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    await client.createPayloadIndex(collection, {
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

type CreateCollectionBody = Parameters<QdrantClient['createCollection']>[1];
type CollectionInfo = Awaited<ReturnType<QdrantClient['getCollection']>>;

/**
 * The hybrid schema: one NAMED dense vector plus a sparse BM25 vector with the `idf`
 * modifier (Qdrant computes the IDF part of the BM25 score server-side, so the indexer
 * only has to ship term frequencies).
 *
 * `on_disk` on the dense vector and `on_disk_payload` keep RAM proportional to the
 * index structures rather than to the corpus.
 *
 * Quantization is opt-in (`QDRANT_QUANTIZATION`). The database is external and
 * centrally managed: shrinking vectors to int8 is the operator's decision and can be
 * applied later with `update_collection`, without a re-index.
 */
function buildCollectionSchema(dimensions: number): CreateCollectionBody {
  const body: CreateCollectionBody = {
    vectors: {
      [DENSE_VECTOR_NAME]: {
        size: dimensions,
        distance: 'Cosine',
        on_disk: true,
      },
    },
    sparse_vectors: {
      [BM25_VECTOR_NAME]: {
        modifier: 'idf',
      },
    },
    on_disk_payload: true,
  };

  if (config.QDRANT_QUANTIZATION) {
    body.quantization_config = {
      scalar: {
        type: 'int8',
        quantile: 0.99,
        // The quantized copy stays in RAM while the originals live on disk — that is
        // the whole point of turning quantization on.
        always_ram: true,
      },
    };
  }

  return body;
}

/**
 * Classify the `vectors` block of an existing collection. The legacy schema stored a
 * single UNNAMED vector (`{ size, distance }`); the hybrid schema stores a map keyed
 * by vector name. Telling them apart matters: reading `.size` off a named config
 * yields `undefined`, which would silently disable the dimension guard.
 */
function describeVectorSchema(
  vectors: unknown,
): { kind: 'unnamed' } | { kind: 'named'; denseSize: number | undefined } | { kind: 'absent' } {
  if (typeof vectors !== 'object' || vectors === null) {
    return { kind: 'absent' };
  }
  const record = vectors as Record<string, unknown>;
  if (typeof record.size === 'number') {
    return { kind: 'unnamed' };
  }
  const dense = record[DENSE_VECTOR_NAME];
  if (typeof dense !== 'object' || dense === null) {
    return { kind: 'named', denseSize: undefined };
  }
  const size = (dense as { size?: unknown }).size;
  return { kind: 'named', denseSize: typeof size === 'number' ? size : undefined };
}

/** Advice appended to every "this collection cannot be used" error. */
function recreateHint(collection: string): string {
  return (
    `Drop and re-create "${collection}" with the current schema and re-index ` +
    '(the service creates it on start once the name is free).'
  );
}

/**
 * Fail startup when the existing collection cannot serve the current build, and warn
 * about degradations that are survivable.
 *
 * Fatal: legacy unnamed vectors, a missing `dense` vector, a dense vector sized for a
 * different embedding model. Survivable: a missing `bm25` sparse vector — dense search
 * still answers, lexical retrieval simply has nothing to read.
 */
function assertUsableCollection(
  info: CollectionInfo,
  collection: string,
  dimensions: number,
  log: FastifyBaseLogger,
): void {
  const schema = describeVectorSchema(info.config?.params?.vectors);

  if (schema.kind === 'unnamed') {
    throw new Error(
      `Qdrant collection "${collection}" uses the legacy UNNAMED vector schema, but this ` +
        `build requires a named "${DENSE_VECTOR_NAME}" vector plus a sparse ` +
        `"${BM25_VECTOR_NAME}" vector. ${recreateHint(collection)}`,
    );
  }

  if (schema.kind === 'absent') {
    log.warn(
      { collection },
      'Qdrant did not report a vector configuration — skipping the dimension check',
    );
    return;
  }

  if (schema.denseSize === undefined) {
    throw new Error(
      `Qdrant collection "${collection}" has no "${DENSE_VECTOR_NAME}" vector. ` +
        recreateHint(collection),
    );
  }

  // Vector size is fixed at creation; switching embedding providers/models with a
  // different dimension requires a fresh collection and re-index.
  if (schema.denseSize !== dimensions) {
    throw new Error(
      `Qdrant collection "${collection}" has vector size ${schema.denseSize}, but the ` +
        `active embedding provider produces ${dimensions}. Recreate the collection and ` +
        're-index after changing EMBEDDING_PROVIDER/model.',
    );
  }

  const sparse = info.config?.params?.sparse_vectors;
  if (typeof sparse !== 'object' || sparse === null || !(BM25_VECTOR_NAME in sparse)) {
    log.warn(
      { collection },
      `Qdrant collection has no "${BM25_VECTOR_NAME}" sparse vector — lexical/hybrid ` +
        'retrieval is unavailable until the collection is re-created and re-indexed',
    );
  }
}

/**
 * Resolve the physical collection behind {@link COLLECTION_NAME}, creating it and the
 * alias on first start. Returns the physical name and whether it was just created.
 *
 * Cases:
 *  - alias exists → use whatever it points at. Pointing at something other than
 *    {@link PHYSICAL_COLLECTION} is a warning, never fatal: that is exactly the state
 *    of a rolled-back deployment, and it must keep serving.
 *  - alias missing, a COLLECTION already owns the name → fatal. Qdrant keeps aliases
 *    and collections in one namespace, so the alias cannot be created; only a human
 *    can decide whether the old collection is still needed.
 *  - alias missing, name free → create {@link PHYSICAL_COLLECTION} unless it is
 *    already there (a previous half-finished start), then attach the alias.
 *
 * The old `cognivault` collection is never dropped or modified here — it is the
 * rollback path.
 */
async function resolveCollection(
  client: QdrantClient,
  dimensions: number,
  log: FastifyBaseLogger,
): Promise<{ collection: string; created: boolean }> {
  const { aliases } = await client.getAliases();
  const alias = aliases.find((a) => a.alias_name === COLLECTION_NAME);

  if (alias !== undefined) {
    if (alias.collection_name !== PHYSICAL_COLLECTION) {
      log.warn(
        {
          alias: COLLECTION_NAME,
          collection: alias.collection_name,
          expected: PHYSICAL_COLLECTION,
        },
        `Alias "${COLLECTION_NAME}" points at an older collection — re-index into ` +
          `"${PHYSICAL_COLLECTION}" and repoint the alias to pick up the hybrid schema`,
      );
    }
    return { collection: alias.collection_name, created: false };
  }

  const { collections } = await client.getCollections();
  const names = new Set(collections.map((c) => c.name));

  if (names.has(COLLECTION_NAME)) {
    throw new Error(
      `"${COLLECTION_NAME}" exists as a COLLECTION, not as an alias, so the alias cannot ` +
        'be created (Qdrant shares one namespace for both). The old collection is left ' +
        'untouched on purpose — it is the rollback path. To migrate: re-index into ' +
        `"${PHYSICAL_COLLECTION}", then rename or delete the legacy "${COLLECTION_NAME}" ` +
        'collection manually and restart; this service will create the alias.',
    );
  }

  const created = !names.has(PHYSICAL_COLLECTION);
  if (created) {
    await client.createCollection(PHYSICAL_COLLECTION, buildCollectionSchema(dimensions));
    log.info({ collection: PHYSICAL_COLLECTION, dimensions }, 'Created Qdrant collection');
  }

  // Atomic: the alias appears fully formed or not at all.
  await client.updateCollectionAliases({
    actions: [
      { create_alias: { collection_name: PHYSICAL_COLLECTION, alias_name: COLLECTION_NAME } },
    ],
  });
  log.info(
    { alias: COLLECTION_NAME, collection: PHYSICAL_COLLECTION },
    'Attached Qdrant collection alias',
  );

  return { collection: PHYSICAL_COLLECTION, created };
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

  // Resolve (and on first start create) the collection behind the alias. Every
  // maintenance call below targets the PHYSICAL collection: aliases are for point
  // traffic, and pinning admin work to the real name keeps it unambiguous while an
  // alias is being repointed.
  const { collection, created } = await resolveCollection(client, dimensions, fastify.log);

  if (!created) {
    const info = await client.getCollection(collection);
    assertUsableCollection(info, collection, dimensions, fastify.log);
  }

  if (created) {
    // Create payload indexes for filtering
    for (const { field, type } of PAYLOAD_INDEXES) {
      await ensurePayloadIndex(client, collection, field, type, fastify.log);
    }
  }

  // Create full-text indexes for lexical search — idempotent (safe on restart)
  for (const field of TEXT_INDEXES) {
    await ensurePayloadIndex(client, collection, field, TEXT_INDEX_SCHEMA, fastify.log);
  }

  // Create user_id tenant index — idempotent (safe on restart)
  await ensurePayloadIndex(client, collection, 'user_id', USER_ID_INDEX_SCHEMA, fastify.log);

  // Purge legacy vectors without user_id payload
  await client.delete(collection, {
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
