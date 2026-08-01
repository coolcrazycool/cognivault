import { inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../../db/schema.js';
import { sections } from '../../db/schema.js';
import type { SparseVector } from '../../lib/bm25.js';
import { BM25_VECTOR_NAME, buildSparseVector, DENSE_VECTOR_NAME } from '../../lib/bm25.js';
import type { EmbeddingProvider } from '../../lib/embedding.js';
import type { TenantQdrantClient } from '../../lib/tenant-qdrant-client.js';
import type { SearchFilters, SearchResult } from './schemas.js';

type DbInstance = BetterSQLite3Database<typeof schema>;

// Qdrant internal types we need
interface QdrantPayload {
  text?: string;
  path?: string;
  title?: string;
  section_path?: string;
  chunk_index?: number;
  parent_id?: string | null;
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

type QdrantCondition =
  | { key: string; match: { value: string | number } }
  | { key: string; match: { any: string[] } }
  | { key: string; match: { text: string } };

interface QdrantFilter {
  must?: QdrantCondition[];
  should?: QdrantCondition[];
}

/** One branch of a fusion query: a vector, the named vector it targets, and its depth. */
interface PrefetchBranch {
  query: number[] | SparseVector;
  using: string;
  limit: number;
  params?: { quantization: { rescore: boolean; oversampling: number } };
}

/**
 * Sent with the dense branch unconditionally. Quantization is opt-in per deployment
 * (`QDRANT_QUANTIZATION`), and Qdrant ignores these params on a collection that has none —
 * so sending them always costs nothing and removes a silent failure mode: enabling
 * quantization later via update_collection would otherwise leave the search running
 * without rescoring, losing accuracy with nothing in the logs to say so.
 */
const DENSE_QUANTIZATION_PARAMS = {
  quantization: { rescore: true, oversampling: 2.0 },
} as const;

/**
 * Depth of each prefetch branch before RRF merges them. Fusion can only rank what it is
 * handed: if a branch returns exactly `limit` points, a document that sits just below the
 * cut in BOTH branches is lost even though the fusion would have ranked it first.
 * Oversampling keeps the fusion input meaningful; the floor covers small limits, where 2x
 * would be far too shallow to recover anything.
 */
const FUSION_OVERSAMPLE = 2;
const FUSION_CANDIDATE_FLOOR = 40;

/** Cap on the section text returned with a grouped result, when the caller sets none. */
const DEFAULT_SECTION_MAX_CHARS = 4000;

/** Options for the hybrid endpoint's small-to-big (parent document) expansion. */
export interface HybridOptions {
  /** Collapse chunks of the same section into their best-ranked chunk. */
  groupBySection?: boolean;
  /** Truncate the expanded section text to this many characters. */
  sectionMaxChars?: number;
}

export class SearchService {
  private readonly qdrant: TenantQdrantClient;
  private readonly embedder: EmbeddingProvider;
  /**
   * Only needed for `group_by_section` — the section ("parent document") texts live in
   * SQLite, not in Qdrant. Callers that never group (e.g. `/api/vault/context`) may omit
   * it; grouping without a db then simply returns empty `section_text`.
   */
  private readonly db: DbInstance | undefined;

  constructor(qdrant: TenantQdrantClient, embedder: EmbeddingProvider, db?: DbInstance) {
    this.qdrant = qdrant;
    this.embedder = embedder;
    this.db = db;
  }

  async semantic(query: string, limit: number, filters: SearchFilters): Promise<SearchResult[]> {
    // embedQuery (not embed) — asymmetric models instruct the query side only.
    const embedding = await this.embedder.embedQuery(query);

    // Dense-only, and deliberately still on search(): the tenant client already targets the
    // named `dense` vector there, so the contract of this endpoint is unchanged.
    const result = await this.qdrant.search({
      vector: embedding,
      limit,
      with_payload: true,
      filter: this.buildFilter(filters) as { must?: unknown[] },
    });

    const points = this.usablePoints(result as unknown as ScoredPoint[], filters.folder);

    // Cosine similarity is already an absolute, comparable score — clamp only, so a
    // semantic score keeps meaning across requests.
    return points.map((hit, i) =>
      this.toSearchResult(hit.payload ?? {}, this.clampScore(hit.score), i + 1),
    );
  }

  async lexical(query: string, limit: number, filters: SearchFilters): Promise<SearchResult[]> {
    const sparse = buildSparseVector(query);
    // Nothing survived tokenization (stop words / single characters only). Qdrant rejects an
    // empty sparse query, and there is no lexical signal to search with anyway.
    if (sparse.indices.length === 0) return [];

    const result = await this.qdrant.query({
      query: sparse,
      using: BM25_VECTOR_NAME,
      limit,
      with_payload: true,
      filter: this.buildFilter(filters) as { must?: unknown[] },
    });

    const points = this.usablePoints(result.points as ScoredPoint[], filters.folder);
    // BM25 scores are unbounded sums of term weights — rescale for the same reason as RRF.
    return this.finalize(points);
  }

  async hybrid(
    query: string,
    limit: number,
    filters: SearchFilters,
    options: HybridOptions = {},
  ): Promise<SearchResult[]> {
    // embedQuery (not embed) — asymmetric models instruct the query side only. The sparse
    // side goes through the SAME builder as the indexer, or the terms would not line up.
    const denseVector = await this.embedder.embedQuery(query);
    const sparseVector = buildSparseVector(query);
    const candidateLimit = Math.max(limit * FUSION_OVERSAMPLE, FUSION_CANDIDATE_FLOOR);

    const prefetch: PrefetchBranch[] = [
      {
        query: denseVector,
        using: DENSE_VECTOR_NAME,
        limit: candidateLimit,
        params: DENSE_QUANTIZATION_PARAMS,
      },
    ];
    // A query of nothing but stop words has no lexical branch; the dense side still works.
    if (sparseVector.indices.length > 0) {
      prefetch.push({ query: sparseVector, using: BM25_VECTOR_NAME, limit: candidateLimit });
    }

    // One round trip: both branches are retrieved and fused server-side. The tenant client
    // injects the user_id condition into the outer filter AND into every prefetch branch,
    // so isolation must not be repeated here.
    const result = await this.qdrant.query({
      prefetch,
      query: { fusion: 'rrf' },
      limit,
      with_payload: true,
      filter: this.buildFilter(filters) as { must?: unknown[] },
    });

    let points = this.usablePoints(result.points as ScoredPoint[], filters.folder);

    // Safety net against duplicate points from Qdrant. The key is path + chunk_index --
    // several chunks of the SAME file in the result set are desired behaviour (the UI
    // relies on multiple hits per file for smart expansion), so we never dedupe by path.
    points = this.dedupeChunks(points);

    let sectionTexts: Map<string, string> | undefined;
    if (options.groupBySection === true) {
      points = this.dedupeSections(points);
      sectionTexts = this.loadSectionTexts(points, options.sectionMaxChars);
    }

    return this.finalize(points, sectionTexts);
  }

  /** Drops payload-less points and applies the folder prefix post-filter. */
  private usablePoints(points: ScoredPoint[], folderPrefix: string | undefined): ScoredPoint[] {
    return points
      .filter((hit) => hit.payload?.text !== undefined && hit.payload.text !== null)
      .filter(
        (hit) => folderPrefix === undefined || (hit.payload?.path ?? '').startsWith(folderPrefix),
        // TODO: At scale, add a text index on path field to push filtering to Qdrant.
      );
  }

  /** Removes points that repeat an already-seen (path, chunk_index) pair. */
  private dedupeChunks(points: ScoredPoint[]): ScoredPoint[] {
    const seen = new Set<string>();
    const deduped: ScoredPoint[] = [];
    for (const point of points) {
      const key = `${point.payload?.path ?? ''}::${point.payload?.chunk_index ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(point);
    }
    return deduped;
  }

  /**
   * Keeps the best-ranked chunk of every section and drops its siblings — the caller gets
   * the whole section text instead, so the extra chunks would only be duplicate content.
   *
   * Points with no `parent_id` (pdf/csv/canvas/excalidraw have no sections) are passed
   * through untouched: they are not part of any group and must not be swallowed by it.
   */
  private dedupeSections(points: ScoredPoint[]): ScoredPoint[] {
    const seen = new Set<string>();
    const kept: ScoredPoint[] = [];
    for (const point of points) {
      const key = this.sectionKey(point);
      if (key === undefined) {
        kept.push(point);
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(point);
    }
    return kept;
  }

  /**
   * Composite (path, parent_id) identity of a section, or undefined for points that have
   * none. The path is part of the key because `parent_id` is derived from the section's
   * position inside its note only — two different notes can produce the same one.
   */
  private sectionKey(point: ScoredPoint): string | undefined {
    const parentId = point.payload?.parent_id;
    if (typeof parentId !== 'string' || parentId.length === 0) return undefined;
    return `${point.payload?.path ?? ''} ${parentId}`;
  }

  /** Fetches the parent-document text of every grouped point in a single SQLite query. */
  private loadSectionTexts(
    points: ScoredPoint[],
    maxChars: number | undefined,
  ): Map<string, string> {
    const texts = new Map<string, string>();
    if (this.db === undefined) return texts;

    const parentIds = [
      ...new Set(
        points
          .map((point) => point.payload?.parent_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ];
    if (parentIds.length === 0) return texts;

    const limit = maxChars !== undefined && maxChars > 0 ? maxChars : DEFAULT_SECTION_MAX_CHARS;
    // Filtering on parent_id alone can match rows of other notes (the id excludes the path);
    // the composite key below is what pins each row back to the right note.
    const rows = this.db.select().from(sections).where(inArray(sections.parentId, parentIds)).all();
    for (const row of rows) {
      texts.set(`${row.path} ${row.parentId}`, row.text.slice(0, limit));
    }
    return texts;
  }

  /** Rescales scores, attaches section texts and assigns 1-based ranks. */
  private finalize(points: ScoredPoint[], sectionTexts?: Map<string, string>): SearchResult[] {
    const scores = this.rescaleToTop(points);
    return points.map((point, i) => {
      const key = this.sectionKey(point);
      const sectionText = (key !== undefined ? sectionTexts?.get(key) : undefined) ?? '';
      return this.toSearchResult(point.payload ?? {}, scores[i] ?? 0, i + 1, sectionText);
    });
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

    // folder filter is NOT pushed to Qdrant here -- path is keyword-indexed (exact match only).
    // Instead, we post-filter results by path.startsWith() in the caller.

    return conditions;
  }

  private clampScore(raw: number): number {
    // Clamp to [0, 1] range -- no min-max normalization per batch (anti-pattern for consistency)
    return Math.min(1, Math.max(0, raw));
  }

  /**
   * Rescales a result set against its own top hit: rank 1 becomes 1.0, everything else keeps
   * its proportion, order is untouched.
   *
   * Fusion and BM25 scores are not similarities. Qdrant's RRF sums 1/(k + rank), which lands
   * every result in a ~0.016-0.033 band, and BM25 sums unbounded term weights. Passing either
   * through raw breaks every consumer that compares a score against a threshold — most
   * concretely `/api/vault/context`, whose `min_score` defaults to 0.3 and would silently
   * discard the entire result set (exactly the Wave 0 regression). The schema also caps
   * `score` at 1, so unbounded BM25 sums would fail response validation outright.
   */
  private rescaleToTop(points: ScoredPoint[]): number[] {
    let max = 0;
    for (const point of points) {
      if (point.score > max) max = point.score;
    }
    if (max <= 0) return points.map(() => 0);
    return points.map((point) => this.clampScore(point.score / max));
  }

  private toSearchResult(
    payload: QdrantPayload,
    score: number,
    rank: number,
    sectionText = '',
  ): SearchResult {
    return {
      text: typeof payload.text === 'string' ? payload.text : '',
      path: typeof payload.path === 'string' ? payload.path : '',
      title: typeof payload.title === 'string' ? payload.title : '',
      section_path: typeof payload.section_path === 'string' ? payload.section_path : '',
      score,
      tags: Array.isArray(payload.tags) ? payload.tags : [],
      project: typeof payload.project === 'string' ? payload.project : null,
      status: typeof payload.status === 'string' ? payload.status : null,
      type: typeof payload.type === 'string' ? payload.type : null,
      chunk_index: typeof payload.chunk_index === 'number' ? payload.chunk_index : 0,
      parent_id: typeof payload.parent_id === 'string' ? payload.parent_id : '',
      section_text: sectionText,
      rank,
    };
  }
}
