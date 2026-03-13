---
phase: 14-infrastructure-hardening-cleanup
verified: 2026-03-12T22:58:00Z
status: human_needed
score: 6/6 must-haves verified
re_verification:
  previous_status: gaps_found
  previous_score: 5/6
  gaps_closed:
    - "pnpm test passes all 27 suites without OPENAI_API_KEY exported in the shell"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Docker named volume persistence across container restarts"
    expected: "SQLite index.db at /data/index.db survives docker-compose down && docker-compose up without re-indexing"
    why_human: "Cannot run Docker containers in this environment to verify volume mount behavior"
  - test: "HighErrorRate Prometheus alert fires after 30m idle, not 5m"
    expected: "Alert state transitions to firing only after 30 minutes of zero search traffic"
    why_human: "Requires a live Prometheus instance and 30+ minutes of observation"
---

# Phase 14: Infrastructure Hardening & Cleanup Verification Report

**Phase Goal:** Fix infrastructure issues, clean up tech debt, and complete documentation gaps
**Verified:** 2026-03-12T22:58:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure plan 14-03

## Re-Verification Summary

Previous verification (2026-03-12T22:20:00Z) found 1 gap: "pnpm test passes" — 5 suites crashed at suite level when `OPENAI_API_KEY` was absent from the shell.

Plan 14-03 closed the gap via two changes:
1. Updated `test` and `test:watch` scripts in `package.json` to use `node --env-file=.env ./node_modules/vitest/vitest.mjs run` instead of bare `vitest run`.
2. Added `vi.mock('openai')` and `vi.mock('@qdrant/js-client-rest')` to all 5 test files that call `buildApp()`, eliminating reliance on live API keys even when `.env` is loaded.

Plan 14-03 also fixed a pre-existing `vault/routes.ts` double-response bug (`handleVaultError` now returns `FastifyReply`) that had been generating 19 `ERR_HTTP_HEADERS_SENT` errors previously masked by suite-level failures. A queue-drain guard was added to `vault/routes.test.ts` to prevent background indexing from competing with sequential route tests.

**Gap closed. No regressions. No new gaps found.**

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SQLite data directory uses a named Docker volume, persisted across container restarts | VERIFIED | `docker-compose.yml` declares `cognivault_data:` top-level volume, mounts at `/data`, `COGNIVAULT_DATA_DIR=/data` set |
| 2 | VaultManager.rootPath accessed via public getter, not unsafe private-field cast | VERIFIED | `src/lib/vault.ts` lines 91-93: `get vaultRootPath(): string`; zero unsafe casts in src/ |
| 3 | Biome lint + typecheck passes cleanly | VERIFIED | `pnpm check` exits 0; 13 warnings and 27 infos (style suggestions only, no errors) |
| 4 | No-op close test in db.test.ts removed | VERIFIED | `expect(true).toBe(true)` gone; replaced with explanatory comment |
| 5 | HighErrorRate alert rule uses `for: 30m` | VERIFIED | `monitoring/prometheus/rules/cognivault.yml` line 38: `for: 30m` |
| 6 | pnpm test passes all 27 suites without live API keys | VERIFIED | Live run: "27 passed (27), 434 passed (434)" — exit 0 |

**Score: 6/6 truths verified**

### Gap Closure Verification

**Truth: "pnpm test passes all 27 suites without OPENAI_API_KEY exported in the shell"**

Previous status: FAILED

Current status: VERIFIED

Evidence:

1. `package.json` line 11 — `"test": "node --env-file=.env ./node_modules/vitest/vitest.mjs run"` loads `.env` before vitest starts.

2. All 5 previously-failing test files have mocks at the top of the file (confirmed by Read tool):
   - `src/plugins/__tests__/auth.test.ts` — `vi.mock('openai', ...)` at lines 8-16, `vi.mock('@qdrant/js-client-rest', ...)` at lines 19-30.
   - `src/plugins/__tests__/db.test.ts` — same mocks at lines 9-16 and 19-30.
   - `src/plugins/__tests__/indexer.test.ts` — same mocks at lines 9-16 and 19-30.
   - `src/features/health/__tests__/routes.test.ts` — same mocks at lines 8-16 and 19-30.
   - `src/features/vault/__tests__/routes.test.ts` — same mocks at lines 8-32.

3. `src/features/vault/routes.ts` `handleVaultError` now returns `FastifyReply` (line 26: `function handleVaultError(err: unknown, reply: FastifyReply): FastifyReply`); all 9 route catch blocks return its result — eliminating `ERR_HTTP_HEADERS_SENT` errors.

4. `src/features/vault/__tests__/routes.test.ts` drains `pipelineQueue.onIdle()` and stops the indexer after `app.ready()` (lines 95-107) before tests run.

5. Live `pnpm test` run output: `Test Files 27 passed (27)` | `Tests 434 passed (434)` | exit 0.

### Regression Check (Previously Passing Truths)

| Truth | Previous Status | Current Status | Regression? |
|-------|----------------|----------------|-------------|
| Docker named volume | VERIFIED | VERIFIED (unchanged) | No |
| VaultManager getter | VERIFIED | VERIFIED (unchanged) | No |
| Biome lint / typecheck | VERIFIED | VERIFIED — `pnpm check` exits 0 | No |
| No-op test removed | VERIFIED | VERIFIED (unchanged) | No |
| Alert `for: 30m` | VERIFIED | VERIFIED (unchanged) | No |
| MON-01 through MON-08 in REQUIREMENTS.md | VERIFIED | VERIFIED — 16 occurrences of `MON-0` confirmed | No |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `package.json` | `test` script with `--env-file=.env` | VERIFIED | Line 11: `node --env-file=.env ./node_modules/vitest/vitest.mjs run` |
| `src/plugins/__tests__/auth.test.ts` | OpenAI + Qdrant mocks | VERIFIED | Both mocks confirmed at file top |
| `src/plugins/__tests__/db.test.ts` | OpenAI + Qdrant mocks | VERIFIED | Both mocks confirmed at file top |
| `src/plugins/__tests__/indexer.test.ts` | OpenAI + Qdrant mocks | VERIFIED | Both mocks confirmed at file top |
| `src/features/health/__tests__/routes.test.ts` | OpenAI + Qdrant mocks | VERIFIED | Both mocks confirmed at file top |
| `src/features/vault/__tests__/routes.test.ts` | OpenAI + Qdrant mocks + queue drain | VERIFIED | Mocks confirmed; `pipelineQueue.onIdle()` drain at lines 95-107 |
| `src/features/vault/routes.ts` | `handleVaultError` returns `FastifyReply` | VERIFIED | Line 26: `function handleVaultError(...): FastifyReply`; all 9 catch blocks return result |
| `src/lib/vault.ts` | `vaultRootPath` getter | VERIFIED | Lines 91-93: `get vaultRootPath(): string` |
| `docker-compose.yml` | Named volume `cognivault_data` at `/data` | VERIFIED | Unchanged from previous verification |
| `monitoring/prometheus/rules/cognivault.yml` | `for: 30m` | VERIFIED | Unchanged from previous verification |
| `.planning/REQUIREMENTS.md` | MON-01 through MON-08 | VERIFIED | 16 occurrences of `MON-0` confirmed |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `package.json test script` | `.env file` | `node --env-file` flag | WIRED | `node --env-file=.env ./node_modules/vitest/vitest.mjs run` |
| Mock declarations | `openai` module | `vi.mock('openai', ...)` in 5 test files | WIRED | All 5 files confirmed |
| Mock declarations | `@qdrant/js-client-rest` module | `vi.mock('@qdrant/js-client-rest', ...)` in 5 test files | WIRED | All 5 files confirmed |
| `vault/routes.ts` catch blocks | `handleVaultError` | `return handleVaultError(err, reply)` | WIRED | 9 catch blocks verified via grep |
| `src/lib/indexer.ts` | `src/lib/vault.ts` | `vaultRootPath` getter | WIRED | Unchanged from previous verification |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| MON-01 | 14-01 | Embedding API calls metric | SATISFIED | Pre-existing from Phase 12; traceability documented in REQUIREMENTS.md |
| MON-02 | 14-01 | Chunks processed + pipeline duration metrics | SATISFIED | Pre-existing from Phase 12; traceability documented |
| MON-03 | 14-01 | Prometheus scrapes /metrics at 15s, 7-day retention | SATISFIED | Pre-existing from Phase 12; traceability documented |
| MON-04 | 14-02 | Four Prometheus alerting rules | SATISFIED | Alert rule file verified; HighErrorRate fixed to `for: 30m` |
| MON-05 | 14-01 | Grafana auto-provisions datasource and dashboards | SATISFIED | Pre-existing from Phase 12; traceability documented |
| MON-06 | 14-02 | Search performance dashboard | SATISFIED | Pre-existing from Phase 12; traceability documented |
| MON-07 | 14-02 | Indexing pipeline dashboard | SATISFIED | Pre-existing from Phase 12; traceability documented |
| MON-08 | 14-02 | System dashboard | SATISFIED | Pre-existing from Phase 12; traceability documented |

All 8 MON requirements satisfied.

### Anti-Patterns Found

No blockers. The biome warnings are pre-existing style suggestions — not errors, not introduced by this phase.

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `src/lib/vault.ts` | `useTemplate` style warnings | Info | No functional impact; `pnpm check` exits 0 |
| `src/plugins/__tests__/pipeline.test.ts` | `useLiteralKeys` style warnings | Info | No functional impact |
| `src/features/admin/__tests__/service.test.ts` | `noNonNullAssertion` warnings | Warning | Style only; tests pass |
| `src/features/context/__tests__/service.test.ts` | `noNonNullAssertion` warnings | Warning | Style only; tests pass |

### Human Verification Required

#### 1. Docker Volume Persistence

**Test:** Run `docker-compose up -d`, wait for indexing, run `docker-compose down`, run `docker-compose up -d` again
**Expected:** SQLite index.db at `/data/index.db` inside the container persists; indexed file count matches pre-restart count; no full re-index triggered
**Why human:** Cannot run Docker containers in this environment

#### 2. HighErrorRate Alert Timing

**Test:** Start the monitoring stack with no search traffic for 30+ minutes, check Prometheus alerts page
**Expected:** HighErrorRate alert transitions to "pending" then "firing" only at the 30-minute mark — not the old 5-minute mark
**Why human:** Requires live Prometheus instance and sustained idle period observation

---

## Summary

All 6 automated must-haves are now verified. The single gap from the initial verification is closed:

- `pnpm test` exits 0 with 27 suites and 434 tests passing. The test script loads `.env` via `node --env-file=.env`, and all 5 previously-failing suites have proper OpenAI and Qdrant mocks eliminating live API dependencies.
- Bonus fix delivered: `vault/routes.ts` double-response bug eliminated; 19 `ERR_HTTP_HEADERS_SENT` errors gone.
- No regressions introduced. `pnpm check` exits 0.

The two human verification items (Docker volume persistence and Prometheus alert timing) remain open — these require a live infrastructure environment and cannot be verified programmatically.

---

_Verified: 2026-03-12T22:58:00Z_
_Verifier: Claude (gsd-verifier)_
