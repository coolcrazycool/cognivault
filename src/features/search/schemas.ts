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

export { ErrorResponseSchema };
