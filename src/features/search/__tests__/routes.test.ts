import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Set env vars before any module imports that trigger config parsing
process.env.COGNIVAULT_API_KEY = 'test-search-key';
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

// ── Mock Qdrant and embedder ──

const mockQdrantSearch = vi.fn().mockResolvedValue(MOCK_SCORED_POINTS);
const mockQdrantScroll = vi.fn().mockResolvedValue(MOCK_SCROLL_RESULT);
const mockEmbed = vi.fn().mockResolvedValue(MOCK_EMBEDDING);

const mockQdrant = {
  search: mockQdrantSearch,
  scroll: mockQdrantScroll,
};

const mockEmbedder = {
  embed: mockEmbed,
  dimensions: 10,
};

// ── App setup with isolated Fastify instance ──

async function buildTestApp(): Promise<FastifyInstance> {
  const { default: Fastify } = await import('fastify');

  const app = Fastify({ logger: false });

  // Decorate with mocked qdrant and embedder (cast to satisfy Fastify TypeScript type checks)
  // biome-ignore lint/suspicious/noExplicitAny: test mock — intentionally partial QdrantClient
  app.decorate('qdrant', mockQdrant as any);
  // biome-ignore lint/suspicious/noExplicitAny: test mock — intentionally partial EmbeddingProvider
  app.decorate('embedder', mockEmbedder as any);
  app.decorate('metrics', {
    searchDuration: { startTimer: vi.fn().mockReturnValue(vi.fn()) },
    searchRequests: { inc: vi.fn() },
    indexQueueDepth: { set: vi.fn() },
    staleVectorCleanups: { inc: vi.fn() },
  } as unknown as FastifyInstance['metrics']);

  // Register error handler (converts validation errors to proper 400 responses)
  const { default: errorHandler } = await import('../../../plugins/error-handler.js');
  await app.register(errorHandler);

  // Register auth plugin so auth is enforced
  const { default: authPlugin } = await import('../../../plugins/auth.js');
  await app.register(authPlugin);

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
    mockQdrantSearch.mockClear();
    mockQdrantScroll.mockClear();
    mockEmbed.mockClear();
    // Reset to default return values
    mockQdrantSearch.mockResolvedValue(MOCK_SCORED_POINTS);
    mockQdrantScroll.mockResolvedValue(MOCK_SCROLL_RESULT);
    mockEmbed.mockResolvedValue(MOCK_EMBEDDING);
  });

  describe('POST /api/vault/search/semantic', () => {
    it('returns 200 with correct result shape (all fields present)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/semantic',
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
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
    });

    it('calls embedder.embed with query and qdrant.search with the embedding vector', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/semantic',
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
        payload: { query: 'embedding test' },
      });

      expect(mockEmbed).toHaveBeenCalledWith(['embedding test']);
      expect(mockQdrantSearch).toHaveBeenCalledWith(
        'cognivault',
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
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test', limit: 5 },
      });

      expect(response.statusCode).toBe(200);
      expect(mockQdrantSearch).toHaveBeenCalledWith(
        'cognivault',
        expect.objectContaining({ limit: 5 }),
      );
    });

    it('returns 400 with empty query', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/semantic',
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
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
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
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
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
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
      // Qdrant returns mixed paths — folder filter should post-filter them
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
          score: 0.80,
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
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
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
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
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

    it('calls both qdrant.search (semantic) AND qdrant.scroll (lexical)', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
        payload: { query: 'hybrid test' },
      });

      expect(mockQdrantSearch).toHaveBeenCalled();
      expect(mockQdrantScroll).toHaveBeenCalled();
    });

    it('calls semantic with 2x the requested limit', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
        payload: { query: 'hybrid test', limit: 5 },
      });

      // semantic uses qdrant.search — it should receive limit=10 (2x)
      expect(mockQdrantSearch).toHaveBeenCalledWith(
        'cognivault',
        expect.objectContaining({ limit: 10 }),
      );
    });

    it('calls lexical with 2x the requested limit', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
        payload: { query: 'hybrid test', limit: 5 },
      });

      // lexical uses qdrant.scroll
      expect(mockQdrantScroll).toHaveBeenCalled();
    });

    it('deduplicates same-path results with accumulated RRF score', async () => {
      // Both semantic and lexical return a result with the same path
      const sharedPath = 'notes/shared.md';
      mockQdrantSearch.mockResolvedValueOnce([
        {
          id: 'uuid-s1',
          score: 0.9,
          payload: {
            text: 'shared text',
            path: sharedPath,
            title: 'shared',
            section_path: 'shared > intro',
            tags: [],
            project: null,
            status: null,
            type: null,
          },
        },
      ]);
      mockQdrantScroll.mockResolvedValueOnce({
        points: [
          {
            id: 'uuid-l1',
            payload: {
              text: 'shared text',
              path: sharedPath,
              title: 'shared',
              section_path: 'shared > intro',
              tags: [],
              project: null,
              status: null,
              type: null,
            },
          },
        ],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
        payload: { query: 'shared', limit: 10 },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // The shared path should appear only once (deduplicated)
      const sharedResults = body.results.filter((r: { path: string }) => r.path === sharedPath);
      expect(sharedResults).toHaveLength(1);
      // Score should be > 1/(1+60) since it accumulated from both sources
      const singleRrfScore = 1 / (1 + 60);
      expect(sharedResults[0].score).toBeGreaterThan(singleRrfScore);
    });

    it('degrades gracefully when semantic returns empty — returns lexical results', async () => {
      mockQdrantSearch.mockResolvedValueOnce([]);

      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results.length).toBeGreaterThan(0);
    });

    it('degrades gracefully when lexical returns empty — returns semantic results', async () => {
      mockQdrantScroll.mockResolvedValueOnce({ points: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
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
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
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
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
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
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
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
      // Both semantic and lexical return mixed paths — only Projects/ should survive
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
      mockQdrantScroll.mockResolvedValueOnce({
        points: [
          {
            id: 'uuid-l1',
            payload: {
              text: 'lexical in projects',
              path: 'Projects/gamma.md',
              title: 'gamma',
              section_path: 'gamma > setup',
              tags: [],
              project: null,
              status: null,
              type: null,
            },
          },
          {
            id: 'uuid-l2',
            payload: {
              text: 'lexical outside',
              path: 'notes/unrelated.md',
              title: 'unrelated',
              section_path: 'main',
              tags: [],
              project: null,
              status: null,
              type: null,
            },
          },
        ],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
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
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
        payload: { query: 'ingestion' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results).toBeDefined();
      expect(Array.isArray(body.results)).toBe(true);

      for (const result of body.results) {
        expect(result.score).toBe(1.0);
      }
    });

    it('calls qdrant.scroll (not search) with should conditions for text/title/section_path', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/lexical',
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
        payload: { query: 'ingestion' },
      });

      expect(mockQdrantScroll).toHaveBeenCalledWith(
        'cognivault',
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

    it('filter by tags passes MatchAny to Qdrant must conditions', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/lexical',
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test', filters: { tags: ['project-a'] } },
      });

      expect(mockQdrantScroll).toHaveBeenCalledWith(
        'cognivault',
        expect.objectContaining({
          filter: expect.objectContaining({
            must: expect.arrayContaining([{ key: 'tags', match: { any: ['project-a'] } }]),
          }),
        }),
      );
    });

    it('filter by folder prefix post-filters results by path.startsWith', async () => {
      // Scroll returns points with paths — some in Projects/ some not
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
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test', filters: { folder: 'Projects/' } },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0].path).toBe('Projects/alpha.md');
    });

    it('filter by type passes MatchValue to Qdrant must conditions', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/lexical',
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test', filters: { type: 'meeting-note' } },
      });

      expect(mockQdrantScroll).toHaveBeenCalledWith(
        'cognivault',
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
        headers: { authorization: 'Bearer test-search-key', 'content-type': 'application/json' },
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
