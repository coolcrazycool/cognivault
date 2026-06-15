import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantQdrantClient } from '../../lib/tenant-qdrant-client.js';

// Set required env vars before any imports that trigger config parsing
beforeAll(() => {
  process.env.VAULT_PATH = '/tmp/test-vault';
  process.env.QDRANT_URL = 'http://localhost:6333';
});

const mockGetCollections = vi.fn();
const mockGetCollection = vi.fn();
const mockCreateCollection = vi.fn();
const mockCreatePayloadIndex = vi.fn();
const mockDelete = vi.fn();

vi.mock('@qdrant/js-client-rest', () => {
  class MockQdrantClient {
    getCollections = mockGetCollections;
    getCollection = mockGetCollection;
    createCollection = mockCreateCollection;
    createPayloadIndex = mockCreatePayloadIndex;
    delete = mockDelete;
  }
  return { QdrantClient: MockQdrantClient };
});

describe('qdrantPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDelete.mockResolvedValue({});
    // Existing-collection probe defaults to a matching vector size (openai 1536)
    mockGetCollection.mockResolvedValue({
      config: { params: { vectors: { size: 1536, distance: 'Cosine' } } },
    });
  });

  it('creates collection when it does not exist', async () => {
    mockGetCollections.mockResolvedValue({ collections: [] });
    mockCreateCollection.mockResolvedValue({});
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
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
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
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
    await app.register(qdrantPlugin);
    await app.ready();

    const indexedFields = mockCreatePayloadIndex.mock.calls.map((call) => call[1].field_name);

    expect(indexedFields).toContain('path');
    expect(indexedFields).toContain('tags');
    expect(indexedFields).toContain('project');
    expect(indexedFields).toContain('status');
    expect(indexedFields).toContain('type');
    expect(indexedFields).toContain('chunk_index');
    // 6 keyword/integer indexes + 3 full-text indexes + 1 user_id keyword index
    expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(10);

    await app.close();
  });

  it('creates user_id keyword index idempotently', async () => {
    mockGetCollections.mockResolvedValue({
      collections: [{ name: 'cognivault' }],
    });
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(qdrantPlugin);
    await app.ready();

    const indexedFields = mockCreatePayloadIndex.mock.calls.map((call) => call[1].field_name);
    expect(indexedFields).toContain('user_id');

    const userIdCall = mockCreatePayloadIndex.mock.calls.find(
      (call) => call[1].field_name === 'user_id',
    );
    expect(userIdCall?.[1].field_schema).toBe('keyword');

    await app.close();
  });

  it('purges legacy vectors without user_id on startup', async () => {
    mockGetCollections.mockResolvedValue({
      collections: [{ name: 'cognivault' }],
    });
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(qdrantPlugin);
    await app.ready();

    expect(mockDelete).toHaveBeenCalledWith('cognivault', {
      filter: {
        must: [{ is_empty: { key: 'user_id' } }],
      },
    });

    await app.close();
  });

  it('decorates fastify.createTenantQdrant factory (not fastify.qdrant)', async () => {
    mockGetCollections.mockResolvedValue({ collections: [] });
    mockCreateCollection.mockResolvedValue({});
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(qdrantPlugin);
    await app.ready();

    expect(app.createTenantQdrant).toBeDefined();
    expect(typeof app.createTenantQdrant).toBe('function');

    const tenantClient = app.createTenantQdrant('test-user');
    expect(tenantClient).toBeInstanceOf(TenantQdrantClient);

    // Raw client should NOT be exposed
    expect((app as unknown as Record<string, unknown>).qdrant).toBeUndefined();

    await app.close();
  });

  it('decorates fastify.purgeUserVectors function', async () => {
    mockGetCollections.mockResolvedValue({ collections: [] });
    mockCreateCollection.mockResolvedValue({});
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(qdrantPlugin);
    await app.ready();

    expect(app.purgeUserVectors).toBeDefined();
    expect(typeof app.purgeUserVectors).toBe('function');

    await app.close();
  });

  it('skips keyword/integer indexes but still creates text and user_id indexes when collection already exists', async () => {
    mockGetCollections.mockResolvedValue({
      collections: [{ name: 'cognivault' }],
    });
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(qdrantPlugin);
    await app.ready();

    // Keyword/integer indexes are NOT created (inside if (!exists) block)
    expect(mockCreateCollection).not.toHaveBeenCalled();
    // Text indexes + user_id index ARE created idempotently (outside if (!exists) block)
    const indexedFields = mockCreatePayloadIndex.mock.calls.map((call) => call[1].field_name);
    expect(indexedFields).toContain('text');
    expect(indexedFields).toContain('title');
    expect(indexedFields).toContain('section_path');
    expect(indexedFields).toContain('user_id');
    // 3 text indexes + 1 user_id index
    expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(4);

    await app.close();
  });

  it('creates full-text text indexes with multilingual tokenizer and lowercase', async () => {
    mockGetCollections.mockResolvedValue({ collections: [] });
    mockCreateCollection.mockResolvedValue({});
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
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
