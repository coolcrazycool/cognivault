# CogniVault

## What This Is

A unified self-hosted REST API service that serves as the knowledge access layer for AI agents working with Obsidian vaults. CogniVault combines Obsidian-compatible file operations, continuous vector indexing into Qdrant, hybrid retrieval (semantic + lexical + metadata), and structured context pack assembly — all in a single deployable service. Agents interact via standard REST or TOON (Token-Oriented Object Notation) for token-efficient communication.

## Core Value

AI agents can find and retrieve the right knowledge from an Obsidian vault in under one second, with high precision across mixed Russian/English content, exact technical terms, and freeform metadata.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] REST API for Obsidian note/file CRUD operations (list, read, create, update, append/prepend/patch, delete, rename/move)
- [ ] Frontmatter read/write for freeform YAML metadata
- [ ] Multi-vault support with isolation between vaults
- [ ] Built-in indexing subsystem: full + incremental, filesystem change detection via polling (Obsidian Sync compatible)
- [ ] Markdown-aware chunking with section hierarchy preservation
- [ ] Multi-format indexing: .md, PDF text extraction, Canvas JSON parsing, Excalidraw text extraction, CSV, image metadata
- [ ] Qdrant vector storage with concrete payload schema (path, title, chunk_id, section_path, tags, project, status, content_hash, etc.)
- [ ] SQLite-based index state tracking (hashes, timestamps, embedding model versions)
- [ ] Semantic search via Qdrant with embedding provider abstraction (start with OpenAI, swappable)
- [ ] Keyword/lexical search for exact technical terms, acronyms, mixed-language queries
- [ ] Hybrid retrieval with RRF fusion + Cohere/BGE cross-encoder reranking
- [ ] Metadata filtering: project, type, tags, status, folder path
- [ ] Context pack assembly endpoint: structured knowledge bundle for downstream agents (~32K token budget, configurable)
- [ ] TOON notation support for both request and response (content negotiation: Accept: text/toon vs application/json)
- [ ] API key authentication with read-only vs write/admin role separation
- [ ] Async write path: file writes on disk, watcher triggers reindexing
- [ ] Stale vector cleanup: detect obsolete chunks on reindex, propagate deletes, handle renames
- [ ] Embedding model version tracking and upgrade path
- [ ] Manual reindex endpoints (full, by path, by folder)
- [ ] Path traversal protection and safe filesystem operations
- [ ] Full observability: structured JSON logs, Prometheus metrics, OpenTelemetry tracing
- [ ] Docker deployment: single service + Qdrant in docker-compose
- [ ] Health and readiness endpoints

### Out of Scope

- Wikilink/backlink graph navigation — agents use retrieval, not graph traversal
- Real-time WebSocket push — agents poll or use request/response
- Obsidian plugin — this is a standalone server-side service
- User authentication / multi-user — local agents only, API key sufficient
- UI/dashboard — admin via REST endpoints and metrics
- Aggressive query caching — Qdrant is fast enough, cache invalidation adds complexity

## Context

**Current state:** There is an existing custom REST API for Obsidian data and Smart Connections for semantic search. CogniVault replaces and unifies both into one robust service.

**Vault characteristics:**
- 500-5,000 notes, growing
- Freeform structure (no PARA or fixed folder convention)
- Freeform frontmatter (no standardized schema across notes)
- 80%+ Russian content, mixed with English technical terminology
- Synced via Obsidian Sync from phone, laptop, desktop
- Contains .md, PDFs, Canvas, Excalidraw, CSV, Excel, images

**Agent ecosystem:** 1-3 concurrent agents. Framework-agnostic — any agent that speaks REST/TOON can use the service. Hot path: hybrid search > read note > context pack > create/update.

**TOON format:** Token-Oriented Object Notation (https://github.com/toon-format/toon). Compact, human-readable, schema-aware JSON alternative for LLM prompts. Uses indentation + field headers + tabular arrays. ~40% fewer tokens than JSON. Service supports content negotiation (Accept: text/toon returns TOON, default JSON).

**Multilingual retrieval challenge:** Vault contains queries like "Compass catalog ui filters", "как устроен ingestion metadata routes", "SLA ownership tabs", "schema evolution rules" — mix of Russian prose, English technical terms, abbreviations, project names. Retrieval must handle exact matching of short technical identifiers alongside semantic similarity.

## Constraints

- **Deployment**: Single Docker-deployable service + Qdrant sidecar, self-hosted server
- **Latency**: < 1 second for hybrid search requests
- **Consistency**: Vault on disk is source of truth; Qdrant must not contain stale vectors
- **Sync method**: Obsidian Sync — no git diffs available, must use filesystem polling + content hashing
- **Token budget**: Context packs default ~32K tokens, configurable per request
- **Concurrency**: 1-3 simultaneous agent connections
- **Embedding**: Provider abstraction required; start with OpenAI text-embedding-3, must be swappable to local models (BGE, nomic-embed)
- **Reranker**: Cross-encoder reranking (Cohere/BGE) for precision on top-K results
- **State storage**: SQLite for index state — atomic, fast lookups, zero config
- **Write model**: Async — writes go to disk, filesystem watcher triggers reindexing

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Replace existing API entirely | Clean slate allows unified design without backward compatibility hacks | — Pending |
| Multi-vault from v1 | User requirement; vault_name as namespace in Qdrant collection + SQLite | — Pending |
| SQLite for index state | ACID, fast path lookups, no external dependency, survives crashes | — Pending |
| TOON content negotiation | Both input and output; Accept header determines format; reduces agent token usage by ~40% | — Pending |
| Async write-then-index | Decouples write latency from embedding latency; watcher ensures consistency | — Pending |
| Filesystem polling (not inotify) | Obsidian Sync doesn't trigger FS events reliably; polling + content hash is robust | — Pending |
| Cross-encoder reranking | Significant precision improvement for mixed-language technical queries | — Pending |
| No query caching | Qdrant latency acceptable; cache invalidation complexity not worth it at this scale | — Pending |
| No backlink/graph support | Agents use retrieval, not graph traversal; simplifies architecture | — Pending |

---
*Last updated: 2026-03-10 after initialization*
