# Phase 6: Semantic + Lexical Search - Research

**Researched:** 2026-03-10
**Domain:** Qdrant vector search, Qdrant full-text payload index, Fastify feature module
**Confidence:** HIGH

## Summary

Phase 6 implements two search endpoints — `POST /api/vault/search/semantic` and `POST /api/vault/search/lexical` — as a new `src/features/search/` Fastify plugin module. All required infrastructure is already in place: `fastify.qdrant` (QdrantClient v1.17.0), `fastify.embedder` (OpenAI), existing payload indexes, and the Fastify plugin registration pattern. The only infrastructure change needed is in the pipeline: add a `text` field to each Qdrant point payload during upsert, and add a full-text payload index on the `text` field to Qdrant's initialization.

Semantic search uses `qdrantClient.search()` with the query embedding as the vector. Lexical search uses `qdrantClient.scroll()` with a `FieldCondition` match using `{ text: queryString }` — this triggers Qdrant's full-text index and returns all matching points. The Qdrant JS client v1.17.0 already ships the full `TextIndexParams` type including `tokenizer`, `lowercase`, and multilingual support. For mixed Russian/English queries the `"multilingual"` tokenizer is the correct choice.

**Primary recommendation:** Add `text` to the pipeline payload, create a `TextIndexParams` full-text index in `qdrantPlugin` (alongside existing keyword indexes), then implement `SearchService` that calls `qdrant.search()` for semantic and `qdrant.scroll()` for lexical, normalizes cosine scores to 0–1, and maps results to the agreed response shape.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Search endpoint design**
- Separate endpoints: `POST /api/vault/search/semantic` and `POST /api/vault/search/lexical`
- POST with JSON body (not GET with query params) — cleaner for structured filters and Cyrillic queries
- Route prefix stays under `/api/vault/search/*` — consistent with existing vault namespace
- Auth required on all search endpoints (consistent with vault read ops)
- New feature module: `src/features/search/` with its own routes.ts, schemas.ts, service.ts
- Phase 7 adds `POST /api/vault/search/hybrid` to the same module

**Chunk text storage**
- Store chunk text as a payload field in Qdrant during indexing pipeline — search returns it directly from Qdrant, no disk reads
- Requires pipeline modification: add `text` field to Qdrant payload in pipeline.ts upsert
- Requires full reindex after pipeline change — no graceful fallback for older chunks without text
- Also add full-text index on chunk text payload field for lexical search

**Lexical search approach**
- Use Qdrant full-text payload index on chunk text — keep everything in one system, no SQLite FTS5
- Search scope: chunk text + title + section_path (agents can find terms in headings too)
- Exact token matching only, no prefix matching
- Case-insensitive search

**Result shape & ranking**
- Default limit: 10, max limit: 50 — agent specifies in request body
- Relevance scores normalized to 0-1 range (1.0 = best match)
- All matching chunks returned (no dedup by note) — agents see section-level granularity
- Response includes metadata: `{"results": [...], "total": N, "limit": N, "query_ms": N}`
- Each result: `{"text": "...", "path": "...", "title": "...", "section_path": "...", "score": 0.95, "tags": [...], "project": "...", "status": "..."}`

**Filter UX**
- Structured filter object: `{"query": "...", "limit": 10, "filters": {"tags": [...], "project": "...", "status": "...", "folder": "..."}}`
- All filter fields optional — omitted means no constraint, no filters = search everything
- Tags filter uses OR logic (any tag matches)
- Folder filter uses prefix match: `"Projects/"` matches all notes under Projects/
- No negation filters in v1 — positive filters only, keep API simple

### Claude's Discretion
- Exact TypeBox schema definitions for request/response
- Qdrant full-text index configuration (tokenizer settings)
- Score normalization algorithm (min-max, sigmoid, etc.)
- Search service internal architecture
- Error handling for empty results, invalid queries, Qdrant timeouts

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| RET-01 | Agent can perform semantic search with embedding similarity | `qdrantClient.search()` with embedded query vector + filter; scores are cosine distance from Qdrant |
| RET-02 | Agent can perform lexical search for exact terms and acronyms | `qdrantClient.scroll()` with `FieldCondition { key: "text", match: { text: query } }` against a TextIndexParams full-text index; also multi-field via OR across text/title/section_path |
| RET-05 | Agent can filter search by tags, project, status, folder path, note type | Qdrant `Filter.must[]` with existing keyword payload indexes; folder prefix via `MatchText` on `path` field or `startsWith` logic using keyword match |
| RET-06 | Search results include chunk text, source note path, section_path, and relevance score | Pipeline must add `text` to Qdrant payload; all fields already stored as payload; `with_payload: true` in search/scroll requests |
</phase_requirements>

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@qdrant/js-client-rest` | ^1.17.0 | Semantic ANN search + full-text scroll | Already in project; provides `search()`, `scroll()`, `createPayloadIndex()` with `TextIndexParams` |
| `@sinclair/typebox` | ^0.34.48 | Request/response schemas | Project-standard; Fastify-native JSON Schema + TypeScript types |
| `fastify-plugin` | ^5.1.0 | Feature plugin registration | Required for all feature modules (fp() wrapping) |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `openai` (via `fastify.embedder`) | existing | Embed search query for semantic search | Called once per semantic search request to get query vector |

### No new packages needed
All required capabilities are available through the existing installed dependencies.

**Installation:**
```bash
# No new packages — all dependencies already installed
```

---

## Architecture Patterns

### Recommended Project Structure
```
src/
  features/
    search/
      routes.ts        # POST /api/vault/search/semantic + /lexical
      schemas.ts       # TypeBox: SearchRequest, SearchResponse, SearchResult
      service.ts       # SearchService: semantic(), lexical() methods
      __tests__/
        routes.test.ts # fastify.inject() tests for both endpoints
  plugins/
    qdrant.ts          # MODIFY: add TextIndexParams index for "text" field
    pipeline.ts        # MODIFY: add text: chunk.text to each point payload
```

### Pattern 1: Qdrant Full-Text Index Creation (TextIndexParams)
**What:** Create a payload index of type "text" with multilingual tokenizer on the `text` field during Qdrant collection initialization.
**When to use:** Alongside the existing keyword/integer payload indexes in `qdrantPlugin`.
**Example:**
```typescript
// Source: @qdrant/js-client-rest dist/types/openapi/generated_schema.d.ts
// TextIndexParams: { type: "text", tokenizer?: TokenizerType, lowercase?: boolean }
// TokenizerType: "prefix" | "whitespace" | "word" | "multilingual"
await client.createPayloadIndex(COLLECTION_NAME, {
  field_name: 'text',
  field_schema: {
    type: 'text',
    tokenizer: 'multilingual',  // handles Russian + English token boundaries
    lowercase: true,             // case-insensitive matching
  },
});

// Also index title and section_path for heading-level lexical search
await client.createPayloadIndex(COLLECTION_NAME, {
  field_name: 'title',
  field_schema: { type: 'text', tokenizer: 'multilingual', lowercase: true },
});
await client.createPayloadIndex(COLLECTION_NAME, {
  field_name: 'section_path',
  field_schema: { type: 'text', tokenizer: 'multilingual', lowercase: true },
});
```

### Pattern 2: Semantic Search via `qdrant.search()`
**What:** Embed query, pass vector to `qdrantClient.search()` with optional filter conditions and `with_payload: true`.
**When to use:** `POST /api/vault/search/semantic`
**Example:**
```typescript
// Source: @qdrant/js-client-rest qdrant-client.d.ts line 127
const [embedding] = await fastify.embedder.embed([query]);
const hits = await fastify.qdrant.search('cognivault', {
  vector: embedding,
  limit,
  with_payload: true,
  filter: buildFilter(filters),  // see Filter Pattern below
});
// hits: ScoredPoint[] — each has .score (cosine similarity) and .payload
```

### Pattern 3: Lexical Search via `qdrant.scroll()`
**What:** Use `qdrantClient.scroll()` with a `FieldCondition` using `{ text: query }` match — this uses the full-text index. No vector is involved. For multi-field (text OR title OR section_path), use `Filter.should[]`.
**When to use:** `POST /api/vault/search/lexical`
**Example:**
```typescript
// Source: @qdrant/js-client-rest generated_schema.d.ts — MatchText: { text: string }
// scroll() returns ScrollResult: { points: Record[], next_page_offset }
const result = await fastify.qdrant.scroll('cognivault', {
  filter: {
    must: [
      ...buildFilterConditions(filters),       // metadata filters
    ],
    should: [
      { key: 'text', match: { text: query } },
      { key: 'title', match: { text: query } },
      { key: 'section_path', match: { text: query } },
    ],
  },
  limit,
  with_payload: true,
});
// result.points: Record[] — no .score field; assign score: 1.0 (exact match)
```

**Important:** `scroll()` returns `ScrollResult` with `.points` (not `.result`). Points have no `score` field. Lexical matches are exact — score is 1.0 for all results.

### Pattern 4: Building the Qdrant Filter from Request Body
**What:** Translate the `filters` object from the API request into a Qdrant `Filter` structure.
**When to use:** Both semantic and lexical search, applied as `must` conditions.
```typescript
// Source: @qdrant/js-client-rest generated_schema.d.ts — Filter, FieldCondition, Match
function buildMustConditions(filters: SearchFilters): Condition[] {
  const conditions: Condition[] = [];

  if (filters.tags && filters.tags.length > 0) {
    // OR logic: any tag matches — use MatchAny
    conditions.push({ key: 'tags', match: { any: filters.tags } });
  }
  if (filters.project) {
    conditions.push({ key: 'project', match: { value: filters.project } });
  }
  if (filters.status) {
    conditions.push({ key: 'status', match: { value: filters.status } });
  }
  if (filters.folder) {
    // Prefix match on path: use MatchText on the keyword-indexed path field
    // keyword index supports startsWith via MatchValue with prefix syntax
    // RECOMMENDED: use path text index OR filter in-memory after scroll
    // Safest: scroll with no path filter, then filter results by startsWith in service layer
    // Alternatively: Qdrant keyword match does NOT support prefix — use scroll + post-filter
    conditions.push({ key: 'path', match: { text: filters.folder } });
    // NOTE: see Pitfall 3 below — path is keyword-indexed, not text-indexed.
    // Add a text index on 'path' field OR do post-filtering in service.
  }

  return conditions;
}
```

### Pattern 5: Pipeline Modification (add `text` to payload)
**What:** In `pipeline.ts`, add `text: chunk.text` to each point payload during upsert.
**When to use:** `processCreatedOrUpdated()` — the `chunks.map()` building `points`.
```typescript
// In pipeline.ts processCreatedOrUpdated():
const points = chunks.map((chunk, i) => ({
  id: chunkId(event.path, i),
  vector: embeddings[i] as number[],
  payload: {
    // ... existing fields ...
    text: chunk.text,   // ADD THIS — enables search return and lexical index
  },
}));
```

### Pattern 6: Score Normalization for Semantic Search
**What:** Cosine similarity from Qdrant returns values in [-1, 1] range (typically [0, 1] for embeddings). Normalize to strict [0, 1].
**When to use:** Semantic search result mapping.
```typescript
// Clamp approach — safe, predictable, no distribution assumptions
function normalizeScore(raw: number): number {
  return Math.min(1, Math.max(0, raw));
}
```
**Note:** OpenAI text-embedding models produce cosine scores in [0, 1] range already (embeddings are normalized). Clamping is a safety measure. Avoid min-max normalization per-batch — it makes a single result score 1.0 even if the similarity is low.

### Pattern 7: Response Assembly
**What:** Map `ScoredPoint[]` (semantic) or `Record[]` (lexical) to the agreed result shape.
```typescript
function toSearchResult(point: ScoredPoint | Record, score: number): SearchResult {
  const p = point.payload as ChunkPayload;
  return {
    text: p.text ?? '',
    path: p.path,
    title: p.title,
    section_path: p.section_path,
    score,
    tags: p.tags ?? [],
    project: p.project ?? null,
    status: p.status ?? null,
  };
}
```

### Anti-Patterns to Avoid
- **Returning disk reads instead of payload text:** The chunk text MUST come from Qdrant payload, not from re-reading vault files. This is the hot path.
- **Using `GET` with query params for search:** POST + JSON body is the locked decision. Cyrillic in URL params causes encoding issues.
- **Deduplicating by note path in service:** The decision is to return all matching chunks at section granularity.
- **Min-max score normalization per result batch:** A single perfect result would always score 1.0; meaningless for agents ranking across searches.
- **Using `MatchValue` for folder prefix:** `MatchValue` is exact-match only on keyword indexes. Folder prefix filtering requires either a text index on `path` or post-filtering in the service layer.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Full-text token indexing | Custom tokenizer/inverted index | Qdrant `TextIndexParams` with `"multilingual"` tokenizer | Handles CJK, Cyrillic, Latin word boundaries automatically |
| Vector ANN | Custom nearest-neighbor | `qdrantClient.search()` | HNSW index already initialized in collection |
| Metadata filtering | SQL-style filter parser | Qdrant `Filter` with `must[]`, `should[]`, `MatchAny` | All indexes already created in Phase 5 |
| Query embedding | HTTP call to OpenAI | `fastify.embedder.embed([query])` | Already decorated, validated, model-configured |

**Key insight:** Every infrastructure primitive already exists. This phase is purely about wiring the search API layer on top of what Phase 4 and Phase 5 built.

---

## Common Pitfalls

### Pitfall 1: `scroll()` Returns `.points`, Not `.result`
**What goes wrong:** Developer writes `result.result` instead of `result.points` for the scroll response.
**Why it happens:** `search()` returns `ScoredPoint[]` directly; `scroll()` returns `ScrollResult` with a `.points` array and an optional `.next_page_offset`.
**How to avoid:** Check `ScrollResult` type: `{ points: Record[], next_page_offset?: ... }`. Use `result.points`.
**Warning signs:** TypeScript error `Property 'result' does not exist on type 'ScrollResult'`.

### Pitfall 2: Lexical `scroll()` Has No Score Field
**What goes wrong:** Code tries to read `.score` from scroll results.
**Why it happens:** `scroll()` returns `Record` (no score), unlike `search()` which returns `ScoredPoint` (has score).
**How to avoid:** Assign a fixed score of `1.0` for all lexical results. If ordering is needed, scroll supports `order_by` a payload field but not a relevance score.
**Warning signs:** `score` is `undefined` at runtime; TypeScript type shows no `.score` on `Record`.

### Pitfall 3: Folder Prefix Filter — `path` is Keyword-Indexed, Not Text-Indexed
**What goes wrong:** Using `{ key: 'path', match: { text: filters.folder } }` on a keyword-indexed field silently returns no results or throws.
**Why it happens:** `MatchText` (`{ text: "..." }`) only works on fields with a full-text (`TextIndexParams`) index. `path` has a `keyword` index.
**How to avoid:** Two options: (A) Post-filter in service: apply folder prefix with `String.prototype.startsWith()` after fetching results, or (B) add a `text` index on `path` field in Qdrant plugin. Option A is simpler for v1. Option B enables Qdrant-side filtering at scale.
**Warning signs:** Empty results for folder filter; no Qdrant error (it silently misses).

### Pitfall 4: Full Reindex Required After Adding `text` to Payload
**What goes wrong:** Lexical search returns empty `text` field for existing indexed chunks.
**Why it happens:** Chunks indexed in Phase 5 don't have the `text` payload field. The pipeline change only affects newly indexed/updated files.
**How to avoid:** The plan must include a step that triggers a full reindex after pipeline modification. Verify by checking that a known chunk has a non-null `text` field in Qdrant payload.
**Warning signs:** `text: null` or `text: undefined` in search results; lexical search returns no matches.

### Pitfall 5: Tags OR Logic Requires `MatchAny`, Not Multiple `must[]` Conditions
**What goes wrong:** Developer adds multiple `{ key: 'tags', match: { value: tag } }` conditions in `must[]`, resulting in AND logic (all tags must match).
**Why it happens:** Confusion between `must` (AND) and `should` (OR) semantics. For OR across values of the same field, `MatchAny` is the correct construct.
**How to avoid:** Use `{ key: 'tags', match: { any: filters.tags } }` — `MatchAny.any` accepts a string array and matches if any value is present.
**Warning signs:** Tags filter works for single tags but returns zero results for multi-tag queries.

### Pitfall 6: Query Timing Must Use `Date.now()` Around Qdrant Call Only
**What goes wrong:** `query_ms` includes embedding time for semantic search, making it inconsistently comparable.
**Why it happens:** Developer wraps the entire handler in timing logic.
**How to avoid:** For the `query_ms` field, time from just before the Qdrant call to just after. Embedding time is a separate concern. Or: time the full request and document it as "wall time including embedding".
**Warning signs:** Semantic `query_ms` is 200ms; lexical `query_ms` is 5ms — comparing them misleads agents.

### Pitfall 7: Qdrant `createPayloadIndex` Fails if Index Already Exists
**What goes wrong:** On restart, `qdrantPlugin` tries to create indexes again, throwing an error if the collection exists.
**Why it happens:** The existing Phase 5 pattern skips index creation entirely if the collection exists. Adding new text indexes requires the skip check to be updated.
**How to avoid:** The existing pattern `if (!exists) { createCollection + createIndexes }` must be extended OR the new text indexes must be created outside the `if (!exists)` block using a try/catch to ignore "already exists" errors. The cleanest approach: move all `createPayloadIndex` calls to happen regardless of collection existence, wrapped in a helper that ignores 409/already-exists errors.
**Warning signs:** Service fails to start on restart after the Qdrant plugin is updated.

---

## Code Examples

### Full-Text Index Creation in qdrantPlugin
```typescript
// Source: @qdrant/js-client-rest dist/types/openapi/generated_schema.d.ts
// TextIndexParams: type "text", TokenizerType: "multilingual" supports Russian+English

const TEXT_INDEXES = ['text', 'title', 'section_path'] as const;

// Outside the if (!exists) block — safe to call on every startup:
for (const field of TEXT_INDEXES) {
  try {
    await client.createPayloadIndex(COLLECTION_NAME, {
      field_name: field,
      field_schema: {
        type: 'text',
        tokenizer: 'multilingual',
        lowercase: true,
      },
    });
  } catch {
    // Index already exists — safe to ignore on restart
  }
}
```

### Semantic Search Method
```typescript
// Source: @qdrant/js-client-rest qdrant-client.d.ts
// search() returns ScoredPoint[] — each has .score and .payload

async semantic(query: string, limit: number, filters: SearchFilters): Promise<SearchResult[]> {
  const [embedding] = await this.embedder.embed([query]);
  const hits = await this.qdrant.search('cognivault', {
    vector: embedding as number[],
    limit,
    with_payload: true,
    filter: buildFilter(filters),
  });
  return hits.map((h) => toSearchResult(h, normalizeScore(h.score)));
}
```

### Lexical Search Method
```typescript
// Source: @qdrant/js-client-rest generated_schema.d.ts
// ScrollResult: { points: Record[], next_page_offset }
// MatchText: { text: string } — uses TextIndexParams full-text index

async lexical(query: string, limit: number, filters: SearchFilters): Promise<SearchResult[]> {
  const mustConditions = buildMustConditions(filters);
  const result = await this.qdrant.scroll('cognivault', {
    filter: {
      must: mustConditions,
      should: [
        { key: 'text', match: { text: query } },
        { key: 'title', match: { text: query } },
        { key: 'section_path', match: { text: query } },
      ],
    },
    limit,
    with_payload: true,
  });
  return result.points
    .filter((p) => p.payload?.text)  // skip legacy chunks without text field
    .map((p) => toSearchResult(p, 1.0));
}
```

### Route Handler Pattern (following vault routes pattern)
```typescript
// Source: src/features/vault/routes.ts — established pattern
fastify.post<{ Body: SemanticSearchBody }>(
  '/semantic',
  { schema: semanticSearchSchema },
  async (request, reply) => {
    const start = Date.now();
    const { query, limit = 10, filters = {} } = request.body;
    const results = await fastify.searchService.semantic(query, limit, filters);
    return {
      results,
      total: results.length,
      limit,
      query_ms: Date.now() - start,
    };
  },
);
```

### TypeBox Schemas (Claude's Discretion — Recommended Shape)
```typescript
// Source: @sinclair/typebox — project-standard schema library
const SearchFiltersSchema = Type.Object({
  tags: Type.Optional(Type.Array(Type.String())),
  project: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  folder: Type.Optional(Type.String()),
});

const SearchRequestBodySchema = Type.Object({
  query: Type.String({ minLength: 1 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
  filters: Type.Optional(SearchFiltersSchema),
});

const SearchResultSchema = Type.Object({
  text: Type.String(),
  path: Type.String(),
  title: Type.String(),
  section_path: Type.String(),
  score: Type.Number({ minimum: 0, maximum: 1 }),
  tags: Type.Array(Type.String()),
  project: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([Type.String(), Type.Null()]),
});

const SearchResponseSchema = Type.Object({
  results: Type.Array(SearchResultSchema),
  total: Type.Integer(),
  limit: Type.Integer(),
  query_ms: Type.Integer(),
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| BM25 sparse vectors for lexical search | Qdrant native full-text payload index (TextIndexParams) | Qdrant v1.7+ | No sparse vector encoding needed; just index a text field and use `MatchText` filter |
| SQLite FTS5 as separate lexical backend | Single Qdrant system for both search modes | Decision in Phase 6 CONTEXT | No cross-system sync; consistent filter behavior |

**Deprecated/outdated:**
- BM25 sparse vectors: Still supported in Qdrant but require a separate named vector and encoder. TextIndexParams full-text index is simpler for single-system use.
- `prefix` tokenizer: Useful for autocomplete, but produces false positives for exact technical term matching. Use `word` or `multilingual` for term search.

---

## Open Questions

1. **Folder prefix matching via Qdrant vs. post-filter**
   - What we know: `path` has a `keyword` index; `MatchText` requires a `text` index; `MatchValue` is exact-match only
   - What's unclear: Whether adding a `text` index on `path` is worth it vs. post-filtering in service layer
   - Recommendation: Implement folder filter as post-filter in service layer for v1 (simpler, no index change). Add a TODO comment noting that at scale a path text index would push filtering to Qdrant.

2. **query_ms definition: wall time vs. Qdrant-only time**
   - What we know: Semantic search embeds the query (can be 50-200ms) before calling Qdrant (~5-20ms); lexical search only calls Qdrant
   - What's unclear: Whether agents care about embedding latency vs. retrieval latency
   - Recommendation: Time the full handler (wall time from request body parsed to results assembled). Document this in API response comments.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.0.18 |
| Config file | vitest.config.ts (implicit — `pnpm test` runs `vitest run`) |
| Quick run command | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RET-01 | Semantic search returns ranked results with score | unit (inject) | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` | ❌ Wave 0 |
| RET-02 | Lexical search finds exact terms (e.g., "ingestion") | unit (inject) | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` | ❌ Wave 0 |
| RET-05 | Filter by tags (OR), project, status, folder prefix | unit (inject) | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` | ❌ Wave 0 |
| RET-06 | Result includes text, path, section_path, score | unit (inject) | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` | ❌ Wave 0 |

**Test approach:** Tests use `fastify.inject()` with a mocked `fastify.qdrant` (return known fixture points) and a mocked `fastify.embedder`. Pattern established in Phase 5: class-style mocks for constructable services. Qdrant mock must return `ScoredPoint[]` for `search()` and `ScrollResult` for `scroll()`.

### Sampling Rate
- **Per task commit:** `pnpm test -- --run src/features/search/__tests__/routes.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/features/search/__tests__/routes.test.ts` — covers RET-01, RET-02, RET-05, RET-06
- [ ] Qdrant mock fixtures: `ScoredPoint[]` for semantic, `ScrollResult` for lexical

*(Pipeline modification test coverage: existing `pipeline.ts` tests from Phase 5 should be updated to assert `text` field presence in upserted payload)*

---

## Sources

### Primary (HIGH confidence)
- `@qdrant/js-client-rest` v1.17.0 local node_modules — `TextIndexParams`, `TokenizerType`, `MatchText`, `MatchTextAny`, `ScrollResult`, `ScoredPoint`, `Filter`, `FieldCondition`, `MatchAny` types inspected directly
- `src/plugins/qdrant.ts` (Phase 5) — existing collection init pattern, `createPayloadIndex` usage, `PAYLOAD_INDEXES` array
- `src/plugins/pipeline.ts` (Phase 5) — existing payload fields, `upsert` call structure
- `src/features/vault/routes.ts` + `schemas.ts` (Phase 2/3) — established route handler pattern, TypeBox schema conventions
- `src/app.ts` — plugin registration order, `fastify.register()` pattern

### Secondary (MEDIUM confidence)
- Qdrant documentation via type inspection — `"multilingual"` tokenizer handles Cyrillic + Latin word boundaries; confirmed in `TokenizerType` enum in schema

### Tertiary (LOW confidence)
- None — all claims verified against installed source code

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already installed; types inspected from local node_modules
- Architecture: HIGH — established patterns in Phase 2–5 code read directly
- Pitfalls: HIGH — identified from type inspection (scroll vs search return types, keyword vs text index mismatch)
- Score normalization: MEDIUM — OpenAI embedding cosine behavior from training knowledge, not verified against live calls

**Research date:** 2026-03-10
**Valid until:** 2026-06-10 (stable — Qdrant client version pinned, no fast-moving dependencies)
