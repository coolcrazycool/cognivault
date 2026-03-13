# Phase 6: Semantic + Lexical Search - Context

**Gathered:** 2026-03-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Agents can search vault content by meaning (semantic) or exact terms (lexical) with metadata filtering. Two search endpoints returning chunk text, source note path, section_path, and relevance score. Hybrid search (RRF fusion, reranking) is Phase 7.

</domain>

<decisions>
## Implementation Decisions

### Search endpoint design
- Separate endpoints: `POST /api/vault/search/semantic` and `POST /api/vault/search/lexical`
- POST with JSON body (not GET with query params) — cleaner for structured filters and Cyrillic queries
- Route prefix stays under `/api/vault/search/*` — consistent with existing vault namespace
- Auth required on all search endpoints (consistent with vault read ops)
- New feature module: `src/features/search/` with its own routes.ts, schemas.ts, service.ts
- Phase 7 adds `POST /api/vault/search/hybrid` to the same module

### Chunk text storage
- Store chunk text as a payload field in Qdrant during indexing pipeline — search returns it directly from Qdrant, no disk reads
- Requires pipeline modification: add `text` field to Qdrant payload in pipeline.ts upsert
- Requires full reindex after pipeline change — no graceful fallback for older chunks without text
- Also add full-text index on chunk text payload field for lexical search

### Lexical search approach
- Use Qdrant full-text payload index on chunk text — keep everything in one system, no SQLite FTS5
- Search scope: chunk text + title + section_path (agents can find terms in headings too)
- Exact token matching only, no prefix matching
- Case-insensitive search

### Result shape & ranking
- Default limit: 10, max limit: 50 — agent specifies in request body
- Relevance scores normalized to 0-1 range (1.0 = best match)
- All matching chunks returned (no dedup by note) — agents see section-level granularity
- Response includes metadata: `{"results": [...], "total": N, "limit": N, "query_ms": N}`
- Each result: `{"text": "...", "path": "...", "title": "...", "section_path": "...", "score": 0.95, "tags": [...], "project": "...", "status": "..."}`

### Filter UX
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

</decisions>

<specifics>
## Specific Ideas

- Lexical search must handle mixed Russian/English queries like "как устроен ingestion metadata routes", "SLA ownership tabs"
- Search is the hot path for agents — latency matters (< 1 second target from PROJECT.md)

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `QdrantClient` decorated as `fastify.qdrant` — direct access to Qdrant for search queries
- `EmbeddingProvider` decorated as `fastify.embedder` — embed query text for semantic search
- `ErrorResponseSchema` in vault schemas — reusable for search error responses
- Auth plugin already applied globally — search routes automatically protected

### Established Patterns
- Feature modules: `src/features/{name}/routes.ts`, `schemas.ts`, `service.ts`, `__tests__/`
- TypeBox for route schemas, Fastify plugin registration via `fastify.register()`
- Error format: `{"error": {"code": "...", "message": "..."}}`

### Integration Points
- Pipeline plugin (`src/plugins/pipeline.ts`) needs modification: add `text` field to Qdrant payload on upsert
- Qdrant plugin (`src/plugins/qdrant.ts`) may need full-text index creation alongside existing payload indexes
- App registration (`src/app.ts`) needs search feature plugin added after qdrant/embedder

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 06-semantic-lexical-search*
*Context gathered: 2026-03-10*
