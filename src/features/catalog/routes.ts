import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import type { CatalogQuery } from './schemas.js';
import { CATALOG_DEFAULT_LIMIT, catalogSchema } from './schemas.js';
import { readCatalog, summaryAvailability } from './service.js';

export async function catalogRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /catalog — one row per indexed document: path, title and the annotation the
  // indexer cached for it. The rows are `doc_summaries`, written per document at index
  // time and until now readable only by the indexer's own cache lookup.
  fastify.get<{ Querystring: CatalogQuery }>(
    '/catalog',
    { schema: catalogSchema },
    async (request) => {
      const { limit = CATALOG_DEFAULT_LIMIT, offset = 0 } = request.query;

      // Per-user SQLite, like every other route here — the annotations live in the caller's
      // own index.db and never leave it.
      return readCatalog(request.getUserDb(), {
        limit,
        offset,
        availability: summaryAvailability({
          indexDocSummary: config.INDEX_DOC_SUMMARY,
          embeddingProvider: config.EMBEDDING_PROVIDER,
          certPath: config.GIGACHAT_CERT_PATH,
          keyPath: config.GIGACHAT_KEY_PATH,
        }),
      });
    },
  );
}
