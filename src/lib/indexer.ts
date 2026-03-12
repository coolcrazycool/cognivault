import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
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

// ── Event map for typed EventEmitter ──

interface IndexerEvents {
  changes: [events: FileChangeEvent[]];
}

const BATCH_SIZE = 100;
const LOG_PROGRESS_EVERY = 500;

const INDEXED_EXTENSIONS = [
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

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp']);

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

  constructor(opts: VaultIndexerOptions) {
    super();
    this.db = opts.db;
    this.vault = opts.vault;
    this.config = opts.config;
    this.logger = opts.logger;
    // Access vault's root path for building absolute paths
    this.vaultRoot = (opts.vault as unknown as { rootPath: string }).rootPath;
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
              const contentHash = await this.hashFile(absPath);

              fileStats.push({
                path: relPath,
                contentHash,
                mtime: stat.mtimeMs,
                size: stat.size,
              });

              const existing = dbMap.get(relPath);
              if (!existing) {
                events.push({ path: relPath, type: 'created', contentHash });
              } else if (existing.contentHash !== contentHash) {
                events.push({ path: relPath, type: 'updated', contentHash });
              }
              // Same hash — no event
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

      // Upsert all current files into DB
      if (fileStats.length > 0) {
        const now = new Date().toISOString();
        this.db
          .insert(indexedFiles)
          .values(
            fileStats.map((f) => ({
              path: f.path,
              contentHash: f.contentHash,
              mtime: f.mtime,
              size: f.size,
              indexedAt: now,
              fileType: fileTypeFromPath(f.path),
            })),
          )
          .onConflictDoUpdate({
            target: indexedFiles.path,
            set: {
              contentHash: indexedFiles.contentHash,
              mtime: indexedFiles.mtime,
              size: indexedFiles.size,
              indexedAt: indexedFiles.indexedAt,
              fileType: indexedFiles.fileType,
            },
          })
          .run();
      }

      // Delete stale rows
      for (const event of events) {
        if (event.type === 'deleted') {
          this.db.delete(indexedFiles).where(eq(indexedFiles.path, event.path)).run();
        }
      }

      const durationMs = Date.now() - scanStart;
      this.logger.info(
        `Initial scan complete: ${fileStats.length} files indexed in ${(durationMs / 1000).toFixed(1)}s`,
      );

      // Set isIndexing false before emitting so listeners can observe the final state
      this._isIndexing = false;

      // Emit events in chunks
      this.emitInChunks(events);
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

    // Hash existing files to detect updates (first pass)
    const existingHashResults = await Promise.all(
      existingPaths.map((relPath) =>
        limit(async () => {
          const absPath = this.abs(relPath);
          try {
            const contentHash = await this.hashFile(absPath);
            return { path: relPath, contentHash };
          } catch {
            return null;
          }
        }),
      ),
    );

    // Find modified files (candidates for stability check)
    const candidateUpdates: Array<{ path: string; firstHash: string }> = [];
    for (const result of existingHashResults) {
      if (!result) continue;
      const existing = dbMap.get(result.path);
      if (existing && existing.contentHash !== result.contentHash) {
        candidateUpdates.push({ path: result.path, firstHash: result.contentHash });
      }
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
              mtime: s.mtimeMs,
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
              mtime: s.mtimeMs,
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

    // Update DB: upsert created/updated (and moved destination)
    const now = new Date().toISOString();

    const toUpsert = [...stableCreated, ...stableUpdated];
    for (const item of toUpsert) {
      this.db
        .insert(indexedFiles)
        .values({
          path: item.path,
          contentHash: item.contentHash,
          mtime: item.mtime,
          size: item.size,
          indexedAt: now,
          fileType: fileTypeFromPath(item.path),
        })
        .onConflictDoUpdate({
          target: indexedFiles.path,
          set: {
            contentHash: indexedFiles.contentHash,
            mtime: indexedFiles.mtime,
            size: indexedFiles.size,
            indexedAt: indexedFiles.indexedAt,
            fileType: indexedFiles.fileType,
          },
        })
        .run();
    }

    // Delete removed and moved-from rows
    for (const row of deletedRows) {
      this.db.delete(indexedFiles).where(eq(indexedFiles.path, row.path)).run();
    }

    // Emit
    if (events.length > 0) {
      this.logger.info(`Poll detected ${events.length} changes`);
      for (const event of events) {
        this.logger.debug({ event }, 'File change');
      }
      this.emitInChunks(events);
    }
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

    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
