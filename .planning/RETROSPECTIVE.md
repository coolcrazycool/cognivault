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

## Milestone: v2.0 — Multi-User

**Shipped:** 2026-03-14
**Phases:** 8 | **Plans:** 19 | **Timeline:** 1 day

### What Was Built
- Single-container multi-tenant architecture: API key → user_id registry with hot-reload
- Per-user data isolation: tenant-scoped Qdrant filtering + separate SQLite databases
- CLI user lifecycle: `cognivault-ctl add-user/remove-user/list-users` with Obsidian credential provisioning
- Per-user vault sync: `ob sync --continuous` child processes with exponential backoff
- Multi-tenant observability: all metrics carry user_id labels, Grafana per-user filtering
- Production Docker: tini PID 1, obsidian-headless, HEALTHCHECK, end-to-end isolation tests

### What Worked
- Milestone audit (Phase 21-22) caught real gaps: missing event propagation, vault-path race, uncommitted OBS-03 fix
- Per-user SQLite + Qdrant payload filtering gave true isolation without architectural complexity
- Registry hot-reload pattern (fs.watch + SHA-256 hash + atomic write) proved reliable
- Gap closure phases (21, 22) efficiently addressed audit findings without over-scoping
- Documentation-only Phase 22 verified all 19 requirements with zero code changes needed

### What Was Inefficient
- Phase 19 plan 03 (app.ts registration) was trivially small — could have been merged into plan 02
- Vault symlink bug (macOS /tmp → /private/tmp) discovered only during Phase 22 verification, not during Phase 18-19 development
- SYNC_STATUS always 'unknown' in CLI — design decision but could confuse operators
- obsidian-headless beta concerns listed as blockers persisted through entire milestone despite being resolved early

### Patterns Established
- `fp()` dependency declarations for plugin ordering (registry → auth → pipeline → indexer → sync)
- Per-user Map pattern: embedders Map, indexers Map, SQLite Map — consistent lifecycle via registry events
- Direct event emission in data layer (not relying on fs.watch) for reliable lifecycle propagation
- Retry loop with bounded timeout for async resource availability (vault directory creation)

### Key Lessons
1. VaultManager.initialize() must be called before any path operations — realpath resolution is not optional on macOS
2. Direct event emission in the mutating method is more reliable than watching for file changes
3. Gap closure phases are efficient when scoped to audit findings — don't re-plan the whole milestone
4. Documentation-only verification phases have legitimate value: they surface bugs (symlink issue) and force evidence gathering
5. prom-client .remove() is essential for tenant cleanup — .set(0) leaves stale label combinations

### Cost Observations
- Model mix: ~20% opus (orchestration), ~80% sonnet (execution/verification/research)
- 8 phases completed in a single day
- Notable: verification closure phase discovered and fixed a real bug despite being "documentation only"

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Timeline | Phases | Key Change |
|-----------|----------|--------|------------|
| v1.0 | 3 days | 14 | Initial milestone — established GSD workflow patterns |
| v2.0 | 1 day | 8 | Gap closure phases for audit-driven verification |

### Cumulative Quality

| Milestone | Tests | LOC | Files |
|-----------|-------|-----|-------|
| v1.0 | 434 | 12,704 | 232 |
| v2.0 | 519 | 16,543 | 330 |

### Top Lessons (Verified Across Milestones)

1. Bottom-up data-flow ordering prevents dependency blockers
2. Mock external services in integration tests — live calls break CI/fresh environments
3. Milestone audit before completion catches real integration gaps — verified in both v1.0 and v2.0
4. Gap closure phases efficiently address audit findings without over-scoping
