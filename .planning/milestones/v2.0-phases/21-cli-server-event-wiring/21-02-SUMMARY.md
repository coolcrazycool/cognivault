---
phase: 21-cli-server-event-wiring
plan: 02
subsystem: indexer
tags: [fastify, indexer, retry, vault, timers, vitest, fake-timers]

# Dependency graph
requires:
  - phase: 21-01
    provides: user-added/user-removed events emitted reliably from addUser/removeUser
provides:
  - Bounded 30s retry loop in indexer user-added handler for lazy vault path materialisation
  - Warning log when vault never appears within timeout window
  - Full test coverage for retry, timeout, and immediate-start scenarios
affects:
  - 21-cli-server-event-wiring (phase completion)
  - any future work touching indexer plugin user lifecycle

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Bounded retry loop with deadline: Date.now() + MAX_WAIT_MS, poll via setTimeout"
    - "vi.useFakeTimers() + vi.advanceTimersByTimeAsync() for testing async retry loops without real delays"

key-files:
  created: []
  modified:
    - src/plugins/indexer.ts
    - src/plugins/__tests__/indexer.test.ts

key-decisions:
  - "Retry loop wraps createUserIndexer calls — createUserIndexer itself unchanged, still returns null on ENOENT"
  - "try/catch wraps entire user-added handler body to prevent unhandled rejections from async EventEmitter handler"
  - "Existing test 'skips indexer creation if new user vault path does not exist' updated to use fake timers + persistent rejection (mockRejectedValue) to correctly reflect retry semantics"

patterns-established:
  - "Fake timer pattern for retry tests: fire handler promise, then vi.advanceTimersByTimeAsync() to unblock setTimeout delays"

requirements-completed:
  - SYNC-01

# Metrics
duration: 4min
completed: 2026-03-14
---

# Phase 21 Plan 02: Vault-Path Retry Loop in Indexer Summary

**30-second bounded retry loop added to indexer user-added handler so vault directories created asynchronously by `ob sync` are detected and indexed without manual intervention**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-14T16:38:25Z
- **Completed:** 2026-03-14T16:42:00Z
- **Tasks:** 1 (TDD)
- **Files modified:** 2

## Accomplishments

- Indexer user-added handler retries vault path access every 2s for up to 30s
- Indexer starts automatically when vault directory materialises during retry window
- Warning logged with userId and vaultPath if vault never appears after 30s
- Handler wrapped in try/catch to prevent unhandled rejections from async EventEmitter callback
- 3 new tests covering retry success, timeout/give-up, and immediate-start scenarios
- Existing skip test updated to use fake timers and persistent failure (correct semantics for retry behavior)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add vault-path retry tests and implement retry loop in indexer** - `25c9b66` (feat)

**Plan metadata:** (docs commit follows)

_Note: TDD task — RED (new tests added, 1 failed), GREEN (implementation added, all pass)_

## Files Created/Modified

- `src/plugins/indexer.ts` - Added MAX_VAULT_WAIT_MS/VAULT_POLL_INTERVAL_MS constants and retry while-loop in user-added handler; wrapped handler in try/catch
- `src/plugins/__tests__/indexer.test.ts` - Added `describe('vault path retry on user-added')` block with 3 tests using fake timers; updated existing skip test to use fake timers + persistent rejection

## Decisions Made

- Retry loop wraps createUserIndexer calls — createUserIndexer itself unchanged, still returns null on ENOENT. This keeps the existing function clean and the retry policy in the event handler where it belongs.
- try/catch wraps entire handler body (not just the retry section) to catch any unexpected error from db wait, createUserIndexer, or indexer.start().
- Existing test `'skips indexer creation if new user vault path does not exist'` was renamed to `'skips indexer creation if new user vault path never appears (timeout)'` and updated with fake timers + `mockRejectedValue` (persistent). A single rejection no longer means skip — it triggers a retry. This is a Rule 1 auto-fix (existing test was semantically broken by the new retry behavior).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated existing test to match new retry semantics**
- **Found during:** Task 1 GREEN phase
- **Issue:** Existing test `'skips indexer creation if new user vault path does not exist'` used `mockRejectedValueOnce` (single failure). With retry logic, one failure is followed by a successful retry using the default `mockResolvedValue(undefined)`, causing the test to assert `false` but get `true`. Test was semantically incorrect for the new behavior.
- **Fix:** Updated test to use `mockRejectedValue` (persistent failure), `vi.useFakeTimers()`, and `vi.advanceTimersByTimeAsync(31000)` to simulate full 30s timeout. Renamed test to accurately describe the scenario.
- **Files modified:** src/plugins/__tests__/indexer.test.ts
- **Verification:** All 12 tests pass including renamed test
- **Committed in:** 25c9b66 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - existing test broken by new behavior)
**Impact on plan:** Auto-fix required for test suite integrity. No scope creep.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 21 is now complete: both plans (user-added/user-removed event emission and vault-path retry) are implemented and tested
- The `add-user` / `remove-user` CLI workflow is fully wired: events fire reliably, indexer starts when vault materialises
- Ready for phase 22 (metric fixes or further gap closure work per ROADMAP)

---
*Phase: 21-cli-server-event-wiring*
*Completed: 2026-03-14*
