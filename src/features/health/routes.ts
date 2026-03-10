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

      const ready = vaultOk;
      const status = ready ? 'ready' : 'not_ready';
      return reply.status(ready ? 200 : 503).send({
        status,
        timestamp: new Date().toISOString(),
        checks: {
          vault: vaultOk ? 'ok' : 'error',
        },
      });
    },
  );
}
