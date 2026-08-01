import type { QdrantClient } from '@qdrant/js-client-rest';
import { v5 as uuidv5 } from 'uuid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingProvider } from '../../../lib/embedding.js';
import { TenantQdrantClient } from '../../../lib/tenant-qdrant-client.js';
import { SCHEME_POINT_ID, SCHEME_VERSION_FIELD } from '../../../plugins/qdrant.js';
import { SearchService } from '../service.js';

/**
 * The BM25 scheme marker (`src/plugins/qdrant.ts`) is a real point in the shared
 * collection. This file is the proof that it cannot reach a caller through any of the
 * three search endpoints, at three independent levels:
 *
 *  1. it carries no vectors, so it is not a candidate in the dense or the sparse branch;
 *  2. it carries no `user_id`, and every request that leaves `TenantQdrantClient` demands
 *     `user_id == <tenant>` on the outer filter AND on every prefetch branch — Qdrant's
 *     `match` never matches a missing payload key;
 *  3. even a point that somehow arrived anyway is dropped by `usablePoints`, which keeps
 *     only points that have `payload.text`.
 */

const USER_ID = 'user-alice';

/** The tenant condition every filter node must carry. */
const tenantCondition = { key: 'user_id', match: { value: USER_ID } };

/** The marker exactly as the qdrant plugin writes it. */
const MARKER_POINT = {
  id: SCHEME_POINT_ID,
  vector: {},
  payload: { [SCHEME_VERSION_FIELD]: 3 },
};

function createRawClient(queryPoints: unknown[] = [], searchPoints: unknown[] = []) {
  return {
    search: vi.fn().mockResolvedValue(searchPoints),
    query: vi.fn().mockResolvedValue({ points: queryPoints }),
  } as unknown as QdrantClient & {
    search: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  };
}

const embedder: EmbeddingProvider = {
  embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  embedQuery: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
} as unknown as EmbeddingProvider;

/** Every filter object in a request body: the outer one plus every (nested) prefetch. */
function filterNodes(body: unknown): Array<{ must?: unknown[] }> {
  if (typeof body !== 'object' || body === null) return [];
  const node = body as { filter?: { must?: unknown[] }; prefetch?: unknown[] };
  const found: Array<{ must?: unknown[] }> = [];
  if (node.filter !== undefined) found.push(node.filter);
  for (const branch of node.prefetch ?? []) found.push(...filterNodes(branch));
  return found;
}

describe('the BM25 scheme marker cannot leak into search results', () => {
  let raw: ReturnType<typeof createRawClient>;
  let service: SearchService;

  beforeEach(() => {
    vi.clearAllMocks();
    raw = createRawClient();
    service = new SearchService(new TenantQdrantClient(raw, USER_ID), embedder);
  });

  it('scopes every filter of every branch of all three endpoints to the tenant', async () => {
    await service.semantic('квота превышена', 10, {});
    await service.lexical('квота превышена', 10, {});
    await service.hybrid('квота превышена', 10, {});

    const bodies = [
      ...raw.search.mock.calls.map((call) => call[1]),
      ...raw.query.mock.calls.map((call) => call[1]),
    ];
    // semantic → search, lexical → query, hybrid → query.
    expect(bodies).toHaveLength(3);

    const nodes = bodies.flatMap((body) => filterNodes(body));
    // Outer filters (3) + the hybrid dense and bm25 prefetch branches (2).
    expect(nodes).toHaveLength(5);
    for (const node of nodes) {
      expect(node.must).toContainEqual(tenantCondition);
    }
  });

  it('keeps the tenant condition alongside caller filters instead of replacing them', async () => {
    await service.hybrid('квота превышена', 10, { project: 'afpc', tags: ['registry'] });

    const nodes = filterNodes(raw.query.mock.calls[0]?.[1]);
    for (const node of nodes) {
      expect(node.must).toContainEqual(tenantCondition);
    }
    // The tenant condition is appended to the caller's filter, never substituted for it.
    // (The caller's conditions ride on the outer request only — the prefetch branches
    // oversample and the outer filter prunes; the tenant condition is the one thing that
    // must be on both, and the loop above is what proves it.)
    const [outer] = nodes;
    expect(outer?.must).toContainEqual({ key: 'project', match: { value: 'afpc' } });
    expect(outer?.must).toContainEqual({ key: 'tags', match: { any: ['registry'] } });
  });

  it('drops the marker even if a request came back with it', async () => {
    // Defence in depth: this state is unreachable through the filter above, so the only
    // way to observe the second guard is to hand it the point directly.
    const leaked = [{ ...MARKER_POINT, score: 0.99 }];
    raw = createRawClient(leaked, leaked);
    service = new SearchService(new TenantQdrantClient(raw, USER_ID), embedder);

    expect(await service.semantic('квота', 10, {})).toEqual([]);
    expect(await service.lexical('квота', 10, {})).toEqual([]);
    expect(await service.hybrid('квота', 10, {})).toEqual([]);
  });

  it('uses an id no chunk can ever be given', () => {
    // Chunk ids are uuidv5 (src/plugins/pipeline.ts), which always sets the version nibble
    // to 5 and the RFC 4122 variant bits; the nil UUID has neither.
    expect(SCHEME_POINT_ID).toBe('00000000-0000-0000-0000-000000000000');
    const chunkId = uuidv5('user-alice:notes/quota.md:0', '6ba7b810-9dad-11d1-80b4-00c04fd430c8');
    expect(chunkId).not.toBe(SCHEME_POINT_ID);
    expect(chunkId[14]).toBe('5');
  });
});
