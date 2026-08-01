import type { FastifyInstance } from 'fastify';
import { Registry as PromRegistry } from 'prom-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Set env vars before any module imports that trigger config parsing
process.env.VAULT_PATH = '/tmp/test-vault';
process.env.OPENAI_API_KEY = 'test-openai-key';

// ── Mocks ──

const mockIsIndexingValue = { value: false };
const mockStop = vi.fn();
const mockStart = vi.fn();
const mockRestart = vi.fn();
const mockIndexerEmit = vi.fn();
const mockIndexerOn = vi.fn();
const mockIndexerOnce = vi.fn();
const mockIndexerRemoveListener = vi.fn();

const mockIndexer = {
  get isIndexing() {
    return mockIsIndexingValue.value;
  },
  stop: mockStop,
  start: mockStart,
  restart: mockRestart,
  emit: mockIndexerEmit,
  on: mockIndexerOn,
  once: mockIndexerOnce,
  removeListener: mockIndexerRemoveListener,
};

const mockDbSelect = vi.fn().mockReturnValue({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
    }),
  }),
});

const mockUserDb = {
  select: mockDbSelect,
};

const mockUserQdrantDelete = vi.fn().mockResolvedValue(undefined);
const mockUserQdrant = {
  search: vi.fn(),
  scroll: vi.fn(),
  upsert: vi.fn(),
  delete: mockUserQdrantDelete,
  setPayload: vi.fn(),
};

const mockPipelineQueueOnIdle = vi.fn().mockResolvedValue(undefined);
const mockPipelineQueue = {
  onIdle: mockPipelineQueueOnIdle,
};

// ── Collection admin mocks ──

const PHYSICAL_COLLECTION = 'cognivault_v2';
const SCHEME_VERSION = 3;

const mockDropCollection = vi.fn().mockResolvedValue(undefined);
const mockCreateCollection = vi.fn().mockResolvedValue(undefined);
const mockDescribeCollection = vi.fn();

const mockQdrantAdmin = {
  alias: 'cognivault',
  collection: PHYSICAL_COLLECTION,
  expectedSchemeVersion: SCHEME_VERSION,
  describe: mockDescribeCollection,
  dropCollection: mockDropCollection,
  createCollection: mockCreateCollection,
};

// ── App builder ──

async function buildTestApp(): Promise<FastifyInstance> {
  const { default: Fastify } = await import('fastify');

  const app = Fastify({ logger: false });

  // Mock per-user indexers Map (keyed by userId)
  const indexersMap = new Map();
  indexersMap.set('test-admin', {
    // biome-ignore lint/suspicious/noExplicitAny: test mock -- intentionally partial VaultIndexer
    indexer: mockIndexer as any,
    // biome-ignore lint/suspicious/noExplicitAny: test mock -- intentionally partial PQueue
    queue: mockPipelineQueue as any,
    // biome-ignore lint/suspicious/noExplicitAny: test mock -- intentionally empty VaultManager
    vault: {} as any,
  });
  app.decorate('indexers', indexersMap);
  // biome-ignore lint/suspicious/noExplicitAny: test mock -- intentionally partial processFileChanges
  app.decorate('processFileChanges', vi.fn() as any);
  // biome-ignore lint/suspicious/noExplicitAny: test mock -- intentionally partial QdrantAdmin
  app.decorate('qdrantAdmin', mockQdrantAdmin as any);

  const { default: fp } = await import('fastify-plugin');

  // Mock metrics plugin (named, for auth dependency resolution)
  await app.register(
    fp(
      async (f) => {
        const promRegistry = new PromRegistry();
        f.decorate('metrics', { promRegistry } as unknown as FastifyInstance['metrics']);
      },
      { name: 'metrics' },
    ),
  );

  // Mock registry plugin (named, for auth dependency resolution)
  await app.register(
    fp(
      async (f) => {
        f.decorate('registry', {
          getAllUsers: () => [
            {
              userId: 'test-admin',
              apiKey: 'cv-test-admin-key',
              vaultPath: '/tmp/test-vault',
            },
          ],
          getUserByApiKey: (key: string) =>
            key === 'cv-test-admin-key'
              ? {
                  userId: 'test-admin',
                  apiKey: 'cv-test-admin-key',
                  vaultPath: '/tmp/test-vault',
                  openaiKey: 'test-openai-key',
                  obsidian: { email: 'test@test.com', password: 'secret', vault: 'v' },
                }
              : undefined,
        } as unknown as FastifyInstance['registry']);
      },
      { name: 'registry' },
    ),
  );

  // Real pipeline event bus — the reindex service subscribes to per-file failures
  const { default: pipelineEventsPlugin } = await import('../../../plugins/pipeline-events.js');
  await app.register(pipelineEventsPlugin);

  // Register error handler first
  const { default: errorHandler } = await import('../../../plugins/error-handler.js');
  await app.register(errorHandler);

  // Register auth plugin
  const { default: authPlugin } = await import('../../../plugins/auth.js');
  await app.register(authPlugin);

  // Add onRequest hook to provide getUserDb and getUserQdrant on authenticated requests
  app.addHook('onRequest', async (request) => {
    if (request.user) {
      request.getUserDb = () => mockUserDb as unknown as ReturnType<typeof request.getUserDb>;
      request.getUserQdrant = () =>
        mockUserQdrant as unknown as ReturnType<typeof request.getUserQdrant>;
    }
  });

  // Register admin routes with prefix
  const { adminRoutes } = await import('../routes.js');
  await app.register(adminRoutes, { prefix: '/api/admin' });

  await app.ready();
  return app;
}

describe('admin reindex routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsIndexingValue.value = false;
    mockUserQdrantDelete.mockResolvedValue(undefined);
    mockPipelineQueueOnIdle.mockResolvedValue(undefined);
    mockDropCollection.mockResolvedValue(undefined);
    mockCreateCollection.mockResolvedValue(undefined);
    mockDescribeCollection.mockResolvedValue({
      collection: PHYSICAL_COLLECTION,
      alias: 'cognivault',
      schemeVersion: 2,
      expectedSchemeVersion: SCHEME_VERSION,
      pointsCount: 4200,
    });
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue([]),
        }),
      }),
    });
  });

  describe('POST /api/admin/reindex', () => {
    it('returns 202 with jobId when scope is full and auth is valid', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/reindex',
        headers: { authorization: 'Bearer cv-test-admin-key', 'content-type': 'application/json' },
        payload: { scope: 'full' },
      });

      expect(response.statusCode).toBe(202);
      const body = response.json();
      expect(body.jobId).toBeDefined();
      expect(body.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(body.status).toBe('running');
      expect(body.message).toBeDefined();
    });

    it('returns 401 without auth token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/reindex',
        headers: { 'content-type': 'application/json' },
        payload: { scope: 'full' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 400 with invalid scope', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/reindex',
        headers: { authorization: 'Bearer cv-test-admin-key', 'content-type': 'application/json' },
        payload: { scope: 'invalid-scope' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 202 with jobId when scope is path', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/reindex',
        headers: { authorization: 'Bearer cv-test-admin-key', 'content-type': 'application/json' },
        payload: { scope: 'path', path: 'notes/test.md' },
      });

      expect(response.statusCode).toBe(202);
      const body = response.json();
      expect(body.jobId).toBeDefined();
    });

    it('returns 202 with jobId when scope is folder', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/reindex',
        headers: { authorization: 'Bearer cv-test-admin-key', 'content-type': 'application/json' },
        payload: { scope: 'folder', folder: 'projects/' },
      });

      expect(response.statusCode).toBe(202);
      const body = response.json();
      expect(body.jobId).toBeDefined();
    });

    it('returns 409 when full reindex already in progress', async () => {
      mockIsIndexingValue.value = true;

      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/reindex',
        headers: { authorization: 'Bearer cv-test-admin-key', 'content-type': 'application/json' },
        payload: { scope: 'full' },
      });

      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBeDefined();
    });

    it('returns 400 when scope is path but path field is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/reindex',
        headers: { authorization: 'Bearer cv-test-admin-key', 'content-type': 'application/json' },
        payload: { scope: 'path' },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/admin/reindex/status', () => {
    it('returns 200 with job state for valid jobId', async () => {
      // First create a job
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/admin/reindex',
        headers: { authorization: 'Bearer cv-test-admin-key', 'content-type': 'application/json' },
        payload: { scope: 'full' },
      });
      const { jobId } = createResponse.json();

      // Then query status
      const statusResponse = await app.inject({
        method: 'GET',
        url: `/api/admin/reindex/status?jobId=${jobId}`,
        headers: { authorization: 'Bearer cv-test-admin-key' },
      });

      expect(statusResponse.statusCode).toBe(200);
      const body = statusResponse.json();
      expect(body.jobId).toBe(jobId);
      expect(body.status).toBeDefined();
      expect(typeof body.filesProcessed).toBe('number');
      expect(typeof body.totalFiles).toBe('number');
      expect(Array.isArray(body.errors)).toBe(true);
      // errors[] is capped at 100 messages, so the true failure count is reported separately
      expect(typeof body.errorCount).toBe('number');
      expect(body.startedAt).toBeDefined();
    });

    it('returns 404 for nonexistent jobId', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/reindex/status?jobId=00000000-0000-0000-0000-000000000000',
        headers: { authorization: 'Bearer cv-test-admin-key' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 401 without auth token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/reindex/status?jobId=00000000-0000-0000-0000-000000000000',
      });

      expect(response.statusCode).toBe(401);
    });
  });
});

// ── Collection rebuild ──
//
// Its own app: the reindex suite above leaves full-reindex jobs registered as running
// (the mocked indexer never emits scanComplete), and a running reindex legitimately
// blocks a rebuild. A fresh instance gives these tests a clean interlock.
describe('admin collection routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsIndexingValue.value = false;
    mockUserQdrantDelete.mockResolvedValue(undefined);
    mockPipelineQueueOnIdle.mockResolvedValue(undefined);
    mockDropCollection.mockResolvedValue(undefined);
    mockCreateCollection.mockResolvedValue(undefined);
    mockDescribeCollection.mockResolvedValue({
      collection: PHYSICAL_COLLECTION,
      alias: 'cognivault',
      schemeVersion: 2,
      expectedSchemeVersion: SCHEME_VERSION,
      pointsCount: 4200,
    });
  });

  const AUTH = { authorization: 'Bearer cv-test-admin-key' };
  const JSON_AUTH = { ...AUTH, 'content-type': 'application/json' };

  /** Poll the status endpoint until the job is no longer running. */
  async function awaitRebuild(jobId: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/collection/rebuild/status?jobId=${jobId}`,
        headers: AUTH,
      });
      const body = res.json();
      if (body.status !== 'running') {
        return body;
      }
      if (Date.now() > deadline) {
        throw new Error(`Rebuild ${jobId} never settled (phase: ${body.phase})`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  describe('GET /api/admin/collection', () => {
    it('reports what a rebuild would destroy', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/collection',
        headers: AUTH,
      });

      expect(response.statusCode).toBe(200);
      // The operator has to type `collection` back — it must be exact, and nothing in
      // this response is pre-filled anywhere for them.
      expect(response.json()).toEqual({
        collection: PHYSICAL_COLLECTION,
        alias: 'cognivault',
        schemeVersion: 2,
        expectedSchemeVersion: SCHEME_VERSION,
        pointsCount: 4200,
      });
    });

    it('serialises a null scheme version and point count', async () => {
      mockDescribeCollection.mockResolvedValue({
        collection: PHYSICAL_COLLECTION,
        alias: 'cognivault',
        schemeVersion: null,
        expectedSchemeVersion: SCHEME_VERSION,
        pointsCount: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/collection',
        headers: AUTH,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ schemeVersion: null, pointsCount: null });
    });

    it('returns 401 without auth token', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/admin/collection' });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /api/admin/collection/rebuild', () => {
    it('returns 400 CONFIRM_MISMATCH when the confirmation is not the collection name', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/collection/rebuild',
        headers: JSON_AUTH,
        payload: { confirm: 'cognivault' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('CONFIRM_MISMATCH');
      // Nothing may be destroyed on a mistyped confirmation.
      expect(mockDropCollection).not.toHaveBeenCalled();
    });

    it('returns 400 when confirm is missing entirely', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/collection/rebuild',
        headers: JSON_AUTH,
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(mockDropCollection).not.toHaveBeenCalled();
    });

    it('returns 202 with a jobId and drops the collection when confirmed', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/collection/rebuild',
        headers: JSON_AUTH,
        payload: { confirm: PHYSICAL_COLLECTION },
      });

      expect(response.statusCode).toBe(202);
      const body = response.json();
      expect(body.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(body.status).toBe('running');
      // The 202 body warns about the outage the operator just started.
      expect(body.message).toMatch(/Search returns nothing/);

      const finished = await awaitRebuild(body.jobId);
      expect(finished.status).toBe('completed');
      expect(mockDropCollection).toHaveBeenCalledOnce();
      expect(mockCreateCollection).toHaveBeenCalledOnce();
    });

    it('returns 409 REBUILD_IN_PROGRESS for a second rebuild', async () => {
      let releaseDrop!: () => void;
      mockDropCollection.mockReturnValue(
        new Promise<void>((resolve) => {
          releaseDrop = resolve;
        }),
      );

      const first = await app.inject({
        method: 'POST',
        url: '/api/admin/collection/rebuild',
        headers: JSON_AUTH,
        payload: { confirm: PHYSICAL_COLLECTION },
      });
      expect(first.statusCode).toBe(202);

      const second = await app.inject({
        method: 'POST',
        url: '/api/admin/collection/rebuild',
        headers: JSON_AUTH,
        payload: { confirm: PHYSICAL_COLLECTION },
      });

      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('REBUILD_IN_PROGRESS');

      releaseDrop();
      await awaitRebuild(first.json().jobId);
    });

    it('makes a per-user reindex 409 while a rebuild is running', async () => {
      let releaseDrop!: () => void;
      mockDropCollection.mockReturnValue(
        new Promise<void>((resolve) => {
          releaseDrop = resolve;
        }),
      );

      const rebuild = await app.inject({
        method: 'POST',
        url: '/api/admin/collection/rebuild',
        headers: JSON_AUTH,
        payload: { confirm: PHYSICAL_COLLECTION },
      });

      const reindex = await app.inject({
        method: 'POST',
        url: '/api/admin/reindex',
        headers: JSON_AUTH,
        payload: { scope: 'full' },
      });

      expect(reindex.statusCode).toBe(409);
      expect(reindex.json().error.code).toBe('REINDEX_IN_PROGRESS');
      expect(reindex.json().error.message).toMatch(/collection rebuild/);
      // The rebuild owns the vectors — no per-user purge may run behind its back.
      expect(mockUserQdrantDelete).not.toHaveBeenCalled();

      releaseDrop();
      await awaitRebuild(rebuild.json().jobId);
    });

    it('returns 401 without auth token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/collection/rebuild',
        headers: { 'content-type': 'application/json' },
        payload: { confirm: PHYSICAL_COLLECTION },
      });

      expect(response.statusCode).toBe(401);
      expect(mockDropCollection).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/admin/collection/rebuild/status', () => {
    it('returns the full status shape and ends on phase done', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/admin/collection/rebuild',
        headers: JSON_AUTH,
        payload: { confirm: PHYSICAL_COLLECTION },
      });
      const { jobId } = created.json();

      const finished = await awaitRebuild(jobId);

      expect(finished).toMatchObject({
        jobId,
        status: 'completed',
        phase: 'done',
        collection: PHYSICAL_COLLECTION,
        schemeVersion: SCHEME_VERSION,
        usersTotal: 1,
        usersDone: 1,
        errorCount: 0,
      });
      expect(Array.isArray(finished.errors)).toBe(true);
      expect(typeof finished.filesProcessed).toBe('number');
      expect(finished.startedAt).toBeDefined();
      expect(finished.finishedAt).not.toBeNull();
    });

    it('reports a failed drop as failed, still in phase dropping', async () => {
      mockDropCollection.mockRejectedValue(new Error('Connection refused'));

      const created = await app.inject({
        method: 'POST',
        url: '/api/admin/collection/rebuild',
        headers: JSON_AUTH,
        payload: { confirm: PHYSICAL_COLLECTION },
      });

      const finished = await awaitRebuild(created.json().jobId);

      expect(finished.status).toBe('failed');
      expect(finished.phase).toBe('dropping');
      expect((finished.errors as string[])[0]).toMatch(/Nothing was destroyed/);
    });

    it('returns 404 JOB_NOT_FOUND for an unknown jobId', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/collection/rebuild/status?jobId=00000000-0000-0000-0000-000000000000',
        headers: AUTH,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('JOB_NOT_FOUND');
    });

    it('returns 401 without auth token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/collection/rebuild/status?jobId=00000000-0000-0000-0000-000000000000',
      });

      expect(response.statusCode).toBe(401);
    });
  });
});
