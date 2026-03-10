# Project Research Summary

**Project:** CogniVault
**Domain:** Agent-facing knowledge access layer — Obsidian vault API with hybrid vector retrieval
**Researched:** 2026-03-10
**Confidence:** HIGH

## Executive Summary

CogniVault occupies a clearly defined gap in the personal knowledge management tooling landscape: every existing RAG product is either file-aware-but-not-searchable (Obsidian Local REST API) or search-capable-but-not-file-aware (Khoj, PrivateGPT, Onyx, AnythingLLM). None is designed agent-first. The recommended approach is a single-process Node.js/TypeScript service using Fastify v5, Qdrant 1.15+, and SQLite (via Drizzle ORM) as the canonical index state tracker. The architecture is deliberately monolithic — a long-running Docker service, not a distributed system — and this is correct for the target scale of 500–5,000 notes with 1–3 concurrent agents. Qdrant 1.15+'s native BM25 sparse vectors with Russian stemming eliminate the need for a separate lexical search sidecar, which is the single most important technology selection insight from the research.

The recommended build order is bottom-up: Vault Manager and File Ops first (no external dependencies), then index state and filesystem polling (SQLite + content hashing), then the full indexing pipeline (chunking → embedding → Qdrant), then retrieval (semantic + lexical + RRF fusion + reranking), and finally context pack assembly and observability polish. This ordering is dictated by hard data flow dependencies: retrieval cannot be built before indexing, indexing cannot be built before change detection, and change detection cannot be built before the vault abstraction. Skipping ahead creates integration bottlenecks that compound into architectural debt.

The three highest-risk decisions that must be made correctly in Phase 1 are: (1) markdown-aware chunking with section hierarchy preservation — wrong chunking is catastrophically expensive to fix later because it forces a full vault reindex; (2) deterministic Qdrant point IDs derived from vault + path + chunk index — without this, re-indexing creates duplicates rather than idempotent upserts; and (3) SQLite embedding model version tracking — without this, switching embedding models causes silent garbage retrieval with no detection mechanism. All three are cheap to implement correctly upfront and expensive to retrofit.

## Key Findings

### Recommended Stack

The stack is mature and well-justified. Fastify v5 (v5.8.x, current as of March 2026) provides schema-based request validation via Zod v4, a plugin architecture that maps to CogniVault's distinct domains (file ops, indexing, retrieval), and superior performance versus Express. Qdrant 1.15+ is the decisive vector database choice: its native multilingual BM25 sparse vectors with Russian stemming built in means no Elasticsearch/MeiliSearch sidecar is needed — hybrid search with RRF fusion runs entirely server-side via Qdrant's Query API. Drizzle ORM with better-sqlite3 provides type-safe synchronous access to the index state database without the runtime overhead of Prisma. OpenAI text-embedding-3-small is the default embedding model (1536 dims, strong multilingual performance, $0.02/M tokens), with Cohere Rerank 3.5 for cross-encoder reranking. Both are abstracted behind provider interfaces to allow future migration to local models without business logic changes.

For filesystem change detection, the research is unambiguous: polling + content hashing is the only correct approach. Obsidian Sync does not trigger reliable filesystem events. chokidar is explicitly out. Custom polling at 5–10 second intervals with a two-pass stability check (mtime/size stable across two consecutive polls before reading) handles Obsidian Sync's multi-step writes without reading partial content.

**Core technologies:**
- **Fastify v5.8.x**: REST API framework — 2-3x faster than Express, schema-based validation via Zod, plugin encapsulation per domain
- **Zod v4.3.x**: Schema validation + type inference — 14x faster than Zod 3, dual-use for request validation and config validation
- **Qdrant 1.15+ (Docker)**: Vector store — native BM25 sparse vectors with Russian stemming, Query API handles RRF fusion server-side
- **better-sqlite3 + Drizzle ORM**: Index state — synchronous API, type-safe queries, migration support, <100KB overhead
- **OpenAI text-embedding-3-small**: Embeddings — strong multilingual performance, dimension reduction API support, low cost
- **Cohere Rerank 3.5**: Cross-encoder reranking — excellent multilingual support, simple API
- **Custom polling + xxhash-wasm**: Filesystem change detection — content hashing over mtimes because Obsidian Sync updates metadata without changing content
- **pino v9**: Structured logging — Fastify native, JSON output, 5x faster than winston
- **prom-client v15**: Prometheus metrics — event loop lag, custom search latency, index queue size metrics
- **Node.js 22 LTS + TypeScript 5.7+ + ESM-only**: Runtime — all key dependencies are ESM-first; Alpine avoided for Docker base (use node:22-slim for better-sqlite3 native module compatibility)

### Expected Features

CogniVault's unique position is the combination of Obsidian-native file CRUD with hybrid vector retrieval in a single agent-facing API. No competitor does this. The context pack assembly endpoint — token-budget-aware structured knowledge bundles with source attribution — is a unique differentiator that no existing product offers.

**Must have (table stakes — P1 for v1 launch):**
- Note CRUD (list, read, create, update, delete, append) — agents cannot function without this
- Frontmatter read/write — YAML metadata extraction and update without corruption
- Document ingestion with Markdown-aware chunking — section hierarchy preservation (not generic token splitting)
- Semantic search via Qdrant — embedding pipeline + ANN search with metadata filters
- Keyword/lexical search — exact term matching via SQLite FTS5 for technical identifiers, acronyms, mixed-language queries
- Hybrid retrieval with RRF fusion — combine semantic + lexical results
- Incremental indexing — filesystem polling + content hashing (not full reindex on every change)
- Stale vector cleanup — delete/rename propagation to prevent ghost data accumulation
- Metadata filtering — filter by tags, project, folder path, status on all search endpoints
- API key authentication — read-only vs write roles
- Health/readiness endpoints — required for Docker deployment

**Should have (v1.x — add after core retrieval is validated):**
- Cross-encoder reranking — add Cohere/BGE; significant precision improvement for mixed Russian/English queries
- Context pack assembly — structured token-budgeted knowledge bundles (unique differentiator)
- TOON content negotiation — ~40% token reduction; add when token costs become a concern
- Multi-vault activation — data model designed from v1, activate when second vault needed
- Multi-format indexing (PDF, CSV, Canvas) — extend beyond Markdown
- Prometheus metrics + OpenAPI docs — operational observability

**Defer (v2+):**
- Embedding model migration tooling — only needed when switching providers
- OpenTelemetry distributed tracing — useful at scale, unnecessary for 1-3 agents
- Local embedding model support (BGE/nomic-embed) — OpenAI is sufficient initially
- Excalidraw/image metadata extraction — low-volume, high-complexity

**Anti-features (explicitly do not build):**
- LLM chat/completions endpoint — agents have their own LLM; coupling to providers adds complexity without value
- Real-time WebSocket push — agents are request/response; polling search is sufficient
- UI/admin dashboard — API-first + Prometheus/Grafana is better
- Wikilink graph traversal — semantic search achieves "find related" more reliably

### Architecture Approach

CogniVault is a single-process Node.js service with internally modular subsystems communicating via in-process calls and a simple event emitter (FS Poller → Indexing Pipeline). No microservices, no message queues. The filesystem is the single source of truth; Qdrant and SQLite are derived state that can be fully reconstructed from a full reindex. Writes always go to disk first (atomic temp-file + rename), return immediately to the agent, and trigger async reindexing via the polling cycle — embedding latency (100–500ms per batch) never blocks write acknowledgment. The Qdrant collection uses payload-based tenant isolation (`vault_id` with `is_tenant: true`) rather than one collection per vault, following Qdrant's official multitenancy recommendation.

**Major components:**
1. **API Layer (Fastify)** — HTTP routing, bearer auth, content negotiation (JSON/TOON), Zod request validation; stateless
2. **Vault Manager** — multi-vault registry, path resolution, path traversal protection; owns vault config
3. **File Ops Module** — note/file CRUD, frontmatter parsing, atomic writes; filesystem is source of truth
4. **FS Poller** — periodic scanning with two-pass stability check, content hashing (xxhash), change event emission
5. **Indexing Pipeline** — format-specific chunking, embedding batching with backpressure, Qdrant upsert, stale cleanup; driven by bounded queue (p-queue, concurrency 1-3)
6. **Retrieval Pipeline** — hybrid search orchestration: parallel semantic + lexical, RRF fusion, cross-encoder reranking; stateless query path
7. **Context Pack Assembler** — token-budget-aware assembly with relevance floor filtering, deduplication, source attribution; stateless
8. **Observability** — pino structured logging, prom-client Prometheus metrics, OpenTelemetry traces (deferred to v2)

### Critical Pitfalls

1. **Naive markdown chunking destroys retrieval quality** — Fixed-size token splitting achieves faithfulness scores of 0.47–0.51 vs 0.79–0.82 for structure-aware chunking. Split on heading boundaries first, preserve `section_path` metadata (e.g., `["Note Title", "## Architecture", "### Data Flow"]`), never split mid-code-block or mid-table, carry section context into oversized chunk splits. This decision is catastrophically expensive to fix later (requires full reindex).

2. **Stale vectors accumulate silently** — File edits/renames/deletes leave ghost vectors in Qdrant that pollute results. Prevention: content hash per file in SQLite; on change, delete all chunks for that path then re-chunk and re-embed; detect renames via hash match at different path (update payload vs delete+reindex); add `cognivault_stale_vectors_cleaned_total` Prometheus metric. Must be built into the core indexing loop, not bolted on.

3. **Multilingual embedding bias silently degrades Russian retrieval** — OpenAI embedding models have measurably lower recall for cross-language queries (English query → Russian content). Lexical search (BM25/FTS5) is the primary safety net — exact term matching catches technical identifiers regardless of embedding quality. Build a 30–50 query evaluation harness in the same phase as retrieval, not after. Never defer lexical search to a later phase.

4. **Filesystem polling race conditions** — Obsidian Sync writes files in chunks; reading during sync yields partial/corrupt content. Use a two-pass stability check: record `(path, mtime, size)` on each poll; only process files whose mtime/size was stable across two consecutive polls. Poll at 5–10 second interval (not shorter, macOS stat() is slow on thousands of files).

5. **SQLite–Qdrant index state divergence** — SQLite writes and Qdrant writes are not atomic; crashes between operations leave state inconsistent. Prevention: upsert new vectors first → verify count → delete stale vectors → update SQLite. Enable WAL mode (`PRAGMA journal_mode=WAL`) and `busy_timeout=5000`. Use deterministic point IDs so upserts are idempotent. Build a reconciliation endpoint for periodic consistency verification.

6. **Embedding model version mismatch causes silent garbage retrieval** — Switching models without tracking which vectors use which model causes cosine similarity comparisons across incompatible spaces. Prevention: store `embedding_model_version` in SQLite per-file from day one; verify query model matches stored model before searching; use Qdrant collection aliases for zero-downtime migration.

## Implications for Roadmap

Based on the dependency graph from ARCHITECTURE.md and the pitfall phase mappings from PITFALLS.md, five phases are the natural structure. The ordering is non-negotiable due to hard data flow dependencies.

### Phase 1: Foundation — Vault + File Ops + Project Skeleton

**Rationale:** Zero external dependencies; testable in complete isolation. All subsequent phases depend on the vault abstraction. Chunking strategy and data model schema must be established here because they are expensive to change later (full reindex required).
**Delivers:** A working Obsidian vault REST API (note CRUD, frontmatter read/write) inside a properly scaffolded Fastify service with Docker support.
**Addresses (from FEATURES.md):** Note CRUD, frontmatter read/write, API key auth, health/readiness endpoints; multi-vault data model designed (even if single vault operational).
**Stack used:** Fastify v5, Zod v4, `@fastify/bearer-auth`, TypeScript 5.7, ESM, node:22-slim Docker image.
**Pitfalls addressed:** Path traversal protection (Vault Manager), multi-format chunking interface (`ChunkingStrategy` abstraction even if only markdown implemented), embedding model version tracking schema in SQLite, deterministic point ID function (implemented but not yet wired to Qdrant).
**Research flag:** Standard patterns — no additional research needed. Fastify docs and file I/O patterns are well-established.

### Phase 2: Index State + Change Detection + Indexing Pipeline

**Rationale:** Retrieval is impossible without indexed data. Change detection must be solid before adding the embedding layer on top. This is the most complex phase — chunking, embedding, Qdrant integration, and stale cleanup all ship together because they are tightly coupled.
**Delivers:** Fully automated vault indexing: filesystem polling detects changes, Markdown-aware chunker splits content with section hierarchy, embeddings generated via OpenAI API (batched, rate-limited), vectors upserted to Qdrant with rich payload, stale vectors cleaned on edit/rename/delete.
**Addresses (from FEATURES.md):** Document ingestion with Markdown-aware chunking, incremental indexing, stale vector cleanup, SQLite index state.
**Stack used:** better-sqlite3, Drizzle ORM, drizzle-kit, Qdrant 1.15+, `@qdrant/js-client-rest`, OpenAI SDK, xxhash-wasm, p-queue for backpressure control.
**Pitfalls addressed:** Naive chunking (heading-aware splitter, code-block preservation, section_path metadata); stale vectors (content hash → delete old → upsert new → update SQLite); polling race conditions (two-pass stability check); SQLite/Qdrant divergence (WAL mode, deterministic IDs, ordered operations); version tracking (embedding_model_version in SQLite from first write).
**Research flag:** Likely needs `/gsd:research-phase` during planning. Qdrant collection setup specifics (payload index configuration for `is_tenant`, BM25 sparse vector configuration), OpenAI batch embedding API limits, and p-queue concurrency tuning for rate limits may need verification against current docs.

### Phase 3: Retrieval — Hybrid Search + RRF Fusion

**Rationale:** Once data is indexed, the retrieval layer can be built and validated. Semantic search first, then lexical, then fuse — each layer is independently testable before combining. Lexical search via SQLite FTS5 must ship in this phase (not deferred) because it is the primary defense against multilingual embedding bias.
**Delivers:** A search API returning ranked, filtered results. Parallel semantic search (Qdrant ANN) + lexical search (SQLite FTS5) with RRF fusion. Metadata filtering by tags, project, folder, status. An evaluation harness (30–50 queries) measuring recall@10 separately for Russian, English, and mixed-language queries.
**Addresses (from FEATURES.md):** Semantic search, keyword/lexical search, hybrid retrieval with RRF fusion, metadata filtering.
**Stack used:** Qdrant Query API (prefetch + RRF fusion), SQLite FTS5 (unicode61 tokenizer for Russian + English), Zod-validated search request schema.
**Pitfalls addressed:** Multilingual embedding bias (lexical search as safety net, evaluation harness built in same phase); hybrid fusion weighting (RRF k parameter configurable per request, query classifier for semantic vs lexical boost); Qdrant global HNSW without tenant pre-filtering (is_tenant payload index configuration).
**Research flag:** Likely needs `/gsd:research-phase` during planning. SQLite FTS5 tokenization for mixed Russian/English content and Qdrant Query API RRF configuration details may need verification.

### Phase 4: Reranking + Context Pack Assembly

**Rationale:** Cross-encoder reranking requires working hybrid retrieval to rerank. Context pack assembly requires reranker scores for its relevance floor filtering — without scores, the assembler degrades to token-greedy bin-packing, which is precisely the failure mode documented in PITFALLS.md Pitfall 6.
**Delivers:** Reranked search results via Cohere Rerank 3.5 (with graceful fallback to RRF-only if Cohere unavailable). Context pack assembly endpoint with token budget, relevance floor, deduplication, position-aware relevance ordering (high-relevance chunks at start and end to mitigate "lost in the middle" effect), and per-chunk source attribution.
**Addresses (from FEATURES.md):** Cross-encoder reranking, context pack assembly, TOON content negotiation.
**Stack used:** cohere-ai SDK, `@toon-format/toon`, Reranker provider interface (strategy pattern).
**Pitfalls addressed:** Context pack token-greedy filling (relevance floor filtering, diminishing returns threshold, configurable max-chunks per request); reranker latency (only rerank top-20 from initial retrieval, make reranking optional per request flag).
**Research flag:** Likely needs `/gsd:research-phase` during planning. Cohere Rerank 3.5 API rate limits, TOON library stability, and token-budgeting algorithm details may need verification.

### Phase 5: Multi-Format + Observability + Multi-Vault Activation

**Rationale:** Once the core pipeline is proven on Markdown, extend to other file formats using the `ChunkingStrategy` interface established in Phase 1. Activate multi-vault support (data model is already in place). Add Prometheus metrics and structured logging to make the service production-ready.
**Delivers:** PDF, CSV, and Canvas file indexing. Full multi-vault isolation (activate second vault namespace). Prometheus `/metrics` endpoint with search latency, index queue depth, stale vector cleanup counts, and OpenTelemetry traces. OpenAPI spec endpoint.
**Addresses (from FEATURES.md):** Multi-format indexing, multi-vault activation, Prometheus metrics, OpenAPI documentation.
**Stack used:** pdf-parse, csv-parse, gray-matter (already used), prom-client, `@opentelemetry/sdk-node`, `@fastify/otel`.
**Pitfalls addressed:** Multi-format as afterthought (ChunkingStrategy interface from Phase 1 means no core pipeline changes needed; each format plugs in independently).
**Research flag:** Standard patterns for Prometheus/OTel. PDF text extraction quality may need empirical testing with real vault PDFs (pdf-parse confidence is MEDIUM vs HIGH for other libraries).

### Phase Ordering Rationale

- **Foundation before indexing:** Vault Manager and path safety must exist before any component touches the filesystem for indexing purposes.
- **Indexing before retrieval:** Cannot search what isn't indexed; incremental indexing and stale cleanup must be solid before retrieval is layered on top.
- **Lexical search in Phase 3, not deferred:** Multilingual embedding bias makes lexical search a correctness requirement, not a nice-to-have. Deferring it means shipping retrieval that silently fails for Russian-query-to-Russian-content scenarios.
- **Reranking in Phase 4, not Phase 3:** Cross-encoder reranking depends on hybrid retrieval working first; context assembly depends on reranker scores for quality filtering — these two are correctly grouped.
- **Multi-format in Phase 5:** The `ChunkingStrategy` interface abstraction from Phase 1 means adding formats in Phase 5 requires zero changes to the core pipeline; only new strategy implementations are added.
- **Chunking strategy is irreversible:** Any change to chunk size, splitting logic, or section_path format requires a full vault reindex. This is why getting chunking right in Phase 1 (the interface) and Phase 2 (the Markdown implementation) is the highest-priority design decision in the project.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2 (Indexing Pipeline):** Qdrant collection configuration details (BM25 sparse vector setup, `is_tenant` payload index syntax in JS client), OpenAI batch embedding limits and rate limit headers, p-queue integration patterns with async backpressure. The integration surface between multiple new technologies in a single phase warrants upfront API research.
- **Phase 3 (Retrieval):** SQLite FTS5 with `unicode61` tokenizer for mixed Cyrillic/Latin content — Russian-specific tokenization behavior needs verification; Qdrant Query API RRF `k` parameter defaults and configuration syntax in the JS client.
- **Phase 4 (Reranking + Context):** Cohere Rerank 3.5 API rate limits and cost structure; TOON library v3 stability and API surface.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Foundation):** Fastify v5 setup, Zod integration, bearer auth — comprehensive official docs, stable patterns, no novel integration surface.
- **Phase 5 (Multi-format + Observability):** prom-client and OpenTelemetry for Node.js are well-documented; PDF/CSV parsing with existing libraries follows established patterns.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All primary technologies verified against official docs and current releases (March 2026). Qdrant 1.15 BM25 support confirmed from release blog. Fastify v5.8.2 current. Zod v4 released. Only pdf-parse is MEDIUM — pure TS alternative, extraction quality needs empirical validation with real PDFs. |
| Features | HIGH | Multiple competitors analyzed; feature table comprehensive. Table stakes derived from 6 product comparisons. Differentiators clearly gap-filled vs competitors. Anti-features explicitly justified — no hand-waving. |
| Architecture | HIGH | Qdrant multitenancy approach from official Qdrant docs. Build order from dependency graph analysis, not opinion. Single-process monolith is the correct call for 1-3 agents; no speculative distributed design. |
| Pitfalls | HIGH (core), MEDIUM (CogniVault-specific combinations) | Core RAG pitfalls (chunking, stale vectors, multilingual bias) well-documented across multiple independent sources. CogniVault-specific combinations (Obsidian Sync + polling + Qdrant) are medium confidence because fewer real-world deployments exist at this exact intersection. |

**Overall confidence:** HIGH

### Gaps to Address

- **PDF text extraction quality:** pdf-parse v2.4.x is rated MEDIUM confidence. Real-world quality on Obsidian vault PDFs (research papers, scanned docs, complex layouts) needs empirical testing in Phase 5. May need to evaluate alternatives (pdfjs-dist, offloading to a preprocessing step) if quality is insufficient.
- **SQLite FTS5 Russian tokenization:** The `unicode61` tokenizer handles Russian/English Unicode but may not perform BM25 stemming as well as Qdrant's native multilingual BM25. The retrieval evaluation harness in Phase 3 will reveal whether FTS5 lexical search quality is acceptable or whether Qdrant BM25 sparse vectors should also be used for lexical retrieval alongside FTS5.
- **RRF k-parameter tuning:** The optimal `k` value for CogniVault's mixed Russian/English technical content is unknown without empirical testing. Research confirms default values (k=60) may under-weight lexical results for short technical term queries. The evaluation harness and configurable-per-request design mitigates this, but real tuning data does not exist pre-build.
- **Obsidian Sync polling behavior on macOS vs Docker host vs Linux:** The two-pass stability check design is sound, but specific timing characteristics of Obsidian Sync file write patterns across platforms have limited documented precedent. May need adjustment to poll interval or stability window based on observed behavior in early testing.

## Sources

### Primary (HIGH confidence)
- [Fastify official docs](https://fastify.dev/) — v5.8.2, March 2026; plugin architecture, TOON negotiation approach
- [Qdrant text search docs](https://qdrant.tech/documentation/guides/text-search/) — BM25 native sparse vector support, Query API
- [Qdrant 1.15 release blog](https://qdrant.tech/blog/qdrant-1.15.x/) — multilingual tokenizer, Russian stemming/stopwords confirmation
- [Qdrant multitenancy guide](https://qdrant.tech/documentation/guides/multitenancy/) — payload-based isolation recommendation, `is_tenant` field
- [Qdrant collection aliases](https://qdrant.tech/documentation/concepts/collections/) — zero-downtime migration strategy
- [OpenAI embedding models](https://platform.openai.com/docs/models/text-embedding-3-small) — text-embedding-3-small specs, multilingual performance
- [Cohere Rerank docs](https://docs.cohere.com/docs/rerank) — Rerank 3.5 multilingual support, API interface
- [Zod v4 release](https://zod.dev/v4) — 14x performance improvement, `.toJSONSchema()` for OpenAPI
- [Drizzle ORM SQLite](https://orm.drizzle.team/docs/get-started-sqlite) — better-sqlite3 sync integration
- [OpenTelemetry Node.js](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/) — SDK setup; @fastify/otel for Fastify-specific instrumentation
- [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) — competitive baseline; feature gap analysis
- [Khoj documentation](https://docs.khoj.dev/) — competitive analysis; semantic search without file ops
- [Onyx documentation](https://docs.onyx.app/welcome) — competitive analysis; hybrid search architecture
- [PrivateGPT documentation](https://docs.privategpt.dev/api-reference) — competitive analysis; ingestion + chunking patterns
- [AnythingLLM documentation](https://docs.anythingllm.com/) — competitive analysis; workspace-based isolation

### Secondary (MEDIUM confidence)
- [Firecrawl chunking best practices 2026](https://www.firecrawl.dev/blog/best-chunking-strategies-rag) — heading-based chunking performance data (faithfulness 0.47 naive vs 0.79 structure-aware)
- [Building production RAG systems 2026](https://brlikhon.engineer/blog/building-production-rag-systems-in-2026-complete-architecture-guide) — modular RAG architecture patterns
- [SBERT retrieve & re-rank](https://sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html) — two-stage retrieval pipeline pattern
- [Building multilingual RAG systems (Microsoft)](https://medium.com/data-science-at-microsoft/building-and-evaluating-multilingual-rag-systems-943c290ab711) — multilingual bias measurement methodology
- [Superlinked hybrid search + reranking](https://superlinked.com/vectorhub/articles/optimizing-rag-with-hybrid-search-reranking) — RRF fusion + cross-encoder pipeline
- [SQLite concurrent writes](https://tenthousandmeters.com/blog/sqlite-concurrent-writes-and-database-is-locked-errors/) — WAL mode and busy_timeout configuration
- [Migrating vector embeddings to Qdrant](https://0xhagen.medium.com/migrating-vector-embeddings-from-postgresql-to-qdrant-challenges-learnings-and-insights-f101f42f78f5) — embedding model migration strategy

### Tertiary (LOW confidence)
- [Syncthing polling vs filesystem watch forum](https://forum.syncthing.net/t/polling-vs-file-system-watch/953) — analog for Obsidian Sync polling behavior; not CogniVault-specific
- [Cross-lingual retrieval biases in RAG (arxiv)](https://arxiv.org/html/2507.07543) — multilingual embedding bias quantification; research paper, not production data

---
*Research completed: 2026-03-10*
*Ready for roadmap: yes*
