import type { QdrantClient } from '@qdrant/js-client-rest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantQdrantClient } from '../tenant-qdrant-client.js';

function createMockClient() {
  return {
    search: vi.fn().mockResolvedValue([]),
    query: vi.fn().mockResolvedValue({ points: [] }),
    scroll: vi.fn().mockResolvedValue({ points: [] }),
    upsert: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    setPayload: vi.fn().mockResolvedValue({}),
  } as unknown as QdrantClient & {
    search: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    scroll: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    setPayload: ReturnType<typeof vi.fn>;
  };
}

/** The tenant condition every call must carry. */
const tenantCondition = (userId: string) => ({ key: 'user_id', match: { value: userId } });

describe('TenantQdrantClient', () => {
  const USER_ID = 'user-alice';
  let mockClient: ReturnType<typeof createMockClient>;
  let tenant: TenantQdrantClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
    tenant = new TenantQdrantClient(mockClient, USER_ID);
  });

  describe('search', () => {
    it('injects user_id filter and targets the named dense vector', async () => {
      await tenant.search({ vector: [0.1, 0.2], limit: 10 });

      expect(mockClient.search).toHaveBeenCalledWith('cognivault', {
        // Named-vector collection: a bare array would hit a default vector that no
        // longer exists.
        vector: { name: 'dense', vector: [0.1, 0.2] },
        limit: 10,
        filter: {
          must: [tenantCondition(USER_ID)],
        },
      });
    });

    it('merges user_id alongside existing must conditions', async () => {
      await tenant.search({
        vector: [0.1, 0.2],
        limit: 5,
        filter: {
          must: [{ key: 'tags', match: { any: ['project-a'] } }],
        },
        with_payload: true,
      });

      expect(mockClient.search).toHaveBeenCalledWith('cognivault', {
        vector: { name: 'dense', vector: [0.1, 0.2] },
        limit: 5,
        with_payload: true,
        filter: {
          must: [{ key: 'tags', match: { any: ['project-a'] } }, tenantCondition(USER_ID)],
        },
      });
    });
  });

  describe('query', () => {
    /** The options `query` was called with, typed for assertions. */
    function queryBody(): {
      filter?: { must?: unknown[] };
      prefetch?: Array<{ filter?: { must?: unknown[] }; prefetch?: unknown[] }>;
      [key: string]: unknown;
    } {
      return mockClient.query.mock.calls[0]?.[1];
    }

    it('injects user_id into the outer filter when the caller passes none', async () => {
      await tenant.query({ query: [0.1, 0.2], using: 'dense', limit: 10, with_payload: true });

      expect(mockClient.query).toHaveBeenCalledWith('cognivault', {
        query: [0.1, 0.2],
        using: 'dense',
        limit: 10,
        with_payload: true,
        filter: { must: [tenantCondition(USER_ID)] },
      });
    });

    it('injects user_id into EVERY prefetch branch, not just the outer request', async () => {
      await tenant.query({
        prefetch: [
          { query: [0.1, 0.2], using: 'dense', limit: 100 },
          { query: { indices: [1, 7], values: [0.5, 0.2] }, using: 'bm25', limit: 100 },
        ],
        query: { fusion: 'rrf' },
        limit: 10,
        with_payload: true,
      });

      const body = queryBody();
      expect(body.filter?.must).toEqual([tenantCondition(USER_ID)]);
      expect(body.prefetch).toHaveLength(2);
      for (const branch of body.prefetch ?? []) {
        // An unfiltered branch would oversample other tenants' points into the fusion.
        expect(branch.filter?.must).toEqual([tenantCondition(USER_ID)]);
      }
      // The branch payloads themselves are passed through untouched.
      expect(body.prefetch?.[0]).toMatchObject({ query: [0.1, 0.2], using: 'dense', limit: 100 });
      expect(body.prefetch?.[1]).toMatchObject({ using: 'bm25', limit: 100 });
    });

    it('merges the tenant condition into filters the prefetch branches already carry', async () => {
      await tenant.query({
        prefetch: [
          {
            query: [0.1],
            using: 'dense',
            limit: 50,
            filter: { must: [{ key: 'project', match: { value: 'my-proj' } }] },
          },
        ],
        query: { fusion: 'rrf' },
        limit: 5,
        filter: { should: [{ key: 'tags', match: { any: ['a'] } }] },
      });

      const body = queryBody();
      expect(body.filter).toEqual({
        should: [{ key: 'tags', match: { any: ['a'] } }],
        must: [tenantCondition(USER_ID)],
      });
      expect(body.prefetch?.[0]?.filter?.must).toEqual([
        { key: 'project', match: { value: 'my-proj' } },
        tenantCondition(USER_ID),
      ]);
    });

    it('scopes nested prefetch branches too', async () => {
      await tenant.query({
        prefetch: [
          {
            prefetch: [{ query: [0.1], using: 'dense', limit: 200 }],
            query: { fusion: 'rrf' },
            limit: 50,
          },
        ],
        limit: 5,
      });

      const nested = queryBody().prefetch?.[0]?.prefetch as Array<{
        filter?: { must?: unknown[] };
      }>;
      expect(nested[0]?.filter?.must).toEqual([tenantCondition(USER_ID)]);
    });

    it('omits prefetch entirely when the caller passes none', async () => {
      await tenant.query({ query: [0.1], using: 'dense', limit: 3 });

      expect(queryBody()).not.toHaveProperty('prefetch');
    });

    it('returns the points of the query response', async () => {
      mockClient.query.mockResolvedValue({
        points: [{ id: 'p1', score: 0.9, payload: { text: 'hi' } }],
      });

      const result = await tenant.query({ query: [0.1], using: 'dense', limit: 1 });

      expect(result.points).toEqual([{ id: 'p1', score: 0.9, payload: { text: 'hi' } }]);
    });
  });

  describe('scroll', () => {
    it('injects user_id into must array', async () => {
      await tenant.scroll({ limit: 20, with_payload: true });

      expect(mockClient.scroll).toHaveBeenCalledWith('cognivault', {
        limit: 20,
        with_payload: true,
        filter: {
          must: [{ key: 'user_id', match: { value: USER_ID } }],
        },
      });
    });

    it('preserves should conditions while adding user_id to must', async () => {
      await tenant.scroll({
        filter: {
          should: [
            { key: 'text', match: { text: 'query' } },
            { key: 'title', match: { text: 'query' } },
          ],
        },
        limit: 10,
        with_payload: true,
      });

      expect(mockClient.scroll).toHaveBeenCalledWith('cognivault', {
        limit: 10,
        with_payload: true,
        filter: {
          must: [{ key: 'user_id', match: { value: USER_ID } }],
          should: [
            { key: 'text', match: { text: 'query' } },
            { key: 'title', match: { text: 'query' } },
          ],
        },
      });
    });

    it('preserves existing must conditions alongside user_id', async () => {
      await tenant.scroll({
        filter: {
          must: [{ key: 'project', match: { value: 'my-proj' } }],
          should: [{ key: 'text', match: { text: 'test' } }],
        },
        limit: 5,
        with_payload: true,
      });

      expect(mockClient.scroll).toHaveBeenCalledWith('cognivault', {
        limit: 5,
        with_payload: true,
        filter: {
          must: [
            { key: 'project', match: { value: 'my-proj' } },
            { key: 'user_id', match: { value: USER_ID } },
          ],
          should: [{ key: 'text', match: { text: 'test' } }],
        },
      });
    });
  });

  describe('upsert', () => {
    it('passes named vectors through untouched and stamps user_id into every payload', async () => {
      await tenant.upsert({
        points: [
          {
            id: 'p1',
            vector: { dense: [0.1], bm25: { indices: [3], values: [1.5] } },
            payload: { text: 'hello', path: '/a.md' },
          },
          {
            id: 'p2',
            vector: { dense: [0.2], bm25: { indices: [4], values: [0.5] } },
            payload: { text: 'world', path: '/b.md' },
          },
        ],
      });

      expect(mockClient.upsert).toHaveBeenCalledWith('cognivault', {
        points: [
          {
            id: 'p1',
            vector: { dense: [0.1], bm25: { indices: [3], values: [1.5] } },
            payload: { text: 'hello', path: '/a.md', user_id: USER_ID },
          },
          {
            id: 'p2',
            vector: { dense: [0.2], bm25: { indices: [4], values: [0.5] } },
            payload: { text: 'world', path: '/b.md', user_id: USER_ID },
          },
        ],
      });
    });

    it('wraps a legacy bare array into the named dense vector', async () => {
      await tenant.upsert({
        points: [{ id: 'p1', vector: [0.1, 0.2], payload: { text: 'hello' } }],
      });

      expect(mockClient.upsert).toHaveBeenCalledWith('cognivault', {
        points: [
          { id: 'p1', vector: { dense: [0.1, 0.2] }, payload: { text: 'hello', user_id: USER_ID } },
        ],
      });
    });
  });

  describe('delete', () => {
    it('injects user_id into filter must array', async () => {
      await tenant.delete({
        filter: {
          must: [{ key: 'path', match: { value: '/old.md' } }],
        },
      });

      expect(mockClient.delete).toHaveBeenCalledWith('cognivault', {
        wait: true,
        filter: {
          must: [
            { key: 'path', match: { value: '/old.md' } },
            { key: 'user_id', match: { value: USER_ID } },
          ],
        },
      });
    });

    it('creates must array with user_id when no existing must', async () => {
      await tenant.delete({
        filter: {},
      });

      expect(mockClient.delete).toHaveBeenCalledWith('cognivault', {
        wait: true,
        filter: {
          must: [{ key: 'user_id', match: { value: USER_ID } }],
        },
      });
    });

    it('always passes wait: true so callers observe the delete before re-writing', async () => {
      await tenant.delete({ filter: { must: [{ key: 'chunk_index', range: { gte: 0 } }] } });

      const [, payload] = mockClient.delete.mock.calls[0] as [string, { wait?: boolean }];
      expect(payload.wait).toBe(true);
    });
  });

  describe('setPayload', () => {
    it('injects user_id into filter must array', async () => {
      await tenant.setPayload({
        payload: { status: 'indexed' },
        filter: {
          must: [{ key: 'path', match: { value: '/doc.md' } }],
        },
      });

      expect(mockClient.setPayload).toHaveBeenCalledWith('cognivault', {
        payload: { status: 'indexed' },
        filter: {
          must: [
            { key: 'path', match: { value: '/doc.md' } },
            { key: 'user_id', match: { value: USER_ID } },
          ],
        },
      });
    });

    it('creates must array with user_id when no existing must', async () => {
      await tenant.setPayload({
        payload: { indexed: true },
        filter: {},
      });

      expect(mockClient.setPayload).toHaveBeenCalledWith('cognivault', {
        payload: { indexed: true },
        filter: {
          must: [{ key: 'user_id', match: { value: USER_ID } }],
        },
      });
    });
  });
});
