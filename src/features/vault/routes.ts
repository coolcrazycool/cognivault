import type { FastifyInstance, FastifyReply } from 'fastify';
import { VaultError } from '../../lib/vault.js';
import type {
  AppendContentBody,
  ContentQuery,
  CreateNoteBody,
  DeleteNoteBody,
  ListFilesQuery,
  MetadataQuery,
  MoveNoteBody,
  UpdateContentBody,
  UpdateMetadataBody,
} from './schemas.js';
import {
  appendContentSchema,
  contentSchema,
  createNoteSchema,
  deleteNoteSchema,
  listFilesSchema,
  metadataSchema,
  moveNoteSchema,
  updateContentSchema,
  updateMetadataSchema,
} from './schemas.js';

function handleVaultError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof VaultError) {
    return reply.status(err.statusCode).send({
      error: { code: err.code, message: err.message },
    });
  }
  throw err;
}

export async function vaultRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: ListFilesQuery }>(
    '/files',
    { schema: listFilesSchema },
    async (request, reply) => {
      try {
        const { path, recursive, ext } = request.query;
        const result = await fastify.vault.listFiles({ path, recursive, ext });
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );

  fastify.get<{ Querystring: ContentQuery }>(
    '/content',
    { schema: contentSchema },
    async (request, reply) => {
      try {
        const result = await fastify.vault.readContent(request.query.path);
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );

  fastify.get<{ Querystring: MetadataQuery }>(
    '/metadata',
    { schema: metadataSchema },
    async (request, reply) => {
      try {
        const result = await fastify.vault.readMetadata(request.query.path);
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );

  fastify.post<{ Body: CreateNoteBody }>(
    '/content',
    { schema: createNoteSchema },
    async (request, reply) => {
      try {
        const { path, content, frontmatter } = request.body;
        const result = await fastify.vault.createNote(path, content, frontmatter);
        reply.status(201);
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );

  fastify.put<{ Body: UpdateContentBody }>(
    '/content',
    { schema: updateContentSchema },
    async (request, reply) => {
      try {
        const { path, content } = request.body;
        const result = await fastify.vault.updateContent(path, content);
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );

  fastify.patch<{ Body: AppendContentBody }>(
    '/content',
    { schema: appendContentSchema },
    async (request, reply) => {
      try {
        const { path, content, mode } = request.body;
        const result = await fastify.vault.appendContent(path, content, mode);
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );

  fastify.delete<{ Body: DeleteNoteBody }>(
    '/content',
    { schema: deleteNoteSchema },
    async (request, reply) => {
      try {
        const { path } = request.body;
        const result = await fastify.vault.deleteNote(path);
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );

  fastify.post<{ Body: MoveNoteBody }>(
    '/move',
    { schema: moveNoteSchema },
    async (request, reply) => {
      try {
        const { from, to } = request.body;
        const result = await fastify.vault.moveNote(from, to);
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );

  fastify.patch<{ Body: UpdateMetadataBody }>(
    '/metadata',
    { schema: updateMetadataSchema },
    async (request, reply) => {
      try {
        const { path, metadata } = request.body;
        const result = await fastify.vault.updateMetadata(path, metadata);
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );
}
