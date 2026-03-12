import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

// Health endpoints that should not have text/toon documented
const HEALTH_PATHS = new Set(['/health', '/ready']);

interface OpenApiContent {
  [mediaType: string]: unknown;
}

interface OpenApiResponse {
  content?: OpenApiContent;
  [key: string]: unknown;
}

interface OpenApiRequestBody {
  content?: OpenApiContent;
  [key: string]: unknown;
}

interface OpenApiMethod {
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, OpenApiResponse>;
  [key: string]: unknown;
}

interface OpenApiPath {
  [method: string]: OpenApiMethod;
}

interface OpenApiObject {
  paths?: Record<string, OpenApiPath>;
  [key: string]: unknown;
}

/**
 * Inject text/toon as an accepted content type alongside application/json
 * in all non-health paths of the OpenAPI spec.
 */
function injectToonContentType(openapiObject: OpenApiObject): OpenApiObject {
  if (!openapiObject.paths) {
    return openapiObject;
  }

  for (const [path, pathItem] of Object.entries(openapiObject.paths)) {
    if (HEALTH_PATHS.has(path)) {
      continue;
    }

    for (const [method, operation] of Object.entries(pathItem)) {
      if (method === 'parameters' || typeof operation !== 'object' || operation === null) {
        continue;
      }

      const op = operation as OpenApiMethod;

      // Inject into requestBody content types
      if (op.requestBody?.content?.['application/json']) {
        op.requestBody.content['text/toon'] = {
          ...op.requestBody.content['application/json'],
        };
      }

      // Inject into response content types
      if (op.responses) {
        for (const response of Object.values(op.responses)) {
          if (response.content?.['application/json']) {
            response.content['text/toon'] = {
              ...response.content['application/json'],
            };
          }
        }
      }
    }
  }

  return openapiObject;
}

async function swaggerPlugin(fastify: FastifyInstance): Promise<void> {
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'CogniVault API',
        description:
          'Knowledge access layer for AI agents. Supports application/json and text/toon content types.',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    transformObject(documentObject) {
      // For OpenAPI 3.0 docs, documentObject has openapiObject; for Swagger 2.0, swaggerObject
      if ('openapiObject' in documentObject) {
        return injectToonContentType(
          documentObject.openapiObject as OpenApiObject,
        ) as typeof documentObject.openapiObject;
      }
      return documentObject.swaggerObject;
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiHooks: {
      onRequest(_req, _reply, next) {
        next();
      },
    },
  });
}

export default fp(swaggerPlugin, {
  name: 'swagger',
});
