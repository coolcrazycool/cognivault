import { inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../../db/schema.js';
import { sections } from '../../db/schema.js';
import type { SparseVector } from '../../lib/bm25.js';
import { BM25_VECTOR_NAME, buildSparseVector, DENSE_VECTOR_NAME } from '../../lib/bm25.js';
import { DOC_SUMMARY_PREFIX } from '../../lib/chunker.js';
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

/**
 * Over-fetch of the OUTER (fused) limit — a different level from FUSION_OVERSAMPLE above.
 * That one deepens each PREFETCH BRANCH so RRF has enough to fuse; this one deepens what
 * RRF itself hands back, because everything after it only ever removes points: duplicate
 * (path, chunk_index) pairs, sibling chunks collapsed by `group_by_section`, and the folder
 * post-filter. Asking Qdrant for exactly `limit` therefore delivers fewer than `limit`
 * results to the caller (measured: ~32-35 of 40 at 1.23 chunks per section). We ask for
 * more, then cut to `limit` once every filter has run.
 */
const POST_FILTER_OVERFETCH = 2;

/**
 * Ceiling on that over-fetch. The cost here is payload transfer, not ranking, and the API
 * caps `limit` at 50, so this only guards internal callers that pass something larger.
 */
const POST_FILTER_OVERFETCH_CAP = 200;

/** Cap on the section text returned with a grouped result, when the caller sets none. */
const DEFAULT_SECTION_MAX_CHARS = 4000;

/**
 * Head of a chunk body used to relocate it in its section when the two are no longer
 * byte-identical. Long enough that it cannot collide with a neighbouring paragraph, short
 * enough to survive an edit anywhere past the chunk's opening.
 */
const ANCHOR_PROBE_CHARS = 120;

/**
 * Below this the probe is too short to identify a position, so the chunk's opening line is
 * kept only when it is at least this long; a shorter one (a heading, a list marker) falls
 * back to the fixed-width head instead.
 */
const ANCHOR_MIN_PROBE_CHARS = 24;

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
    // How many fused points we ask for; the caller still gets exactly `limit` (see below).
    const fetchLimit = Math.min(limit * POST_FILTER_OVERFETCH, POST_FILTER_OVERFETCH_CAP);
    // Branch depth is oversampled on top of the over-fetched outer limit: RRF can never
    // return more than its branches saw, so the branches must stay the deeper of the two.
    const candidateLimit = Math.max(fetchLimit * FUSION_OVERSAMPLE, FUSION_CANDIDATE_FLOOR);

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
      limit: fetchLimit,
      with_payload: true,
      filter: this.buildFilter(filters) as { must?: unknown[] },
    });

    let points = this.usablePoints(result.points as ScoredPoint[], filters.folder);

    // Safety net against duplicate points from Qdrant. The key is path + chunk_index --
    // several chunks of the SAME file in the result set are desired behaviour (the UI
    // relies on multiple hits per file for smart expansion), so we never dedupe by path.
    points = this.dedupeChunks(points);

    if (options.groupBySection === true) {
      points = this.dedupeSections(points);
    }

    // Every removal above has happened by now, so this is the first point at which cutting
    // to `limit` yields `limit` results instead of "whatever survived".
    points = points.slice(0, limit);

    // Section texts are loaded only for the points that actually ship — one SQLite round
    // trip either way, but no window is computed for a point that was just cut.
    const sectionTexts =
      options.groupBySection === true
        ? this.loadSectionTexts(points, options.sectionMaxChars)
        : undefined;

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
      texts.set(`${row.path} ${row.parentId}`, row.text);
    }

    // Truncation is per POINT, not per row: the window is centred on the chunk that was
    // actually retrieved, so the passage the ranker matched is always inside what ships.
    // (`texts` above holds the raw, untruncated row text — it is never returned as is.)
    const windows = new Map<string, string>();
    for (const point of points) {
      const key = this.sectionKey(point);
      if (key === undefined || windows.has(key)) continue;
      const full = texts.get(key);
      if (full === undefined) continue;
      const chunkText = typeof point.payload?.text === 'string' ? point.payload.text : '';
      const sectionPath =
        typeof point.payload?.section_path === 'string' ? point.payload.section_path : '';
      windows.set(key, this.sectionWindow(full, chunkText, sectionPath, limit));
    }
    return windows;
  }

  /**
   * Cuts at most `limit` characters out of a section so that the retrieved chunk is inside
   * them, with as much surrounding context as the budget allows.
   *
   * A plain `slice(0, limit)` prefix is what this replaces. Measured on the corpus: 4.4% of
   * sections are longer than a 4000-char cut, they hold 17.3% of all chunks, and for 6.6% of
   * ALL chunks the retrieved text fell outside that prefix entirely — the caller was handed
   * a passage that demonstrably does not contain what matched.
   *
   * Falls back to the prefix when the chunk cannot be located in the section (index drift —
   * the note was rewritten after the point was indexed): an arbitrary window would be no
   * better than the prefix, and the prefix at least starts where the section does.
   */
  private sectionWindow(
    sectionText: string,
    chunkText: string,
    sectionPath: string,
    limit: number,
  ): string {
    if (sectionText.length <= limit) return sectionText;

    // The stored payload text is NOT a substring of the section row: the indexer prepends
    // the breadcrumb to every chunk (the section repeats it only once, at its head) and,
    // with INDEX_DOC_SUMMARY on, a document annotation on top of that. Anchoring on the raw
    // payload therefore missed on every chunk but the first and silently degraded the whole
    // window back to `slice(0, limit)`. Anchor on the body instead.
    const body = this.chunkBody(chunkText, sectionPath);
    const anchor = this.locateChunk(sectionText, body);
    if (anchor === -1) return sectionText.slice(0, limit);

    // A probe match (see `locateChunk`) can point at a body that runs past the section end;
    // clamping keeps `anchorEnd` a real offset so the snaps below stay inside the string.
    const anchorEnd = Math.min(anchor + body.length, sectionText.length);
    const chunkLength = anchorEnd - anchor;

    // The chunk alone does not fit. Nothing can keep it whole, so start where it starts:
    // the beginning of the match still beats the beginning of the section.
    if (chunkLength >= limit) return sectionText.slice(anchor, anchor + limit);

    // Spend the spare budget on both sides of the chunk, then pin the window inside the
    // section — near either edge the clamp shifts the window rather than shortening it.
    const padding = limit - chunkLength;
    const centred = Math.max(0, anchor - Math.floor(padding / 2));
    let start = Math.max(0, Math.min(sectionText.length, centred + limit) - limit);

    // Snap to paragraph/line/word boundaries so the window neither opens nor closes
    // mid-word. Both snaps are constrained to stay clear of [anchor, anchorEnd]:
    // readability never costs a single character of the chunk itself.
    start = this.snapStart(sectionText, start, anchor);
    // The start snap only ever moves forward, so re-deriving the end reclaims that budget.
    const end = this.snapEnd(sectionText, Math.min(sectionText.length, start + limit), anchorEnd);

    return sectionText.slice(start, end);
  }

  /**
   * The retrieved chunk stripped of the two prefixes the indexer adds to the payload text
   * but not to the section row: the optional document annotation (`INDEX_DOC_SUMMARY`) and
   * the breadcrumb every chunk carries as its first line. What is left is the chunk body as
   * it appears inside the section.
   */
  private chunkBody(chunkText: string, sectionPath: string): string {
    let body = chunkText;
    if (body.startsWith(DOC_SUMMARY_PREFIX)) {
      const gap = body.indexOf('\n\n');
      if (gap !== -1) body = body.slice(gap + 2);
    }
    const crumb = `${sectionPath}\n\n`;
    if (sectionPath.length > 0 && body.startsWith(crumb)) {
      body = body.slice(crumb.length);
    }
    return body;
  }

  /**
   * Offset of `body` inside `sectionText`, or `-1`.
   *
   * The exact match is tried first. It can still fail on a chunk the indexer post-processed
   * further (a table summary is appended to the run's head chunk) or after a small edit to
   * the note, so the head of the body is used as a probe: locating the chunk approximately
   * is worth far more than falling back to the section prefix. The probe stops at the first
   * line break, since whatever diverged usually did so further down.
   */
  private locateChunk(sectionText: string, body: string): number {
    if (body.length === 0) return -1;
    const exact = sectionText.indexOf(body);
    if (exact !== -1) return exact;

    const head = body.slice(0, ANCHOR_PROBE_CHARS);
    const lineEnd = head.indexOf('\n');
    const probe = lineEnd >= ANCHOR_MIN_PROBE_CHARS ? head.slice(0, lineEnd) : head;
    return sectionText.indexOf(probe);
  }

  /** Moves `start` forward onto the nearest boundary that still sits at or before `anchor`. */
  private snapStart(text: string, start: number, anchor: number): number {
    if (start === 0) return 0;
    for (const [separator, width] of [
      ['\n\n', 2],
      ['\n', 1],
      [' ', 1],
    ] as const) {
      // indexOf, not lastIndexOf: the EARLIEST boundary after `start` keeps the most
      // leading context. The nearest one before the chunk would shrink the window to it.
      const at = text.indexOf(separator, start);
      const boundary = at + width;
      if (at !== -1 && boundary <= anchor) return boundary;
    }
    return start;
  }

  /** Moves `end` back onto the nearest boundary that still sits at or after `anchorEnd`. */
  private snapEnd(text: string, end: number, anchorEnd: number): number {
    if (end >= text.length) return text.length;
    for (const separator of ['\n\n', '\n', ' ']) {
      // lastIndexOf searches backwards from `end`, so the hit can never overrun the window.
      const at = text.lastIndexOf(separator, end);
      if (at >= anchorEnd) return at;
    }
    return end;
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
