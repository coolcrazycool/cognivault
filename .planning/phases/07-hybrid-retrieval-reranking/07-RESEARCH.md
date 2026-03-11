# Phase 7: Hybrid Retrieval + Reranking - Research

**Researched:** 2026-03-11
**Domain:** Reciprocal Rank Fusion (RRF) hybrid search, multilingual information retrieval evaluation
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- RRF fusion parameters: fetch 2x final limit from each source (e.g., 20 semantic + 20 lexical for limit=10)
- Equal weight between semantic and lexical — standard RRF with no bias
- Hardcoded k=60 (industry standard RRF constant) — no env configurability
- If one source returns empty, RRF naturally degrades — no special fallback logic needed
- Hybrid endpoint contract: same request/response schemas as semantic/lexical (SearchRequestBodySchema / SearchResponseSchema)
- No extra fields — no source attribution, no strategy parameter
- Endpoint: POST /api/vault/search/hybrid (decided in Phase 6)
- All three search endpoints are equal — no default preference
- Cross-encoder reranking (RET-04) DEFERRED to v2 — NOT built in this phase
- Evaluation harness: reusable CLI script in test/eval/ (NOT part of pnpm test suite)
- Query set: JSON file (test/eval/queries.json) with ~30-35 queries
- Three categories: ~10 pure Russian, ~10 pure English, ~10-15 mixed Russian/English with technical terms
- Metric: recall@10 — fraction of relevant docs appearing in top 10 results
- Threshold: 0.7 (70%) — below this is a fail
- Compare all three search types: semantic, lexical, and hybrid — report recall per type and per category
- Output: report showing per-category and overall recall for each search type

### Claude's Discretion
- RRF score normalization (how to map fused ranks back to 0-1 scores)
- Exact query set content and expected relevance labels
- Evaluation script implementation details (how to call API, report format)
- SearchService.hybrid() internal implementation

### Deferred Ideas (OUT OF SCOPE)
- Cross-encoder reranking (RET-04) — revisit if recall@10 < 0.7 without it
- Configurable RRF weights per request — add if agents need query-type-specific tuning
- Source attribution in hybrid results (which search type contributed each result)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| RET-03 | Agent can perform hybrid search combining semantic + lexical via RRF fusion | RRF algorithm fully researched; pure TypeScript implementation, no external dependencies needed |
| RET-04 | Hybrid results reranked by cross-encoder — DEFERRED TO V2 | Locked decision — not implemented in this phase |
| RET-07 | Search handles mixed Russian/English queries with technical terms accurately | Evaluation harness with 30-35 multilingual queries validates this; multilingual tokenizer already installed from Phase 6 |
</phase_requirements>

## Summary

Phase 7 adds `SearchService.hybrid()` to the already-built search infrastructure from Phase 6. The method calls `semantic()` and `lexical()` concurrently (via `Promise.all`), then applies Reciprocal Rank Fusion (RRF) with k=60 to produce a single ranked result list. The algorithm is pure arithmetic — no external libraries needed — and handles empty results from either source naturally.

Cross-encoder reranking is explicitly deferred. At 500–5000 notes, RRF fusion alone delivers adequate precision. The user wants evidence-based evaluation before investing in a cloud reranking API.

The evaluation harness (plan 07-03) is a standalone CLI script at `test/eval/eval.ts`, run with `tsx` or after `tsc`. It POSTs queries to the live API, measures recall@10 for each query, and prints a per-category and overall report comparing all three search endpoints. No new npm dependencies are required for the harness itself — Node.js 22 has native `fetch`.

**Primary recommendation:** Implement `SearchService.hybrid()` with parallel `Promise.all` + RRF in-memory fusion, add the `/hybrid` route following the established pattern, then build the evaluation harness as a standalone TypeScript script using native fetch.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| (none — stdlib only) | — | RRF fusion is pure arithmetic | No dependency needed for Map + sort |
| TypeScript | ^5.9.3 (project) | hybrid() method implementation | Already in use |
| Node.js fetch | built-in v22 | Eval harness HTTP calls | Native in Node.js 22 LTS — no node-fetch needed |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| tsx | devDep candidate | Run eval harness without build step | If added for convenience — eval script is run manually |
| vitest | ^4.0.18 (project) | Unit tests for hybrid() and hybrid route | Already used; unit tests for RRF logic go here |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-coded RRF | rerank-ts npm library | rerank-ts exists but adds a dependency for 10 lines of arithmetic — hand-roll is correct here |
| Native fetch for eval | axios/node-fetch | No reason to add a dependency when Node.js 22 has fetch built in |
| Sequential semantic + lexical calls | Promise.all parallel | Sequential is simpler but doubles latency; parallel is standard pattern |

**Installation:**
```bash
# No new runtime dependencies for Phase 7
# If tsx is desired for running eval harness directly:
pnpm add -D tsx
```

## Architecture Patterns

### Recommended Project Structure
```
src/
  features/
    search/
      service.ts           # Add hybrid() method here (alongside semantic() and lexical())
      routes.ts            # Add POST /hybrid route
      schemas.ts           # Add hybridSearchSchema (reuses existing body/response schemas)
      __tests__/
        routes.test.ts     # Add hybrid route tests (mock both qdrant.search and qdrant.scroll)
test/
  eval/
    eval.ts                # CLI evaluation harness script
    queries.json           # Query set with expected relevant doc paths
```

### Pattern 1: RRF Fusion in SearchService.hybrid()

**What:** Call `semantic()` and `lexical()` with 2x limit in parallel; fuse results using RRF with k=60; return top `limit` results sorted by fused score.

**When to use:** Any time both result sets need to be merged into a single ranked list.

**Implementation:**

```typescript
// Source: RRF algorithm — verified from Elasticsearch, Azure AI Search, OpenSearch official docs
// Formula: score(doc) = sum over each ranked list of: 1 / (rank + k)
// k=60 is industry standard; scores accumulate for docs appearing in multiple lists

async hybrid(query: string, limit: number, filters: SearchFilters): Promise<SearchResult[]> {
  const fetchLimit = limit * 2; // fetch 2x to have candidates after dedup

  // Run both searches concurrently
  const [semanticResults, lexicalResults] = await Promise.all([
    this.semantic(query, fetchLimit, filters),
    this.lexical(query, fetchLimit, filters),
  ]);

  // RRF fusion: key by path (doc identity in this collection)
  const K = 60;
  const scores = new Map<string, { result: SearchResult; score: number }>();

  const accumulateRRF = (results: SearchResult[]) => {
    results.forEach((result, idx) => {
      const rank = idx + 1; // 1-based rank
      const rrfScore = 1 / (rank + K);
      const existing = scores.get(result.path);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(result.path, { result, score: rrfScore });
      }
    });
  };

  accumulateRRF(semanticResults);
  accumulateRRF(lexicalResults);

  // Sort by fused score descending, take top limit
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ result, score }) => ({ ...result, score: this.normalizeRrfScore(score) }));
}

// Normalize RRF scores to [0,1]: theoretical max is ~2*(1/(1+60)) ≈ 0.0328
// Use relative normalization across the batch — divide by max score in result set
private normalizeRrfScore(rawRrf: number): number {
  // Caller handles normalization after collecting all scores
  // OR: return as-is and let the route layer accept non-normalized scores
  // Decision: normalize within hybrid() by dividing by max after sorting
  return Math.min(1, Math.max(0, rawRrf));
}
```

**Score normalization decision (Claude's discretion):** RRF scores are very small numbers (max ~0.033 per list when rank=1, k=60). Two options:
1. **Return raw RRF scores** — Response schema requires `score: number { minimum: 0, maximum: 1 }`. Raw RRF scores are already in [0, 1] since 1/(1+60) ≈ 0.016. Max possible is 2*(1/61) ≈ 0.033. TypeBox schema constraint satisfied without normalization.
2. **Normalize to [0,1] relative to batch** — Divide each score by the max score in the result set.

**Recommendation:** Use option 1 — raw RRF scores are already in [0,1]. The TypeBox constraint is satisfied. Relative normalization creates false impression that the top result always scores 1.0, which misleads callers. Clamp with `Math.min(1, Math.max(0, rawRrf))` as safety guard. This is consistent with how `normalizeScore()` works in the existing code.

### Pattern 2: Hybrid Route Registration

**What:** Add POST /hybrid alongside the existing /semantic and /lexical routes using the same pattern.

```typescript
// In routes.ts — follows established searchRoutes pattern exactly
fastify.post<{ Body: SearchRequestBody }>(
  '/hybrid',
  { schema: hybridSearchSchema },
  async (request) => {
    const start = Date.now();
    const { query, limit = 10, filters = {} } = request.body;
    const searchService = new SearchService(fastify.qdrant, fastify.embedder);
    const results = await searchService.hybrid(query, limit, filters);
    return {
      results,
      total: results.length,
      limit,
      query_ms: Date.now() - start,
    };
  },
);
```

```typescript
// In schemas.ts — add hybridSearchSchema (identical to semantic/lexical)
export const hybridSearchSchema = {
  body: SearchRequestBodySchema,
  response: {
    200: SearchResponseSchema,
    400: ErrorResponseSchema,
    500: ErrorResponseSchema,
  },
};
```

### Pattern 3: Evaluation Harness CLI Script

**What:** Standalone TypeScript script that POSTs queries to the live API and measures recall@10.

**Structure of queries.json:**
```json
{
  "queries": [
    {
      "id": "en-01",
      "category": "english",
      "query": "Compass catalog UI filters",
      "relevant_paths": [
        "Projects/Compass/UI/catalog.md",
        "Projects/Compass/filters-spec.md"
      ]
    },
    {
      "id": "ru-01",
      "category": "russian",
      "query": "как устроен ingestion metadata routes",
      "relevant_paths": [
        "Архитектура/ingestion-pipeline.md"
      ]
    },
    {
      "id": "mixed-01",
      "category": "mixed",
      "query": "SLA ownership tabs",
      "relevant_paths": [
        "Projects/SLA/ownership.md"
      ]
    }
  ]
}
```

**Recall@10 formula:**
```
recall@10(query) = |relevant_paths ∩ top_10_result_paths| / |relevant_paths|
overall_recall = mean(recall@10 per query)
```

**Eval script pattern:**
```typescript
// test/eval/eval.ts
// Run: npx tsx test/eval/eval.ts  OR  node --import=tsx/esm test/eval/eval.ts
// Requires: COGNIVAULT_API_KEY and BASE_URL env vars (or defaults)

import { readFileSync } from 'node:fs';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const API_KEY = process.env.COGNIVAULT_API_KEY ?? '';
const TOP_K = 10;
const THRESHOLD = 0.7;

interface QueryEntry {
  id: string;
  category: 'english' | 'russian' | 'mixed';
  query: string;
  relevant_paths: string[];
}

interface QuerySet { queries: QueryEntry[]; }

async function search(endpoint: string, query: string, limit: number): Promise<string[]> {
  const response = await fetch(`${BASE_URL}/api/vault/search/${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ query, limit }),
  });
  const data = await response.json() as { results: Array<{ path: string }> };
  return data.results.map((r) => r.path);
}

function recallAtK(retrieved: string[], relevant: string[]): number {
  if (relevant.length === 0) return 1.0;
  const retrieved_set = new Set(retrieved.slice(0, TOP_K));
  const hits = relevant.filter((p) => retrieved_set.has(p)).length;
  return hits / relevant.length;
}

// ... evaluation loop, per-category aggregation, report output
```

### Anti-Patterns to Avoid

- **Sequential semantic + lexical calls:** Always use `Promise.all` — otherwise hybrid latency is sum of both, not max.
- **Keying RRF map by title or text:** Key by `path` (document identity). Same document appears as multiple results if keyed by text content.
- **Fetching only `limit` from each source before fusion:** Always fetch `2 * limit` from each source to give RRF candidates to choose from after deduplication.
- **Min-max normalizing RRF scores per batch:** This makes the top result always score 1.0, hiding signal about absolute confidence. Clamp to [0,1] only.
- **Including the eval harness in `pnpm test`:** It requires a running API server with real or seeded vault data — it cannot be a unit test.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| RRF fusion | Custom ranking algorithm | Plain Map + arithmetic | RRF is 10 lines; any deviation from the formula is just wrong |
| HTTP client for eval harness | axios, node-fetch | `fetch` (Node.js 22 built-in) | No dependency needed; Node.js 22 LTS has stable fetch |
| Score clamping | Custom normalization | `Math.min(1, Math.max(0, n))` | Already established in `normalizeScore()` — keep consistent |

**Key insight:** The RRF algorithm is deceptively simple (it IS just arithmetic), but the implementation nuances — document identity key, 2x fetch multiplier, k=60 constant, parallel not sequential calls — require care. Don't add external libraries for any of it.

## Common Pitfalls

### Pitfall 1: Wrong document identity key in RRF Map
**What goes wrong:** Keying the fusion Map by `text` or `title` means the same document chunk returns twice (once from semantic, once from lexical) as separate entries rather than having its score accumulated.
**Why it happens:** The `SearchResult` interface doesn't have a unique `id` field — identity is `path` (the note path). Chunks from the same note have the same path. If using per-chunk deduplication, need chunk-level identity. In this system, `path` is the correct dedup key because we're surfacing notes, not raw chunks.
**How to avoid:** Key by `result.path` in the fusion Map.
**Warning signs:** Hybrid results contain duplicates with the same path at different ranks.

### Pitfall 2: Forgetting folder filter post-processing for hybrid
**What goes wrong:** The `lexical()` method post-filters by `path.startsWith(folderPrefix)` after Qdrant scroll because Qdrant's keyword index doesn't support prefix matching. The `semantic()` method doesn't need this because it uses `buildFilter()` which only handles exact-match conditions (folder filter not pushed to Qdrant for semantic either). The `hybrid()` method calls both and re-merges — the folder filter is applied inside each sub-method. This is correct and requires no extra handling.
**How to avoid:** Verify that `hybrid()` delegates filters to `semantic()` and `lexical()` unchanged — no need to re-apply folder filter after fusion.
**Warning signs:** Hybrid results include documents outside the requested folder.

### Pitfall 3: Eval harness expected paths don't match actual Qdrant payload paths
**What goes wrong:** If `queries.json` uses paths like `Projects/foo.md` but the vault indexes them as `Projects/foo` (no extension) or with a different prefix, recall will be zero even when results are correct.
**Why it happens:** The ingestion pipeline stores `path` in Qdrant payload exactly as it appears relative to vault root. The eval harness must use the same format.
**How to avoid:** Before finalizing `queries.json`, inspect a few real Qdrant payloads (via semantic search) to confirm the exact path format stored.
**Warning signs:** Recall@10 is 0.0 for all queries when results look visually correct.

### Pitfall 4: Evaluating against a server with no vault indexed
**What goes wrong:** Running the eval harness against a server with empty Qdrant returns empty results → recall = 0 for all queries — looks like a bug but isn't.
**How to avoid:** The eval harness preamble should check that the server is reachable and has non-zero indexed content (a quick semantic search for a known term) before running the full query set.
**Warning signs:** All three search types score 0.0 recall.

### Pitfall 5: RRF score comparison with semantic scores
**What goes wrong:** Agents consuming hybrid results may compare the `score` field with scores from semantic search and find hybrid scores much lower (max ~0.033 vs semantic scores up to 1.0 for cosine similarity). This looks wrong but isn't — the schemas are satisfied (all in [0,1]) and the ranking order is what matters.
**Why it happens:** RRF scores are rank-derived, not similarity-derived.
**How to avoid:** Document the score semantics in a code comment. Consider whether relative normalization (divide by max) is worth it for agent usability — Claude's discretion per CONTEXT.md.

## Code Examples

Verified patterns from official sources and existing codebase:

### RRF Core Algorithm
```typescript
// Source: Verified against Elasticsearch RRF docs, Azure AI Search hybrid ranking docs,
// OpenSearch RRF blog post — all agree on formula: score += 1/(rank + k)
// k=60 is the de facto standard constant

private fuseRRF(
  semanticResults: SearchResult[],
  lexicalResults: SearchResult[],
  limit: number,
): SearchResult[] {
  const K = 60;
  const scores = new Map<string, { result: SearchResult; score: number }>();

  const accumulate = (results: SearchResult[]) => {
    results.forEach((result, idx) => {
      const rank = idx + 1;
      const contribution = 1 / (rank + K);
      const existing = scores.get(result.path);
      if (existing) {
        existing.score += contribution;
      } else {
        scores.set(result.path, { result, score: contribution });
      }
    });
  };

  accumulate(semanticResults);
  accumulate(lexicalResults);

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ result, score }) => ({
      ...result,
      score: Math.min(1, Math.max(0, score)), // clamp to TypeBox schema constraint
    }));
}
```

### Parallel Search Calls
```typescript
// Source: established Promise.all pattern; no specific doc needed
const [semanticResults, lexicalResults] = await Promise.all([
  this.semantic(query, limit * 2, filters),
  this.lexical(query, limit * 2, filters),
]);
```

### Recall@10 Calculation
```typescript
// Source: standard IR metric formula
function recallAtK(retrieved: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 1.0;
  const topK = new Set(retrieved.slice(0, k));
  const hits = relevant.filter((path) => topK.has(path)).length;
  return hits / relevant.length;
}
```

### Route Addition (follows existing searchRoutes pattern exactly)
```typescript
// In routes.ts — same shape as /semantic and /lexical
fastify.post<{ Body: SearchRequestBody }>(
  '/hybrid',
  { schema: hybridSearchSchema },
  async (request) => {
    const start = Date.now();
    const { query, limit = 10, filters = {} } = request.body;
    const searchService = new SearchService(fastify.qdrant, fastify.embedder);
    const results = await searchService.hybrid(query, limit, filters);
    return { results, total: results.length, limit, query_ms: Date.now() - start };
  },
);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Sequential fallback (semantic OR lexical) | Parallel fusion via RRF | 2023 industry adoption | Better recall for mixed-language queries |
| Weighted score combination | Rank-based RRF | ~2022-2023 | Eliminates score-space normalization problem |
| Cloud cross-encoder mandatory | RRF often sufficient for mid-size corpora | 2024 research consensus | At <5K docs, reranking is optional — evaluate first |

**Deprecated/outdated:**
- Score-based fusion (average or weighted sum of cosine + BM25 scores): scores live in different spaces (cosine [0,1] vs BM25 [0,∞]), making weighting arbitrary. RRF's rank-based approach is universally preferred.

## Open Questions

1. **Score normalization for hybrid results**
   - What we know: RRF raw scores are in (0, ~0.033], which satisfies TypeBox `score: number { minimum: 0, maximum: 1 }` without transformation
   - What's unclear: Agents receiving hybrid results see scores like 0.016 vs semantic scores like 0.95 — is this confusing enough to warrant relative normalization?
   - Recommendation: Default to raw scores (no normalization). Add a code comment explaining the score semantics. Revisit if agents explicitly complain about score comparability.

2. **Chunk-level vs note-level dedup in RRF**
   - What we know: The current `lexical()` and `semantic()` return per-chunk results. Two chunks from the same note (`path`) may appear. RRF keyed by `path` merges them, which may or may not be desired.
   - What's unclear: Should hybrid return the best chunk per note, or allow multiple chunks from the same note?
   - Recommendation: Key by `path` (consistent with how agents think in terms of notes, not chunks). If multiple chunks from the same note arrive from different sources, the first one encountered "wins" as the representative chunk. This is the same behavior as if you called semantic() alone and got multiple results for the same note.

3. **Eval harness path format verification**
   - What we know: queries.json expected paths must match Qdrant payload `path` field exactly
   - What's unclear: Without a real vault, Claude must curate synthetic expected paths for evaluation
   - Recommendation: Structure queries.json with synthetic paths that follow the vault's documented conventions. Make the eval harness output the actual retrieved paths alongside expected paths so mismatches are immediately visible.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.0.18 |
| Config file | vitest.config.ts (project root) |
| Quick run command | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RET-03 | POST /hybrid returns 200 with correct shape | unit | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` | ✅ (extend existing) |
| RET-03 | hybrid() calls both semantic and lexical with 2x limit | unit | same | ✅ (extend existing) |
| RET-03 | RRF dedup: same path from both sources → single result with higher score | unit | same | ✅ (extend existing) |
| RET-03 | hybrid() degrades gracefully when one source is empty | unit | same | ✅ (extend existing) |
| RET-03 | hybrid scores are in [0, 1] | unit | same | ✅ (extend existing) |
| RET-04 | Cross-encoder reranking | — | DEFERRED — not implemented | — |
| RET-07 | Mixed Russian/English queries return relevant results | manual eval | `npx tsx test/eval/eval.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test -- --run src/features/search/__tests__/routes.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green + eval harness report showing recall@10 >= 0.7 for all categories

### Wave 0 Gaps
- [ ] `test/eval/eval.ts` — evaluation harness CLI script (covers RET-07)
- [ ] `test/eval/queries.json` — query set with 30-35 multilingual queries and expected relevant paths

*(Existing test infrastructure at `src/features/search/__tests__/routes.test.ts` covers all RET-03 unit tests — extend, don't create new file)*

## Sources

### Primary (HIGH confidence)
- Elasticsearch RRF documentation — formula `score += 1/(rank+k)`, k=60 default verified
- Azure AI Search hybrid search ranking docs — confirms k=60 industry standard, rank-based accumulation
- OpenSearch RRF blog post — confirms equal-weight fusion, parallel retrieval pattern
- Existing codebase `src/features/search/service.ts` — SearchService API surface, established patterns
- TypeScript implementation example from alexop.dev — verified Map-based fusion pattern

### Secondary (MEDIUM confidence)
- MongoDB RRF resource — confirms deduplication by document ID approach
- ParadeDB RRF explainer — confirms 1/(rank+k) formula and k=60 recommendation

### Tertiary (LOW confidence)
- General web search for "evaluation harness recall@10 Node.js" — no directly applicable library found; custom script is the correct approach

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — No new dependencies; existing TypeScript, Vitest, Node.js 22 fetch
- RRF algorithm: HIGH — Formula verified across Elasticsearch, Azure AI Search, OpenSearch official docs
- Architecture: HIGH — Follows established Phase 6 patterns exactly; code context from CONTEXT.md is authoritative
- Evaluation harness: MEDIUM — Pattern is clear (JSON query set + fetch + recall calculation) but exact script implementation is discretionary
- Score normalization: MEDIUM — Raw RRF scores satisfy TypeBox constraint; relative normalization is discretionary per CONTEXT.md

**Research date:** 2026-03-11
**Valid until:** 2026-09-11 (stable domain — RRF algorithm has been stable since 2009)
