import type { FastifyInstance } from 'fastify';
import { Registry as PromRegistry } from 'prom-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Set env vars before any module imports that trigger config parsing
process.env.VAULT_PATH = '/tmp/test-vault';
process.env.OPENAI_API_KEY = 'test-openai-key';

// ── Fixture data ──
// Two chunks from same note path (Architecture/system.md) to test merging
// One ADR, one implementation note

const MOCK_SCORED_POINTS = [
  {
    id: 'uuid-1',
    score: 0.95,
    payload: {
      text: 'The system architecture follows a microservices pattern with event-driven communication between services.',
      path: 'Architecture/system.md',
      title: 'System Architecture',
      section_path: 'system > overview',
      tags: ['architecture'],
      project: 'cognivault',
      status: 'active',
      type: 'architecture',
    },
  },
  {
    id: 'uuid-2',
    score: 0.85,
    payload: {
      text: 'The components include an API gateway, several microservices, and a shared database layer for state management.',
      path: 'Architecture/system.md',
      title: 'System Architecture',
      section_path: 'system > components',
      tags: ['architecture'],
      project: 'cognivault',
      status: 'active',
      type: 'architecture',
    },
  },
  {
    id: 'uuid-3',
    score: 0.7,
    payload: {
      text: 'ADR-001: We chose Qdrant as the vector database because it supports both dense and sparse vectors natively.',
      path: 'ADRs/adr-001.md',
      title: 'ADR-001: Vector Database Selection',
      section_path: 'ADR-001 > context',
      tags: ['adr', 'database'],
      project: null,
      status: null,
      type: 'adr',
    },
  },
  {
    id: 'uuid-4',
    score: 0.5,
    payload: {
      text: 'Setup instructions: install dependencies with pnpm install, configure environment variables in .env file.',
      path: 'notes/impl.md',
      title: 'Implementation Notes',
      section_path: 'impl > setup',
      tags: [],
      project: null,
      status: null,
      type: null,
    },
  },
];

const MOCK_SCROLL_RESULT = {
  points: [
    {
      id: 'uuid-5',
      payload: {
        text: 'Lexical match for architecture patterns used across the system.',
        path: 'Architecture/patterns.md',
        title: 'Architecture Patterns',
        section_path: 'patterns > overview',
        tags: ['architecture'],
        project: 'cognivault',
        status: 'active',
        type: 'architecture',
      },
    },
  ],
};

/**
 * What /context actually receives now: one fused Query API response whose scores are raw
 * RRF sums (~1/(2 + rank)). Every one of them is far below the min_score default of 0.3 —
 * the pack must still come out non-empty, because SearchService rescales the batch against
 * its top hit before the ContextService threshold ever sees it.
 */
const MOCK_FUSED_RESULT = {
  points: [
    { ...MOCK_SCORED_POINTS[0], score: 0.0333 },
    { ...MOCK_SCORED_POINTS[1], score: 0.025 },
    { ...MOCK_SCORED_POINTS[2], score: 0.02 },
    { ...MOCK_SCORED_POINTS[3], score: 0.0167 },
  ],
};

const MOCK_EMBEDDING = [Array.from({ length: 10 }, (_, i) => (i + 1) * 0.1)];

// ── Mock Qdrant and embedder ──

const mockQdrantSearch = vi.fn().mockResolvedValue(MOCK_SCORED_POINTS);
const mockQdrantScroll = vi.fn().mockResolvedValue(MOCK_SCROLL_RESULT);
const mockQdrantQuery = vi.fn().mockResolvedValue(MOCK_FUSED_RESULT);
const mockEmbed = vi.fn().mockResolvedValue(MOCK_EMBEDDING);
// /context runs hybrid, whose dense branch embeds the query via embedQuery.
const mockEmbedQuery = vi.fn().mockResolvedValue(MOCK_EMBEDDING[0]);

const mockTenantQdrant = {
  search: mockQdrantSearch,
  scroll: mockQdrantScroll,
  query: mockQdrantQuery,
  upsert: vi.fn(),
  delete: vi.fn(),
  setPayload: vi.fn(),
};

const mockEmbedder = {
  embed: mockEmbed,
  embedQuery: mockEmbedQuery,
  dimensions: 10,
};

// ── App setup with isolated Fastify instance ──

async function buildTestApp(): Promise<FastifyInstance> {
  const { default: Fastify } = await import('fastify');

  const app = Fastify({ logger: false });

  // biome-ignore lint/suspicious/noExplicitAny: test mock -- intentionally partial EmbeddingProvider
  app.decorate('getUserEmbedder', (_userId: string) => mockEmbedder as any);
  const { default: fp } = await import('fastify-plugin');

  // Mock metrics plugin (named, for auth dependency resolution)
  await app.register(
    fp(
      async (f) => {
        const promRegistry = new PromRegistry();
        f.decorate('metrics', {
          promRegistry,
          searchDuration: { startTimer: vi.fn().mockReturnValue(vi.fn()) },
          searchRequests: { inc: vi.fn() },
          contextPacks: { inc: vi.fn() },
          indexQueueDepth: { set: vi.fn() },
          staleVectorCleanups: { inc: vi.fn() },
        } as unknown as FastifyInstance['metrics']);
      },
      { name: 'metrics' },
    ),
  );

  // Mock registry plugin (named, for auth dependency resolution)
  await app.register(
    fp(
      async (f) => {
        f.decorate('registry', {
          getUserByApiKey: (key: string) =>
            key === 'cv-test-context-key'
              ? {
                  userId: 'test-user',
                  apiKey: 'cv-test-context-key',
                  vaultPath: '/tmp/test-vault',
                  openaiKey: 'test-openai-key',
                  obsidian: { email: 'test@test.com', password: 'secret', vault: 'v' },
                }
              : undefined,
        } as unknown as FastifyInstance['registry']);
      },
      { name: 'registry' },
    ),
  );

  // Register error handler (converts validation errors to proper 400 responses)
  const { default: errorHandler } = await import('../../../plugins/error-handler.js');
  await app.register(errorHandler);

  // Register auth plugin so auth is enforced
  const { default: authPlugin } = await import('../../../plugins/auth.js');
  await app.register(authPlugin);

  // Add onRequest hook to provide getUserQdrant on authenticated requests
  app.addHook('onRequest', async (request) => {
    if (request.user) {
      request.getUserQdrant = () =>
        mockTenantQdrant as unknown as ReturnType<typeof request.getUserQdrant>;
    }
  });

  // Register context routes with prefix
  const { contextRoutes } = await import('../routes.js');
  await app.register(contextRoutes, { prefix: '/api/vault' });

  await app.ready();
  return app;
}

describe('context routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQdrantSearch.mockClear();
    mockQdrantScroll.mockClear();
    mockQdrantQuery.mockClear();
    mockEmbed.mockClear();
    mockEmbedQuery.mockClear();
    // Reset to default return values
    mockQdrantSearch.mockResolvedValue(MOCK_SCORED_POINTS);
    mockQdrantScroll.mockResolvedValue(MOCK_SCROLL_RESULT);
    mockQdrantQuery.mockResolvedValue(MOCK_FUSED_RESULT);
    mockEmbed.mockResolvedValue(MOCK_EMBEDDING);
    mockEmbedQuery.mockResolvedValue(MOCK_EMBEDDING[0]);
  });

  describe('POST /api/vault/context', () => {
    it('returns 200 with structured context pack for valid query', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/context',
        headers: {
          authorization: 'Bearer cv-test-context-key',
          'content-type': 'application/json',
        },
        payload: { query: 'system architecture' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.meta).toBeDefined();
      expect(typeof body.meta.total_tokens).toBe('number');
      expect(typeof body.meta.token_budget).toBe('number');
      expect(typeof body.meta.chunks_included).toBe('number');
      expect(typeof body.meta.chunks_excluded).toBe('number');
      expect(typeof body.meta.query_ms).toBe('number');
      expect(body.meta.query_ms).toBeGreaterThanOrEqual(0);
    });

    it('each entry has text, source.path, source.title, source.sections, source.score, section', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/context',
        headers: {
          authorization: 'Bearer cv-test-context-key',
          'content-type': 'application/json',
        },
        payload: { query: 'architecture' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Collect all entries across all sections
      const allEntries = [
        ...(body.summary ?? []),
        ...(body.architecture ?? []),
        ...(body.adrs ?? []),
        ...(body.glossary ?? []),
        ...(body.implementation ?? []),
      ];

      expect(allEntries.length).toBeGreaterThan(0);

      for (const entry of allEntries) {
        expect(typeof entry.text).toBe('string');
        expect(entry.text.length).toBeGreaterThan(0);
        expect(typeof entry.source.path).toBe('string');
        expect(typeof entry.source.title).toBe('string');
        expect(Array.isArray(entry.source.sections)).toBe(true);
        expect(typeof entry.source.score).toBe('number');
        expect(entry.source.score).toBeGreaterThanOrEqual(0);
        expect(entry.source.score).toBeLessThanOrEqual(1);
        expect(typeof entry.section).toBe('string');
      }
    });

    it('returns 401 without auth token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/context',
        headers: { 'content-type': 'application/json' },
        payload: { query: 'test' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 400 with empty query', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/context',
        headers: {
          authorization: 'Bearer cv-test-context-key',
          'content-type': 'application/json',
        },
        payload: { query: '' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 400 with missing query field', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/context',
        headers: {
          authorization: 'Bearer cv-test-context-key',
          'content-type': 'application/json',
        },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('custom token_budget=1000 is respected (meta.total_tokens does not exceed 1000)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/context',
        headers: {
          authorization: 'Bearer cv-test-context-key',
          'content-type': 'application/json',
        },
        payload: { query: 'architecture', token_budget: 1000 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.meta.token_budget).toBe(1000);
      expect(body.meta.total_tokens).toBeLessThanOrEqual(1000);
    });

    it('custom min_score=1.0 keeps exactly the top hit (fraction-of-top semantics)', async () => {
      // SearchService rescales the fused batch against its top hit and dedups by
      // path + chunk_index (the fixture payloads carry no chunk_index, so uuid-2 folds
      // into uuid-1): ContextService receives scores 1.0, ~0.6, ~0.5. min_score is a
      // fraction of the top hit: at 1.0 only the top chunk itself survives — the cut-off
      // is applied ONCE, with no second normalisation in ContextService.
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/context',
        headers: {
          authorization: 'Bearer cv-test-context-key',
          'content-type': 'application/json',
        },
        payload: { query: 'architecture', min_score: 1.0 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.meta.chunks_excluded).toBe(2);
      expect(body.meta.chunks_included).toBe(1);
      expect(body.architecture).toHaveLength(1);
      expect(body.architecture[0].source.path).toBe('Architecture/system.md');
      expect(body.architecture[0].source.score).toBe(1);
    });

    it('default token_budget is 32000 when not provided', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/context',
        headers: {
          authorization: 'Bearer cv-test-context-key',
          'content-type': 'application/json',
        },
        payload: { query: 'architecture' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.meta.token_budget).toBe(32000);
    });

    it('empty sections omitted from response (keys not present)', async () => {
      // With MOCK_SCORED_POINTS there are no glossary entries
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/context',
        headers: {
          authorization: 'Bearer cv-test-context-key',
          'content-type': 'application/json',
        },
        payload: { query: 'architecture' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // glossary key should NOT be present in response (no glossary entries)
      expect('glossary' in body).toBe(false);
    });

    it('chunks from same note path produce a single entry in the response', async () => {
      // uuid-1 and uuid-2 both have path 'Architecture/system.md'.
      // hybrid() now returns BOTH chunks (dedup key is path + chunk_index); ContextService
      // groups by path and merges them, so Architecture/system.md appears exactly once.
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/context',
        headers: {
          authorization: 'Bearer cv-test-context-key',
          'content-type': 'application/json',
        },
        payload: { query: 'system architecture' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Collect all entries
      const allEntries = [
        ...(body.summary ?? []),
        ...(body.architecture ?? []),
        ...(body.adrs ?? []),
        ...(body.glossary ?? []),
        ...(body.implementation ?? []),
      ];

      // Architecture/system.md should appear exactly once (deduplicated by hybrid search and grouped by ContextService)
      const systemMdEntries = allEntries.filter(
        (e: { source: { path: string } }) => e.source.path === 'Architecture/system.md',
      );
      expect(systemMdEntries).toHaveLength(1);

      // The single entry should have sections array with at least one section_path
      const mergedEntry = systemMdEntries[0];
      expect(Array.isArray(mergedEntry.source.sections)).toBe(true);
      expect(mergedEntry.source.sections.length).toBeGreaterThanOrEqual(1);
    });

    it('filters parameter is passed through to hybrid search', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/context',
        headers: {
          authorization: 'Bearer cv-test-context-key',
          'content-type': 'application/json',
        },
        payload: { query: 'test', filters: { tags: ['architecture'] } },
      });

      // Facets land on the outer filter of the single fused Query API call
      expect(mockQdrantQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: expect.objectContaining({
            must: expect.arrayContaining([{ key: 'tags', match: { any: ['architecture'] } }]),
          }),
        }),
      );
    });

    it('calls hybrid search with limit=50 (over-fetched to 100 on the wire)', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/context',
        headers: {
          authorization: 'Bearer cv-test-context-key',
          'content-type': 'application/json',
        },
        payload: { query: 'test' },
      });

      // One fused call. The route asks hybrid() for 50; the outer limit on the wire is
      // over-fetched to 100 so dedup does not eat into the pack, and each prefetch branch
      // is oversampled 2x on top of that.
      const call = mockQdrantQuery.mock.calls[0]?.[0];
      expect(call.limit).toBe(100);
      expect(call.query).toEqual({ fusion: 'rrf' });
      expect(
        (call.prefetch as Array<{ using: string; limit: number }>).map((b) => b.using),
      ).toEqual(['dense', 'bm25']);
      expect(
        (call.prefetch as Array<{ using: string; limit: number }>).map((b) => b.limit),
      ).toEqual([200, 200]);
      expect(mockQdrantSearch).not.toHaveBeenCalled();
      expect(mockQdrantScroll).not.toHaveBeenCalled();
    });

    it('raw RRF scores do not starve the pack (min_score default 0.3)', async () => {
      // Regression guard: every fused score in the fixture is ~0.02, i.e. below min_score.
      // Only the rescale in SearchService keeps /context from returning an empty pack.
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/context',
        headers: {
          authorization: 'Bearer cv-test-context-key',
          'content-type': 'application/json',
        },
        payload: { query: 'system architecture' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const allEntries = [
        ...(body.summary ?? []),
        ...(body.architecture ?? []),
        ...(body.adrs ?? []),
        ...(body.glossary ?? []),
        ...(body.implementation ?? []),
      ];
      expect(allEntries.length).toBeGreaterThan(0);
      expect(body.meta.chunks_included).toBeGreaterThan(0);
      for (const entry of allEntries) {
        expect(entry.source.score).toBeGreaterThanOrEqual(0.3);
        expect(entry.source.score).toBeLessThanOrEqual(1);
      }
    });

    it('returns an empty pack when search yields no results — the only empty case', async () => {
      // The emptiness contract: because hybrid rescales its batch so the top hit is 1.0,
      // that hit passes any min_score in [0, 1]. The pack is therefore empty exactly when
      // the search itself returns nothing (documented in the min_score schema description).
      mockQdrantQuery.mockResolvedValue({ points: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/context',
        headers: {
          authorization: 'Bearer cv-test-context-key',
          'content-type': 'application/json',
        },
        payload: { query: 'nothing matches this', min_score: 0.99 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.meta.chunks_included).toBe(0);
      expect(body.meta.chunks_excluded).toBe(0);
      expect(body.meta.total_tokens).toBe(0);
      for (const section of ['summary', 'architecture', 'adrs', 'glossary', 'implementation']) {
        expect(section in body).toBe(false);
      }
    });

    it('top hit always passes any min_score in [0, 1] when search returns anything', async () => {
      // Corollary of the rescale: even a batch whose raw fused scores are all terrible
      // produces a non-empty pack, because rank 1 is rescaled to exactly 1.0. min_score is
      // a tail trim relative to the best hit, NOT an absolute relevance floor.
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/context',
        headers: {
          authorization: 'Bearer cv-test-context-key',
          'content-type': 'application/json',
        },
        payload: { query: 'system architecture', min_score: 1.0 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().meta.chunks_included).toBeGreaterThan(0);
    });

    it('embeds the query via embedQuery (query side), never via embed', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/context',
        headers: {
          authorization: 'Bearer cv-test-context-key',
          'content-type': 'application/json',
        },
        payload: { query: 'system architecture' },
      });

      expect(mockEmbedQuery).toHaveBeenCalledWith('system architecture');
      expect(mockEmbed).not.toHaveBeenCalled();
    });

    it('meta.query_ms is a non-negative integer', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/context',
        headers: {
          authorization: 'Bearer cv-test-context-key',
          'content-type': 'application/json',
        },
        payload: { query: 'test' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.meta.query_ms).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(body.meta.query_ms)).toBe(true);
    });
  });
});
