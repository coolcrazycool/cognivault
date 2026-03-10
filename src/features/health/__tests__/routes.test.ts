import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../app.js';

describe('health routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.COGNIVAULT_API_KEY = 'test-api-key';
    process.env.VAULT_PATH = '/tmp/test-vault';
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
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

  it('GET /ready returns 200 with status and timestamp', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ready',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ready');
    expect(body.timestamp).toBeDefined();
    expect(typeof body.timestamp).toBe('string');
  });

  it('GET /ready requires no Authorization header', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ready',
      // No Authorization header
    });
    expect(response.statusCode).toBe(200);
  });
});
