---
phase: 20-docker-and-integration-hardening
plan: "03"
subsystem: testing
tags: [integration-test, vitest, docker, tenant-isolation, qdrant, smoke-test, healthcheck]

# Dependency graph
requires:
  - phase: 20-docker-and-integration-hardening
    provides: plan 01 Dockerfile with tini; VAULT_PATH optional for v2.0 mode
  - phase: 17-18-multi-tenant
    provides: TenantQdrantClient with user_id filter injection
  - phase: 18-multi-tenant-refactor
    provides: per-user pipeline, indexer, embedder, and createTenantQdrant
provides:
  - vitest.integration.config.ts for running test/ directory integration tests
  - test/isolation.test.ts proving tenant isolation via real Qdrant user_id filters
  - test/docker-smoke.sh verifying Docker image boots and /health returns 200
  - Dockerfile HEALTHCHECK instruction for docker inspect health status
affects: [ci-cd, deployment-verification, infra-qa]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - describe.skipIf guard for conditional integration test execution (QDRANT_URL + OPENAI_API_KEY)
    - Separate vitest config for test/ vs src/ to keep unit/integration test sets independent
    - Docker HEALTHCHECK using Node.js fetch API (no curl dependency needed in image)
    - PID in container name avoids smoke test collision with parallel runs

key-files:
  created:
    - vitest.integration.config.ts
    - test/isolation.test.ts
    - test/docker-smoke.sh
  modified:
    - Dockerfile

key-decisions:
  - "describe.skipIf(!QDRANT_URL || !OPENAI_API_KEY) guards isolation test - skips cleanly in CI without real Qdrant/OpenAI"
  - "HEALTHCHECK added to Dockerfile via Rule 3 auto-fix - required for docker inspect to report 'healthy' status used by smoke test"
  - "HEALTHCHECK uses Node.js fetch API (node -e) not curl - avoids adding curl to production image"
  - "Isolation test uses admin reindex endpoint + job polling instead of direct Qdrant upsert - tests the full indexing pipeline"
  - "Lexical search added as Test 4 instead of vault note read - v2.0 has no per-user vault routing; search is the correct isolation boundary"
  - "afterAll purges test vectors from Qdrant via app.purgeUserVectors - best-effort cleanup, non-fatal on error"

patterns-established:
  - "Integration tests in test/ use separate vitest.integration.config.ts; unit tests in src/ use vitest.config.ts"
  - "Docker smoke test pattern: build -> run -> poll docker inspect -> curl /health -> cleanup on EXIT trap"

requirements-completed: [INFRA-03]

# Metrics
duration: 5min
completed: 2026-03-14
---

# Phase 20 Plan 03: Integration Tests and Docker Smoke Test Summary

**Vitest integration config + tenant isolation test (search user_id filter isolation via real Qdrant) + Docker smoke test (HEALTHCHECK + /health 200); Dockerfile HEALTHCHECK added as auto-fix**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-14T13:31:42Z
- **Completed:** 2026-03-14T13:34:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- `vitest.integration.config.ts` added — separates integration tests from unit tests, includes `test/**/*.test.ts` with 30s timeouts
- `test/isolation.test.ts` proves INFRA-03: User B's semantic and lexical searches return 0 results for content indexed by User A; skips cleanly without QDRANT_URL or OPENAI_API_KEY
- `test/docker-smoke.sh` verified: builds image, starts container, healthcheck passes in ~15s, `/health` returns 200, outputs "SMOKE TEST PASSED"
- Dockerfile HEALTHCHECK added (Rule 3 auto-fix) — uses Node.js fetch API, interval=5s, start-period=10s

## Task Commits

Each task was committed atomically:

1. **Task 1: Create vitest integration config and tenant isolation test** - `dbf195a` (feat)
2. **Task 2: Create Docker smoke test script** - `da7ec43` (feat)

**Plan metadata:** (to be added by final commit)

## Files Created/Modified
- `vitest.integration.config.ts` - Separate Vitest config for `test/` directory, 30s timeouts
- `test/isolation.test.ts` - Tenant isolation integration test; 4 test cases proving User B cannot access User A's data via search
- `test/docker-smoke.sh` - Docker smoke test; builds, runs, polls healthcheck, curls /health, cleans up
- `Dockerfile` - Added HEALTHCHECK instruction (Rule 3 auto-fix)

## Decisions Made
- Dockerfile HEALTHCHECK uses `node -e "fetch(...)"` (Node.js v22 built-in fetch) not curl — keeps the production image slim without adding curl as a dependency
- Tenant isolation tests cover semantic and lexical search (both use TenantQdrantClient user_id filter) rather than vault note read endpoints — vault routes use global `fastify.vault` which doesn't exist in v2.0 multi-tenant mode without VAULT_PATH
- Test uses admin reindex endpoint + polling loop to trigger real indexing through the full pipeline (indexer -> pipeline -> embedding -> Qdrant upsert)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added HEALTHCHECK to Dockerfile**
- **Found during:** Task 2 (Docker smoke test)
- **Issue:** Dockerfile had no HEALTHCHECK; `docker inspect --format='{{.State.Health.Status}}'` returned empty string, so the smoke test loop never detected "healthy" and timed out after 60s
- **Fix:** Added `HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch(...)"` to Dockerfile
- **Files modified:** `Dockerfile`
- **Verification:** Smoke test ran successfully — container became healthy after ~15s, /health returned 200, "SMOKE TEST PASSED"
- **Committed in:** `da7ec43` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 3 — blocking issue)
**Impact on plan:** HEALTHCHECK is a required correctness fix; without it the smoke test cannot verify container health. No scope creep.

## Issues Encountered
- Dockerfile was missing HEALTHCHECK — smoke test could not detect container health status. Fixed by adding HEALTHCHECK via Rule 3.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Integration test infrastructure in place for CI pipelines
- Smoke test verifies Docker image correctness on every build
- Tenant isolation proven via real Qdrant user_id filter injection
- Phase 20 complete: Docker hardening, Grafana metrics, and integration testing all done

---
*Phase: 20-docker-and-integration-hardening*
*Completed: 2026-03-14*

## Self-Check: PASSED

- vitest.integration.config.ts: FOUND
- test/isolation.test.ts: FOUND
- test/docker-smoke.sh: FOUND
- .planning/phases/20-docker-and-integration-hardening/20-03-SUMMARY.md: FOUND
- Commit dbf195a: FOUND (Task 1)
- Commit da7ec43: FOUND (Task 2)
