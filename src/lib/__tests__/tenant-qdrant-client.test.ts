import type { QdrantClient } from '@qdrant/js-client-rest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantQdrantClient } from '../tenant-qdrant-client.js';

function createMockClient() {
  return {
    search: vi.fn().mockResolvedValue([]),
    scroll: vi.fn().mockResolvedValue({ points: [] }),
    upsert: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    setPayload: vi.fn().mockResolvedValue({}),
  } as unknown as QdrantClient & {
    search: ReturnType<typeof vi.fn>;
    scroll: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    setPayload: ReturnType<typeof vi.fn>;
  };
}

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
    it('injects user_id filter when no caller filter provided', async () => {
      await tenant.search({ vector: [0.1, 0.2], limit: 10 });

      expect(mockClient.search).toHaveBeenCalledWith('cognivault', {
        vector: [0.1, 0.2],
        limit: 10,
        filter: {
          must: [{ key: 'user_id', match: { value: USER_ID } }],
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
        vector: [0.1, 0.2],
        limit: 5,
        with_payload: true,
        filter: {
          must: [
            { key: 'tags', match: { any: ['project-a'] } },
            { key: 'user_id', match: { value: USER_ID } },
          ],
        },
      });
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
    it('injects user_id into every point payload', async () => {
      await tenant.upsert({
        points: [
          { id: 'p1', vector: [0.1], payload: { text: 'hello', path: '/a.md' } },
          { id: 'p2', vector: [0.2], payload: { text: 'world', path: '/b.md' } },
        ],
      });

      expect(mockClient.upsert).toHaveBeenCalledWith('cognivault', {
        points: [
          { id: 'p1', vector: [0.1], payload: { text: 'hello', path: '/a.md', user_id: USER_ID } },
          { id: 'p2', vector: [0.2], payload: { text: 'world', path: '/b.md', user_id: USER_ID } },
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
        filter: {
          must: [{ key: 'user_id', match: { value: USER_ID } }],
        },
      });
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
