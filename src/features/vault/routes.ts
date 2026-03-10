import type { FastifyInstance, FastifyReply } from 'fastify';
import { VaultError } from '../../lib/vault.js';
import type {
  AppendContentBody,
  ContentQuery,
  CreateNoteBody,
  ListFilesQuery,
  MetadataQuery,
  UpdateContentBody,
} from './schemas.js';
import {
  appendContentSchema,
  contentSchema,
  createNoteSchema,
  listFilesSchema,
  metadataSchema,
  updateContentSchema,
} from './schemas.js';

function handleVaultError(err: unknown, reply: FastifyReply): void {
  if (err instanceof VaultError) {
    reply.status(err.statusCode).send({
      error: { code: err.code, message: err.message },
    });
    return;
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
        handleVaultError(err, reply);
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
        handleVaultError(err, reply);
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
        handleVaultError(err, reply);
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
        handleVaultError(err, reply);
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
        handleVaultError(err, reply);
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
        handleVaultError(err, reply);
      }
    },
  );
}
