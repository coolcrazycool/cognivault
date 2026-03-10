import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { healthRoutes } from './features/health/routes.js';
import authPlugin from './plugins/auth.js';
import errorHandler from './plugins/error-handler.js';

interface BuildAppOptions {
  logger?: boolean | object;
}

export async function buildApp(opts?: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts?.logger ?? true,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Plugins (order matters: error handler first, then auth)
  await app.register(errorHandler);
  await app.register(authPlugin);

  // Feature routes
  await app.register(healthRoutes);

  return app;
}
