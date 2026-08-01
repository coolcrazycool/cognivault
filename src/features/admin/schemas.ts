import { type Static, Type } from '@sinclair/typebox';
import { ErrorResponseSchema } from '../vault/schemas.js';

// ── Request body: union of three scope shapes ──

const ReindexFullBodySchema = Type.Object({
  scope: Type.Literal('full'),
});

const ReindexPathBodySchema = Type.Object({
  scope: Type.Literal('path'),
  path: Type.String({ minLength: 1 }),
});

const ReindexFolderBodySchema = Type.Object({
  scope: Type.Literal('folder'),
  folder: Type.String({ minLength: 1 }),
});

export const ReindexRequestBodySchema = Type.Union([
  ReindexFullBodySchema,
  ReindexPathBodySchema,
  ReindexFolderBodySchema,
]);

export type ReindexRequestBody = Static<typeof ReindexRequestBodySchema>;

// ── Response schemas ──

export const ReindexResponseSchema = Type.Object({
  jobId: Type.String(),
  status: Type.String(),
  message: Type.String(),
});

export type ReindexResponse = Static<typeof ReindexResponseSchema>;

export const ReindexStatusQuerySchema = Type.Object({
  jobId: Type.String({ minLength: 1 }),
});

export type ReindexStatusQuery = Static<typeof ReindexStatusQuerySchema>;

export const ReindexStatusResponseSchema = Type.Object({
  jobId: Type.String(),
  status: Type.String(),
  filesProcessed: Type.Integer(),
  totalFiles: Type.Integer(),
  errors: Type.Array(Type.String()),
  // Total failures observed; `errors` retains only the first 100 messages.
  errorCount: Type.Integer(),
  startedAt: Type.String(),
  completedAt: Type.Optional(Type.String()),
});

export type ReindexStatusResponse = Static<typeof ReindexStatusResponseSchema>;

// ── Route schema objects ──

export const reindexSchema = {
  body: ReindexRequestBodySchema,
  response: {
    202: ReindexResponseSchema,
    400: ErrorResponseSchema,
    401: ErrorResponseSchema,
    409: ErrorResponseSchema,
    500: ErrorResponseSchema,
  },
};

export const reindexStatusSchema = {
  querystring: ReindexStatusQuerySchema,
  response: {
    200: ReindexStatusResponseSchema,
    400: ErrorResponseSchema,
    401: ErrorResponseSchema,
    404: ErrorResponseSchema,
    500: ErrorResponseSchema,
  },
};

// ── Collection rebuild ──

export const CollectionInfoResponseSchema = Type.Object({
  collection: Type.String({
    description:
      'Physical collection holding every tenant\'s vectors. This exact string is what "confirm" must carry to rebuild it.',
  }),
  alias: Type.String({ description: 'Alias all runtime search traffic goes through.' }),
  schemeVersion: Type.Union([Type.Integer(), Type.Null()], {
    description:
      'BM25 scheme version recorded on the collection; null when it carries no marker or could not be read.',
  }),
  expectedSchemeVersion: Type.Integer({
    description:
      'BM25 scheme version this build produces. A difference means lexical retrieval is degraded until the collection is rebuilt.',
  }),
  pointsCount: Type.Union([Type.Integer(), Type.Null()], {
    description: 'Points in the collection; null while it is dropped or unreadable.',
  }),
});

export type CollectionInfoResponse = Static<typeof CollectionInfoResponseSchema>;

export const RebuildRequestBodySchema = Type.Object({
  confirm: Type.String({
    minLength: 1,
    description:
      "The physical collection name, typed by the operator. Nothing is pre-filled: this is the only guard on an action that deletes every tenant's vectors.",
  }),
});

export type RebuildRequestBody = Static<typeof RebuildRequestBodySchema>;

export const RebuildResponseSchema = Type.Object({
  jobId: Type.String(),
  status: Type.String(),
  message: Type.String(),
});

export type RebuildResponse = Static<typeof RebuildResponseSchema>;

export const RebuildStatusQuerySchema = Type.Object({
  jobId: Type.String({ minLength: 1 }),
});

export type RebuildStatusQuery = Static<typeof RebuildStatusQuerySchema>;

export const RebuildStatusResponseSchema = Type.Object({
  jobId: Type.String(),
  status: Type.String({ description: 'running | completed | failed' }),
  phase: Type.String({
    description:
      'dropping (collection still intact) | creating (collection is GONE, search returns nothing) | indexing (collection exists, filling up, search partial) | done',
  }),
  collection: Type.String(),
  schemeVersion: Type.Integer({
    description: 'BM25 scheme version the rebuilt collection is stamped with.',
  }),
  usersTotal: Type.Integer(),
  usersDone: Type.Integer(),
  filesProcessed: Type.Integer(),
  errors: Type.Array(Type.String()),
  // Total failures observed; `errors` retains only the first 100 messages.
  errorCount: Type.Integer(),
  startedAt: Type.String(),
  finishedAt: Type.Union([Type.String(), Type.Null()]),
});

export type RebuildStatusResponse = Static<typeof RebuildStatusResponseSchema>;

export const collectionInfoSchema = {
  description:
    'Name and BM25 scheme version of the physical collection behind the search alias. Read this before a rebuild — the operator has to type "collection" back to confirm.',
  response: {
    200: CollectionInfoResponseSchema,
    401: ErrorResponseSchema,
    500: ErrorResponseSchema,
  },
};

export const rebuildSchema = {
  description:
    'DESTRUCTIVE. Drops the physical collection — every registered user loses every vector, not just the caller — re-creates it with the current schema and BM25 scheme marker, then re-indexes every user vault. Search returns nothing from the drop until indexing completes. Guarded only by "confirm", which must equal the physical collection name.',
  body: RebuildRequestBodySchema,
  response: {
    202: RebuildResponseSchema,
    400: ErrorResponseSchema,
    401: ErrorResponseSchema,
    409: ErrorResponseSchema,
    500: ErrorResponseSchema,
  },
};

export const rebuildStatusSchema = {
  description: 'Progress of a rebuild job. "phase" says whether the collection currently exists.',
  querystring: RebuildStatusQuerySchema,
  response: {
    200: RebuildStatusResponseSchema,
    400: ErrorResponseSchema,
    401: ErrorResponseSchema,
    404: ErrorResponseSchema,
    500: ErrorResponseSchema,
  },
};

export { ErrorResponseSchema };
