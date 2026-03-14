# Milestones

## v2.0 Multi-User (Shipped: 2026-03-14)

**Phases completed:** 8 phases, 19 plans
**Timeline:** 1 day (2026-03-14)
**Stats:** 330 files changed, 16,543 LOC TypeScript
**Requirements:** 19/19 satisfied

**Key accomplishments:**
1. Single-container multi-tenant architecture: one CogniVault process serves all users via API key → user_id registry with hot-reload
2. Per-user data isolation: tenant-scoped Qdrant filtering and separate SQLite databases prevent cross-tenant access
3. CLI user lifecycle management (`cognivault-ctl add-user/remove-user/list-users`) with inline Obsidian credential provisioning
4. Per-user vault sync via `ob sync --continuous` child processes with exponential backoff and lock file cleanup
5. Multi-tenant observability: all Prometheus metrics carry user_id labels, Grafana dashboards filter by user
6. Production Docker image with tini as PID 1, obsidian-headless installed, and end-to-end tenant isolation tests

**Known gaps:**
- None — all 19 requirements verified across 3 sources (code, tests, verification docs)

---

## v1.0 MVP (Shipped: 2026-03-13)

**Phases completed:** 14 phases, 37 plans
**Timeline:** 3 days (2026-03-10 → 2026-03-13)
**Stats:** 223 commits, 232 files, 12,704 LOC TypeScript

**Key accomplishments:**
1. Full Obsidian vault CRUD API with atomic writes and path traversal protection
2. Continuous markdown indexing with heading-aware chunking into Qdrant vectors
3. Semantic, lexical, and hybrid (RRF) search with tag/project/folder filtering
4. Token-budgeted context pack assembly for AI agent consumption
5. Multi-format indexing: PDF text extraction, Canvas/Excalidraw parsing, CSV row chunking, image metadata
6. TOON content negotiation for ~40% token savings alongside JSON
7. Full observability stack: Prometheus + Grafana dashboards, OpenTelemetry tracing, structured logging

**Known gaps:**
- RET-04: Cross-encoder reranking deferred to v2 by design
- Semantic search folder filter uses post-filter (documented trade-off)
- Reindex job status transitions before pipeline queue fully drains (documented)

---

