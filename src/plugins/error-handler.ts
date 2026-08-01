import { encode } from '@toon-format/toon';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { isHttpError } from '../lib/http-error.js';

function mapErrorToCode(statusCode: number, error: FastifyError): string {
  // An error built by `httpError()` names its own code and is answering a question the
  // caller asked — it wins over every mapping below, including the 5xx default.
  if (isHttpError(error)) {
    return error.code;
  }
  // Check for custom error codes set by plugins FIRST (e.g., INVALID_TOON from toon content parser)
  // This must come before the validation check because Fastify may wrap parser errors with validation metadata
  const errWithCode = error as FastifyError & { code?: string };
  if (errWithCode.code === 'INVALID_TOON') {
    return 'INVALID_TOON';
  }
  // Also check the cause chain for the INVALID_TOON code
  const cause = (error as FastifyError & { cause?: { code?: string } }).cause;
  if (cause?.code === 'INVALID_TOON') {
    return 'INVALID_TOON';
  }
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
  fastify.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = error.statusCode ?? 500;
    const code = mapErrorToCode(statusCode, error);
    // 5xx messages are swallowed because they usually leak internals. A deliberate
    // `httpError()` is the exception: its text is the whole point of the response — a
    // 503 that says only "Internal server error" would send the operator hunting for a
    // bug instead of pressing the button that fixes it.
    const message =
      statusCode >= 500 && !isHttpError(error) ? 'Internal server error' : error.message;

    fastify.log.error(error);

    const payload = {
      error: {
        code,
        message,
      },
    };

    const accept = request.headers.accept ?? '';
    const contentType = request.headers['content-type'] ?? '';
    const wantToon = accept.includes('text/toon') || contentType.includes('text/toon');

    // Check if this is a health/readiness route — those always return JSON
    // Auth 401 errors flow through here — TOON-awareness applies to all error codes including UNAUTHORIZED
    const routeConfig = request.routeOptions?.config as unknown as
      | Record<string, unknown>
      | undefined;
    const isHealthRoute = routeConfig?.skipAuth === true;

    if (wantToon && !isHealthRoute) {
      reply.header('Content-Type', 'text/toon');
      return reply.status(statusCode).send(encode(payload));
    }

    return reply.status(statusCode).send(payload);
  });
}

export default fp(errorHandlerPlugin, {
  name: 'error-handler',
});
