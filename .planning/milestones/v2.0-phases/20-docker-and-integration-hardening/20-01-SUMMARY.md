---
phase: 20-docker-and-integration-hardening
plan: "01"
subsystem: infra
tags: [docker, tini, obsidian-headless, multi-tenant, config]

# Dependency graph
requires:
  - phase: 19-cli-and-vault-sync
    provides: obsidian-headless sync plugin that needs tini for PID 1 signal forwarding
provides:
  - Dockerfile with tini as PID 1 and obsidian-headless globally installed
  - docker-compose.yml using only v2.0 environment variables (no VAULT_PATH bind mount)
  - VAULT_PATH made optional in config.ts for zero-user healthy start
  - vault.ts guard skips global vault plugin when VAULT_PATH unset
affects: [docker-deployment, integration-testing, ci-cd]

# Tech tracking
tech-stack:
  added: [tini v0.19.0, obsidian-headless v0.0.6 (global npm install)]
  patterns: [ENTRYPOINT+CMD pattern for tini PID 1, optional config with runtime guard]

key-files:
  created: []
  modified:
    - Dockerfile
    - docker-compose.yml
    - src/config.ts
    - src/plugins/vault.ts

key-decisions:
  - "tini installed via apt-get in production stage; ENTRYPOINT uses /usr/bin/tini -- for signal forwarding to ob sync child processes"
  - "build-essential and python3 installed then purged after obsidian-headless npm install (needed for btime native addon)"
  - "VAULT_PATH made optional (z.string().optional()) — v2.0 uses per-user vaultPath from users.json registry"
  - "vault.ts guard: if VAULT_PATH not set, log info and return early without decorating fastify.vault"

patterns-established:
  - "Optional env vars with runtime guards: check at plugin init time, not at config parse time"

requirements-completed: [INFRA-01, INFRA-02]

# Metrics
duration: 4min
completed: 2026-03-14
---

# Phase 20 Plan 01: Docker and Configuration Hardening Summary

**Multi-stage Dockerfile rewritten with tini as PID 1 and obsidian-headless v0.0.6 globally installed; docker-compose.yml cleaned of single-user env vars; VAULT_PATH made optional for v2.0 zero-user healthy start**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-14T13:21:36Z
- **Completed:** 2026-03-14T13:25:40Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Docker image builds successfully with tini v0.19.0 at `/usr/bin/tini` and `ob` (obsidian-headless v0.0.6) globally available
- docker-compose.yml no longer references COGNIVAULT_API_KEY, OPENAI_API_KEY, or VAULT_PATH (vault bind mount removed)
- Server can start without VAULT_PATH set — vault plugin gracefully skips in v2.0 multi-tenant mode
- All 511 tests pass

## Task Commits

Each task was committed atomically:

1. **Task 1: Rewrite Dockerfile with tini and obsidian-headless** - `cef78c4` (feat)
2. **Task 2: Clean up docker-compose.yml and make config.ts VAULT_PATH optional** - `c09b9a1` (feat)

**Plan metadata:** (to be added by final commit)

## Files Created/Modified
- `Dockerfile` - Added tini + obsidian-headless install, replaced CMD with ENTRYPOINT+CMD
- `docker-compose.yml` - Removed COGNIVAULT_API_KEY, OPENAI_API_KEY, VAULT_PATH env vars and vault bind mount
- `src/config.ts` - VAULT_PATH changed from required (.min(1)) to optional (.optional())
- `src/plugins/vault.ts` - Added guard: skips plugin initialization if VAULT_PATH not set

## Decisions Made
- tini installed via apt-get (system package), not npm, to ensure it's at `/usr/bin/tini` for the ENTRYPOINT
- build-essential and python3 are purged after obsidian-headless install to keep the image slim while supporting the btime native addon during build
- vault.ts guard uses early return pattern (`if (!config.VAULT_PATH) { log.info(...); return; }`) — does not decorate `fastify.vault` when in multi-tenant mode

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None — Dockerfile built successfully on first attempt. All checks and tests passed.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Docker image ready for integration testing with tini signal forwarding
- Server can start without VAULT_PATH, enabling zero-user healthy container startup
- Remaining plans in Phase 20: integration testing and health check hardening

---
*Phase: 20-docker-and-integration-hardening*
*Completed: 2026-03-14*

## Self-Check: PASSED

- SUMMARY.md: FOUND
- Dockerfile: FOUND (with tini ENTRYPOINT)
- docker-compose.yml: FOUND (no VAULT_PATH/API_KEY refs)
- src/config.ts: FOUND (VAULT_PATH optional)
- src/plugins/vault.ts: FOUND (guard added)
- Commit cef78c4: FOUND (Task 1)
- Commit c09b9a1: FOUND (Task 2)
