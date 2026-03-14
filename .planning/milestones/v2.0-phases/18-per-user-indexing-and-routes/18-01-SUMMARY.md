---
phase: 18-per-user-indexing-and-routes
plan: 01
subsystem: api
tags: [prom-client, metrics, embedding, qdrant, multi-tenant, fastify-plugin]

# Dependency graph
requires:
  - phase: 17-data-isolation
    provides: per-user DB plugin, tenant Qdrant client, user registry with events
provides:
  - per-user metrics with user_id labels and removeUserMetrics cleanup
  - per-user EmbeddingProvider Map via getUserEmbedder(userId)
  - qdrant plugin decoupled from global embedder (uses DIMENSION_MAP)
  - getUserDbById(userId) fastify-level DB accessor for pipeline
  - OPENAI_API_KEY made optional in config
affects: [18-02-pipeline, 18-03-routes]

# Tech tracking
tech-stack:
  added: []
  patterns: [per-user-embedder-map, user-id-metric-labels, dimension-map-lookup]

key-files:
  created:
    - src/plugins/__tests__/embedding.test.ts
  modified:
    - src/plugins/metrics.ts
    - src/plugins/embedding.ts
    - src/plugins/qdrant.ts
    - src/plugins/db.ts
    - src/config.ts
    - src/app.ts
    - src/features/search/routes.ts
    - src/features/context/routes.ts

key-decisions:
  - "Qdrant uses DIMENSION_MAP[config.EMBEDDING_MODEL] instead of fastify.embedder.dimensions"
  - "Embedding plugin keeps name 'embedder' in fp() for Fastify dependency graph compatibility"
  - "No validate() call on per-user embedder creation (skip API round-trip, fail on first use)"

patterns-established:
  - "Per-user resource Map pattern: Map<userId, Resource> with registry event lifecycle"
  - "Metric user_id labels: all per-user metrics use user_id label, removeUserMetrics cleans up on user removal"

requirements-completed: [OBS-01]

# Metrics
duration: 7min
completed: 2026-03-14
---

# Phase 18 Plan 01: Plugin Refactoring Summary

**Per-user metrics with user_id labels, per-user EmbeddingProvider Map, qdrant decoupled from global embedder, getUserDbById accessor**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-14T09:52:05Z
- **Completed:** 2026-03-14T09:59:13Z
- **Tasks:** 2
- **Files modified:** 13

## Accomplishments
- All per-user metrics carry user_id labels with removeUserMetrics cleanup helper
- Embedding plugin manages Map<userId, EmbeddingProvider> with full registry event lifecycle (add/remove/update)
- Qdrant plugin uses DIMENSION_MAP for collection creation, no longer depends on embedder plugin
- getUserDbById(userId) provides fastify-level DB access for pipeline use outside request context
- OPENAI_API_KEY made optional since all embedding uses per-user keys
- Search and context routes updated to use getUserEmbedder(request.user.userId)

## Task Commits

Each task was committed atomically:

1. **Task 1: Refactor metrics and embedding plugins** - `2e5813d` (test: RED), `5e874dd` (feat: GREEN)
2. **Task 2: Decouple qdrant, optional OPENAI_API_KEY, getUserDbById** - `2a31bfb` (feat)

_Note: TDD task had RED + GREEN commits_

## Files Created/Modified
- `src/plugins/metrics.ts` - Added user_id labels to all per-user metrics, contextPacks counter, removeUserMetrics helper
- `src/plugins/embedding.ts` - Replaced global embedder with per-user Map, registry event listeners
- `src/plugins/qdrant.ts` - Uses DIMENSION_MAP instead of fastify.embedder.dimensions, removed embedder dependency
- `src/plugins/db.ts` - Added getUserDbById fastify-level accessor
- `src/config.ts` - OPENAI_API_KEY made optional
- `src/app.ts` - Reordered plugin registration (qdrant before embedding)
- `src/features/search/routes.ts` - Uses getUserEmbedder(request.user.userId)
- `src/features/context/routes.ts` - Uses getUserEmbedder(request.user.userId)
- `src/plugins/__tests__/metrics.test.ts` - Updated with user_id label tests, contextPacks, removeUserMetrics
- `src/plugins/__tests__/embedding.test.ts` - New test file for per-user embedder lifecycle
- `src/plugins/__tests__/qdrant.test.ts` - Removed embedder dependency from tests
- `src/plugins/__tests__/db.test.ts` - Added getUserDbById tests
- `src/features/search/__tests__/routes.test.ts` - Updated mock from embedder to getUserEmbedder
- `src/features/context/__tests__/routes.test.ts` - Updated mock from embedder to getUserEmbedder

## Decisions Made
- Qdrant uses DIMENSION_MAP[config.EMBEDDING_MODEL] instead of fastify.embedder.dimensions -- decouples qdrant from embedding lifecycle
- Embedding plugin retains fp() name 'embedder' for existing dependency graph compatibility
- No validate() call on per-user embedder creation -- avoids API round-trip, fails naturally on first embed call

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated qdrant plugin and tests in Task 1 instead of Task 2**
- **Found during:** Task 1 (metrics and embedding refactor)
- **Issue:** Removing fastify.embedder declaration broke qdrant plugin which depended on it, preventing app boot and Task 1 metrics integration tests from passing
- **Fix:** Moved qdrant refactoring (DIMENSION_MAP, removed embedder dependency) from Task 2 into Task 1
- **Files modified:** src/plugins/qdrant.ts, src/plugins/__tests__/qdrant.test.ts, src/app.ts
- **Verification:** All qdrant tests pass, metrics integration tests pass
- **Committed in:** 5e874dd (Task 1 commit)

**2. [Rule 3 - Blocking] Updated search and context route tests for getUserEmbedder**
- **Found during:** Task 2 (typecheck and full test suite)
- **Issue:** Search and context route tests decorated fastify.embedder which no longer exists in type declarations
- **Fix:** Updated test setups to use getUserEmbedder decorator instead
- **Files modified:** src/features/search/__tests__/routes.test.ts, src/features/context/__tests__/routes.test.ts
- **Verification:** All 462 tests pass, typecheck clean
- **Committed in:** 2a31bfb (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both auto-fixes were necessary cascading changes from removing global embedder. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All five plugins refactored and ready for per-user indexing pipeline (Plan 02)
- Route migration (Plan 03) can proceed with getUserEmbedder pattern already in place
- 462 tests passing, typecheck clean

---
*Phase: 18-per-user-indexing-and-routes*
*Completed: 2026-03-14*
