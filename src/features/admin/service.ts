import { randomUUID } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type * as schema from '../../db/schema.js';
import { indexedFiles } from '../../db/schema.js';
import type { TenantQdrantClient } from '../../lib/tenant-qdrant-client.js';

// ── Types ──

export interface ReindexJob {
  id: string;
  scope: 'full' | 'path' | 'folder';
  status: 'running' | 'completed' | 'failed';
  filesProcessed: number;
  totalFiles: number;
  errors: string[];
  startedAt: string;
  completedAt?: string;
}

export class ReindexService {
  private readonly fastify: FastifyInstance;
  private readonly jobs = new Map<string, ReindexJob>();

  constructor(fastify: FastifyInstance) {
    this.fastify = fastify;
  }

  async createJob(
    scope: 'full' | 'path' | 'folder',
    target: string | undefined,
    userDb: BetterSQLite3Database<typeof schema>,
    userQdrant: TenantQdrantClient,
    userId: string,
  ): Promise<ReindexJob> {
    if (scope === 'full') {
      return this.createFullJob(userQdrant, userId);
    } else if (scope === 'path') {
      return this.createPathJob(target ?? '', userDb, userId);
    } else {
      return this.createFolderJob(target ?? '', userDb, userId);
    }
  }

  private async createFullJob(userQdrant: TenantQdrantClient, userId: string): Promise<ReindexJob> {
    const indexerEntry = this.fastify.indexers.get(userId);
    if (indexerEntry?.indexer.isIndexing) {
      throw Object.assign(new Error('Reindex already in progress'), {
        code: 'REINDEX_IN_PROGRESS',
        statusCode: 409,
      });
    }

    const job: ReindexJob = {
      id: randomUUID(),
      scope: 'full',
      status: 'running',
      filesProcessed: 0,
      totalFiles: 0,
      errors: [],
      startedAt: new Date().toISOString(),
    };

    this.jobs.set(job.id, job);

    // Listen for 'changes' events to count files as they are dispatched for processing
    const onChanges = (events: import('../../lib/indexer.js').FileChangeEvent[]): void => {
      const processed = events.filter((e) => e.type !== 'deleted').length;
      job.filesProcessed += processed;
    };

    // Listen for scan completion to record totalFiles and mark job done
    const onScanComplete = async (filesScanned: number, _eventsEmitted: number): Promise<void> => {
      job.totalFiles = filesScanned;
      if (job.filesProcessed > filesScanned) {
        job.filesProcessed = filesScanned;
      }
      // Wait for all queued pipeline tasks to finish before marking completed
      const entry = this.fastify.indexers.get(userId);
      if (entry) {
        await entry.queue.onIdle();
      }
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      indexerEntry?.indexer.removeListener('changes', onChanges);
      indexerEntry?.indexer.removeListener('scanComplete', onScanComplete);
    };

    indexerEntry?.indexer.on('changes', onChanges);
    indexerEntry?.indexer.on('scanComplete', onScanComplete);

    // Clear all existing vectors for this user so stale data doesn't persist
    await userQdrant.delete({
      filter: { must: [{ key: 'chunk_index', range: { gte: 0 } }] },
    });

    // restart(true) clears DB so every file is treated as 'created' and re-embedded
    indexerEntry?.indexer.restart(true);

    return job;
  }

  private async createPathJob(
    filePath: string,
    userDb: BetterSQLite3Database<typeof schema>,
    userId: string,
  ): Promise<ReindexJob> {
    const job: ReindexJob = {
      id: randomUUID(),
      scope: 'path',
      status: 'running',
      filesProcessed: 0,
      totalFiles: 1,
      errors: [],
      startedAt: new Date().toISOString(),
    };

    this.jobs.set(job.id, job);

    try {
      const row = userDb.select().from(indexedFiles).where(eq(indexedFiles.path, filePath)).get();
      const contentHash = row?.contentHash ?? '';

      // Use processFileChanges to dispatch the synthetic event
      this.fastify.processFileChanges(userId, [
        {
          path: filePath,
          type: 'updated',
          contentHash,
        },
      ]);

      job.filesProcessed = 1;
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
    } catch (err: unknown) {
      job.status = 'failed';
      job.errors.push(err instanceof Error ? err.message : String(err));
      job.completedAt = new Date().toISOString();
    }

    return job;
  }

  private async createFolderJob(
    folderPrefix: string,
    userDb: BetterSQLite3Database<typeof schema>,
    userId: string,
  ): Promise<ReindexJob> {
    const job: ReindexJob = {
      id: randomUUID(),
      scope: 'folder',
      status: 'running',
      filesProcessed: 0,
      totalFiles: 0,
      errors: [],
      startedAt: new Date().toISOString(),
    };

    this.jobs.set(job.id, job);

    try {
      const files = userDb
        .select()
        .from(indexedFiles)
        .where(like(indexedFiles.path, `${folderPrefix}%`))
        .all();

      job.totalFiles = files.length;

      if (files.length > 0) {
        // Use processFileChanges to dispatch synthetic events
        this.fastify.processFileChanges(
          userId,
          files.map((f) => ({
            path: f.path,
            type: 'updated' as const,
            contentHash: f.contentHash,
          })),
        );
        job.filesProcessed = files.length;
      }

      job.status = 'completed';
      job.completedAt = new Date().toISOString();
    } catch (err: unknown) {
      job.status = 'failed';
      job.errors.push(err instanceof Error ? err.message : String(err));
      job.completedAt = new Date().toISOString();
    }

    return job;
  }

  getJob(id: string): ReindexJob | undefined {
    return this.jobs.get(id);
  }
}
