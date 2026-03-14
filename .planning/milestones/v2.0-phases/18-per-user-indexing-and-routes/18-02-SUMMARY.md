---
phase: 18-per-user-indexing-and-routes
plan: 02
subsystem: api
tags: [vault-indexer, pipeline, multi-tenant, pqueue, per-user, fastify-plugin]

# Dependency graph
requires:
  - phase: 18-per-user-indexing-and-routes
    plan: 01
    provides: per-user DB plugin (getUserDbById), per-user embedder (getUserEmbedder), tenant Qdrant (createTenantQdrant), per-user metrics with removeUserMetrics
provides:
  - per-user VaultIndexer manager with Map<userId, { indexer, queue, vault }>
  - per-user PQueue (concurrency 3, timeout 120s) per indexer entry
  - processFileChanges(userId, events) for pipeline event dispatch
  - registry lifecycle hooks (user-added/user-removed) for indexer management
  - all pipeline processing with userId-scoped resources and metrics
affects: [18-03-routes, admin-reindex]

# Tech tracking
tech-stack:
  added: []
  patterns: [per-user-indexer-map, per-user-pqueue, user-scoped-chunk-ids, tenant-qdrant-pipeline]

key-files:
  created: []
  modified:
    - src/plugins/indexer.ts
    - src/plugins/pipeline.ts
    - src/plugins/__tests__/indexer.test.ts
    - src/plugins/__tests__/pipeline.test.ts
    - src/features/admin/service.ts
    - src/features/admin/routes.ts
    - src/features/admin/__tests__/service.test.ts

key-decisions:
  - "Pipeline does NOT depend on indexer; indexer depends on pipeline via processFileChanges"
  - "Queue depth gauge update in finally block of each task (PQueue events lack userId)"
  - "Admin reindex service updated to use processFileChanges instead of indexer.emit for path/folder scope"

patterns-established:
  - "Per-user indexer Map: fastify.indexers.get(userId) returns { indexer, queue, vault }"
  - "Pipeline accesses per-user vault via fastify.indexers.get(userId).vault (no separate VaultManager creation)"
  - "All pipeline metrics carry { user_id: userId } label on every call"

requirements-completed: [OBS-01]

# Metrics
duration: 7min
completed: 2026-03-14
---

# Phase 18 Plan 02: Indexer and Pipeline Rewrite Summary

**Per-user VaultIndexer manager and multi-tenant pipeline with userId-scoped resources, queues, and metrics**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-14T10:02:04Z
- **Completed:** 2026-03-14T10:09:13Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Rewrote indexer plugin as per-user manager with Map<userId, { indexer, queue, vault }>, registry lifecycle, and vault path validation
- Rewrote pipeline plugin for per-user processing: all DB/embedder/Qdrant access via userId, all metrics with user_id label
- Removed @ts-nocheck from pipeline.ts, removed describe.skip from both test files
- Updated admin reindex service to work with new per-user APIs

## Task Commits

Each task was committed atomically:

1. **Task 1: Rewrite indexer plugin as per-user indexer manager** - `bb21520` (feat)
2. **Task 2: Rewrite pipeline plugin for per-user processing** - `8d5670c` (feat)

## Files Created/Modified
- `src/plugins/indexer.ts` - Per-user VaultIndexer manager with Map, registry events, onReady/onClose hooks
- `src/plugins/pipeline.ts` - Multi-tenant pipeline with processFileChanges(userId, events), per-user resource access
- `src/plugins/__tests__/indexer.test.ts` - 9 tests covering init, user-added, user-removed, onClose, vault path validation
- `src/plugins/__tests__/pipeline.test.ts` - 14 tests covering processFileChanges, CRUD events, metrics with user_id, queue depth
- `src/features/admin/service.ts` - Updated to use fastify.indexers Map and processFileChanges instead of old single-indexer API
- `src/features/admin/routes.ts` - Passes request.user.userId to createJob
- `src/features/admin/__tests__/service.test.ts` - Updated mocks for per-user API (12 tests pass)

## Decisions Made
- Pipeline does NOT depend on indexer (reversed dependency: indexer depends on pipeline)
- Queue depth gauge updated in finally block since PQueue events don't carry userId context
- Admin reindex path/folder scope uses processFileChanges instead of indexer.emit for cleaner userId routing

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated admin service for per-user API**
- **Found during:** Task 2 (pipeline rewrite)
- **Issue:** src/features/admin/service.ts referenced old fastify.indexer and fastify.pipelineQueue, causing typecheck failures
- **Fix:** Updated to use fastify.indexers Map, added userId parameter to createJob, path/folder reindex uses processFileChanges
- **Files modified:** src/features/admin/service.ts, src/features/admin/routes.ts, src/features/admin/__tests__/service.test.ts
- **Verification:** pnpm typecheck passes, all 12 admin service tests pass
- **Committed in:** 8d5670c (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Auto-fix necessary to maintain typecheck passing. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Indexer and pipeline fully operational for per-user multi-tenant use
- Ready for Plan 03: wiring into app.ts and route registration
- Admin reindex already updated for the new API

---
*Phase: 18-per-user-indexing-and-routes*
*Completed: 2026-03-14*
