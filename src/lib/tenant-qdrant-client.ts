import type { QdrantClient } from '@qdrant/js-client-rest';
import { COLLECTION_NAME } from '../plugins/qdrant.js';
import { DENSE_VECTOR_NAME } from './bm25.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Qdrant client types are complex; we use `any` at the boundary for filter pass-through */

interface QdrantFilter {
  must?: unknown[];
  should?: unknown[];
}

interface SearchParams {
  vector: number[];
  limit: number;
  filter?: QdrantFilter;
  with_payload?: boolean;
  score_threshold?: number;
}

interface ScrollParams {
  filter?: QdrantFilter;
  limit: number;
  with_payload?: boolean;
}

interface UpsertParams {
  points: Array<{
    id: string | number;
    /**
     * Named vectors, e.g. `{ dense: number[], bm25: { indices, values } }`.
     *
     * A bare `number[]` is the legacy unnamed form; the collection no longer accepts
     * it, so it is wrapped into `{ [DENSE_VECTOR_NAME]: vector }` on the way out. The
     * union exists only until every caller emits named vectors.
     */
    vector: Record<string, unknown> | number[];
    payload: Record<string, unknown>;
  }>;
}

/**
 * A `query` (Universal Query API) call: dense/sparse/fusion in one request.
 * Shapes of `prefetch`/`query`/`params` are passed through to the client verbatim —
 * this wrapper only exists to enforce the tenant filter.
 */
interface QueryParams {
  prefetch?: unknown[];
  query?: unknown;
  using?: string;
  limit: number;
  filter?: QdrantFilter;
  with_payload?: boolean;
  params?: unknown;
}

interface QueryResponse {
  points: Array<{
    id: string | number;
    score: number;
    payload?: Record<string, unknown>;
  }>;
}

interface DeleteParams {
  filter: QdrantFilter;
}

interface SetPayloadParams {
  payload: Record<string, unknown>;
  filter: QdrantFilter;
}

export class TenantQdrantClient {
  private readonly client: QdrantClient;
  private readonly userId: string;

  constructor(client: QdrantClient, userId: string) {
    this.client = client;
    this.userId = userId;
  }

  private get userFilter(): { key: string; match: { value: string } } {
    return { key: 'user_id', match: { value: this.userId } };
  }

  private mergeMust(existing?: unknown[]): unknown[] {
    return [...(existing ?? []), this.userFilter];
  }

  private buildFilter(base: QdrantFilter | undefined): Record<string, unknown> {
    return { ...base, must: this.mergeMust(base?.must) } as Record<string, unknown>;
  }

  /**
   * Every element of `prefetch` carries its OWN filter, and Qdrant applies it in
   * isolation — an unfiltered prefetch would oversample other tenants' points and feed
   * them into the fusion step. So the tenant condition is injected into each branch
   * (recursively: prefetches nest).
   */
  private scopePrefetch(entry: unknown): unknown {
    if (typeof entry !== 'object' || entry === null) {
      return entry;
    }
    const source = entry as { filter?: QdrantFilter; prefetch?: unknown };
    const scoped: Record<string, unknown> = {
      ...(entry as Record<string, unknown>),
      filter: this.buildFilter(source.filter),
    };
    if (Array.isArray(source.prefetch)) {
      scoped.prefetch = source.prefetch.map((nested) => this.scopePrefetch(nested));
    }
    return scoped;
  }

  async search(params: SearchParams): Promise<unknown> {
    const { filter, vector, ...rest } = params;
    return this.client.search(COLLECTION_NAME, {
      ...rest,
      // The collection uses named vectors; a bare array would target the (nonexistent)
      // default vector.
      vector: { name: DENSE_VECTOR_NAME, vector },
      filter: this.buildFilter(filter),
    });
  }

  /**
   * Universal Query API — dense, sparse and fusion (RRF) in one round trip.
   * The tenant filter goes on the outer request AND on every prefetch branch.
   */
  async query(params: QueryParams): Promise<QueryResponse> {
    const { filter, prefetch, ...rest } = params;
    const body: Record<string, unknown> = {
      ...rest,
      filter: this.buildFilter(filter),
    };
    if (prefetch !== undefined) {
      body.prefetch = prefetch.map((entry) => this.scopePrefetch(entry));
    }
    const result = await this.client.query(
      COLLECTION_NAME,
      body as Parameters<QdrantClient['query']>[1],
    );
    return result as unknown as QueryResponse;
  }

  async scroll(params: ScrollParams): Promise<unknown> {
    const { filter, ...rest } = params;
    return this.client.scroll(COLLECTION_NAME, {
      ...rest,
      filter: this.buildFilter(filter),
    });
  }

  async upsert(params: UpsertParams): Promise<unknown> {
    const points = params.points.map((p) => ({
      ...p,
      vector: Array.isArray(p.vector) ? { [DENSE_VECTOR_NAME]: p.vector } : p.vector,
      payload: { ...p.payload, user_id: this.userId },
    }));
    return this.client.upsert(COLLECTION_NAME, { points } as Parameters<QdrantClient['upsert']>[1]);
  }

  async delete(params: DeleteParams): Promise<unknown> {
    const { filter } = params;
    // wait: true — callers (pipeline re-index, admin purge) must observe the delete
    // before writing replacements, otherwise stale points can survive the operation.
    return this.client.delete(COLLECTION_NAME, {
      wait: true,
      filter: this.buildFilter(filter),
    });
  }

  async setPayload(params: SetPayloadParams): Promise<unknown> {
    const { filter, ...rest } = params;
    return this.client.setPayload(COLLECTION_NAME, {
      ...rest,
      filter: this.buildFilter(filter),
    });
  }
}
