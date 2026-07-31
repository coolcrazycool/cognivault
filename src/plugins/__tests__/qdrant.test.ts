import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
const mockVersionInfo = vi.fn();
/** Records the options object the plugin passes to `new QdrantClient(...)`. */
const mockClientConstructor = vi.fn();

vi.mock('@qdrant/js-client-rest', () => {
  class MockQdrantClient {
    getCollections = mockGetCollections;
    getCollection = mockGetCollection;
    createCollection = mockCreateCollection;
    createPayloadIndex = mockCreatePayloadIndex;
    delete = mockDelete;
    versionInfo = mockVersionInfo;

    constructor(params?: unknown) {
      mockClientConstructor(params);
    }
  }
  return { QdrantClient: MockQdrantClient };
});

/** Fields the plugin indexes when it has to create the collection from scratch. */
const ALL_INDEXED_FIELDS = [
  'path',
  'tags',
  'project',
  'status',
  'type',
  'chunk_index',
  'text',
  'title',
  'section_path',
  'user_id',
];

/** Fields re-asserted idempotently on every start, even for an existing collection. */
const IDEMPOTENT_INDEXED_FIELDS = ['text', 'title', 'section_path', 'user_id'];

function indexedFieldNames(): string[] {
  return mockCreatePayloadIndex.mock.calls.map((call) => call[1].field_name);
}

describe('qdrantPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDelete.mockResolvedValue({});
    mockVersionInfo.mockResolvedValue({
      title: 'qdrant - vector search engine',
      version: '1.16.3',
    });
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

    // 6 keyword/integer indexes + 3 full-text indexes + 1 user_id keyword index
    expect(indexedFieldNames().sort()).toEqual([...ALL_INDEXED_FIELDS].sort());

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
      wait: true,
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
    expect(indexedFieldNames().sort()).toEqual([...IDEMPOTENT_INDEXED_FIELDS].sort());

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

  describe('payload index error handling', () => {
    it('logs an error and still starts when index creation fails for a real reason', async () => {
      mockGetCollections.mockResolvedValue({ collections: [{ name: 'cognivault' }] });
      mockCreatePayloadIndex.mockRejectedValue(new Error('Connection refused'));

      const Fastify = (await import('fastify')).default;
      const { default: qdrantPlugin } = await import('../qdrant.js');

      const app = Fastify({ logger: false });
      const errorSpy = vi.spyOn(app.log, 'error');

      await app.register(qdrantPlugin);
      await app.ready();

      expect(app.createTenantQdrant).toBeDefined();
      expect(errorSpy).toHaveBeenCalled();
      const loggedFields = errorSpy.mock.calls.map(
        (call) => (call[0] as { field?: string } | undefined)?.field,
      );
      expect(loggedFields).toContain('user_id');

      await app.close();
    });

    it('stays silent when the index already exists', async () => {
      mockGetCollections.mockResolvedValue({ collections: [{ name: 'cognivault' }] });
      mockCreatePayloadIndex.mockRejectedValue(
        new Error('Index already exists for field "user_id"'),
      );

      const Fastify = (await import('fastify')).default;
      const { default: qdrantPlugin } = await import('../qdrant.js');

      const app = Fastify({ logger: false });
      const errorSpy = vi.spyOn(app.log, 'error');

      await app.register(qdrantPlugin);
      await app.ready();

      expect(errorSpy).not.toHaveBeenCalled();

      await app.close();
    });

    it('stays silent when the server answers 409 Conflict', async () => {
      mockGetCollections.mockResolvedValue({ collections: [{ name: 'cognivault' }] });
      mockCreatePayloadIndex.mockRejectedValue(
        Object.assign(new Error('Conflict'), { status: 409 }),
      );

      const Fastify = (await import('fastify')).default;
      const { default: qdrantPlugin } = await import('../qdrant.js');

      const app = Fastify({ logger: false });
      const errorSpy = vi.spyOn(app.log, 'error');

      await app.register(qdrantPlugin);
      await app.ready();

      expect(errorSpy).not.toHaveBeenCalled();

      await app.close();
    });
  });

  describe('server version logging', () => {
    it('logs the server version on startup', async () => {
      mockGetCollections.mockResolvedValue({ collections: [{ name: 'cognivault' }] });
      mockCreatePayloadIndex.mockResolvedValue({});

      const Fastify = (await import('fastify')).default;
      const { default: qdrantPlugin } = await import('../qdrant.js');

      const app = Fastify({ logger: false });
      const infoSpy = vi.spyOn(app.log, 'info');

      await app.register(qdrantPlugin);
      await app.ready();

      const versionLog = infoSpy.mock.calls.find(
        (call) => (call[0] as { qdrantVersion?: string } | undefined)?.qdrantVersion === '1.16.3',
      );
      expect(versionLog).toBeDefined();

      await app.close();
    });

    it('warns on major version skew but still starts', async () => {
      mockGetCollections.mockResolvedValue({ collections: [{ name: 'cognivault' }] });
      mockCreatePayloadIndex.mockResolvedValue({});
      mockVersionInfo.mockResolvedValue({ title: 'qdrant', version: '2.0.0' });

      const Fastify = (await import('fastify')).default;
      const { default: qdrantPlugin } = await import('../qdrant.js');

      const app = Fastify({ logger: false });
      const warnSpy = vi.spyOn(app.log, 'warn');

      await app.register(qdrantPlugin);
      await app.ready();

      expect(warnSpy).toHaveBeenCalled();
      expect(app.createTenantQdrant).toBeDefined();

      await app.close();
    });

    it('starts even when the version probe fails', async () => {
      mockGetCollections.mockResolvedValue({ collections: [{ name: 'cognivault' }] });
      mockCreatePayloadIndex.mockResolvedValue({});
      mockVersionInfo.mockRejectedValue(new Error('Connection refused'));

      const Fastify = (await import('fastify')).default;
      const { default: qdrantPlugin } = await import('../qdrant.js');

      const app = Fastify({ logger: false });
      const warnSpy = vi.spyOn(app.log, 'warn');

      await app.register(qdrantPlugin);
      await app.ready();

      expect(warnSpy).toHaveBeenCalled();
      expect(app.createTenantQdrant).toBeDefined();

      await app.close();
    });
  });

  it('purges user vectors with wait: true', async () => {
    mockGetCollections.mockResolvedValue({ collections: [{ name: 'cognivault' }] });
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(qdrantPlugin);
    await app.ready();

    mockDelete.mockClear();
    await app.purgeUserVectors('user-42');

    expect(mockDelete).toHaveBeenCalledWith('cognivault', {
      wait: true,
      filter: { must: [{ key: 'user_id', match: { value: 'user-42' } }] },
    });

    await app.close();
  });

  describe('client construction', () => {
    const QDRANT_ENV_KEYS = ['QDRANT_USERNAME', 'QDRANT_PASSWORD', 'QDRANT_TIMEOUT_MS'] as const;

    const USERNAME = 'qdrant-reader';
    const PASSWORD = 'sup3r-s3cr3t-p@ss';

    interface ClientParams {
      url?: string;
      timeout?: number;
      checkCompatibility?: boolean;
      headers?: Record<string, string>;
    }

    interface StartedApp {
      close: () => Promise<void>;
      params: ClientParams;
      logCalls: unknown[][];
    }

    /**
     * Boot the plugin with a fresh module registry so `config.ts` re-reads process.env,
     * and hand back the options the client was constructed with plus every logger call.
     */
    async function start(env: Partial<Record<string, string>>): Promise<StartedApp> {
      for (const key of QDRANT_ENV_KEYS) {
        delete process.env[key];
      }
      for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
          process.env[key] = value;
        }
      }

      vi.resetModules();
      const Fastify = (await import('fastify')).default;
      const { default: qdrantPlugin } = await import('../qdrant.js');

      const app = Fastify({ logger: false });
      const logCalls: unknown[][] = [];
      for (const level of ['info', 'warn', 'error'] as const) {
        vi.spyOn(app.log, level).mockImplementation(((...args: unknown[]) => {
          logCalls.push(args);
          return undefined;
        }) as never);
      }

      await app.register(qdrantPlugin);
      await app.ready();

      const params = mockClientConstructor.mock.calls.at(-1)?.[0] as ClientParams;
      return { close: () => app.close(), params, logCalls };
    }

    beforeEach(() => {
      mockGetCollections.mockResolvedValue({ collections: [{ name: 'cognivault' }] });
      mockCreatePayloadIndex.mockResolvedValue({});
    });

    afterEach(() => {
      for (const key of QDRANT_ENV_KEYS) {
        delete process.env[key];
      }
    });

    it('sends a Basic Authorization header when both credentials are set', async () => {
      const { close, params } = await start({
        QDRANT_USERNAME: USERNAME,
        QDRANT_PASSWORD: PASSWORD,
      });

      const authorization = params.headers?.Authorization;
      expect(authorization).toMatch(/^Basic /);
      const decoded = Buffer.from(String(authorization).slice('Basic '.length), 'base64').toString(
        'utf8',
      );
      expect(decoded).toBe(`${USERNAME}:${PASSWORD}`);

      await close();
    });

    it('sends no Authorization header when credentials are absent', async () => {
      const { close, params } = await start({});

      expect(params.headers?.Authorization).toBeUndefined();

      await close();
    });

    it('disables the built-in compatibility check and forwards the timeout', async () => {
      const { close, params } = await start({ QDRANT_TIMEOUT_MS: '12345' });

      expect(params.checkCompatibility).toBe(false);
      expect(params.timeout).toBe(12345);

      await close();
    });

    it('defaults the timeout to 30s', async () => {
      const { close, params } = await start({});

      expect(params.timeout).toBe(30_000);

      await close();
    });

    it('never leaks the password into the logs', async () => {
      const { close, logCalls } = await start({
        QDRANT_USERNAME: USERNAME,
        QDRANT_PASSWORD: PASSWORD,
      });

      const serialized = JSON.stringify(logCalls);
      expect(serialized).not.toContain(PASSWORD);
      // The base64 blob must not surface either.
      expect(serialized).not.toContain(Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64'));
      // …but the auth MODE is reported, so a misconfiguration is visible in the logs.
      const authLog = logCalls.find(
        (args) => (args[0] as { qdrantAuth?: string } | undefined)?.qdrantAuth === 'basic',
      );
      expect(authLog).toBeDefined();

      await close();
    });

    it('reports qdrantAuth "none" when running without credentials', async () => {
      const { close, logCalls } = await start({});

      const authLog = logCalls.find(
        (args) => (args[0] as { qdrantAuth?: string } | undefined)?.qdrantAuth === 'none',
      );
      expect(authLog).toBeDefined();

      await close();
    });
  });
});
