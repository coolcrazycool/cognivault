import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

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

    // Stop current indexer and restart for a full reindex
    this.fastify.indexer.stop();
    this.fastify.indexer.start();

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
      // Emit a synthetic updated event for the specific file
      // The indexer (and pipeline) will handle re-processing
      this.fastify.indexer.emit('changes', [
        {
          path: filePath,
          type: 'updated',
          contentHash: '',
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
      const { indexedFiles } = await import('../../db/schema.js');
      const { like } = await import('drizzle-orm');

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
