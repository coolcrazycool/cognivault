import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Create a real temp vault directory so vault plugin initializes correctly
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swagger-test-'));
const vaultRoot = path.join(tmpDir, 'vault');
await fs.mkdir(vaultRoot, { recursive: true });

// Set env vars before any module imports that trigger config parsing
process.env.COGNIVAULT_API_KEY = 'test-api-key';
process.env.VAULT_PATH = vaultRoot;
process.env.COGNIVAULT_DATA_DIR = path.join(tmpDir, 'data');
process.env.OPENAI_API_KEY = 'test-openai-key';

const { buildApp } = await import('../../app.js');

describe('Swagger / OpenAPI Plugin', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
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
    const bearerScheme = spec.components?.securitySchemes?.['bearerAuth'] as Record<
      string,
      unknown
    >;
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
