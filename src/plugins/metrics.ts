import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

interface MetricsCollection {
  searchDuration: Histogram<'type'>;
  searchRequests: Counter<'type'>;
  indexQueueDepth: Gauge;
  staleVectorCleanups: Counter;
  embeddingRequests: Counter;
  chunksProcessed: Counter;
  pipelineDuration: Histogram;
  promRegistry: Registry;
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

  // Total embedding API calls counter
  const embeddingRequests = new Counter({
    name: 'cognivault_embedding_requests_total',
    help: 'Total number of embedding API calls made',
    registers: [register],
  });

  // Total chunks processed through the indexing pipeline counter
  const chunksProcessed = new Counter({
    name: 'cognivault_chunks_processed_total',
    help: 'Total number of chunks processed through the indexing pipeline',
    registers: [register],
  });

  // End-to-end per-file pipeline processing duration histogram
  const pipelineDuration = new Histogram({
    name: 'cognivault_pipeline_duration_seconds',
    help: 'End-to-end duration of file processing through the indexing pipeline',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [register],
  });

  // Decorate fastify with the metrics collection
  fastify.decorate('metrics', {
    searchDuration,
    searchRequests,
    indexQueueDepth,
    staleVectorCleanups,
    embeddingRequests,
    chunksProcessed,
    pipelineDuration,
    promRegistry: register,
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
