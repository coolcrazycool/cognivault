import type { FastifyInstance } from 'fastify';
import { Registry as PromRegistry } from 'prom-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Set env vars before any module imports that trigger config parsing
process.env.VAULT_PATH = '/tmp/test-vault';
process.env.OPENAI_API_KEY = 'test-openai-key';

// ── Fixture data ──

const MOCK_SCORED_POINTS = [
  {
    id: 'uuid-1',
    score: 0.95,
    payload: {
      text: 'chunk text 1',
      path: 'notes/test.md',
      title: 'test',
      section_path: 'test > intro',
      tags: ['tag-a'],
      project: 'proj-1',
      status: 'active',
      type: 'meeting-note',
    },
  },
  {
    id: 'uuid-2',
    score: 0.8,
    payload: {
      text: 'chunk text 2',
      path: 'notes/other.md',
      title: 'other',
      section_path: 'other > details',
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
      id: 'uuid-1',
      payload: {
        text: 'exact match text',
        path: 'Projects/alpha.md',
        title: 'alpha',
        section_path: 'alpha > setup',
        tags: ['infra'],
        project: 'alpha',
        status: 'done',
        type: 'adr',
      },
    },
  ],
};

const MOCK_EMBEDDING = [Array.from({ length: 10 }, (_, i) => (i + 1) * 0.1)];

// ── Mock Qdrant (TenantQdrantClient interface) and embedder ──

const mockQdrantSearch = vi.fn().mockResolvedValue(MOCK_SCORED_POINTS);
const mockQdrantScroll = vi.fn().mockResolvedValue(MOCK_SCROLL_RESULT);
const mockEmbed = vi.fn().mockResolvedValue(MOCK_EMBEDDING);
// Semantic search must go through embedQuery (query side), never embed (document side).
const mockEmbedQuery = vi.fn().mockResolvedValue(MOCK_EMBEDDING[0]);

const mockTenantQdrant = {
  search: mockQdrantSearch,
  scroll: mockQdrantScroll,
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

  // Decorate with mocked per-user embedder lookup
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
            key === 'cv-test-search-key'
              ? {
                  userId: 'test-user',
                  apiKey: 'cv-test-search-key',
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

  // Register search routes with prefix
  const { searchRoutes } = await import('../routes.js');
  await app.register(searchRoutes, { prefix: '/api/vault/search' });

  await app.ready();
  return app;
}

describe('search routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    // mockReset (not mockClear) — it also drops unconsumed mockResolvedValueOnce queues,
    // which matters now that hybrid no longer calls scroll
    mockQdrantSearch.mockReset();
    mockQdrantScroll.mockReset();
    mockEmbed.mockReset();
    mockEmbedQuery.mockReset();
    // Reset to default return values
    mockQdrantSearch.mockResolvedValue(MOCK_SCORED_POINTS);
    mockQdrantScroll.mockResolvedValue(MOCK_SCROLL_RESULT);
    mockEmbed.mockResolvedValue(MOCK_EMBEDDING);
    mockEmbedQuery.mockResolvedValue(MOCK_EMBEDDING[0]);
  });

  describe('POST /api/vault/search/semantic', () => {
    it('returns 200 with correct result shape (all fields present)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/semantic',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test query' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results).toBeDefined();
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.total).toBeTypeOf('number');
      expect(body.limit).toBeTypeOf('number');
      expect(body.query_ms).toBeTypeOf('number');

      const first = body.results[0];
      expect(first).toBeDefined();
      expect(first.text).toBeDefined();
      expect(first.path).toBeDefined();
      expect(first.title).toBeDefined();
      expect(first.section_path).toBeDefined();
      expect(first.score).toBeTypeOf('number');
      expect(first.tags).toBeDefined();
      expect(Array.isArray(first.tags)).toBe(true);
      expect('project' in first).toBe(true);
      expect('status' in first).toBe(true);
      // chunk_index defaults to 0 when the payload has none; rank is 1-based
      expect(first.chunk_index).toBe(0);
      expect(body.results.map((r: { rank: number }) => r.rank)).toEqual([1, 2]);
    });

    it('propagates chunk_index from payload and assigns 1-based rank', async () => {
      mockQdrantSearch.mockResolvedValueOnce([
        {
          id: 'uuid-c0',
          score: 0.9,
          payload: {
            text: 'chunk zero',
            path: 'notes/multi.md',
            title: 'multi',
            section_path: 'multi > a',
            chunk_index: 0,
            tags: [],
            project: null,
            status: null,
            type: null,
          },
        },
        {
          id: 'uuid-c3',
          score: 0.7,
          payload: {
            text: 'chunk three',
            path: 'notes/multi.md',
            title: 'multi',
            section_path: 'multi > b',
            chunk_index: 3,
            tags: [],
            project: null,
            status: null,
            type: null,
          },
        },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/semantic',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'multi' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(
        body.results.map((r: { chunk_index: number; rank: number }) => [r.chunk_index, r.rank]),
      ).toEqual([
        [0, 1],
        [3, 2],
      ]);
    });

    it('calls embedder.embedQuery with query and tenant qdrant.search with the embedding vector', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/semantic',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'embedding test' },
      });

      // Query side goes through embedQuery so asymmetric models get their instruction;
      // the document-side embed() must not be touched.
      expect(mockEmbedQuery).toHaveBeenCalledWith('embedding test');
      expect(mockEmbed).not.toHaveBeenCalled();
      expect(mockQdrantSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          vector: MOCK_EMBEDDING[0],
          with_payload: true,
        }),
      );
    });

    it('respects limit parameter', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/semantic',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test', limit: 5 },
      });

      expect(response.statusCode).toBe(200);
      expect(mockQdrantSearch).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
    });

    it('returns 400 with empty query', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/semantic',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: '' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 401 without auth token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/semantic',
        headers: { 'content-type': 'application/json' },
        payload: { query: 'test' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('semantic scores are in [0, 1] range', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/semantic',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      for (const result of body.results) {
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
      }
    });

    it('response includes total, limit, query_ms fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/semantic',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test', limit: 7 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(body.results.length);
      expect(body.limit).toBe(7);
      expect(typeof body.query_ms).toBe('number');
      expect(body.query_ms).toBeGreaterThanOrEqual(0);
    });

    it('folder filter in semantic search returns only matching paths', async () => {
      // Qdrant returns mixed paths -- folder filter should post-filter them
      mockQdrantSearch.mockResolvedValueOnce([
        {
          id: 'uuid-p1',
          score: 0.95,
          payload: {
            text: 'in projects',
            path: 'Projects/alpha.md',
            title: 'alpha',
            section_path: 'alpha > intro',
            tags: [],
            project: null,
            status: null,
            type: null,
          },
        },
        {
          id: 'uuid-p2',
          score: 0.8,
          payload: {
            text: 'not in projects',
            path: 'notes/other.md',
            title: 'other',
            section_path: 'other > main',
            tags: [],
            project: null,
            status: null,
            type: null,
          },
        },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/semantic',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test', filters: { folder: 'Projects/' } },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0].path).toBe('Projects/alpha.md');
    });
  });

  describe('POST /api/vault/search/hybrid', () => {
    it('returns 200 with correct SearchResponse shape', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test query' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results).toBeDefined();
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.total).toBeTypeOf('number');
      expect(body.limit).toBeTypeOf('number');
      expect(body.query_ms).toBeTypeOf('number');
    });

    it('calls qdrant.search exactly once and never calls qdrant.scroll (no lexical leg)', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'hybrid test' },
      });

      expect(mockQdrantSearch).toHaveBeenCalledTimes(1);
      expect(mockQdrantScroll).not.toHaveBeenCalled();
    });

    it('delegates to semantic and therefore embeds via embedQuery', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'hybrid test' },
      });

      expect(mockEmbedQuery).toHaveBeenCalledWith('hybrid test');
      expect(mockEmbed).not.toHaveBeenCalled();
    });

    it('passes the requested limit straight through (no 2x oversampling)', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'hybrid test', limit: 5 },
      });

      expect(mockQdrantSearch).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
    });

    it('scores are the clamped cosine scores from qdrant (not RRF sums)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'hybrid test' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results.map((r: { score: number }) => r.score)).toEqual([0.95, 0.8]);
    });

    it('clamps out-of-range cosine scores into [0, 1]', async () => {
      mockQdrantSearch.mockResolvedValueOnce([
        {
          id: 'uuid-hi',
          score: 1.4,
          payload: {
            text: 'too high',
            path: 'notes/hi.md',
            title: 'hi',
            section_path: 'hi',
            chunk_index: 0,
            tags: [],
            project: null,
            status: null,
            type: null,
          },
        },
        {
          id: 'uuid-lo',
          score: -0.2,
          payload: {
            text: 'negative',
            path: 'notes/lo.md',
            title: 'lo',
            section_path: 'lo',
            chunk_index: 0,
            tags: [],
            project: null,
            status: null,
            type: null,
          },
        },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results.map((r: { score: number }) => r.score)).toEqual([1, 0]);
    });

    it('keeps multiple chunks of the same file (dedup key is path + chunk_index)', async () => {
      const sharedPath = 'notes/shared.md';
      mockQdrantSearch.mockResolvedValueOnce([
        {
          id: 'uuid-s1',
          score: 0.9,
          payload: {
            text: 'shared chunk 0',
            path: sharedPath,
            title: 'shared',
            section_path: 'shared > intro',
            chunk_index: 0,
            tags: [],
            project: null,
            status: null,
            type: null,
          },
        },
        {
          id: 'uuid-s2',
          score: 0.85,
          payload: {
            text: 'shared chunk 1',
            path: sharedPath,
            title: 'shared',
            section_path: 'shared > details',
            chunk_index: 1,
            tags: [],
            project: null,
            status: null,
            type: null,
          },
        },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'shared', limit: 10 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const sharedResults = body.results.filter((r: { path: string }) => r.path === sharedPath);
      // Both chunks must survive -- the UI relies on several hits per file for smart expansion
      expect(sharedResults).toHaveLength(2);
      expect(
        sharedResults.map((r: { chunk_index: number; rank: number }) => [r.chunk_index, r.rank]),
      ).toEqual([
        [0, 1],
        [1, 2],
      ]);
    });

    it('drops exact duplicate points (same path AND same chunk_index)', async () => {
      const duplicatePayload = {
        text: 'dupe text',
        path: 'notes/dupe.md',
        title: 'dupe',
        section_path: 'dupe > intro',
        chunk_index: 2,
        tags: [],
        project: null,
        status: null,
        type: null,
      };
      mockQdrantSearch.mockResolvedValueOnce([
        { id: 'uuid-d1', score: 0.9, payload: duplicatePayload },
        { id: 'uuid-d2', score: 0.7, payload: duplicatePayload },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'dupe' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0].rank).toBe(1);
      expect(body.results[0].score).toBe(0.9);
    });

    it('returns an empty result set when semantic returns nothing', async () => {
      mockQdrantSearch.mockResolvedValueOnce([]);

      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('is unaffected by the lexical (scroll) path returning nothing', async () => {
      mockQdrantScroll.mockResolvedValueOnce({ points: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results.length).toBeGreaterThan(0);
    });

    it('hybrid scores are in [0, 1] range', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      for (const result of body.results) {
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
      }
    });

    it('returns 400 with empty query', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: '' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 401 without auth token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { 'content-type': 'application/json' },
        payload: { query: 'test' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('response includes total, limit, query_ms fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test', limit: 6 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(body.results.length);
      expect(body.limit).toBe(6);
      expect(typeof body.query_ms).toBe('number');
      expect(body.query_ms).toBeGreaterThanOrEqual(0);
    });

    it('hybrid search with folder filter excludes results outside folder', async () => {
      // Qdrant returns mixed paths -- only Projects/ should survive the post-filter
      mockQdrantSearch.mockResolvedValueOnce([
        {
          id: 'uuid-s1',
          score: 0.92,
          payload: {
            text: 'semantic in projects',
            path: 'Projects/beta.md',
            title: 'beta',
            section_path: 'beta > intro',
            tags: [],
            project: null,
            status: null,
            type: null,
          },
        },
        {
          id: 'uuid-s2',
          score: 0.75,
          payload: {
            text: 'semantic outside',
            path: 'Archive/old.md',
            title: 'old',
            section_path: 'old > intro',
            tags: [],
            project: null,
            status: null,
            type: null,
          },
        },
      ]);

      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test', filters: { folder: 'Projects/' } },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // All returned results must be within Projects/
      expect(body.results.length).toBeGreaterThan(0);
      for (const result of body.results) {
        expect(result.path).toMatch(/^Projects\//);
      }
    });
  });

  describe('POST /api/vault/search/lexical', () => {
    it('returns 200 with correct result shape and score is 1.0', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/lexical',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'ingestion' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results).toBeDefined();
      expect(Array.isArray(body.results)).toBe(true);

      for (const result of body.results) {
        expect(result.score).toBe(1.0);
      }
      // chunk_index/rank are filled uniformly across all three search methods
      expect(
        body.results.map((r: { chunk_index: number; rank: number }) => [r.chunk_index, r.rank]),
      ).toEqual([[0, 1]]);
    });

    it('calls tenant qdrant.scroll (not search) with should conditions for text/title/section_path', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/lexical',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'ingestion' },
      });

      expect(mockQdrantScroll).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: expect.objectContaining({
            should: expect.arrayContaining([
              { key: 'text', match: { text: 'ingestion' } },
              { key: 'title', match: { text: 'ingestion' } },
              { key: 'section_path', match: { text: 'ingestion' } },
            ]),
          }),
        }),
      );
      // Should NOT call search for lexical
      expect(mockQdrantSearch).not.toHaveBeenCalled();
    });

    it('filter by tags passes MatchAny to must conditions', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/lexical',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test', filters: { tags: ['project-a'] } },
      });

      expect(mockQdrantScroll).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: expect.objectContaining({
            must: expect.arrayContaining([{ key: 'tags', match: { any: ['project-a'] } }]),
          }),
        }),
      );
    });

    it('filter by folder prefix post-filters results by path.startsWith', async () => {
      // Scroll returns points with paths -- some in Projects/ some not
      const mixedScrollResult = {
        points: [
          {
            id: 'uuid-a',
            payload: {
              text: 'in projects',
              path: 'Projects/alpha.md',
              title: 'alpha',
              section_path: 'setup',
              tags: [],
              project: null,
              status: null,
              type: null,
            },
          },
          {
            id: 'uuid-b',
            payload: {
              text: 'not in projects',
              path: 'notes/other.md',
              title: 'other',
              section_path: 'main',
              tags: [],
              project: null,
              status: null,
              type: null,
            },
          },
        ],
      };
      mockQdrantScroll.mockResolvedValueOnce(mixedScrollResult);

      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/lexical',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test', filters: { folder: 'Projects/' } },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0].path).toBe('Projects/alpha.md');
    });

    it('filter by type passes MatchValue to must conditions', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/lexical',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test', filters: { type: 'meeting-note' } },
      });

      expect(mockQdrantScroll).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: expect.objectContaining({
            must: expect.arrayContaining([{ key: 'type', match: { value: 'meeting-note' } }]),
          }),
        }),
      );
    });

    it('returns 401 without auth token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/lexical',
        headers: { 'content-type': 'application/json' },
        payload: { query: 'test' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('response includes total, limit, query_ms fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/lexical',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test', limit: 3 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(body.results.length);
      expect(body.limit).toBe(3);
      expect(typeof body.query_ms).toBe('number');
    });
  });
});
