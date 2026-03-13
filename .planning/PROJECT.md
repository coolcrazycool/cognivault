# CogniVault

## What This Is

A self-hosted REST API service that serves as the knowledge access layer for AI agents working with Obsidian vaults. CogniVault provides Obsidian-compatible file CRUD, continuous vector indexing into Qdrant, hybrid retrieval (semantic + lexical + RRF fusion), structured context pack assembly, and multi-format support (Markdown, PDF, Canvas, Excalidraw, CSV, images) — all in a single Docker-deployable service. Agents interact via standard REST or TOON (Token-Oriented Object Notation) for ~40% token savings.

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

### Active

- [ ] Multi-user deployment: per-user CogniVault+Obsidian container with shared Qdrant
- [ ] Containerized Obsidian with VNC access for visual vault management
- [ ] Obsidian Sync integration for per-user vault synchronization
- [ ] Per-user API key authentication with tenant isolation in Qdrant
- [ ] Management CLI (cognivault-ctl) for user lifecycle management
- [ ] Shared metrics infrastructure (Prometheus + Grafana) across all users

### Deferred

- Cross-encoder reranking (Cohere/BGE) for top-K precision (RET-04, deferred from v1.0)
- Multi-vault support per user — single vault per user sufficient for now
- Embedding model version tracking and upgrade path
- Read-only vs write/admin role separation in auth

### Out of Scope

- Wikilink/backlink graph navigation — agents use retrieval, not graph traversal
- Real-time WebSocket push — agents poll or use request/response
- Obsidian plugin — this is a standalone server-side service
- Multi-user authentication — local agents only, API key sufficient
- UI/dashboard — admin via REST endpoints and Grafana
- Aggressive query caching — Qdrant is fast enough at this scale

## Context

**Shipped:** v1.0 MVP on 2026-03-13
**Codebase:** 12,704 LOC TypeScript across 232 files
**Tech stack:** Fastify 5, TypeBox, Drizzle ORM + SQLite, Qdrant, OpenAI embeddings, prom-client, @opentelemetry/sdk, pdfjs-dist, PapaParse, @toon-format/toon
**Deployment:** Docker Compose (CogniVault + Qdrant + Prometheus + Grafana)

**Vault characteristics:**
- 500-5,000 notes, growing
- Freeform structure and frontmatter
- 80%+ Russian content, mixed with English technical terms
- Synced via Obsidian Sync
- Contains .md, PDFs, Canvas, Excalidraw, CSV, images

**Agent ecosystem:** 1-3 concurrent agents, framework-agnostic REST/TOON interface

## Constraints

- **Deployment**: Single Docker-deployable service + Qdrant sidecar, self-hosted
- **Latency**: < 1 second for hybrid search requests
- **Consistency**: Vault on disk is source of truth; Qdrant must not contain stale vectors
- **Sync method**: Obsidian Sync — filesystem polling + content hashing
- **Token budget**: Context packs default ~32K tokens, configurable per request
- **Concurrency**: 1-3 simultaneous agent connections
- **Embedding**: Start with OpenAI text-embedding-3, must be swappable to local models
- **State storage**: SQLite for index state — atomic, fast lookups, zero config

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Replace existing API entirely | Clean slate allows unified design | ✓ Good — clean architecture |
| SQLite for index state | ACID, fast, no external dependency | ✓ Good — reliable, zero config |
| TOON content negotiation | Reduces agent token usage ~40% | ✓ Good — works in both directions |
| Async write-then-index | Decouples write latency from embedding | ✓ Good — responsive writes |
| Filesystem polling (not inotify) | Obsidian Sync compatible | ✓ Good — reliable change detection |
| RRF fusion without reranking | Simpler, good enough for v1 | ✓ Good — deferred reranking to v2 |
| No query caching | Qdrant latency acceptable at scale | ✓ Good — avoided complexity |
| Per-instance prom-client Registry | Prevents test pollution | ✓ Good — clean test isolation |
| pdfjs-dist for PDF extraction | Mature, no native deps | ✓ Good — works in Docker |
| Heading-aware chunking | Preserves section context | ✓ Good — high retrieval quality |

## Current Milestone: v2.0 Multi-User

**Goal:** Transform CogniVault from a single-user service into a multi-user platform where each user gets their own CogniVault+Obsidian container with VNC access, sharing a common Qdrant and monitoring infrastructure.

**Target features:**
- Per-user container (CogniVault + Obsidian + VNC) with Obsidian Sync
- Tenant-isolated Qdrant (shared instance, per-user data separation via API key)
- Management CLI for user lifecycle (add, remove, list)
- Shared Prometheus + Grafana with per-user metrics labeling

---
*Last updated: 2026-03-13 after v2.0 milestone start*
