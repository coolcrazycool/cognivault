---
phase: 17-data-isolation
plan: 01
subsystem: database
tags: [qdrant, tenant-isolation, multi-tenant, payload-filter, wrapper-pattern]

# Dependency graph
requires:
  - phase: 16-per-user-container-stack
    provides: user registry with userId, auth plugin setting request.user
provides:
  - TenantQdrantClient wrapper class enforcing user_id filter injection
  - createTenantQdrant factory on Fastify instance
  - purgeUserVectors function for user removal cleanup
  - user_id keyword index on Qdrant collection
  - Legacy vector purge on startup
affects: [17-02-PLAN, search-service, pipeline-plugin]

# Tech tracking
tech-stack:
  added: []
  patterns: [tenant-scoped-wrapper, filter-injection, factory-decoration]

key-files:
  created:
    - src/lib/tenant-qdrant-client.ts
    - src/lib/__tests__/tenant-qdrant-client.test.ts
  modified:
    - src/plugins/qdrant.ts
    - src/plugins/__tests__/qdrant.test.ts

key-decisions:
  - "Filter merging via spread on must array with unknown[] types for Qdrant client compatibility"
  - "buildFilter helper centralizes must-merging and casts to Record<string, unknown> at boundary"
  - "Raw QdrantClient kept as local variable in plugin closure, never exposed on fastify"

patterns-established:
  - "TenantQdrantClient wrapper: all Qdrant operations go through tenant-scoped client"
  - "Factory decoration: fastify.createTenantQdrant(userId) creates per-user clients"
  - "Idempotent index creation: user_id keyword index outside if-exists block with try/catch"

requirements-completed: [DATA-01]

# Metrics
duration: 4min
completed: 2026-03-14
---

# Phase 17 Plan 01: Qdrant Tenant Isolation Summary

**TenantQdrantClient wrapper with mandatory user_id filter injection on all 5 Qdrant operations, plus qdrant plugin refactored to create user_id index, purge legacy vectors, and expose factory instead of raw client**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-14T07:56:15Z
- **Completed:** 2026-03-14T08:00:15Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- TenantQdrantClient wrapper class with 5 methods (search, scroll, upsert, delete, setPayload) that inject user_id filter into every operation
- Qdrant plugin refactored: user_id keyword index created idempotently, legacy vectors purged on startup, raw client internalized
- createTenantQdrant factory and purgeUserVectors function decorated on Fastify instance
- 19 tests across 2 test files (10 unit tests for wrapper, 9 for plugin)

## Task Commits

Each task was committed atomically:

1. **Task 1: TenantQdrantClient wrapper class with unit tests (TDD)**
   - `964c4af` (test: failing tests - RED phase)
   - `495ae81` (feat: implementation - GREEN phase)

2. **Task 2: Refactor qdrant plugin** - `99a17f7` (feat)

## Files Created/Modified
- `src/lib/tenant-qdrant-client.ts` - TenantQdrantClient wrapper class with 5 methods and user_id filter injection
- `src/lib/__tests__/tenant-qdrant-client.test.ts` - 10 unit tests covering all methods and edge cases
- `src/plugins/qdrant.ts` - Refactored plugin with user_id index, legacy purge, factory decoration
- `src/plugins/__tests__/qdrant.test.ts` - 9 tests covering index creation, legacy purge, factory decoration

## Decisions Made
- Used `unknown[]` for filter condition types with `Record<string, unknown>` cast at boundary to avoid complex Qdrant client type gymnastics while maintaining runtime safety
- Centralized filter merging in private `buildFilter` helper method
- Raw QdrantClient stays as local variable in plugin closure -- structurally impossible for route handlers to access

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TypeScript type compatibility with Qdrant client**
- **Found during:** Task 2 (qdrant plugin refactor)
- **Issue:** `FilterCondition` interface with optional `key` field was incompatible with Qdrant client's expected filter types
- **Fix:** Simplified to `unknown[]` for filter arrays, added `buildFilter` helper that casts to `Record<string, unknown>` at the boundary
- **Files modified:** src/lib/tenant-qdrant-client.ts
- **Verification:** `pnpm typecheck` passes for all modified files
- **Committed in:** 99a17f7 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Type fix necessary for compilation. No scope creep.

## Issues Encountered
- Expected: `pnpm typecheck` shows errors in pipeline.ts and search/routes.ts due to `fastify.qdrant` removal. These are expected per plan and will be fixed in Plan 02.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- TenantQdrantClient wrapper ready for use by search service and pipeline
- Plan 02 will update consumers (search service, pipeline, request decorators) to use createTenantQdrant factory
- Existing code using `fastify.qdrant` will need migration in Plan 02

---
*Phase: 17-data-isolation*
*Completed: 2026-03-14*
