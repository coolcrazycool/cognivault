---
phase: 06-semantic-+-lexical-search
verified: 2026-03-11T08:45:00Z
status: passed
score: 11/11 must-haves verified
re_verification: false
human_verification:
  - test: "Semantic search returns results ranked by actual embedding similarity"
    expected: "Results appear in descending cosine similarity order from Qdrant"
    why_human: "Test mocks Qdrant — actual similarity ordering depends on real Qdrant ANN behavior with real embeddings"
  - test: "Lexical search finds exact technical terms and acronyms (e.g. 'RRF', 'BGE', 'UUID')"
    expected: "Results contain chunks with exact-match or tokenized occurrence of the term"
    why_human: "Multilingual tokenizer behavior and Qdrant full-text index require live data to validate"
  - test: "Mixed Russian/English queries return relevant results"
    expected: "Multilingual tokenizer handles Cyrillic + Latin token boundaries correctly"
    why_human: "Language tokenization quality requires real Qdrant instance with populated data"
---

# Phase 6: Semantic + Lexical Search Verification Report

**Phase Goal:** Agents can search vault content by meaning or by exact terms with metadata filtering
**Verified:** 2026-03-11T08:45:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Agent can perform semantic search and receive results ranked by embedding similarity | VERIFIED | `POST /semantic` in routes.ts calls `SearchService.semantic()` which embeds query via `embedder.embed()` then calls `qdrant.search()` with vector; scores clamped to [0,1] via `normalizeScore()` |
| 2 | Agent can perform lexical search that finds exact technical terms, acronyms, and short identifiers | VERIFIED | `POST /lexical` calls `SearchService.lexical()` which uses `qdrant.scroll()` with `should` MatchText conditions on `text`, `title`, `section_path` fields; full-text indexes use multilingual tokenizer |
| 3 | Agent can filter any search by tags, project, status, folder path, or note type | VERIFIED | `buildMustConditions()` in service.ts handles tags (MatchAny), project/status/type (MatchValue exact); folder is post-filtered by `path.startsWith()` in lexical(); semantic also applies filter via `buildFilter()` |
| 4 | Search results include chunk text, source note path, section_path, and relevance score | VERIFIED | `SearchResultSchema` defines all required fields; `toSearchResult()` maps all: text, path, title, section_path, score, tags, project, status |
| 5 | Qdrant payload for each chunk includes chunk text field | VERIFIED | `pipeline.ts` line 88: `text: chunk.text` present in upsert payload inside `chunks.map()` |
| 6 | Qdrant collection has full-text indexes on text, title, and section_path fields | VERIFIED | `qdrant.ts` lines 14,50-63: `TEXT_INDEXES = ['text', 'title', 'section_path']` iterated with `createPayloadIndex` using `type: 'text'` |
| 7 | Qdrant text indexes use multilingual tokenizer with lowercase enabled | VERIFIED | `qdrant.ts` lines 54-57: `field_schema: { type: 'text', tokenizer: 'multilingual', lowercase: true }` |

**Score:** 7/7 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/plugins/pipeline.ts` | Pipeline upsert with text field in payload | VERIFIED | Line 88: `text: chunk.text` present in payload object; file is 173 lines, fully implemented |
| `src/plugins/qdrant.ts` | Full-text index creation for lexical search | VERIFIED | Lines 50-63: idempotent text index creation loop with multilingual tokenizer; `COLLECTION_NAME` exported |
| `src/features/search/schemas.ts` | TypeBox request/response schemas | VERIFIED | Exports `SearchFiltersSchema`, `SearchRequestBodySchema`, `SearchResultSchema`, `SearchResponseSchema`, `semanticSearchSchema`, `lexicalSearchSchema`; 73 lines |
| `src/features/search/service.ts` | SearchService with semantic() and lexical() | VERIFIED | Full implementation: 157 lines, `semantic()` (lines 49-63), `lexical()` (lines 65-104), private filter builders, `normalizeScore()`, `toSearchResult()` |
| `src/features/search/routes.ts` | Fastify plugin with POST /semantic and POST /lexical | VERIFIED | 44 lines; exports `searchRoutes`; both routes instantiate SearchService with `fastify.qdrant` and `fastify.embedder` |
| `src/features/search/__tests__/routes.test.ts` | Tests for both endpoints | VERIFIED | 398 lines, 14 tests covering result shape, filters, auth, scoring, limit, timing; min_lines requirement of 80 exceeded |
| `src/app.ts` | Search routes registered at /api/vault/search | VERIFIED | Line 40: `await app.register(searchRoutes, { prefix: '/api/vault/search' })` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/plugins/pipeline.ts` | Qdrant cognivault collection | `text: chunk.text` in upsert payload | VERIFIED | Line 88 contains `text: chunk.text` inside `chunks.map()` — payload field present |
| `src/plugins/qdrant.ts` | Qdrant cognivault collection | `createPayloadIndex` with TextIndexParams | VERIFIED | Lines 50-63: loop over TEXT_INDEXES with `type: 'text', tokenizer: 'multilingual'`; try/catch for idempotency |
| `src/features/search/routes.ts` | `src/features/search/service.ts` | `SearchService` instantiated in handlers | VERIFIED | Both handlers: `const searchService = new SearchService(fastify.qdrant, fastify.embedder)` then `.semantic()` / `.lexical()` |
| `src/features/search/service.ts` | `fastify.qdrant` | `qdrant.search()` for semantic, `qdrant.scroll()` for lexical | VERIFIED | `semantic()` calls `this.qdrant.search(COLLECTION_NAME, ...)` (line 52); `lexical()` calls `this.qdrant.scroll` (line 82) |
| `src/features/search/service.ts` | `fastify.embedder` | `embedder.embed()` for query vector | VERIFIED | `semantic()` line 50: `const [embedding] = await this.embedder.embed([query])` |
| `src/app.ts` | `src/features/search/routes.ts` | `register(searchRoutes, { prefix: '/api/vault/search' })` | VERIFIED | Line 5 import, line 40 register — pattern matches requirement |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| RET-01 | 06-02-PLAN.md | Agent can perform semantic search with embedding similarity | SATISFIED | `POST /api/vault/search/semantic` embeds query, calls `qdrant.search()` with vector; 14 tests including embedding call verification |
| RET-02 | 06-02-PLAN.md | Agent can perform lexical search for exact terms and acronyms | SATISFIED | `POST /api/vault/search/lexical` uses Qdrant scroll with MatchText on text/title/section_path; full-text indexes with multilingual tokenizer |
| RET-05 | 06-01-PLAN.md, 06-02-PLAN.md | Agent can filter search by tags, project, status, folder path, note type | SATISFIED | `SearchFiltersSchema` defines all 5 filter types; `buildMustConditions()` handles tags (MatchAny), project/status/type (MatchValue); folder post-filtered via `startsWith()` |
| RET-06 | 06-01-PLAN.md, 06-02-PLAN.md | Search results include chunk text, source note path, section_path, and relevance score | SATISFIED | `SearchResultSchema` defines all required fields; `toSearchResult()` maps all fields; chunk text now in Qdrant payload (no disk reads) |

All 4 requirements assigned to Phase 6 are satisfied. No orphaned requirements found — REQUIREMENTS.md traceability table maps only RET-01, RET-02, RET-05, RET-06 to Phase 6, matching the plan frontmatter exactly.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/features/search/service.ts` | 101 | `// TODO: At scale, add a text index on path field to push filtering to Qdrant.` | Info | Documents intentional trade-off: folder prefix filtering done in-memory. Current implementation is correct and functional. No blocker. |

No blocker or warning anti-patterns found. The single TODO is a documented technical debt note for future optimization, not a gap in current functionality.

### Test Results

- `src/features/search/__tests__/routes.test.ts`: **14/14 tests passed** (338ms)
- `src/plugins/__tests__/pipeline.test.ts`: **15/15 tests passed** (1400ms)
- `pnpm typecheck`: **0 errors** (clean exit)

### Human Verification Required

#### 1. Embedding Similarity Ranking

**Test:** Index 5+ notes covering different topics. Call `POST /api/vault/search/semantic` with a specific query. Verify results are returned in descending cosine similarity order and the top result is meaningfully related to the query.
**Expected:** The most semantically similar note appears first; unrelated notes have lower scores.
**Why human:** Tests mock Qdrant's search response — real ANN ranking depends on actual embedding model behavior and Qdrant's HNSW index.

#### 2. Lexical Exact-Term Matching

**Test:** Index notes containing technical terms like "RRF", "BM25", "UUID". Call `POST /api/vault/search/lexical` with query `"RRF"`. Verify results contain chunks with that exact term.
**Expected:** Notes containing "RRF" appear in results; notes without it do not.
**Why human:** Multilingual tokenizer behavior with short uppercase acronyms requires a live Qdrant instance with `lowercase: true` to validate tokenization works as expected.

#### 3. Multilingual Query Handling

**Test:** Index notes with Russian text mixed with English technical terms. Call `POST /api/vault/search/lexical` with a Cyrillic query term.
**Expected:** Results containing the Cyrillic term are returned.
**Why human:** Russian + English token boundary handling by the multilingual tokenizer can only be validated with real data in a live Qdrant instance.

### Gaps Summary

No gaps. All must-haves from both plans are verified at all three levels (exists, substantive, wired). All 4 phase requirements are satisfied. Test suite passes (14 search tests + 15 pipeline tests). TypeScript compiles clean. The only outstanding items are human-testable behaviors that require a live Qdrant instance with real vault data — these are not gaps in implementation, they are expected validation needs for a search feature.

---

_Verified: 2026-03-11T08:45:00Z_
_Verifier: Claude (gsd-verifier)_
