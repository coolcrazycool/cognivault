import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Registry as PromRegistry } from 'prom-client';

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

const mockDb = {
  select: mockDbSelect,
};

const mockQdrantDelete = vi.fn().mockResolvedValue(undefined);
const mockQdrant = {
  delete: mockQdrantDelete,
};

const mockPipelineQueueOnIdle = vi.fn().mockResolvedValue(undefined);
const mockPipelineQueue = {
  onIdle: mockPipelineQueueOnIdle,
};

// ── App builder ──

async function buildTestApp(): Promise<FastifyInstance> {
  const { default: Fastify } = await import('fastify');

  const app = Fastify({ logger: false });

  // biome-ignore lint/suspicious/noExplicitAny: test mock — intentionally partial VaultIndexer
  app.decorate('indexer', mockIndexer as any);
  // biome-ignore lint/suspicious/noExplicitAny: test mock — intentionally partial DB
  app.decorate('db', mockDb as any);
  // biome-ignore lint/suspicious/noExplicitAny: test mock — intentionally partial Qdrant client
  app.decorate('qdrant', mockQdrant as any);
  // biome-ignore lint/suspicious/noExplicitAny: test mock — intentionally partial PQueue
  app.decorate('pipelineQueue', mockPipelineQueue as any);

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

  // Register error handler first
  const { default: errorHandler } = await import('../../../plugins/error-handler.js');
  await app.register(errorHandler);

  // Register auth plugin
  const { default: authPlugin } = await import('../../../plugins/auth.js');
  await app.register(authPlugin);

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
    mockQdrantDelete.mockResolvedValue(undefined);
    mockPipelineQueueOnIdle.mockResolvedValue(undefined);
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
