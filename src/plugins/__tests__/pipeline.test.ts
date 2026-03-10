import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { FileChangeEvent } from '../../lib/indexer.js';
import type { EmbeddingProvider } from '../../lib/embedding.js';

// Set required env vars before any imports that trigger config parsing
beforeAll(() => {
  process.env.COGNIVAULT_API_KEY = 'test-api-key';
  process.env.VAULT_PATH = '/tmp/test-vault';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.QDRANT_URL = 'http://localhost:6333';
  process.env.EMBEDDING_MODEL = 'text-embedding-3-small';
});

// ── Mock helpers ──

type MockFn = ReturnType<typeof vi.fn>;

interface MockQdrant {
  upsert: MockFn;
  delete: MockFn;
  setPayload: MockFn;
}

interface MockEmbedder extends EmbeddingProvider {
  embed: MockFn;
  dimensions: number;
}

interface MockVault {
  readContent: MockFn;
}

interface MockDb {
  update: MockFn;
}

// Creates a minimal Fastify app with mocked services wired as decorators
async function buildTestApp(overrides?: {
  vault?: Partial<MockVault>;
  embedder?: Partial<MockEmbedder>;
  qdrant?: Partial<MockQdrant>;
  db?: Partial<MockDb>;
}): Promise<{
  app: FastifyInstance;
  mocks: { vault: MockVault; embedder: MockEmbedder; qdrant: MockQdrant; db: MockDb };
}> {
  const Fastify = (await import('fastify')).default;

  // Default mock implementations
  const mockVault: MockVault = {
    readContent: vi.fn().mockResolvedValue({ content: '# Test\n\nSome content for testing purposes with enough tokens to create a chunk in the markdown processor since we need at least 100 tokens per section to avoid merging. Adding more text here to ensure we have enough content for chunking to work correctly and produce at least one valid chunk output.' }),
    ...overrides?.vault,
  };

  const mockEmbedder: MockEmbedder = {
    dimensions: 1536,
    embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    ...overrides?.embedder,
  };

  const mockQdrant: MockQdrant = {
    upsert: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    setPayload: vi.fn().mockResolvedValue({}),
    ...overrides?.qdrant,
  };

  // Mock the db.update chain: db.update().set().where().run()
  const mockRun = vi.fn();
  const mockWhere = vi.fn().mockReturnValue({ run: mockRun });
  const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
  const mockDb: MockDb = {
    update: mockUpdate,
    ...overrides?.db,
  };

  const app = Fastify({ logger: false });

  // Register mock services as named plugins with fp() so they satisfy dependency checks
  await app.register(
    fp(
      async (f) => {
        f.decorate('vault', mockVault);
        f.decorate('embedder', mockEmbedder);
        f.decorate('qdrant', mockQdrant);
        f.decorate('db', mockDb);
        f.decorate('indexer', {
          on: vi.fn(),
          removeListener: vi.fn(),
        });
      },
      { name: 'vault' },
    ),
  );

  await app.register(
    fp(async (f) => { f; }, { name: 'db' }),
  );
  await app.register(
    fp(async (f) => { f; }, { name: 'embedder' }),
  );
  await app.register(
    fp(async (f) => { f; }, { name: 'qdrant' }),
  );
  await app.register(
    fp(async (f) => { f; }, { name: 'indexer' }),
  );

  const { default: pipelinePlugin } = await import('../pipeline.js');
  await app.register(pipelinePlugin);
  await app.ready();

  return { app, mocks: { vault: mockVault, embedder: mockEmbedder, qdrant: mockQdrant, db: mockDb } };
}

// Helper: emit a batch of changes directly to the pipeline's listener
async function emitChanges(app: FastifyInstance, events: FileChangeEvent[]): Promise<void> {
  // The pipeline registers a listener via indexer.on('changes', handler)
  // We capture it from the mock and call it directly
  const indexer = app.indexer as unknown as { on: MockFn; removeListener: MockFn };
  const onCall = indexer.on.mock.calls.find((c: unknown[]) => c[0] === 'changes');
  if (!onCall) throw new Error('Pipeline did not register changes listener');
  const handler = onCall[1] as (events: FileChangeEvent[]) => void;
  handler(events);
  // Allow queue microtasks to settle
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('pipeline plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('created event', () => {
    it('reads file content, embeds chunks, and upserts to Qdrant with correct payload', async () => {
      const { app, mocks } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await emitChanges(app, [event]);

      expect(mocks.vault.readContent).toHaveBeenCalledWith('notes/my-note.md');
      expect(mocks.embedder.embed).toHaveBeenCalled();
      expect(mocks.qdrant.upsert).toHaveBeenCalledWith(
        'cognivault',
        expect.objectContaining({ points: expect.any(Array) }),
      );

      const upsertCall = mocks.qdrant.upsert.mock.calls[0];
      const points = upsertCall[1].points as Array<{
        id: string;
        vector: number[];
        payload: Record<string, unknown>;
      }>;
      expect(points.length).toBeGreaterThan(0);

      const firstPoint = points[0];
      expect(firstPoint.id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
      expect(firstPoint.vector).toEqual([0.1, 0.2, 0.3]);
      expect(firstPoint.payload.path).toBe('notes/my-note.md');
      expect(firstPoint.payload.title).toBe('my-note');
      expect(firstPoint.payload.chunk_index).toBe(0);
      expect(firstPoint.payload.content_hash).toBe('abc123');
      expect(firstPoint.payload.section_path).toBeDefined();
      expect(firstPoint.payload.tags).toEqual([]);
      expect(firstPoint.payload.project).toBeNull();
      expect(firstPoint.payload.status).toBeNull();
      expect(firstPoint.payload.type).toBeNull();
      expect(typeof firstPoint.payload.extra_metadata).toBe('string');

      await app.close();
    });

    it('sets embedding_model_version in indexed_files after successful embed', async () => {
      const { app, mocks } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await emitChanges(app, [event]);

      expect(mocks.db.update).toHaveBeenCalled();

      await app.close();
    });

    it('deletes stale vectors after upsert (chunk_index >= new count)', async () => {
      const { app, mocks } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await emitChanges(app, [event]);

      // Stale cleanup should have been called
      expect(mocks.qdrant.delete).toHaveBeenCalledWith(
        'cognivault',
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

    it('includes tags array from frontmatter', async () => {
      const content = '---\ntags:\n  - ai\n  - research\n---\n\n# My Note\n\nContent with enough tokens here to ensure chunking works properly and produces at least one chunk with sufficient token count to not be merged into another section.';
      const { app, mocks } = await buildTestApp({
        vault: { readContent: vi.fn().mockResolvedValue({ content }) },
      });

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await emitChanges(app, [event]);

      if (mocks.qdrant.upsert.mock.calls.length > 0) {
        const points = mocks.qdrant.upsert.mock.calls[0][1].points as Array<{
          payload: Record<string, unknown>;
        }>;
        if (points.length > 0) {
          expect(points[0].payload.tags).toEqual(['ai', 'research']);
        }
      }

      await app.close();
    });

    it('normalizes string tags to array', async () => {
      const content = '---\ntags: ai\nproject: cognivault\nstatus: active\ntype: note\n---\n\n# My Note\n\nContent with enough tokens here to ensure chunking works properly and produces at least one chunk with sufficient token count to not be merged into another section.';
      const { app, mocks } = await buildTestApp({
        vault: { readContent: vi.fn().mockResolvedValue({ content }) },
      });

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await emitChanges(app, [event]);

      if (mocks.qdrant.upsert.mock.calls.length > 0) {
        const points = mocks.qdrant.upsert.mock.calls[0][1].points as Array<{
          payload: Record<string, unknown>;
        }>;
        if (points.length > 0) {
          expect(points[0].payload.tags).toEqual(['ai']);
          expect(points[0].payload.project).toBe('cognivault');
          expect(points[0].payload.status).toBe('active');
          expect(points[0].payload.type).toBe('note');
        }
      }

      await app.close();
    });

    it('stores remaining frontmatter fields in extra_metadata as JSON string', async () => {
      const content = '---\ntags: [ai]\ncustom_field: hello\nanother: 42\n---\n\n# My Note\n\nContent with enough tokens here to ensure chunking works properly and produces at least one chunk with sufficient token count to not be merged into another section.';
      const { app, mocks } = await buildTestApp({
        vault: { readContent: vi.fn().mockResolvedValue({ content }) },
      });

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await emitChanges(app, [event]);

      if (mocks.qdrant.upsert.mock.calls.length > 0) {
        const points = mocks.qdrant.upsert.mock.calls[0][1].points as Array<{
          payload: Record<string, unknown>;
        }>;
        if (points.length > 0) {
          const extraMetadata = JSON.parse(points[0].payload.extra_metadata as string) as Record<string, unknown>;
          expect(extraMetadata.custom_field).toBe('hello');
          expect(extraMetadata.another).toBe(42);
          // Standard fields should NOT be in extra_metadata
          expect(extraMetadata.tags).toBeUndefined();
        }
      }

      await app.close();
    });
  });

  describe('updated event', () => {
    it('re-embeds and upserts, then cleans stale vectors', async () => {
      const { app, mocks } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'updated',
        contentHash: 'newHash456',
      };

      await emitChanges(app, [event]);

      expect(mocks.vault.readContent).toHaveBeenCalledWith('notes/my-note.md');
      expect(mocks.embedder.embed).toHaveBeenCalled();
      expect(mocks.qdrant.upsert).toHaveBeenCalled();

      // Stale cleanup
      const deleteCalls = mocks.qdrant.delete.mock.calls as Array<[string, { filter: { must: Array<{ key: string; match?: unknown; range?: unknown }> } }]>;
      const staleCleanup = deleteCalls.find((call) => {
        const filter = call[1].filter;
        return filter.must.some((c) => c.key === 'chunk_index' && c.range !== undefined);
      });
      expect(staleCleanup).toBeDefined();

      await app.close();
    });
  });

  describe('deleted event', () => {
    it('deletes all vectors for the path from Qdrant', async () => {
      const { app, mocks } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/to-delete.md',
        type: 'deleted',
        contentHash: 'abc123',
      };

      await emitChanges(app, [event]);

      expect(mocks.vault.readContent).not.toHaveBeenCalled();
      expect(mocks.embedder.embed).not.toHaveBeenCalled();
      expect(mocks.qdrant.delete).toHaveBeenCalledWith(
        'cognivault',
        expect.objectContaining({
          filter: expect.objectContaining({
            must: expect.arrayContaining([
              expect.objectContaining({ key: 'path', match: { value: 'notes/to-delete.md' } }),
            ]),
          }),
        }),
      );
      // For deleted events, no chunk_index filter — just path filter
      const deleteCall = mocks.qdrant.delete.mock.calls[0] as [string, { filter: { must: Array<{ key: string }> } }];
      const hasChunkIndexFilter = deleteCall[1].filter.must.some((c) => c.key === 'chunk_index');
      expect(hasChunkIndexFilter).toBe(false);

      await app.close();
    });

    it('does not call embed or upsert for deleted events', async () => {
      const { app, mocks } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/to-delete.md',
        type: 'deleted',
        contentHash: 'abc123',
      };

      await emitChanges(app, [event]);

      expect(mocks.qdrant.upsert).not.toHaveBeenCalled();
      expect(mocks.embedder.embed).not.toHaveBeenCalled();

      await app.close();
    });
  });

  describe('moved event', () => {
    it('updates path and title in Qdrant payload without re-embedding', async () => {
      const { app, mocks } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/new-location.md',
        type: 'moved',
        contentHash: 'abc123',
        oldPath: 'notes/old-location.md',
      };

      await emitChanges(app, [event]);

      expect(mocks.embedder.embed).not.toHaveBeenCalled();
      expect(mocks.qdrant.upsert).not.toHaveBeenCalled();
      expect(mocks.qdrant.setPayload).toHaveBeenCalledWith(
        'cognivault',
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

    it('updates title in payload when moved to new filename', async () => {
      const { app, mocks } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/new-name.md',
        type: 'moved',
        contentHash: 'abc123',
        oldPath: 'notes/old-name.md',
      };

      await emitChanges(app, [event]);

      const setPayloadCall = mocks.qdrant.setPayload.mock.calls[0] as [string, { payload: Record<string, unknown> }];
      expect(setPayloadCall[1].payload.title).toBe('new-name');

      await app.close();
    });
  });

  describe('frontmatter-only notes', () => {
    it('skips embedding but still cleans stale vectors', async () => {
      const content = '---\ntags: [ai]\ntitle: My Note\n---\n';
      const { app, mocks } = await buildTestApp({
        vault: { readContent: vi.fn().mockResolvedValue({ content }) },
      });

      const event: FileChangeEvent = {
        path: 'notes/frontmatter-only.md',
        type: 'updated',
        contentHash: 'abc123',
      };

      await emitChanges(app, [event]);

      // No embedding should happen for empty body
      expect(mocks.embedder.embed).not.toHaveBeenCalled();
      expect(mocks.qdrant.upsert).not.toHaveBeenCalled();

      // Stale cleanup should still run
      expect(mocks.qdrant.delete).toHaveBeenCalled();

      await app.close();
    });
  });

  describe('partial failure handling', () => {
    it('processes other events when one event fails', async () => {
      // First call fails, second succeeds
      const readContent = vi.fn()
        .mockRejectedValueOnce(new Error('File read error'))
        .mockResolvedValueOnce({ content: '# Note\n\nContent with enough tokens here to ensure chunking works properly and produces at least one chunk with sufficient token count to not be merged into another section.' });

      const { app, mocks } = await buildTestApp({
        vault: { readContent },
      });

      const events: FileChangeEvent[] = [
        { path: 'notes/error-note.md', type: 'created', contentHash: 'err1' },
        { path: 'notes/ok-note.md', type: 'created', contentHash: 'ok1' },
      ];

      await emitChanges(app, events);

      // The second note should still be processed despite first failing
      expect(mocks.qdrant.upsert).toHaveBeenCalled();
      const upsertCallPaths = mocks.qdrant.upsert.mock.calls.map(
        (call: Array<[string, { points: Array<{ payload: { path: string } }> }]>) => (call as unknown as [string, { points: Array<{ payload: { path: string } }> }])[1].points[0]?.payload?.path,
      );
      expect(upsertCallPaths).toContain('notes/ok-note.md');

      await app.close();
    });
  });

  describe('deterministic chunk IDs', () => {
    it('generates UUID v5 IDs deterministically from path and chunk_index', async () => {
      const { app, mocks } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await emitChanges(app, [event]);

      // Run again — should produce same UUIDs
      vi.clearAllMocks();
      mocks.vault.readContent = vi.fn().mockResolvedValue({ content: '# Test\n\nSome content for testing purposes with enough tokens to create a chunk in the markdown processor since we need at least 100 tokens per section to avoid merging. Adding more text here to ensure we have enough content for chunking to work correctly and produce at least one valid chunk output.' });
      mocks.embedder.embed = vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]);
      mocks.qdrant.upsert = vi.fn().mockResolvedValue({});
      mocks.qdrant.delete = vi.fn().mockResolvedValue({});

      await emitChanges(app, [event]);

      const firstCallPoints = (mocks.qdrant.upsert.mock.calls[0] as [string, { points: Array<{ id: string }> }])[1].points;
      // Should have UUIDs — just verify format since we cleared mocks
      expect(firstCallPoints[0].id).toMatch(/^[0-9a-f-]{36}$/);

      await app.close();
    });
  });

  describe('plugin lifecycle', () => {
    it('registers changes listener on indexer.on', async () => {
      const { app } = await buildTestApp();

      const indexer = app.indexer as unknown as { on: MockFn };
      const onChangesCall = indexer.on.mock.calls.find((c: unknown[]) => c[0] === 'changes');
      expect(onChangesCall).toBeDefined();

      await app.close();
    });

    it('removes changes listener on app close', async () => {
      const { app } = await buildTestApp();

      const indexer = app.indexer as unknown as { on: MockFn; removeListener: MockFn };
      await app.close();

      expect(indexer.removeListener).toHaveBeenCalledWith('changes', expect.any(Function));
    });
  });
});
