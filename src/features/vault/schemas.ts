import { type Static, Type } from '@sinclair/typebox';

// ── Shared schemas ──

const VaultEntrySchema = Type.Object({
  name: Type.String(),
  path: Type.String(),
  type: Type.Union([Type.Literal('file'), Type.Literal('directory')]),
});

export type VaultEntry = Static<typeof VaultEntrySchema>;

export const ErrorResponseSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
  }),
});

export type ErrorResponse = Static<typeof ErrorResponseSchema>;

// ── List Files ──

export const ListFilesQuerySchema = Type.Object({
  path: Type.Optional(Type.String({ default: '' })),
  recursive: Type.Optional(Type.Boolean({ default: false })),
  ext: Type.Optional(Type.String()),
});

export type ListFilesQuery = Static<typeof ListFilesQuerySchema>;

export const ListFilesResponseSchema = Type.Object({
  entries: Type.Array(VaultEntrySchema),
});

export type ListFilesResponse = Static<typeof ListFilesResponseSchema>;

// ── Content ──

export const ContentQuerySchema = Type.Object({
  path: Type.String(),
});

export type ContentQuery = Static<typeof ContentQuerySchema>;

export const ContentResponseSchema = Type.Object({
  path: Type.String(),
  content: Type.String(),
});

export type ContentResponse = Static<typeof ContentResponseSchema>;

// ── Metadata ──

export const MetadataQuerySchema = Type.Object({
  path: Type.String(),
});

export type MetadataQuery = Static<typeof MetadataQuerySchema>;

export const MetadataResponseSchema = Type.Object({
  path: Type.String(),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  warning: Type.Optional(Type.String()),
});

export type MetadataResponse = Static<typeof MetadataResponseSchema>;

// ── Route schema objects ──

export const listFilesSchema = {
  querystring: ListFilesQuerySchema,
  response: {
    200: ListFilesResponseSchema,
    403: ErrorResponseSchema,
  },
};

export const contentSchema = {
  querystring: ContentQuerySchema,
  response: {
    200: ContentResponseSchema,
    403: ErrorResponseSchema,
    404: ErrorResponseSchema,
    415: ErrorResponseSchema,
  },
};

export const metadataSchema = {
  querystring: MetadataQuerySchema,
  response: {
    200: MetadataResponseSchema,
    403: ErrorResponseSchema,
    404: ErrorResponseSchema,
  },
};
