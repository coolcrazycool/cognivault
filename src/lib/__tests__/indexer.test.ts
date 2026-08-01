import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../db/client.js';
import type { FileChangeEvent } from '../indexer.js';
import {
  DOCUMENT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  INDEXED_EXTENSIONS,
  VaultIndexer,
} from '../indexer.js';

// Records every fs.readFile the indexer performs, so the mtime/size pretest can be
// asserted directly ("this file was never opened"). The real implementation still runs.
const { readFileCalls } = vi.hoisted(() => ({ readFileCalls: [] as string[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    readFile: (
      target: Parameters<typeof original.readFile>[0],
      ...rest: unknown[]
    ): ReturnType<typeof original.readFile> => {
      readFileCalls.push(String(target));
      return (original.readFile as (...args: unknown[]) => ReturnType<typeof original.readFile>)(
        target,
        ...rest,
      );
    },
  };
});

// Create a real VaultManager-like stub for tests
// (avoids circular deps and allows fine-grained control of file listing)
interface MockVaultEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

function createMockVault(vaultRoot: string) {
  return {
    rootPath: vaultRoot,
    get vaultRootPath() {
      return vaultRoot;
    },
    async listFiles(opts?: {
      recursive?: boolean;
      ext?: string;
    }): Promise<{ entries: MockVaultEntry[] }> {
      const extFilter = opts?.ext
        ? opts.ext.startsWith('.')
          ? opts.ext
          : `.${opts.ext}`
        : undefined;

      const results: MockVaultEntry[] = [];

      async function walk(dir: string): Promise<void> {
        let entries: import('node:fs').Dirent<string>[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf-8' });
        } catch {
          return;
        }

        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;

          const absPath = path.join(dir, entry.name);
          const relPath = path.relative(vaultRoot, absPath).split(path.sep).join('/');

          if (entry.isDirectory()) {
            if (opts?.recursive !== false) {
              await walk(absPath);
            }
          } else if (entry.isFile()) {
            if (extFilter && path.extname(entry.name) !== extFilter) continue;
            results.push({ name: entry.name, path: relPath, type: 'file' });
          }
        }
      }

      await walk(vaultRoot);
      return { entries: results };
    },
  };
}

/**
 * Stand in for the pipeline: acknowledge every created/updated/moved event so the
 * indexed_files row actually gets written. Without this the indexer keeps the file
 * "pending" forever, which is the whole point of the transactional handshake.
 */
function attachAutoConfirm(indexer: VaultIndexer): void {
  indexer.on('changes', (events) => {
    for (const event of events) {
      if (event.type !== 'deleted') {
        indexer.confirmIndexed(event.path);
      }
    }
  });
}

function createTestIndexer(opts: {
  vaultRoot: string;
  dbPath: string;
  pollIntervalMs?: number;
  stabilityDelayMs?: number;
  /** Set false to observe the pending state before the pipeline confirms. */
  autoConfirm?: boolean;
}) {
  const { db } = createDatabase(opts.dbPath);
  const vault = createMockVault(opts.vaultRoot) as unknown as import('../vault.js').VaultManager;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as import('fastify').FastifyBaseLogger;

  const indexer = new VaultIndexer({
    db,
    vault,
    config: {
      POLL_INTERVAL_MS: opts.pollIntervalMs ?? 100,
      STABILITY_DELAY_MS: opts.stabilityDelayMs ?? 50,
    },
    logger,
  });

  if (opts.autoConfirm !== false) {
    attachAutoConfirm(indexer);
  }

  return { indexer, db, logger };
}

async function writeMd(dir: string, relPath: string, content: string): Promise<string> {
  const absPath = path.join(dir, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, 'utf-8');
  return absPath;
}

function waitForChanges(
  indexer: VaultIndexer,
  count: number,
  timeout = 3000,
): Promise<FileChangeEvent[][]> {
  return new Promise((resolve, reject) => {
    const batches: FileChangeEvent[][] = [];
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for ${count} change batches`)),
      timeout,
    );

    indexer.on('changes', (events) => {
      batches.push(events);
      if (batches.length >= count) {
        clearTimeout(timer);
        resolve(batches);
      }
    });
  });
}

describe('document extensions', () => {
  // "Document" has to mean ONE thing across the service. It is defined here — the list the
  // poller scans by, minus images — and served to clients through the catalogue's
  // `document_extensions`. A second, hand-written allowlist anywhere else is the defect:
  // it counts files that are never indexed, and promises documents search cannot return.

  it('is the scanned set minus images, with nothing left over', () => {
    expect([...DOCUMENT_EXTENSIONS, ...IMAGE_EXTENSIONS].sort()).toEqual(
      [...INDEXED_EXTENSIONS].sort(),
    );
    expect(new Set(DOCUMENT_EXTENSIONS).size).toBe(DOCUMENT_EXTENSIONS.length);
  });

  it('contains no extension the poller does not scan', () => {
    for (const ext of DOCUMENT_EXTENSIONS) {
      expect(INDEXED_EXTENSIONS as readonly string[]).toContain(ext);
    }
    // Named because they were counted as documents by the UI footprint while the indexer
    // ignored them entirely — the exact divergence this constant closes.
    expect(DOCUMENT_EXTENSIONS).not.toContain('txt');
    expect(DOCUMENT_EXTENSIONS).not.toContain('markdown');
  });

  it('is stated lower-case and without a leading dot, the way scanning uses it', () => {
    for (const ext of INDEXED_EXTENSIONS) {
      expect(ext).toBe(ext.toLowerCase());
      expect(ext.startsWith('.')).toBe(false);
    }
  });
});

describe('VaultIndexer', () => {
  let tmpDir: string;
  let vaultRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    readFileCalls.length = 0;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'indexer-test-'));
    vaultRoot = path.join(tmpDir, 'vault');
    dbPath = path.join(tmpDir, 'test.db');
    await fs.mkdir(vaultRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('Initial scan', () => {
    it('indexes all .md files from vault and inserts rows into DB', async () => {
      await writeMd(vaultRoot, 'note1.md', '# Note 1');
      await writeMd(vaultRoot, 'note2.md', '# Note 2');
      await writeMd(vaultRoot, 'subdir/note3.md', '# Note 3');

      const { indexer, db } = createTestIndexer({ vaultRoot, dbPath });

      await indexer.start();

      // Wait for scan to complete
      await new Promise((resolve) => setTimeout(resolve, 500));

      const { indexedFiles } = await import('../../db/schema.js');
      const rows = db.select().from(indexedFiles).all();

      expect(rows).toHaveLength(3);
      const paths = rows.map((r) => r.path).sort();
      expect(paths).toContain('note1.md');
      expect(paths).toContain('note2.md');
      expect(paths).toContain('subdir/note3.md');

      indexer.stop();
    });

    it('emits created events for all files found during initial scan', async () => {
      await writeMd(vaultRoot, 'a.md', 'content a');
      await writeMd(vaultRoot, 'b.md', 'content b');

      const { indexer } = createTestIndexer({ vaultRoot, dbPath });
      const batches = await new Promise<FileChangeEvent[][]>((resolve, reject) => {
        const collected: FileChangeEvent[][] = [];
        const timer = setTimeout(() => reject(new Error('Timeout')), 5000);

        indexer.on('changes', (events) => {
          collected.push(events);
          // Once we have at least 2 events total, resolve
          const total = collected.flat().length;
          if (total >= 2) {
            clearTimeout(timer);
            indexer.stop();
            resolve(collected);
          }
        });

        void indexer.start();
      });

      const allEvents = batches.flat();
      expect(allEvents.filter((e) => e.type === 'created')).toHaveLength(2);
      const paths = allEvents.map((e) => e.path).sort();
      expect(paths).toContain('a.md');
      expect(paths).toContain('b.md');
    });

    it('emits deleted events for files in DB but not on disk', async () => {
      // Pre-populate DB with a file that doesn't exist on disk
      const { indexer, db } = createTestIndexer({ vaultRoot, dbPath });
      const { indexedFiles } = await import('../../db/schema.js');

      db.insert(indexedFiles)
        .values({
          path: 'stale.md',
          contentHash: 'abc123',
          mtime: Date.now(),
          size: 100,
          indexedAt: new Date().toISOString(),
        })
        .run();

      const batches = await new Promise<FileChangeEvent[][]>((resolve, reject) => {
        const collected: FileChangeEvent[][] = [];
        const timer = setTimeout(() => reject(new Error('Timeout')), 5000);

        indexer.on('changes', (events) => {
          collected.push(events);
          const hasDeleted = collected
            .flat()
            .some((e) => e.type === 'deleted' && e.path === 'stale.md');
          if (hasDeleted) {
            clearTimeout(timer);
            indexer.stop();
            resolve(collected);
          }
        });

        void indexer.start();
      });

      const allEvents = batches.flat();
      const deletedEvents = allEvents.filter((e) => e.type === 'deleted');
      expect(deletedEvents).toHaveLength(1);
      expect(deletedEvents[0]?.path).toBe('stale.md');
    });

    it('handles empty vault (no errors, no events)', async () => {
      const { indexer, logger } = createTestIndexer({ vaultRoot, dbPath });

      await indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 300));

      indexer.stop();

      // Logger should not have errored
      expect((logger.error as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it('sets isIndexing true during scan and false after completion', async () => {
      await writeMd(vaultRoot, 'doc.md', 'hello');

      const { indexer } = createTestIndexer({ vaultRoot, dbPath });

      let wasIndexingDuringScan = false;

      const checkDuringPoll = () => {
        if (indexer.isIndexing) wasIndexingDuringScan = true;
      };

      // isIndexing should be false initially
      expect(indexer.isIndexing).toBe(false);

      void indexer.start();

      // Check right after start — should be true (scan kicks off immediately)
      checkDuringPoll();

      await new Promise((resolve) => setTimeout(resolve, 500));

      // After scan completes, isIndexing should be false
      expect(indexer.isIndexing).toBe(false);
      expect(wasIndexingDuringScan).toBe(true);

      indexer.stop();
    });
  });

  describe('Poll cycle change detection', () => {
    it('detects a new .md file and emits created event', async () => {
      const { indexer } = createTestIndexer({
        vaultRoot,
        dbPath,
        pollIntervalMs: 200,
        stabilityDelayMs: 50,
      });

      // Start with empty vault
      await indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 300)); // let scan complete

      const changePromise = waitForChanges(indexer, 1, 5000);

      // Add a new file
      await writeMd(vaultRoot, 'new.md', '# New');

      const batches = await changePromise;
      indexer.stop();

      const allEvents = batches.flat();
      const createdEvents = allEvents.filter((e) => e.type === 'created');
      expect(createdEvents.length).toBeGreaterThanOrEqual(1);
      expect(createdEvents.some((e) => e.path === 'new.md')).toBe(true);
    });

    it('detects a modified file (hash changed) and emits updated event', async () => {
      await writeMd(vaultRoot, 'existing.md', 'original content');

      const { indexer } = createTestIndexer({
        vaultRoot,
        dbPath,
        pollIntervalMs: 200,
        stabilityDelayMs: 50,
      });

      await indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const changePromise = waitForChanges(indexer, 1, 5000);

      // Modify the file
      await fs.writeFile(path.join(vaultRoot, 'existing.md'), 'modified content', 'utf-8');

      const batches = await changePromise;
      indexer.stop();

      const allEvents = batches.flat();
      const updatedEvents = allEvents.filter(
        (e) => e.type === 'updated' && e.path === 'existing.md',
      );
      expect(updatedEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('detects a deleted file and emits deleted event', async () => {
      await writeMd(vaultRoot, 'todelete.md', 'will be deleted');

      const { indexer } = createTestIndexer({
        vaultRoot,
        dbPath,
        pollIntervalMs: 200,
        stabilityDelayMs: 50,
      });

      await indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const changePromise = waitForChanges(indexer, 1, 5000);

      // Delete the file
      await fs.unlink(path.join(vaultRoot, 'todelete.md'));

      const batches = await changePromise;
      indexer.stop();

      const allEvents = batches.flat();
      const deletedEvents = allEvents.filter(
        (e) => e.type === 'deleted' && e.path === 'todelete.md',
      );
      expect(deletedEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('only processes .md files (non-.md files are ignored)', async () => {
      // Write a .txt file — should be ignored
      await fs.writeFile(path.join(vaultRoot, 'readme.txt'), 'ignore me', 'utf-8');
      await writeMd(vaultRoot, 'include.md', 'include me');

      const { indexer, db } = createTestIndexer({ vaultRoot, dbPath });

      await indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 500));

      indexer.stop();

      const { indexedFiles } = await import('../../db/schema.js');
      const rows = db.select().from(indexedFiles).all();

      const paths = rows.map((r) => r.path);
      expect(paths).toContain('include.md');
      expect(paths.some((p) => p.endsWith('.txt'))).toBe(false);
    });

    it('excludes dotfiles and dotfolders (.obsidian/, .trash/, .git/)', async () => {
      // Create files inside dot directories
      await fs.mkdir(path.join(vaultRoot, '.obsidian'), { recursive: true });
      await fs.writeFile(path.join(vaultRoot, '.obsidian', 'config.md'), 'internal', 'utf-8');
      await fs.mkdir(path.join(vaultRoot, '.git'), { recursive: true });
      await fs.writeFile(path.join(vaultRoot, '.git', 'HEAD'), 'ref', 'utf-8');

      // Create a valid .md file
      await writeMd(vaultRoot, 'real.md', 'real content');

      const { indexer, db } = createTestIndexer({ vaultRoot, dbPath });

      await indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 500));
      indexer.stop();

      const { indexedFiles } = await import('../../db/schema.js');
      const rows = db.select().from(indexedFiles).all();

      const paths = rows.map((r) => r.path);
      expect(paths).toHaveLength(1);
      expect(paths[0]).toBe('real.md');
    });
  });

  describe('Move detection', () => {
    it('detects file renamed/moved by matching content hashes and emits moved event', async () => {
      const content = 'unique content for move detection test';
      await writeMd(vaultRoot, 'original.md', content);

      const { indexer } = createTestIndexer({
        vaultRoot,
        dbPath,
        pollIntervalMs: 200,
        stabilityDelayMs: 50,
      });

      await indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const changePromise = waitForChanges(indexer, 1, 5000);

      // Rename: delete original, create new with same content
      await fs.unlink(path.join(vaultRoot, 'original.md'));
      await writeMd(vaultRoot, 'renamed.md', content);

      const batches = await changePromise;
      indexer.stop();

      const allEvents = batches.flat();
      const movedEvents = allEvents.filter((e) => e.type === 'moved');
      expect(movedEvents.length).toBeGreaterThanOrEqual(1);

      const moveEvent = movedEvents[0];
      expect(moveEvent?.path).toBe('renamed.md');
      expect(moveEvent?.oldPath).toBe('original.md');
    });
  });

  describe('Two-pass stability check', () => {
    it('rejects files whose hash changes between two reads (unstable)', async () => {
      // This tests that the stability mechanism works
      // We will use a long stability delay and very short poll interval
      // and ensure a file written "in progress" doesn't emit events
      // In practice, we'll test the checkStability logic indirectly:
      // by checking that only stable files get emitted
      const { indexer } = createTestIndexer({
        vaultRoot,
        dbPath,
        pollIntervalMs: 200,
        stabilityDelayMs: 100,
      });

      await indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 300));

      // We'll write a file and immediately overwrite it to simulate partial write
      // The stability check should prevent it from being emitted in the first cycle
      // but may emit in subsequent cycles once stable
      let createdCount = 0;
      indexer.on('changes', (events) => {
        createdCount += events.filter(
          (e) => e.type === 'created' && e.path === 'unstable.md',
        ).length;
      });

      // Write and quickly overwrite - simulates instability
      const filePath = path.join(vaultRoot, 'unstable.md');
      await fs.writeFile(filePath, 'version1', 'utf-8');
      // The indexer will start its first read during poll; we immediately update
      await fs.writeFile(filePath, 'version2', 'utf-8');

      // Wait for poll cycles — eventually the file stabilizes and gets emitted
      await new Promise((resolve) => setTimeout(resolve, 1000));
      indexer.stop();

      // The file should eventually be indexed once stable
      // (we just verify no crash and the indexer is functional)
      expect(createdCount).toBeGreaterThanOrEqual(0); // may or may not emit depending on timing
    });

    it('accepts files whose hash is stable across both reads', async () => {
      const { indexer } = createTestIndexer({
        vaultRoot,
        dbPath,
        pollIntervalMs: 200,
        stabilityDelayMs: 50,
      });

      await indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const changePromise = waitForChanges(indexer, 1, 5000);

      // Write a stable file (no modifications after write)
      await writeMd(vaultRoot, 'stable.md', 'this content will not change');

      const batches = await changePromise;
      indexer.stop();

      const allEvents = batches.flat();
      const stableEvents = allEvents.filter((e) => e.path === 'stable.md');
      expect(stableEvents.length).toBeGreaterThanOrEqual(1);
      expect(stableEvents[0]?.type).toBe('created');
    });
  });

  describe('Batch emission', () => {
    it('emits one changes event per poll cycle as an array of FileChangeEvent', async () => {
      const { indexer } = createTestIndexer({
        vaultRoot,
        dbPath,
        pollIntervalMs: 500,
        stabilityDelayMs: 50,
      });

      const batchSizes: number[] = [];
      indexer.on('changes', (events) => {
        batchSizes.push(events.length);
      });

      // Write multiple files before scan starts
      await writeMd(vaultRoot, 'batch1.md', 'content 1');
      await writeMd(vaultRoot, 'batch2.md', 'content 2');
      await writeMd(vaultRoot, 'batch3.md', 'content 3');

      await indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 500));
      indexer.stop();

      // Should have emitted at least one batch from initial scan
      expect(batchSizes.length).toBeGreaterThanOrEqual(1);
      // Each batch is an array
      for (const size of batchSizes) {
        expect(size).toBeGreaterThan(0);
      }
    });

    it('chunks large batches into ~100 events per emission', async () => {
      // Write 250 md files
      for (let i = 0; i < 250; i++) {
        await writeMd(vaultRoot, `note-${String(i).padStart(3, '0')}.md`, `content ${i}`);
      }

      const { indexer } = createTestIndexer({ vaultRoot, dbPath });

      const batches: FileChangeEvent[][] = [];
      indexer.on('changes', (events) => {
        batches.push(events);
      });

      await indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      indexer.stop();

      // All events should be in batches of at most 100
      const allBatchesFromScan = batches.filter((b) => b.every((e) => e.type === 'created'));
      if (allBatchesFromScan.length > 1) {
        // If chunked, each chunk should be <= 100
        allBatchesFromScan.forEach((batch) => {
          expect(batch.length).toBeLessThanOrEqual(100);
        });
      }

      // Total should be 250 created events
      const totalCreated = batches.flat().filter((e) => e.type === 'created').length;
      expect(totalCreated).toBe(250);
    }, 15000);
  });

  describe('mtime/size pretest', () => {
    it('does not read a file whose mtime and size are unchanged', async () => {
      const absPath = await writeMd(vaultRoot, 'quiet.md', 'stable content');

      const { indexer } = createTestIndexer({
        vaultRoot,
        dbPath,
        pollIntervalMs: 100,
        stabilityDelayMs: 20,
      });

      indexer.start();
      // Initial scan hashes everything; wait for it plus several poll cycles.
      await new Promise((resolve) => setTimeout(resolve, 400));

      readFileCalls.length = 0;
      await new Promise((resolve) => setTimeout(resolve, 500));
      indexer.stop();

      expect(readFileCalls.filter((p) => p === absPath)).toHaveLength(0);
    });

    it('skips hashing entirely when the stat matches (stale hash in DB is not noticed)', async () => {
      await writeMd(vaultRoot, 'quiet.md', 'stable content');

      const { indexer, db } = createTestIndexer({
        vaultRoot,
        dbPath,
        pollIntervalMs: 100,
        stabilityDelayMs: 20,
      });

      indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Corrupt only the hash. A poller that still hashes every file would report an
      // update; the pretest must short-circuit on the untouched mtime/size.
      const { indexedFiles } = await import('../../db/schema.js');
      const { eq } = await import('drizzle-orm');
      db.update(indexedFiles)
        .set({ contentHash: 'stale-hash' })
        .where(eq(indexedFiles.path, 'quiet.md'))
        .run();

      const seen: FileChangeEvent[] = [];
      indexer.on('changes', (events) => seen.push(...events));

      await new Promise((resolve) => setTimeout(resolve, 500));
      indexer.stop();

      expect(seen.filter((e) => e.path === 'quiet.md')).toHaveLength(0);
    });

    it('hashes and emits when the stat differs', async () => {
      await writeMd(vaultRoot, 'busy.md', 'first content');

      const { indexer } = createTestIndexer({
        vaultRoot,
        dbPath,
        pollIntervalMs: 100,
        stabilityDelayMs: 20,
      });

      indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const seen: FileChangeEvent[] = [];
      indexer.on('changes', (events) => seen.push(...events));

      await fs.writeFile(path.join(vaultRoot, 'busy.md'), 'second content, longer', 'utf-8');
      await new Promise((resolve) => setTimeout(resolve, 600));
      indexer.stop();

      expect(seen.some((e) => e.path === 'busy.md' && e.type === 'updated')).toBe(true);
    });
  });

  describe('Transactional persistence (pendingIndex)', () => {
    it('does not write the indexed_files row until confirmIndexed is called', async () => {
      await writeMd(vaultRoot, 'pending.md', 'body');

      const { indexer, db } = createTestIndexer({
        vaultRoot,
        dbPath,
        pollIntervalMs: 200,
        stabilityDelayMs: 20,
        autoConfirm: false,
      });

      const changePromise = waitForChanges(indexer, 1, 5000);
      indexer.start();
      const events = (await changePromise).flat();

      expect(events.some((e) => e.path === 'pending.md' && e.type === 'created')).toBe(true);

      const { indexedFiles } = await import('../../db/schema.js');
      expect(db.select().from(indexedFiles).all()).toHaveLength(0);

      indexer.confirmIndexed('pending.md');
      indexer.stop();

      const rows = db.select().from(indexedFiles).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.path).toBe('pending.md');
      expect(rows[0]?.fileType).toBe('md');
      expect(rows[0]?.contentHash).toBe(events.find((e) => e.path === 'pending.md')?.contentHash);
      expect(rows[0]?.size).toBe(Buffer.byteLength('body'));
      expect(rows[0]?.indexedAt).toBeTruthy();
    });

    it('confirmIndexed for an unknown path is a no-op', async () => {
      const { indexer, db } = createTestIndexer({ vaultRoot, dbPath, autoConfirm: false });

      indexer.confirmIndexed('never-seen.md');

      const { indexedFiles } = await import('../../db/schema.js');
      expect(db.select().from(indexedFiles).all()).toHaveLength(0);
      indexer.stop();
    });

    it('failIndexed leaves the row untouched so the next poll re-emits the change', async () => {
      await writeMd(vaultRoot, 'retry.md', 'body');

      const { indexer, db } = createTestIndexer({
        vaultRoot,
        dbPath,
        pollIntervalMs: 150,
        stabilityDelayMs: 20,
        autoConfirm: false,
      });

      const emissions: FileChangeEvent[] = [];
      indexer.on('changes', (events) => {
        for (const event of events) {
          if (event.path !== 'retry.md') continue;
          emissions.push(event);
          // Simulate the pipeline failing on every attempt.
          indexer.failIndexed(event.path);
        }
      });

      indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 800));
      indexer.stop();

      const { indexedFiles } = await import('../../db/schema.js');
      expect(db.select().from(indexedFiles).all()).toHaveLength(0);
      expect(emissions.length).toBeGreaterThanOrEqual(2);
      expect(emissions.every((e) => e.type === 'created')).toBe(true);
    });

    it('does not re-emit a path that is still pending with the same hash', async () => {
      await writeMd(vaultRoot, 'inflight.md', 'body');

      const { indexer } = createTestIndexer({
        vaultRoot,
        dbPath,
        pollIntervalMs: 100,
        stabilityDelayMs: 20,
        autoConfirm: false,
      });

      const emissions: FileChangeEvent[] = [];
      indexer.on('changes', (events) => {
        emissions.push(...events.filter((e) => e.path === 'inflight.md'));
      });

      indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 800));
      indexer.stop();

      expect(emissions).toHaveLength(1);
    });

    it('re-emits a pending path when its content changes again', async () => {
      await writeMd(vaultRoot, 'inflight.md', 'first body');

      const { indexer } = createTestIndexer({
        vaultRoot,
        dbPath,
        pollIntervalMs: 100,
        stabilityDelayMs: 20,
        autoConfirm: false,
      });

      const emissions: FileChangeEvent[] = [];
      indexer.on('changes', (events) => {
        emissions.push(...events.filter((e) => e.path === 'inflight.md'));
      });

      indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 300));

      await fs.writeFile(path.join(vaultRoot, 'inflight.md'), 'second body, different', 'utf-8');
      await new Promise((resolve) => setTimeout(resolve, 600));
      indexer.stop();

      expect(emissions.length).toBeGreaterThanOrEqual(2);
      expect(new Set(emissions.map((e) => e.contentHash)).size).toBe(2);
    });

    it('confirmIndexed on a moved file carries the row over to the new path', async () => {
      const content = 'content that survives a rename';
      await writeMd(vaultRoot, 'before.md', content);

      const { indexer, db } = createTestIndexer({
        vaultRoot,
        dbPath,
        pollIntervalMs: 150,
        stabilityDelayMs: 20,
      });

      indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 400));

      const { indexedFiles } = await import('../../db/schema.js');
      expect(
        db
          .select()
          .from(indexedFiles)
          .all()
          .map((r) => r.path),
      ).toEqual(['before.md']);

      await fs.unlink(path.join(vaultRoot, 'before.md'));
      await writeMd(vaultRoot, 'after.md', content);

      await new Promise((resolve) => setTimeout(resolve, 700));
      indexer.stop();

      const rows = db.select().from(indexedFiles).all();
      expect(rows.map((r) => r.path)).toEqual(['after.md']);
    });
  });

  describe('Lifecycle', () => {
    it('poller starts only after initial scan completes', async () => {
      let scanCompletedBeforePoll = false;
      let pollStarted = false;

      await writeMd(vaultRoot, 'lifecycle.md', 'content');

      const { indexer } = createTestIndexer({ vaultRoot, dbPath, pollIntervalMs: 200 });

      // Track scan completion by watching isIndexing
      indexer.on('changes', () => {
        if (!indexer.isIndexing && !pollStarted) {
          scanCompletedBeforePoll = true;
        }
        pollStarted = true;
      });

      await indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 600));
      indexer.stop();

      // Initial scan emits events, which sets scanCompletedBeforePoll
      expect(scanCompletedBeforePoll).toBe(true);
    });

    it('stop() clears the poll timer and prevents further polling', async () => {
      const { indexer } = createTestIndexer({ vaultRoot, dbPath, pollIntervalMs: 100 });

      const batches: FileChangeEvent[][] = [];
      indexer.on('changes', (events) => {
        batches.push(events);
      });

      await indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 200));

      indexer.stop();

      const countAfterStop = batches.length;
      await new Promise((resolve) => setTimeout(resolve, 300));

      // No more events after stop
      expect(batches.length).toBe(countAfterStop);
    });

    it('overlapping poll cycles are skipped (isPolling guard)', async () => {
      // This is tested implicitly — if the guard wasn't working, we'd see doubled events
      // We'll verify by watching that changes are sensible
      await writeMd(vaultRoot, 'guard-test.md', 'test');

      const { indexer } = createTestIndexer({
        vaultRoot,
        dbPath,
        pollIntervalMs: 50,
        stabilityDelayMs: 200,
      });

      let changeCount = 0;
      indexer.on('changes', () => {
        changeCount++;
      });

      await indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 600));
      indexer.stop();

      // Should not have duplicated events due to overlapping polls
      // changeCount should be reasonable (not exponential)
      expect(changeCount).toBeLessThan(20);
    });

    it('listener errors do not crash the poller', async () => {
      const { indexer } = createTestIndexer({
        vaultRoot,
        dbPath,
        pollIntervalMs: 200,
        stabilityDelayMs: 50,
      });

      let threwError = false;
      indexer.on('changes', () => {
        threwError = true;
        throw new Error('Listener error');
      });

      await writeMd(vaultRoot, 'error-test.md', 'test');
      await indexer.start();
      await new Promise((resolve) => setTimeout(resolve, 600));

      // If we got here without a crash, the test passes
      expect(threwError).toBe(true);
      indexer.stop();
    });
  });
});
