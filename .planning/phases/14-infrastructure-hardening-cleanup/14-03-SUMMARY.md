---
phase: 14-infrastructure-hardening-cleanup
plan: 03
subsystem: testing
tags: [vitest, openai, qdrant, env-file, test-isolation, node-env-file]

# Dependency graph
requires:
  - phase: 14-infrastructure-hardening-cleanup
    provides: Phase 14 foundation (persistent volumes, VaultManager getter, alert rule fixes)
provides:
  - Reliable pnpm test exit 0 without manual OPENAI_API_KEY export
  - OpenAI and Qdrant mocks in all buildApp() test files
  - vault/routes.ts double-response fix eliminating 19 ERR_HTTP_HEADERS_SENT errors
affects: [testing, ci-cd, developer-experience]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Use node --env-file=.env to load .env before vitest instead of bare vitest run
    - vi.mock('openai') + vi.mock('@qdrant/js-client-rest') required in all test files that call buildApp()
    - handleVaultError must return FastifyReply (return reply.status().send()) to prevent double-response in Fastify v5

key-files:
  created: []
  modified:
    - package.json
    - src/features/vault/routes.ts
    - src/plugins/__tests__/auth.test.ts
    - src/plugins/__tests__/db.test.ts
    - src/plugins/__tests__/indexer.test.ts
    - src/features/health/__tests__/routes.test.ts
    - src/features/vault/__tests__/routes.test.ts

key-decisions:
  - "node --env-file=.env ./node_modules/vitest/vitest.mjs run used instead of bare vitest run - vitest.mjs (not .bin/vitest shell script) required for node --env-file flag to work"
  - "OpenAI mock required in auth.test.ts, db.test.ts, indexer.test.ts, health/routes.test.ts, vault/routes.test.ts - .env OPENAI_API_KEY lacks model.request scope; tests must not make live API calls"
  - "vault/routes.ts handleVaultError changed from void to return FastifyReply to prevent Fastify v5 double-response - 19 ERR_HTTP_HEADERS_SENT unhandled errors eliminated"
  - "vault/routes.test.ts stops indexer + waits for pipelineQueue.onIdle() after app.ready() to prevent background processing interference during tests"

patterns-established:
  - "Test files using buildApp() must mock openai and @qdrant/js-client-rest to avoid live API dependencies"
  - "Route error handlers that call reply.send() must return the result to signal Fastify the response is handled"

requirements-completed: [MON-01, MON-02, MON-03, MON-04, MON-05, MON-06, MON-07, MON-08]

# Metrics
duration: 21min
completed: 2026-03-12
---

# Phase 14 Plan 03: Test Environment Stability Summary

**node --env-file=.env test script, OpenAI/Qdrant mocks in 5 test files, and vault routes double-response fix bring all 27 suites to clean exit 0**

## Performance

- **Duration:** 21 min
- **Started:** 2026-03-12T19:28:57Z
- **Completed:** 2026-03-12T19:49:57Z
- **Tasks:** 1
- **Files modified:** 7

## Accomplishments
- pnpm test now exits 0 with all 27 suites and 434 tests passing reliably
- Test files that call buildApp() now mock OpenAI and Qdrant to avoid live API dependencies
- Fixed vault/routes.ts double-response bug (handleVaultError returns FastifyReply) that caused 19 ERR_HTTP_HEADERS_SENT unhandled errors

## Task Commits

1. **Task 1: Add --env-file=.env to test scripts in package.json** - `25beed1` (fix)

**Plan metadata:** (docs commit to follow)

## Files Created/Modified
- `package.json` - Updated test/test:watch to use `node --env-file=.env ./node_modules/vitest/vitest.mjs run`
- `src/features/vault/routes.ts` - Fixed handleVaultError to return FastifyReply, eliminating double-response
- `src/plugins/__tests__/auth.test.ts` - Added vi.mock(openai), vi.mock(@qdrant/js-client-rest), OPENAI_API_KEY env var
- `src/plugins/__tests__/db.test.ts` - Added vi.mock(openai), vi.mock(@qdrant/js-client-rest), OPENAI_API_KEY env var
- `src/plugins/__tests__/indexer.test.ts` - Added vi.mock(openai), vi.mock(@qdrant/js-client-rest), OPENAI_API_KEY env var
- `src/features/health/__tests__/routes.test.ts` - Added vi.mock(openai), vi.mock(@qdrant/js-client-rest), OPENAI_API_KEY env var
- `src/features/vault/__tests__/routes.test.ts` - Added vi.mock(openai), vi.mock(@qdrant/js-client-rest), OPENAI_API_KEY env var; stop indexer + await pipelineQueue.onIdle() in beforeAll

## Decisions Made
- Used `node --env-file=.env ./node_modules/vitest/vitest.mjs run` rather than `./node_modules/.bin/vitest` (the .bin entry is a shell script, not a node module, so --env-file flag cannot be applied to it directly)
- The .env OPENAI_API_KEY has insufficient scope (missing model.request) for OpenAI embeddings validation; all tests using buildApp() must mock OpenAI rather than rely on the real key
- vault/routes.ts handleVaultError changed from `void` to `return FastifyReply` to match Fastify v5 route handler contract; without the return value, Fastify attempts a second response send on the undefined return

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added OpenAI and Qdrant mocks to 5 test files calling buildApp()**
- **Found during:** Task 1 (Add --env-file=.env to test scripts)
- **Issue:** auth.test.ts, db.test.ts, indexer.test.ts, health/routes.test.ts, vault/routes.test.ts all call buildApp() without mocking OpenAI. With --env-file=.env loading the .env key, the embedding plugin validates via live API call but returns 401 (key lacks model.request scope). Tests fail.
- **Fix:** Added vi.mock('openai') and vi.mock('@qdrant/js-client-rest') with appropriate mock implementations to all 5 files. Also set OPENAI_API_KEY='test-openai-key' in process.env in each.
- **Files modified:** 5 test files listed above
- **Verification:** All 27 test suites pass after mocks added
- **Committed in:** 25beed1

**2. [Rule 1 - Bug] Fixed vault/routes.ts double-response causing 19 ERR_HTTP_HEADERS_SENT errors**
- **Found during:** Task 1 (verifying all 27 suites pass)
- **Issue:** handleVaultError called reply.status().send() for VaultErrors then returned void. Route handlers fell through to return undefined, causing Fastify v5 to attempt a second response finalization. This generated 19 unhandled ERR_HTTP_HEADERS_SENT rejections that failed the pnpm test exit code.
- **Fix:** Changed handleVaultError return type from void to FastifyReply, returning reply.status().send(...). All 9 route handler catch blocks changed to return handleVaultError(...).
- **Files modified:** src/features/vault/routes.ts
- **Verification:** Vault routes test exits without errors; pnpm test exits 0
- **Committed in:** 25beed1

**3. [Rule 1 - Bug] Added indexer stop + pipeline queue drain in vault/routes.test.ts beforeAll**
- **Found during:** Task 1 (debugging ERR_HTTP_HEADERS_SENT)
- **Issue:** Vault routes test created markdown files in vault root before app started. On app.ready(), indexer scanned and found them, pipeline queued processing tasks. Background processing competed with sequential inject() tests.
- **Fix:** Stop indexer and wait for pipelineQueue.onIdle() after app.ready() before tests execute.
- **Files modified:** src/features/vault/__tests__/routes.test.ts
- **Verification:** Test runs cleanly without unhandled errors
- **Committed in:** 25beed1

---

**Total deviations:** 3 auto-fixed (all Rule 1 - Bug)
**Impact on plan:** All auto-fixes necessary to achieve clean pnpm test exit 0. The --env-file change exposed pre-existing test isolation bugs that were previously masked by ZodError failures. No scope creep.

## Issues Encountered
- `.bin/vitest` is a bash shim, not a Node.js module — cannot be used directly with `node --env-file=.env`. Used `./node_modules/vitest/vitest.mjs` instead (the actual ESM entry point per vitest's package.json bin declaration).
- The OPENAI_API_KEY in .env has org-level restrictions lacking `model.request` scope — embedding validation makes live API call that returns 401. Fix was to mock OpenAI in all integration test files.

## Self-Check

Files verified:
- [x] package.json updated with --env-file=.env
- [x] src/features/vault/routes.ts handleVaultError returns FastifyReply
- [x] 5 test files have vi.mock('openai') and vi.mock('@qdrant/js-client-rest')
- [x] All 27 suites pass, exit code 0 (verified 3 consecutive runs)

## Self-Check: PASSED

All committed files exist. pnpm test exits 0 consistently. pnpm check exits 0.

## Next Phase Readiness
- Phase 14 infrastructure hardening complete — test suite fully green in fresh shell
- No blockers for v1.0 milestone completion

---
*Phase: 14-infrastructure-hardening-cleanup*
*Completed: 2026-03-12*
