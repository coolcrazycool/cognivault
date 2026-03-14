import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { Counter } from 'prom-client';
import type { UserRecord } from '../lib/user-registry.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRecord;
  }
}

function extractBearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return undefined;
  }
  return header.slice(7);
}

const UNAUTHORIZED_RESPONSE = {
  error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key' },
} as const;

async function authPlugin(fastify: FastifyInstance): Promise<void> {
  const authFailures = new Counter({
    name: 'cognivault_auth_failures_total',
    help: 'Total number of authentication failures',
    registers: [fastify.metrics.promRegistry],
  });

  fastify.addHook('onRequest', async (request, reply) => {
    // Skip auth for routes that opt out (e.g., health/readiness)
    if ((request.routeOptions.config as unknown as Record<string, unknown>)?.skipAuth) {
      return;
    }

    // Skip auth for Swagger UI docs routes (/docs and sub-paths)
    if (request.url.startsWith('/docs')) {
      return;
    }

    const token = extractBearerToken(request);
    if (!token) {
      authFailures.inc();
      return reply.status(401).send(UNAUTHORIZED_RESPONSE);
    }

    const user = fastify.registry.getUserByApiKey(token);
    if (!user) {
      authFailures.inc();
      return reply.status(401).send(UNAUTHORIZED_RESPONSE);
    }

    request.user = user;
    request.log = request.log.child({ userId: user.userId });
  });
}

export default fp(authPlugin, { name: 'auth', dependencies: ['registry', 'metrics'] });
