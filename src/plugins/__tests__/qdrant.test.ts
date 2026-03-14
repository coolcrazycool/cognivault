import fp from 'fastify-plugin';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingProvider } from '../../lib/embedding.js';

// Set required env vars before any imports that trigger config parsing
beforeAll(() => {
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

    const indexedFields = mockCreatePayloadIndex.mock.calls.map((call) => call[1].field_name);

    expect(indexedFields).toContain('path');
    expect(indexedFields).toContain('tags');
    expect(indexedFields).toContain('project');
    expect(indexedFields).toContain('status');
    expect(indexedFields).toContain('type');
    expect(indexedFields).toContain('chunk_index');
    // 6 keyword/integer indexes + 3 full-text indexes (text, title, section_path)
    expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(9);

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

  it('skips keyword/integer indexes but still creates text indexes when collection already exists', async () => {
    mockGetCollections.mockResolvedValue({
      collections: [{ name: 'cognivault' }],
    });
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(createEmbedderPlugin());
    await app.register(qdrantPlugin);
    await app.ready();

    // Keyword/integer indexes are NOT created (inside if (!exists) block)
    expect(mockCreateCollection).not.toHaveBeenCalled();
    // Text indexes ARE created idempotently (outside if (!exists) block)
    const indexedFields = mockCreatePayloadIndex.mock.calls.map((call) => call[1].field_name);
    expect(indexedFields).toContain('text');
    expect(indexedFields).toContain('title');
    expect(indexedFields).toContain('section_path');
    expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(3);

    await app.close();
  });

  it('creates full-text text indexes with multilingual tokenizer and lowercase', async () => {
    mockGetCollections.mockResolvedValue({ collections: [] });
    mockCreateCollection.mockResolvedValue({});
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(createEmbedderPlugin());
    await app.register(qdrantPlugin);
    await app.ready();

    const textIndexCalls = mockCreatePayloadIndex.mock.calls.filter(
      (call) => typeof call[1].field_schema === 'object' && call[1].field_schema.type === 'text',
    );
    expect(textIndexCalls.length).toBe(3);
    for (const call of textIndexCalls) {
      expect(call[1].field_schema).toMatchObject({
        type: 'text',
        tokenizer: 'multilingual',
        lowercase: true,
      });
    }

    await app.close();
  });
});
