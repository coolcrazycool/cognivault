---
phase: 04-index-state-+-change-detection
plan: 03
subsystem: api
tags: [fastify, typebox, drizzle-orm, sqlite, health-check, readiness]

# Dependency graph
requires:
  - phase: 04-01
    provides: fastify.db (BetterSQLite3Database) plugin decoration
  - phase: 04-02
    provides: fastify.indexer (VaultIndexer) plugin with isIndexing property
  - phase: 02-03
    provides: original /ready endpoint with vault check
provides:
  - Extended /ready endpoint with db health check (SELECT 1) and indexing boolean
  - TypeBox ReadyResponseSchema with required checks.db and indexing fields
  - Docker/K8s-compatible readiness probe that passes during active index scan
affects: [05-search, any consumer of /ready endpoint, Docker health probe configuration]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Drizzle sql tag used for raw query health checks (fastify.db.get(sql`SELECT 1`))"
    - "Readiness = vault AND db; indexing field is informational only (never gates 200)"

key-files:
  created: []
  modified:
    - src/features/health/schemas.ts
    - src/features/health/routes.ts
    - src/features/health/__tests__/routes.test.ts

key-decisions:
  - "DB health check uses drizzle sql`SELECT 1` via fastify.db.get() — synchronous, minimal overhead"
  - "Ready condition requires vault AND db; indexing is informational only (200 returned even when indexing:true)"
  - "checks.db made required in schema alongside checks.vault (removed Type.Optional wrapper)"

patterns-established:
  - "Health check pattern: try/catch around resource access, boolean flag, ok|error string in checks object"

requirements-completed: [IDX-01, IDX-06]

# Metrics
duration: 5min
completed: 2026-03-10
---

# Phase 4 Plan 03: Extended Readiness Endpoint Summary

**Readiness endpoint extended with drizzle SQL health check (SELECT 1) and VaultIndexer.isIndexing status; Docker probes pass during active index scan**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-10T20:03:00Z
- **Completed:** 2026-03-10T20:08:00Z
- **Tasks:** 1 (TDD: test + feat commits)
- **Files modified:** 3

## Accomplishments
- Added `checks.db: 'ok' | 'error'` to /ready response via `fastify.db.get(sql\`SELECT 1\`)`
- Added `indexing: boolean` field from `fastify.indexer?.isIndexing ?? false`
- Updated ready condition: `vaultOk && dbOk` (both must pass for `status: 'ready'`)
- Indexing is informational only — endpoint always returns 200 when vault+db are healthy
- Updated TypeBox schema: checks is now required (not Optional), db field added, indexing Boolean added
- Added 4 new test cases covering db check, indexing field, 200-during-indexing, and ready condition logic

## Task Commits

Each task was committed atomically (TDD pattern):

1. **RED: Failing tests** - `f4f3a35` (test)
2. **GREEN: Implementation** - `70e8b9c` (feat)

## Files Created/Modified
- `src/features/health/schemas.ts` — Added `db` to checks object, added `indexing: Type.Boolean()`, made checks required
- `src/features/health/routes.ts` — Added DB health check via `sql\`SELECT 1\``, added indexing from `fastify.indexer?.isIndexing`, updated ready condition
- `src/features/health/__tests__/routes.test.ts` — Added 4 new tests + set `COGNIVAULT_DATA_DIR` env var for DB setup in tests

## Decisions Made
- DB health check uses drizzle `sql` tag with `fastify.db.get()` (synchronous BetterSQLite3) — no async needed
- Indexing field never gates readiness (200 returned whether indexing is true or false) per plan specification
- Test for COGNIVAULT_DATA_DIR set to temp dir so dbPlugin can create its data directory during test suite

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- /ready endpoint now reports full service health: vault + DB + indexing status
- Phase 04 plans 01, 02, 03 all complete — index state + change detection phase is done
- Ready for Phase 05 (search/embedding features) which will use the indexer change events

---
*Phase: 04-index-state-+-change-detection*
*Completed: 2026-03-10*
