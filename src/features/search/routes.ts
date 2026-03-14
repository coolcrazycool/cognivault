import { SpanStatusCode, TraceFlags, trace } from '@opentelemetry/api';
import type { FastifyInstance } from 'fastify';
import type { SearchRequestBody } from './schemas.js';
import { hybridSearchSchema, lexicalSearchSchema, semanticSearchSchema } from './schemas.js';
import { SearchService } from './service.js';

const tracer = trace.getTracer('cognivault-search');

export async function searchRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /semantic — Semantic search using embedding similarity via Qdrant vector search
  fastify.post<{ Body: SearchRequestBody }>(
    '/semantic',
    { schema: semanticSearchSchema },
    async (request) => {
      return tracer.startActiveSpan('search.semantic', async (span) => {
        // Inject traceId into log context when tracing is active (sampled span only)
        const spanCtx = span.spanContext();
        if (spanCtx.traceFlags & TraceFlags.SAMPLED) {
          request.log = request.log.child({ traceId: spanCtx.traceId });
        }
        try {
          // query_ms measures total wall time including embedding (deliberate — tracks full agent latency)
          const start = Date.now();
          const userId = request.user!.userId;
          const { query, limit = 10, filters = {} } = request.body;
          const searchService = new SearchService(
            request.getUserQdrant(),
            fastify.getUserEmbedder(userId),
          );
          const endTimer = fastify.metrics.searchDuration.startTimer({ type: 'semantic', user_id: userId });
          const results = await searchService.semantic(query, limit, filters);
          endTimer();
          fastify.metrics.searchRequests.inc({ type: 'semantic', user_id: userId });
          span.setAttribute('search.results_count', results.length);
          return {
            results,
            total: results.length,
            limit,
            query_ms: Date.now() - start,
          };
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      });
    },
  );

  // POST /hybrid — Hybrid search combining semantic + lexical via Reciprocal Rank Fusion (RRF)
  fastify.post<{ Body: SearchRequestBody }>(
    '/hybrid',
    { schema: hybridSearchSchema },
    async (request) => {
      return tracer.startActiveSpan('search.hybrid', async (span) => {
        // Inject traceId into log context when tracing is active (sampled span only)
        const spanCtx = span.spanContext();
        if (spanCtx.traceFlags & TraceFlags.SAMPLED) {
          request.log = request.log.child({ traceId: spanCtx.traceId });
        }
        try {
          // query_ms measures total wall time including embedding (semantic path calls embedder)
          const start = Date.now();
          const userId = request.user!.userId;
          const { query, limit = 10, filters = {} } = request.body;
          const searchService = new SearchService(
            request.getUserQdrant(),
            fastify.getUserEmbedder(userId),
          );
          const endTimer = fastify.metrics.searchDuration.startTimer({ type: 'hybrid', user_id: userId });
          const results = await searchService.hybrid(query, limit, filters);
          endTimer();
          fastify.metrics.searchRequests.inc({ type: 'hybrid', user_id: userId });
          span.setAttribute('search.results_count', results.length);
          return {
            results,
            total: results.length,
            limit,
            query_ms: Date.now() - start,
          };
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      });
    },
  );

  // POST /lexical — Lexical search using Qdrant full-text index on text/title/section_path
  fastify.post<{ Body: SearchRequestBody }>(
    '/lexical',
    { schema: lexicalSearchSchema },
    async (request) => {
      return tracer.startActiveSpan('search.lexical', async (span) => {
        // Inject traceId into log context when tracing is active (sampled span only)
        const spanCtx = span.spanContext();
        if (spanCtx.traceFlags & TraceFlags.SAMPLED) {
          request.log = request.log.child({ traceId: spanCtx.traceId });
        }
        try {
          // query_ms measures total wall time (embedding not called for lexical — tracks Qdrant latency)
          const start = Date.now();
          const userId = request.user!.userId;
          const { query, limit = 10, filters = {} } = request.body;
          const searchService = new SearchService(
            request.getUserQdrant(),
            fastify.getUserEmbedder(userId),
          );
          const endTimer = fastify.metrics.searchDuration.startTimer({ type: 'lexical', user_id: userId });
          const results = await searchService.lexical(query, limit, filters);
          endTimer();
          fastify.metrics.searchRequests.inc({ type: 'lexical', user_id: userId });
          span.setAttribute('search.results_count', results.length);
          return {
            results,
            total: results.length,
            limit,
            query_ms: Date.now() - start,
          };
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      });
    },
  );
}
