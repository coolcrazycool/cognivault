# Milestones

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

