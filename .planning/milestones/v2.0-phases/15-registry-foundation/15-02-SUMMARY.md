---
phase: 15-registry-foundation
plan: 02
subsystem: auth
tags: [fastify-plugin, prom-client, prometheus, pino-redaction, lifecycle]

requires:
  - phase: 15-registry-foundation plan 01
    provides: "UserRegistry class with O(1) lookup, hot-reload, atomic writes"
provides:
  - "fastify.registry decoration wrapping UserRegistry with lifecycle management"
  - "Prometheus counter cognivault_registry_reloads_total and gauge cognivault_registry_users"
  - "fastify.metrics.promRegistry exposed for shared metric registration"
  - "Pino log redaction for openaiKey, obsidian.password, obsidian.token"
affects: [16-auth-gateway, 17-data-isolation, 18-routes, 19-cli-management]

tech-stack:
  added: []
  patterns: [fastify-plugin-wrapper-with-metrics, prom-client-shared-registry, pino-redaction]

key-files:
  created:
    - src/plugins/registry.ts
    - src/plugins/__tests__/registry.test.ts
  modified:
    - src/plugins/metrics.ts
    - src/app.ts

key-decisions:
  - "Expose prom-client Registry on fastify.metrics.promRegistry for cross-plugin metric registration"
  - "Registry plugin depends on metrics plugin (fp dependencies array)"
  - "Plugin registration order: errorHandler -> metrics -> registry -> auth -> swagger -> toon"
  - "Ensure data directory exists (mkdir recursive) before loading users.json"

patterns-established:
  - "Shared promRegistry pattern: plugins register custom metrics on fastify.metrics.promRegistry"
  - "Plugin lifecycle: load at register time, start watching, stop watching on onClose hook"

requirements-completed: [TENANT-02, TENANT-03]

duration: 3min
completed: 2026-03-14
---

# Phase 15 Plan 02: Registry Fastify Plugin Summary

**UserRegistry wired into Fastify as fp-wrapped plugin with Prometheus counter/gauge metrics, shared prom-client Registry, Pino secret redaction, and graceful lifecycle management**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-14T05:53:36Z
- **Completed:** 2026-03-14T05:57:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Registry plugin wraps UserRegistry with Fastify lifecycle hooks (load on register, startWatching, stopWatching on close)
- Prometheus observability: counter for reload success/rejected, gauge for current user count
- Exposed prom-client Registry instance on fastify.metrics.promRegistry for cross-plugin metric registration
- Pino log redaction paths for sensitive user fields (openaiKey, obsidian.password, obsidian.token)
- 7 integration tests covering decoration, load, lookup, shutdown, metrics endpoint, empty file, malformed file

## Task Commits

Each task was committed atomically:

1. **Task 1: Expose prom-client Registry and create registry plugin** - `27a5b34` (feat)
2. **Task 2: Integration tests for registry plugin** - `d021cc7` (test)

## Files Created/Modified
- `src/plugins/registry.ts` - Fastify plugin wrapping UserRegistry with lifecycle hooks, Prometheus metrics, data dir creation
- `src/plugins/__tests__/registry.test.ts` - 7 integration tests for registry plugin
- `src/plugins/metrics.ts` - Added promRegistry field to MetricsCollection interface and decoration
- `src/app.ts` - Reordered plugin registration (metrics before registry before auth), added Pino redact paths, imported registry plugin

## Decisions Made
- Exposed prom-client Registry on fastify.metrics.promRegistry rather than creating a separate decoration
- Registry plugin declares dependency on metrics plugin via fp dependencies array
- Reordered plugin registration: metrics moved before auth to satisfy registry dependency chain
- Added mkdir(recursive) for data directory in registry plugin to prevent ENOENT on first run

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Ensure data directory exists before loading users.json**
- **Found during:** Task 2 (integration tests)
- **Issue:** Existing tests (metrics, etc.) set COGNIVAULT_DATA_DIR to temp paths that don't exist on disk; registry.load() would fail with ENOENT when atomicWrite tries to create the empty users.json
- **Fix:** Added `await mkdir(config.COGNIVAULT_DATA_DIR, { recursive: true })` in registry plugin before calling registry.load()
- **Files modified:** src/plugins/registry.ts
- **Verification:** All 459 tests pass including all existing test suites
- **Committed in:** d021cc7 (Task 2 commit)

**2. [Rule 1 - Bug] Fixed Biome import ordering and formatting in app.ts**
- **Found during:** Task 2 (verification with pnpm check)
- **Issue:** Biome required alphabetical import ordering (registryPlugin before qdrantPlugin) and single-line formatting for redact array
- **Fix:** Reordered imports and collapsed redact array to single line per Biome formatter
- **Files modified:** src/app.ts
- **Verification:** npx biome check passes clean on all modified files
- **Committed in:** d021cc7 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both auto-fixes necessary for correctness and code quality. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- fastify.registry available for Phase 16 auth gateway to replace single-key bearer auth with per-user API key lookup
- fastify.metrics.promRegistry available for any future plugin that needs to register custom Prometheus metrics
- Pino redaction ensures sensitive user data never leaks to logs

---
*Phase: 15-registry-foundation*
*Completed: 2026-03-14*
