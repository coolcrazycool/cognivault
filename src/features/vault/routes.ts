import type { FastifyInstance, FastifyReply } from 'fastify';
import { VaultError } from '../../lib/vault.js';
import { contentSchema, listFilesSchema, metadataSchema } from './schemas.js';
import type { ContentQuery, ListFilesQuery, MetadataQuery } from './schemas.js';

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
}
