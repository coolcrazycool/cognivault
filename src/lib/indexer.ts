import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import pLimit from 'p-limit';
import type * as schema from '../db/schema.js';
import { indexedFiles } from '../db/schema.js';
import type { VaultManager } from './vault.js';

// ── Types ──

export interface FileChangeEvent {
  path: string;
  type: 'created' | 'updated' | 'deleted' | 'moved';
  contentHash: string;
  oldPath?: string;
}

interface VaultIndexerConfig {
  POLL_INTERVAL_MS: number;
  STABILITY_DELAY_MS: number;
}

interface VaultIndexerOptions {
  db: BetterSQLite3Database<typeof schema>;
  vault: VaultManager;
  config: VaultIndexerConfig;
  logger: FastifyBaseLogger;
}

interface FileStat {
  path: string;
  contentHash: string;
  mtime: number;
  size: number;
}

/**
 * A file handed to the pipeline whose indexed_files row has NOT been written yet.
 * The row is persisted only once the pipeline reports success via confirmIndexed(),
 * so a crash/failure mid-pipeline leaves the old hash in place and the next poll
 * honestly re-detects the change.
 */
interface PendingIndexEntry {
  contentHash: string;
  mtime: number;
  size: number;
  /** Set for 'moved' events: the row to carry over and delete on confirmation. */
  movedFrom?: string;
}

// ── Event map for typed EventEmitter ──

interface IndexerEvents {
  changes: [events: FileChangeEvent[]];
  scanComplete: [filesScanned: number, eventsEmitted: number];
}

const BATCH_SIZE = 100;
const LOG_PROGRESS_EVERY = 500;

/**
 * Every extension the poller picks up. A file whose extension is absent here is never
 * scanned, never chunked and never embedded — search cannot return it under any
 * configuration.
 */
export const INDEXED_EXTENSIONS = [
  'md',
  'pdf',
  'canvas',
  'excalidraw',
  'csv',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'bmp',
] as const;

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'] as const;

/**
 * THE definition of "document" for this service: indexed, and not an image.
 *
 * Derived, never written out by hand. Anything that counts documents — the catalogue,
 * and the UI's corpus footprint through it — must read this list rather than keep its
 * own allowlist. Two hand-maintained lists is how a `.txt` file ends up counted in a
 * footprint that promises documents search can never return; a footprint that lies about
 * scale is the same defect as an answer that lies about content, moved one screen over.
 */
export const DOCUMENT_EXTENSIONS: readonly string[] = INDEXED_EXTENSIONS.filter(
  (ext) => !(IMAGE_EXTENSIONS as readonly string[]).includes(ext),
);

const IMAGE_EXTS = new Set(IMAGE_EXTENSIONS.map((ext) => `.${ext}`));

/**
 * indexed_files.mtime is an INTEGER column; fs.stat gives fractional milliseconds.
 * Truncating on both write and compare keeps the mtime pretest an exact match
 * instead of a float round-trip lottery.
 */
function normalizeMtime(mtimeMs: number): number {
  return Math.floor(mtimeMs);
}

function fileTypeFromPath(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').at(-1) ?? '';
  if (IMAGE_EXTS.has(`.${ext}`)) return 'image';
  switch (ext) {
    case 'md':
      return 'md';
    case 'pdf':
      return 'pdf';
    case 'csv':
      return 'csv';
    case 'canvas':
      return 'canvas';
    case 'excalidraw':
      return 'excalidraw';
    default:
      return 'md';
  }
}

// ── VaultIndexer ──

export class VaultIndexer extends EventEmitter<IndexerEvents> {
  private readonly db: BetterSQLite3Database<typeof schema>;
  private readonly vault: VaultManager;
  private readonly config: VaultIndexerConfig;
  private readonly logger: FastifyBaseLogger;
  private readonly vaultRoot: string;

  private _isIndexing = false;
  private running = true;
  private _isPolling = false;
  private pollTimer: NodeJS.Timeout | null = null;
  /** path -> stat snapshot handed to the pipeline but not yet confirmed as indexed. */
  private readonly pendingIndex = new Map<string, PendingIndexEntry>();

  constructor(opts: VaultIndexerOptions) {
    super();
    this.db = opts.db;
    this.vault = opts.vault;
    this.config = opts.config;
    this.logger = opts.logger;
    // Access vault's root path for building absolute paths
    this.vaultRoot = opts.vault.vaultRootPath;
  }

  get isIndexing(): boolean {
    return this._isIndexing;
  }

  // ── Private: File hashing ──

  private async hashFile(absolutePath: string): Promise<string> {
    const buf = await fs.readFile(absolutePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  // ── Private: Vault scanning ──

  private async scanVault(): Promise<string[]> {
    const pathSet = new Set<string>();
    for (const ext of INDEXED_EXTENSIONS) {
      const { entries } = await this.vault.listFiles({ recursive: true, ext });
      for (const e of entries) {
        if (e.type === 'file') {
          pathSet.add(e.path);
        }
      }
    }
    return Array.from(pathSet);
  }

  // ── Private: Absolute path helper ──

  private abs(relativePath: string): string {
    return path.join(this.vaultRoot, relativePath);
  }

  // ── Public: Start ──

  start(): void {
    this._isIndexing = true;
    void this.runInitialScan().catch((err: unknown) => {
      this.logger.error(err, 'Initial scan failed');
      this._isIndexing = false;
    });
  }

  // ── Public: Restart (stop + reset running flag + start) ──
  // When force=true, clears indexed_files so every file is treated as 'created'.

  restart(force = false): void {
    this.stop();
    this.pendingIndex.clear();
    if (force) {
      this.db.delete(indexedFiles).run();
      this.logger.info('Cleared indexed_files table for forced reindex');
    }
    this.running = true;
    this.start();
  }

  // ── Private: Initial scan ──

  private async runInitialScan(): Promise<void> {
    const scanStart = Date.now();
    this.logger.info('Starting initial vault scan');

    try {
      const relativePaths = await this.scanVault();
      const dbRows = this.db.select().from(indexedFiles).all();

      // Build lookup map from DB
      const dbMap = new Map(dbRows.map((row) => [row.path, row]));

      // Process files in parallel with concurrency limit
      const limit = pLimit(20);
      const fileStats: FileStat[] = [];
      const events: FileChangeEvent[] = [];

      let processed = 0;

      await Promise.all(
        relativePaths.map((relPath) =>
          limit(async () => {
            const absPath = this.abs(relPath);
            try {
              const stat = await fs.stat(absPath);
              const mtime = normalizeMtime(stat.mtimeMs);
              const contentHash = await this.hashFile(absPath);

              fileStats.push({
                path: relPath,
                contentHash,
                mtime,
                size: stat.size,
              });

              const existing = dbMap.get(relPath);
              if (!existing) {
                events.push({ path: relPath, type: 'created', contentHash });
              } else if (existing.contentHash !== contentHash) {
                events.push({ path: relPath, type: 'updated', contentHash });
              } else if (existing.mtime !== mtime || existing.size !== stat.size) {
                // Content identical, only the stat drifted (touch, restore, legacy
                // fractional mtime). Refresh the columns so the poller's mtime/size
                // pretest can skip this file without re-hashing it forever.
                this.refreshStat(relPath, mtime, stat.size);
              }
              // Same hash and same stat — nothing to do
            } catch (err: unknown) {
              this.logger.warn({ path: relPath, err }, 'Failed to stat/hash file during scan');
            }

            processed++;
            if (processed % LOG_PROGRESS_EVERY === 0) {
              this.logger.info(`Scan progress: ${processed}/${relativePaths.length} files`);
            }
          }),
        ),
      );

      // Files in DB but not on filesystem -> deleted
      const fsPathSet = new Set(relativePaths);
      for (const dbRow of dbRows) {
        if (!fsPathSet.has(dbRow.path)) {
          events.push({ path: dbRow.path, type: 'deleted', contentHash: dbRow.contentHash });
        }
      }

      // NOTE: indexed_files rows for created/updated files are deliberately NOT written
      // here. They are persisted by confirmIndexed() once the pipeline has actually
      // embedded and upserted the file — otherwise a pipeline failure would leave the
      // new hash on record and the file would never be retried.

      // Delete stale rows
      for (const event of events) {
        if (event.type === 'deleted') {
          this.db.delete(indexedFiles).where(eq(indexedFiles.path, event.path)).run();
        }
      }

      const durationMs = Date.now() - scanStart;
      this.logger.info(
        `Initial scan complete: ${fileStats.length} files scanned in ${(durationMs / 1000).toFixed(1)}s`,
      );

      // Set isIndexing false before emitting so listeners can observe the final state
      this._isIndexing = false;

      // Track everything handed to the pipeline, then emit events in chunks
      const emitted = this.registerPending(events, new Map(fileStats.map((f) => [f.path, f])));
      this.emitInChunks(emitted);

      // Notify listeners that the scan is complete (filesScanned, eventsEmitted)
      this.emit('scanComplete', fileStats.length, emitted.length);
    } catch (err: unknown) {
      this._isIndexing = false;
      throw err;
    } finally {
      if (this.running) {
        this.schedulePoll();
      }
    }
  }

  // ── Private: Emit events in batches of BATCH_SIZE ──

  private emitInChunks(events: FileChangeEvent[]): void {
    if (events.length === 0) return;

    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const chunk = events.slice(i, i + BATCH_SIZE);
      try {
        this.emit('changes', chunk);
      } catch (err: unknown) {
        this.logger.error(err, 'Error in changes event listener');
      }
    }
  }

  // ── Private: Poll scheduling ──

  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => {
      void this.runPollCycle();
    }, this.config.POLL_INTERVAL_MS);
  }

  private async runPollCycle(): Promise<void> {
    if (this._isPolling) {
      this.logger.warn('Poll cycle skipped: previous cycle still running');
      if (this.running) this.schedulePoll();
      return;
    }

    this._isPolling = true;

    try {
      await this.detectChanges();
    } catch (err: unknown) {
      this.logger.error(err, 'Poll cycle error');
    } finally {
      this._isPolling = false;
      if (this.running) {
        this.schedulePoll();
      }
    }
  }

  // ── Private: Change detection ──

  private async detectChanges(): Promise<void> {
    const relativePaths = await this.scanVault();
    const dbRows = this.db.select().from(indexedFiles).all();

    const dbMap = new Map(dbRows.map((row) => [row.path, row]));
    const fsPathSet = new Set(relativePaths);

    // Categorize
    const deletedRows = dbRows.filter((r) => !fsPathSet.has(r.path));
    const createdPaths = relativePaths.filter((p) => !dbMap.has(p));
    const existingPaths = relativePaths.filter((p) => dbMap.has(p));

    const limit = pLimit(20);

    // Existing files: cheap mtime/size pretest first — only files whose stat differs
    // from the recorded one are read and hashed. On a quiet vault this turns the poll
    // cycle from "sha256 every file every 5s" into a stat-only sweep.
    const existingHashResults = await Promise.all(
      existingPaths.map((relPath) =>
        limit(async () => {
          const row = dbMap.get(relPath);
          if (!row) return null;
          const absPath = this.abs(relPath);
          try {
            const stat = await fs.stat(absPath);
            const mtime = normalizeMtime(stat.mtimeMs);
            if (mtime === row.mtime && stat.size === row.size) {
              return null; // unchanged — do not read the file at all
            }

            const contentHash = await this.hashFile(absPath);
            if (contentHash === row.contentHash) {
              // Stat drifted but the bytes did not — refresh the stat columns so the
              // pretest catches this file next cycle instead of re-hashing forever.
              this.refreshStat(relPath, mtime, stat.size);
              return null;
            }
            return { path: relPath, contentHash };
          } catch {
            return null;
          }
        }),
      ),
    );

    // Modified files (candidates for the stability check)
    const candidateUpdates: Array<{ path: string; firstHash: string }> = [];
    for (const result of existingHashResults) {
      if (!result) continue;
      candidateUpdates.push({ path: result.path, firstHash: result.contentHash });
    }

    // Hash created files (first pass)
    const createdFirstHashes = await Promise.all(
      createdPaths.map((relPath) =>
        limit(async () => {
          const absPath = this.abs(relPath);
          try {
            const contentHash = await this.hashFile(absPath);
            return { path: relPath, firstHash: contentHash };
          } catch {
            return null;
          }
        }),
      ),
    );

    // Stability check for created files (parallel)
    const stableCreated: Array<{ path: string; contentHash: string; mtime: number; size: number }> =
      [];
    await Promise.all(
      createdFirstHashes.map(async (item) => {
        if (!item) return;
        const stableHash = await this.checkStability(this.abs(item.path), item.firstHash);
        if (stableHash !== null) {
          try {
            const s = await fs.stat(this.abs(item.path));
            stableCreated.push({
              path: item.path,
              contentHash: stableHash,
              mtime: normalizeMtime(s.mtimeMs),
              size: s.size,
            });
          } catch {
            // File gone during stability check — skip
          }
        }
      }),
    );

    // Stability check for updated files (parallel)
    const stableUpdated: Array<{ path: string; contentHash: string; mtime: number; size: number }> =
      [];
    await Promise.all(
      candidateUpdates.map(async (item) => {
        const stableHash = await this.checkStability(this.abs(item.path), item.firstHash);
        if (stableHash !== null) {
          try {
            const s = await fs.stat(this.abs(item.path));
            stableUpdated.push({
              path: item.path,
              contentHash: stableHash,
              mtime: normalizeMtime(s.mtimeMs),
              size: s.size,
            });
          } catch {
            // File gone during stability check — skip
          }
        }
      }),
    );

    // Move detection: match stable created files against deleted files by content hash
    const deletedHashMap = new Map<string, string>(); // contentHash -> deletedPath
    for (const row of deletedRows) {
      deletedHashMap.set(row.contentHash, row.path);
    }

    const events: FileChangeEvent[] = [];
    const movedFromPaths = new Set<string>();
    const movedToPaths = new Set<string>();

    for (const created of stableCreated) {
      const movedFrom = deletedHashMap.get(created.contentHash);
      if (movedFrom) {
        events.push({
          path: created.path,
          type: 'moved',
          contentHash: created.contentHash,
          oldPath: movedFrom,
        });
        movedFromPaths.add(movedFrom);
        movedToPaths.add(created.path);
      }
    }

    // Remaining deletes (not matched as moves)
    for (const row of deletedRows) {
      if (!movedFromPaths.has(row.path)) {
        events.push({ path: row.path, type: 'deleted', contentHash: row.contentHash });
      }
    }

    // Remaining creates (not matched as moves)
    for (const created of stableCreated) {
      if (!movedToPaths.has(created.path)) {
        events.push({ path: created.path, type: 'created', contentHash: created.contentHash });
      }
    }

    // Updates
    for (const updated of stableUpdated) {
      events.push({ path: updated.path, type: 'updated', contentHash: updated.contentHash });
    }

    // NOTE: created/updated/moved rows are NOT written here. confirmIndexed() persists
    // them after the pipeline has actually indexed the file (see registerPending).

    // Delete rows of genuinely removed files. Move sources are left in place so
    // confirmIndexed() can carry the row over to the new path transactionally; if the
    // move never gets indexed, the next poll re-detects it from the untouched rows.
    for (const row of deletedRows) {
      if (movedFromPaths.has(row.path)) continue;
      this.db.delete(indexedFiles).where(eq(indexedFiles.path, row.path)).run();
    }

    // Emit (dropping paths already queued with the same content hash)
    const statByPath = new Map<string, { mtime: number; size: number }>();
    for (const item of [...stableCreated, ...stableUpdated]) {
      statByPath.set(item.path, item);
    }

    const emitted = this.registerPending(events, statByPath);

    if (emitted.length > 0) {
      this.logger.info(`Poll detected ${emitted.length} changes`);
      for (const event of emitted) {
        this.logger.debug({ event }, 'File change');
      }
      this.emitInChunks(emitted);
    }
  }

  // ── Private: Pending-index bookkeeping ──

  /**
   * Record every created/updated/moved event as pending and drop re-emissions of paths
   * already queued with the same content hash (the pipeline can take much longer than
   * one poll interval; without this the queue fills with duplicates every 5s).
   */
  private registerPending(
    events: FileChangeEvent[],
    stats: Map<string, { mtime: number; size: number }>,
  ): FileChangeEvent[] {
    const emitted: FileChangeEvent[] = [];

    for (const event of events) {
      if (event.type === 'deleted') {
        this.pendingIndex.delete(event.path);
        emitted.push(event);
        continue;
      }

      const pending = this.pendingIndex.get(event.path);
      if (pending && pending.contentHash === event.contentHash) {
        this.logger.debug(
          { path: event.path },
          'Already queued for indexing with the same hash — not re-emitting',
        );
        continue;
      }

      const stat = stats.get(event.path);
      if (!stat) {
        this.logger.warn({ path: event.path }, 'No stat snapshot for change event — skipping');
        continue;
      }

      this.pendingIndex.set(event.path, {
        contentHash: event.contentHash,
        mtime: stat.mtime,
        size: stat.size,
        movedFrom: event.type === 'moved' ? event.oldPath : undefined,
      });
      emitted.push(event);
    }

    return emitted;
  }

  /** Update only the stat columns of an existing row (content is known unchanged). */
  private refreshStat(filePath: string, mtime: number, size: number): void {
    try {
      this.db
        .update(indexedFiles)
        .set({ mtime, size })
        .where(eq(indexedFiles.path, filePath))
        .run();
    } catch (err: unknown) {
      this.logger.debug({ path: filePath, err }, 'Failed to refresh stat columns');
    }
  }

  // ── Public: Indexing outcome callbacks (called by the pipeline) ──

  /**
   * Persist the indexed_files row for a file the pipeline has successfully indexed.
   * No-op if the path is not pending (duplicate confirmation, or an event that was
   * queued before a restart).
   */
  confirmIndexed(filePath: string): void {
    const pending = this.pendingIndex.get(filePath);
    if (!pending) {
      this.logger.debug({ path: filePath }, 'confirmIndexed for a path that is not pending');
      return;
    }
    this.pendingIndex.delete(filePath);

    const row = {
      path: filePath,
      contentHash: pending.contentHash,
      mtime: pending.mtime,
      size: pending.size,
      indexedAt: new Date().toISOString(),
      fileType: fileTypeFromPath(filePath),
    };

    // Use the incoming row's values (excluded.*), NOT the existing column —
    // self-assignment never persists the new hash, so the poll keeps seeing the
    // file as "updated" and re-embeds it on every cycle (the embedding-cost leak).
    const conflictUpdate = {
      target: indexedFiles.path,
      set: {
        contentHash: sql`excluded.content_hash`,
        mtime: sql`excluded.mtime`,
        size: sql`excluded.size`,
        indexedAt: sql`excluded.indexed_at`,
        fileType: sql`excluded.file_type`,
      },
    } as const;

    try {
      const movedFrom = pending.movedFrom;
      if (movedFrom === undefined) {
        this.db.insert(indexedFiles).values(row).onConflictDoUpdate(conflictUpdate).run();
        return;
      }

      // Move: carry the old row's derived columns over to the new path, then drop it.
      this.db.transaction((tx) => {
        const oldRow = tx.select().from(indexedFiles).where(eq(indexedFiles.path, movedFrom)).get();

        tx.insert(indexedFiles)
          .values({
            ...row,
            embeddingModelVersion: oldRow?.embeddingModelVersion ?? null,
            linkedNotes: oldRow?.linkedNotes ?? null,
          })
          .onConflictDoUpdate(conflictUpdate)
          .run();

        tx.delete(indexedFiles).where(eq(indexedFiles.path, movedFrom)).run();
      });
    } catch (err: unknown) {
      this.logger.error({ path: filePath, err }, 'Failed to persist indexed_files row');
    }
  }

  /**
   * Forget a pending file after a failed indexing attempt. The DB row is left
   * untouched on purpose: it still holds the *old* hash, so the next poll sees a real
   * difference and re-emits the change instead of silently skipping the file forever.
   */
  failIndexed(filePath: string): void {
    this.pendingIndex.delete(filePath);
  }

  // ── Private: Two-pass stability check ──

  private async checkStability(absolutePath: string, firstHash: string): Promise<string | null> {
    await new Promise<void>((resolve) => setTimeout(resolve, this.config.STABILITY_DELAY_MS));

    try {
      const secondHash = await this.hashFile(absolutePath);
      if (secondHash === firstHash) {
        return secondHash;
      }
      this.logger.debug({ path: absolutePath }, 'File unstable — skipping this cycle');
      return null;
    } catch {
      // File gone during stability check
      return null;
    }
  }

  // ── Public: Stop ──

  stop(): void {
    this.running = false;
    // In-flight pipeline work is abandoned; a late confirmIndexed() must not write a
    // row for a file nobody is indexing any more.
    this.pendingIndex.clear();

    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
