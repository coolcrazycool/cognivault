import type { FastifyInstance } from 'fastify';
import { VaultError } from '../../lib/vault.js';
import { metadataSchema } from './schemas.js';
import type { MetadataQuery } from './schemas.js';

export async function vaultRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: MetadataQuery }>(
    '/metadata',
    { schema: metadataSchema },
    async (request, reply) => {
      try {
        const result = await fastify.vault.readMetadata(request.query.path);
        return result;
      } catch (err: unknown) {
        if (err instanceof VaultError) {
          return reply.status(err.statusCode).send({
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    },
  );
}
