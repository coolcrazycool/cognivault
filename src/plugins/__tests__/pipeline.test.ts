import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileChangeEvent } from '../../lib/indexer.js';

// ── Mock format chunkers ──

const mockChunkPdf = vi
  .fn()
  .mockResolvedValue([{ text: 'PDF chunk text', sectionPath: 'Document', chunkIndex: 0 }]);
const mockChunkCsv = vi
  .fn()
  .mockReturnValue([{ text: 'CSV chunk text', sectionPath: 'Rows 1-30', chunkIndex: 0 }]);
const mockChunkCanvas = vi
  .fn()
  .mockReturnValue([
    { text: 'Canvas chunk text', sectionPath: 'MyCanvas > Node 1', chunkIndex: 0 },
  ]);
const mockChunkExcalidraw = vi
  .fn()
  .mockReturnValue([{ text: 'Excalidraw chunk text', sectionPath: 'Drawing', chunkIndex: 0 }]);
const mockExtractImageBacklinks = vi.fn().mockReturnValue([]);

vi.mock('../../lib/pdf-chunker.js', () => ({ chunkPdf: mockChunkPdf }));
vi.mock('../../lib/csv-chunker.js', () => ({ chunkCsv: mockChunkCsv }));
vi.mock('../../lib/canvas-chunker.js', () => ({ chunkCanvas: mockChunkCanvas }));
vi.mock('../../lib/excalidraw-chunker.js', () => ({ chunkExcalidraw: mockChunkExcalidraw }));
vi.mock('../../lib/image-tracker.js', () => ({
  IMAGE_EXTENSIONS: new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp']),
  extractImageBacklinks: mockExtractImageBacklinks,
}));

// Mock node:fs/promises so we can control what fs.readFile returns in PDF tests
const mockFsReadFile = vi.fn().mockResolvedValue(Buffer.from('fake pdf content'));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    readFile: mockFsReadFile,
  };
});

// Set required env vars before any imports that trigger config parsing
beforeAll(() => {
  process.env.VAULT_PATH = '/tmp/test-vault';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.QDRANT_URL = 'http://localhost:6333';
  process.env.EMBEDDING_MODEL = 'text-embedding-3-small';
});

// ── Enough content to produce at least one chunk (>=100 tokens) ──
const RICH_CONTENT =
  '# Test\n\nSome content for testing purposes with enough tokens to create a chunk in the markdown processor since we need at least 100 tokens per section to avoid merging. Adding more text here to ensure we have enough content for chunking to work correctly and produce at least one valid chunk output.';

const TEST_USER_ID = 'test-user-1';

// Mock PQueue that actually runs tasks
function createMockQueue() {
  const queue = {
    add: vi.fn().mockImplementation(async (fn: () => Promise<void>) => {
      await fn();
    }),
    clear: vi.fn(),
    onIdle: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    size: 0,
    pending: 0,
  };
  return queue;
}

// Creates a minimal Fastify app with mocked services
async function buildTestApp(opts?: {
  readContent?: ReturnType<typeof vi.fn>;
  embed?: ReturnType<typeof vi.fn>;
  upsert?: ReturnType<typeof vi.fn>;
  qdrantDelete?: ReturnType<typeof vi.fn>;
  setPayload?: ReturnType<typeof vi.fn>;
  vaultRootPath?: string;
}): Promise<{
  app: FastifyInstance;
  readContent: ReturnType<typeof vi.fn>;
  embed: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  qdrantDelete: ReturnType<typeof vi.fn>;
  setPayload: ReturnType<typeof vi.fn>;
  dbUpdate: ReturnType<typeof vi.fn>;
  metrics: {
    embeddingRequests: { inc: ReturnType<typeof vi.fn> };
    chunksProcessed: { inc: ReturnType<typeof vi.fn> };
    pipelineDuration: { startTimer: ReturnType<typeof vi.fn> };
    indexQueueDepth: { set: ReturnType<typeof vi.fn> };
    staleVectorCleanups: { inc: ReturnType<typeof vi.fn> };
  };
  mockQueue: ReturnType<typeof createMockQueue>;
}> {
  const Fastify = (await import('fastify')).default;

  const readContent = opts?.readContent ?? vi.fn().mockResolvedValue({ content: RICH_CONTENT });
  const embed = opts?.embed ?? vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]);
  const upsert = opts?.upsert ?? vi.fn().mockResolvedValue({});
  const qdrantDelete = opts?.qdrantDelete ?? vi.fn().mockResolvedValue({});
  const setPayload = opts?.setPayload ?? vi.fn().mockResolvedValue({});

  // Build the db.update chain mock
  const dbRun = vi.fn();
  const dbWhere = vi.fn().mockReturnValue({ run: dbRun, all: vi.fn().mockReturnValue([]) });
  const dbSet = vi.fn().mockReturnValue({ where: dbWhere });
  const dbUpdate = vi.fn().mockReturnValue({ set: dbSet });

  // Build db.select chain mock for processImage
  const dbSelectAll = vi.fn().mockReturnValue([]);
  const dbSelectWhere = vi.fn().mockReturnValue({ all: dbSelectAll });
  const dbSelectFrom = vi.fn().mockReturnValue({ where: dbSelectWhere });
  const dbSelect = vi.fn().mockReturnValue({ from: dbSelectFrom });

  const vaultRootPath = opts?.vaultRootPath ?? '/tmp/test-vault';

  const mockQueue = createMockQueue();

  const metricsObj = {
    searchDuration: { startTimer: vi.fn().mockReturnValue(vi.fn()) },
    searchRequests: { inc: vi.fn() },
    indexQueueDepth: { set: vi.fn() },
    staleVectorCleanups: { inc: vi.fn() },
    embeddingRequests: { inc: vi.fn() },
    chunksProcessed: { inc: vi.fn() },
    pipelineDuration: { startTimer: vi.fn().mockReturnValue(vi.fn()) },
    contextPacks: { inc: vi.fn() },
    removeUserMetrics: vi.fn(),
    promRegistry: {},
  };

  const app = Fastify({ logger: false });

  // Register all dependencies as a single plugin
  await app.register(
    fp(
      async (f) => {
        // Per-user DB accessor
        f.decorate('getUserDbById', vi.fn().mockReturnValue({
          update: dbUpdate,
          select: dbSelect,
        }) as unknown as FastifyInstance['getUserDbById']);

        // Per-user embedder accessor
        f.decorate('getUserEmbedder', vi.fn().mockReturnValue({
          embed,
          dimensions: 1536,
        }) as unknown as FastifyInstance['getUserEmbedder']);

        // Tenant Qdrant factory
        f.decorate('createTenantQdrant', vi.fn().mockReturnValue({
          upsert,
          delete: qdrantDelete,
          setPayload,
          search: vi.fn().mockResolvedValue([]),
          scroll: vi.fn().mockResolvedValue({ points: [] }),
        }) as unknown as FastifyInstance['createTenantQdrant']);

        f.decorate('metrics', metricsObj as unknown as FastifyInstance['metrics']);

        f.decorate('registry', {
          getAllUsers: vi.fn().mockReturnValue([]),
          on: vi.fn(),
          removeListener: vi.fn(),
        } as unknown as FastifyInstance['registry']);

        // Indexers map with test user entry
        const indexersMap = new Map();
        indexersMap.set(TEST_USER_ID, {
          indexer: { on: vi.fn(), removeListener: vi.fn() },
          queue: mockQueue,
          vault: {
            readContent,
            vaultRootPath,
          },
        });
        f.decorate('indexers', indexersMap as unknown as FastifyInstance['indexers']);
      },
      { name: 'test-deps' },
    ),
  );

  // Satisfy fp dependency checks with empty plugins
  for (const name of ['db', 'embedder', 'qdrant', 'metrics', 'registry'] as const) {
    await app.register(fp(async () => {}, { name }));
  }

  const { default: pipelinePlugin } = await import('../pipeline.js');
  await app.register(pipelinePlugin);
  await app.ready();

  return {
    app,
    readContent,
    embed,
    upsert,
    qdrantDelete,
    setPayload,
    dbUpdate,
    metrics: metricsObj,
    mockQueue,
  };
}

// Helper: invoke processFileChanges with userId
async function processChanges(app: FastifyInstance, userId: string, events: FileChangeEvent[]): Promise<void> {
  app.processFileChanges(userId, events);
  // Let queue microtasks settle
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

describe('pipeline plugin (per-user)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('processFileChanges decoration', () => {
    it('decorates fastify with processFileChanges function', async () => {
      const { app } = await buildTestApp();
      expect(app.processFileChanges).toBeDefined();
      expect(typeof app.processFileChanges).toBe('function');
      await app.close();
    });
  });

  describe('processFileChanges queuing', () => {
    it('queues events to user PQueue', async () => {
      const { app, mockQueue } = await buildTestApp();

      const events: FileChangeEvent[] = [
        { path: 'notes/test.md', type: 'created', contentHash: 'abc' },
      ];

      await processChanges(app, TEST_USER_ID, events);

      expect(mockQueue.add).toHaveBeenCalled();

      await app.close();
    });
  });

  // ── created events ──

  describe('created event', () => {
    it('reads file content, embeds chunks, and upserts to tenant Qdrant', async () => {
      const { app, readContent, embed, upsert, qdrantDelete } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await processChanges(app, TEST_USER_ID, [event]);

      expect(readContent).toHaveBeenCalledWith('notes/my-note.md');
      expect(embed).toHaveBeenCalled();

      // Upsert should be called on tenant Qdrant (no collection name arg)
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ points: expect.any(Array) }),
      );

      // Stale cleanup on tenant Qdrant
      expect(qdrantDelete).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: expect.objectContaining({
            must: expect.arrayContaining([
              expect.objectContaining({ key: 'path' }),
              expect.objectContaining({ key: 'chunk_index' }),
            ]),
          }),
        }),
      );

      await app.close();
    });

    it('uses user-scoped chunkId (UUID v5 with userId prefix)', async () => {
      const { app, upsert } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await processChanges(app, TEST_USER_ID, [event]);

      type UpsertArg = { points: Array<{ id: string }> };
      const call = upsert.mock.calls[0] as [UpsertArg] | undefined;
      expect(call).toBeDefined();
      const firstId = call?.[0].points[0]?.id;
      expect(firstId).toBeDefined();
      expect(firstId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

      await app.close();
    });

    it('sets embedding_model_version in indexed_files using per-user DB', async () => {
      const { app, dbUpdate } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await processChanges(app, TEST_USER_ID, [event]);

      expect(dbUpdate).toHaveBeenCalled();

      await app.close();
    });
  });

  // ── deleted events ──

  describe('deleted event', () => {
    it('deletes vectors from tenant Qdrant', async () => {
      const { app, readContent, embed, upsert, qdrantDelete } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/to-delete.md',
        type: 'deleted',
        contentHash: 'abc123',
      };

      await processChanges(app, TEST_USER_ID, [event]);

      expect(readContent).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
      expect(qdrantDelete).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: expect.objectContaining({
            must: expect.arrayContaining([
              expect.objectContaining({ key: 'path', match: { value: 'notes/to-delete.md' } }),
            ]),
          }),
        }),
      );

      await app.close();
    });
  });

  // ── moved events ──

  describe('moved event', () => {
    it('updates payload in tenant Qdrant without re-embedding', async () => {
      const { app, embed, upsert, setPayload } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/new-location.md',
        type: 'moved',
        contentHash: 'abc123',
        oldPath: 'notes/old-location.md',
      };

      await processChanges(app, TEST_USER_ID, [event]);

      expect(embed).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
      expect(setPayload).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            path: 'notes/new-location.md',
          }),
          filter: expect.objectContaining({
            must: expect.arrayContaining([
              expect.objectContaining({
                key: 'path',
                match: { value: 'notes/old-location.md' },
              }),
            ]),
          }),
        }),
      );

      await app.close();
    });
  });

  // ── metrics with user_id ──

  describe('metrics with user_id label', () => {
    it('passes user_id to pipelineDuration.startTimer', async () => {
      const { app, metrics } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await processChanges(app, TEST_USER_ID, [event]);

      expect(metrics.pipelineDuration.startTimer).toHaveBeenCalledWith({ user_id: TEST_USER_ID });

      await app.close();
    });

    it('passes user_id to embeddingRequests.inc', async () => {
      const { app, metrics } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await processChanges(app, TEST_USER_ID, [event]);

      expect(metrics.embeddingRequests.inc).toHaveBeenCalledWith({ user_id: TEST_USER_ID });

      await app.close();
    });

    it('passes user_id to chunksProcessed.inc', async () => {
      const { app, metrics } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await processChanges(app, TEST_USER_ID, [event]);

      expect(metrics.chunksProcessed.inc).toHaveBeenCalledWith(
        { user_id: TEST_USER_ID },
        expect.any(Number),
      );

      await app.close();
    });

    it('passes user_id to staleVectorCleanups.inc', async () => {
      const { app, metrics } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await processChanges(app, TEST_USER_ID, [event]);

      expect(metrics.staleVectorCleanups.inc).toHaveBeenCalledWith({ user_id: TEST_USER_ID });

      await app.close();
    });
  });

  // ── queue depth tracking ──

  describe('queue depth tracking', () => {
    it('updates indexQueueDepth gauge with user_id after queuing', async () => {
      const { app, metrics } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await processChanges(app, TEST_USER_ID, [event]);

      expect(metrics.indexQueueDepth.set).toHaveBeenCalledWith(
        { user_id: TEST_USER_ID },
        expect.any(Number),
      );

      await app.close();
    });
  });

  // ── image file dispatch ──

  describe('image file dispatch', () => {
    it('skips Qdrant operations for image files', async () => {
      const { app, upsert, embed, qdrantDelete } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'attachments/diagram.png',
        type: 'created',
        contentHash: 'imghash',
      };

      await processChanges(app, TEST_USER_ID, [event]);

      expect(embed).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
      expect(qdrantDelete).not.toHaveBeenCalled();

      await app.close();
    });
  });

  // ── frontmatter-only notes ──

  describe('frontmatter-only notes', () => {
    it('skips embedding but cleans stale vectors on tenant Qdrant', async () => {
      const content = '---\ntags: [ai]\ntitle: My Note\n---\n';
      const { app, embed, upsert, qdrantDelete } = await buildTestApp({
        readContent: vi.fn().mockResolvedValue({ content }),
      });

      const event: FileChangeEvent = {
        path: 'notes/frontmatter-only.md',
        type: 'updated',
        contentHash: 'abc123',
      };

      await processChanges(app, TEST_USER_ID, [event]);

      expect(embed).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
      expect(qdrantDelete).toHaveBeenCalled();

      await app.close();
    });
  });
});
