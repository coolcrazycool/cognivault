import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { VaultManager } from '../../lib/vault.js';
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

function getUserVault(fastify: FastifyInstance, request: FastifyRequest): VaultManager {
  // v2.0 multi-tenant: get per-user vault from indexer
  const userId = request.user?.userId;
  if (userId) {
    const entry = fastify.indexers.get(userId);
    if (entry) {
      return entry.vault;
    }
  }
  // v1.0 fallback: global vault
  if (fastify.vault) {
    return fastify.vault;
  }
  throw new VaultError('No vault available for this user', 'VAULT_NOT_FOUND', 404);
}

export async function vaultRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: ListFilesQuery }>(
    '/files',
    { schema: listFilesSchema },
    async (request, reply) => {
      try {
        const vault = getUserVault(fastify, request);
        const { path, recursive, ext } = request.query;
        const result = await vault.listFiles({ path, recursive, ext });
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
        const vault = getUserVault(fastify, request);
        const result = await vault.readContent(request.query.path);
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
        const vault = getUserVault(fastify, request);
        const result = await vault.readMetadata(request.query.path);
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
        const vault = getUserVault(fastify, request);
        const { path, content, frontmatter } = request.body;
        const result = await vault.createNote(path, content, frontmatter);
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
        const vault = getUserVault(fastify, request);
        const { path, content } = request.body;
        const result = await vault.updateContent(path, content);
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
        const vault = getUserVault(fastify, request);
        const { path, content, mode } = request.body;
        const result = await vault.appendContent(path, content, mode);
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
        const vault = getUserVault(fastify, request);
        const { path } = request.body;
        const result = await vault.deleteNote(path);
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
        const vault = getUserVault(fastify, request);
        const { from, to } = request.body;
        const result = await vault.moveNote(from, to);
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
        const vault = getUserVault(fastify, request);
        const { path, metadata } = request.body;
        const result = await vault.updateMetadata(path, metadata);
        return result;
      } catch (err: unknown) {
        return handleVaultError(err, reply);
      }
    },
  );
}
