import type { FastifyInstance } from 'fastify';
import { Registry as PromRegistry } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Set env vars before any module imports that trigger config parsing
process.env.VAULT_PATH = '/tmp/test-vault';
process.env.OPENAI_API_KEY = 'test-openai-key';

/**
 * How every retrieval surface behaves while `qdrantAdmin.blocked` is true — the state a
 * legacy `cognivault` COLLECTION squatting the alias name leaves the service in.
 *
 * What must NOT happen is the interesting part: no Qdrant call, no embedding call, and
 * above all no 200 with an empty `results` array. An empty result set is the one answer
 * that reads as an answer ("the vault has nothing on that") when it means "the index is
 * unreachable", and the agent on the other end cannot tell the difference.
 */

const AUTH = { authorization: 'Bearer cv-test-blocked-key', 'content-type': 'application/json' };

const mockQuery = vi.fn();
const mockSearch = vi.fn();
const mockEmbedQuery = vi.fn();

const mockTenantQdrant = { search: mockSearch, query: mockQuery, scroll: vi.fn() };
const mockEmbedder = { embed: vi.fn(), embedQuery: mockEmbedQuery, dimensions: 10 };

async function buildBlockedApp(): Promise<FastifyInstance> {
  const { default: Fastify } = await import('fastify');
  const { default: fp } = await import('fastify-plugin');

  const app = Fastify({ logger: false });

  // biome-ignore lint/suspicious/noExplicitAny: test mock -- intentionally partial EmbeddingProvider
  app.decorate('getUserEmbedder', (_userId: string) => mockEmbedder as any);
  // The one fact under test. `collection` is the LEGACY collection, exactly as the
  // plugin reports it in this state.
  app.decorate('qdrantAdmin', {
    alias: 'cognivault',
    collection: 'cognivault',
    blocked: true,
    expectedSchemeVersion: 3,
    describe: vi.fn(),
    dropCollection: vi.fn(),
    createCollection: vi.fn(),
  });

  await app.register(
    fp(
      async (f) => {
        f.decorate('metrics', {
          promRegistry: new PromRegistry(),
          searchDuration: { startTimer: vi.fn().mockReturnValue(vi.fn()) },
          searchRequests: { inc: vi.fn() },
          contextPacks: { inc: vi.fn() },
        } as unknown as FastifyInstance['metrics']);
      },
      { name: 'metrics' },
    ),
  );

  await app.register(
    fp(
      async (f) => {
        f.decorate('registry', {
          getUserByApiKey: (key: string) =>
            key === 'cv-test-blocked-key'
              ? {
                  userId: 'test-user',
                  apiKey: 'cv-test-blocked-key',
                  vaultPath: '/tmp/test-vault',
                  openaiKey: 'test-openai-key',
                }
              : undefined,
        } as unknown as FastifyInstance['registry']);
      },
      { name: 'registry' },
    ),
  );

  const { default: errorHandler } = await import('../../../plugins/error-handler.js');
  await app.register(errorHandler);
  const { default: authPlugin } = await import('../../../plugins/auth.js');
  await app.register(authPlugin);

  app.addHook('onRequest', async (request) => {
    if (request.user) {
      request.getUserQdrant = () =>
        mockTenantQdrant as unknown as ReturnType<typeof request.getUserQdrant>;
      request.getUserDb = () => ({}) as unknown as ReturnType<typeof request.getUserDb>;
    }
  });

  const { healthRoutes } = await import('../../health/routes.js');
  const { searchRoutes } = await import('../routes.js');
  const { contextRoutes } = await import('../../context/routes.js');
  await app.register(healthRoutes);
  await app.register(searchRoutes, { prefix: '/api/vault/search' });
  await app.register(contextRoutes, { prefix: '/api/vault' });

  await app.ready();
  return app;
}

describe('retrieval while the collection is blocked', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildBlockedApp();
  });

  afterAll(async () => {
    await app.close();
  });

  for (const path of ['semantic', 'hybrid', 'lexical']) {
    it(`/search/${path} answers 503 COLLECTION_BLOCKED instead of searching`, async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/vault/search/${path}`,
        headers: AUTH,
        payload: { query: 'релиз' },
      });

      expect(response.statusCode).toBe(503);
      const { error } = response.json();
      expect(error.code).toBe('COLLECTION_BLOCKED');
      // 5xx bodies are normally scrubbed to "Internal server error"; this one is written
      // for the reader and says what to do.
      expect(error.message).toContain('/api/admin/collection/rebuild');
      expect(error.message).toContain('cognivault');
      // Nothing reached the database or the embedding provider.
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockSearch).not.toHaveBeenCalled();
      expect(mockEmbedQuery).not.toHaveBeenCalled();
    });
  }

  it('/context answers 503 instead of an empty context pack', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/vault/context',
      headers: AUTH,
      payload: { query: 'релиз' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('COLLECTION_BLOCKED');
  });

  it('answers the refusal in TOON when the caller asks for it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/vault/search/hybrid',
      headers: { ...AUTH, accept: 'text/toon' },
      payload: { query: 'релиз' },
    });

    // The guard throws rather than replying, precisely so content negotiation still works.
    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('text/toon');
    expect(response.body).toContain('COLLECTION_BLOCKED');
  });

  it('still answers 401 before disclosing anything to an unauthenticated caller', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/vault/search/hybrid',
      headers: { 'content-type': 'application/json' },
      payload: { query: 'релиз' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('keeps /health at 200 — the kubelet must not restart a pod an operator can fix', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ok');
  });
});
