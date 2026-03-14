---
phase: 16-per-user-container-stack
plan: 01
subsystem: auth
tags: [multi-tenant, auth, prom-client, fastify-plugin, user-registry]

# Dependency graph
requires:
  - phase: 15-registry-foundation
    provides: UserRegistry class and registry Fastify plugin
provides:
  - Registry-backed multi-tenant auth via fastify.registry.getUserByApiKey()
  - request.user populated with UserRecord on authenticated requests
  - cognivault_auth_failures_total Prometheus counter
  - Declaration merging for FastifyRequest.user
affects: [17-per-user-scoping, 18-vault-isolation, 19-obsidian-sync]

# Tech tracking
tech-stack:
  added: []
  removed: [@fastify/bearer-auth]
  patterns: [registry-backed auth lookup, request.user decoration, generic 401 responses]

key-files:
  created: []
  modified:
    - src/plugins/auth.ts
    - src/plugins/__tests__/auth.test.ts
    - src/config.ts

key-decisions:
  - "Auth plugin depends on registry and metrics plugins via fp() dependencies array"
  - "Single generic 401 response for all auth failure modes to prevent information leakage"
  - "Auth failure counter registered on shared promRegistry for Prometheus scraping"
  - "request.log enriched with userId via child logger after successful auth"

patterns-established:
  - "Registry auth pattern: extract Bearer token, lookup via registry.getUserByApiKey(), attach to request.user"
  - "Test mock pattern for custom Fastify apps: register mock metrics/registry as named fp plugins to satisfy dependency checks"

requirements-completed: [TENANT-01]

# Metrics
duration: 10min
completed: 2026-03-14
---

# Phase 16 Plan 01: Registry Auth Summary

**Registry-backed multi-tenant auth replacing static API key, with request.user decoration, Prometheus failure counter, and generic 401 responses**

## Performance

- **Duration:** 10 min
- **Started:** 2026-03-14T06:47:07Z
- **Completed:** 2026-03-14T06:57:10Z
- **Tasks:** 3
- **Files modified:** 20

## Accomplishments
- Replaced static COGNIVAULT_API_KEY auth with registry-backed multi-tenant auth via UserRegistry
- Every authenticated request now carries request.user with the resolved UserRecord
- Migrated all 18 test files from static API key to registry-backed auth patterns
- Removed @fastify/bearer-auth dependency entirely

## Task Commits

Each task was committed atomically:

1. **Task 1: Remove static API key config and uninstall @fastify/bearer-auth** - `0c09441` (chore)
2. **Task 2 RED: Add failing tests for registry-backed auth** - `983a534` (test)
3. **Task 2 GREEN: Rewrite auth plugin with registry-backed auth** - `6b35bff` (feat)
4. **Task 3: Full suite validation and cleanup** - `19361b4` (fix)

## Files Created/Modified
- `src/config.ts` - Removed COGNIVAULT_API_KEY from Zod config schema
- `src/plugins/auth.ts` - Rewrote from @fastify/bearer-auth to custom registry-backed onRequest hook
- `src/plugins/__tests__/auth.test.ts` - Comprehensive tests for registry-backed auth (8 test cases)
- `package.json` / `pnpm-lock.yaml` - Removed @fastify/bearer-auth dependency
- 16 test files across features/ and plugins/ - Migrated from static API key to registry auth

## Decisions Made
- Auth plugin uses fp() with dependencies: ['registry', 'metrics'] for proper plugin ordering
- Single UNAUTHORIZED_RESPONSE constant used for all 401 cases (no information leakage)
- Custom app test files use named fp-wrapped mock plugins to satisfy Fastify dependency checks
- request.log enriched with userId child logger for structured logging correlation

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Named fp-wrapped mock plugins for test dependency resolution**
- **Found during:** Task 3 (Full suite validation)
- **Issue:** Tests building custom Fastify apps with `app.decorate()` mocks failed because auth plugin's fp() wrapper validates named plugin dependencies ('registry', 'metrics')
- **Fix:** Wrapped mock decorations in `fp(async (f) => { f.decorate(...) }, { name: 'registry' })` pattern
- **Files modified:** search/routes.test.ts, context/routes.test.ts, admin/routes.test.ts, swagger.test.ts, toon.test.ts
- **Verification:** All 5 test files pass
- **Committed in:** 19361b4

**2. [Rule 3 - Blocking] Added promRegistry to metrics mock for auth Counter registration**
- **Found during:** Task 3 (Full suite validation)
- **Issue:** Auth plugin creates a prom-client Counter on fastify.metrics.promRegistry, but custom test app metrics mocks lacked promRegistry
- **Fix:** Added `new PromRegistry()` to metrics mock in test files using custom Fastify apps
- **Files modified:** search/routes.test.ts, context/routes.test.ts, admin/routes.test.ts, swagger.test.ts, toon.test.ts
- **Verification:** Counter creation succeeds, auth plugin initializes correctly
- **Committed in:** 19361b4

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both fixes necessary to make auth plugin's dependency system work with test mocks. No scope creep.

## Issues Encountered
- Pre-existing test failure in vault/routes.test.ts (malformed YAML frontmatter warning test) documented in deferred-items.md. Unrelated to auth changes.

## User Setup Required

None - no external service configuration required. The COGNIVAULT_API_KEY environment variable is no longer needed; authentication is handled by the user registry (users.json in COGNIVAULT_DATA_DIR).

## Next Phase Readiness
- Auth foundation complete: every request resolves to a UserRecord
- request.user.userId available for per-user data scoping in Phase 17
- request.user.vaultPath and request.user.openaiKey available for per-user resource isolation

---
*Phase: 16-per-user-container-stack*
*Completed: 2026-03-14*
