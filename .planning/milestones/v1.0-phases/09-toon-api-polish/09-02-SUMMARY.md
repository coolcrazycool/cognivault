---
phase: 09-toon-api-polish
plan: 02
subsystem: api
tags: [openapi, swagger, swagger-ui, fastify-swagger, documentation, text/toon]

# Dependency graph
requires:
  - phase: 09-toon-api-polish plan 01
    provides: TOON content negotiation plugin registered in app.ts
  - phase: 01-project-skeleton
    provides: Fastify app factory (buildApp), auth plugin with skipAuth pattern
provides:
  - OpenAPI 3.0 spec auto-generated from TypeBox route schemas at /docs/json and /docs/yaml
  - Swagger UI served at /docs without authentication
  - text/toon documented as accepted content type alongside application/json in all non-health routes
  - bearerAuth security scheme documented in OpenAPI spec
affects:
  - future API consumers discovering endpoints via /docs
  - agents querying /docs/json for programmatic API discovery

# Tech tracking
tech-stack:
  added:
    - "@fastify/swagger 9.7.0 — OpenAPI spec generation from TypeBox schemas"
    - "@fastify/swagger-ui 5.2.5 — Interactive Swagger UI at /docs"
  patterns:
    - "transformObject hook on @fastify/swagger used to inject text/toon into all non-health content types"
    - "Auth bypass for /docs prefix via URL check in global onRequest hook (not per-route config)"

key-files:
  created:
    - src/plugins/swagger.ts
    - src/plugins/__tests__/swagger.test.ts
  modified:
    - src/app.ts
    - src/plugins/auth.ts
    - package.json
    - pnpm-lock.yaml

key-decisions:
  - "transformObject hook injects text/toon into requestBody and response content types for all non-health paths — single location ensures consistency across all routes"
  - "Auth bypass for /docs via URL prefix check (request.url.startsWith('/docs')) instead of per-route config.skipAuth — swagger-ui routes cannot receive custom config via uiHooks"
  - "swaggerPlugin registered after auth but before infrastructure plugins (vault/db/embedder) — captures all route schemas registered after it"
  - "Test uses lightweight mock-based app instead of full buildApp() — avoids real OpenAI API call during validate() in embeddingPlugin"

patterns-established:
  - "Swagger plugin pattern: fp()-wrapped, registered after auth before features, uses transformObject for content type injection"
  - "URL-prefix auth bypass: check request.url.startsWith('/prefix') as alternative to skipAuth config for third-party routes"

requirements-completed: [INF-02]

# Metrics
duration: 8min
completed: 2026-03-12
---

# Phase 09 Plan 02: Swagger / OpenAPI Documentation Summary

**OpenAPI 3.0 spec auto-generated from TypeBox route schemas with Swagger UI at /docs, text/toon documented alongside application/json in all non-health route content types**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-12T09:50:07Z
- **Completed:** 2026-03-12T09:57:59Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files modified:** 6

## Accomplishments

- Swagger UI served at /docs with full interactive API documentation
- OpenAPI 3.0 spec at /docs/json and /docs/yaml with all registered route schemas
- text/toon injected alongside application/json in all non-health endpoint content types via transformObject hook
- bearerAuth security scheme with global security requirement documented in spec
- /docs endpoints bypass authentication via URL prefix check in auth plugin

## Task Commits

TDD execution with separate RED and GREEN commits:

1. **Task 1 RED: Failing swagger tests** - `71d5700` (test)
2. **Task 1 GREEN: Swagger plugin implementation** - `54e6da6` (feat)

## Files Created/Modified

- `src/plugins/swagger.ts` — Fastify plugin wrapping @fastify/swagger + @fastify/swagger-ui; registers OpenAPI 3.0 spec with bearerAuth scheme; uses transformObject to inject text/toon content type
- `src/plugins/__tests__/swagger.test.ts` — 7 tests covering /docs, /docs/json, /docs/yaml, auth bypass, bearerAuth scheme, paths presence, and text/toon content type
- `src/app.ts` — Added swaggerPlugin registration after auth, before toonPlugin and infrastructure plugins
- `src/plugins/auth.ts` — Added URL prefix check (request.url.startsWith('/docs')) to skip auth for Swagger UI routes
- `package.json` — Added @fastify/swagger 9.7.0 and @fastify/swagger-ui 5.2.5 as production dependencies
- `pnpm-lock.yaml` — Updated lockfile

## Decisions Made

- **transformObject for text/toon injection:** The `transformObject` hook on @fastify/swagger receives the final assembled OpenAPI spec object and returns a modified version. This is the correct place to inject text/toon — it runs after all route schemas are merged, ensuring all paths get the content type.
- **URL prefix auth bypass:** The auth plugin's global `onRequest` hook runs before swagger-ui's per-route `uiHooks.onRequest`. The `uiHooks` mechanism only adds to route handlers, not before the global hook. Adding `request.url.startsWith('/docs')` to the auth hook is the correct bypass pattern for third-party plugin routes that can't receive `config.skipAuth`.
- **Mock-based test app for swagger:** Using `buildApp()` triggers `embeddingPlugin.validate()` which makes a real OpenAI API call. The swagger test builds a lightweight app with mocked services, following the pattern established in search/context route tests.
- **swaggerPlugin position in app.ts:** Placed after auth (swagger-ui hooks need auth already registered to override it) and before feature routes (must be registered before routes to capture their schemas).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added URL-prefix auth bypass for /docs routes in auth plugin**
- **Found during:** Task 1 GREEN (swagger plugin implementation)
- **Issue:** The plan specified using `uiHooks: { onRequest: (_req, _reply, next) => next() }` to bypass auth, but this only sets the route-level hook for swagger-ui static routes. The global `onRequest` hook added by the auth plugin runs BEFORE per-route hooks, so all /docs routes were returning 401.
- **Fix:** Added `if (request.url.startsWith('/docs')) { return; }` to the auth plugin's global onRequest hook
- **Files modified:** src/plugins/auth.ts
- **Verification:** Tests confirm GET /docs without Authorization header returns 200
- **Committed in:** 54e6da6 (Task 1 GREEN commit)

**2. [Rule 2 - Missing Critical] Switched test from full buildApp() to mock-based app**
- **Found during:** Task 1 GREEN (test setup)
- **Issue:** buildApp() triggers embeddingPlugin which calls OpenAI validate() — a real network request that fails with a fake key. Other route tests (search, context) use mock apps for the same reason.
- **Fix:** Built a lightweight Fastify app with mocked qdrant, embedder, vault, db, indexer — same pattern as search routes tests
- **Files modified:** src/plugins/__tests__/swagger.test.ts
- **Verification:** All 7 swagger tests pass without real network calls
- **Committed in:** 54e6da6 (Task 1 GREEN commit)

---

**Total deviations:** 2 auto-fixed (both Rule 2 - missing critical for test environment and auth bypass)
**Impact on plan:** Both fixes necessary for correctness. The auth bypass is the correct implementation of the plan's intent (docs accessible without auth); the mock app is the established project pattern for integration tests.

## Issues Encountered

- Pre-existing test failures in 5 files (health/auth/db/indexer/vault routes tests) caused by plan 09-01's addition of OPENAI_API_KEY to config without updating all test files. These are out of scope for this plan — all 235 individual test cases in non-broken files pass.

## Next Phase Readiness

- Swagger UI at /docs and OpenAPI spec at /docs/json ready for API discovery
- text/toon documented in spec for all non-health routes
- INF-02 requirement fulfilled
- Plans 09-03 and beyond can proceed independently

## Self-Check: PASSED

- src/plugins/swagger.ts: FOUND
- src/plugins/__tests__/swagger.test.ts: FOUND
- .planning/phases/09-toon-api-polish/09-02-SUMMARY.md: FOUND
- Commit 71d5700 (TDD RED): FOUND
- Commit 54e6da6 (TDD GREEN): FOUND

---
*Phase: 09-toon-api-polish*
*Completed: 2026-03-12*
