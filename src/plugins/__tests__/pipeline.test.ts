import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { docSummaries, sections } from '../../db/schema.js';
import { buildDocumentSparseVector, buildSparseVector } from '../../lib/bm25.js';
import { ChunkParseError } from '../../lib/chunk-errors.js';
import { countTokens, DOC_SUMMARY_MAX_TOKENS } from '../../lib/chunker.js';
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

interface FileFailedRecord {
  userId: string;
  path: string;
  error: string;
}

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

/** Shape of a cached doc_summaries row as the pipeline reads it back. */
interface DocSummaryRow {
  path: string;
  contentHash: string;
  summary: string;
}

// Creates a minimal Fastify app with mocked services
async function buildTestApp(opts?: {
  readContent?: ReturnType<typeof vi.fn>;
  embed?: ReturnType<typeof vi.fn>;
  upsert?: ReturnType<typeof vi.fn>;
  qdrantDelete?: ReturnType<typeof vi.fn>;
  setPayload?: ReturnType<typeof vi.fn>;
  vaultRootPath?: string;
  /** Injected chat client; absent means "summaries unavailable" (the openai case). */
  summarize?: ReturnType<typeof vi.fn>;
  /** Row returned by the doc_summaries cache lookup. */
  docSummaryRow?: DocSummaryRow;
  /**
   * Decorate a BLOCKED `qdrantAdmin`: a legacy collection owns the alias name, so the
   * pipeline must not write into it. Absent = no decorator at all, which is the shape
   * every other test in this file runs against.
   */
  blockedCollection?: boolean;
}): Promise<{
  app: FastifyInstance;
  readContent: ReturnType<typeof vi.fn>;
  embed: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  qdrantDelete: ReturnType<typeof vi.fn>;
  setPayload: ReturnType<typeof vi.fn>;
  dbUpdate: ReturnType<typeof vi.fn>;
  dbSet: ReturnType<typeof vi.fn>;
  dbDelete: ReturnType<typeof vi.fn>;
  dbInsert: ReturnType<typeof vi.fn>;
  dbInsertValues: ReturnType<typeof vi.fn>;
  dbInsertOnConflict: ReturnType<typeof vi.fn>;
  dbSelectGet: ReturnType<typeof vi.fn>;
  dbTransaction: ReturnType<typeof vi.fn>;
  summarize: ReturnType<typeof vi.fn>;
  confirmIndexed: ReturnType<typeof vi.fn>;
  failIndexed: ReturnType<typeof vi.fn>;
  fileFailed: FileFailedRecord[];
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

  // Build the db.update chain mock. The table argument is recorded on dbUpdate itself,
  // so tests can tell an indexed_files update from a sections update.
  const dbRun = vi.fn();
  const dbWhere = vi.fn().mockReturnValue({ run: dbRun, all: vi.fn().mockReturnValue([]) });
  const dbSet = vi.fn().mockReturnValue({ where: dbWhere });
  const dbUpdate = vi.fn().mockReturnValue({ set: dbSet });

  // db.delete(table).where(...).run() — used to drop a path's sections
  const dbDeleteRun = vi.fn();
  const dbDeleteWhere = vi.fn().mockReturnValue({ run: dbDeleteRun });
  const dbDelete = vi.fn().mockReturnValue({ where: dbDeleteWhere });

  // db.insert(table).values(rows).run() — used to write a path's sections.
  // The doc_summaries cache goes through .onConflictDoUpdate(...).run() instead.
  const dbInsertRun = vi.fn();
  const dbInsertOnConflict = vi.fn().mockReturnValue({ run: dbInsertRun });
  const dbInsertValues = vi
    .fn()
    .mockReturnValue({ run: dbInsertRun, onConflictDoUpdate: dbInsertOnConflict });
  const dbInsert = vi.fn().mockReturnValue({ values: dbInsertValues });

  // db.transaction(cb) runs the callback synchronously against the same chains, which
  // is what better-sqlite3 does — so ordering assertions stay meaningful.
  const dbTransaction = vi.fn().mockImplementation((cb: (tx: unknown) => unknown) =>
    cb({
      delete: dbDelete,
      insert: dbInsert,
      update: dbUpdate,
    }),
  );

  // Build db.select chain mock for processImage (.all) and the doc_summaries cache (.get)
  const dbSelectAll = vi.fn().mockReturnValue([]);
  const dbSelectGet = vi.fn().mockReturnValue(opts?.docSummaryRow);
  const dbSelectWhere = vi.fn().mockReturnValue({ all: dbSelectAll, get: dbSelectGet });
  const dbSelectFrom = vi.fn().mockReturnValue({ where: dbSelectWhere });
  const dbSelect = vi.fn().mockReturnValue({ from: dbSelectFrom });

  const vaultRootPath = opts?.vaultRootPath ?? '/tmp/test-vault';

  const mockQueue = createMockQueue();

  const confirmIndexed = vi.fn();
  const failIndexed = vi.fn();
  const pipelineEvents = new EventEmitter();
  const fileFailed: FileFailedRecord[] = [];
  pipelineEvents.on('file-failed', (payload: FileFailedRecord) => {
    fileFailed.push(payload);
  });

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
        f.decorate(
          'getUserDbById',
          vi.fn().mockReturnValue({
            update: dbUpdate,
            select: dbSelect,
            delete: dbDelete,
            insert: dbInsert,
            transaction: dbTransaction,
          }) as unknown as FastifyInstance['getUserDbById'],
        );

        // Per-user embedder accessor
        f.decorate(
          'getUserEmbedder',
          vi.fn().mockReturnValue({
            embed,
            dimensions: 1536,
          }) as unknown as FastifyInstance['getUserEmbedder'],
        );

        // Tenant Qdrant factory
        f.decorate(
          'createTenantQdrant',
          vi.fn().mockReturnValue({
            upsert,
            delete: qdrantDelete,
            setPayload,
            search: vi.fn().mockResolvedValue([]),
            scroll: vi.fn().mockResolvedValue({ points: [] }),
          }) as unknown as FastifyInstance['createTenantQdrant'],
        );

        f.decorate('metrics', metricsObj as unknown as FastifyInstance['metrics']);

        if (opts?.blockedCollection) {
          f.decorate('qdrantAdmin', {
            alias: 'cognivault',
            collection: 'cognivault',
            blocked: true,
            expectedSchemeVersion: 3,
            describe: vi.fn(),
            dropCollection: vi.fn(),
            createCollection: vi.fn(),
          } as unknown as FastifyInstance['qdrantAdmin']);
        }

        f.decorate('registry', {
          getAllUsers: vi.fn().mockReturnValue([]),
          on: vi.fn(),
          removeListener: vi.fn(),
        } as unknown as FastifyInstance['registry']);

        // Indexers map with test user entry
        const indexersMap = new Map();
        indexersMap.set(TEST_USER_ID, {
          indexer: { on: vi.fn(), removeListener: vi.fn(), confirmIndexed, failIndexed },
          queue: mockQueue,
          vault: {
            readContent,
            vaultRootPath,
          },
        });
        f.decorate('indexers', indexersMap as unknown as FastifyInstance['indexers']);

        // Stand-in for the pipeline-events plugin's EventEmitter
        f.decorate(
          'pipelineEvents',
          pipelineEvents as unknown as FastifyInstance['pipelineEvents'],
        );

        // Chat client for index-time summaries. Decorating it here (before the pipeline
        // plugin registers) is what stops the plugin from building a real GigaChat one.
        f.decorate(
          'summarizer',
          (opts?.summarize
            ? { complete: opts.summarize }
            : undefined) as unknown as FastifyInstance['summarizer'],
        );
      },
      { name: 'test-deps' },
    ),
  );

  // Satisfy fp dependency checks with empty plugins
  for (const name of [
    'db',
    'embedder',
    'qdrant',
    'metrics',
    'registry',
    'pipeline-events',
  ] as const) {
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
    dbSet,
    dbDelete,
    dbInsert,
    dbInsertValues,
    dbInsertOnConflict,
    dbSelectGet,
    dbTransaction,
    summarize: opts?.summarize ?? vi.fn(),
    confirmIndexed,
    failIndexed,
    fileFailed,
    metrics: metricsObj,
    mockQueue,
  };
}

// Helper: invoke processFileChanges with userId
async function processChanges(
  app: FastifyInstance,
  userId: string,
  events: FileChangeEvent[],
): Promise<void> {
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
      expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ points: expect.any(Array) }));

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
      expect(firstId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

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

  // ── blocked collection ──

  describe('blocked collection', () => {
    it('indexes nothing and confirms nothing while the collection is blocked', async () => {
      const { app, upsert, embed, readContent, confirmIndexed, failIndexed } = await buildTestApp({
        blockedCollection: true,
      });

      await processChanges(app, TEST_USER_ID, [
        { path: 'notes/a.md', type: 'created', contentHash: 'h1' },
        { path: 'notes/b.md', type: 'updated', contentHash: 'h2' },
      ]);

      // Not a single write into a collection this build cannot write to and a rebuild is
      // about to destroy — and no embedding bill for work that would be thrown away.
      expect(upsert).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
      expect(readContent).not.toHaveBeenCalled();
      // Crucially not confirmed: indexed_files keeps the OLD hash, so the next poll
      // re-detects these files and indexes them for real once the rebuild lifts the block.
      expect(confirmIndexed).not.toHaveBeenCalled();
      expect(failIndexed).toHaveBeenCalledWith('notes/a.md');
      expect(failIndexed).toHaveBeenCalledWith('notes/b.md');

      await app.close();
    });

    it('deletions are held back too — nothing reaches the legacy collection', async () => {
      const { app, qdrantDelete, failIndexed } = await buildTestApp({ blockedCollection: true });

      await processChanges(app, TEST_USER_ID, [
        { path: 'notes/gone.md', type: 'deleted', contentHash: '' },
      ]);

      expect(qdrantDelete).not.toHaveBeenCalled();
      expect(failIndexed).toHaveBeenCalledWith('notes/gone.md');

      await app.close();
    });
  });

  // ── transactional confirmation ──

  describe('index confirmation handshake', () => {
    it('confirms the file exactly once after a successful upsert', async () => {
      const { app, confirmIndexed, failIndexed, upsert, fileFailed } = await buildTestApp();

      await processChanges(app, TEST_USER_ID, [
        { path: 'notes/my-note.md', type: 'created', contentHash: 'abc123' },
      ]);

      expect(upsert).toHaveBeenCalledTimes(1);
      expect(confirmIndexed).toHaveBeenCalledTimes(1);
      expect(confirmIndexed).toHaveBeenCalledWith('notes/my-note.md');
      expect(failIndexed).not.toHaveBeenCalled();
      expect(fileFailed).toHaveLength(0);

      await app.close();
    });

    it('confirms a valid-but-empty file after its vectors are dropped', async () => {
      const { app, confirmIndexed, qdrantDelete, upsert, embed } = await buildTestApp({
        readContent: vi.fn().mockResolvedValue({ content: '---\ntags: [ai]\n---\n' }),
      });

      await processChanges(app, TEST_USER_ID, [
        { path: 'notes/empty.md', type: 'updated', contentHash: 'abc123' },
      ]);

      expect(embed).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
      expect(qdrantDelete).toHaveBeenCalled();
      expect(confirmIndexed).toHaveBeenCalledWith('notes/empty.md');

      await app.close();
    });

    it('fails the file (no confirm) and emits file-failed when embedding throws', async () => {
      const { app, confirmIndexed, failIndexed, upsert, fileFailed } = await buildTestApp({
        embed: vi.fn().mockRejectedValue(new Error('embedder exploded')),
      });

      await processChanges(app, TEST_USER_ID, [
        { path: 'notes/my-note.md', type: 'created', contentHash: 'abc123' },
      ]);

      expect(upsert).not.toHaveBeenCalled();
      expect(confirmIndexed).not.toHaveBeenCalled();
      expect(failIndexed).toHaveBeenCalledWith('notes/my-note.md');
      expect(fileFailed).toEqual([
        {
          userId: TEST_USER_ID,
          path: 'notes/my-note.md',
          error: expect.stringContaining('embedder exploded'),
        },
      ]);

      await app.close();
    });

    it('leaves vectors and the index row alone when a chunker throws ChunkParseError', async () => {
      mockChunkCanvas.mockImplementationOnce(() => {
        throw new ChunkParseError('Invalid JSON in canvas "broken"', 'broken', {});
      });

      const { app, confirmIndexed, failIndexed, upsert, qdrantDelete, embed, fileFailed } =
        await buildTestApp({
          readContent: vi.fn().mockResolvedValue({ content: 'not json {{{' }),
        });

      await processChanges(app, TEST_USER_ID, [
        { path: 'diagrams/broken.canvas', type: 'updated', contentHash: 'abc123' },
      ]);

      expect(embed).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
      // The critical part: a parse failure must NOT wipe the file's existing vectors.
      expect(qdrantDelete).not.toHaveBeenCalled();
      expect(confirmIndexed).not.toHaveBeenCalled();
      expect(failIndexed).toHaveBeenCalledWith('diagrams/broken.canvas');
      expect(fileFailed).toHaveLength(1);

      await app.close();
    });

    it('confirms a moved file so the SQLite row follows the new path', async () => {
      const { app, confirmIndexed, setPayload } = await buildTestApp();

      await processChanges(app, TEST_USER_ID, [
        {
          path: 'notes/new-location.md',
          type: 'moved',
          contentHash: 'abc123',
          oldPath: 'notes/old-location.md',
        },
      ]);

      expect(setPayload).toHaveBeenCalledTimes(1);
      expect(confirmIndexed).toHaveBeenCalledWith('notes/new-location.md');

      await app.close();
    });

    it('fails a moved event that carries no oldPath instead of rewriting every point', async () => {
      const { app, confirmIndexed, failIndexed, setPayload, fileFailed } = await buildTestApp();

      await processChanges(app, TEST_USER_ID, [
        { path: 'notes/orphan.md', type: 'moved', contentHash: 'abc123' },
      ]);

      expect(setPayload).not.toHaveBeenCalled();
      expect(confirmIndexed).not.toHaveBeenCalled();
      expect(failIndexed).toHaveBeenCalledWith('notes/orphan.md');
      expect(fileFailed).toHaveLength(1);

      await app.close();
    });

    it('confirms an image file after its backlinks are resolved', async () => {
      const { app, confirmIndexed } = await buildTestApp();

      await processChanges(app, TEST_USER_ID, [
        { path: 'attachments/diagram.png', type: 'created', contentHash: 'imghash' },
      ]);

      expect(confirmIndexed).toHaveBeenCalledWith('attachments/diagram.png');

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

  // ── parent sections (small-to-big retrieval) ──

  describe('parent sections', () => {
    const NOTE: FileChangeEvent = {
      path: 'notes/my-note.md',
      type: 'created',
      contentHash: 'abc123',
    };

    it('stamps parent_id and named dense/bm25 vectors on every point', async () => {
      const { app, upsert } = await buildTestApp();

      await processChanges(app, TEST_USER_ID, [NOTE]);

      type Point = {
        vector: Record<string, unknown>;
        payload: Record<string, unknown>;
      };
      const call = upsert.mock.calls[0] as [{ points: Point[] }] | undefined;
      const point = call?.[0].points[0];
      expect(point).toBeDefined();
      expect(point?.vector).toHaveProperty('dense');
      expect(point?.vector).toHaveProperty('bm25');
      expect(point?.payload.parent_id).toEqual(expect.any(String));

      await app.close();
    });

    it("replaces the path's section rows inside a single transaction", async () => {
      const { app, dbTransaction, dbDelete, dbInsert, dbInsertValues } = await buildTestApp();

      await processChanges(app, TEST_USER_ID, [NOTE]);

      expect(dbTransaction).toHaveBeenCalledTimes(1);
      expect(dbDelete).toHaveBeenCalledWith(sections);
      expect(dbInsert).toHaveBeenCalledWith(sections);

      const rows = dbInsertValues.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.path).toBe(NOTE.path);
        expect(row.parentId).toEqual(expect.any(String));
        expect(row.sectionPath).toEqual(expect.any(String));
        expect(row.text).toEqual(expect.any(String));
        expect(row.contentHash).toEqual(expect.any(String));
        expect(row.updatedAt).toEqual(expect.any(String));
      }

      // Every chunk's parent must have a row.
      const parentIds = new Set(rows.map((r) => r.parentId));
      expect(parentIds.size).toBe(rows.length);

      await app.close();
    });

    it('writes sections only after confirmIndexed (the row must exist first)', async () => {
      const { app, confirmIndexed, dbTransaction } = await buildTestApp();

      await processChanges(app, TEST_USER_ID, [NOTE]);

      const confirmOrder = confirmIndexed.mock.invocationCallOrder[0] as number;
      const txOrder = dbTransaction.mock.invocationCallOrder[0] as number;
      expect(confirmOrder).toBeLessThan(txOrder);

      await app.close();
    });

    it('does not touch sections when the embedder throws', async () => {
      const { app, dbTransaction, dbInsert, failIndexed } = await buildTestApp({
        embed: vi.fn().mockRejectedValue(new Error('embedder exploded')),
      });

      await processChanges(app, TEST_USER_ID, [NOTE]);

      expect(failIndexed).toHaveBeenCalled();
      expect(dbTransaction).not.toHaveBeenCalled();
      expect(dbInsert).not.toHaveBeenCalled();

      await app.close();
    });

    it('clears sections for a file that no longer produces chunks', async () => {
      const { app, dbTransaction, dbDelete, dbInsert } = await buildTestApp({
        readContent: vi.fn().mockResolvedValue({ content: '---\ntags: [ai]\n---\n' }),
      });

      await processChanges(app, TEST_USER_ID, [
        { path: 'notes/empty.md', type: 'updated', contentHash: 'abc123' },
      ]);

      expect(dbTransaction).toHaveBeenCalledTimes(1);
      expect(dbDelete).toHaveBeenCalledWith(sections);
      expect(dbInsert).not.toHaveBeenCalled();

      await app.close();
    });

    it('drops the sections of a deleted file', async () => {
      const { app, dbDelete } = await buildTestApp();

      await processChanges(app, TEST_USER_ID, [
        { path: 'notes/to-delete.md', type: 'deleted', contentHash: 'abc123' },
      ]);

      expect(dbDelete).toHaveBeenCalledWith(sections);

      await app.close();
    });

    it('leaves sections alone when a deleted file is an image', async () => {
      const { app, dbDelete } = await buildTestApp();

      await processChanges(app, TEST_USER_ID, [
        { path: 'attachments/diagram.png', type: 'deleted', contentHash: 'imghash' },
      ]);

      expect(dbDelete).not.toHaveBeenCalled();

      await app.close();
    });

    it('repoints sections to the new path on a move, without re-embedding', async () => {
      const { app, dbUpdate, dbSet, embed, dbInsert } = await buildTestApp();

      await processChanges(app, TEST_USER_ID, [
        {
          path: 'notes/new-location.md',
          type: 'moved',
          contentHash: 'abc123',
          oldPath: 'notes/old-location.md',
        },
      ]);

      expect(embed).not.toHaveBeenCalled();
      expect(dbInsert).not.toHaveBeenCalled();
      expect(dbUpdate).toHaveBeenCalledWith(sections);
      expect(dbSet).toHaveBeenCalledWith({ path: 'notes/new-location.md' });

      await app.close();
    });
  });

  // ── index-time summaries (table_summary + doc annotation) ──

  describe('index-time summaries', () => {
    type Point = { payload: Record<string, unknown>; vector: Record<string, unknown> };

    const CSV_EVENT: FileChangeEvent = {
      path: 'data/table.csv',
      type: 'updated',
      contentHash: 'hash-v1',
    };
    const MD_EVENT: FileChangeEvent = {
      path: 'notes/my-note.md',
      type: 'created',
      contentHash: 'abc123',
    };

    /** Two row groups of the same split table, as the table-aware chunker emits them. */
    function splitTableChunks() {
      return [
        {
          text: 'Отчёт > Таблица\n| a | b |\n| --- | --- |\n| 1 | 2 |',
          sectionPath: 'Отчёт > Таблица',
          chunkIndex: 0,
          parentId: 'parent-table',
          contentKind: 'table_rows',
        },
        {
          text: 'Отчёт > Таблица\n| a | b |\n| --- | --- |\n| 3 | 4 |',
          sectionPath: 'Отчёт > Таблица',
          chunkIndex: 1,
          parentId: 'parent-table',
          contentKind: 'table_rows',
        },
      ];
    }

    function pointsOf(upsert: ReturnType<typeof vi.fn>): Point[] {
      const call = upsert.mock.calls[0] as [{ points: Point[] }] | undefined;
      return call?.[0].points ?? [];
    }

    it('stamps content_kind text on chunks that do not declare one', async () => {
      const { app, upsert } = await buildTestApp();

      await processChanges(app, TEST_USER_ID, [MD_EVENT]);

      expect(pointsOf(upsert)[0]?.payload.content_kind).toBe('text');

      await app.close();
    });

    it('adds a table_summary point for a table split into row groups', async () => {
      mockChunkCsv.mockReturnValueOnce(splitTableChunks());
      const summarize = vi.fn().mockResolvedValue('Таблица о продажах: колонки a и b.');
      const { app, upsert, embed } = await buildTestApp({
        summarize,
        embed: vi.fn().mockResolvedValue([[0.1], [0.2], [0.3]]),
      });

      await processChanges(app, TEST_USER_ID, [CSV_EVENT]);

      const points = pointsOf(upsert);
      expect(points).toHaveLength(3);
      const summaryPoint = points[2] as Point;
      expect(summaryPoint.payload.content_kind).toBe('table_summary');
      expect(summaryPoint.payload.parent_id).toBe('parent-table');
      expect(summaryPoint.payload.text).toContain('Таблица о продажах');

      // The table prompt sees the header rows of the first group.
      const tablePrompt = summarize.mock.calls
        .map((c) => c[0] as string)
        .find((p) => p.includes('Опиши таблицу'));
      expect(tablePrompt).toContain('| a | b |');

      // The extra point is embedded like any other chunk.
      expect((embed.mock.calls[0]?.[0] as string[]).length).toBe(3);

      await app.close();
    });

    it('costs two chat calls for a document of many chunks with one split table', async () => {
      // Indexing cost has to stay per-document, not per-chunk: one annotation call for
      // the file plus one description call for the table, however many chunks it made.
      const manyChunks = [
        ...splitTableChunks(),
        ...Array.from({ length: 8 }, (_, i) => ({
          text: `Отчёт > Пояснения ${i}`,
          sectionPath: 'Отчёт > Пояснения',
          chunkIndex: 2 + i,
          parentId: 'parent-prose',
          contentKind: 'text',
        })),
      ];
      mockChunkCsv.mockReturnValueOnce(manyChunks);
      const summarize = vi.fn().mockResolvedValue('описание');
      const { app } = await buildTestApp({
        summarize,
        embed: vi.fn().mockResolvedValue(manyChunks.concat({} as never).map(() => [0.1])),
      });

      await processChanges(app, TEST_USER_ID, [CSV_EVENT]);

      expect(summarize).toHaveBeenCalledTimes(2);
      const prompts = summarize.mock.calls.map((c) => c[0] as string);
      expect(prompts.filter((p) => p.includes('Опиши таблицу'))).toHaveLength(1);
      expect(prompts.filter((p) => p.includes('Аннотация 1–2 предложения'))).toHaveLength(1);

      await app.close();
    });

    it('does not summarize a table that fit into a single chunk', async () => {
      mockChunkCsv.mockReturnValueOnce([
        {
          text: 'Отчёт > Таблица\n| a | b |\n| --- | --- |\n| 1 | 2 |',
          sectionPath: 'Отчёт > Таблица',
          chunkIndex: 0,
          parentId: 'parent-table',
          contentKind: 'table_rows',
        },
      ]);
      const summarize = vi.fn().mockResolvedValue('аннотация');
      const { app, upsert } = await buildTestApp({ summarize });

      await processChanges(app, TEST_USER_ID, [CSV_EVENT]);

      const points = pointsOf(upsert);
      expect(points).toHaveLength(1);
      expect(points[0]?.payload.content_kind).toBe('table_rows');
      expect(summarize.mock.calls.some((c) => (c[0] as string).includes('Опиши таблицу'))).toBe(
        false,
      );

      await app.close();
    });

    it('prefixes the document annotation to the embedded text and the payload', async () => {
      const summarize = vi.fn().mockResolvedValue('Документ про mTLS.');
      const { app, upsert, embed } = await buildTestApp({ summarize });

      await processChanges(app, TEST_USER_ID, [MD_EVENT]);

      const embedded = embed.mock.calls[0]?.[0] as string[];
      expect(embedded[0]).toContain('Аннотация документа: Документ про mTLS.\n\n');
      expect(pointsOf(upsert)[0]?.payload.text).toBe(embedded[0]);

      await app.close();
    });

    it('caps a long annotation before it is prepended and cached', async () => {
      // "1–2 предложения" in the prompt is a request, not a bound. The annotation is
      // repeated at the head of EVERY chunk of the document, so an unbounded one both
      // breaks the chunk budget silently and starts dominating each chunk's dense vector.
      const long = Array.from(
        { length: 60 },
        (_, i) => `Предложение номер ${i} про содержание документа и его назначение.`,
      ).join(' ');
      const summarize = vi.fn().mockResolvedValue(long);
      const { app, upsert, embed, dbInsertValues } = await buildTestApp({ summarize });

      await processChanges(app, TEST_USER_ID, [MD_EVENT]);

      const embedded = (embed.mock.calls[0]?.[0] as string[])[0] as string;
      const annotation = embedded.slice(
        'Аннотация документа: '.length,
        embedded.indexOf('\n\n', 'Аннотация документа: '.length),
      );
      expect(countTokens(annotation)).toBeLessThanOrEqual(DOC_SUMMARY_MAX_TOKENS + 1);
      expect(annotation.endsWith('…')).toBe(true);
      expect(pointsOf(upsert)[0]?.payload.text).toContain(annotation);
      // What is cached is what was used, so a cache hit cannot resurrect the long one.
      const cached = dbInsertValues.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .find((row) => typeof row.summary === 'string');
      expect(cached?.summary).toBe(annotation);

      await app.close();
    });

    it('keeps the annotation out of the BM25 vector', async () => {
      // The annotation is identical in every chunk of a document. In the sparse vector
      // that would make every chunk match on the annotation's terms and would stretch
      // the BM25 length normalizer, damping the terms the chunk is really about — so
      // the lexical side is built from the chunk's own text only.
      const summarize = vi.fn().mockResolvedValue('Документ про сертификаты взаимодействия.');
      const { app, upsert, embed } = await buildTestApp({ summarize });

      await processChanges(app, TEST_USER_ID, [MD_EVENT]);

      const embedded = (embed.mock.calls[0]?.[0] as string[])[0] as string;
      const point = pointsOf(upsert)[0];
      const chunkText = embedded.slice(
        embedded.indexOf('\n\n', 'Аннотация документа: '.length) + 2,
      );

      expect(embedded).toContain('Аннотация документа: ');
      expect(chunkText).not.toContain('Аннотация документа');
      // The document builder, not the plain one: the indexed side boosts the chunk's
      // breadcrumb, and only the annotation is supposed to be missing from the input.
      expect(point?.vector.bm25).toEqual(buildDocumentSparseVector(chunkText));
      // A term that occurs only in the annotation must not be in the sparse vector.
      const annotationOnly = buildSparseVector('сертификаты взаимодействия');
      const sparse = point?.vector.bm25 as { indices: number[] };
      expect(annotationOnly.indices.length).toBeGreaterThan(0);
      for (const index of annotationOnly.indices) {
        expect(sparse.indices).not.toContain(index);
      }

      await app.close();
    });

    it('caches the annotation and skips the chat call when the hash is unchanged', async () => {
      const summarize = vi.fn().mockResolvedValue('свежая аннотация');
      const { app, upsert, dbInsert, dbSelectGet } = await buildTestApp({
        summarize,
        docSummaryRow: {
          path: MD_EVENT.path,
          contentHash: MD_EVENT.contentHash,
          summary: 'кэшированная аннотация',
        },
      });

      await processChanges(app, TEST_USER_ID, [MD_EVENT]);

      expect(dbSelectGet).toHaveBeenCalled();
      expect(summarize).not.toHaveBeenCalled();
      expect(pointsOf(upsert)[0]?.payload.text).toContain(
        'Аннотация документа: кэшированная аннотация',
      );
      expect(dbInsert).not.toHaveBeenCalledWith(docSummaries);

      await app.close();
    });

    it('recomputes and re-caches the annotation when the content hash changed', async () => {
      const summarize = vi.fn().mockResolvedValue('новая аннотация');
      const { app, upsert, dbInsert, dbInsertValues, dbInsertOnConflict } = await buildTestApp({
        summarize,
        docSummaryRow: {
          path: MD_EVENT.path,
          contentHash: 'stale-hash',
          summary: 'старая аннотация',
        },
      });

      await processChanges(app, TEST_USER_ID, [MD_EVENT]);

      expect(summarize).toHaveBeenCalledTimes(1);
      expect(dbInsert).toHaveBeenCalledWith(docSummaries);
      expect(dbInsertValues).toHaveBeenCalledWith({
        path: MD_EVENT.path,
        contentHash: MD_EVENT.contentHash,
        summary: 'новая аннотация',
      });
      expect(dbInsertOnConflict).toHaveBeenCalled();
      expect(pointsOf(upsert)[0]?.payload.text).toContain('Аннотация документа: новая аннотация');

      await app.close();
    });

    it('indexes the file normally when the chat client fails', async () => {
      const summarize = vi.fn().mockRejectedValue(new Error('gateway down'));
      const { app, upsert, confirmIndexed, failIndexed, fileFailed } = await buildTestApp({
        summarize,
      });

      await processChanges(app, TEST_USER_ID, [MD_EVENT]);

      expect(confirmIndexed).toHaveBeenCalledWith(MD_EVENT.path);
      expect(failIndexed).not.toHaveBeenCalled();
      expect(fileFailed).toHaveLength(0);
      expect(pointsOf(upsert)[0]?.payload.text).not.toContain('Аннотация документа');

      await app.close();
    });

    it('skips a table summary that fails without dropping the row-group chunks', async () => {
      mockChunkCsv.mockReturnValueOnce(splitTableChunks());
      const summarize = vi.fn().mockRejectedValue(new Error('gateway down'));
      const { app, upsert, confirmIndexed } = await buildTestApp({ summarize });

      await processChanges(app, TEST_USER_ID, [CSV_EVENT]);

      expect(pointsOf(upsert)).toHaveLength(2);
      expect(confirmIndexed).toHaveBeenCalledWith(CSV_EVENT.path);

      await app.close();
    });

    it('makes no chat call at all when no summarizer is configured', async () => {
      const { app, upsert, dbSelectGet } = await buildTestApp();

      await processChanges(app, TEST_USER_ID, [MD_EVENT]);

      expect(dbSelectGet).not.toHaveBeenCalled();
      expect(pointsOf(upsert)[0]?.payload.text).not.toContain('Аннотация документа');

      await app.close();
    });

    it('drops the cached annotation of a deleted file', async () => {
      const { app, dbDelete } = await buildTestApp();

      await processChanges(app, TEST_USER_ID, [
        { path: 'notes/to-delete.md', type: 'deleted', contentHash: 'abc123' },
      ]);

      expect(dbDelete).toHaveBeenCalledWith(sections);
      expect(dbDelete).toHaveBeenCalledWith(docSummaries);

      await app.close();
    });

    it('carries the cached annotation over to the new path on a move', async () => {
      const { app, dbUpdate, dbSet } = await buildTestApp();

      await processChanges(app, TEST_USER_ID, [
        {
          path: 'notes/new-location.md',
          type: 'moved',
          contentHash: 'abc123',
          oldPath: 'notes/old-location.md',
        },
      ]);

      expect(dbUpdate).toHaveBeenCalledWith(docSummaries);
      expect(dbSet).toHaveBeenCalledWith({ path: 'notes/new-location.md' });

      await app.close();
    });

    // Last on purpose: the flag is read at config-parse time, so the module registry has
    // to be reset — after which the table objects imported here are no longer the ones
    // the freshly loaded pipeline compares against.
    it('INDEX_DOC_SUMMARY=false leaves chunk text untouched', async () => {
      process.env.INDEX_DOC_SUMMARY = 'false';
      vi.resetModules();
      try {
        const summarize = vi.fn().mockResolvedValue('аннотация');
        const { app, upsert } = await buildTestApp({ summarize });

        await processChanges(app, TEST_USER_ID, [MD_EVENT]);

        expect(summarize).not.toHaveBeenCalled();
        expect(pointsOf(upsert)[0]?.payload.text).not.toContain('Аннотация документа');

        await app.close();
      } finally {
        delete process.env.INDEX_DOC_SUMMARY;
        vi.resetModules();
      }
    });
  });
});
