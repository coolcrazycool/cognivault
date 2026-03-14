---
phase: 18-per-user-indexing-and-routes
plan: 03
subsystem: api
tags: [fastify, metrics, multi-tenant, per-user, indexer, pipeline]

requires:
  - phase: 18-01
    provides: per-user embedder (getUserEmbedder), user_id labels on metrics
  - phase: 18-02
    provides: per-user indexer Map, processFileChanges, pipeline plugin

provides:
  - search/context/admin routes wired to per-user embedder and metrics
  - contextPacks counter with user_id label
  - indexer and pipeline plugins re-enabled in app.ts
  - full multi-tenant indexing and route stack operational

affects: [19-vault-sync, 20-docker]

tech-stack:
  added: []
  patterns: [per-user embedder in route handlers, user_id on all metrics]

key-files:
  created: []
  modified:
    - src/features/search/routes.ts
    - src/features/context/routes.ts
    - src/features/health/routes.ts
    - src/app.ts
    - src/features/admin/__tests__/routes.test.ts
    - src/features/context/__tests__/routes.test.ts

key-decisions:
  - "Pipeline registered before indexer in app.ts (indexer depends on pipeline)"
  - "Health readiness endpoint iterates per-user indexers Map for indexing status"

patterns-established:
  - "Extract userId at handler start: const userId = request.user!.userId"
  - "All metric calls include user_id label for per-user observability"

requirements-completed: [OBS-01]

duration: 7min
completed: 2026-03-14
---

# Phase 18 Plan 03: Route Migration and Plugin Re-enablement Summary

**Search/context/admin routes wired to per-user embedder with user_id metrics, indexer and pipeline plugins re-enabled in correct order**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-14T10:11:22Z
- **Completed:** 2026-03-14T10:18:21Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- All search route metrics (searchDuration, searchRequests) carry user_id label
- Context routes track contextPacks counter per user and searchRequests with user_id
- Admin test mocks updated from old global indexer/pipelineQueue to per-user indexers Map
- Indexer and pipeline plugins re-enabled in app.ts with correct registration order
- All TODO Phase 18 comments removed from production code
- Full test suite green (485 tests, 31 files), pnpm check passes

## Task Commits

Each task was committed atomically:

1. **Task 1: Migrate search, context, and admin routes to per-user embedder and metrics** - `3058c3f` (feat)
2. **Task 2: Re-enable indexer and pipeline plugins in app.ts, run full test suite** - `f21f9b6` (feat)

## Files Created/Modified
- `src/features/search/routes.ts` - Added user_id to searchDuration and searchRequests metrics
- `src/features/context/routes.ts` - Added user_id to searchRequests, added contextPacks.inc
- `src/features/health/routes.ts` - Updated indexing status to check per-user indexers Map
- `src/app.ts` - Uncommented indexer/pipeline imports, registered in correct order
- `src/features/admin/__tests__/routes.test.ts` - Updated mocks to use indexers Map and processFileChanges
- `src/features/context/__tests__/routes.test.ts` - Added contextPacks to mock metrics
- `src/features/admin/__tests__/service.test.ts` - Formatting fixes from biome
- `src/plugins/__tests__/indexer.test.ts` - Formatting fixes from biome
- `src/plugins/__tests__/pipeline.test.ts` - Formatting fixes from biome

## Decisions Made
- Pipeline registered before indexer in app.ts (indexer fp() dependencies include 'pipeline')
- Health readiness endpoint iterates fastify.indexers Map to determine if any user's indexer is active

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Updated health routes indexing status check**
- **Found during:** Task 2 (Re-enable plugins)
- **Issue:** Health /ready endpoint had TODO Phase 18 comment and hardcoded `indexing = false`
- **Fix:** Iterate fastify.indexers Map to check if any per-user indexer has isIndexing=true
- **Files modified:** src/features/health/routes.ts
- **Verification:** Health route tests pass (8/8)
- **Committed in:** f21f9b6 (Task 2 commit)

**2. [Rule 3 - Blocking] Fixed biome formatting in formatter-touched files**
- **Found during:** Task 2
- **Issue:** Formatter had reformatted some files but missed indexer.test.ts on first pass
- **Fix:** Re-ran biome format on affected file
- **Files modified:** src/plugins/__tests__/indexer.test.ts
- **Committed in:** f21f9b6 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 missing critical, 1 blocking)
**Impact on plan:** Both fixes necessary for correctness and build passing. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 18 complete: full multi-tenant indexing and route stack operational
- Per-user embedder, indexer, pipeline, metrics all wired and tested
- Ready for Phase 19 (vault sync) or Phase 20 (Docker)

---
*Phase: 18-per-user-indexing-and-routes*
*Completed: 2026-03-14*
