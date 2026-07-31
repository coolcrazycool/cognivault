import type { QdrantClient } from '@qdrant/js-client-rest';
import { COLLECTION_NAME } from '../plugins/qdrant.js';

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
    vector: number[];
    payload: Record<string, unknown>;
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

  async search(params: SearchParams): Promise<unknown> {
    const { filter, ...rest } = params;
    return this.client.search(COLLECTION_NAME, {
      ...rest,
      filter: this.buildFilter(filter),
    });
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
      payload: { ...p.payload, user_id: this.userId },
    }));
    return this.client.upsert(COLLECTION_NAME, { points });
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
