# CogniVault

## What This Is

A self-hosted, multi-tenant REST API service that serves as the knowledge access layer for AI agents working with Obsidian vaults. CogniVault provides Obsidian-compatible file CRUD, continuous vector indexing into Qdrant, hybrid retrieval (semantic + lexical + RRF fusion), structured context pack assembly, multi-format support (Markdown, PDF, Canvas, Excalidraw, CSV, images), and per-user vault sync via obsidian-headless — all in a single Docker-deployable container serving multiple users. Agents interact via standard REST or TOON (Token-Oriented Object Notation) for ~40% token savings.

## Core Value

AI agents can find and retrieve the right knowledge from an Obsidian vault in under one second, with high precision across mixed Russian/English content, exact technical terms, and freeform metadata.

## Requirements

### Validated

- ✓ REST API for Obsidian note/file CRUD operations — v1.0
- ✓ Frontmatter read/write for freeform YAML metadata — v1.0
- ✓ Built-in indexing subsystem with filesystem polling change detection — v1.0
- ✓ Markdown-aware chunking with section hierarchy preservation — v1.0
- ✓ Multi-format indexing: PDF, Canvas, Excalidraw, CSV, image metadata — v1.0
- ✓ Qdrant vector storage with rich payload schema — v1.0
- ✓ SQLite-based index state tracking — v1.0
- ✓ Semantic search via Qdrant with OpenAI embeddings — v1.0
- ✓ Keyword/lexical search for exact terms and mixed-language queries — v1.0
- ✓ Hybrid retrieval with RRF fusion — v1.0
- ✓ Metadata filtering: project, type, tags, status, folder path — v1.0
- ✓ Context pack assembly with configurable token budget — v1.0
- ✓ TOON content negotiation (request + response) — v1.0
- ✓ API key authentication — v1.0
- ✓ Async write path with automatic reindexing — v1.0
- ✓ Stale vector cleanup on reindex — v1.0
- ✓ Manual reindex endpoints (full, path, folder) — v1.0
- ✓ Path traversal protection — v1.0
- ✓ Structured JSON logs, Prometheus metrics, OpenTelemetry tracing — v1.0
- ✓ Docker deployment with Qdrant sidecar — v1.0
- ✓ Health and readiness endpoints — v1.0
- ✓ Prometheus + Grafana monitoring dashboards — v1.0
- ✓ Single-container multi-tenant with API key → user_id registry — v2.0
- ✓ Per-user vault sync via obsidian-headless (`ob sync --continuous`) — v2.0
- ✓ CLI user lifecycle management (`add-user`, `remove-user`, `list-users`) — v2.0
- ✓ Per-user OpenAI API keys for embeddings — v2.0
- ✓ Multi-tenant observability: metrics with user_id labels, per-user Grafana filtering — v2.0

### Active

(None — planning next milestone)

### Deferred

- Cross-encoder reranking (Cohere/BGE) for top-K precision (RET-04, deferred from v1.0)
- Embedding model version tracking and upgrade path
- Read-only vs write/admin role separation in auth
- API key rotation without downtime (OPS-01)
- Per-user resource usage monitoring (OPS-03)

### Out of Scope

- Wikilink/backlink graph navigation — agents use retrieval, not graph traversal
- Real-time WebSocket push — agents poll or use request/response
- Obsidian plugin — this is a standalone server-side service
- UI/dashboard — admin via REST endpoints and Grafana
- Aggressive query caching — Qdrant is fast enough at this scale
- Per-user containers — architectural pivot to single-container multi-tenant (simpler, lower resource usage)
- VNC/GUI access to Obsidian — headless sync only, no browser-based editing
- Caddy reverse proxy — single container, single port
- Kubernetes / Helm — not justified for single-server deployment at 5-20 users
- Cross-user search — requires permission model, defer to v3+

## Context

**Shipped:** v2.0 Multi-User on 2026-03-14
**Codebase:** 16,543 LOC TypeScript across 330 files
**Tech stack:** Fastify 5, TypeBox, Drizzle ORM + SQLite, Qdrant, OpenAI embeddings, prom-client, @opentelemetry/sdk, pdfjs-dist, PapaParse, @toon-format/toon, Commander.js, obsidian-headless, tini
**Deployment:** Docker Compose (CogniVault + Qdrant + Prometheus + Grafana), single container multi-tenant

**Vault characteristics:**
- 500-5,000 notes per user, growing
- Freeform structure and frontmatter
- 80%+ Russian content, mixed with English technical terms
- Synced via Obsidian Sync (obsidian-headless `ob sync --continuous`)
- Contains .md, PDFs, Canvas, Excalidraw, CSV, images

**Agent ecosystem:** 1-3 concurrent agents per user, framework-agnostic REST/TOON interface
**User scale:** 5-20 users, single server deployment

## Constraints

- **Deployment**: Single Docker container + Qdrant sidecar, self-hosted
- **Latency**: < 1 second for hybrid search requests
- **Consistency**: Vault on disk is source of truth; Qdrant must not contain stale vectors
- **Sync method**: obsidian-headless `ob sync --continuous` per user
- **Token budget**: Context packs default ~32K tokens, configurable per request
- **Concurrency**: 1-3 simultaneous agent connections per user
- **Embedding**: OpenAI text-embedding-3 per user (user provides own key), must be swappable to local models
- **State storage**: Per-user SQLite for index state — atomic, fast lookups, zero config
- **Tenant isolation**: Qdrant payload filtering by user_id; separate SQLite per user

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Replace existing API entirely | Clean slate allows unified design | ✓ Good — clean architecture |
| SQLite for index state | ACID, fast, no external dependency | ✓ Good — reliable, zero config |
| TOON content negotiation | Reduces agent token usage ~40% | ✓ Good — works in both directions |
| Async write-then-index | Decouples write latency from embedding | ✓ Good — responsive writes |
| Filesystem polling (not inotify) | Obsidian Sync compatible | ✓ Good — reliable change detection |
| RRF fusion without reranking | Simpler, good enough at scale | ✓ Good — deferred reranking |
| No query caching | Qdrant latency acceptable at scale | ✓ Good — avoided complexity |
| Per-instance prom-client Registry | Prevents test pollution | ✓ Good — clean test isolation |
| pdfjs-dist for PDF extraction | Mature, no native deps | ✓ Good — works in Docker |
| Heading-aware chunking | Preserves section context | ✓ Good — high retrieval quality |
| Single-container multi-tenant | Simpler than per-user containers | ✓ Good — lower resource usage, one process |
| obsidian-headless for sync | Headless CLI, no GUI needed | ✓ Good — works in Docker |
| fs.watch on parent dir | Detects atomic rename-over for registry | ✓ Good — reliable hot-reload |
| Qdrant payload filtering (not collections) | Qdrant recommends; better performance | ✓ Good — simple, scalable |
| Per-user SQLite databases | True data isolation without complexity | ✓ Good — clean separation |
| tini as PID 1 | Signal forwarding to ob sync processes | ✓ Good — clean shutdown |
| Direct event emission in registry | Reliable without fs.watch timing | ✓ Good — immediate propagation |
| Vault-path retry loop in indexer | ob sync creates dir asynchronously | ✓ Good — handles race condition |

---
*Last updated: 2026-03-14 after v2.0 milestone*
