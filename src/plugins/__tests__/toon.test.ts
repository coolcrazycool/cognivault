import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { decode, encode } from '@toon-format/toon';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Set env vars before any module imports that trigger config parsing
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'toon-test-'));
const vaultRoot = path.join(tmpDir, 'vault');
await fs.mkdir(vaultRoot, { recursive: true });

process.env.COGNIVAULT_API_KEY = 'test-api-key';
process.env.VAULT_PATH = vaultRoot;
process.env.OPENAI_API_KEY = 'test-openai-key';

// Import plugins after env vars are set
const { default: errorHandler } = await import('../error-handler.js');
const { default: authPlugin } = await import('../auth.js');

const API_KEY = 'test-api-key';

/**
 * Build a minimal Fastify app with only error-handler, auth, and toon plugins.
 * No infrastructure (db, qdrant, embedding) so tests run without real services.
 */
async function buildMinimalApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(errorHandler);
  await app.register(authPlugin);

  // toon plugin will be imported here — it fails (RED phase) until we create it
  const { default: toonPlugin } = await import('../toon.js');
  await app.register(toonPlugin);

  // Test routes
  app.post(
    '/test',
    {
      config: {},
      schema: {
        body: {
          type: 'object',
          properties: { query: { type: 'string' } },
          additionalProperties: true,
        },
      },
    },
    async (request) => {
      return request.body;
    },
  );

  app.get('/test', { config: {} }, async () => {
    return { data: 'hello' };
  });

  // Health route with skipAuth (mirrors real app)
  app.get('/health', { config: { skipAuth: true } }, async () => {
    return { status: 'ok' };
  });

  await app.ready();
  return app;
}

describe('TOON content negotiation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildMinimalApp();
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('Request parsing', () => {
    it('POST with Content-Type text/toon decodes body and handler receives parsed object', async () => {
      const payload = encode({ query: 'hello world' });
      const response = await app.inject({
        method: 'POST',
        url: '/test',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'text/toon',
          accept: 'application/json',
        },
        payload,
      });

      // Note: Content-Type: text/toon triggers format symmetry — response is also TOON
      expect(response.statusCode).toBe(200);
      const decoded = decode(response.body) as Record<string, unknown>;
      expect(decoded.query).toBe('hello world');
    });

    it('POST with Content-Type text/toon; charset=utf-8 is accepted (regex matching)', async () => {
      const payload = encode({ query: 'charset test' });
      const response = await app.inject({
        method: 'POST',
        url: '/test',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'text/toon; charset=utf-8',
          accept: 'application/json',
        },
        payload,
      });

      // Note: Content-Type: text/toon triggers format symmetry — response is also TOON
      expect(response.statusCode).toBe(200);
      const decoded = decode(response.body) as Record<string, unknown>;
      expect(decoded.query).toBe('charset test');
    });

    it('POST with invalid TOON body returns 400 with code INVALID_TOON', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/test',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'text/toon',
          accept: 'application/json',
        },
        payload: '!@#$%^& this is not valid toon [[[',
      });

      // Error handler will check Content-Type header for format symmetry
      // content-type: text/toon means error is TOON-serialized
      expect(response.statusCode).toBe(400);
      const decoded = decode(response.body) as Record<string, unknown>;
      const error = decoded.error as Record<string, unknown>;
      expect(error).toBeDefined();
      expect(error.code).toBe('INVALID_TOON');
    });
  });

  describe('Response serialization', () => {
    it('GET with Accept: text/toon returns Content-Type text/toon and TOON-encoded body', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/test',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          accept: 'text/toon',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/toon/);
      const decoded = decode(response.body);
      expect(decoded).toMatchObject({ data: 'hello' });
    });

    it('GET with Accept: application/json returns JSON', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/test',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          accept: 'application/json',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      const body = response.json();
      expect(body.data).toBe('hello');
    });

    it('GET without Accept header returns JSON (default)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/test',
        headers: {
          authorization: `Bearer ${API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      const body = response.json();
      expect(body.data).toBe('hello');
    });

    it('GET with unsupported Accept (text/xml) falls back to JSON', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/test',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          accept: 'text/xml',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      const body = response.json();
      expect(body.data).toBe('hello');
    });

    it('POST with Content-Type: text/toon (no Accept header) returns TOON response (format symmetry)', async () => {
      const payload = encode({ query: 'symmetry test' });
      const response = await app.inject({
        method: 'POST',
        url: '/test',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'text/toon',
          // No Accept header
        },
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/toon/);
      const decoded = decode(response.body);
      expect(decoded).toMatchObject({ query: 'symmetry test' });
    });
  });

  describe('Health endpoint exclusion', () => {
    it('Health endpoint with Accept: text/toon still returns JSON', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: {
          accept: 'text/toon',
        },
      });

      expect(response.statusCode).toBe(200);
      // Health uses skipAuth config, so TOON encoding is skipped
      expect(response.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('Error response TOON-awareness', () => {
    it('401 error with Accept: text/toon returns TOON-serialized error with UNAUTHORIZED code', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/test',
        headers: {
          accept: 'text/toon',
          // No authorization
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers['content-type']).toMatch(/text\/toon/);
      const decoded = decode(response.body) as Record<string, unknown>;
      const error = decoded.error as Record<string, unknown>;
      expect(error).toBeDefined();
      expect(error.code).toBe('UNAUTHORIZED');
    });

    it('401 error with Content-Type: text/toon (no Accept) returns TOON-serialized error (format symmetry)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/test',
        headers: {
          'content-type': 'text/toon',
          // No authorization, no Accept
        },
        payload: encode({ query: 'test' }),
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers['content-type']).toMatch(/text\/toon/);
      const decoded = decode(response.body) as Record<string, unknown>;
      const error = decoded.error as Record<string, unknown>;
      expect(error).toBeDefined();
      expect(error.code).toBe('UNAUTHORIZED');
    });

    it('401 error without Accept: text/toon returns JSON error (unchanged behavior)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/test',
        headers: {
          accept: 'application/json',
          // No authorization
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      const body = response.json();
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('400 invalid TOON body with Accept: text/toon returns TOON-serialized error', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/test',
        headers: {
          authorization: `Bearer ${API_KEY}`,
          'content-type': 'text/toon',
          accept: 'text/toon',
        },
        payload: '!@#$%^& invalid toon body [[[',
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toMatch(/text\/toon/);
      const decoded = decode(response.body) as Record<string, unknown>;
      const error = decoded.error as Record<string, unknown>;
      expect(error).toBeDefined();
      expect(error.code).toBe('INVALID_TOON');
    });
  });
});
