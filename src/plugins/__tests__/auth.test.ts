import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Create a real temp vault directory so vault plugin can initialize
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-test-'));
const vaultRoot = path.join(tmpDir, 'vault');
await fs.mkdir(vaultRoot, { recursive: true });

// Set env vars before any module imports that trigger config parsing
process.env.COGNIVAULT_API_KEY = 'test-api-key';
process.env.VAULT_PATH = vaultRoot;

const { buildApp } = await import('../../app.js');

describe('auth plugin', () => {
  let app: FastifyInstance;
  const API_KEY = 'test-api-key';

  beforeAll(async () => {
    app = await buildApp({ logger: false });

    // Register a test-only protected route (no skipAuth config)
    app.get('/test-protected', async (_request, _reply) => {
      return { ok: true };
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects requests without Authorization header with 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test-protected',
    });
    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).toBeDefined();
  });

  it('rejects requests with invalid Bearer token with 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test-protected',
      headers: {
        authorization: 'Bearer wrong-key',
      },
    });
    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('accepts requests with valid Bearer token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test-protected',
      headers: {
        authorization: `Bearer ${API_KEY}`,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('health endpoint still returns 200 without auth (regression)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ok');
  });
});
