import { QdrantClient } from '@qdrant/js-client-rest';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { DIMENSION_MAP } from '../lib/embedding.js';
import { TenantQdrantClient } from '../lib/tenant-qdrant-client.js';

declare module 'fastify' {
  interface FastifyInstance {
    createTenantQdrant: (userId: string) => TenantQdrantClient;
    purgeUserVectors: (userId: string) => Promise<void>;
  }
}

export const COLLECTION_NAME = 'cognivault';

const TEXT_INDEXES = ['text', 'title', 'section_path'] as const;

const PAYLOAD_INDEXES: Array<{ field: string; type: 'keyword' | 'integer' }> = [
  { field: 'path', type: 'keyword' },
  { field: 'tags', type: 'keyword' },
  { field: 'project', type: 'keyword' },
  { field: 'status', type: 'keyword' },
  { field: 'type', type: 'keyword' },
  { field: 'chunk_index', type: 'integer' },
];

async function qdrantPlugin(fastify: FastifyInstance): Promise<void> {
  const dimensions = DIMENSION_MAP[config.EMBEDDING_MODEL];
  if (dimensions === undefined) {
    throw new Error(
      `Unknown embedding model: "${config.EMBEDDING_MODEL}". Known models: ${Object.keys(DIMENSION_MAP).join(', ')}`,
    );
  }

  const client = new QdrantClient({ url: config.QDRANT_URL });

  // Check if collection exists; create if not (idempotent restarts)
  const { collections } = await client.getCollections();
  const exists = collections.some((c) => c.name === COLLECTION_NAME);

  if (!exists) {
    await client.createCollection(COLLECTION_NAME, {
      vectors: {
        size: dimensions,
        distance: 'Cosine',
      },
    });

    // Create payload indexes for filtering
    for (const { field, type } of PAYLOAD_INDEXES) {
      await client.createPayloadIndex(COLLECTION_NAME, {
        field_name: field,
        field_schema: type,
      });
    }
  }

  // Create full-text indexes for lexical search — idempotent (safe on restart)
  for (const field of TEXT_INDEXES) {
    try {
      await client.createPayloadIndex(COLLECTION_NAME, {
        field_name: field,
        field_schema: {
          type: 'text',
          tokenizer: 'multilingual',
          lowercase: true,
        },
      });
    } catch {
      // Index already exists — safe to ignore on restart
    }
  }

  // Create user_id keyword index — idempotent (safe on restart)
  try {
    await client.createPayloadIndex(COLLECTION_NAME, {
      field_name: 'user_id',
      field_schema: 'keyword',
    });
  } catch {
    // Index already exists — safe to ignore
  }

  // Purge legacy vectors without user_id payload
  await client.delete(COLLECTION_NAME, {
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
      filter: { must: [{ key: 'user_id', match: { value: userId } }] },
    });
  });
}

export default fp(qdrantPlugin, { name: 'qdrant', dependencies: [] });
