import { randomUUID } from 'node:crypto';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { adminRoutes } from './features/admin/routes.js';
import { contextRoutes } from './features/context/routes.js';
import { healthRoutes } from './features/health/routes.js';
import { searchRoutes } from './features/search/routes.js';
import { vaultRoutes } from './features/vault/routes.js';
import authPlugin from './plugins/auth.js';
import dbPlugin from './plugins/db.js';
import embeddingPlugin from './plugins/embedding.js';
import errorHandler from './plugins/error-handler.js';
// TODO Phase 18: Re-enable indexer with per-user context
// import indexerPlugin from './plugins/indexer.js';
import metricsPlugin from './plugins/metrics.js';
// TODO Phase 18: Re-enable pipeline with per-user indexing
// import pipelinePlugin from './plugins/pipeline.js';
import qdrantPlugin from './plugins/qdrant.js';
import registryPlugin from './plugins/registry.js';
import swaggerPlugin from './plugins/swagger.js';
import toonPlugin from './plugins/toon.js';
import vaultPlugin from './plugins/vault.js';

interface BuildAppOptions {
  logger?: boolean | object;
}

/**
 * Custom Pino request serializer that includes headers so redact can mask sensitive values.
 * The default Fastify serializer omits headers — we add them to enable Authorization redaction.
 */
function serializeRequest(req: {
  method: string;
  url: string;
  hostname?: string;
  remoteAddress?: string;
  headers?: Record<string, unknown>;
}) {
  return {
    method: req.method,
    url: req.url,
    hostname: req.hostname,
    remoteAddress: req.remoteAddress,
    headers: req.headers,
  };
}

/**
 * Build the Pino logger options with Authorization header redaction.
 * When logger is false (tests with no logging), pass through as-is.
 * When logger is true or undefined, construct a logger object with redact.
 * When logger is an object, merge redact into existing options.
 */
function buildLoggerOptions(logger: boolean | object | undefined): boolean | object {
  if (logger === false) {
    return false;
  }

  const enrichedOptions = {
    redact: ['req.headers.authorization', '*.openaiKey', '*.obsidian.password', '*.obsidian.token'],
    serializers: {
      req: serializeRequest,
    },
  };

  if (logger === true || logger === undefined) {
    return {
      level: 'info',
      ...enrichedOptions,
    };
  }
  // logger is an object — merge enriched options in
  return {
    ...(logger as object),
    ...enrichedOptions,
  };
}

export async function buildApp(opts?: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerOptions(opts?.logger),
    // X-Request-ID correlation: accept from agent or generate UUID
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    requestIdLogLabel: 'reqId',
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Echo X-Request-ID in every response (agent correlation)
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Request-ID', request.id);
  });

  // Plugins (order matters: error handler first, then metrics, registry, auth)
  await app.register(errorHandler);
  await app.register(metricsPlugin);
  await app.register(registryPlugin);
  await app.register(authPlugin);

  // Swagger must be registered after auth but before feature routes to capture schemas
  await app.register(swaggerPlugin);

  // TOON content negotiation plugin (after auth, before infrastructure)
  await app.register(toonPlugin);

  // Infrastructure plugins (order: vault, embedding, qdrant must come before db)
  await app.register(vaultPlugin);
  await app.register(embeddingPlugin);
  await app.register(qdrantPlugin);
  await app.register(dbPlugin);
  // TODO Phase 18: Re-enable indexer and pipeline with per-user context
  // await app.register(indexerPlugin);
  // await app.register(pipelinePlugin);

  // Feature routes
  await app.register(healthRoutes);
  await app.register(vaultRoutes, { prefix: '/api/vault' });
  await app.register(searchRoutes, { prefix: '/api/vault/search' });
  await app.register(contextRoutes, { prefix: '/api/vault' });
  await app.register(adminRoutes, { prefix: '/api/admin' });

  return app;
}
