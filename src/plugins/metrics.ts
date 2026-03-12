import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

interface MetricsCollection {
  searchDuration: Histogram<'type'>;
  searchRequests: Counter<'type'>;
  indexQueueDepth: Gauge;
  staleVectorCleanups: Counter;
}

declare module 'fastify' {
  interface FastifyInstance {
    metrics: MetricsCollection;
  }
}

async function metricsPlugin(fastify: FastifyInstance): Promise<void> {
  // Use a per-instance registry (not global default) to avoid test pollution
  const register = new Registry();

  // Collect default Node.js process metrics (CPU, memory, event loop lag, etc.)
  collectDefaultMetrics({ register });

  // Search latency histogram by search type
  const searchDuration = new Histogram({
    name: 'cognivault_search_duration_seconds',
    help: 'Duration of search requests in seconds',
    labelNames: ['type'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [register],
  });

  // Search throughput counter by search type
  const searchRequests = new Counter({
    name: 'cognivault_search_requests_total',
    help: 'Total number of search requests',
    labelNames: ['type'] as const,
    registers: [register],
  });

  // Index queue depth gauge (active + pending tasks)
  const indexQueueDepth = new Gauge({
    name: 'cognivault_index_queue_depth',
    help: 'Current number of items in the index processing queue',
    registers: [register],
  });

  // Stale vector cleanup counter
  const staleVectorCleanups = new Counter({
    name: 'cognivault_stale_vector_cleanups_total',
    help: 'Total number of stale vector cleanup operations',
    registers: [register],
  });

  // Decorate fastify with the metrics collection
  fastify.decorate('metrics', {
    searchDuration,
    searchRequests,
    indexQueueDepth,
    staleVectorCleanups,
  });

  // Register /metrics route — skips auth (Prometheus scraping does not send auth headers)
  fastify.get('/metrics', { config: { skipAuth: true } }, async (_request, reply) => {
    const metricsOutput = await register.metrics();
    await reply.header('Content-Type', register.contentType).send(metricsOutput);
  });
}

export default fp(metricsPlugin, {
  name: 'metrics',
  dependencies: [],
});
