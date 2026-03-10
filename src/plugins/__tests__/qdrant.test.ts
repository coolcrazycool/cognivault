import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fp from 'fastify-plugin';
import type { EmbeddingProvider } from '../../lib/embedding.js';

// Set required env vars before any imports that trigger config parsing
beforeAll(() => {
  process.env.COGNIVAULT_API_KEY = 'test-api-key';
  process.env.VAULT_PATH = '/tmp/test-vault';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.QDRANT_URL = 'http://localhost:6333';
});

const mockGetCollections = vi.fn();
const mockCreateCollection = vi.fn();
const mockCreatePayloadIndex = vi.fn();

vi.mock('@qdrant/js-client-rest', () => {
  class MockQdrantClient {
    getCollections = mockGetCollections;
    createCollection = mockCreateCollection;
    createPayloadIndex = mockCreatePayloadIndex;
  }
  return { QdrantClient: MockQdrantClient };
});

// Create a fake embedder plugin that satisfies the 'embedder' dependency
const fakeEmbedder: EmbeddingProvider = {
  dimensions: 1536,
  embed: vi.fn().mockResolvedValue([]),
};

function createEmbedderPlugin() {
  return fp(
    async (fastify) => {
      fastify.decorate('embedder', fakeEmbedder);
    },
    { name: 'embedder' },
  );
}

describe('qdrantPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates collection when it does not exist', async () => {
    mockGetCollections.mockResolvedValue({ collections: [] });
    mockCreateCollection.mockResolvedValue({});
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(createEmbedderPlugin());
    await app.register(qdrantPlugin);
    await app.ready();

    expect(mockCreateCollection).toHaveBeenCalledWith('cognivault', {
      vectors: { size: 1536, distance: 'Cosine' },
    });

    await app.close();
  });

  it('does not create collection when it already exists', async () => {
    mockGetCollections.mockResolvedValue({
      collections: [{ name: 'cognivault' }],
    });

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(createEmbedderPlugin());
    await app.register(qdrantPlugin);
    await app.ready();

    expect(mockCreateCollection).not.toHaveBeenCalled();

    await app.close();
  });

  it('creates payload indexes for all required fields when creating collection', async () => {
    mockGetCollections.mockResolvedValue({ collections: [] });
    mockCreateCollection.mockResolvedValue({});
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(createEmbedderPlugin());
    await app.register(qdrantPlugin);
    await app.ready();

    const indexedFields = mockCreatePayloadIndex.mock.calls.map(
      (call) => call[1].field_name,
    );

    expect(indexedFields).toContain('path');
    expect(indexedFields).toContain('tags');
    expect(indexedFields).toContain('project');
    expect(indexedFields).toContain('status');
    expect(indexedFields).toContain('type');
    expect(indexedFields).toContain('chunk_index');
    expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(6);

    await app.close();
  });

  it('decorates fastify.qdrant after plugin ready', async () => {
    mockGetCollections.mockResolvedValue({ collections: [] });
    mockCreateCollection.mockResolvedValue({});
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(createEmbedderPlugin());
    await app.register(qdrantPlugin);
    await app.ready();

    expect(app.qdrant).toBeDefined();
    expect(app.qdrant.getCollections).toBeDefined();

    await app.close();
  });

  it('does not create indexes when collection already exists', async () => {
    mockGetCollections.mockResolvedValue({
      collections: [{ name: 'cognivault' }],
    });

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(createEmbedderPlugin());
    await app.register(qdrantPlugin);
    await app.ready();

    expect(mockCreatePayloadIndex).not.toHaveBeenCalled();

    await app.close();
  });
});
