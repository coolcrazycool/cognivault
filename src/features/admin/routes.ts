import type { FastifyInstance } from 'fastify';
import type { ReindexRequestBody, ReindexStatusQuery } from './schemas.js';
import { reindexSchema, reindexStatusSchema } from './schemas.js';
import { ReindexService } from './service.js';

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  // Single shared service instance for this plugin scope (preserves in-memory job map)
  const service = new ReindexService(fastify);

  // POST /reindex — Trigger a full, path, or folder reindex operation
  fastify.post<{ Body: ReindexRequestBody }>(
    '/reindex',
    { schema: reindexSchema },
    async (request, reply) => {
      const body = request.body;

      let target: string | undefined;
      if (body.scope === 'path') {
        target = body.path;
      } else if (body.scope === 'folder') {
        target = body.folder;
      }

      try {
        const job = await service.createJob(
          body.scope,
          target,
          request.getUserDb(),
          request.getUserQdrant(),
        );

        return reply.status(202).send({
          jobId: job.id,
          status: job.status,
          message: 'Reindex started',
        });
      } catch (err: unknown) {
        const error = err as Error & { statusCode?: number; code?: string };
        if (error.statusCode === 409 || error.code === 'REINDEX_IN_PROGRESS') {
          return reply.status(409).send({
            error: {
              code: 'REINDEX_IN_PROGRESS',
              message: 'A full reindex is already in progress',
            },
          });
        }
        throw err;
      }
    },
  );

  // GET /reindex/status — Query job progress by job ID
  fastify.get<{ Querystring: ReindexStatusQuery }>(
    '/reindex/status',
    { schema: reindexStatusSchema },
    async (request, reply) => {
      const { jobId } = request.query;
      const job = service.getJob(jobId);

      if (!job) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `No reindex job found with id: ${jobId}`,
          },
        });
      }

      return reply.status(200).send({
        jobId: job.id,
        status: job.status,
        filesProcessed: job.filesProcessed,
        totalFiles: job.totalFiles,
        errors: job.errors,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
      });
    },
  );
}
