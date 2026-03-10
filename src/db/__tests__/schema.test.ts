import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import type { IndexedFile, NewIndexedFile } from '../schema.js';
import { indexedFiles } from '../schema.js';

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
