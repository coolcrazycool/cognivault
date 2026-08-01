import { type Static, Type } from '@sinclair/typebox';
import { ErrorResponseSchema } from '../vault/schemas.js';

// ── Filters ──

export const SearchFiltersSchema = Type.Object({
  tags: Type.Optional(Type.Array(Type.String())),
  project: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  folder: Type.Optional(Type.String()),
});

export type SearchFilters = Static<typeof SearchFiltersSchema>;

// ── Request body ──

export const SearchRequestBodySchema = Type.Object({
  query: Type.String({ minLength: 1 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
  filters: Type.Optional(SearchFiltersSchema),
  // Small-to-big retrieval, honoured by /hybrid only: collapse the chunks of one section
  // into their best-ranked chunk and return the whole section text with it.
  group_by_section: Type.Optional(Type.Boolean({ default: false })),
  // Truncation limit for that section text (characters).
  section_max_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
});

export type SearchRequestBody = Static<typeof SearchRequestBodySchema>;

// ── Result ──

export const SearchResultSchema = Type.Object({
  text: Type.String(),
  path: Type.String(),
  title: Type.String(),
  section_path: Type.String(),
  score: Type.Number({ minimum: 0, maximum: 1 }),
  tags: Type.Array(Type.String()),
  project: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([Type.String(), Type.Null()]),
  type: Type.Union([Type.String(), Type.Null()]),
  // 0-based position of the chunk inside its source note (0 when the payload lacks it)
  chunk_index: Type.Integer({ minimum: 0 }),
  // Identifier of the section this chunk belongs to; "" for formats without sections
  // (pdf/csv/canvas/excalidraw) and for points indexed before parent tracking existed.
  parent_id: Type.String(),
  // Shape of the chunk's text as stamped by the indexer: 'text', 'table_rows' (header row
  // plus data rows) or 'table_summary'. Open string, not an enum, so future kinds are not
  // a breaking schema change. Always present in responses ('text' when the payload
  // predates the field); Optional only so existing consumers of the Static type that
  // build SearchResult values do not have to declare it.
  content_kind: Type.Optional(Type.String()),
  // Full text of that section, only filled when the request asked for group_by_section.
  section_text: Type.String(),
  // 1-based position of this result in the returned list
  rank: Type.Integer({ minimum: 1 }),
});

export type SearchResult = Static<typeof SearchResultSchema>;

// ── Response ──

export const SearchResponseSchema = Type.Object({
  results: Type.Array(SearchResultSchema),
  total: Type.Integer(),
  limit: Type.Integer(),
  query_ms: Type.Integer(),
});

export type SearchResponse = Static<typeof SearchResponseSchema>;

// ── Route schema objects ──

export const semanticSearchSchema = {
  body: SearchRequestBodySchema,
  response: {
    200: SearchResponseSchema,
    400: ErrorResponseSchema,
    500: ErrorResponseSchema,
  },
};

export const lexicalSearchSchema = {
  body: SearchRequestBodySchema,
  response: {
    200: SearchResponseSchema,
    400: ErrorResponseSchema,
    500: ErrorResponseSchema,
  },
};

export const hybridSearchSchema = {
  body: SearchRequestBodySchema,
  response: {
    200: SearchResponseSchema,
    400: ErrorResponseSchema,
    500: ErrorResponseSchema,
  },
};

export { ErrorResponseSchema };
