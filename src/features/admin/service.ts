import { randomUUID } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { indexedFiles } from '../../db/schema.js';

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

  async createJob(scope: 'full' | 'path' | 'folder', target?: string): Promise<ReindexJob> {
    if (scope === 'full') {
      return this.createFullJob();
    } else if (scope === 'path') {
      return this.createPathJob(target ?? '');
    } else {
      return this.createFolderJob(target ?? '');
    }
  }

  private async createFullJob(): Promise<ReindexJob> {
    if (this.fastify.indexer.isIndexing) {
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
      // Count all non-deleted events as "files processed" (created/updated/moved)
      const processed = events.filter((e) => e.type !== 'deleted').length;
      job.filesProcessed += processed;
    };

    // Listen for scan completion to record totalFiles and mark job done
    const onScanComplete = async (filesScanned: number, _eventsEmitted: number): Promise<void> => {
      job.totalFiles = filesScanned;
      // Ensure filesProcessed doesn't exceed totalFiles (images are excluded from Qdrant but counted)
      if (job.filesProcessed > filesScanned) {
        job.filesProcessed = filesScanned;
      }
      // Wait for all queued pipeline tasks to finish before marking completed
      await this.fastify.pipelineQueue.onIdle();
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      this.fastify.indexer.removeListener('changes', onChanges);
      this.fastify.indexer.removeListener('scanComplete', onScanComplete);
    };

    this.fastify.indexer.on('changes', onChanges);
    this.fastify.indexer.on('scanComplete', onScanComplete);

    // Clear all existing vectors so stale data doesn't persist
    await this.fastify.qdrant.delete('cognivault', {
      filter: { must: [{ key: 'chunk_index', range: { gte: 0 } }] },
    });

    // restart(true) clears DB so every file is treated as 'created' and re-embedded
    this.fastify.indexer.restart(true);

    return job;
  }

  private async createPathJob(filePath: string): Promise<ReindexJob> {
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
      // Look up the real contentHash from indexed_files (fall back to '' if not found)
      const row = this.fastify.db
        .select()
        .from(indexedFiles)
        .where(eq(indexedFiles.path, filePath))
        .get();

      const contentHash = row?.contentHash ?? '';

      // Emit a synthetic updated event for the specific file
      // The indexer (and pipeline) will handle re-processing
      this.fastify.indexer.emit('changes', [
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

  private async createFolderJob(folderPrefix: string): Promise<ReindexJob> {
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
      // Query DB for all files matching the folder prefix
      const files = this.fastify.db
        .select()
        .from(indexedFiles)
        .where(like(indexedFiles.path, `${folderPrefix}%`))
        .all();

      job.totalFiles = files.length;

      if (files.length > 0) {
        // Emit batch of synthetic updated events for all files in the folder
        this.fastify.indexer.emit(
          'changes',
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
