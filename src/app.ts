import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { healthRoutes } from './features/health/routes.js';
import { searchRoutes } from './features/search/routes.js';
import { vaultRoutes } from './features/vault/routes.js';
import authPlugin from './plugins/auth.js';
import dbPlugin from './plugins/db.js';
import embeddingPlugin from './plugins/embedding.js';
import errorHandler from './plugins/error-handler.js';
import indexerPlugin from './plugins/indexer.js';
import pipelinePlugin from './plugins/pipeline.js';
import qdrantPlugin from './plugins/qdrant.js';
import vaultPlugin from './plugins/vault.js';

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

  // Plugins
  await app.register(vaultPlugin);
  await app.register(dbPlugin);
  await app.register(indexerPlugin);
  await app.register(embeddingPlugin);
  await app.register(qdrantPlugin);
  await app.register(pipelinePlugin);

  // Feature routes
  await app.register(healthRoutes);
  await app.register(vaultRoutes, { prefix: '/api/vault' });
  await app.register(searchRoutes, { prefix: '/api/vault/search' });

  return app;
}
