---
phase: 11-observability-admin
plan: 02
subsystem: api
tags: [fastify, typebox, sqlite, drizzle-orm, reindex, admin]

# Dependency graph
requires:
  - phase: 04-index-state-change-detection
    provides: VaultIndexer with start/stop/isIndexing and FileChangeEvent emission
  - phase: 11-observability-admin
    provides: plan 01 context and metrics plugin

provides:
  - POST /api/admin/reindex endpoint accepting full, path, folder scopes
  - GET /api/admin/reindex/status endpoint returning job progress
  - ReindexService with in-memory job map and scope dispatch
  - TypeBox schemas for reindex request/response types

affects: [admin-clients, operator-tools, embedding-model-upgrade-workflows]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Admin routes use shared service instance on plugin scope to preserve in-memory job map
    - Scope union discriminated by TypeBox Type.Union of literal-tagged objects
    - 409 guard: service throws with statusCode/code, route catches and returns structured error

key-files:
  created:
    - src/features/admin/schemas.ts
    - src/features/admin/service.ts
    - src/features/admin/routes.ts
    - src/features/admin/__tests__/service.test.ts
    - src/features/admin/__tests__/routes.test.ts
  modified:
    - src/app.ts

key-decisions:
  - "ReindexService instantiated once per plugin scope (not per-request) to preserve in-memory job map"
  - "Full reindex: stop() then start() the VaultIndexer (triggers full scan and event emission)"
  - "Path/folder scopes emit synthetic 'updated' FileChangeEvent(s) directly via indexer.emit()"
  - "409 guard uses statusCode on thrown Error; route catches and returns structured error body"
  - "Formatter (Biome) strips import order changes — adminRoutes import added manually after format step"

patterns-established:
  - "Admin route plugin: shared service instance on plugin scope, no per-request instantiation"
  - "Service error signaling: throw Error with statusCode + code, route catch maps to HTTP response"

requirements-completed: [IDX-13]

# Metrics
duration: 5min
completed: 2026-03-12
---

# Phase 11 Plan 02: Admin Reindex API Summary

**POST /api/admin/reindex + GET /api/admin/reindex/status with full/path/folder scope dispatch, in-memory job tracking, 409 conflict guard, and auth enforcement**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-12T15:34:08Z
- **Completed:** 2026-03-12T15:38:50Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Admin reindex API with three scope variants: full vault restart, single path synthetic event, folder batch events
- In-memory job map in ReindexService tracks status, filesProcessed, totalFiles, errors per job
- Full auth enforcement (no skipAuth) — 401 returned without valid API key
- 409 Conflict when full reindex is already in progress (isIndexing guard)
- 17 tests total: 7 service unit tests + 10 route integration tests

## Task Commits

Each task was committed atomically:

1. **Task 1: Reindex schemas and service** - `77d1662` (feat)
2. **Task 2: Admin reindex routes and registration** - `2b98138` (feat)

**Plan metadata:** (docs commit below)

_Note: TDD tasks have test + implementation in same commit (service.test.ts included in Task 1 commit)_

## Files Created/Modified

- `src/features/admin/schemas.ts` - TypeBox schemas for reindex request/response (union of full/path/folder shapes)
- `src/features/admin/service.ts` - ReindexService class with createJob/getJob, in-memory Map, scope dispatch
- `src/features/admin/routes.ts` - POST /reindex and GET /reindex/status Fastify plugin handlers
- `src/features/admin/__tests__/service.test.ts` - 7 unit tests for ReindexService job creation and retrieval
- `src/features/admin/__tests__/routes.test.ts` - 10 route integration tests for all HTTP behaviors
- `src/app.ts` - Added adminRoutes import and registration with /api/admin prefix

## Decisions Made

- ReindexService instantiated once per plugin scope (shared across requests) to preserve in-memory job map — this is the same approach as ContextService per-request but inverted, since job persistence requires a single instance
- Full reindex uses indexer.stop() + indexer.start() which triggers a complete vault rescan; the job starts in 'running' state and stays there (the indexer handles progress internally via events)
- Path and folder scopes emit synthetic FileChangeEvent('updated') directly via indexer.emit(); they complete synchronously and set status='completed' immediately
- The 409 guard is implemented by throwing an Error with statusCode=409 in the service, then catching in the route to return a structured error body (matching existing error response shape)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added OPENAI_API_KEY to test env vars**
- **Found during:** Task 2 (routes test execution)
- **Issue:** routes.test.ts imported auth plugin which triggers config.ts parsing; config schema requires OPENAI_API_KEY but test didn't set it
- **Fix:** Added `process.env.OPENAI_API_KEY = 'test-openai-key'` to routes.test.ts header
- **Files modified:** src/features/admin/__tests__/routes.test.ts
- **Verification:** All 10 route tests pass after fix
- **Committed in:** 2b98138 (Task 2 commit)

**2. [Rule 3 - Blocking] Removed unused mock variables from service.test.ts**
- **Found during:** Task 2 (pnpm check / biome lint)
- **Issue:** mockDbSelect, mockDbSelectFrom, mockDbSelectFromWhere declared but not used — Biome lint errors
- **Fix:** Removed three unused const declarations; mockDb already uses inline vi.fn() chain
- **Files modified:** src/features/admin/__tests__/service.test.ts
- **Verification:** Biome check passes on admin/ directory
- **Committed in:** 2b98138 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 missing critical, 1 blocking)
**Impact on plan:** Both fixes necessary for correctness and build quality. No scope creep.

## Issues Encountered

- Biome formatter ran during initial check and reset app.ts (stripping the new import alphabetically). This is expected behavior — imports must be re-added after running `biome format --write src/`. Resolved by running format only on the admin directory and adding app.ts changes last.

## User Setup Required

None - no external service configuration required. Admin endpoints use the existing COGNIVAULT_API_KEY authentication.

## Next Phase Readiness

- Admin reindex API is complete and production-ready
- POST /api/admin/reindex triggers full, path, and folder reindexes with 202 Accepted pattern
- GET /api/admin/reindex/status provides job progress polling
- Phase 11 plan 02 complete — phase 11 continues with remaining observability/admin plans

---
*Phase: 11-observability-admin*
*Completed: 2026-03-12*

## Self-Check: PASSED

- src/features/admin/schemas.ts: FOUND
- src/features/admin/service.ts: FOUND
- src/features/admin/routes.ts: FOUND
- src/features/admin/__tests__/routes.test.ts: FOUND
- src/features/admin/__tests__/service.test.ts: FOUND
- Commit 77d1662: FOUND
- Commit 2b98138: FOUND
