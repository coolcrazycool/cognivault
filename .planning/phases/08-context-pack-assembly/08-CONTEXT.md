# Phase 8: Context Pack Assembly - Context

**Gathered:** 2026-03-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Agents can request structured, token-budgeted knowledge bundles for downstream tasks. A new endpoint retrieves relevant chunks via hybrid search, classifies them into section types, merges chunks from the same note, applies relevance floor filtering, respects a configurable token budget, and returns organized content with source citations. TOON format support is Phase 9. Multi-format indexing (PDF, Canvas, etc.) is Phase 10.

</domain>

<decisions>
## Implementation Decisions

### Pack structure & sections
- Context pack organized by classified section types: summary, architecture, adrs, glossary, implementation
- Fixed five-section set from CTX-03 requirements — unrecognized frontmatter types map to "implementation" as catch-all
- Classification driven by frontmatter `type` field (already in Qdrant payload); fallback by folder path heuristic (e.g., ADRs/ folder -> adrs section)
- Empty sections omitted from response — only sections with matching chunks are included
- Chunks from the same note merged into a single entry preserving original section order (by chunk_index)

### Token budget allocation
- Relevance-first, no per-section caps — fill budget with highest-relevance chunks regardless of section type
- Default token budget: 32K tokens; agent-configurable range: 1K-128K via `token_budget` request field
- Response meta includes: total_tokens (actual used), token_budget (requested), chunks_included, chunks_excluded (below floor)
- Token counting via js-tiktoken (already in use by chunker)

### Relevance floor & filtering
- Fixed default relevance floor at 0.3 (hybrid RRF scores); agent-adjustable via `min_score` in request body (0.0-1.0)
- Quality over quantity: if few chunks pass the floor, return a smaller pack — never lower the floor automatically
- Fetch top 50 chunks from hybrid search, then apply relevance floor, then fill token budget from remaining
- Accepts same `filters` object as search endpoints (tags, project, status, folder) — passed through to underlying hybrid search

### Request contract & citations
- Endpoint: POST /api/vault/context (own route, not under search namespace)
- Request body: `{ query, token_budget?, min_score?, filters? }` — query required, rest optional with defaults
- Per-entry source metadata: each entry includes `source: { path, title, sections: [...], score }` and `text` (merged chunk content)
- Entries within a merged note keep original section order (chunk_index) for coherent reading

### Claude's Discretion
- Folder path heuristic rules for section type classification
- Position-aware ordering (high-relevance entries at start/end of pack)
- Internal assembly pipeline architecture (service class structure)
- Exact meta field naming and response envelope structure
- Error handling for empty results, Qdrant timeouts
- How to handle chunks with no frontmatter type and no recognizable folder path

</decisions>

<specifics>
## Specific Ideas

- Context pack is the primary interface for AI agents — it's the "knowledge access layer" from PROJECT.md core value
- Response shape should be predictable enough that agents can parse it without schema introspection
- Merged note entries read coherently because chunks maintain section order — agent sees content as the author wrote it
- Token stats in meta let agents calibrate future requests (e.g., "last pack only used 12K of 32K budget, maybe I should lower min_score")

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `SearchService.hybrid()` (src/features/search/service.ts): Retrieves RRF-fused results — context pack calls this with limit=50
- `SearchFiltersSchema` (src/features/search/schemas.ts): Reuse for context pack filter parameter
- `SearchResult` type: Carries text, path, title, section_path, score, tags, project, status — all needed for classification and assembly
- js-tiktoken: Already used in chunker (src/lib/chunker.ts) for token counting — reuse for budget enforcement
- `ErrorResponseSchema` (src/features/vault/schemas.ts): Reuse for context pack error responses

### Established Patterns
- Feature modules: `src/features/{name}/routes.ts`, `schemas.ts`, `service.ts`, `__tests__/`
- TypeBox for route schemas, Fastify plugin registration
- POST JSON body for all data endpoints
- SearchService instantiated per-request in route handler (stateless)
- Auth plugin applied globally — new routes automatically protected

### Integration Points
- `src/features/context/` — new feature module for context pack assembly
- `src/app.ts` — register context feature plugin (after search, since it depends on search service)
- Reuses `fastify.qdrant` and `fastify.embedder` via SearchService (no new plugin dependencies)

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 08-context-pack-assembly*
*Context gathered: 2026-03-11*
