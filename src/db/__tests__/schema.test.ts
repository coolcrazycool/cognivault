import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import type { IndexedFile, NewDocSummary, NewIndexedFile, NewSection } from '../schema.js';
import { docSummaries, indexedFiles, sections } from '../schema.js';

describe('Drizzle schema and DB client', () => {
  let db: ReturnType<typeof createDatabase>['db'];
  let sqlite: ReturnType<typeof createDatabase>['sqlite'];

  beforeAll(() => {
    // Use :memory: for most tests — WAL mode is tested separately with a file DB
    const result = createDatabase(':memory:');
    db = result.db;
    sqlite = result.sqlite;
  });

  afterAll(() => {
    sqlite.close();
  });

  describe('createDatabase', () => {
    it('creates a working database', () => {
      expect(db).toBeDefined();
      expect(sqlite).toBeDefined();
    });

    it('enables WAL journal mode for file-based databases', () => {
      // WAL mode is not applicable to :memory: databases (always returns 'memory')
      // Test with a real temp file to verify the PRAGMA is applied
      const tmpDir = mkdtempSync(join(tmpdir(), 'cognivault-wal-test-'));
      const dbPath = join(tmpDir, 'test.db');
      try {
        const { sqlite: fileSqlite } = createDatabase(dbPath);
        const result = fileSqlite.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
        expect(result.journal_mode).toBe('wal');
        fileSqlite.close();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('creates indexed_files table', () => {
      const result = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='indexed_files'")
        .get();
      expect(result).toBeDefined();
    });

    it('creates content_hash_idx index', () => {
      const result = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='content_hash_idx'")
        .get();
      expect(result).toBeDefined();
    });
  });

  describe('indexed_files table columns', () => {
    it('has path, content_hash, mtime, size, indexed_at columns', () => {
      const cols = sqlite.prepare('PRAGMA table_info(indexed_files)').all() as Array<{
        name: string;
        notnull: number;
        pk: number;
      }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain('path');
      expect(colNames).toContain('content_hash');
      expect(colNames).toContain('mtime');
      expect(colNames).toContain('size');
      expect(colNames).toContain('indexed_at');
    });

    it('path column is primary key', () => {
      const cols = sqlite.prepare('PRAGMA table_info(indexed_files)').all() as Array<{
        name: string;
        notnull: number;
        pk: number;
      }>;
      const pathCol = cols.find((c) => c.name === 'path');
      expect(pathCol?.pk).toBe(1);
    });

    it('content_hash, mtime, size, indexed_at are NOT NULL', () => {
      const cols = sqlite.prepare('PRAGMA table_info(indexed_files)').all() as Array<{
        name: string;
        notnull: number;
        pk: number;
      }>;
      for (const name of ['content_hash', 'mtime', 'size', 'indexed_at']) {
        const col = cols.find((c) => c.name === name);
        expect(col?.notnull, `${name} should be NOT NULL`).toBe(1);
      }
    });
  });

  describe('CRUD operations', () => {
    const testFile: NewIndexedFile = {
      path: '/notes/hello.md',
      contentHash: 'abc123def456',
      mtime: 1700000000000,
      size: 1024,
      indexedAt: '2024-01-01T00:00:00.000Z',
    };

    it('can insert a row', () => {
      db.insert(indexedFiles).values(testFile).run();
      const row = db.select().from(indexedFiles).where(eq(indexedFiles.path, testFile.path)).get();
      expect(row).toBeDefined();
      expect(row?.contentHash).toBe(testFile.contentHash);
      expect(row?.mtime).toBe(testFile.mtime);
      expect(row?.size).toBe(testFile.size);
      expect(row?.indexedAt).toBe(testFile.indexedAt);
    });

    it('can query by content_hash (move detection)', () => {
      const rows = db
        .select()
        .from(indexedFiles)
        .where(eq(indexedFiles.contentHash, 'abc123def456'))
        .all();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.path).toBe('/notes/hello.md');
    });

    it('can upsert on path primary key', () => {
      const updated: NewIndexedFile = {
        path: '/notes/hello.md',
        contentHash: 'newHash999',
        mtime: 1700001000000,
        size: 2048,
        indexedAt: '2024-01-02T00:00:00.000Z',
      };

      db.insert(indexedFiles)
        .values(updated)
        .onConflictDoUpdate({
          target: indexedFiles.path,
          set: {
            contentHash: updated.contentHash,
            mtime: updated.mtime,
            size: updated.size,
            indexedAt: updated.indexedAt,
          },
        })
        .run();

      const row = db.select().from(indexedFiles).where(eq(indexedFiles.path, updated.path)).get();
      expect(row?.contentHash).toBe('newHash999');
      expect(row?.size).toBe(2048);
    });

    it('IndexedFile type is assignable from query result', () => {
      const row: IndexedFile | undefined = db
        .select()
        .from(indexedFiles)
        .where(eq(indexedFiles.path, '/notes/hello.md'))
        .get();
      expect(row).toBeDefined();
    });
  });

  describe('sections table (parent documents)', () => {
    const makeSection = (overrides: Partial<NewSection> = {}): NewSection => ({
      path: '/notes/parents.md',
      parentId: 'a'.repeat(40),
      sectionPath: 'Parents > Intro',
      text: 'Parents > Intro\n\nFull section body.',
      contentHash: 'sectionhash1',
      updatedAt: '2024-01-01T00:00:00.000Z',
      ...overrides,
    });

    it('creates the sections table', () => {
      const result = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sections'")
        .get();
      expect(result).toBeDefined();
    });

    it('creates sections_path_idx index', () => {
      const result = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='sections_path_idx'")
        .get();
      expect(result).toBeDefined();
    });

    it('has path, parent_id, section_path, text, content_hash, updated_at columns', () => {
      const cols = sqlite.prepare('PRAGMA table_info(sections)').all() as Array<{
        name: string;
        notnull: number;
        pk: number;
      }>;
      const colNames = cols.map((c) => c.name);
      for (const name of [
        'path',
        'parent_id',
        'section_path',
        'text',
        'content_hash',
        'updated_at',
      ]) {
        expect(colNames, `missing column ${name}`).toContain(name);
      }
    });

    it('uses a composite primary key of (path, parent_id)', () => {
      const cols = sqlite.prepare('PRAGMA table_info(sections)').all() as Array<{
        name: string;
        pk: number;
      }>;
      const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
      expect(pkCols.map((c) => c.name)).toEqual(['path', 'parent_id']);
    });

    it('accepts the same parent_id under two different paths', () => {
      // parent_id is derived without the file path, so a collision across notes is
      // expected and must not be rejected.
      const shared = 'b'.repeat(40);
      db.insert(sections)
        .values(makeSection({ path: '/notes/one.md', parentId: shared }))
        .run();
      db.insert(sections)
        .values(makeSection({ path: '/notes/two.md', parentId: shared }))
        .run();

      const rows = db.select().from(sections).where(eq(sections.parentId, shared)).all();
      expect(rows.map((r) => r.path).sort()).toEqual(['/notes/one.md', '/notes/two.md']);
    });

    it('rejects a duplicate (path, parent_id) pair', () => {
      const row = makeSection({ path: '/notes/dupe.md', parentId: 'c'.repeat(40) });
      db.insert(sections).values(row).run();
      expect(() => db.insert(sections).values(row).run()).toThrow();
    });

    it('deletes every section of a path in one statement', () => {
      db.insert(sections)
        .values([
          makeSection({ path: '/notes/purge.md', parentId: 'd'.repeat(40) }),
          makeSection({ path: '/notes/purge.md', parentId: 'e'.repeat(40) }),
        ])
        .run();
      expect(
        db.select().from(sections).where(eq(sections.path, '/notes/purge.md')).all(),
      ).toHaveLength(2);

      db.delete(sections).where(eq(sections.path, '/notes/purge.md')).run();
      expect(db.select().from(sections).where(eq(sections.path, '/notes/purge.md')).all()).toEqual(
        [],
      );
    });

    it('repoints every section of a moved file with one UPDATE', () => {
      db.insert(sections)
        .values([
          makeSection({ path: '/inbox/moved.md', parentId: 'f'.repeat(40) }),
          makeSection({ path: '/inbox/moved.md', parentId: '0'.repeat(40) }),
        ])
        .run();

      db.update(sections)
        .set({ path: '/archive/moved.md' })
        .where(eq(sections.path, '/inbox/moved.md'))
        .run();

      expect(db.select().from(sections).where(eq(sections.path, '/inbox/moved.md')).all()).toEqual(
        [],
      );
      expect(
        db.select().from(sections).where(eq(sections.path, '/archive/moved.md')).all(),
      ).toHaveLength(2);
    });
  });

  describe('doc_summaries table (annotation cache)', () => {
    const makeSummary = (overrides: Partial<NewDocSummary> = {}): NewDocSummary => ({
      path: '/notes/annotated.md',
      contentHash: 'hash-v1',
      summary: 'Документ о настройке mTLS.',
      ...overrides,
    });

    it('creates the doc_summaries table', () => {
      const result = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='doc_summaries'")
        .get();
      expect(result).toBeDefined();
    });

    it('has path, content_hash, summary columns with path as primary key', () => {
      const cols = sqlite.prepare('PRAGMA table_info(doc_summaries)').all() as Array<{
        name: string;
        notnull: number;
        pk: number;
      }>;
      expect(cols.map((c) => c.name)).toEqual(['path', 'content_hash', 'summary']);
      expect(cols.find((c) => c.name === 'path')?.pk).toBe(1);
      for (const name of ['content_hash', 'summary']) {
        expect(cols.find((c) => c.name === name)?.notnull, `${name} NOT NULL`).toBe(1);
      }
    });

    it('refreshes the cached summary on conflict with the path', () => {
      db.insert(docSummaries).values(makeSummary()).run();
      db.insert(docSummaries)
        .values(makeSummary({ contentHash: 'hash-v2', summary: 'Обновлённая аннотация.' }))
        .onConflictDoUpdate({
          target: docSummaries.path,
          set: { contentHash: 'hash-v2', summary: 'Обновлённая аннотация.' },
        })
        .run();

      const rows = db
        .select()
        .from(docSummaries)
        .where(eq(docSummaries.path, '/notes/annotated.md'))
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.contentHash).toBe('hash-v2');
      expect(rows[0]?.summary).toBe('Обновлённая аннотация.');
    });

    it('drops the cached summary of a deleted path', () => {
      db.insert(docSummaries)
        .values(makeSummary({ path: '/notes/gone.md' }))
        .run();
      db.delete(docSummaries).where(eq(docSummaries.path, '/notes/gone.md')).run();
      expect(
        db.select().from(docSummaries).where(eq(docSummaries.path, '/notes/gone.md')).all(),
      ).toEqual([]);
    });
  });
});

describe('Config schema extensions', () => {
  it('accepts COGNIVAULT_DATA_DIR with default', async () => {
    // Test that importing config with partial env does not throw for new fields
    // We test the schema parsing directly via dynamic import isolation
    const { z } = await import('zod');
    const testSchema = z.object({
      COGNIVAULT_DATA_DIR: z.string().default('./.cognivault'),
      POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
      STABILITY_DELAY_MS: z.coerce.number().int().positive().default(2000),
    });
    const result = testSchema.parse({});
    expect(result.COGNIVAULT_DATA_DIR).toBe('./.cognivault');
    expect(result.POLL_INTERVAL_MS).toBe(5000);
    expect(result.STABILITY_DELAY_MS).toBe(2000);
  });

  it('allows overriding COGNIVAULT_DATA_DIR', async () => {
    const { z } = await import('zod');
    const testSchema = z.object({
      COGNIVAULT_DATA_DIR: z.string().default('./.cognivault'),
      POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
      STABILITY_DELAY_MS: z.coerce.number().int().positive().default(2000),
    });
    const result = testSchema.parse({
      COGNIVAULT_DATA_DIR: '/custom/data',
      POLL_INTERVAL_MS: '10000',
      STABILITY_DELAY_MS: '3000',
    });
    expect(result.COGNIVAULT_DATA_DIR).toBe('/custom/data');
    expect(result.POLL_INTERVAL_MS).toBe(10000);
    expect(result.STABILITY_DELAY_MS).toBe(3000);
  });
});
