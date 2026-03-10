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
      // Phase 1: always ready (no external deps checked yet)
      // Future phases: check Qdrant connectivity, index state, etc.
      const ready = true;
      const status = ready ? 'ready' : 'not_ready';
      return reply.status(ready ? 200 : 503).send({
        status,
        timestamp: new Date().toISOString(),
      });
    },
  );
}
