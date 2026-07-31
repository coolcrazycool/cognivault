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
      mockGetCollections.mockResolvedValue({ collections: [{ name: 'cognivault' }] });
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
