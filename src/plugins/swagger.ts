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
 * Convert a JSON schema example object to TOON format string.
 * Handles nested objects and arrays.
 */
function jsonToToon(obj: Record<string, unknown>, indent = 0): string {
  const prefix = '  '.repeat(indent);
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${prefix}${key}:`);
      lines.push(jsonToToon(value as Record<string, unknown>, indent + 1));
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] === 'object' && value[i] !== null) {
          lines.push(`${prefix}${key}[${i + 1}]:`);
          lines.push(jsonToToon(value[i] as Record<string, unknown>, indent + 1));
        } else {
          lines.push(`${prefix}${key}[${i + 1}]: ${String(value[i])}`);
        }
      }
    } else {
      lines.push(`${prefix}${key}: ${String(value)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Build a sample object from a JSON Schema, using defaults and reasonable placeholders.
 */
function buildSample(schema: Record<string, unknown>): unknown {
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;

  const type = schema.type as string | undefined;
  if (type === 'object') {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set((schema.required ?? []) as string[]);
    const result: Record<string, unknown> = {};
    for (const [key, propSchema] of Object.entries(props)) {
      // Include required fields and optional fields with defaults
      if (required.has(key) || propSchema.default !== undefined) {
        result[key] = buildSample(propSchema);
      }
    }
    return result;
  }
  if (type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) return [buildSample(items)];
    return [];
  }
  if (type === 'integer') return schema.default ?? 10;
  if (type === 'number') return schema.default ?? 0.5;
  if (type === 'string') return 'example';
  if (type === 'boolean') return false;
  // Union types — pick first
  if (Array.isArray(schema.anyOf)) {
    return buildSample(schema.anyOf[0] as Record<string, unknown>);
  }
  return 'string';
}

/**
 * Inject text/toon as an accepted content type alongside application/json
 * in all non-health paths of the OpenAPI spec.
 * TOON entries use a string example in TOON format instead of JSON schema.
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
        const jsonContent = op.requestBody.content['application/json'] as Record<string, unknown>;
        const jsonSchema = jsonContent.schema as Record<string, unknown> | undefined;
        const sample = jsonSchema ? buildSample(jsonSchema) : {};
        const toonExample = jsonToToon(sample as Record<string, unknown>);

        op.requestBody.content['text/toon'] = {
          schema: { type: 'string' },
          example: toonExample,
        };
      }

      // Inject into response content types
      if (op.responses) {
        for (const response of Object.values(op.responses)) {
          if (response.content?.['application/json']) {
            const jsonContent = response.content['application/json'] as Record<string, unknown>;
            const jsonSchema = jsonContent.schema as Record<string, unknown> | undefined;
            const sample = jsonSchema ? buildSample(jsonSchema) : {};
            const toonExample = jsonToToon(sample as Record<string, unknown>);

            response.content['text/toon'] = {
              schema: { type: 'string' },
              example: toonExample,
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
