# Phase 7: Hybrid Retrieval + Reranking - Context

**Gathered:** 2026-03-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Agents get high-precision results from combined semantic + lexical search via RRF fusion. A new hybrid search endpoint merges both result sets. Multilingual accuracy (Russian/English/mixed) is validated by a reusable evaluation harness. Cross-encoder reranking is deferred to v2 — not built in this phase.

</domain>

<decisions>
## Implementation Decisions

### RRF fusion parameters
- Fetch 2x the final limit from each source (e.g., 20 semantic + 20 lexical for limit=10)
- Equal weight between semantic and lexical — standard RRF with no bias
- Hardcoded k=60 (industry standard RRF constant) — no env configurability
- If one source returns empty, RRF naturally degrades — no special fallback logic needed

### Hybrid endpoint contract
- Same request body schema as semantic/lexical (SearchRequestBodySchema: query + limit + filters)
- Same response shape (SearchResponseSchema: results, total, limit, query_ms)
- No extra fields — no source attribution, no strategy parameter
- Endpoint: POST /api/vault/search/hybrid (decided in Phase 6)
- All three search endpoints are equal — no default preference, agent picks based on query type

### Reranking — DEFERRED to v2
- Cross-encoder reranking (RET-04) dropped from v1
- At 500-5000 notes, RRF fusion provides sufficient precision without reranking
- No GPU on server rules out local cross-encoder; cloud API (Cohere) adds cost and external dependency
- Evaluate after RRF: if recall@10 is insufficient, revisit reranking

### Evaluation harness
- Reusable CLI script in test/eval/ (not part of pnpm test suite)
- Query set: JSON file (test/eval/queries.json) with ~30-35 queries
- Three categories: ~10 pure Russian, ~10 pure English, ~10-15 mixed Russian/English with technical terms
- Claude curates queries based on vault characteristics from PROJECT.md (no real vault data required)
- Each query has a list of expected relevant document paths
- Metric: recall@10 — fraction of relevant docs appearing in top 10 results
- Threshold: 0.7 (70%) — below this is a fail
- Compares all three search types: semantic, lexical, and hybrid — report recall per type and per category
- Output: report showing per-category and overall recall for each search type

### Claude's Discretion
- RRF score normalization (how to map fused ranks back to 0-1 scores)
- Exact query set content and expected relevance labels
- Evaluation script implementation details (how to call API, report format)
- SearchService.hybrid() internal implementation

</decisions>

<specifics>
## Specific Ideas

- Queries should reflect real vault patterns: "Compass catalog ui filters", "как устроен ingestion metadata routes", "SLA ownership tabs", "schema evolution rules"
- Evaluation report should clearly show where hybrid improves over semantic-only and lexical-only

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `SearchService` (src/features/search/service.ts): Already has `semantic()` and `lexical()` methods — hybrid() calls both and fuses
- `SearchRequestBodySchema` and `SearchResponseSchema` (schemas.ts): Reused directly for hybrid endpoint
- `searchRoutes` (routes.ts): Add hybrid route alongside existing semantic/lexical
- `EmbeddingProvider` (fastify.embedder): Used by semantic search, hybrid will use it via SearchService.semantic()

### Established Patterns
- SearchService instantiated per-request in route handler (stateless)
- Qdrant conditions built via buildMustConditions() and buildFilter() — reused for hybrid
- Score normalization via normalizeScore() clamping to [0,1]
- POST JSON body for all search endpoints

### Integration Points
- SearchService gets a new hybrid() method that calls semantic() + lexical() internally
- routes.ts gets a new POST /hybrid route
- schemas.ts may get a hybridSearchSchema (or reuse semanticSearchSchema)
- No new plugins or dependencies needed — hybrid is pure logic on top of existing search

</code_context>

<deferred>
## Deferred Ideas

- Cross-encoder reranking (RET-04) — deferred to v2. Revisit if evaluation shows recall@10 < 0.7 without it
- Configurable RRF weights per request — add if agents need query-type-specific tuning
- Source attribution in hybrid results (which search type contributed each result)

</deferred>

---

*Phase: 07-hybrid-retrieval-reranking*
*Context gathered: 2026-03-11*
