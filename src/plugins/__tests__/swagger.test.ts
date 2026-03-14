import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Registry as PromRegistry } from 'prom-client';

// Set env vars before any module imports that trigger config parsing
process.env.VAULT_PATH = '/tmp/test-vault-swagger';
process.env.COGNIVAULT_DATA_DIR = '/tmp/test-cognivault-swagger';
process.env.OPENAI_API_KEY = 'test-openai-key';

// ── Mock external services to avoid real network calls ──

const mockQdrant = {
  search: vi.fn().mockResolvedValue([]),
  scroll: vi.fn().mockResolvedValue({ points: [] }),
  getCollections: vi.fn().mockResolvedValue({ collections: [] }),
  createCollection: vi.fn().mockResolvedValue({}),
  createPayloadIndex: vi.fn().mockResolvedValue({}),
};

const mockEmbedder = {
  embed: vi.fn().mockResolvedValue([]),
  dimensions: 1536,
  validate: vi.fn().mockResolvedValue(undefined),
};

async function buildTestApp(): Promise<FastifyInstance> {
  const { default: Fastify } = await import('fastify');
  const { default: fp } = await import('fastify-plugin');

  const app = Fastify({ logger: false });

  // Mock metrics plugin (named, for auth dependency resolution)
  await app.register(
    fp(
      async (f) => {
        const promRegistry = new PromRegistry();
        f.decorate('metrics', { promRegistry } as unknown as FastifyInstance['metrics']);
      },
      { name: 'metrics' },
    ),
  );

  // Mock registry plugin (named, for auth dependency resolution)
  await app.register(
    fp(
      async (f) => {
        f.decorate('registry', {
          getUserByApiKey: () => undefined,
        } as unknown as FastifyInstance['registry']);
      },
      { name: 'registry' },
    ),
  );

  // Register error handler
  const { default: errorHandler } = await import('../../plugins/error-handler.js');
  await app.register(errorHandler);

  // Register auth plugin
  const { default: authPlugin } = await import('../../plugins/auth.js');
  await app.register(authPlugin);

  // Register swagger plugin
  const { default: swaggerPlugin } = await import('../../plugins/swagger.js');
  await app.register(swaggerPlugin);

  // Register mock vault plugin (stub)
  await app.register(
    fp(async (fastify) => {
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      fastify.decorate('vault', {} as any);
    }),
  );

  // Register health routes (for path assertions in spec)
  const { healthRoutes } = await import('../../features/health/routes.js');
  await app.register(healthRoutes);

  // Register mock db plugin (stub)
  await app.register(
    fp(async (fastify) => {
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      fastify.decorate('db', {} as any);
    }),
  );

  // Register mock embedder plugin (stub)
  await app.register(
    fp(async (fastify) => {
      // biome-ignore lint/suspicious/noExplicitAny: test stub — avoids real OpenAI calls
      fastify.decorate('embedder', mockEmbedder as any);
    }),
  );

  // Register mock qdrant plugin (stub)
  await app.register(
    fp(async (fastify) => {
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      fastify.decorate('qdrant', mockQdrant as any);
    }),
  );

  // Register mock indexer (stub)
  await app.register(
    fp(async (fastify) => {
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      fastify.decorate('indexer', { isIndexing: false } as any);
    }),
  );

  // Register vault routes for complete API surface
  const { vaultRoutes } = await import('../../features/vault/routes.js');
  await app.register(vaultRoutes, { prefix: '/api/vault' });

  // Register search routes for complete API surface
  const { searchRoutes } = await import('../../features/search/routes.js');
  await app.register(searchRoutes, { prefix: '/api/vault/search' });

  // Register context routes for complete API surface
  const { contextRoutes } = await import('../../features/context/routes.js');
  await app.register(contextRoutes, { prefix: '/api/vault' });

  await app.ready();
  return app;
}

describe('Swagger / OpenAPI Plugin', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /docs returns 200 with Swagger UI HTML', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.body.toLowerCase()).toContain('swagger');
  });

  it('GET /docs/json returns 200 with valid OpenAPI JSON', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs/json',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);

    const spec = JSON.parse(response.body) as Record<string, unknown>;
    expect(spec).toHaveProperty('openapi');
    expect(spec).toHaveProperty('info');
    expect(spec).toHaveProperty('paths');
  });

  it('GET /docs/yaml returns 200 with YAML content-type', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs/yaml',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/yaml|yml/i);
  });

  it('GET /docs without auth header returns 200 (no auth required)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs',
      // No Authorization header
    });
    expect(response.statusCode).toBe(200);
  });

  it('OpenAPI spec includes bearerAuth security scheme', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs/json',
    });
    const spec = JSON.parse(response.body) as {
      components?: { securitySchemes?: Record<string, unknown> };
      security?: unknown[];
    };

    expect(spec.components?.securitySchemes).toHaveProperty('bearerAuth');
    const bearerScheme = spec.components?.securitySchemes?.bearerAuth as Record<string, unknown>;
    expect(bearerScheme?.type).toBe('http');
    expect(bearerScheme?.scheme).toBe('bearer');
  });

  it('OpenAPI spec includes at least one path from feature routes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs/json',
    });
    const spec = JSON.parse(response.body) as { paths?: Record<string, unknown> };
    expect(spec.paths).toBeDefined();
    expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0);
  });

  it('OpenAPI spec lists text/toon as supported content type', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs/json',
    });
    // text/toon must appear somewhere in the spec
    expect(response.body).toContain('text/toon');
  });
});
