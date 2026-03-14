---
phase: 21-cli-server-event-wiring
plan: 01
subsystem: registry
tags: [event-emitter, user-registry, lifecycle-events, tdd]

# Dependency graph
requires:
  - phase: 20-docker-and-integration-hardening
    provides: sync plugin with user-removed event handler using prom-client .remove()
provides:
  - UserRegistry.addUser() emits 'user-added' event directly after atomic write
  - UserRegistry.removeUser() emits 'user-removed' event directly after atomic write
  - OBS-03 requirement marked complete
affects:
  - 21-cli-server-event-wiring (CLI plans can rely on direct event emission)
  - 22-sync-gap-closure (sync plugin receives events from any registry instance)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Emit lifecycle events directly in write methods, not only on file-watch reload — any registry instance (CLI or server) fires events reliably"

key-files:
  created: []
  modified:
    - src/lib/user-registry.ts
    - src/lib/__tests__/user-registry.test.ts
    - .planning/REQUIREMENTS.md

key-decisions:
  - "Emit 'user-added'/'user-removed' after onUserCountChangeCb — maintains existing callback order while adding event propagation"
  - "Deep-freeze emitted records with same pattern as diffUsers() — consistent immutability across all event sources"

patterns-established:
  - "Write-method emission: call this.emit() after atomicWrite completes and onUserCountChangeCb fires — atomicity is preserved before observers run"

requirements-completed:
  - CLI-01
  - CLI-02
  - CLI-04
  - OBS-03

# Metrics
duration: 8min
completed: 2026-03-14
---

# Phase 21 Plan 01: CLI-Server Event Wiring Summary

**Direct event emission added to UserRegistry.addUser() and removeUser() so any registry instance reliably fires lifecycle events without depending on fs.watch timing**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-14T19:34:00Z
- **Completed:** 2026-03-14T19:36:50Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- addUser() emits 'user-added' with deep-frozen record after atomic write completes
- removeUser() emits 'user-removed' with deep-frozen record after atomic write completes
- 5 new event emission tests covering: emit on add, emit on remove, no-emit on duplicate, no-emit on unknown userId, frozen records
- OBS-03 marked complete in REQUIREMENTS.md (satisfied count: 10 → 11)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add event emission tests and implement direct emit in UserRegistry** - `69b1186` (feat)
2. **Task 2: Mark OBS-03 complete in REQUIREMENTS.md** - `0bf3d7d` (docs)

_Note: Task 1 used TDD (RED then GREEN); TypeScript strict-mode fix for `spy.mock.calls[0]` indexing was part of GREEN phase._

## Files Created/Modified

- `src/lib/user-registry.ts` - Added `this.emit('user-added', ...)` in addUser() and `this.emit('user-removed', ...)` in removeUser()
- `src/lib/__tests__/user-registry.test.ts` - Added `describe('event emission')` block with 5 tests
- `.planning/REQUIREMENTS.md` - OBS-03 marked [x], traceability updated to Complete, coverage counts updated

## Decisions Made

- Emit after `onUserCountChangeCb` call — preserves existing callback ordering while adding event propagation
- Use same `deepFreeze({ ...record, obsidian: { ...record.obsidian } })` pattern as `diffUsers()` for consistent immutability

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TypeScript strict-mode error in test spy.mock.calls indexing**
- **Found during:** Task 1 (GREEN phase, running `pnpm typecheck`)
- **Issue:** `spy.mock.calls[0][0]` produced `TS2532: Object is possibly 'undefined'` under strict mode
- **Fix:** Extracted `const firstCall = spy.mock.calls[0]` with `expect(firstCall).toBeDefined()` guard, then accessed `firstCall![0]`
- **Files modified:** src/lib/__tests__/user-registry.test.ts
- **Verification:** `pnpm typecheck` exits 0; all 23 tests pass
- **Committed in:** 69b1186 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug in test type safety)
**Impact on plan:** Necessary for strict-mode TypeScript compliance. No scope creep.

## Issues Encountered

None beyond the TypeScript strict-mode fix documented above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- UserRegistry now emits events from both write paths (direct CLI writes and fs.watch reloads)
- Phase 21 plans 02+ can rely on 'user-added'/'user-removed' events firing from any registry instance
- OBS-03 is fully satisfied

---
*Phase: 21-cli-server-event-wiring*
*Completed: 2026-03-14*
