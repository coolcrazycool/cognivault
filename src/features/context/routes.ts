import type { FastifyInstance } from 'fastify';
import { SearchService } from '../search/service.js';
import type { ContextRequestBody } from './schemas.js';
import { contextSchema } from './schemas.js';
import { ContextService } from './service.js';

export async function contextRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: ContextRequestBody }>(
    '/context',
    { schema: contextSchema },
    async (request) => {
      const start = Date.now();
      const { query, token_budget = 32000, min_score = 0.3, filters = {} } = request.body;

      // Fetch top 50 hybrid results (per locked decision)
      const searchService = new SearchService(fastify.qdrant, fastify.embedder);
      const results = await searchService.hybrid(query, 50, filters);

      // Assemble context pack
      const contextService = new ContextService();
      const pack = contextService.assemble(results, {
        tokenBudget: token_budget,
        minScore: min_score,
      });

      // Add query_ms to meta (not set by service — route measures wall time)
      return {
        ...pack,
        meta: {
          ...pack.meta,
          query_ms: Date.now() - start,
        },
      };
    },
  );
}
