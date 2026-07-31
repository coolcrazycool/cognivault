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

export { ErrorResponseSchema };
