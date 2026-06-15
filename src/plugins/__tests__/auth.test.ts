import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UserRecord } from '../../lib/user-registry.js';

// Mock OpenAI to avoid real API calls during embedding plugin validation
vi.mock('openai', () => {
  const mockEmbeddingsCreate = vi.fn().mockResolvedValue({
    data: [{ index: 0, embedding: new Array(1536).fill(0.1) }],
  });
  class MockOpenAI {
    embeddings = { create: mockEmbeddingsCreate };
  }
  return { default: MockOpenAI };
});

// Mock Qdrant client to avoid connection to localhost:6333 during plugin init
vi.mock('@qdrant/js-client-rest', () => {
  class MockQdrantClient {
    getCollections = vi.fn().mockResolvedValue({ collections: [{ name: 'cognivault' }] });
    getCollection = vi.fn().mockResolvedValue({
      config: { params: { vectors: { size: 1536, distance: 'Cosine' } } },
    });
    createCollection = vi.fn().mockResolvedValue({});
    createPayloadIndex = vi.fn().mockResolvedValue({});
    upsert = vi.fn().mockResolvedValue({});
    delete = vi.fn().mockResolvedValue({});
    setPayload = vi.fn().mockResolvedValue({});
    search = vi.fn().mockResolvedValue([]);
    query = vi.fn().mockResolvedValue({ points: [] });
    scroll = vi.fn().mockResolvedValue({ points: [] });
  }
  return { QdrantClient: MockQdrantClient };
});

// Create temp directory structure
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-test-'));
const vaultRoot = path.join(tmpDir, 'vault');
const dataDir = path.join(tmpDir, 'data');

await fs.mkdir(vaultRoot, { recursive: true });
await fs.mkdir(dataDir, { recursive: true });

const testUsers: UserRecord[] = [
  {
    userId: 'alice',
    apiKey: 'cv-alice-key-001',
    vaultPath: '/vaults/alice',
    openaiKey: 'sk-alice-openai',
    obsidian: { email: 'alice@test.com', password: 'secret-alice', vault: 'alice-vault' },
  },
  {
    userId: 'bob',
    apiKey: 'cv-bob-key-002',
    vaultPath: '/vaults/bob',
    openaiKey: 'sk-bob-openai',
    obsidian: { email: 'bob@test.com', password: 'secret-bob', vault: 'bob-vault' },
  },
];

// Write users.json before importing app (config parsed at import time)
await fs.writeFile(path.join(dataDir, 'users.json'), JSON.stringify(testUsers, null, 2));

// Set env vars before any module imports that trigger config parsing
process.env.VAULT_PATH = vaultRoot;
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.COGNIVAULT_DATA_DIR = dataDir;

const { buildApp } = await import('../../app.js');

describe('auth plugin', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });

    // Register a test-only protected route (no skipAuth config) that returns request.user
    app.get('/test-protected', async (request, _reply) => {
      return { ok: true, userId: request.user?.userId };
    });

    // Register a test-only route with skipAuth
    app.get(
      '/test-skip-auth',
      { config: { skipAuth: true } as Record<string, unknown> },
      async (_request, _reply) => {
        return { ok: true };
      },
    );

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
    expect(body).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key' },
    });
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
    expect(body).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key' },
    });
  });

  it('rejects requests with non-Bearer auth scheme with 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test-protected',
      headers: {
        authorization: 'Basic dXNlcjpwYXNz',
      },
    });
    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key' },
    });
  });

  it('accepts requests with valid registry API key and populates request.user', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test-protected',
      headers: {
        authorization: 'Bearer cv-alice-key-001',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({ ok: true, userId: 'alice' });
  });

  it('health endpoint returns 200 without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ok');
  });

  it('skipAuth routes work without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test-skip-auth',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('auth failure counter increments on failed attempts', async () => {
    // Get initial counter value
    const initialMetrics = await app.metrics.promRegistry.getSingleMetricAsString(
      'cognivault_auth_failures_total',
    );

    // Make a failing request
    await app.inject({
      method: 'GET',
      url: '/test-protected',
      headers: { authorization: 'Bearer invalid-key' },
    });

    const updatedMetrics = await app.metrics.promRegistry.getSingleMetricAsString(
      'cognivault_auth_failures_total',
    );

    // Counter should have increased (metrics output includes the counter value)
    expect(updatedMetrics).toContain('cognivault_auth_failures_total');
    expect(updatedMetrics).not.toBe(initialMetrics);
  });

  it('request.user.userId is accessible in route handler', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test-protected',
      headers: {
        authorization: 'Bearer cv-bob-key-002',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().userId).toBe('bob');
  });
});
