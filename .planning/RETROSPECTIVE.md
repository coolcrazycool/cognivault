# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — MVP

**Shipped:** 2026-03-13
**Phases:** 14 | **Plans:** 37 | **Timeline:** 3 days

### What Was Built
- Full Obsidian vault REST API with CRUD, path security, and frontmatter operations
- Continuous indexing pipeline: markdown chunking, OpenAI embeddings, Qdrant vectors
- Multi-format support: PDF, Canvas, Excalidraw, CSV, image metadata
- Three search modes: semantic, lexical, hybrid (RRF fusion)
- Token-budgeted context pack assembly for AI agents
- TOON content negotiation for ~40% token savings
- Full observability: Prometheus + Grafana dashboards, OpenTelemetry tracing, structured logging
- Docker Compose deployment with CogniVault + Qdrant + Prometheus + Grafana

### What Worked
- Bottom-up phase ordering by data flow dependencies eliminated cross-phase blockers
- Wave-based parallel execution of independent plans within phases
- GSD workflow kept planning/execution/verification in tight cycles
- TypeBox schemas provided both route validation and OpenAPI generation from one source
- Fastify plugin encapsulation kept features isolated and testable

### What Was Inefficient
- Phases 12-14 added post-audit — could have been anticipated in initial roadmap
- STATE.md accumulated stale position data (progress % stuck at 19%, focus stuck on Phase 6)
- Some test mocks had to be patched after VaultManager API changed (getter addition)
- Docker volume permissions issue (USER node vs root-owned mount) discovered only during manual testing

### Patterns Established
- Zod for config validation at startup, TypeBox for route schemas
- Feature-based directory structure with colocated tests
- `vi.mock('openai')` and `vi.mock('@qdrant/js-client-rest')` in all `buildApp()` test files
- `node --env-file=.env` for test scripts (not `.bin/vitest` shim)
- Per-instance prom-client Registry to prevent test pollution
- `handleVaultError` returns `FastifyReply` to prevent Fastify double-response

### Key Lessons
1. Always mock external API calls in tests that call `buildApp()` — embedding plugin validates at registration time
2. Docker volume permissions must be set before `USER` directive — volumes mount as root by default
3. Milestone audit before completion catches real integration gaps (folder filter, reindex timing)
4. Swagger `text/toon` examples need actual TOON format strings, not copied JSON schemas

### Cost Observations
- Model mix: ~30% opus (orchestration), ~70% sonnet (execution/verification)
- 223 commits across 3 days
- Notable: parallel plan execution within waves significantly reduced wall-clock time

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Timeline | Phases | Key Change |
|-----------|----------|--------|------------|
| v1.0 | 3 days | 14 | Initial milestone — established GSD workflow patterns |

### Cumulative Quality

| Milestone | Tests | LOC | Files |
|-----------|-------|-----|-------|
| v1.0 | 434 | 12,704 | 232 |

### Top Lessons (Verified Across Milestones)

1. Bottom-up data-flow ordering prevents dependency blockers
2. Mock external services in integration tests — live calls break CI/fresh environments
