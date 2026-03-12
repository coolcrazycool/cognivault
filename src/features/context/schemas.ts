import { type Static, Type } from '@sinclair/typebox';
import { SearchFiltersSchema } from '../search/schemas.js';
import { ErrorResponseSchema } from '../vault/schemas.js';

// ── Request body ──

export const ContextRequestBodySchema = Type.Object({
  query: Type.String({ minLength: 1 }),
  token_budget: Type.Optional(Type.Integer({ minimum: 1000, maximum: 128000, default: 32000 })),
  min_score: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 0.3 })),
  filters: Type.Optional(SearchFiltersSchema),
});

export type ContextRequestBody = Static<typeof ContextRequestBodySchema>;

// ── Source metadata ──

export const ContextSourceSchema = Type.Object({
  path: Type.String(),
  title: Type.String(),
  sections: Type.Array(Type.String()),
  score: Type.Number({ minimum: 0, maximum: 1 }),
});

export type ContextSource = Static<typeof ContextSourceSchema>;

// ── Entry (single note merged chunks) ──

export const ContextEntrySchema = Type.Object({
  text: Type.String(),
  source: ContextSourceSchema,
  section: Type.Union([
    Type.Literal('summary'),
    Type.Literal('architecture'),
    Type.Literal('adrs'),
    Type.Literal('glossary'),
    Type.Literal('implementation'),
  ]),
});

export type ContextEntry = Static<typeof ContextEntrySchema>;

// ── Meta ──

export const ContextMetaSchema = Type.Object({
  total_tokens: Type.Integer(),
  token_budget: Type.Integer(),
  chunks_included: Type.Integer(),
  chunks_excluded: Type.Integer(),
  query_ms: Type.Integer(),
});

export type ContextMeta = Static<typeof ContextMetaSchema>;

// ── Response ──

export const ContextResponseSchema = Type.Object({
  summary: Type.Optional(Type.Array(ContextEntrySchema)),
  architecture: Type.Optional(Type.Array(ContextEntrySchema)),
  adrs: Type.Optional(Type.Array(ContextEntrySchema)),
  glossary: Type.Optional(Type.Array(ContextEntrySchema)),
  implementation: Type.Optional(Type.Array(ContextEntrySchema)),
  meta: ContextMetaSchema,
});

export type ContextResponse = Static<typeof ContextResponseSchema>;

// ── Route schema object ──

export const contextSchema = {
  body: ContextRequestBodySchema,
  response: {
    200: ContextResponseSchema,
    400: ErrorResponseSchema,
    500: ErrorResponseSchema,
  },
};

export { ErrorResponseSchema };
