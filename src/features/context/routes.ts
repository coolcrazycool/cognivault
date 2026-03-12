import { SpanStatusCode, TraceFlags, trace } from '@opentelemetry/api';
import type { FastifyInstance } from 'fastify';
import { SearchService } from '../search/service.js';
import type { ContextRequestBody } from './schemas.js';
import { contextSchema } from './schemas.js';
import { ContextService } from './service.js';

const tracer = trace.getTracer('cognivault-context');

export async function contextRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: ContextRequestBody }>(
    '/context',
    { schema: contextSchema },
    async (request) => {
      return tracer.startActiveSpan('context.assemble', async (span) => {
        // Inject traceId into log context when tracing is active (sampled span only)
        const spanCtx = span.spanContext();
        if (spanCtx.traceFlags & TraceFlags.SAMPLED) {
          request.log = request.log.child({ traceId: spanCtx.traceId });
        }
        try {
          const start = Date.now();
          const { query, token_budget = 32000, min_score = 0.3, filters = {} } = request.body;

          // Set span attributes before async work
          span.setAttribute('context.token_budget', token_budget);

          // Fetch top 50 hybrid results (per locked decision)
          const searchService = new SearchService(fastify.qdrant, fastify.embedder);
          const results = await searchService.hybrid(query, 50, filters);
          fastify.metrics.searchRequests.inc({ type: 'hybrid' });

          // Assemble context pack
          const contextService = new ContextService();
          const pack = contextService.assemble(results, {
            tokenBudget: token_budget,
            minScore: min_score,
          });

          span.setAttribute('context.chunks_count', pack.meta.chunks_included);

          // Add query_ms to meta (not set by service — route measures wall time)
          return {
            ...pack,
            meta: {
              ...pack.meta,
              query_ms: Date.now() - start,
            },
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
