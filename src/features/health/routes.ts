import type { FastifyInstance } from 'fastify';
import { healthSchema, readySchema } from './schemas.js';

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/health',
    {
      config: { skipAuth: true },
      schema: healthSchema,
    },
    async (_request, _reply) => {
      return {
        status: 'ok' as const,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      };
    },
  );

  fastify.get(
    '/ready',
    {
      config: { skipAuth: true },
      schema: readySchema,
    },
    async (_request, reply) => {
      let vaultOk = false;

      try {
        if (fastify.vault) {
          await fastify.vault.resolvePath('');
          vaultOk = true;
        }
      } catch {
        vaultOk = false;
      }

      // Per-user DBs: readiness checks vault only (DB is per-user, no global DB)
      const dbOk = true;

      // Check if any per-user indexer is currently indexing
      let indexing = false;
      if (fastify.indexers) {
        for (const [, entry] of fastify.indexers) {
          if (entry.indexer.isIndexing) {
            indexing = true;
            break;
          }
        }
      }

      const ready = vaultOk && dbOk;
      const status = ready ? 'ready' : 'not_ready';

      return reply.status(ready ? 200 : 503).send({
        status,
        timestamp: new Date().toISOString(),
        checks: {
          vault: vaultOk ? 'ok' : 'error',
          db: dbOk ? 'ok' : 'error',
        },
        indexing,
      });
    },
  );
}
