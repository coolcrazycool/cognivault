# Roadmap: CogniVault

## Overview

CogniVault is built bottom-up following hard data flow dependencies: vault abstraction and file operations first (no external dependencies), then index state and change detection (SQLite), then the full indexing pipeline (chunking, embedding, Qdrant), then retrieval (semantic, lexical, hybrid, reranking), then context assembly, then agent interface polish (TOON, OpenAPI), then multi-format support, and finally observability. Each phase delivers a coherent, independently verifiable capability. The ordering ensures no phase depends on work that has not yet shipped.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Project Skeleton** - Fastify scaffold, Docker, health endpoints, API key auth (completed 2026-03-10)
- [x] **Phase 2: Vault Read Operations** - Vault manager, path safety, list/read files, frontmatter read (completed 2026-03-10)
- [x] **Phase 3: Vault Write Operations** - Create, update, append, delete, rename, frontmatter write (completed 2026-03-10)
- [x] **Phase 4: Index State + Change Detection** - SQLite state tracking, filesystem polling, content hashing (completed 2026-03-10)
- [x] **Phase 5: Markdown Indexing Pipeline** - Heading-aware chunking, embedding, Qdrant upsert, stale cleanup (completed 2026-03-10)
- [x] **Phase 6: Semantic + Lexical Search** - Qdrant ANN search, FTS5/BM25 lexical search, metadata filtering (completed 2026-03-11)
- [x] **Phase 7: Hybrid Retrieval + Reranking** - RRF fusion, multilingual evaluation harness (reranking deferred to v2) (completed 2026-03-11)
- [x] **Phase 8: Context Pack Assembly** - Token-budgeted knowledge bundles with relevance floor and source citations (completed 2026-03-11)
- [x] **Phase 9: TOON + API Polish** - TOON content negotiation, JSON default, OpenAPI spec generation (completed 2026-03-12)
- [x] **Phase 10: Multi-Format Indexing** - PDF, Canvas, Excalidraw, CSV, and image metadata indexing (completed 2026-03-12)
- [x] **Phase 11: Observability + Admin** - Structured logging, Prometheus metrics, OpenTelemetry, manual reindex (completed 2026-03-12)
- [x] **Phase 12: Prometheus Metrics Dashboard** - Prometheus + Grafana docker-compose, dashboards, alert rules (completed 2026-03-12)
- [x] **Phase 13: Search & Reindex Correctness** - Folder filter in semantic search, reindex status timing, contentHash fix (completed 2026-03-12)
- [ ] **Phase 14: Infrastructure Hardening & Cleanup** - Docker volume persistence, unsafe cast fix, lint cleanup, docs

## Phase Details

### Phase 1: Project Skeleton
**Goal**: A running Fastify service in Docker that authenticates requests and reports health
**Depends on**: Nothing (first phase)
**Requirements**: API-04, INF-01, INF-06
**Success Criteria** (what must be TRUE):
  1. Service starts in Docker (docker-compose up) and responds to HTTP requests
  2. Health endpoint returns service status; readiness endpoint confirms service is ready to accept work
  3. Requests without valid API key are rejected with 401; requests with valid key succeed
  4. Project has TypeScript compilation, ESM module resolution, and a working test runner
**Plans**: 3 plans

Plans:
- [ ] 01-01-PLAN.md -- Project init, tooling, Fastify app factory, config, error handler
- [ ] 01-02-PLAN.md -- Health/readiness endpoints and API key auth plugin with tests
- [ ] 01-03-PLAN.md -- Dockerfile, docker-compose with Qdrant sidecar, end-to-end verification

### Phase 2: Vault Read Operations
**Goal**: Agents can browse and read vault contents safely through the REST API
**Depends on**: Phase 1
**Requirements**: FILE-01, FILE-02, FILE-08, FILE-10
**Success Criteria** (what must be TRUE):
  1. Agent can list files and folders in vault, filtered by path prefix
  2. Agent can read full note content by path, receiving markdown body
  3. Agent can read frontmatter metadata as structured key-value data from any note
  4. Any request with a path that traverses outside the vault boundary is rejected with 403
**Plans**: 3 plans

Plans:
- [ ] 02-01-PLAN.md -- VaultManager class with path security, Fastify plugin, TypeBox schemas
- [ ] 02-02-PLAN.md -- List files and read content endpoints with integration tests
- [ ] 02-03-PLAN.md -- Frontmatter metadata endpoint and readiness vault check

### Phase 3: Vault Write Operations
**Goal**: Agents can create, modify, and organize notes through the REST API
**Depends on**: Phase 2
**Requirements**: FILE-03, FILE-04, FILE-05, FILE-06, FILE-07, FILE-09
**Success Criteria** (what must be TRUE):
  1. Agent can create a new note with content and optional frontmatter at a specified path
  2. Agent can fully replace note content and append/prepend content to an existing note
  3. Agent can delete a note by path and the file is removed from disk
  4. Agent can rename or move a note to a new path, preserving content
  5. Agent can update individual frontmatter fields without corrupting note body or other metadata
**Plans**: 3 plans

Plans:
- [ ] 03-01-PLAN.md — Create, update, and append/prepend endpoints with atomic writes
- [ ] 03-02-PLAN.md — Delete and rename/move endpoints
- [ ] 03-03-PLAN.md — Frontmatter update endpoint with shallow merge and null-delete

### Phase 4: Index State + Change Detection
**Goal**: Service automatically detects vault changes and tracks index state in SQLite
**Depends on**: Phase 2
**Requirements**: IDX-01, IDX-02, IDX-06
**Success Criteria** (what must be TRUE):
  1. On startup, service scans the full vault and records every file in SQLite with content hash
  2. Filesystem poller detects created, modified, moved, and deleted files within 10-15 seconds
  3. Poller uses two-pass stability check so partially-written files (Obsidian Sync) are not processed
  4. SQLite tracks file path, content hash, mtime, and embedding model version per indexed file
**Plans**: 3 plans

Plans:
- [ ] 04-01-PLAN.md — SQLite schema with Drizzle ORM, DB client, Fastify plugin, config extension
- [ ] 04-02-PLAN.md — VaultIndexer with scan, poll, stability check, move detection, event emission
- [ ] 04-03-PLAN.md — Readiness endpoint extension with DB health and indexing status

### Phase 5: Markdown Indexing Pipeline
**Goal**: Markdown files are chunked, embedded, and stored in Qdrant with rich metadata
**Depends on**: Phase 4
**Requirements**: IDX-03, IDX-04, IDX-05, IDX-07
**Success Criteria** (what must be TRUE):
  1. Markdown is split by heading boundaries; code blocks and tables are never split mid-element
  2. Each chunk carries section_path metadata reflecting its heading hierarchy (e.g., "Note Title > H2 > H3")
  3. Frontmatter fields (tags, project, status, type) are extracted and stored in Qdrant payload per chunk
  4. When a note is edited, old vectors are deleted and new vectors are upserted (no stale duplicates)
  5. When a note is deleted, all its vectors are removed from Qdrant
**Plans**: 3 plans

Plans:
- [ ] 05-01-PLAN.md — Heading-aware markdown chunker with section_path (TDD)
- [ ] 05-02-PLAN.md — Config extension, EmbeddingProvider, Qdrant plugin with collection init
- [ ] 05-03-PLAN.md — Pipeline plugin wiring indexer events to chunk/embed/upsert with stale cleanup

### Phase 6: Semantic + Lexical Search
**Goal**: Agents can search vault content by meaning or by exact terms with metadata filtering
**Depends on**: Phase 5
**Requirements**: RET-01, RET-02, RET-05, RET-06
**Success Criteria** (what must be TRUE):
  1. Agent can perform semantic search and receive results ranked by embedding similarity
  2. Agent can perform lexical search that finds exact technical terms, acronyms, and short identifiers
  3. Agent can filter any search by tags, project, status, folder path, or note type
  4. Search results include chunk text, source note path, section_path, and relevance score
**Plans**: 2 plans

Plans:
- [ ] 06-01-PLAN.md — Pipeline text payload + Qdrant full-text indexes for lexical search
- [ ] 06-02-PLAN.md — Search feature module (semantic + lexical endpoints, schemas, service, tests)

### Phase 7: Hybrid Retrieval + Reranking
**Goal**: Agents get high-precision results from combined semantic + lexical search via RRF fusion, validated by multilingual evaluation harness
**Depends on**: Phase 6
**Requirements**: RET-03, RET-04, RET-07
**Success Criteria** (what must be TRUE):
  1. Hybrid search endpoint combines semantic and lexical results via RRF fusion
  2. RET-04 (cross-encoder reranking) is deferred to v2 — not implemented in this phase
  3. Mixed Russian/English queries with technical terms return relevant results (validated by evaluation harness)
  4. Evaluation harness reports recall@10 per category and overall for all three search types
**Plans**: 2 plans

Plans:
- [x] 07-01-PLAN.md — RRF fusion hybrid() method, POST /hybrid route, unit tests
- [ ] 07-02-PLAN.md — Multilingual evaluation harness CLI script with 30-35 queries and recall@10 metrics

### Phase 8: Context Pack Assembly
**Goal**: Agents can request structured, token-budgeted knowledge bundles for downstream tasks
**Depends on**: Phase 7
**Requirements**: CTX-01, CTX-02, CTX-03, CTX-04
**Success Criteria** (what must be TRUE):
  1. Agent can request a context pack for a query/task and receive a structured knowledge bundle
  2. Context pack respects configurable token budget (default ~32K, adjustable per request)
  3. Context pack includes relevant chunks organized by type (summary, architecture, ADRs, implementation) with source citations
  4. Context pack applies relevance floor filtering, excluding low-relevance chunks rather than greedy bin-packing
**Plans**: 2 plans

Plans:
- [ ] 08-01-PLAN.md — Schemas, SearchResult type fix, and ContextService assembly pipeline
- [ ] 08-02-PLAN.md — Context route handler, app registration, and integration tests

### Phase 9: TOON + API Polish
**Goal**: Agents communicate with CogniVault using either JSON or TOON for ~40% token savings
**Depends on**: Phase 1
**Requirements**: API-01, API-02, API-03, INF-02
**Success Criteria** (what must be TRUE):
  1. Service accepts TOON-formatted request bodies when Content-Type is text/toon
  2. Service returns TOON-formatted responses when Accept header is text/toon
  3. Service returns JSON by default when Accept is application/json or unspecified
  4. OpenAPI spec is auto-generated from route definitions and accessible via endpoint
**Plans**: 2 plans

Plans:
- [ ] 09-01-PLAN.md — TOON content negotiation plugin with request parsing, response serialization, and TOON-aware error handling
- [ ] 09-02-PLAN.md — OpenAPI spec generation with @fastify/swagger and Swagger UI at /docs

### Phase 10: Multi-Format Indexing
**Goal**: Non-markdown vault content (PDF, Canvas, Excalidraw, CSV, images) is indexed and searchable
**Depends on**: Phase 5
**Requirements**: IDX-08, IDX-09, IDX-10, IDX-11, IDX-12
**Success Criteria** (what must be TRUE):
  1. PDF files have their text extracted, chunked, and indexed into Qdrant
  2. Canvas JSON files have their node content parsed and indexed
  3. Excalidraw files have their text elements extracted and indexed
  4. CSV files are indexed with row-level chunking
  5. Image files have their metadata (name, path, linked notes) tracked in the index
**Plans**: 3 plans

Plans:
- [ ] 10-01-PLAN.md — PDF chunker (pdfjs-dist) and CSV chunker (PapaParse) with tests
- [ ] 10-02-PLAN.md — Canvas JSON chunker and Excalidraw chunker with tests
- [ ] 10-03-PLAN.md — DB migration, image tracker, indexer extension, and pipeline format dispatch

### Phase 11: Observability + Admin
**Goal**: Service is production-ready with structured logging, metrics, tracing, and admin reindex controls
**Depends on**: Phase 5
**Requirements**: INF-03, INF-04, INF-05, IDX-13
**Success Criteria** (what must be TRUE):
  1. All requests emit structured JSON logs with request ID, method, path, status, and duration
  2. Prometheus /metrics endpoint exposes search latency, throughput, index queue depth, and stale vector cleanup counts
  3. OpenTelemetry traces span request lifecycle from API entry through Qdrant/embedding calls
  4. Admin can trigger full reindex or partial reindex (by path or folder) via API endpoint
**Plans**: 3 plans

Plans:
- [ ] 11-01-PLAN.md — Structured logging enrichment (X-Request-ID, redaction) and Prometheus metrics plugin with search/pipeline instrumentation
- [ ] 11-02-PLAN.md — Admin reindex API endpoints (full, path, folder scopes with async job pattern)
- [ ] 11-03-PLAN.md — OpenTelemetry tracing with conditional SDK init, manual spans, and trace ID log injection

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10 -> 11 -> 12
Note: Phases 9, 10, 11 depend on earlier phases but are independent of each other and could execute in any order after their dependencies are met.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Project Skeleton | 3/3 | Complete   | 2026-03-10 |
| 2. Vault Read Operations | 3/3 | Complete   | 2026-03-10 |
| 3. Vault Write Operations | 3/3 | Complete   | 2026-03-10 |
| 4. Index State + Change Detection | 3/3 | Complete   | 2026-03-10 |
| 5. Markdown Indexing Pipeline | 3/3 | Complete   | 2026-03-10 |
| 6. Semantic + Lexical Search | 2/2 | Complete   | 2026-03-11 |
| 7. Hybrid Retrieval + Reranking | 2/2 | Complete   | 2026-03-11 |
| 8. Context Pack Assembly | 2/2 | Complete   | 2026-03-11 |
| 9. TOON + API Polish | 2/2 | Complete   | 2026-03-12 |
| 10. Multi-Format Indexing | 3/3 | Complete    | 2026-03-12 |
| 11. Observability + Admin | 3/3 | Complete    | 2026-03-12 |
| 12. Prometheus Metrics Dashboard | 3/3 | Complete    | 2026-03-12 |
| 13. Search & Reindex Correctness | 2/2 | Complete   | 2026-03-12 |
| 14. Infrastructure Hardening & Cleanup | 0/0 | Not Started | - |

### Phase 12: Prometheus metrics dashboard in separate container

**Goal:** Prometheus and Grafana run alongside CogniVault in docker-compose, scraping metrics and providing auto-provisioned dashboards for search performance, indexing pipeline health, and Node.js runtime monitoring
**Requirements**: MON-01, MON-02, MON-03, MON-04, MON-05, MON-06, MON-07, MON-08
**Depends on:** Phase 11
**Success Criteria** (what must be TRUE):
  1. Prometheus scrapes CogniVault /metrics endpoint every 15 seconds with 7-day retention
  2. Grafana loads three auto-provisioned dashboards (Search, Indexing, System) on startup without manual configuration
  3. Search dashboard shows latency percentiles, heatmaps, request rate, and error rate
  4. Indexing dashboard shows embedding call rate, chunk throughput, pipeline duration, queue depth
  5. System dashboard shows CPU, memory, heap, GC, event loop lag, and uptime
  6. Four Prometheus alerting rules fire on service down, high memory, high latency, high error rate
  7. Three new pipeline metrics (embedding requests, chunks processed, pipeline duration) are instrumented in CogniVault
**Plans**: 3 plans

Plans:
- [ ] 12-01-PLAN.md — New pipeline metrics (embedding, chunks, duration) in metrics.ts + pipeline.ts instrumentation
- [ ] 12-02-PLAN.md — Prometheus + Grafana docker-compose services, scrape config, alert rules, Grafana provisioning
- [ ] 12-03-PLAN.md — Three Grafana dashboard JSON files (Search, Indexing, System) with end-to-end verification

### Phase 13: Search & Reindex Correctness
**Goal:** Fix integration correctness issues in search filtering and reindex status tracking
**Depends on:** Phase 6, Phase 11
**Requirements:** RET-05, IDX-13, IDX-06
**Gap Closure:** Closes integration gaps from v1.0 audit
**Success Criteria** (what must be TRUE):
  1. Folder filter is applied in semantic() and hybrid semantic leg, not just lexical post-filter
  2. Reindex job status transitions to 'completed' only after pipeline queue fully drains
  3. Path-scoped reindex emits real contentHash instead of empty string
**Plans**: 2 plans

Plans:
- [ ] 13-01-PLAN.md — Folder post-filter in semantic() search for RET-05 correctness
- [ ] 13-02-PLAN.md — Pipeline queue drain for reindex completion and real contentHash in path reindex

### Phase 14: Infrastructure Hardening & Cleanup
**Goal:** Fix infrastructure issues, clean up tech debt, and complete documentation gaps
**Depends on:** Phase 1, Phase 4, Phase 9, Phase 12
**Requirements:** MON-01, MON-02, MON-03, MON-04, MON-05, MON-06, MON-07, MON-08
**Gap Closure:** Closes tech debt and documentation gaps from v1.0 audit
**Success Criteria** (what must be TRUE):
  1. SQLite data directory uses a named Docker volume, persisted across container restarts
  2. VaultManager.rootPath accessed via public getter, not unsafe private-field cast
  3. Biome lint passes cleanly (organizeImports fixed in toon.test.ts)
  4. No-op onClose test in db.test.ts replaced with meaningful assertion or removed
  5. HighErrorRate alert rule handles idle periods without false-positives
  6. MON-01 through MON-08 added to REQUIREMENTS.md traceability table
**Plans**: TBD
