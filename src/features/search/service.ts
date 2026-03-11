import type { QdrantClient } from '@qdrant/js-client-rest';
import type { EmbeddingProvider } from '../../lib/embedding.js';
import { COLLECTION_NAME } from '../../plugins/qdrant.js';
import type { SearchFilters, SearchResult } from './schemas.js';

// Qdrant internal types we need
interface QdrantPayload {
  text?: string;
  path?: string;
  title?: string;
  section_path?: string;
  tags?: string[];
  project?: string | null;
  status?: string | null;
  type?: string | null;
  [key: string]: unknown;
}

interface ScoredPoint {
  id: string | number;
  score: number;
  payload?: QdrantPayload | null;
}

interface ScrollPoint {
  id: string | number;
  payload?: QdrantPayload | null;
}

type QdrantCondition =
  | { key: string; match: { value: string | number } }
  | { key: string; match: { any: string[] } }
  | { key: string; match: { text: string } };

interface QdrantFilter {
  must?: QdrantCondition[];
  should?: QdrantCondition[];
}

export class SearchService {
  private readonly qdrant: QdrantClient;
  private readonly embedder: EmbeddingProvider;

  constructor(qdrant: QdrantClient, embedder: EmbeddingProvider) {
    this.qdrant = qdrant;
    this.embedder = embedder;
  }

  async semantic(query: string, limit: number, filters: SearchFilters): Promise<SearchResult[]> {
    const [embedding] = await this.embedder.embed([query]);

    const result = await this.qdrant.search(COLLECTION_NAME, {
      vector: embedding as number[],
      limit,
      with_payload: true,
      filter: this.buildFilter(filters) as Parameters<QdrantClient['search']>[1]['filter'],
    });

    const points = result as unknown as ScoredPoint[];
    return points
      .filter((hit) => hit.payload?.text !== undefined && hit.payload.text !== null)
      .map((hit) => this.toSearchResult(hit.payload ?? {}, this.normalizeScore(hit.score)));
  }

  async lexical(query: string, limit: number, filters: SearchFilters): Promise<SearchResult[]> {
    const mustConditions = this.buildMustConditions(filters);
    const folderPrefix = filters.folder;

    const shouldConditions: QdrantCondition[] = [
      { key: 'text', match: { text: query } },
      { key: 'title', match: { text: query } },
      { key: 'section_path', match: { text: query } },
    ];

    const filter: QdrantFilter = {
      should: shouldConditions,
    };
    if (mustConditions.length > 0) {
      filter.must = mustConditions;
    }

    const result = await (
      this.qdrant.scroll as unknown as (
        collection: string,
        opts: { filter: unknown; limit: number; with_payload: boolean },
      ) => Promise<unknown>
    )(COLLECTION_NAME, {
      filter,
      limit,
      with_payload: true,
    });

    // scroll() returns result.points (not result.result) — see Qdrant JS client docs
    const scrollResult = result as unknown as { points: ScrollPoint[] };
    const points = scrollResult.points;

    return points
      .filter((p) => p.payload?.text !== undefined && p.payload.text !== null)
      .filter(
        (p) => folderPrefix === undefined || (p.payload?.path ?? '').startsWith(folderPrefix),
        // TODO: At scale, add a text index on path field to push filtering to Qdrant.
      )
      .map((p) => this.toSearchResult(p.payload ?? {}, 1.0));
  }

  private buildFilter(filters: SearchFilters): QdrantFilter | undefined {
    const must = this.buildMustConditions(filters);
    if (must.length === 0) return undefined;
    return { must };
  }

  private buildMustConditions(filters: SearchFilters): QdrantCondition[] {
    const conditions: QdrantCondition[] = [];

    if (filters.tags && filters.tags.length > 0) {
      // MatchAny for OR logic across tag values
      conditions.push({ key: 'tags', match: { any: filters.tags } });
    }

    if (filters.project !== undefined) {
      conditions.push({ key: 'project', match: { value: filters.project } });
    }

    if (filters.status !== undefined) {
      conditions.push({ key: 'status', match: { value: filters.status } });
    }

    if (filters.type !== undefined) {
      // Filters by note type (e.g., "meeting-note", "adr") using keyword index from Phase 5
      conditions.push({ key: 'type', match: { value: filters.type } });
    }

    // folder filter is NOT pushed to Qdrant here — path is keyword-indexed (exact match only).
    // Instead, we post-filter results by path.startsWith() in the caller.

    return conditions;
  }

  private normalizeScore(raw: number): number {
    // Clamp to [0, 1] range — no min-max normalization per batch (anti-pattern for consistency)
    return Math.min(1, Math.max(0, raw));
  }

  private toSearchResult(payload: QdrantPayload, score: number): SearchResult {
    return {
      text: typeof payload.text === 'string' ? payload.text : '',
      path: typeof payload.path === 'string' ? payload.path : '',
      title: typeof payload.title === 'string' ? payload.title : '',
      section_path: typeof payload.section_path === 'string' ? payload.section_path : '',
      score,
      tags: Array.isArray(payload.tags) ? payload.tags : [],
      project: typeof payload.project === 'string' ? payload.project : null,
      status: typeof payload.status === 'string' ? payload.status : null,
    };
  }
}
