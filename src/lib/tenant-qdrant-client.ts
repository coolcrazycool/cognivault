import type { QdrantClient } from '@qdrant/js-client-rest';
import { COLLECTION_NAME } from '../plugins/qdrant.js';

interface FilterCondition {
  key?: string;
  match?: { value?: string | number; any?: string[]; text?: string };
  is_empty?: { key: string };
  [key: string]: unknown;
}

interface QdrantFilter {
  must?: FilterCondition[];
  should?: FilterCondition[];
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

  private get userFilter(): FilterCondition {
    return { key: 'user_id', match: { value: this.userId } };
  }

  private mergeMust(existing?: FilterCondition[]): FilterCondition[] {
    return [...(existing ?? []), this.userFilter];
  }

  async search(params: SearchParams): Promise<unknown> {
    const { filter, ...rest } = params;
    return this.client.search(COLLECTION_NAME, {
      ...rest,
      filter: { ...filter, must: this.mergeMust(filter?.must) },
    });
  }

  async scroll(params: ScrollParams): Promise<unknown> {
    const { filter, ...rest } = params;
    return this.client.scroll(COLLECTION_NAME, {
      ...rest,
      filter: { ...filter, must: this.mergeMust(filter?.must) },
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
    return this.client.delete(COLLECTION_NAME, {
      filter: { ...filter, must: this.mergeMust(filter.must) },
    });
  }

  async setPayload(params: SetPayloadParams): Promise<unknown> {
    const { filter, ...rest } = params;
    return this.client.setPayload(COLLECTION_NAME, {
      ...rest,
      filter: { ...filter, must: this.mergeMust(filter.must) },
    });
  }
}
