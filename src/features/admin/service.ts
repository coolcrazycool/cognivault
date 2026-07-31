import { randomUUID } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type * as schema from '../../db/schema.js';
import { indexedFiles } from '../../db/schema.js';
import type { TenantQdrantClient } from '../../lib/tenant-qdrant-client.js';
import type { FileFailedEvent } from '../../plugins/pipeline-events.js';

// ── Types ──

export interface ReindexJob {
  id: string;
  scope: 'full' | 'path' | 'folder';
  status: 'running' | 'completed' | 'completed_with_errors' | 'failed';
  filesProcessed: number;
  totalFiles: number;
  errors: string[];
  /** Total number of failures observed, including those beyond MAX_JOB_ERRORS. */
  errorCount: number;
  startedAt: string;
  completedAt?: string;
}

/** Cap on retained error strings per job — beyond this only errorCount grows. */
const MAX_JOB_ERRORS = 100;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Record a job failure, keeping the retained list bounded. */
function recordJobError(job: ReindexJob, message: string): void {
  job.errorCount += 1;
  if (job.errors.length < MAX_JOB_ERRORS) {
    job.errors.push(message);
  }
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
      errorCount: 0,
      startedAt: new Date().toISOString(),
    };

    this.jobs.set(job.id, job);

    // Listen for 'changes' events to count files as they are dispatched for processing
    const onChanges = (events: import('../../lib/indexer.js').FileChangeEvent[]): void => {
      const processed = events.filter((e) => e.type !== 'deleted').length;
      job.filesProcessed += processed;
    };

    // Per-file pipeline failures are what make a job "completed with errors" instead of
    // silently reporting success — only this user's failures count towards this job.
    const pipelineEvents = this.fastify.pipelineEvents;
    const onFileFailed = (event: FileFailedEvent): void => {
      if (event.userId !== userId) {
        return;
      }
      recordJobError(job, `${event.path}: ${event.error}`);
    };

    // Listen for scan completion to record totalFiles and mark job done
    const onScanComplete = async (filesScanned: number, _eventsEmitted: number): Promise<void> => {
      try {
        job.totalFiles = filesScanned;
        if (job.filesProcessed > filesScanned) {
          job.filesProcessed = filesScanned;
        }
        // Wait for all queued pipeline tasks to finish before marking completed
        const entry = this.fastify.indexers.get(userId);
        if (entry) {
          await entry.queue.onIdle();
        }
        job.status = job.errorCount > 0 ? 'completed_with_errors' : 'completed';
      } catch (err: unknown) {
        recordJobError(job, errorMessage(err));
        job.status = 'failed';
      } finally {
        job.completedAt = new Date().toISOString();
        detachListeners();
      }
    };

    function detachListeners(): void {
      pipelineEvents.removeListener('file-failed', onFileFailed);
      indexerEntry?.indexer.removeListener('changes', onChanges);
      indexerEntry?.indexer.removeListener('scanComplete', onScanComplete);
    }

    indexerEntry?.indexer.on('changes', onChanges);
    indexerEntry?.indexer.on('scanComplete', onScanComplete);
    pipelineEvents.on('file-failed', onFileFailed);

    // Clear all existing vectors for this user so stale data doesn't persist.
    // A failed purge must terminate the job — otherwise it hangs in 'running' forever.
    try {
      await userQdrant.delete({
        filter: { must: [{ key: 'chunk_index', range: { gte: 0 } }] },
      });
    } catch (err: unknown) {
      detachListeners();
      recordJobError(job, `Failed to purge existing vectors: ${errorMessage(err)}`);
      job.status = 'failed';
      job.completedAt = new Date().toISOString();
      throw err;
    }

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
      errorCount: 0,
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
      recordJobError(job, errorMessage(err));
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
      errorCount: 0,
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
      recordJobError(job, errorMessage(err));
      job.completedAt = new Date().toISOString();
    }

    return job;
  }

  getJob(id: string): ReindexJob | undefined {
    return this.jobs.get(id);
  }
}
