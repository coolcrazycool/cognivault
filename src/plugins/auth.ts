import bearerAuth from '@fastify/bearer-auth';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';

async function authPlugin(fastify: FastifyInstance): Promise<void> {
  await fastify.register(bearerAuth, {
    keys: new Set([config.COGNIVAULT_API_KEY]),
    addHook: false,
  });

  type VerifyFn = (
    request: FastifyRequest,
    reply: FastifyReply,
    done: (err?: Error) => void,
  ) => void;

  fastify.addHook('onRequest', async (request, reply) => {
    // Skip auth for routes that opt out (e.g., health/readiness)
    if ((request.routeOptions.config as unknown as Record<string, unknown>)?.skipAuth) {
      return;
    }

    // Skip auth for Swagger UI docs routes (/docs and sub-paths)
    if (request.url.startsWith('/docs')) {
      return;
    }

    const verify = (fastify as unknown as { verifyBearerAuth: VerifyFn }).verifyBearerAuth;
    await new Promise<void>((resolve, reject) => {
      verify(request, reply, (err?: Error) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });
}

export default fp(authPlugin, {
  name: 'auth',
});
