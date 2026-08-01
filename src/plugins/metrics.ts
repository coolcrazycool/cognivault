import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

interface MetricsCollection {
  searchDuration: Histogram<'type' | 'user_id'>;
  searchRequests: Counter<'type' | 'user_id'>;
  indexQueueDepth: Gauge<'user_id'>;
  staleVectorCleanups: Counter<'user_id'>;
  embeddingRequests: Counter<'user_id'>;
  chunksProcessed: Counter<'user_id'>;
  pipelineDuration: Histogram<'user_id'>;
  contextPacks: Counter<'user_id'>;
  bm25SchemeMismatch: Gauge<string>;
  collectionBlocked: Gauge<string>;
  removeUserMetrics: (userId: string) => void;
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

  // Search latency histogram by search type and user
  const searchDuration = new Histogram({
    name: 'cognivault_search_duration_seconds',
    help: 'Duration of search requests in seconds',
    labelNames: ['type', 'user_id'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [register],
  });

  // Search throughput counter by search type and user
  const searchRequests = new Counter({
    name: 'cognivault_search_requests_total',
    help: 'Total number of search requests',
    labelNames: ['type', 'user_id'] as const,
    registers: [register],
  });

  // Index queue depth gauge per user
  const indexQueueDepth = new Gauge({
    name: 'cognivault_index_queue_depth',
    help: 'Current number of items in the index processing queue',
    labelNames: ['user_id'] as const,
    registers: [register],
  });

  // Stale vector cleanup counter per user
  const staleVectorCleanups = new Counter({
    name: 'cognivault_stale_vector_cleanups_total',
    help: 'Total number of stale vector cleanup operations',
    labelNames: ['user_id'] as const,
    registers: [register],
  });

  // Total embedding API calls counter per user
  const embeddingRequests = new Counter({
    name: 'cognivault_embedding_requests_total',
    help: 'Total number of embedding API calls made',
    labelNames: ['user_id'] as const,
    registers: [register],
  });

  // Total chunks processed through the indexing pipeline counter per user
  const chunksProcessed = new Counter({
    name: 'cognivault_chunks_processed_total',
    help: 'Total number of chunks processed through the indexing pipeline',
    labelNames: ['user_id'] as const,
    registers: [register],
  });

  // End-to-end per-file pipeline processing duration histogram per user
  const pipelineDuration = new Histogram({
    name: 'cognivault_pipeline_duration_seconds',
    help: 'End-to-end duration of file processing through the indexing pipeline',
    labelNames: ['user_id'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [register],
  });

  // Context packs assembled counter per user
  const contextPacks = new Counter({
    name: 'cognivault_context_packs_total',
    help: 'Total context packs assembled',
    labelNames: ['user_id'] as const,
    registers: [register],
  });

  // Whether the collection's sparse vectors are known to match this build's BM25 scheme.
  // Set once at startup by the qdrant plugin; 1 means the lexical branch is degraded and
  // a re-index into a fresh collection is owed. Unlabelled — the collection is a
  // process-wide property, and a label would only invite cardinality.
  const bm25SchemeMismatch = new Gauge({
    name: 'cognivault_bm25_scheme_mismatch',
    help: "1 when the Qdrant collection's recorded BM25 scheme version differs from (or is unknown to) the running build — lexical retrieval is degraded until a re-index",
    registers: [register],
  });

  // Whether the search collection is unusable and waiting on an operator. Set at startup
  // by the qdrant plugin and cleared when a rebuild resolves it. Deliberately NOT folded
  // into bm25SchemeMismatch: that gauge means "lexical ranking is degraded, dense search
  // is fine", this one means "nothing is searchable and nothing is being indexed".
  // Unlabelled for the same reason — the collection is a process-wide property.
  const collectionBlocked = new Gauge({
    name: 'cognivault_collection_blocked',
    help: '1 when the Qdrant collection cannot serve and only an operator can resolve it (a legacy collection occupies the search alias name) — search and indexing refuse with 503 until POST /api/admin/collection/rebuild',
    registers: [register],
  });

  // Remove all metric label combinations for a specific user
  function removeUserMetrics(userId: string): void {
    const searchTypes = ['semantic', 'hybrid', 'lexical'];
    for (const type of searchTypes) {
      searchDuration.remove({ type, user_id: userId });
      searchRequests.remove({ type, user_id: userId });
    }
    indexQueueDepth.remove({ user_id: userId });
    staleVectorCleanups.remove({ user_id: userId });
    embeddingRequests.remove({ user_id: userId });
    chunksProcessed.remove({ user_id: userId });
    pipelineDuration.remove({ user_id: userId });
    contextPacks.remove({ user_id: userId });
  }

  // Decorate fastify with the metrics collection
  fastify.decorate('metrics', {
    searchDuration,
    searchRequests,
    indexQueueDepth,
    staleVectorCleanups,
    embeddingRequests,
    chunksProcessed,
    pipelineDuration,
    contextPacks,
    bm25SchemeMismatch,
    collectionBlocked,
    removeUserMetrics,
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
