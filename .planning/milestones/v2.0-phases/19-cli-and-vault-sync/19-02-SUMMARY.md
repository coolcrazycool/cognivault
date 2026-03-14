---
phase: 19-cli-and-vault-sync
plan: 02
subsystem: infra
tags: [child-process, obsidian-sync, backoff, prometheus, fastify-plugin]

requires:
  - phase: 16-user-registry
    provides: UserRegistry with user-added/user-removed events
  - phase: 17-per-user-storage
    provides: promRegistry on fastify.metrics for shared metric registration
provides:
  - Per-user ob sync --continuous child process supervision
  - Exponential backoff with stability reset
  - Lock file cleanup before sync starts
  - SIGTERM/SIGKILL graceful shutdown
  - cognivault_sync_running gauge and cognivault_sync_failures_total counter
affects: [20-docker-compose, 19-cli-and-vault-sync]

tech-stack:
  added: []
  patterns: [sync-lock-cleanup, exponential-backoff-with-stability-reset, fire-and-forget-sigkill]

key-files:
  created:
    - src/plugins/sync.ts
    - src/plugins/__tests__/sync.test.ts
  modified: []

key-decisions:
  - "Used unlinkSync instead of async unlink for lock file cleanup -- simplifies timer-based restart logic and avoids async chains in setTimeout callbacks"
  - "Backoff uses current delay then increments for next failure (use-then-increase) rather than increment-then-use, giving 1s initial delay as specified"
  - "onClose SIGKILL is fire-and-forget (not awaited) to prevent blocking server shutdown"

patterns-established:
  - "Sync lock cleanup: unlinkSync wrapped in try/catch ignoring all errors before every sync start"
  - "Exponential backoff: use current delay, then multiply for next failure; reset after stability threshold"

requirements-completed: [SYNC-01, SYNC-02, SYNC-03, SYNC-04]

duration: 20min
completed: 2026-03-14
---

# Phase 19 Plan 02: Sync Plugin Summary

**Per-user ob sync child process supervisor with exponential backoff, lock file cleanup, and Prometheus metrics on shared promRegistry**

## Performance

- **Duration:** 20 min
- **Started:** 2026-03-14T11:35:49Z
- **Completed:** 2026-03-14T11:55:29Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files modified:** 2

## Accomplishments
- Sync plugin manages per-user `ob sync --continuous` child processes via Map + registry events pattern
- Exponential backoff with 1s base, 2x factor, 30s cap; resets to 1s after 60s stable run
- Lock file cleanup (`.obsidian/.sync.lock`) via unlinkSync before every spawn
- SIGTERM + 5s SIGKILL on user removal and server shutdown
- Prometheus metrics: `cognivault_sync_running` gauge and `cognivault_sync_failures_total` counter with `user_id` label

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Sync plugin tests** - `3d2054f` (test) - 12 failing tests for child process supervision
2. **Task 1 (GREEN): Sync plugin implementation** - `66c700c` (feat) - Implementation passing all 12 tests

## Files Created/Modified
- `src/plugins/sync.ts` - Fastify plugin managing per-user ob sync child processes with backoff and metrics (195 lines)
- `src/plugins/__tests__/sync.test.ts` - Tests for sync plugin lifecycle, backoff, metrics, cleanup (404 lines)

## Decisions Made
- Used `unlinkSync` instead of async `unlink` for lock file cleanup to simplify timer-based restart logic and avoid async Promise chains in setTimeout callbacks
- Backoff uses current delay then increments for next failure (1s, 2s, 4s...) rather than incrementing before use (which would skip 1s)
- onClose hook SIGKILL timer is fire-and-forget (not awaited) to prevent blocking server shutdown

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed backoff delay calculation order**
- **Found during:** Task 1 (TDD GREEN phase)
- **Issue:** Original implementation multiplied backoff before setting the timer, causing first restart delay to be 2s instead of specified 1s
- **Fix:** Changed to use-then-increase pattern: use current `backoffDelay` for timer, then multiply for next failure
- **Files modified:** src/plugins/sync.ts
- **Verification:** Backoff sequence test (1s, 2s, 4s, 8s, 16s, 30s, 30s) passes
- **Committed in:** 66c700c

**2. [Rule 1 - Bug] Changed from async unlink to sync unlinkSync**
- **Found during:** Task 1 (TDD GREEN phase)
- **Issue:** Async `unlink` inside setTimeout restart callback created Promise chains that didn't resolve with Vitest fake timers, preventing restart tests from passing. Also a real production concern: async operations in timer callbacks are harder to reason about.
- **Fix:** Switched to `unlinkSync` with try/catch for all lock file cleanup
- **Files modified:** src/plugins/sync.ts, src/plugins/__tests__/sync.test.ts
- **Verification:** All 12 tests pass including backoff timing tests with fake timers
- **Committed in:** 66c700c

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both fixes necessary for correct backoff behavior. No scope creep.

## Issues Encountered
- Vitest fake timers do not flush microtask queues from async functions called inside setTimeout callbacks. Resolved by making lock file cleanup synchronous (unlinkSync).
- Mock child_process.spawn identity issue: `vi.clearAllMocks()` resets `mockReturnValue`, causing spawned process identity mismatch in assertions. Resolved by capturing processes directly in the spawn mock factory.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Sync plugin ready for registration in app.ts (dependencies: registry, metrics)
- Next plan can wire sync into the application plugin chain
- obsidian-headless `ob` CLI binary must be available at runtime for actual sync

---
*Phase: 19-cli-and-vault-sync*
*Completed: 2026-03-14*
