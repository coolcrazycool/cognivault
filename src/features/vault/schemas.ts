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

// ── Upload (zip archive → user vault) ──

export const UploadResponseSchema = Type.Object({
  uploaded: Type.Number(),
  skipped: Type.Number(),
  files: Type.Array(Type.String()),
});

export type UploadResponse = Static<typeof UploadResponseSchema>;

// Body is multipart/form-data (a single zip file), so no TypeBox body schema.
export const uploadSchema = {
  response: {
    200: UploadResponseSchema,
    400: ErrorResponseSchema,
    403: ErrorResponseSchema,
    404: ErrorResponseSchema,
    413: ErrorResponseSchema,
  },
};

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

// ── Create Note ──

export const CreateNoteBodySchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  content: Type.String(),
  frontmatter: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export type CreateNoteBody = Static<typeof CreateNoteBodySchema>;

export const CreateNoteResponseSchema = Type.Object({
  path: Type.String(),
  created: Type.Literal(true),
});

export type CreateNoteResponse = Static<typeof CreateNoteResponseSchema>;

// ── Update Content ──

export const UpdateContentBodySchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  content: Type.String(),
});

export type UpdateContentBody = Static<typeof UpdateContentBodySchema>;

export const UpdateContentResponseSchema = Type.Object({
  path: Type.String(),
  updated: Type.Literal(true),
});

export type UpdateContentResponse = Static<typeof UpdateContentResponseSchema>;

// ── Append Content ──

export const AppendContentBodySchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  content: Type.String(),
  mode: Type.Union([Type.Literal('append'), Type.Literal('prepend')]),
});

export type AppendContentBody = Static<typeof AppendContentBodySchema>;

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

export const createNoteSchema = {
  body: CreateNoteBodySchema,
  response: {
    201: CreateNoteResponseSchema,
    403: ErrorResponseSchema,
    404: ErrorResponseSchema,
    409: ErrorResponseSchema,
  },
};

export const updateContentSchema = {
  body: UpdateContentBodySchema,
  response: {
    200: UpdateContentResponseSchema,
    403: ErrorResponseSchema,
    404: ErrorResponseSchema,
  },
};

export const appendContentSchema = {
  body: AppendContentBodySchema,
  response: {
    200: UpdateContentResponseSchema,
    403: ErrorResponseSchema,
    404: ErrorResponseSchema,
  },
};

// ── Delete Note ──

export const DeleteNoteBodySchema = Type.Object({
  path: Type.String({ minLength: 1 }),
});

export type DeleteNoteBody = Static<typeof DeleteNoteBodySchema>;

export const DeleteNoteResponseSchema = Type.Object({
  path: Type.String(),
  deleted: Type.Literal(true),
});

export type DeleteNoteResponse = Static<typeof DeleteNoteResponseSchema>;

// ── Move Note ──

export const MoveNoteBodySchema = Type.Object({
  from: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
});

export type MoveNoteBody = Static<typeof MoveNoteBodySchema>;

export const MoveNoteResponseSchema = Type.Object({
  from: Type.String(),
  to: Type.String(),
});

export type MoveNoteResponse = Static<typeof MoveNoteResponseSchema>;

// ── Route schema objects for delete and move ──

export const deleteNoteSchema = {
  body: DeleteNoteBodySchema,
  response: {
    200: DeleteNoteResponseSchema,
    403: ErrorResponseSchema,
    404: ErrorResponseSchema,
  },
};

export const moveNoteSchema = {
  body: MoveNoteBodySchema,
  response: {
    200: MoveNoteResponseSchema,
    403: ErrorResponseSchema,
    404: ErrorResponseSchema,
    409: ErrorResponseSchema,
  },
};

// ── Update Metadata ──

export const UpdateMetadataBodySchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  metadata: Type.Record(Type.String(), Type.Union([Type.Unknown(), Type.Null()])),
});

export type UpdateMetadataBody = Static<typeof UpdateMetadataBodySchema>;

export const UpdateMetadataResponseSchema = Type.Object({
  path: Type.String(),
  metadata: Type.Record(Type.String(), Type.Unknown()),
});

export type UpdateMetadataResponse = Static<typeof UpdateMetadataResponseSchema>;

export const updateMetadataSchema = {
  body: UpdateMetadataBodySchema,
  response: {
    200: UpdateMetadataResponseSchema,
    403: ErrorResponseSchema,
    404: ErrorResponseSchema,
  },
};
