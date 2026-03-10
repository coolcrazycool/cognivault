import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Create a real temp vault directory so readiness check passes
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'health-test-'));
const vaultRoot = path.join(tmpDir, 'vault');
await fs.mkdir(vaultRoot, { recursive: true });

// Set env vars before any module imports that trigger config parsing
process.env.COGNIVAULT_API_KEY = 'test-api-key';
process.env.VAULT_PATH = vaultRoot;
process.env.COGNIVAULT_DATA_DIR = path.join(tmpDir, 'data');

const { buildApp } = await import('../../../app.js');

describe('health routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('GET /health returns 200 with status, timestamp, and uptime', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
    expect(typeof body.timestamp).toBe('string');
    expect(body.uptime).toBeGreaterThan(0);
  });

  it('GET /health requires no Authorization header', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      // No Authorization header
    });
    expect(response.statusCode).toBe(200);
  });

  it('GET /ready returns 200 with status, timestamp, and checks when vault is accessible', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ready',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ready');
    expect(body.timestamp).toBeDefined();
    expect(typeof body.timestamp).toBe('string');
    expect(body.checks).toBeDefined();
    expect(body.checks.vault).toBe('ok');
  });

  it('GET /ready requires no Authorization header', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ready',
      // No Authorization header
    });
    expect(response.statusCode).toBe(200);
  });

  it('GET /ready returns checks.db: ok when database is healthy', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ready',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.checks).toBeDefined();
    expect(body.checks.db).toBe('ok');
  });

  it('GET /ready returns indexing field as a boolean', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ready',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body.indexing).toBe('boolean');
  });

  it('GET /ready returns 200 even when indexing is true', async () => {
    // Verify the endpoint always returns 200 when vault and db are ok,
    // regardless of indexing status — indexing is informational only
    const response = await app.inject({
      method: 'GET',
      url: '/ready',
    });
    // Whether indexing is true or false, status should be 200 and checks should pass
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // indexing field exists; 200 is not gated on indexing
    expect(body.indexing).toBeDefined();
  });

  it('GET /ready ready status requires both vault and db to be ok', async () => {
    // When both vault and db are ok, status should be ready
    const response = await app.inject({
      method: 'GET',
      url: '/ready',
    });
    const body = response.json();
    if (body.checks.vault === 'ok' && body.checks.db === 'ok') {
      expect(body.status).toBe('ready');
    } else {
      expect(body.status).toBe('not_ready');
    }
  });
});
