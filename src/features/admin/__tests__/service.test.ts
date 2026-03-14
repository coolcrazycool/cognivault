import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Set env vars before any module imports that trigger config parsing
process.env.VAULT_PATH = '/tmp/test-vault';

// ── Mocks ──

const TEST_USER_ID = 'test-user-1';

const mockIsIndexing = vi.fn().mockReturnValue(false);
const mockStop = vi.fn();
const mockStart = vi.fn();
const mockRestart = vi.fn();
const mockEmit = vi.fn();
const mockOn = vi.fn();
const mockOnce = vi.fn();
const mockRemoveListener = vi.fn();

const mockIndexer = {
  get isIndexing() {
    return mockIsIndexing();
  },
  stop: mockStop,
  start: mockStart,
  restart: mockRestart,
  emit: mockEmit,
  on: mockOn,
  once: mockOnce,
  removeListener: mockRemoveListener,
};

const mockDbAll = vi.fn().mockReturnValue([]);
const mockDbGet = vi.fn().mockReturnValue(undefined);

const mockUserDb = {
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        all: mockDbAll,
        get: mockDbGet,
      }),
    }),
  }),
};

const mockOnIdle = vi.fn().mockResolvedValue(undefined);
const mockQueueClear = vi.fn();

const mockUserQdrantDelete = vi.fn().mockResolvedValue(undefined);
const mockUserQdrant = {
  search: vi.fn(),
  scroll: vi.fn(),
  upsert: vi.fn(),
  delete: mockUserQdrantDelete,
  setPayload: vi.fn(),
};

const mockProcessFileChanges = vi.fn();

// Build indexers Map with test user entry
const indexersMap = new Map();
indexersMap.set(TEST_USER_ID, {
  indexer: mockIndexer,
  queue: { onIdle: mockOnIdle, clear: mockQueueClear, size: 0, pending: 0 },
  vault: { vaultRootPath: '/tmp/test-vault', readContent: vi.fn() },
});

const mockFastify = {
  indexers: indexersMap,
  processFileChanges: mockProcessFileChanges,
} as unknown as FastifyInstance;

describe('ReindexService', () => {
  let ReindexService: typeof import('../service.js').ReindexService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIsIndexing.mockReturnValue(false);
    mockDbAll.mockReturnValue([]);
    mockDbGet.mockReturnValue(undefined);
    mockOnIdle.mockResolvedValue(undefined);
    const mod = await import('../service.js');
    ReindexService = mod.ReindexService;
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('createJob', () => {
    it('creates a full reindex job with status running and a UUID jobId', async () => {
      const service = new ReindexService(mockFastify);
      const job = await service.createJob(
        'full',
        undefined,
        mockUserDb as never,
        mockUserQdrant as never,
        TEST_USER_ID,
      );

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

      await expect(
        service.createJob(
          'full',
          undefined,
          mockUserDb as never,
          mockUserQdrant as never,
          TEST_USER_ID,
        ),
      ).rejects.toThrow();
    });

    it('calls indexer.restart() for full reindex', async () => {
      const service = new ReindexService(mockFastify);
      await service.createJob(
        'full',
        undefined,
        mockUserDb as never,
        mockUserQdrant as never,
        TEST_USER_ID,
      );

      expect(mockRestart).toHaveBeenCalledOnce();
    });

    it('creates a path scope job with target path', async () => {
      const service = new ReindexService(mockFastify);
      const job = await service.createJob(
        'path',
        'notes/foo.md',
        mockUserDb as never,
        mockUserQdrant as never,
        TEST_USER_ID,
      );

      expect(job.scope).toBe('path');
      expect(job.status).toBe('completed');
    });

    it('creates a folder scope job', async () => {
      const service = new ReindexService(mockFastify);
      const job = await service.createJob(
        'folder',
        'projects/',
        mockUserDb as never,
        mockUserQdrant as never,
        TEST_USER_ID,
      );

      expect(job.scope).toBe('folder');
      expect(job.status).toBe('completed');
    });

    it('full reindex calls queue.onIdle() before marking completed', async () => {
      const service = new ReindexService(mockFastify);
      await service.createJob(
        'full',
        undefined,
        mockUserDb as never,
        mockUserQdrant as never,
        TEST_USER_ID,
      );

      // Find the scanComplete handler registered via mockOn
      const scanCompleteCall = mockOn.mock.calls.find((call) => call[0] === 'scanComplete');
      expect(scanCompleteCall).toBeDefined();
      const onScanComplete = scanCompleteCall![1] as (
        filesScanned: number,
        eventsEmitted: number,
      ) => Promise<void>;

      // Simulate scanComplete firing
      await onScanComplete(5, 5);

      // onIdle must have been called
      expect(mockOnIdle).toHaveBeenCalledOnce();
    });

    it('full reindex uses .on() (not .once()) for scanComplete listener', async () => {
      const service = new ReindexService(mockFastify);
      await service.createJob(
        'full',
        undefined,
        mockUserDb as never,
        mockUserQdrant as never,
        TEST_USER_ID,
      );

      // .on() should have been called for scanComplete
      const onCalls = mockOn.mock.calls.filter((call) => call[0] === 'scanComplete');
      expect(onCalls).toHaveLength(1);

      // .once() should NOT have been called for scanComplete
      const onceCalls = mockOnce.mock.calls.filter((call) => call[0] === 'scanComplete');
      expect(onceCalls).toHaveLength(0);
    });

    it('full reindex marks completed only after onIdle resolves', async () => {
      let onIdleResolve!: () => void;
      const onIdlePromise = new Promise<void>((res) => {
        onIdleResolve = res;
      });
      mockOnIdle.mockReturnValue(onIdlePromise);

      const service = new ReindexService(mockFastify);
      const job = await service.createJob(
        'full',
        undefined,
        mockUserDb as never,
        mockUserQdrant as never,
        TEST_USER_ID,
      );

      // Find and invoke the scanComplete handler
      const scanCompleteCall = mockOn.mock.calls.find((call) => call[0] === 'scanComplete');
      const onScanComplete = scanCompleteCall![1] as (
        filesScanned: number,
        eventsEmitted: number,
      ) => Promise<void>;

      // Start calling onScanComplete but don't await yet
      const scanDonePromise = onScanComplete(3, 3);

      // Status should still be 'running' while onIdle hasn't resolved
      expect(job.status).toBe('running');

      // Now resolve onIdle
      onIdleResolve();
      await scanDonePromise;

      // Now status should be 'completed'
      expect(job.status).toBe('completed');
    });
  });

  describe('createPathJob', () => {
    it('path reindex uses processFileChanges with real contentHash from DB', async () => {
      mockDbGet.mockReturnValue({ contentHash: 'abc123', path: 'notes/foo.md' });

      const service = new ReindexService(mockFastify);
      await service.createJob(
        'path',
        'notes/foo.md',
        mockUserDb as never,
        mockUserQdrant as never,
        TEST_USER_ID,
      );

      expect(mockProcessFileChanges).toHaveBeenCalledOnce();
      const callArgs = mockProcessFileChanges.mock.calls[0]!;
      expect(callArgs[0]).toBe(TEST_USER_ID);
      const events = callArgs[1] as Array<{ path: string; type: string; contentHash: string }>;
      expect(events).toHaveLength(1);
      expect(events[0]!.contentHash).toBe('abc123');
    });

    it('path reindex uses empty contentHash when file not found in DB', async () => {
      mockDbGet.mockReturnValue(undefined);

      const service = new ReindexService(mockFastify);
      await service.createJob(
        'path',
        'notes/missing.md',
        mockUserDb as never,
        mockUserQdrant as never,
        TEST_USER_ID,
      );

      expect(mockProcessFileChanges).toHaveBeenCalledOnce();
      const callArgs = mockProcessFileChanges.mock.calls[0]!;
      const events = callArgs[1] as Array<{ path: string; type: string; contentHash: string }>;
      expect(events).toHaveLength(1);
      expect(events[0]!.contentHash).toBe('');
    });
  });

  describe('getJob', () => {
    it('returns job state with filesProcessed, totalFiles, errors', async () => {
      const service = new ReindexService(mockFastify);
      const created = await service.createJob(
        'full',
        undefined,
        mockUserDb as never,
        mockUserQdrant as never,
        TEST_USER_ID,
      );
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
