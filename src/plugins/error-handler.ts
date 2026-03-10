import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

function mapErrorToCode(statusCode: number, error: FastifyError): string {
  if (error.validation) {
    return 'VALIDATION_ERROR';
  }
  switch (statusCode) {
    case 401:
      return 'UNAUTHORIZED';
    case 404:
      return 'NOT_FOUND';
    default:
      return 'INTERNAL_ERROR';
  }
}

async function errorHandlerPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = error.statusCode ?? 500;
    const code = mapErrorToCode(statusCode, error);
    const message = statusCode >= 500 ? 'Internal server error' : error.message;

    fastify.log.error(error);

    return reply.status(statusCode).send({
      error: {
        code,
        message,
      },
    });
  });
}

export default fp(errorHandlerPlugin, {
  name: 'error-handler',
});
