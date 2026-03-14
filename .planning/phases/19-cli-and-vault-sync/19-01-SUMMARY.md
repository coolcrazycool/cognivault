---
phase: 19-cli-and-vault-sync
plan: 01
subsystem: cli
tags: [commander, cli, user-management, obsidian-headless]

# Dependency graph
requires:
  - phase: 16-user-registry
    provides: UserRegistry class with addUser/removeUser/getAllUsers/getUserById
provides:
  - cognivault-ctl CLI entrypoint with Commander.js
  - add-user command with ob login + ob sync-setup lifecycle
  - remove-user command with confirmation prompt
  - list-users command with table and JSON output
affects: [20-docker-deployment]

# Tech tracking
tech-stack:
  added: [commander@14.0.3]
  patterns: [CLI handler extraction for testability, promisified execFile for subprocess calls]

key-files:
  created:
    - src/cli/index.ts
    - src/cli/commands/add-user.ts
    - src/cli/commands/remove-user.ts
    - src/cli/commands/list-users.ts
    - src/cli/__tests__/add-user.test.ts
    - src/cli/__tests__/remove-user.test.ts
    - src/cli/__tests__/list-users.test.ts
  modified:
    - package.json

key-decisions:
  - "Extract handler functions (handleAddUser, etc.) from Commander action for direct testability"
  - "SYNC_STATUS always 'unknown' in CLI -- no server access from offline CLI"
  - "Use promisify(execFile) for subprocess calls to ob CLI"

patterns-established:
  - "CLI handler pattern: export handleX() for testing, registerX(program) for Commander registration"
  - "CLI error handling: try/catch in action, stderr output, process.exit(1)"

requirements-completed: [CLI-01, CLI-02, CLI-03, CLI-04]

# Metrics
duration: 5min
completed: 2026-03-14
---

# Phase 19 Plan 01: CLI User Management Summary

**cognivault-ctl CLI with add-user (ob login + sync-setup flow), remove-user (confirmation prompt), and list-users (table/JSON output) using Commander.js**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-14T11:35:48Z
- **Completed:** 2026-03-14T11:40:56Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- CLI entrypoint with Commander.js program named cognivault-ctl
- add-user command performs full ob login, token read, ob sync-setup, registry write lifecycle
- remove-user command with interactive confirmation prompt and --force bypass
- list-users command with padded table output and --json mode
- 14 tests passing with mocked child_process, readline, and UserRegistry

## Task Commits

Each task was committed atomically:

1. **Task 1: CLI scaffolding, add-user command with ob login flow** - `9c9c17b` (feat)
2. **Task 2: remove-user and list-users commands** - `94633c5` (feat)

## Files Created/Modified
- `src/cli/index.ts` - CLI entrypoint with Commander.js, registers all 3 commands
- `src/cli/commands/add-user.ts` - add-user subcommand with ob login + sync-setup + registry write
- `src/cli/commands/remove-user.ts` - remove-user with confirmation prompt and --force
- `src/cli/commands/list-users.ts` - list-users with table and --json output
- `src/cli/__tests__/add-user.test.ts` - 6 tests for add-user handler
- `src/cli/__tests__/remove-user.test.ts` - 4 tests for remove-user handler
- `src/cli/__tests__/list-users.test.ts` - 4 tests for list-users handler
- `package.json` - Added bin field and commander dependency

## Decisions Made
- Extracted handler functions from Commander actions for direct unit testing without parsing CLI args
- SYNC_STATUS is always 'unknown' since CLI reads registry file only, no server connection
- Used promisify(execFile) for subprocess calls to obsidian-headless CLI

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Vitest v4 dropped `-x` flag; switched to `--bail 1` for fail-fast behavior
- vi.fn().mockImplementation() not usable as constructor; used vi.fn(function() {}) pattern for class mocks
- Biome useLiteralKeys lint rule required switching process.env['KEY'] to process.env.KEY

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- CLI commands ready for integration testing in Phase 19 Plan 02/03
- bin field in package.json ready for `pnpm link` or Docker build

---
*Phase: 19-cli-and-vault-sync*
*Completed: 2026-03-14*
