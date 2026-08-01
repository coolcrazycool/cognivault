import type { FastifyInstance } from 'fastify';
import { createAdminInterlock } from './interlock.js';
import { CollectionRebuildService } from './rebuild-service.js';
import type {
  RebuildRequestBody,
  RebuildStatusQuery,
  ReindexRequestBody,
  ReindexStatusQuery,
} from './schemas.js';
import {
  collectionInfoSchema,
  rebuildSchema,
  rebuildStatusSchema,
  reindexSchema,
  reindexStatusSchema,
} from './schemas.js';
import { ReindexService } from './service.js';

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  // Single shared service instance for this plugin scope (preserves in-memory job map).
  // The interlock is shared too — it is the only thing that keeps a per-user reindex and
  // a collection rebuild from running over each other.
  const interlock = createAdminInterlock();
  const service = new ReindexService(fastify, interlock);
  const rebuildService = new CollectionRebuildService(fastify, interlock);

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
          request.user!.userId,
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
              // The service distinguishes "your own reindex is running" from "a
              // collection rebuild owns the corpus" — pass that through verbatim.
              message: error.message || 'A full reindex is already in progress',
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
        errorCount: job.errorCount,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
      });
    },
  );

  // GET /collection — What a rebuild would destroy.
  //
  // Its own route rather than a field on /ready or /health: those two skip auth so the
  // kubelet can reach them, and the physical collection name is both the thing an
  // operator must type to destroy every tenant's vectors and a detail of the vector
  // database's layout. It belongs behind the same token as the rebuild it feeds.
  fastify.get('/collection', { schema: collectionInfoSchema }, async (_request, reply) => {
    const info = await fastify.qdrantAdmin.describe();
    return reply.status(200).send(info);
  });

  // POST /collection/rebuild — Drop, re-create and re-index the whole collection.
  fastify.post<{ Body: RebuildRequestBody }>(
    '/collection/rebuild',
    { schema: rebuildSchema },
    async (request, reply) => {
      try {
        const job = rebuildService.start(request.body.confirm);

        fastify.log.warn(
          { jobId: job.id, collection: job.collection, requestedBy: request.user?.userId },
          'Collection rebuild accepted — dropping the collection of ALL users',
        );

        return reply.status(202).send({
          jobId: job.id,
          status: job.status,
          message:
            `Rebuilding "${job.collection}": dropping it, re-creating it at BM25 scheme ` +
            `v${job.schemeVersion} and re-indexing ${job.usersTotal} user(s). Search ` +
            'returns nothing until this finishes.',
        });
      } catch (err: unknown) {
        const error = err as Error & { statusCode?: number; code?: string };
        if (error.statusCode === 400 || error.statusCode === 409) {
          return reply.status(error.statusCode).send({
            error: { code: error.code ?? 'BAD_REQUEST', message: error.message },
          });
        }
        throw err;
      }
    },
  );

  // GET /collection/rebuild/status — Progress of a rebuild job.
  fastify.get<{ Querystring: RebuildStatusQuery }>(
    '/collection/rebuild/status',
    { schema: rebuildStatusSchema },
    async (request, reply) => {
      const { jobId } = request.query;
      const job = rebuildService.getJob(jobId);

      if (!job) {
        return reply.status(404).send({
          error: {
            code: 'JOB_NOT_FOUND',
            message: `No rebuild job found with id: ${jobId}`,
          },
        });
      }

      return reply.status(200).send({
        jobId: job.id,
        status: job.status,
        phase: job.phase,
        collection: job.collection,
        schemeVersion: job.schemeVersion,
        usersTotal: job.usersTotal,
        usersDone: job.usersDone,
        filesProcessed: job.filesProcessed,
        errors: job.errors,
        errorCount: job.errorCount,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt ?? null,
      });
    },
  );
}
