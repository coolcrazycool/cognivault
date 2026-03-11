import type { FastifyInstance } from 'fastify';
import type { SearchRequestBody } from './schemas.js';
import { lexicalSearchSchema, semanticSearchSchema } from './schemas.js';
import { SearchService } from './service.js';

export async function searchRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /semantic — Semantic search using embedding similarity via Qdrant vector search
  fastify.post<{ Body: SearchRequestBody }>(
    '/semantic',
    { schema: semanticSearchSchema },
    async (request) => {
      // query_ms measures total wall time including embedding (deliberate — tracks full agent latency)
      const start = Date.now();
      const { query, limit = 10, filters = {} } = request.body;
      const searchService = new SearchService(fastify.qdrant, fastify.embedder);
      const results = await searchService.semantic(query, limit, filters);
      return {
        results,
        total: results.length,
        limit,
        query_ms: Date.now() - start,
      };
    },
  );

  // POST /lexical — Lexical search using Qdrant full-text index on text/title/section_path
  fastify.post<{ Body: SearchRequestBody }>(
    '/lexical',
    { schema: lexicalSearchSchema },
    async (request) => {
      // query_ms measures total wall time (embedding not called for lexical — tracks Qdrant latency)
      const start = Date.now();
      const { query, limit = 10, filters = {} } = request.body;
      const searchService = new SearchService(fastify.qdrant, fastify.embedder);
      const results = await searchService.lexical(query, limit, filters);
      return {
        results,
        total: results.length,
        limit,
        query_ms: Date.now() - start,
      };
    },
  );
}
