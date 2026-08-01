import { type Static, Type } from '@sinclair/typebox';
import { ErrorResponseSchema } from '../vault/schemas.js';

// ── Query ──

/**
 * Default page size. The corpus this was built for is 127 documents, so the default
 * returns the whole catalogue in one call and a caller that ignores paging entirely is
 * still correct there. `total` is always the full count, so truncation is detectable
 * (`offset + documents.length < total`) rather than silent.
 */
export const CATALOG_DEFAULT_LIMIT = 500;
export const CATALOG_MAX_LIMIT = 2000;

export const CatalogQuerySchema = Type.Object({
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: CATALOG_MAX_LIMIT,
      default: CATALOG_DEFAULT_LIMIT,
      description:
        'Maximum number of documents to return. The default covers a normal vault in ' +
        'one call; compare `offset + documents.length` with `total` to detect truncation.',
    }),
  ),
  offset: Type.Optional(
    Type.Integer({
      minimum: 0,
      default: 0,
      description: 'Number of documents to skip, in the same path order every call uses.',
    }),
  ),
});

export type CatalogQuery = Static<typeof CatalogQuerySchema>;

// ── Entry ──

export const CatalogEntrySchema = Type.Object({
  path: Type.String({
    description: 'Vault-relative path, identical to the `path` payload field on search hits.',
  }),
  title: Type.String({
    description:
      'File name without its extension — derived exactly the way the indexer derives ' +
      'the `title` payload field, so the two always agree.',
  }),
  summary: Type.Union([Type.String(), Type.Null()], {
    description:
      'The cached one-paragraph annotation the indexer wrote for this document, or null ' +
      'when it has none. Null is a per-document fact, not an error: a page that produced ' +
      'no indexable content (a container page holding only frontmatter) never reaches the ' +
      'annotator, and an install that cannot run the annotator at all reports that once in ' +
      '`status`/`reason` instead of repeating it on every entry.',
  }),
  size: Type.Integer({
    minimum: 0,
    description:
      'File size in bytes as recorded by the indexer, frontmatter included. Present so a ' +
      'null `summary` on a ~500-byte container page can be told apart from a null on a ' +
      'full page whose annotation call failed.',
  }),
});

export type CatalogEntry = Static<typeof CatalogEntrySchema>;

// ── Response ──

export const CatalogStatusSchema = Type.Union(
  [
    Type.Literal('ok'),
    Type.Literal('empty_vault'),
    Type.Literal('summaries_disabled'),
    Type.Literal('summaries_pending'),
  ],
  {
    description:
      'One-field answer to "why does this catalogue look the way it does", derived from ' +
      'the counters below:\n' +
      '- `ok` — at least one document carries an annotation.\n' +
      '- `empty_vault` — nothing is indexed for this user yet. THE ONLY value that means ' +
      'the corpus itself is empty.\n' +
      '- `summaries_disabled` — documents are indexed, but this deployment cannot produce ' +
      'annotations (see `reason`). Re-indexing will not change that.\n' +
      '- `summaries_pending` — documents are indexed and annotations are enabled, but none ' +
      'have been written yet: indexing has not reached them, or every chat call failed.',
  },
);

export type CatalogStatus = Static<typeof CatalogStatusSchema>;

export const CatalogResponseSchema = Type.Object(
  {
    status: CatalogStatusSchema,
    summaries_enabled: Type.Boolean({
      description:
        'Whether this deployment can write NEW annotations at index time. Reported ' +
        'independently of `status`, because rows written by an earlier GigaChat-backed ' +
        'index survive a switch to a provider that cannot refresh them.',
    }),
    reason: Type.Union([Type.String(), Type.Null()], {
      description:
        'Why `summaries_enabled` is false — which setting to change. Null when they are enabled.',
    }),
    documents: Type.Array(CatalogEntrySchema, {
      description:
        'One entry per indexed document, ordered by path (so the list is already a ' +
        'depth-first walk of the folder tree). Images are excluded: they carry no text. ' +
        'Documents WITHOUT an annotation are included with `summary: null` — omitting them ' +
        'would make the catalogue disagree with what retrieval can actually return.',
    }),
    total: Type.Integer({
      minimum: 0,
      description: 'Indexed documents for this user, before `limit`/`offset`.',
    }),
    offset: Type.Integer({ minimum: 0, description: 'Echo of the requested offset.' }),
    documents_with_summary: Type.Integer({
      minimum: 0,
      description:
        'How many of `total` carry an annotation — counted over the whole index, not over ' +
        'the returned page, so it is comparable with `total` regardless of paging.',
    }),
    document_extensions: Type.Array(Type.String(), {
      description:
        'THE definition of "document" for this service: the extensions the indexer picks ' +
        'up, minus images. Served from `DOCUMENT_EXTENSIONS` in `src/lib/indexer.ts`, the ' +
        'same constant the poller scans by — so it cannot drift from what is actually ' +
        'indexed. A client that counts documents by walking the filesystem ' +
        '(`GET /api/vault/files`) MUST filter by this list rather than keep its own ' +
        'allowlist: a file with any other extension is never indexed, and counting it ' +
        'promises a document that search can never return. Lower-case, no leading dot.',
    }),
  },
  {
    description:
      'Per-document annotations written at index time. An empty `documents` array is a ' +
      'legitimate answer with four distinct causes; read `status` before concluding ' +
      'anything about the corpus.',
  },
);

export type CatalogResponse = Static<typeof CatalogResponseSchema>;

// ── Route schema object ──

export const catalogSchema = {
  querystring: CatalogQuerySchema,
  response: {
    200: CatalogResponseSchema,
    400: ErrorResponseSchema,
    401: ErrorResponseSchema,
    500: ErrorResponseSchema,
  },
};
