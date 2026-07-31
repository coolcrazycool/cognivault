import type { QdrantClientParams } from '@qdrant/js-client-rest';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { resolveDimensions } from '../lib/embedding.js';
import { describeQdrantTls, installQdrantTls } from '../lib/qdrant-tls.js';
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
 * Build the Qdrant client options. The external Qdrant sits behind a reverse proxy that
 * speaks HTTP Basic (native Qdrant only understands the `api-key` header), so the
 * credentials go out as an `Authorization` header. Without both credentials no auth
 * header is added at all.
 *
 * NEVER log the returned object — it carries the password in `headers.Authorization`.
 */
function buildClientParams(): QdrantClientParams {
  const params: QdrantClientParams = {
    url: config.QDRANT_URL,
    timeout: config.QDRANT_TIMEOUT_MS,
    // Client 1.17 vs server 1.16 makes the client print an incompatibility warning on
    // every start. We probe and log the server version ourselves (`logServerVersion`),
    // so the built-in check is pure noise.
    checkCompatibility: false,
  };

  const user = config.QDRANT_USERNAME;
  const pass = config.QDRANT_PASSWORD;
  if (user && pass) {
    params.headers = {
      Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
    };
  }

  return params;
}

async function qdrantPlugin(fastify: FastifyInstance): Promise<void> {
  const dimensions = resolveDimensions(config);

  // Must precede the client and its first connection: the REST client ships its own
  // undici Agent, so the only reachable seam is `tls.connect` (see qdrant-tls.ts).
  installQdrantTls(config, fastify.log);

  const params = buildClientParams();
  const client = new QdrantClient(params);

  // Log MODES only — never the header value, the params object, cert paths or the
  // key passphrase.
  fastify.log.info(
    {
      qdrantUrl: config.QDRANT_URL,
      qdrantAuth: params.headers ? 'basic' : 'none',
      qdrantTimeoutMs: config.QDRANT_TIMEOUT_MS,
      ...describeQdrantTls(config),
    },
    'Qdrant client configured',
  );

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

  // Expose factory for tenant-scoped Qdrant clients — raw client stays internal
  fastify.decorate('createTenantQdrant', (userId: string) => {
    return new TenantQdrantClient(client, userId);
  });

  // Expose purge function for user removal cleanup
  fastify.decorate('purgeUserVectors', async (userId: string) => {
    await client.delete(COLLECTION_NAME, {
      wait: true,
      filter: { must: [{ key: 'user_id', match: { value: userId } }] },
    });
  });
}

export default fp(qdrantPlugin, { name: 'qdrant', dependencies: [] });
