import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantQdrantClient } from '../../lib/tenant-qdrant-client.js';

// Set required env vars before any imports that trigger config parsing
beforeAll(() => {
  process.env.VAULT_PATH = '/tmp/test-vault';
  process.env.QDRANT_URL = 'http://localhost:6333';
});

const mockGetCollections = vi.fn();
const mockGetCollection = vi.fn();
const mockCollectionExists = vi.fn();
const mockCreateCollection = vi.fn();
const mockCreatePayloadIndex = vi.fn();
const mockGetAliases = vi.fn();
const mockUpdateCollectionAliases = vi.fn();
const mockDelete = vi.fn();
const mockQuery = vi.fn();
const mockVersionInfo = vi.fn();
/** Records the options object the plugin passes to `new QdrantClient(...)`. */
const mockClientConstructor = vi.fn();

vi.mock('@qdrant/js-client-rest', () => {
  class MockQdrantClient {
    getCollections = mockGetCollections;
    getCollection = mockGetCollection;
    collectionExists = mockCollectionExists;
    createCollection = mockCreateCollection;
    createPayloadIndex = mockCreatePayloadIndex;
    getAliases = mockGetAliases;
    updateCollectionAliases = mockUpdateCollectionAliases;
    delete = mockDelete;
    query = mockQuery;
    versionInfo = mockVersionInfo;

    constructor(params?: unknown) {
      mockClientConstructor(params);
    }
  }
  return { QdrantClient: MockQdrantClient };
});

/** Runtime name — an ALIAS since the hybrid rework, not a collection. */
const ALIAS = 'cognivault';
/** Physical collection the alias points at. */
const PHYSICAL = 'cognivault_v2';

/** Nothing provisioned yet: no alias, no collections. */
function emptyCluster(): void {
  mockGetAliases.mockResolvedValue({ aliases: [] });
  mockGetCollections.mockResolvedValue({ collections: [] });
}

/** Steady state: the alias exists and points at the current physical collection. */
function provisioned(): void {
  mockGetAliases.mockResolvedValue({
    aliases: [{ alias_name: ALIAS, collection_name: PHYSICAL }],
  });
  mockGetCollections.mockResolvedValue({ collections: [{ name: PHYSICAL }] });
}

/** Options `createCollection` was called with. */
function createdSchema(): Record<string, unknown> {
  return mockCreateCollection.mock.calls[0]?.[1] as Record<string, unknown>;
}

/** Hands out IAM tokens without touching the network. */
const mockGetToken = vi.fn();
let mockExpiresAt: number | undefined;

vi.mock('../../lib/qdrant-auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/qdrant-auth.js')>();
  return {
    ...actual,
    QdrantTokenProvider: class {
      getToken = mockGetToken;
      get expiresAt(): number | undefined {
        return mockExpiresAt;
      }
      get expirySource(): string {
        return 'jwt-exp';
      }
    },
  };
});

/**
 * Fields that MUST be indexed when the plugin creates the collection from scratch.
 * Asserted as a subset, not as an exact list — adding a filterable field is a routine
 * change and must not break unrelated tests.
 */
const REQUIRED_INDEXED_FIELDS = [
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

/** Fields only created together with the collection, never on a restart. */
const CREATION_ONLY_INDEXED_FIELDS = ['path', 'tags', 'project', 'status', 'type', 'chunk_index'];

function indexedFieldNames(): string[] {
  return mockCreatePayloadIndex.mock.calls.map((call) => call[1].field_name);
}

/** Collection names every `createPayloadIndex` call targeted. */
function indexedCollections(): string[] {
  return mockCreatePayloadIndex.mock.calls.map((call) => call[0]);
}

describe('qdrantPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDelete.mockResolvedValue({});
    mockCreateCollection.mockResolvedValue({});
    mockUpdateCollectionAliases.mockResolvedValue(true);
    mockVersionInfo.mockResolvedValue({
      title: 'qdrant - vector search engine',
      version: '1.16.3',
    });
    // Existing-collection probe defaults to the hybrid schema at the openai size.
    mockGetCollection.mockResolvedValue({
      config: {
        params: {
          vectors: { dense: { size: 1536, distance: 'Cosine', on_disk: true } },
          sparse_vectors: { bm25: { modifier: 'idf' } },
        },
      },
    });
    emptyCluster();
  });

  it('creates the physical collection with the hybrid schema when nothing exists', async () => {
    emptyCluster();
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(qdrantPlugin);
    await app.ready();

    // The collection is created under its PHYSICAL name — `cognivault` is the alias.
    expect(mockCreateCollection.mock.calls[0]?.[0]).toBe(PHYSICAL);
    expect(createdSchema()).toMatchObject({
      vectors: { dense: { size: 1536, distance: 'Cosine', on_disk: true } },
      sparse_vectors: { bm25: { modifier: 'idf' } },
      on_disk_payload: true,
    });

    await app.close();
  });

  it('does not create collection when it already exists', async () => {
    provisioned();
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
    emptyCluster();
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(qdrantPlugin);
    await app.ready();

    // Keyword/integer + full-text + the user_id tenant index. A superset is fine —
    // what matters is that none of these is missing.
    expect(indexedFieldNames()).toEqual(expect.arrayContaining(REQUIRED_INDEXED_FIELDS));
    // …all of them on the physical collection, never on the alias.
    expect(new Set(indexedCollections())).toEqual(new Set([PHYSICAL]));

    await app.close();
  });

  it('creates the user_id index as a tenant index', async () => {
    provisioned();
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(qdrantPlugin);
    await app.ready();

    expect(indexedFieldNames()).toContain('user_id');

    const userIdCall = mockCreatePayloadIndex.mock.calls.find(
      (call) => call[1].field_name === 'user_id',
    );
    // `is_tenant` co-locates one user's points on disk — every query filters by it.
    expect(userIdCall?.[1].field_schema).toMatchObject({ type: 'keyword', is_tenant: true });

    await app.close();
  });

  it('purges legacy vectors without user_id on startup', async () => {
    provisioned();
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(qdrantPlugin);
    await app.ready();

    // Maintenance work targets the physical collection, not the alias.
    expect(mockDelete).toHaveBeenCalledWith(PHYSICAL, {
      wait: true,
      filter: {
        must: [{ is_empty: { key: 'user_id' } }],
      },
    });

    await app.close();
  });

  it('decorates fastify.createTenantQdrant factory (not fastify.qdrant)', async () => {
    emptyCluster();
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
    emptyCluster();
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
    provisioned();
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(qdrantPlugin);
    await app.ready();

    // Keyword/integer indexes are NOT re-created for an existing collection
    expect(mockCreateCollection).not.toHaveBeenCalled();
    const fields = indexedFieldNames();
    expect(fields).toEqual(expect.arrayContaining(IDEMPOTENT_INDEXED_FIELDS));
    for (const field of CREATION_ONLY_INDEXED_FIELDS) {
      expect(fields).not.toContain(field);
    }

    await app.close();
  });

  it('creates full-text text indexes with multilingual tokenizer and lowercase', async () => {
    emptyCluster();
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(qdrantPlugin);
    await app.ready();

    const textIndexCalls = mockCreatePayloadIndex.mock.calls.filter(
      (call) => typeof call[1].field_schema === 'object' && call[1].field_schema.type === 'text',
    );
    // Whichever fields get full-text indexes, they all share the same analyzer.
    expect(textIndexCalls.map((call) => call[1].field_name)).toEqual(
      expect.arrayContaining(['text', 'title', 'section_path']),
    );
    for (const call of textIndexCalls) {
      expect(call[1].field_schema).toMatchObject({
        type: 'text',
        tokenizer: 'multilingual',
        lowercase: true,
      });
    }

    await app.close();
  });

  describe('alias resolution', () => {
    /** Boot the plugin and hand the app back; caller closes it. */
    async function boot(): Promise<FastifyInstance> {
      mockCreatePayloadIndex.mockResolvedValue({});
      const Fastify = (await import('fastify')).default;
      const { default: qdrantPlugin } = await import('../qdrant.js');
      const app = Fastify({ logger: false });
      await app.register(qdrantPlugin);
      await app.ready();
      return app;
    }

    it('attaches the alias atomically after creating the collection', async () => {
      emptyCluster();

      const app = await boot();

      expect(mockUpdateCollectionAliases).toHaveBeenCalledWith({
        actions: [{ create_alias: { collection_name: PHYSICAL, alias_name: ALIAS } }],
      });

      await app.close();
    });

    it('leaves an alias that already points at the physical collection alone', async () => {
      provisioned();

      const app = await boot();

      expect(mockUpdateCollectionAliases).not.toHaveBeenCalled();
      expect(mockCreateCollection).not.toHaveBeenCalled();

      await app.close();
    });

    it('only attaches the alias when the collection is already there', async () => {
      mockGetAliases.mockResolvedValue({ aliases: [] });
      mockGetCollections.mockResolvedValue({ collections: [{ name: PHYSICAL }] });

      const app = await boot();

      // Half-finished previous start: collection created, alias never attached.
      expect(mockCreateCollection).not.toHaveBeenCalled();
      expect(mockUpdateCollectionAliases).toHaveBeenCalledTimes(1);
      // …and the schema of the collection we adopted is verified.
      expect(mockGetCollection).toHaveBeenCalledWith(PHYSICAL);

      await app.close();
    });

    it('refuses to start when the alias name is taken by a COLLECTION', async () => {
      mockGetAliases.mockResolvedValue({ aliases: [] });
      mockGetCollections.mockResolvedValue({ collections: [{ name: ALIAS }] });
      mockCreatePayloadIndex.mockResolvedValue({});

      const Fastify = (await import('fastify')).default;
      const { default: qdrantPlugin } = await import('../qdrant.js');
      const app = Fastify({ logger: false });
      // NOT awaited: awaiting `register` boots the app, and the rejection would then
      // escape the assertion below.
      void app.register(qdrantPlugin);

      await expect(app.ready()).rejects.toThrow(/exists as a COLLECTION, not as an alias/);
      // The legacy collection is the rollback path — nothing may touch it.
      expect(mockUpdateCollectionAliases).not.toHaveBeenCalled();
      expect(mockCreateCollection).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();

      await app.close();
    });

    it('warns but keeps serving when the alias points at an older collection', async () => {
      mockGetAliases.mockResolvedValue({
        aliases: [{ alias_name: ALIAS, collection_name: 'cognivault_v1' }],
      });
      mockGetCollections.mockResolvedValue({ collections: [{ name: 'cognivault_v1' }] });
      mockCreatePayloadIndex.mockResolvedValue({});

      const Fastify = (await import('fastify')).default;
      const { default: qdrantPlugin } = await import('../qdrant.js');
      const app = Fastify({ logger: false });
      const warnSpy = vi.spyOn(app.log, 'warn');

      await app.register(qdrantPlugin);
      await app.ready();

      const reindexWarning = warnSpy.mock.calls.find((call) =>
        String(call[1]).includes('points at an older collection'),
      );
      expect(reindexWarning).toBeDefined();
      // A rolled-back deployment keeps working against whatever the alias points at.
      expect(mockCreateCollection).not.toHaveBeenCalled();
      expect(mockGetCollection).toHaveBeenCalledWith('cognivault_v1');
      expect(app.createTenantQdrant).toBeDefined();

      await app.close();
    });
  });

  describe('existing collection schema', () => {
    async function expectStartupError(pattern: RegExp): Promise<void> {
      mockCreatePayloadIndex.mockResolvedValue({});
      const Fastify = (await import('fastify')).default;
      const { default: qdrantPlugin } = await import('../qdrant.js');
      const app = Fastify({ logger: false });
      // NOT awaited — see the comment in the alias-conflict test.
      void app.register(qdrantPlugin);
      await expect(app.ready()).rejects.toThrow(pattern);
      await app.close();
    }

    beforeEach(() => {
      provisioned();
    });

    it('refuses to start on the legacy UNNAMED vector schema', async () => {
      mockGetCollection.mockResolvedValue({
        config: { params: { vectors: { size: 1536, distance: 'Cosine' } } },
      });

      await expectStartupError(/legacy UNNAMED vector schema/);
    });

    it('refuses to start when the named "dense" vector is missing', async () => {
      mockGetCollection.mockResolvedValue({
        config: { params: { vectors: { embedding: { size: 1536, distance: 'Cosine' } } } },
      });

      await expectStartupError(/has no "dense" vector/);
    });

    it('refuses to start when the dense vector size does not match the provider', async () => {
      mockGetCollection.mockResolvedValue({
        config: {
          params: {
            vectors: { dense: { size: 1024, distance: 'Cosine' } },
            sparse_vectors: { bm25: { modifier: 'idf' } },
          },
        },
      });

      await expectStartupError(/has vector size 1024, but the active embedding provider/);
    });

    it('warns but starts when the sparse bm25 vector is missing', async () => {
      mockGetCollection.mockResolvedValue({
        config: { params: { vectors: { dense: { size: 1536, distance: 'Cosine' } } } },
      });
      mockCreatePayloadIndex.mockResolvedValue({});

      const Fastify = (await import('fastify')).default;
      const { default: qdrantPlugin } = await import('../qdrant.js');
      const app = Fastify({ logger: false });
      const warnSpy = vi.spyOn(app.log, 'warn');

      await app.register(qdrantPlugin);
      await app.ready();

      const sparseWarning = warnSpy.mock.calls.find((call) =>
        String(call[1]).includes('sparse vector'),
      );
      expect(sparseWarning).toBeDefined();
      expect(app.createTenantQdrant).toBeDefined();

      await app.close();
    });
  });

  describe('quantization', () => {
    /** Re-import the plugin so `config.ts` re-reads QDRANT_QUANTIZATION. */
    async function bootWithQuantization(value: string | undefined): Promise<FastifyInstance> {
      if (value === undefined) {
        delete process.env.QDRANT_QUANTIZATION;
      } else {
        process.env.QDRANT_QUANTIZATION = value;
      }
      emptyCluster();
      mockCreatePayloadIndex.mockResolvedValue({});

      vi.resetModules();
      const Fastify = (await import('fastify')).default;
      const { default: qdrantPlugin } = await import('../qdrant.js');
      const app = Fastify({ logger: false });
      await app.register(qdrantPlugin);
      await app.ready();
      return app;
    }

    afterEach(() => {
      delete process.env.QDRANT_QUANTIZATION;
    });

    it('is off by default — the external database decides', async () => {
      const app = await bootWithQuantization(undefined);

      expect(createdSchema()).not.toHaveProperty('quantization_config');

      await app.close();
    });

    it('adds a scalar int8 quantization config when QDRANT_QUANTIZATION=true', async () => {
      const app = await bootWithQuantization('true');

      expect(createdSchema()).toMatchObject({
        quantization_config: { scalar: { type: 'int8', quantile: 0.99, always_ram: true } },
      });

      await app.close();
    });
  });

  describe('payload index error handling', () => {
    it('logs an error and still starts when index creation fails for a real reason', async () => {
      provisioned();
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
      provisioned();
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
      provisioned();
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
      provisioned();
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
      provisioned();
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
      provisioned();
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
    provisioned();
    mockCreatePayloadIndex.mockResolvedValue({});

    const Fastify = (await import('fastify')).default;
    const { default: qdrantPlugin } = await import('../qdrant.js');

    const app = Fastify({ logger: false });
    await app.register(qdrantPlugin);
    await app.ready();

    mockDelete.mockClear();
    await app.purgeUserVectors('user-42');

    // Runtime point traffic goes through the ALIAS, so a re-index can repoint it.
    expect(mockDelete).toHaveBeenCalledWith(ALIAS, {
      wait: true,
      filter: { must: [{ key: 'user_id', match: { value: 'user-42' } }] },
    });

    await app.close();
  });

  describe('client construction', () => {
    const QDRANT_ENV_KEYS = [
      'QDRANT_API_KEY',
      'QDRANT_USERNAME',
      'QDRANT_PASSWORD',
      'QDRANT_TIMEOUT_MS',
      'QDRANT_AUTH_URL',
      'QDRANT_TOKEN_REFRESH_SKEW_MS',
    ] as const;

    const USERNAME = 'qdrant-reader';
    const PASSWORD = 'sup3r-s3cr3t-p@ss';
    const API_KEY = 'qdr4nt-@pi-k3y-v3ry-s3cr3t';
    const TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0dXoifQ.s1gn4tur3';
    const NEXT_TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0dXoiLCJuIjoyfQ.n3xt';

    interface ClientParams {
      url?: string;
      timeout?: number;
      checkCompatibility?: boolean;
      apiKey?: string;
      headers?: Record<string, string>;
    }

    interface StartedApp {
      app: FastifyInstance;
      close: () => Promise<void>;
      params: ClientParams;
      logCalls: unknown[][];
    }

    /** Options of the most recently constructed client. */
    function latestParams(): ClientParams {
      return mockClientConstructor.mock.calls.at(-1)?.[0] as ClientParams;
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

      return { app, close: () => app.close(), params: latestParams(), logCalls };
    }

    beforeEach(() => {
      provisioned();
      mockCreatePayloadIndex.mockResolvedValue({});
      mockGetToken.mockResolvedValue(TOKEN);
      mockExpiresAt = Date.now() + 3_600_000;
    });

    afterEach(() => {
      for (const key of QDRANT_ENV_KEYS) {
        delete process.env[key];
      }
    });

    it('passes the api key to the client and sends no Authorization header', async () => {
      const { close, params } = await start({ QDRANT_API_KEY: API_KEY });

      // The client sets the `api-key` header itself — we must not add one ourselves.
      expect(params.apiKey).toBe(API_KEY);
      expect(params.headers?.Authorization).toBeUndefined();
      // `https` stays untouched: the scheme comes from the URL.
      expect((params as { https?: boolean }).https).toBeUndefined();

      await close();
    });

    it('sends the IAM token as a Bearer header when username/password are set', async () => {
      const { close, params } = await start({
        QDRANT_USERNAME: USERNAME,
        QDRANT_PASSWORD: PASSWORD,
      });

      expect(params.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
      // The JWT is the whole credential — no api key tags along.
      expect(params.apiKey).toBeUndefined();
      // The credentials themselves never reach the database client.
      expect(JSON.stringify(params)).not.toContain(PASSWORD);
      expect(JSON.stringify(params)).not.toContain(USERNAME);

      await close();
    });

    it('mints exactly one token at startup', async () => {
      const { close } = await start({
        QDRANT_USERNAME: USERNAME,
        QDRANT_PASSWORD: PASSWORD,
      });

      expect(mockGetToken).toHaveBeenCalledTimes(1);

      await close();
    });

    it('recreates the client on renewal, and createTenantQdrant wraps the NEW one', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        // Skew larger than the remaining lifetime collapses the delay to its 1s floor.
        mockExpiresAt = Date.now() + 60_000;
        const started = await start({
          QDRANT_USERNAME: USERNAME,
          QDRANT_PASSWORD: PASSWORD,
          QDRANT_TOKEN_REFRESH_SKEW_MS: '600000',
        });

        const clientsBefore = mockClientConstructor.mock.calls.length;
        expect(latestParams().headers?.Authorization).toBe(`Bearer ${TOKEN}`);
        const wrapperBefore = started.app.createTenantQdrant('user-1') as unknown as {
          client: unknown;
        };

        mockGetToken.mockResolvedValue(NEXT_TOKEN);
        mockExpiresAt = Date.now() + 3_600_000;
        await vi.advanceTimersByTimeAsync(1_500);

        // A brand-new client, built with the renewed header.
        expect(mockClientConstructor.mock.calls.length).toBe(clientsBefore + 1);
        expect(latestParams().headers?.Authorization).toBe(`Bearer ${NEXT_TOKEN}`);

        // …and the factory hands out wrappers over it, not over the retired client.
        const wrapperAfter = started.app.createTenantQdrant('user-1') as unknown as {
          client: unknown;
        };
        expect(wrapperAfter.client).not.toBe(wrapperBefore.client);

        await started.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps running when a renewal fails, and logs the failure', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        mockExpiresAt = Date.now() + 60_000;
        const started = await start({
          QDRANT_USERNAME: USERNAME,
          QDRANT_PASSWORD: PASSWORD,
          QDRANT_TOKEN_REFRESH_SKEW_MS: '600000',
        });

        const clientsBefore = mockClientConstructor.mock.calls.length;
        mockGetToken.mockRejectedValue(new Error('IAM unreachable'));
        await vi.advanceTimersByTimeAsync(1_500);

        // The old client stays in place — the current token is usually still valid.
        expect(mockClientConstructor.mock.calls.length).toBe(clientsBefore);
        // `vi.resetModules()` gives the plugin its own copy of the module, so compare
        // by constructor name rather than by identity.
        expect(started.app.createTenantQdrant('user-1').constructor.name).toBe(
          TenantQdrantClient.name,
        );
        const failureLog = started.logCalls.find((args) =>
          String(args[1]).includes('Failed to refresh Qdrant IAM token'),
        );
        expect(failureLog).toBeDefined();

        await started.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it('sends neither an api key nor an Authorization header when nothing is set', async () => {
      const { close, params } = await start({});

      expect(params.apiKey).toBeUndefined();
      expect(params.headers?.Authorization).toBeUndefined();

      await close();
    });

    it('refuses to boot when the api key and the IAM credentials are both set', async () => {
      for (const key of QDRANT_ENV_KEYS) {
        delete process.env[key];
      }
      process.env.QDRANT_API_KEY = API_KEY;
      process.env.QDRANT_USERNAME = USERNAME;
      process.env.QDRANT_PASSWORD = PASSWORD;

      vi.resetModules();
      await expect(import('../../config.js')).rejects.toThrow(/mutually exclusive/);
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

    it('never leaks the api key into the logs and reports qdrantAuth "api-key"', async () => {
      const { close, logCalls } = await start({ QDRANT_API_KEY: API_KEY });

      expect(JSON.stringify(logCalls)).not.toContain(API_KEY);
      const authLog = logCalls.find(
        (args) => (args[0] as { qdrantAuth?: string } | undefined)?.qdrantAuth === 'api-key',
      );
      expect(authLog).toBeDefined();

      await close();
    });

    it('leaks neither the password nor the token into the logs', async () => {
      const { close, logCalls } = await start({
        QDRANT_USERNAME: USERNAME,
        QDRANT_PASSWORD: PASSWORD,
      });

      const serialized = JSON.stringify(logCalls);
      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain(TOKEN);
      // …but the auth MODE is reported, so a misconfiguration is visible in the logs.
      const authLog = logCalls.find(
        (args) => (args[0] as { qdrantAuth?: string } | undefined)?.qdrantAuth === 'iam',
      );
      expect(authLog).toBeDefined();

      await close();
    });

    it('logs the token by length and expiry only', async () => {
      const { close, logCalls } = await start({
        QDRANT_USERNAME: USERNAME,
        QDRANT_PASSWORD: PASSWORD,
      });

      const tokenLog = logCalls.find((args) => args[1] === 'Obtained Qdrant IAM token')?.[0] as
        | Record<string, unknown>
        | undefined;

      expect(tokenLog).toMatchObject({ tokenLength: TOKEN.length, expirySource: 'jwt-exp' });
      expect(typeof tokenLog?.expiresAt).toBe('string');

      await close();
    });

    it('derives the IAM endpoint from the QDRANT_URL origin unless told otherwise', async () => {
      const started = await start({
        QDRANT_USERNAME: USERNAME,
        QDRANT_PASSWORD: PASSWORD,
      });
      const derived = started.logCalls.find(
        (args) => args[1] === 'Obtained Qdrant IAM token',
      )?.[0] as { qdrantAuthUrl?: string } | undefined;
      expect(derived?.qdrantAuthUrl).toBe('http://localhost:6333/auth');
      await started.close();

      const overridden = await start({
        QDRANT_USERNAME: USERNAME,
        QDRANT_PASSWORD: PASSWORD,
        QDRANT_AUTH_URL: 'https://vectordb.example:6533/auth',
      });
      const explicit = overridden.logCalls.find(
        (args) => args[1] === 'Obtained Qdrant IAM token',
      )?.[0] as { qdrantAuthUrl?: string } | undefined;
      expect(explicit?.qdrantAuthUrl).toBe('https://vectordb.example:6533/auth');
      await overridden.close();
    });

    // The "custom" TLS path (and its no-leak guarantees) lives in
    // src/lib/__tests__/qdrant-tls.test.ts — installing a real undici dispatcher
    // from here would mutate the global dispatcher of the whole test process.
    it('reports the TLS mode on the same line as the auth mode', async () => {
      const { close, logCalls } = await start({});

      const configuredLog = logCalls.find((args) => args[1] === 'Qdrant client configured')?.[0] as
        | Record<string, unknown>
        | undefined;

      expect(configuredLog).toMatchObject({
        qdrantTls: 'system',
        qdrantClientCert: false,
        qdrantVerifySsl: true,
      });

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
