import { decode, encode } from '@toon-format/toon';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

async function toonPlugin(fastify: FastifyInstance): Promise<void> {
  // Parse text/toon request bodies (regex handles charset suffixes like text/toon; charset=utf-8)
  fastify.addContentTypeParser(
    /^text\/toon/,
    { parseAs: 'string' },
    (_req: FastifyRequest, body: string, done: (err: Error | null, body?: unknown) => void) => {
      try {
        const parsed = decode(body);
        // If the decoded result is a primitive string, the input did not parse as structured TOON.
        // Reject as invalid TOON body (structured data is expected for API requests).
        if (typeof parsed === 'string') {
          const parseErr = Object.assign(new Error('Invalid TOON body: expected object or array'), {
            statusCode: 400 as number,
            code: 'INVALID_TOON',
          });
          done(parseErr, undefined);
          return;
        }
        done(null, parsed);
      } catch (err) {
        const parseErr = Object.assign(
          new Error(err instanceof Error ? err.message : 'Invalid TOON body'),
          {
            statusCode: 400 as number,
            code: 'INVALID_TOON',
          },
        );
        done(parseErr, undefined);
      }
    },
  );

  // Serialize responses as TOON when client requests it
  fastify.addHook(
    'onSend',
    async (request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> => {
      // Skip TOON encoding for health/readiness routes (skipAuth routes return JSON always)
      const routeConfig = request.routeOptions?.config as unknown as Record<string, unknown> | undefined;
      if (routeConfig?.skipAuth) {
        return payload;
      }

      const accept = request.headers.accept ?? '';
      const contentType = request.headers['content-type'] ?? '';

      // TOON is requested if: Accept contains text/toon, OR Content-Type is text/toon (format symmetry)
      const wantToon = accept.includes('text/toon') || contentType.includes('text/toon');

      if (!wantToon) {
        return payload;
      }

      // Parse the JSON payload and re-encode as TOON
      if (typeof payload !== 'string') {
        return payload;
      }

      let obj: unknown;
      try {
        obj = JSON.parse(payload);
      } catch {
        // Not JSON, return as-is
        return payload;
      }

      // Encode to TOON — on failure, re-throw (per locked decision: no silent fallback)
      const toonBody = encode(obj);
      reply.header('Content-Type', 'text/toon');
      return toonBody;
    },
  );
}

export default fp(toonPlugin, {
  name: 'toon',
});
