---
phase: 13-search-reindex-correctness
plan: 02
subsystem: api
tags: [fastify, p-queue, drizzle-orm, vitest, tdd, reindex, pipeline]

# Dependency graph
requires:
  - phase: 11-observability-admin
    provides: ReindexService with createFullJob/createPathJob/createFolderJob methods
  - phase: 05-markdown-indexing-pipeline
    provides: PQueue-based pipeline plugin processing FileChangeEvents
provides:
  - fastify.pipelineQueue decoration exposing PQueue for queue drain awaiting
  - Full reindex job correctly waits for pipelineQueue.onIdle() before status='completed'
  - Path-scoped reindex emits real contentHash from indexed_files DB (not empty string)
affects: [future reindex phases, admin API consumers]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Fastify module augmentation (declare module 'fastify') placed after imports for Biome import-sort compliance"
    - "Async event listener registered with .on() + manual removeListener (not .once()) for correct async handler cleanup"
    - "pipelineQueue.onIdle() await pattern: ensures pipeline tasks complete before reporting job done"
    - "Static drizzle-orm imports replace dynamic await import() for consistency"

key-files:
  created: []
  modified:
    - src/plugins/pipeline.ts
    - src/features/admin/service.ts
    - src/features/admin/__tests__/service.test.ts

key-decisions:
  - "[13-02]: pipelineQueue decorated on fastify via fastify.decorate() in pipelinePlugin for cross-plugin access"
  - "[13-02]: scanComplete uses .on() not .once() because async handler's promise resolves after listener is auto-removed by .once()"
  - "[13-02]: onIdle() not onEmpty() — onIdle waits for size===0 && pending===0; onEmpty only waits for queue size"
  - "[13-02]: declare module 'fastify' block placed after all imports to satisfy Biome organizeImports rule"
  - "[13-02]: Static imports for eq/like/indexedFiles at service.ts top level replace dynamic await import() in createFolderJob"

patterns-established:
  - "Queue drain check: await fastify.pipelineQueue.onIdle() before marking async jobs complete"

requirements-completed: [IDX-13, IDX-06]

# Metrics
duration: 4min
completed: 2026-03-12
---

# Phase 13 Plan 02: Reindex Job Correctness Summary

**Fixed full reindex premature completion (awaits pipelineQueue.onIdle() before status='completed') and path-scoped reindex empty contentHash (reads real hash from indexed_files DB via .get())**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-12T17:18:57Z
- **Completed:** 2026-03-12T17:23:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Pipeline plugin now decorates `fastify.pipelineQueue` so service layer can await queue drain
- Full reindex `onScanComplete` handler made async and awaits `pipelineQueue.onIdle()` before setting `job.status = 'completed'` — agents no longer see 'completed' while Qdrant is still being populated
- `createPathJob` looks up real `contentHash` from `indexed_files` via Drizzle `.get()` instead of hardcoding `''`
- Dynamic imports in `createFolderJob` replaced with static imports at file top for consistency
- TDD: 12 tests total covering queue drain timing, .on() vs .once() assertion, real/missing DB hash cases

## Task Commits

Each task was committed atomically:

1. **Task 1: Expose pipelineQueue and fix createFullJob to await queue drain** - `c671f41` (feat)
2. **Task 2: Fix createPathJob to read real contentHash from indexed_files** - `032619a` (fix)

## Files Created/Modified

- `src/plugins/pipeline.ts` - Added FastifyInstance type augmentation for pipelineQueue; added `fastify.decorate('pipelineQueue', queue)` after PQueue creation
- `src/features/admin/service.ts` - Made onScanComplete async with pipelineQueue.onIdle() await; switched .once() to .on(); createPathJob DB lookup for contentHash; static imports replacing dynamic imports
- `src/features/admin/__tests__/service.test.ts` - Added pipelineQueue mock, qdrant mock, mockDbGet; added 5 new tests for queue drain timing and contentHash correctness

## Decisions Made

- Used `pipelineQueue.onIdle()` (not `onEmpty()`) — onIdle waits for both queue size and pending tasks to reach 0
- Used `.on()` with manual `removeListener` inside async handler instead of `.once()` — `.once()` removes the listener synchronously before the async handler's promise resolves, causing the removeListener calls to be no-ops
- `declare module 'fastify'` block placed after all imports to satisfy Biome `organizeImports` rule
- Static `import { eq, like } from 'drizzle-orm'` and `import { indexedFiles }` at file top replaces `await import()` in createFolderJob for cleaner, consistent style

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. Pre-existing lint errors in `image-tracker.test.ts` and `pdf-chunker.test.ts` (import sort order) were out of scope and not introduced by our changes — verified by stashing changes and confirming same failures on baseline.

## Next Phase Readiness

- Full reindex now reliably reports 'completed' only after all Qdrant vectors are written
- Path-scoped reindex correctly propagates contentHash to pipeline for cache-aware processing
- Ready for Phase 13 Plan 03 (search result correctness fixes) or integration testing

## Self-Check: PASSED

- FOUND: .planning/phases/13-search-reindex-correctness/13-02-SUMMARY.md
- FOUND: commit c671f41 (Task 1)
- FOUND: commit 032619a (Task 2)

---
*Phase: 13-search-reindex-correctness*
*Completed: 2026-03-12*
