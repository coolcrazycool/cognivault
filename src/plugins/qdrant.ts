import { QdrantClient } from '@qdrant/js-client-rest';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    qdrant: QdrantClient;
  }
}

const COLLECTION_NAME = 'cognivault';

const PAYLOAD_INDEXES: Array<{ field: string; type: 'keyword' | 'integer' }> = [
  { field: 'path', type: 'keyword' },
  { field: 'tags', type: 'keyword' },
  { field: 'project', type: 'keyword' },
  { field: 'status', type: 'keyword' },
  { field: 'type', type: 'keyword' },
  { field: 'chunk_index', type: 'integer' },
];

async function qdrantPlugin(fastify: FastifyInstance): Promise<void> {
  const client = new QdrantClient({ url: config.QDRANT_URL });

  // Check if collection exists; create if not (idempotent restarts)
  const { collections } = await client.getCollections();
  const exists = collections.some((c) => c.name === COLLECTION_NAME);

  if (!exists) {
    await client.createCollection(COLLECTION_NAME, {
      vectors: {
        size: fastify.embedder.dimensions,
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

  fastify.decorate('qdrant', client);
}

export default fp(qdrantPlugin, { name: 'qdrant', dependencies: ['embedder'] });
