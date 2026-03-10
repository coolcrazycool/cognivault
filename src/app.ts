import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { healthRoutes } from './features/health/routes.js';
import errorHandler from './plugins/error-handler.js';

interface BuildAppOptions {
  logger?: boolean | object;
}

export async function buildApp(opts?: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts?.logger ?? true,
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(errorHandler);

  // Feature routes
  await app.register(healthRoutes);

  return app;
}
