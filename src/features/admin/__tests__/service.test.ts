import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Set env vars before any module imports that trigger config parsing
process.env.COGNIVAULT_API_KEY = 'test-admin-key';
process.env.VAULT_PATH = '/tmp/test-vault';

// ── Mocks ──

const mockIsIndexing = vi.fn().mockReturnValue(false);
const mockStop = vi.fn();
const mockStart = vi.fn();
const mockEmit = vi.fn();

const mockIndexer = {
  get isIndexing() {
    return mockIsIndexing();
  },
  stop: mockStop,
  start: mockStart,
  emit: mockEmit,
};

const mockDbSelect = vi.fn();
const mockDbSelectFrom = vi.fn();
const mockDbSelectFromWhere = vi.fn();
const mockDbAll = vi.fn().mockReturnValue([]);

const mockDb = {
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        all: mockDbAll,
      }),
    }),
  }),
};

const mockFastify = {
  indexer: mockIndexer,
  db: mockDb,
} as unknown as FastifyInstance;

describe('ReindexService', () => {
  let ReindexService: typeof import('../service.js').ReindexService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIsIndexing.mockReturnValue(false);
    mockDbAll.mockReturnValue([]);
    const mod = await import('../service.js');
    ReindexService = mod.ReindexService;
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('createJob', () => {
    it('creates a full reindex job with status running and a UUID jobId', async () => {
      const service = new ReindexService(mockFastify);
      const job = await service.createJob('full');

      expect(job.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(job.scope).toBe('full');
      expect(job.status).toBe('running');
      expect(job.filesProcessed).toBe(0);
      expect(job.totalFiles).toBe(0);
      expect(job.errors).toEqual([]);
      expect(job.startedAt).toBeDefined();
    });

    it('throws when already indexing (409 scenario)', async () => {
      mockIsIndexing.mockReturnValue(true);
      const service = new ReindexService(mockFastify);

      await expect(service.createJob('full')).rejects.toThrow();
    });

    it('calls indexer.stop() then indexer.start() for full reindex', async () => {
      const service = new ReindexService(mockFastify);
      await service.createJob('full');

      expect(mockStop).toHaveBeenCalledOnce();
      expect(mockStart).toHaveBeenCalledOnce();
    });

    it('creates a path scope job with target path', async () => {
      const service = new ReindexService(mockFastify);
      const job = await service.createJob('path', 'notes/foo.md');

      expect(job.scope).toBe('path');
      expect(job.status).toBe('completed');
    });

    it('creates a folder scope job', async () => {
      const service = new ReindexService(mockFastify);
      const job = await service.createJob('folder', 'projects/');

      expect(job.scope).toBe('folder');
      expect(job.status).toBe('completed');
    });
  });

  describe('getJob', () => {
    it('returns job state with filesProcessed, totalFiles, errors', async () => {
      const service = new ReindexService(mockFastify);
      const created = await service.createJob('full');
      const found = service.getJob(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(typeof found?.filesProcessed).toBe('number');
      expect(typeof found?.totalFiles).toBe('number');
      expect(Array.isArray(found?.errors)).toBe(true);
    });

    it('returns undefined for nonexistent job id', () => {
      const service = new ReindexService(mockFastify);
      const result = service.getJob(randomUUID());
      expect(result).toBeUndefined();
    });
  });
});
