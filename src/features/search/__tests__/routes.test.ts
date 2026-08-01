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

// query() answers with { points: [...] } — a third response shape next to search()'s bare
// array and scroll()'s { points } without scores. Scores here sit in the RRF band Qdrant
// actually produces (~1/(2 + rank)), so the rescaling is exercised against real values.
const MOCK_FUSED_RESULT = {
  points: [
    {
      id: 'uuid-1',
      score: 0.0327,
      payload: {
        text: 'chunk text 1',
        path: 'notes/test.md',
        title: 'test',
        section_path: 'test > intro',
        chunk_index: 0,
        parent_id: 'parent-1',
        tags: ['tag-a'],
        project: 'proj-1',
        status: 'active',
        type: 'meeting-note',
      },
    },
    {
      id: 'uuid-2',
      score: 0.0163,
      payload: {
        text: 'chunk text 2',
        path: 'notes/other.md',
        title: 'other',
        section_path: 'other > details',
        chunk_index: 0,
        parent_id: 'parent-2',
        tags: [],
        project: null,
        status: null,
        type: null,
      },
    },
  ],
};

/** Two chunks of ONE section, plus a sectionless point (pdf-style: parent_id === null). */
const MOCK_SECTION_RESULT = {
  points: [
    {
      id: 'uuid-a0',
      score: 0.033,
      payload: {
        text: 'section chunk 0',
        path: 'notes/multi.md',
        title: 'multi',
        section_path: 'multi > overview',
        chunk_index: 0,
        parent_id: 'parent-A',
        tags: [],
        project: null,
        status: null,
        type: null,
      },
    },
    {
      id: 'uuid-a1',
      score: 0.02,
      payload: {
        text: 'section chunk 1',
        path: 'notes/multi.md',
        title: 'multi',
        section_path: 'multi > overview',
        chunk_index: 1,
        parent_id: 'parent-A',
        tags: [],
        project: null,
        status: null,
        type: null,
      },
    },
    {
      id: 'uuid-pdf',
      score: 0.016,
      payload: {
        text: 'pdf page text',
        path: 'files/report.pdf',
        title: 'report',
        section_path: '',
        chunk_index: 4,
        parent_id: null,
        tags: [],
        project: null,
        status: null,
        type: null,
      },
    },
  ],
};

const SECTION_TEXT = 'Full section body — longer than either of the chunks cut out of it.';

const MOCK_SECTION_ROWS = [
  {
    path: 'notes/multi.md',
    parentId: 'parent-A',
    sectionPath: 'multi > overview',
    text: SECTION_TEXT,
    contentHash: 'hash-a',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

/**
 * A section far longer than the truncation budget, made of numbered paragraphs so that a
 * chunk taken from its middle or its tail can be pinned down in the assertions.
 */
const paragraph = (i: number): string =>
  `Параграф ${i}: строка-наполнитель достаточной длины для окна.`;
const LONG_SECTION_TEXT = Array.from({ length: 40 }, (_, i) => paragraph(i)).join('\n\n');
const MIDDLE_CHUNK_TEXT = paragraph(20);
const TAIL_CHUNK_TEXT = paragraph(39);
const SECTION_WINDOW_CHARS = 400;

/** A single grouped hit whose chunk text is `chunkText`, pointing at the long section. */
function longSectionResult(chunkText: string) {
  return {
    points: [
      {
        id: 'uuid-long',
        score: 0.033,
        payload: {
          text: chunkText,
          path: 'notes/long.md',
          title: 'long',
          section_path: 'long > body',
          chunk_index: 7,
          parent_id: 'parent-LONG',
          tags: [],
          project: null,
          status: null,
          type: null,
        },
      },
    ],
  };
}

const MOCK_LONG_SECTION_ROWS = [
  {
    path: 'notes/long.md',
    parentId: 'parent-LONG',
    sectionPath: 'long > body',
    text: LONG_SECTION_TEXT,
    contentHash: 'hash-long',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

/** `count` fused points, two chunks per section — the shape that used to starve the caller. */
function pairedSectionPool(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `uuid-pool-${i}`,
    score: 0.03 - i * 0.0001,
    payload: {
      text: `pool chunk ${i}`,
      path: `notes/pool-${Math.floor(i / 2)}.md`,
      title: `pool ${Math.floor(i / 2)}`,
      section_path: 'pool > body',
      chunk_index: i % 2,
      parent_id: `parent-pool-${Math.floor(i / 2)}`,
      tags: [],
      project: null,
      status: null,
      type: null,
    },
  }));
}

/** `count` fused points, every other one outside the folder the caller will ask for. */
function alternatingFolderPool(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `uuid-folder-${i}`,
    score: 0.03 - i * 0.0001,
    payload: {
      text: `folder chunk ${i}`,
      path: `${i % 2 === 0 ? 'Projects' : 'Archive'}/note-${i}.md`,
      title: `note ${i}`,
      section_path: 'note > body',
      chunk_index: 0,
      parent_id: `parent-folder-${i}`,
      tags: [],
      project: null,
      status: null,
      type: null,
    },
  }));
}

/**
 * Two DIFFERENT notes whose sections collide on `parent_id`. That is legitimate, not a
 * bug: the id is derived from the section's ordinal + section path only, never the file
 * path, so the first section of any note hashes to the same value. Grouping and section
 * lookup must therefore key on the composite (path, parent_id).
 */
const MOCK_COLLIDING_RESULT = {
  points: [
    {
      id: 'uuid-c0',
      score: 0.033,
      payload: {
        text: 'alpha chunk',
        path: 'notes/alpha.md',
        title: 'alpha',
        section_path: 'alpha > intro',
        chunk_index: 0,
        parent_id: 'parent-SHARED',
        tags: [],
        project: null,
        status: null,
        type: null,
      },
    },
    {
      id: 'uuid-c1',
      score: 0.02,
      payload: {
        text: 'beta chunk',
        path: 'notes/beta.md',
        title: 'beta',
        section_path: 'beta > intro',
        chunk_index: 0,
        parent_id: 'parent-SHARED',
        tags: [],
        project: null,
        status: null,
        type: null,
      },
    },
  ],
};

const ALPHA_SECTION_TEXT = 'Whole first section of alpha.md.';
const BETA_SECTION_TEXT = 'Whole first section of beta.md — a different note entirely.';

/** What `WHERE parent_id IN (...)` returns for the collision above: one row per note. */
const MOCK_COLLIDING_ROWS = [
  {
    path: 'notes/alpha.md',
    parentId: 'parent-SHARED',
    sectionPath: 'alpha > intro',
    text: ALPHA_SECTION_TEXT,
    contentHash: 'hash-alpha',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    path: 'notes/beta.md',
    parentId: 'parent-SHARED',
    sectionPath: 'beta > intro',
    text: BETA_SECTION_TEXT,
    contentHash: 'hash-beta',
    updatedAt: '2026-01-01T00:00:00.000Z',
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
const mockQdrantQuery = vi.fn().mockResolvedValue(MOCK_FUSED_RESULT);
const mockEmbed = vi.fn().mockResolvedValue(MOCK_EMBEDDING);
// Semantic search must go through embedQuery (query side), never embed (document side).
const mockEmbedQuery = vi.fn().mockResolvedValue(MOCK_EMBEDDING[0]);

const mockTenantQdrant = {
  search: mockQdrantSearch,
  scroll: mockQdrantScroll,
  query: mockQdrantQuery,
  upsert: vi.fn(),
  delete: vi.fn(),
  setPayload: vi.fn(),
};

// ── Mock per-user SQLite (drizzle's select().from().where().all() chain) ──

const mockSectionRows = vi.fn().mockReturnValue([]);
const mockUserDb = {
  select: () => ({ from: () => ({ where: () => ({ all: mockSectionRows }) }) }),
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

  // Add onRequest hook to provide getUserQdrant and getUserDb on authenticated requests
  app.addHook('onRequest', async (request) => {
    if (request.user) {
      request.getUserQdrant = () =>
        mockTenantQdrant as unknown as ReturnType<typeof request.getUserQdrant>;
      request.getUserDb = () => mockUserDb as unknown as ReturnType<typeof request.getUserDb>;
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
    // which matters now that each endpoint hits a different Qdrant method
    mockQdrantSearch.mockReset();
    mockQdrantScroll.mockReset();
    mockQdrantQuery.mockReset();
    mockSectionRows.mockReset();
    mockEmbed.mockReset();
    mockEmbedQuery.mockReset();
    // Reset to default return values
    mockQdrantSearch.mockResolvedValue(MOCK_SCORED_POINTS);
    mockQdrantScroll.mockResolvedValue(MOCK_SCROLL_RESULT);
    mockQdrantQuery.mockResolvedValue(MOCK_FUSED_RESULT);
    mockSectionRows.mockReturnValue([]);
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
      // parent_id / section_text are part of the schema everywhere, empty when unknown
      expect(first.parent_id).toBe('');
      expect(first.section_text).toBe('');
      // chunk_index defaults to 0 when the payload has none; rank is 1-based
      expect(first.chunk_index).toBe(0);
      // content_kind defaults to 'text' when the payload predates the field
      expect(first.content_kind).toBe('text');
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
      // semantic stays dense-only: no fusion, no sparse branch
      expect(mockQdrantQuery).not.toHaveBeenCalled();
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

    it('semantic scores are the clamped cosine scores from qdrant (absolute, not rescaled)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/semantic',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test' },
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
        url: '/api/vault/search/semantic',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results.map((r: { score: number }) => r.score)).toEqual([1, 0]);
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
      expect(body.results[0].parent_id).toBe('parent-1');
    });

    it('runs a single Query API call — never search() or scroll()', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'гибридный поиск' },
      });

      expect(mockQdrantQuery).toHaveBeenCalledTimes(1);
      expect(mockQdrantSearch).not.toHaveBeenCalled();
      expect(mockQdrantScroll).not.toHaveBeenCalled();
    });

    it('prefetches a dense and a bm25 branch and fuses them with RRF', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'разреженный вектор', limit: 10 },
      });

      const call = mockQdrantQuery.mock.calls[0]?.[0];
      expect(call.query).toEqual({ fusion: 'rrf' });
      // Outer limit is over-fetched 2x — dedup and the folder filter run after it
      expect(call.limit).toBe(20);
      expect(call.with_payload).toBe(true);

      const branches = call.prefetch as Array<{
        query: unknown;
        using: string;
        limit: number;
      }>;
      expect(branches).toHaveLength(2);

      const dense = branches.find((b) => b.using === 'dense');
      expect(dense?.query).toEqual(MOCK_EMBEDDING[0]);

      const sparse = branches.find((b) => b.using === 'bm25');
      const sparseVector = sparse?.query as { indices: number[]; values: number[] };
      expect(Array.isArray(sparseVector.indices)).toBe(true);
      expect(sparseVector.indices.length).toBeGreaterThan(0);
      expect(sparseVector.values).toHaveLength(sparseVector.indices.length);
    });

    it('oversamples both branches on top of the over-fetched outer limit (floor of 40)', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'oversampling', limit: 5 },
      });

      const smallCall = mockQdrantQuery.mock.calls[0]?.[0];
      expect(smallCall.limit).toBe(10);
      // 10 * 2 = 20 is below the floor, so both branches take 40
      expect((smallCall.prefetch as Array<{ limit: number }>).map((b) => b.limit)).toEqual([
        40, 40,
      ]);

      await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'oversampling', limit: 50 },
      });

      const bigCall = mockQdrantQuery.mock.calls[1]?.[0];
      // Outer over-fetch 100, and each branch is twice that — RRF cannot return more
      // points than its branches handed it.
      expect(bigCall.limit).toBe(100);
      expect((bigCall.prefetch as Array<{ limit: number }>).map((b) => b.limit)).toEqual([
        200, 200,
      ]);
    });

    it('drops the sparse branch when the query tokenizes to nothing', async () => {
      // Nothing but stop words — there is no lexical signal, dense still works
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'и не то же' },
      });

      const branches = mockQdrantQuery.mock.calls[0]?.[0].prefetch as Array<{ using: string }>;
      expect(branches.map((b) => b.using)).toEqual(['dense']);
    });

    it('embeds the query via embedQuery (query side), never via embed', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'hybrid test' },
      });

      expect(mockEmbedQuery).toHaveBeenCalledWith('hybrid test');
      expect(mockEmbed).not.toHaveBeenCalled();
    });

    it('rescales RRF scores against the top hit (first is 1.0, order preserved)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'hybrid test' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const scores = body.results.map((r: { score: number }) => r.score);
      // Raw RRF values (~0.016-0.033) would sink below the /context min_score default of 0.3
      expect(scores[0]).toBe(1);
      expect(scores[1]).toBeCloseTo(0.0163 / 0.0327, 5);
      expect(scores[1]).toBeLessThan(scores[0]);
      // Ranking order is untouched by the rescale
      expect(body.results.map((r: { path: string }) => r.path)).toEqual([
        'notes/test.md',
        'notes/other.md',
      ]);
    });

    it('all rescaled scores stay inside [0, 1]', async () => {
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

    it('propagates content_kind from the payload and defaults absent ones to text', async () => {
      mockQdrantQuery.mockResolvedValueOnce({
        points: [
          {
            id: 'uuid-k1',
            score: 0.033,
            payload: {
              text: '| id | name |\n| --- | --- |\n| 1 | a |',
              path: 'notes/table.md',
              title: 'table',
              section_path: 'table > rows',
              chunk_index: 0,
              content_kind: 'table_rows',
              tags: [],
              project: null,
              status: null,
              type: null,
            },
          },
          {
            id: 'uuid-k2',
            score: 0.02,
            payload: {
              // Indexed before content_kind existed: the field is simply absent.
              text: 'plain prose chunk',
              path: 'notes/prose.md',
              title: 'prose',
              section_path: 'prose > intro',
              chunk_index: 0,
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
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'table' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results.map((r: { content_kind: string }) => r.content_kind)).toEqual([
        'table_rows',
        'text',
      ]);
    });

    it('keeps multiple chunks of the same file (dedup key is path + chunk_index)', async () => {
      const sharedPath = 'notes/shared.md';
      mockQdrantQuery.mockResolvedValueOnce({
        points: [
          {
            id: 'uuid-s1',
            score: 0.033,
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
            score: 0.025,
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
        ],
      });

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
      mockQdrantQuery.mockResolvedValueOnce({
        points: [
          { id: 'uuid-d1', score: 0.033, payload: duplicatePayload },
          { id: 'uuid-d2', score: 0.02, payload: duplicatePayload },
        ],
      });

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
      expect(body.results[0].score).toBe(1);
    });

    it('returns an empty result set when the fusion returns nothing', async () => {
      mockQdrantQuery.mockResolvedValueOnce({ points: [] });

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

    it('passes facet filters to the outer query filter', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test', filters: { tags: ['project-a'] } },
      });

      expect(mockQdrantQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: expect.objectContaining({
            must: expect.arrayContaining([{ key: 'tags', match: { any: ['project-a'] } }]),
          }),
        }),
      );
    });

    it('hybrid search with folder filter excludes results outside folder', async () => {
      mockQdrantQuery.mockResolvedValueOnce({
        points: [
          {
            id: 'uuid-f1',
            score: 0.033,
            payload: {
              text: 'fused in projects',
              path: 'Projects/beta.md',
              title: 'beta',
              section_path: 'beta > intro',
              chunk_index: 0,
              tags: [],
              project: null,
              status: null,
              type: null,
            },
          },
          {
            id: 'uuid-f2',
            score: 0.02,
            payload: {
              text: 'fused outside',
              path: 'Archive/old.md',
              title: 'old',
              section_path: 'old > intro',
              chunk_index: 0,
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

    describe('group_by_section', () => {
      it('collapses chunks of one section into its best-ranked chunk with the section text', async () => {
        mockQdrantQuery.mockResolvedValueOnce(MOCK_SECTION_RESULT);
        mockSectionRows.mockReturnValueOnce(MOCK_SECTION_ROWS);

        const response = await app.inject({
          method: 'POST',
          url: '/api/vault/search/hybrid',
          headers: {
            authorization: 'Bearer cv-test-search-key',
            'content-type': 'application/json',
          },
          payload: { query: 'multi', group_by_section: true },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();

        const grouped = body.results.filter((r: { path: string }) => r.path === 'notes/multi.md');
        expect(grouped).toHaveLength(1);
        // The surviving chunk is the best-ranked one (chunk_index 0), not the later sibling
        expect(grouped[0].chunk_index).toBe(0);
        expect(grouped[0].parent_id).toBe('parent-A');
        expect(grouped[0].section_text).toBe(SECTION_TEXT);
        // Ranks stay a contiguous 1-based sequence after the collapse
        expect(body.results.map((r: { rank: number }) => r.rank)).toEqual([1, 2]);
      });

      it('keeps points that have no parent_id (pdf/csv/canvas have no sections)', async () => {
        mockQdrantQuery.mockResolvedValueOnce(MOCK_SECTION_RESULT);
        mockSectionRows.mockReturnValueOnce(MOCK_SECTION_ROWS);

        const response = await app.inject({
          method: 'POST',
          url: '/api/vault/search/hybrid',
          headers: {
            authorization: 'Bearer cv-test-search-key',
            'content-type': 'application/json',
          },
          payload: { query: 'multi', group_by_section: true },
        });

        const body = response.json();
        const pdf = body.results.find((r: { path: string }) => r.path === 'files/report.pdf');
        expect(pdf).toBeDefined();
        expect(pdf.parent_id).toBe('');
        expect(pdf.section_text).toBe('');
      });

      it('defaults to false: nothing is grouped and section_text stays empty', async () => {
        mockQdrantQuery.mockResolvedValueOnce(MOCK_SECTION_RESULT);
        mockSectionRows.mockReturnValue(MOCK_SECTION_ROWS);

        const response = await app.inject({
          method: 'POST',
          url: '/api/vault/search/hybrid',
          headers: {
            authorization: 'Bearer cv-test-search-key',
            'content-type': 'application/json',
          },
          payload: { query: 'multi' },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        // Both chunks of parent-A survive
        expect(body.results).toHaveLength(3);
        for (const result of body.results) {
          expect(result.section_text).toBe('');
        }
        // The section table is not even touched when grouping is off
        expect(mockSectionRows).not.toHaveBeenCalled();
      });

      it('section_max_chars truncates the section text', async () => {
        mockQdrantQuery.mockResolvedValueOnce(MOCK_SECTION_RESULT);
        mockSectionRows.mockReturnValueOnce(MOCK_SECTION_ROWS);

        const response = await app.inject({
          method: 'POST',
          url: '/api/vault/search/hybrid',
          headers: {
            authorization: 'Bearer cv-test-search-key',
            'content-type': 'application/json',
          },
          payload: { query: 'multi', group_by_section: true, section_max_chars: 12 },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        const grouped = body.results.find((r: { path: string }) => r.path === 'notes/multi.md');
        expect(grouped.section_text).toBe(SECTION_TEXT.slice(0, 12));
      });

      it('keeps both files when two notes collide on parent_id, each with its own section', async () => {
        mockQdrantQuery.mockResolvedValueOnce(MOCK_COLLIDING_RESULT);
        mockSectionRows.mockReturnValueOnce(MOCK_COLLIDING_ROWS);

        const response = await app.inject({
          method: 'POST',
          url: '/api/vault/search/hybrid',
          headers: {
            authorization: 'Bearer cv-test-search-key',
            'content-type': 'application/json',
          },
          payload: { query: 'collision', group_by_section: true },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();

        // Grouping keys on (path, parent_id): a bare parent_id key would swallow beta.md.
        expect(body.results).toHaveLength(2);
        const alpha = body.results.find((r: { path: string }) => r.path === 'notes/alpha.md');
        const beta = body.results.find((r: { path: string }) => r.path === 'notes/beta.md');
        // ...and each one gets ITS OWN section text, not whichever row came back first.
        expect(alpha.section_text).toBe(ALPHA_SECTION_TEXT);
        expect(beta.section_text).toBe(BETA_SECTION_TEXT);
      });

      describe('section_text window', () => {
        /** Injects the long-section fixture and returns the single result's section_text. */
        async function sectionTextFor(chunkText: string): Promise<string> {
          mockQdrantQuery.mockResolvedValueOnce(longSectionResult(chunkText));
          mockSectionRows.mockReturnValueOnce(MOCK_LONG_SECTION_ROWS);

          const response = await app.inject({
            method: 'POST',
            url: '/api/vault/search/hybrid',
            headers: {
              authorization: 'Bearer cv-test-search-key',
              'content-type': 'application/json',
            },
            payload: {
              query: 'long',
              group_by_section: true,
              section_max_chars: SECTION_WINDOW_CHARS,
            },
          });

          expect(response.statusCode).toBe(200);
          return response.json().results[0].section_text as string;
        }

        it('keeps a chunk from the middle of the section whole, with context around it', async () => {
          // The premise: a prefix cut would have missed this chunk completely
          expect(LONG_SECTION_TEXT.slice(0, SECTION_WINDOW_CHARS)).not.toContain(MIDDLE_CHUNK_TEXT);

          const sectionText = await sectionTextFor(MIDDLE_CHUNK_TEXT);

          expect(sectionText).toContain(MIDDLE_CHUNK_TEXT);
          // ...and the window really is a window: neighbours on BOTH sides came along
          expect(sectionText).toContain(paragraph(19));
          expect(sectionText).toContain(paragraph(21));
          expect(sectionText.startsWith('Параграф')).toBe(true);
        });

        it('keeps a chunk from the very end of the section whole', async () => {
          const sectionText = await sectionTextFor(TAIL_CHUNK_TEXT);

          expect(sectionText).toContain(TAIL_CHUNK_TEXT);
          // Nothing follows the last paragraph, so the window closes on the section end
          expect(sectionText.endsWith(TAIL_CHUNK_TEXT)).toBe(true);
          expect(sectionText).toContain(paragraph(38));
        });

        // The payload text is NOT the section body verbatim: the indexer puts the breadcrumb
        // on every chunk (the section carries it once) and, with INDEX_DOC_SUMMARY on, a
        // document annotation on top. Anchoring on the raw payload matched only chunk 0 and
        // dropped every other chunk back to the prefix cut this window replaces.
        it('anchors through the breadcrumb the indexer prepends to every chunk', async () => {
          const sectionText = await sectionTextFor(`long > body\n\n${MIDDLE_CHUNK_TEXT}`);

          expect(sectionText).toContain(MIDDLE_CHUNK_TEXT);
          expect(sectionText).not.toBe(LONG_SECTION_TEXT.slice(0, SECTION_WINDOW_CHARS));
        });

        it('anchors through the doc-summary prefix as well', async () => {
          const sectionText = await sectionTextFor(
            `Аннотация документа: о чём документ.\n\nlong > body\n\n${TAIL_CHUNK_TEXT}`,
          );

          expect(sectionText).toContain(TAIL_CHUNK_TEXT);
          expect(sectionText.endsWith(TAIL_CHUNK_TEXT)).toBe(true);
        });

        it('relocates a chunk whose stored copy drifted past its opening', async () => {
          // A table summary appended by the indexer, or a small edit to the note: the exact
          // match fails, the head of the body still pins the window to the right place.
          const sectionText = await sectionTextFor(
            `${MIDDLE_CHUNK_TEXT}\n\nСводка таблицы, которой в разделе нет.`,
          );

          expect(sectionText).toContain(MIDDLE_CHUNK_TEXT);
          expect(sectionText).not.toBe(LONG_SECTION_TEXT.slice(0, SECTION_WINDOW_CHARS));
        });

        it('falls back to a prefix when the chunk is not found in the section', async () => {
          // Index drift: the note was rewritten after this point was written
          const sectionText = await sectionTextFor('этого текста в разделе больше нет');

          expect(sectionText).toBe(LONG_SECTION_TEXT.slice(0, SECTION_WINDOW_CHARS));
        });

        it('never exceeds section_max_chars, wherever the chunk sits', async () => {
          for (const chunkText of [
            MIDDLE_CHUNK_TEXT,
            TAIL_CHUNK_TEXT,
            paragraph(0),
            'этого текста в разделе больше нет',
          ]) {
            const sectionText = await sectionTextFor(chunkText);
            expect(sectionText.length).toBeLessThanOrEqual(SECTION_WINDOW_CHARS);
            expect(sectionText.length).toBeGreaterThan(0);
          }
        });

        it('returns the whole section when it already fits the budget', async () => {
          mockQdrantQuery.mockResolvedValueOnce(MOCK_SECTION_RESULT);
          mockSectionRows.mockReturnValueOnce(MOCK_SECTION_ROWS);

          const response = await app.inject({
            method: 'POST',
            url: '/api/vault/search/hybrid',
            headers: {
              authorization: 'Bearer cv-test-search-key',
              'content-type': 'application/json',
            },
            // The chunk texts of this fixture are not substrings of its section text, so a
            // window that fired here would silently truncate a section that fits.
            payload: { query: 'multi', group_by_section: true },
          });

          const grouped = response
            .json()
            .results.find((r: { path: string }) => r.path === 'notes/multi.md');
          expect(grouped.section_text).toBe(SECTION_TEXT);
        });
      });

      it('leaves section_text empty when the section row is missing', async () => {
        mockQdrantQuery.mockResolvedValueOnce(MOCK_SECTION_RESULT);
        mockSectionRows.mockReturnValueOnce([]);

        const response = await app.inject({
          method: 'POST',
          url: '/api/vault/search/hybrid',
          headers: {
            authorization: 'Bearer cv-test-search-key',
            'content-type': 'application/json',
          },
          payload: { query: 'multi', group_by_section: true },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        for (const result of body.results) {
          expect(result.section_text).toBe('');
        }
      });
    });
  });

  describe('over-fetch of the fused limit', () => {
    /** Qdrant honours the limit it is given — that is what makes the over-fetch observable. */
    function respectRequestedLimit(pool: ReturnType<typeof pairedSectionPool>): void {
      mockQdrantQuery.mockImplementationOnce((params: { limit: number }) =>
        Promise.resolve({ points: pool.slice(0, params.limit) }),
      );
    }

    it('still returns a full page of results after sections are collapsed', async () => {
      respectRequestedLimit(pairedSectionPool(200));

      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'pool', limit: 40, group_by_section: true },
      });

      expect(response.statusCode).toBe(200);
      // Qdrant was asked for twice the requested page...
      expect(mockQdrantQuery.mock.calls[0]?.[0].limit).toBe(80);
      const body = response.json();
      // ...so collapsing 80 points of 2 chunks each still fills all 40 slots. Cutting first
      // would have handed the grader 20.
      expect(body.results).toHaveLength(40);
      expect(body.total).toBe(40);
      expect(body.results.map((r: { rank: number }) => r.rank)).toEqual(
        Array.from({ length: 40 }, (_, i) => i + 1),
      );
    });

    it('cuts to the requested limit only after the folder post-filter', async () => {
      respectRequestedLimit(alternatingFolderPool(200));

      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'pool', limit: 40, filters: { folder: 'Projects/' } },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results).toHaveLength(40);
      for (const result of body.results) {
        expect(result.path).toMatch(/^Projects\//);
      }
    });

    it('never returns more than the requested limit', async () => {
      respectRequestedLimit(pairedSectionPool(200));

      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/hybrid',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        // No grouping, no folder filter: nothing is dropped, so the over-fetched surplus
        // has to be cut off at the end instead of leaking to the caller.
        payload: { query: 'pool', limit: 10 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().results).toHaveLength(10);
    });
  });

  describe('POST /api/vault/search/lexical', () => {
    it('queries the bm25 sparse vector (never search/scroll)', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/lexical',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'ingestion', limit: 3 },
      });

      const call = mockQdrantQuery.mock.calls[0]?.[0];
      expect(call.using).toBe('bm25');
      expect(call.limit).toBe(3);
      expect(call.with_payload).toBe(true);
      // No fusion, no prefetch: this endpoint is the lexical branch on its own
      expect(call.prefetch).toBeUndefined();
      const sparseVector = call.query as { indices: number[]; values: number[] };
      expect(sparseVector.indices.length).toBeGreaterThan(0);
      expect(sparseVector.values).toHaveLength(sparseVector.indices.length);

      expect(mockQdrantScroll).not.toHaveBeenCalled();
      expect(mockQdrantSearch).not.toHaveBeenCalled();
      // The lexical path never embeds
      expect(mockEmbedQuery).not.toHaveBeenCalled();
      expect(mockEmbed).not.toHaveBeenCalled();
    });

    it('returns BM25 scores rescaled against the top hit', async () => {
      // Real BM25 sums are unbounded and would blow the schema's score maximum of 1
      mockQdrantQuery.mockResolvedValueOnce({
        points: [
          {
            id: 'uuid-l1',
            score: 12.5,
            payload: {
              text: 'strong lexical match',
              path: 'notes/lex.md',
              title: 'lex',
              section_path: 'lex > intro',
              chunk_index: 0,
              tags: [],
              project: null,
              status: null,
              type: null,
            },
          },
          {
            id: 'uuid-l2',
            score: 5,
            payload: {
              text: 'weaker lexical match',
              path: 'notes/lex2.md',
              title: 'lex2',
              section_path: 'lex2 > intro',
              chunk_index: 0,
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
        url: '/api/vault/search/lexical',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'ingestion' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results.map((r: { score: number }) => r.score)).toEqual([1, 0.4]);
      // chunk_index/rank are filled uniformly across all three search methods
      expect(
        body.results.map((r: { chunk_index: number; rank: number }) => [r.chunk_index, r.rank]),
      ).toEqual([
        [0, 1],
        [0, 2],
      ]);
    });

    it('returns an empty result without touching Qdrant when the query has no terms', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/search/lexical',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'и не то же' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().results).toEqual([]);
      expect(mockQdrantQuery).not.toHaveBeenCalled();
    });

    it('filter by tags passes MatchAny to must conditions', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/lexical',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test', filters: { tags: ['project-a'] } },
      });

      expect(mockQdrantQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: expect.objectContaining({
            must: expect.arrayContaining([{ key: 'tags', match: { any: ['project-a'] } }]),
          }),
        }),
      );
    });

    it('filter by type passes MatchValue to must conditions', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/vault/search/lexical',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test', filters: { type: 'meeting-note' } },
      });

      expect(mockQdrantQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: expect.objectContaining({
            must: expect.arrayContaining([{ key: 'type', match: { value: 'meeting-note' } }]),
          }),
        }),
      );
    });

    it('filter by folder prefix post-filters results by path.startsWith', async () => {
      mockQdrantQuery.mockResolvedValueOnce({
        points: [
          {
            id: 'uuid-a',
            score: 8,
            payload: {
              text: 'in projects',
              path: 'Projects/alpha.md',
              title: 'alpha',
              section_path: 'setup',
              chunk_index: 0,
              tags: [],
              project: null,
              status: null,
              type: null,
            },
          },
          {
            id: 'uuid-b',
            score: 4,
            payload: {
              text: 'not in projects',
              path: 'notes/other.md',
              title: 'other',
              section_path: 'main',
              chunk_index: 0,
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
        url: '/api/vault/search/lexical',
        headers: { authorization: 'Bearer cv-test-search-key', 'content-type': 'application/json' },
        payload: { query: 'test', filters: { folder: 'Projects/' } },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0].path).toBe('Projects/alpha.md');
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
