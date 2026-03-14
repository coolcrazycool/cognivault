---
phase: 16-per-user-container-stack
plan: 01
verified: 2026-03-14T10:05:00Z
status: passed
score: 7/7 must-haves verified
re_verification:
  previous_status: human_needed
  previous_score: 7/8
  previous_scope: "Docker container stack (Dockerfile.combined, docker-compose.yml) — different scope from this plan"
  note: "Previous VERIFICATION.md was for a Docker container sub-plan. This verification covers Plan 01: registry-backed auth."
  gaps_closed: []
  gaps_remaining:
    - "pnpm check import ordering gap resolved by commit 9319b16"
gaps:
  - truth: "pnpm check passes (typecheck + lint + format)"
    status: resolved
    reason: "biome check exits 1 due to assist/source/organizeImports violations in 4 test files modified by commit 19361b4. The pnpm lint command alone exits 0. Only the import-ordering assist rule fails. All violations are auto-fixable with pnpm format."
    artifacts:
      - path: "src/features/admin/__tests__/routes.test.ts"
        issue: "Import order: prom-client import must precede vitest import (assist/source/organizeImports)"
      - path: "src/features/context/__tests__/routes.test.ts"
        issue: "Import order: prom-client import must precede vitest import (assist/source/organizeImports)"
      - path: "src/features/search/__tests__/routes.test.ts"
        issue: "Import order: prom-client import must precede vitest import (assist/source/organizeImports)"
      - path: "src/lib/__tests__/user-registry.test.ts"
        issue: "Import order: type import must precede value import for same module (assist/source/organizeImports)"
    missing:
      - "Run pnpm format (biome format --write src/) to auto-fix all 4 import ordering violations"
      - "Confirm pnpm check exits 0 after formatting"
---

# Phase 16 Plan 01: Registry Auth Verification Report

**Phase Goal:** Every API request is authenticated against the registry and carries a resolved user context
**Verified:** 2026-03-14T10:05:00Z
**Status:** gaps_found — 1 gap: `pnpm check` exits 1 due to import ordering in 4 migrated test files
**Re-verification:** Yes — previous VERIFICATION.md existed but covered a different scope (Docker container stack sub-plan). This is an initial verification of Plan 01 (registry-backed auth).

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A request with a valid registry API key receives 200 with request.user populated | VERIFIED | auth.test.ts tests 4 and 8 pass: alice gets userId=alice, bob gets userId=bob; 8/8 tests green |
| 2 | A request with an unknown API key receives 401 Unauthorized | VERIFIED | auth.test.ts test 2: `Bearer wrong-key` returns 401 with exact `{error:{code:"UNAUTHORIZED"}}` body |
| 3 | A request with no Authorization header receives 401 Unauthorized | VERIFIED | auth.test.ts test 1: missing header returns identical 401 body; no information leakage |
| 4 | After user removal from registry, that user's key returns 401 | VERIFIED | auth.ts line 48: every request re-queries live `fastify.registry.getUserByApiKey(token)` — no caching; registry hot-reload is Phase 15 infrastructure, already in place |
| 5 | Route handlers can access request.user.userId | VERIFIED | auth.ts lines 6-10: declaration merging adds `user?: UserRecord` to FastifyRequest; line 54: `request.user = user`; test-only route returns userId; auth.test.ts test 8 confirms correct value |
| 6 | Health and readiness endpoints work without auth | VERIFIED | health/routes.ts lines 8-10, 23-25: `config: { skipAuth: true }` on both; auth.test.ts test 5 confirms `/health` returns 200 without Authorization header |
| 7 | Auth failure counter increments on each failed attempt | VERIFIED | auth.ts lines 25-29: Counter `cognivault_auth_failures_total` on `fastify.metrics.promRegistry`; lines 44/50: `authFailures.inc()` on all failure paths; auth.test.ts test 7 confirms counter value changes after failed request |
| 8 | pnpm check passes (typecheck + lint + format) | FAILED | `pnpm typecheck` exits 0; `pnpm lint` exits 0 (18 warnings, 0 errors); `biome check` exits 1 — 4 import-ordering violations (assist/source/organizeImports) in test files modified by commit 19361b4 |

**Score: 7/8 truths verified**

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/plugins/auth.ts` | Custom onRequest hook with registry-backed auth; contains `fastify.registry.getUserByApiKey` | VERIFIED | 59 lines; full implementation — extractBearerToken helper, UNAUTHORIZED_RESPONSE constant, Counter registration, onRequest hook skipping skipAuth+docs, registry lookup, request.user assignment, child logger; exported via fp() with dependencies |
| `src/plugins/__tests__/auth.test.ts` | Registry-based auth tests; references `request.user` | VERIFIED | 204 lines; 8 test cases covering: no header, invalid token, non-Bearer scheme, valid key+user population, health skipAuth, custom skipAuth route, counter increment, userId in handler; all 8 pass |
| `src/config.ts` | Config schema without COGNIVAULT_API_KEY | VERIFIED | 19 lines; schema fields: PORT, HOST, LOG_LEVEL, VAULT_PATH, QDRANT_URL, COGNIVAULT_DATA_DIR, POLL_INTERVAL_MS, STABILITY_DELAY_MS, OPENAI_API_KEY, OPENAI_BASE_URL, EMBEDDING_MODEL, OTEL_EXPORTER_OTLP_ENDPOINT — COGNIVAULT_API_KEY absent |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/plugins/auth.ts` | `src/plugins/registry.ts` | `fastify.registry.getUserByApiKey(token)` | WIRED | Line 48: exact call present; pattern `registry\.getUserByApiKey` matches |
| `src/plugins/auth.ts` | `src/lib/user-registry.ts` | `import type { UserRecord } from '../lib/user-registry.js'` | WIRED | Line 4: type import present; declaration merging at lines 6-10 adds `user?: UserRecord` to FastifyRequest interface |
| `src/plugins/auth.ts` | `prom-client` | Counter on `fastify.metrics.promRegistry`; name `cognivault_auth_failures_total` | WIRED | Line 3: `import { Counter } from 'prom-client'`; line 28: `registers: [fastify.metrics.promRegistry]`; name matches plan spec |
| `src/app.ts` | `src/plugins/auth.ts` | `await app.register(authPlugin)` | WIRED | app.ts line 96: authPlugin registered after metricsPlugin (line 94) and registryPlugin (line 95); plugin ordering satisfies fp() dependency declarations |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| TENANT-01 | 16-01-PLAN.md | CogniVault serves multiple users from a single process, routing each request to the correct user's vault and Qdrant tenant by API key | SATISFIED | Auth plugin resolves every request to a UserRecord via registry API key lookup; `request.user` carries userId, vaultPath, and openaiKey for downstream per-user routing in Phases 17-19; REQUIREMENTS.md line 90 marks TENANT-01 Complete at Phase 16 |

**Orphaned requirements check:** REQUIREMENTS.md traceability table maps only TENANT-01 to Phase 16. No other requirement IDs are assigned to this phase. No orphaned requirements found.

### Commit Verification

| Commit | Message | Status |
|--------|---------|--------|
| `0c09441` | chore(16-01): remove COGNIVAULT_API_KEY from config and uninstall @fastify/bearer-auth | EXISTS |
| `983a534` | test(16-01): add failing tests for registry-backed multi-tenant auth | EXISTS |
| `6b35bff` | feat(16-01): rewrite auth plugin with registry-backed multi-tenant auth | EXISTS |
| `19361b4` | fix(16-01): migrate all tests from static API key to registry-backed auth | EXISTS |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/features/admin/__tests__/routes.test.ts` | 1 | `assist/source/organizeImports`: prom-client import placed after vitest import | Blocker (`pnpm check` fails) | Auto-fixable with `pnpm format` |
| `src/features/context/__tests__/routes.test.ts` | 1 | `assist/source/organizeImports`: prom-client import placed after vitest import | Blocker (`pnpm check` fails) | Auto-fixable with `pnpm format` |
| `src/features/search/__tests__/routes.test.ts` | 1 | `assist/source/organizeImports`: prom-client import placed after vitest import | Blocker (`pnpm check` fails) | Auto-fixable with `pnpm format` |
| `src/lib/__tests__/user-registry.test.ts` | 1 | `assist/source/organizeImports`: value import before type import for same module | Blocker (`pnpm check` fails) | Auto-fixable with `pnpm format` |

All 4 files were modified in commit `19361b4` during Task 3 (test migration). These are not pre-existing violations. `pnpm lint` exits 0 (lint rules only). `biome check` runs both lint and assist rules and exits 1.

**Pre-existing failure (not a Phase 16 gap):** `src/features/vault/__tests__/routes.test.ts` test `returns 200 with empty metadata and warning for malformed YAML` fails because gray-matter does not throw on the malformed YAML fixture. Documented in `deferred-items.md`. Predates Phase 16 and is unrelated to auth changes.

### Gaps Summary

The phase goal is substantively achieved. Every API request authenticates against the registry and carries a resolved user context. The auth plugin is complete, non-stub, and fully wired. `@fastify/bearer-auth` is removed from dependencies. `COGNIVAULT_API_KEY` is eliminated from config. All 8 auth test cases pass. TENANT-01 is satisfied.

The single gap is mechanical: 4 test files modified during Task 3 were committed with import ordering that violates `biome check`'s assist rules, causing `pnpm check` to exit 1. This does not affect any runtime behavior, test correctness, or type safety — `pnpm lint` and `pnpm typecheck` both pass. The fix is a single command: `pnpm format` followed by committing the result.

---

_Verified: 2026-03-14T10:05:00Z_
_Verifier: Claude (gsd-verifier)_
