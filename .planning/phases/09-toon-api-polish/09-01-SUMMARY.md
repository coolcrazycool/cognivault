---
phase: 09-toon-api-polish
plan: 01
subsystem: api
tags: [toon, content-negotiation, fastify, format-symmetry]

# Dependency graph
requires: []
provides:
  - TOON content-type parser for text/toon request bodies
  - onSend response hook for TOON serialization (Accept or Content-Type driven)
  - TOON-aware error handler (encode errors as TOON when requested)
  - toonPlugin registered in app.ts after auth, before infrastructure
affects: [all-feature-routes, context-pack, search]

# Tech tracking
tech-stack:
  added: ["@toon-format/toon 2.1.0"]
  patterns:
    - "Content negotiation via Fastify addContentTypeParser + onSend hook"
    - "Format symmetry: Content-Type: text/toon alone triggers TOON response (no Accept header needed)"
    - "Health/readiness routes excluded from TOON via skipAuth config check"
    - "Error handler checks Accept/Content-Type before format selection"
    - "as unknown as Record<string, unknown> pattern for routeOptions.config casts"

key-files:
  created:
    - src/plugins/toon.ts
    - src/plugins/__tests__/toon.test.ts
  modified:
    - src/plugins/error-handler.ts
    - src/app.ts
    - package.json
    - pnpm-lock.yaml

key-decisions:
  - "TOON decode returns primitive string for unstructured input (never throws) — added explicit string check to produce INVALID_TOON 400"
  - "Format symmetry: Content-Type: text/toon without Accept header triggers TOON response (locked decision honored)"
  - "TOON encode failures re-throw (no silent fallback to JSON) per locked decision"
  - "Error handler maps INVALID_TOON code before validation check (Fastify may add validation property to parser errors)"
  - "Auth 401 errors TOON-serialized via error handler path — no changes to auth.ts needed"
  - "Tests use minimal Fastify app (not buildApp) to avoid infrastructure dependencies in unit tests"

patterns-established:
  - "Content type plugin: addContentTypeParser regex + onSend hook in single fp() plugin"
  - "TOON-aware error handler: check Accept/Content-Type then format select before send"

requirements-completed: [API-01, API-02, API-03]

# Metrics
duration: 65min
completed: 2026-03-12
---

# Phase 9 Plan 01: TOON Content Negotiation Summary

**TOON plugin added to CogniVault: text/toon request parsing, response serialization with format symmetry, and TOON-aware error handler for ~40% token savings on AI agent traffic**

## Performance

- **Duration:** 65 min
- **Started:** 2026-03-12T05:51:00Z
- **Completed:** 2026-03-12T06:57:13Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- TOON content-type parser handles `text/toon` and `text/toon; charset=utf-8` requests via regex
- onSend hook serializes responses as TOON when `Accept: text/toon` OR `Content-Type: text/toon` (format symmetry)
- Error handler (401, 400, 500) TOON-serializes when TOON requested, with INVALID_TOON code support
- Health/readiness endpoints always return JSON (excluded via `skipAuth` config check)
- 13 integration tests covering all content negotiation scenarios
- toonPlugin registered in app.ts in correct order (after auth, before infrastructure)

## Task Commits

1. **Task 1: Install @toon-format/toon and create TOON plugin with tests** - `7b9edf8` (feat)
2. **Task 2: Make error handler TOON-aware and register plugin in app.ts** - `42e514d` (feat)

## Files Created/Modified

- `src/plugins/toon.ts` - TOON content-type parser and onSend response serialization hook
- `src/plugins/__tests__/toon.test.ts` - 13 integration tests for TOON content negotiation
- `src/plugins/error-handler.ts` - TOON-aware: encodes errors as TOON when requested, INVALID_TOON code mapping
- `src/app.ts` - Registers toonPlugin after auth, before vault/db/embedding/qdrant
- `package.json` / `pnpm-lock.yaml` - Added @toon-format/toon 2.1.0

## Decisions Made

- **TOON decode primitive detection**: `decode()` never throws — returns primitive string for unstructured input. Added explicit `typeof parsed === 'string'` check to reject with `INVALID_TOON 400` as intended by the spec.
- **Format symmetry test adjustment**: Tests calling `response.json()` for responses with `content-type: text/toon` body were fixed to use `decode()` instead. Content-Type: text/toon triggers TOON response format per locked decision.
- **INVALID_TOON code ordering**: `mapErrorToCode` checks `error.code === 'INVALID_TOON'` before `error.validation` check to handle Fastify wrapping behavior.
- **Minimal test app**: Tests use a standalone Fastify app with just error-handler + auth + toon plugins rather than full `buildApp()`, avoiding infrastructure dependencies.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TOON decode never throws — added explicit primitive string rejection**
- **Found during:** Task 1 (TDD GREEN phase)
- **Issue:** Plan assumed `decode()` throws on invalid TOON. Library is lenient: returns primitive string for unstructured input instead of throwing.
- **Fix:** Added `if (typeof parsed === 'string')` check in parser to produce INVALID_TOON 400 error for inputs that don't parse as structured TOON (object/array).
- **Files modified:** src/plugins/toon.ts
- **Verification:** `pnpm test -- --run src/plugins/__tests__/toon.test.ts` — all 13 tests pass
- **Committed in:** 7b9edf8

**2. [Rule 1 - Bug] Test assertions corrected for format symmetry behavior**
- **Found during:** Task 1 (GREEN phase — tests partially failing)
- **Issue:** Tests used `response.json()` for responses with `content-type: text/toon` body, but format symmetry means TOON input triggers TOON output. The response body is TOON, not JSON.
- **Fix:** Changed affected test assertions to use `decode(response.body)` instead of `response.json()`.
- **Files modified:** src/plugins/__tests__/toon.test.ts
- **Verification:** All 13 tests pass
- **Committed in:** 7b9edf8

---

**Total deviations:** 2 auto-fixed (Rule 1 bugs found during TDD GREEN phase)
**Impact on plan:** Both fixes necessary for correctness. No scope creep.

## Issues Encountered

- Pre-existing test failures: 5 test suites fail due to missing `OPENAI_API_KEY` env var in their test setup (auth, db, indexer, health routes, vault routes). These are pre-existing issues unrelated to this plan. Logged in `deferred-items.md`.
- swagger.ts has a TypeScript error (`openapiObject` property) — pre-existing, out of scope.

## Next Phase Readiness

- TOON content negotiation fully operational for all API routes
- AI agents can send `Accept: text/toon` to receive compact TOON responses (~40% token savings)
- Error responses honor format symmetry — agents get consistent TOON errors
- Health/readiness probes unaffected (always JSON)
- Ready for Phase 09 Plan 02 (OpenAPI/Swagger polish)

---
*Phase: 09-toon-api-polish*
*Completed: 2026-03-12*
