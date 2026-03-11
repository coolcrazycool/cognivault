---
phase: 07-hybrid-retrieval-reranking
plan: 01
subsystem: api
tags: [rrf, hybrid-search, semantic, lexical, qdrant, fastify, typebox, vitest, tdd]

# Dependency graph
requires:
  - phase: 06-semantic-+-lexical-search
    provides: semantic() and lexical() methods on SearchService, existing route infrastructure

provides:
  - POST /api/vault/search/hybrid endpoint combining semantic + lexical via RRF
  - hybrid() method on SearchService with Reciprocal Rank Fusion (k=60)
  - hybridSearchSchema TypeBox schema for route validation and OpenAPI generation
  - TDD test suite for hybrid endpoint (25 total search tests)

affects:
  - 08-evaluation-harness (will benchmark hybrid vs semantic vs lexical quality)
  - any future phases adding search endpoints

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Reciprocal Rank Fusion (RRF) with k=60 for combining ranked lists
    - forEach-based accumulator pattern for TypeScript strict mode array iteration safety
    - Parallel Promise.all with 2x limit for over-fetching before fusion

key-files:
  created: []
  modified:
    - src/features/search/service.ts
    - src/features/search/schemas.ts
    - src/features/search/routes.ts
    - src/features/search/__tests__/routes.test.ts

key-decisions:
  - "RRF k=60 hardcoded (no env config) — standard literature value, not tunable per user decision"
  - "Equal weight between semantic and lexical sources — standard RRF, no bias per user decision"
  - "Dedup key is result.path — note-level identity, not chunk-level"
  - "No source attribution in output, no strategy parameter — clean uniform interface"
  - "Raw RRF scores used (no relative normalization) — already in [0,1] per research recommendation"
  - "RET-04 cross-encoder reranking explicitly deferred to v2 — no code, no stub, no placeholder"

patterns-established:
  - "Hybrid route follows identical pattern to /semantic and /lexical — same schema, same response shape"
  - "forEach with index used instead of indexed for-loops to satisfy TypeScript strict noUncheckedIndexedAccess"

requirements-completed:
  - RET-03
  - RET-04

# Metrics
duration: 4min
completed: 2026-03-11
---

# Phase 7 Plan 1: Hybrid Search Summary

**POST /api/vault/search/hybrid using Reciprocal Rank Fusion (k=60) combining semantic embedding search and lexical full-text search in parallel with 2x over-fetching and score clamping to [0,1]**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-11T07:15:37Z
- **Completed:** 2026-03-11T07:19:34Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Hybrid search endpoint combining semantic + lexical via RRF fusion with k=60
- Both search sources called in parallel (Promise.all) with 2x limit for over-fetching
- Path-level deduplication with accumulated RRF scores from both sources
- Graceful degradation: returns results from whichever source has data when one is empty
- 10 new TDD tests covering all behaviors; full suite 25 search tests passing
- pnpm check (biome + tsc) passing with no regressions

## Task Commits

Each task was committed atomically:

1. **RED phase: Failing tests for hybrid search** - `c5a7157` (test)
2. **GREEN phase: Hybrid search implementation** - `5573db8` (feat)
3. **Fix: TypeScript strict mode + biome formatting** - `1b6e2d3` (fix)

_Note: TDD task 1 produced test commit + feat commit + fix commit (RED/GREEN + TypeScript strict mode correction)_

## Files Created/Modified
- `src/features/search/service.ts` - Added hybrid() method with RRF fusion logic
- `src/features/search/schemas.ts` - Added hybridSearchSchema export
- `src/features/search/routes.ts` - Added POST /hybrid route
- `src/features/search/__tests__/routes.test.ts` - Added 10 hybrid endpoint tests

## Decisions Made
- RRF k=60 hardcoded per user decision — standard literature value, not configurable
- Equal weighting between semantic and lexical (standard RRF, no bias)
- Dedup at path level (note identity) not chunk level
- No source attribution in results, no strategy parameter
- RET-04 (cross-encoder reranking) explicitly NOT implemented — deferred to v2 per user decision

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TypeScript strict mode array access errors in hybrid()**
- **Found during:** Task 2 (pnpm check run)
- **Issue:** TypeScript strict mode flagged `semanticResults[i]` and `lexicalResults[i]` as potentially `undefined` in for-loops (noUncheckedIndexedAccess)
- **Fix:** Replaced indexed for-loops with `forEach((result, i) => ...)` pattern which provides proper type narrowing — extracted into `accumulateRRF()` inner function for DRY
- **Files modified:** src/features/search/service.ts
- **Verification:** `pnpm typecheck` passes with no errors
- **Committed in:** 1b6e2d3

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug)
**Impact on plan:** TypeScript strict mode fix was necessary for correct compilation. No scope creep.

## Issues Encountered
- Pre-existing test failures in `health/__tests__/routes.test.ts`, `auth.test.ts`, `db.test.ts`, `indexer.test.ts`, `vault/__tests__/routes.test.ts` — confirmed pre-existing before my changes via `git stash`. These are outside the scope of this plan (different features, not caused by hybrid search changes). Logged to deferred-items.
- Pre-existing Biome style infos (`useLiteralKeys` in pipeline.test.ts, `useTemplate` in vault.ts) — info-level only (not errors), exit code 0, out of scope.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- POST /api/vault/search/hybrid endpoint ready for evaluation harness benchmarking
- All three search strategies (semantic, lexical, hybrid) available for quality comparison in Phase 8
- No blockers

## Self-Check: PASSED
- src/features/search/service.ts: FOUND
- src/features/search/schemas.ts: FOUND
- src/features/search/routes.ts: FOUND
- src/features/search/__tests__/routes.test.ts: FOUND
- Commit c5a7157: FOUND (test: failing hybrid tests)
- Commit 5573db8: FOUND (feat: hybrid implementation)
- Commit 1b6e2d3: FOUND (fix: TypeScript strict mode + biome format)

---
*Phase: 07-hybrid-retrieval-reranking*
*Completed: 2026-03-11*
