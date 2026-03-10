import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileChangeEvent } from '../../lib/indexer.js';

// Set required env vars before any imports that trigger config parsing
beforeAll(() => {
  process.env.COGNIVAULT_API_KEY = 'test-api-key';
  process.env.VAULT_PATH = '/tmp/test-vault';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.QDRANT_URL = 'http://localhost:6333';
  process.env.EMBEDDING_MODEL = 'text-embedding-3-small';
});

// ── Enough content to produce at least one chunk (>=100 tokens) ──
const RICH_CONTENT =
  '# Test\n\nSome content for testing purposes with enough tokens to create a chunk in the markdown processor since we need at least 100 tokens per section to avoid merging. Adding more text here to ensure we have enough content for chunking to work correctly and produce at least one valid chunk output.';

// Creates a minimal Fastify app with mocked services wired as decorators.
// Uses `unknown` casts to bypass Fastify's strict decorator type matching.
async function buildTestApp(opts?: {
  readContent?: ReturnType<typeof vi.fn>;
  embed?: ReturnType<typeof vi.fn>;
  upsert?: ReturnType<typeof vi.fn>;
  qdrantDelete?: ReturnType<typeof vi.fn>;
  setPayload?: ReturnType<typeof vi.fn>;
}): Promise<{
  app: FastifyInstance;
  readContent: ReturnType<typeof vi.fn>;
  embed: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  qdrantDelete: ReturnType<typeof vi.fn>;
  setPayload: ReturnType<typeof vi.fn>;
  dbUpdate: ReturnType<typeof vi.fn>;
}> {
  const Fastify = (await import('fastify')).default;

  const readContent = opts?.readContent ?? vi.fn().mockResolvedValue({ content: RICH_CONTENT });
  const embed = opts?.embed ?? vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]);
  const upsert = opts?.upsert ?? vi.fn().mockResolvedValue({});
  const qdrantDelete = opts?.qdrantDelete ?? vi.fn().mockResolvedValue({});
  const setPayload = opts?.setPayload ?? vi.fn().mockResolvedValue({});

  // Build the db.update chain mock
  const dbRun = vi.fn();
  const dbWhere = vi.fn().mockReturnValue({ run: dbRun });
  const dbSet = vi.fn().mockReturnValue({ where: dbWhere });
  const dbUpdate = vi.fn().mockReturnValue({ set: dbSet });

  const app = Fastify({ logger: false });

  // Register all dependencies as a single plugin to avoid fp name conflicts
  await app.register(
    fp(
      async (f) => {
        f.decorate('vault', { readContent } as unknown as FastifyInstance['vault']);
        f.decorate('embedder', {
          dimensions: 1536,
          embed,
        } as unknown as FastifyInstance['embedder']);
        f.decorate('qdrant', {
          upsert,
          delete: qdrantDelete,
          setPayload,
        } as unknown as FastifyInstance['qdrant']);
        f.decorate('db', { update: dbUpdate } as unknown as FastifyInstance['db']);
        f.decorate('indexer', {
          on: vi.fn(),
          removeListener: vi.fn(),
        } as unknown as FastifyInstance['indexer']);
      },
      { name: 'vault' },
    ),
  );

  // Satisfy fp dependency checks with empty plugins
  for (const name of ['db', 'embedder', 'qdrant', 'indexer'] as const) {
    await app.register(fp(async (_f) => {}, { name }));
  }

  const { default: pipelinePlugin } = await import('../pipeline.js');
  await app.register(pipelinePlugin);
  await app.ready();

  return { app, readContent, embed, upsert, qdrantDelete, setPayload, dbUpdate };
}

// Helper: invoke the 'changes' listener the pipeline registered on indexer.on
async function emitChanges(app: FastifyInstance, events: FileChangeEvent[]): Promise<void> {
  type IndexerMock = { on: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
  const indexer = app.indexer as unknown as IndexerMock;
  const onCall = indexer.on.mock.calls.find((c: unknown[]) => c[0] === 'changes') as
    | [string, (events: FileChangeEvent[]) => void]
    | undefined;
  if (!onCall) throw new Error('Pipeline did not register changes listener');
  const handler = onCall[1];
  handler(events);
  // Let queue microtasks settle
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

describe('pipeline plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── created events ──────────────────────────────────────────────────────

  describe('created event', () => {
    it('reads file content, embeds chunks, and upserts to Qdrant with correct payload', async () => {
      const { app, readContent, embed, upsert, qdrantDelete } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await emitChanges(app, [event]);

      expect(readContent).toHaveBeenCalledWith('notes/my-note.md');
      expect(embed).toHaveBeenCalled();
      expect(upsert).toHaveBeenCalledWith(
        'cognivault',
        expect.objectContaining({ points: expect.any(Array) }),
      );

      type UpsertPayload = { id: string; vector: number[]; payload: Record<string, unknown> };
      const upsertCall = upsert.mock.calls[0] as [string, { points: UpsertPayload[] }] | undefined;
      expect(upsertCall).toBeDefined();
      if (!upsertCall) return;

      const points = upsertCall[1].points;
      expect(points.length).toBeGreaterThan(0);

      const firstPoint = points[0];
      expect(firstPoint).toBeDefined();
      if (!firstPoint) return;

      expect(firstPoint.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(firstPoint.vector).toEqual([0.1, 0.2, 0.3]);
      expect(firstPoint.payload['path']).toBe('notes/my-note.md');
      expect(firstPoint.payload['title']).toBe('my-note');
      expect(firstPoint.payload['chunk_index']).toBe(0);
      expect(firstPoint.payload['content_hash']).toBe('abc123');
      expect(firstPoint.payload['section_path']).toBeDefined();
      expect(firstPoint.payload['tags']).toEqual([]);
      expect(firstPoint.payload['project']).toBeNull();
      expect(firstPoint.payload['status']).toBeNull();
      expect(firstPoint.payload['type']).toBeNull();
      expect(typeof firstPoint.payload['extra_metadata']).toBe('string');

      // Stale cleanup should have been called
      expect(qdrantDelete).toHaveBeenCalledWith(
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

    it('sets embedding_model_version in indexed_files after successful embed', async () => {
      const { app, dbUpdate } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await emitChanges(app, [event]);

      expect(dbUpdate).toHaveBeenCalled();

      await app.close();
    });

    it('includes tags array from frontmatter', async () => {
      const content =
        '---\ntags:\n  - ai\n  - research\n---\n\n# My Note\n\nContent with enough tokens here to ensure chunking works properly and produces at least one chunk with sufficient token count to not be merged into another section.';
      const { app, upsert } = await buildTestApp({
        readContent: vi.fn().mockResolvedValue({ content }),
      });

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await emitChanges(app, [event]);

      type UpsertPayload = { payload: Record<string, unknown> };
      const call = upsert.mock.calls[0] as [string, { points: UpsertPayload[] }] | undefined;
      if (call) {
        const pt = call[1].points[0];
        if (pt) {
          expect(pt.payload['tags']).toEqual(['ai', 'research']);
        }
      }

      await app.close();
    });

    it('normalizes string tags to array and maps project/status/type from frontmatter', async () => {
      const content =
        '---\ntags: ai\nproject: cognivault\nstatus: active\ntype: note\n---\n\n# My Note\n\nContent with enough tokens here to ensure chunking works properly and produces at least one chunk with sufficient token count to not be merged into another section.';
      const { app, upsert } = await buildTestApp({
        readContent: vi.fn().mockResolvedValue({ content }),
      });

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await emitChanges(app, [event]);

      type UpsertPayload = { payload: Record<string, unknown> };
      const call = upsert.mock.calls[0] as [string, { points: UpsertPayload[] }] | undefined;
      if (call) {
        const pt = call[1].points[0];
        if (pt) {
          expect(pt.payload['tags']).toEqual(['ai']);
          expect(pt.payload['project']).toBe('cognivault');
          expect(pt.payload['status']).toBe('active');
          expect(pt.payload['type']).toBe('note');
        }
      }

      await app.close();
    });

    it('stores remaining frontmatter fields in extra_metadata as JSON string', async () => {
      const content =
        '---\ntags: [ai]\ncustom_field: hello\nanother: 42\n---\n\n# My Note\n\nContent with enough tokens here to ensure chunking works properly and produces at least one chunk with sufficient token count to not be merged into another section.';
      const { app, upsert } = await buildTestApp({
        readContent: vi.fn().mockResolvedValue({ content }),
      });

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      await emitChanges(app, [event]);

      type UpsertPayload = { payload: Record<string, unknown> };
      const call = upsert.mock.calls[0] as [string, { points: UpsertPayload[] }] | undefined;
      if (call) {
        const pt = call[1].points[0];
        if (pt) {
          const extraMetadata = JSON.parse(pt.payload['extra_metadata'] as string) as Record<
            string,
            unknown
          >;
          expect(extraMetadata['custom_field']).toBe('hello');
          expect(extraMetadata['another']).toBe(42);
          // Standard fields must NOT appear in extra_metadata
          expect(extraMetadata['tags']).toBeUndefined();
        }
      }

      await app.close();
    });
  });

  // ── updated events ──────────────────────────────────────────────────────

  describe('updated event', () => {
    it('re-embeds and upserts, then cleans stale vectors', async () => {
      const { app, readContent, embed, upsert, qdrantDelete } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'updated',
        contentHash: 'newHash456',
      };

      await emitChanges(app, [event]);

      expect(readContent).toHaveBeenCalledWith('notes/my-note.md');
      expect(embed).toHaveBeenCalled();
      expect(upsert).toHaveBeenCalled();

      // Verify stale cleanup (chunk_index range filter)
      type DeleteArg = { filter: { must: Array<{ key: string; range?: unknown }> } };
      const deleteCalls = qdrantDelete.mock.calls as [string, DeleteArg][];
      const staleCleanup = deleteCalls.find((call) =>
        call[1].filter.must.some((c) => c.key === 'chunk_index' && c.range !== undefined),
      );
      expect(staleCleanup).toBeDefined();

      await app.close();
    });
  });

  // ── deleted events ──────────────────────────────────────────────────────

  describe('deleted event', () => {
    it('deletes all vectors for the path from Qdrant', async () => {
      const { app, readContent, embed, upsert, qdrantDelete } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/to-delete.md',
        type: 'deleted',
        contentHash: 'abc123',
      };

      await emitChanges(app, [event]);

      expect(readContent).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();

      expect(qdrantDelete).toHaveBeenCalledWith(
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
      type DeleteArg = { filter: { must: Array<{ key: string }> } };
      const deleteCall = qdrantDelete.mock.calls[0] as [string, DeleteArg] | undefined;
      if (deleteCall) {
        const hasChunkIndexFilter = deleteCall[1].filter.must.some((c) => c.key === 'chunk_index');
        expect(hasChunkIndexFilter).toBe(false);
      }

      await app.close();
    });

    it('does not call embed or upsert for deleted events', async () => {
      const { app, upsert, embed } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/to-delete.md',
        type: 'deleted',
        contentHash: 'abc123',
      };

      await emitChanges(app, [event]);

      expect(upsert).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();

      await app.close();
    });
  });

  // ── moved events ────────────────────────────────────────────────────────

  describe('moved event', () => {
    it('updates path and title in Qdrant payload without re-embedding', async () => {
      const { app, embed, upsert, setPayload } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/new-location.md',
        type: 'moved',
        contentHash: 'abc123',
        oldPath: 'notes/old-location.md',
      };

      await emitChanges(app, [event]);

      expect(embed).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
      expect(setPayload).toHaveBeenCalledWith(
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
      const { app, setPayload } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/new-name.md',
        type: 'moved',
        contentHash: 'abc123',
        oldPath: 'notes/old-name.md',
      };

      await emitChanges(app, [event]);

      type SetPayloadArg = { payload: Record<string, unknown> };
      const call = setPayload.mock.calls[0] as [string, SetPayloadArg] | undefined;
      if (call) {
        expect(call[1].payload['title']).toBe('new-name');
      }

      await app.close();
    });
  });

  // ── frontmatter-only notes ───────────────────────────────────────────────

  describe('frontmatter-only notes', () => {
    it('skips embedding but still cleans stale vectors', async () => {
      const content = '---\ntags: [ai]\ntitle: My Note\n---\n';
      const { app, embed, upsert, qdrantDelete } = await buildTestApp({
        readContent: vi.fn().mockResolvedValue({ content }),
      });

      const event: FileChangeEvent = {
        path: 'notes/frontmatter-only.md',
        type: 'updated',
        contentHash: 'abc123',
      };

      await emitChanges(app, [event]);

      expect(embed).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
      expect(qdrantDelete).toHaveBeenCalled();

      await app.close();
    });
  });

  // ── partial failure handling ─────────────────────────────────────────────

  describe('partial failure handling', () => {
    it('processes other events when one event fails', async () => {
      const readContent = vi
        .fn()
        .mockRejectedValueOnce(new Error('File read error'))
        .mockResolvedValueOnce({ content: RICH_CONTENT });

      const { app, upsert } = await buildTestApp({ readContent });

      const events: FileChangeEvent[] = [
        { path: 'notes/error-note.md', type: 'created', contentHash: 'err1' },
        { path: 'notes/ok-note.md', type: 'created', contentHash: 'ok1' },
      ];

      await emitChanges(app, events);

      expect(upsert).toHaveBeenCalled();

      type UpsertArg = { points: Array<{ payload: { path: string } }> };
      const upsertPaths = (upsert.mock.calls as [string, UpsertArg][]).map(
        (call) => call[1].points[0]?.payload.path,
      );
      expect(upsertPaths).toContain('notes/ok-note.md');

      await app.close();
    });
  });

  // ── deterministic chunk IDs ──────────────────────────────────────────────

  describe('deterministic chunk IDs', () => {
    it('generates UUID v5 IDs deterministically from path and chunk_index', async () => {
      const { app, upsert } = await buildTestApp();

      const event: FileChangeEvent = {
        path: 'notes/my-note.md',
        type: 'created',
        contentHash: 'abc123',
      };

      // First run
      await emitChanges(app, [event]);

      type UpsertArg = { points: Array<{ id: string }> };
      const firstCall = upsert.mock.calls[0] as [string, UpsertArg] | undefined;
      expect(firstCall).toBeDefined();
      const firstId = firstCall?.[1].points[0]?.id;
      expect(firstId).toBeDefined();
      // UUID v5 has version nibble = 5
      expect(firstId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      // Second run with same inputs — IDs must be identical
      upsert.mockClear();
      await emitChanges(app, [event]);

      const secondCall = upsert.mock.calls[0] as [string, UpsertArg] | undefined;
      const secondId = secondCall?.[1].points[0]?.id;
      expect(secondId).toBe(firstId);

      await app.close();
    });
  });

  // ── plugin lifecycle ─────────────────────────────────────────────────────

  describe('plugin lifecycle', () => {
    it('registers changes listener on indexer.on', async () => {
      const { app } = await buildTestApp();

      type IndexerMock = { on: ReturnType<typeof vi.fn> };
      const indexer = app.indexer as unknown as IndexerMock;
      const onChangesCall = indexer.on.mock.calls.find((c: unknown[]) => c[0] === 'changes');
      expect(onChangesCall).toBeDefined();

      await app.close();
    });

    it('removes changes listener on app close', async () => {
      const { app } = await buildTestApp();

      type IndexerMock = { removeListener: ReturnType<typeof vi.fn> };
      const indexer = app.indexer as unknown as IndexerMock;
      await app.close();

      expect(indexer.removeListener).toHaveBeenCalledWith('changes', expect.any(Function));
    });
  });
});
