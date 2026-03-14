---
phase: 15-registry-foundation
plan: 01
subsystem: auth
tags: [zod, eventemitter, fs-watch, atomic-write, multi-tenant]

requires: []
provides:
  - "UserRegistry class with O(1) lookup by apiKey/userId"
  - "Hot-reload via fs.watch with content hash diffing"
  - "Atomic write (tmp+rename) for users.json"
  - "Typed EventEmitter with user-added/removed/updated events"
  - "userRecordSchema Zod validator"
  - "UserRegistry.generateApiKey() static utility"
affects: [16-auth-gateway, 17-data-isolation, 19-cli-management]

tech-stack:
  added: []
  patterns: [typed-eventemitter-registry, atomic-file-write, content-hash-reload]

key-files:
  created:
    - src/lib/user-registry.ts
    - src/lib/__tests__/user-registry.test.ts
  modified: []

key-decisions:
  - "fs.watch on parent directory (not file) to detect atomic rename-over writes"
  - "SHA-256 content hash for skip-reload optimization and self-write detection"
  - "Deep-freeze returned records (outer + obsidian sub-object) for immutability"
  - "Reject entire file on any invalid entry (no partial loads)"

patterns-established:
  - "UserRegistry pattern: standalone class with no Fastify dependency, typed EventEmitter, constructor injection"
  - "Atomic file write: writeFile to .tmp then rename over original"
  - "Hot-reload: fs.watch parent dir + debounce 500ms + content hash comparison"

requirements-completed: [TENANT-02, TENANT-03]

duration: 3min
completed: 2026-03-14
---

# Phase 15 Plan 01: UserRegistry Summary

**Standalone UserRegistry class with Zod-validated users.json, O(1) dual-Map lookup, fs.watch hot-reload with SHA-256 content hash diffing, atomic tmp+rename writes, and typed EventEmitter lifecycle events**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-14T05:48:44Z
- **Completed:** 2026-03-14T05:51:34Z
- **Tasks:** 2 (TDD RED + GREEN)
- **Files modified:** 2

## Accomplishments
- UserRegistry class with dual Maps for O(1) lookup by apiKey and userId
- Hot-reload via fs.watch on parent directory with 500ms debounce and SHA-256 content hash comparison
- Atomic file writes using tmp+rename pattern preventing corruption
- Typed EventEmitter emitting user-added, user-removed, user-updated diff events on reload
- Deep-frozen returned records preventing internal state mutation
- 18 unit tests covering load, lookup, immutability, write, hot-reload, events, and key generation

## Task Commits

Each task was committed atomically:

1. **TDD RED: Failing tests** - `5f8195a` (test)
2. **TDD GREEN: Implementation** - `2ac1449` (feat)

_TDD plan: RED wrote 18 failing tests, GREEN implemented UserRegistry to pass all._

## Files Created/Modified
- `src/lib/user-registry.ts` - Standalone UserRegistry class with Zod validation, dual-Map lookup, hot-reload, atomic writes, typed EventEmitter
- `src/lib/__tests__/user-registry.test.ts` - 18 unit tests covering all behaviors

## Decisions Made
- Used fs.watch on parent directory instead of file to properly detect atomic rename-over writes
- SHA-256 content hash comparison for both skip-reload optimization and self-write detection
- Deep-freeze both outer record and obsidian sub-object for complete immutability
- Reject entire users.json file on any invalid entry rather than partial loading

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed ESM spy test for atomic write verification**
- **Found during:** TDD GREEN (implementation)
- **Issue:** vi.spyOn(fs, 'rename') fails in ESM because module namespace is not configurable
- **Fix:** Changed test to verify atomic write by checking file contents on disk and absence of leftover .tmp files
- **Files modified:** src/lib/__tests__/user-registry.test.ts
- **Verification:** All 18 tests pass
- **Committed in:** 2ac1449 (GREEN commit)

**2. [Rule 1 - Bug] Fixed TypeScript unused variable errors**
- **Found during:** TDD GREEN (verification)
- **Issue:** Unused `EventEmitter` import in test file and unused `eventType` parameter in fs.watch callback
- **Fix:** Removed unused import, prefixed unused parameter with underscore
- **Files modified:** src/lib/__tests__/user-registry.test.ts, src/lib/user-registry.ts
- **Verification:** pnpm typecheck passes clean
- **Committed in:** 2ac1449 (GREEN commit)

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both auto-fixes necessary for ESM compatibility and TypeScript strict mode. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- UserRegistry is fully standalone with no Fastify dependency
- Ready for Phase 16 (auth gateway) to consume UserRegistry for per-user API key authentication
- Ready for Phase 17 (data isolation) to use UserRecord.vaultPath for per-user vault routing
- Ready for Phase 19 (CLI) to use addUser/removeUser for user management

---
*Phase: 15-registry-foundation*
*Completed: 2026-03-14*
