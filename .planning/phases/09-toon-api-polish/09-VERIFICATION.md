---
phase: 09-toon-api-polish
verified: 2026-03-12T10:05:00Z
status: gaps_found
score: 19/20 must-haves verified
re_verification: false
gaps:
  - truth: "pnpm check passes (typecheck + lint + format all clean)"
    status: partial
    reason: "Biome assist/source/organizeImports fires as an error on src/plugins/__tests__/toon.test.ts line 1 — import order (node:* before @toon-format/toon). TypeScript passes cleanly. Lint passes. Only the organizeImports assist rule fails, which `biome check` counts as an error."
    artifacts:
      - path: "src/plugins/__tests__/toon.test.ts"
        issue: "Import order: node:* builtins should come before third-party @toon-format/toon import per Biome's organizeImports sort order. Run `biome check --write src/plugins/__tests__/toon.test.ts` to auto-fix."
    missing:
      - "Run: pnpm biome check --write src/plugins/__tests__/toon.test.ts  (or pnpm format) to fix import ordering and make pnpm check fully green"
human_verification:
  - test: "Verify /docs Swagger UI is interactive in browser"
    expected: "Loading /docs in a browser shows a working Swagger UI page with all API routes listed, auth padlock visible, and text/toon shown in content type dropdowns"
    why_human: "Visual interactivity of Swagger UI cannot be confirmed via inject() — tests confirm 200 + HTML body but not interactive behavior"
  - test: "Verify TOON ~40% token savings in practice"
    expected: "A real search response body encoded as TOON is measurably smaller than the equivalent JSON (approximately 40% reduction on tabular data)"
    why_human: "Token savings claim requires comparing real payload sizes with real search results, not synthetic test data"
---

# Phase 9: TOON Content Negotiation and OpenAPI Documentation — Verification Report

**Phase Goal:** TOON content negotiation and OpenAPI documentation
**Verified:** 2026-03-12T10:05:00Z
**Status:** gaps_found (1 fixable gap: import ordering in toon.test.ts)
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths — Plan 09-01 (TOON Content Negotiation)

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | POST with Content-Type: text/toon body is decoded and validated against TypeBox schemas | VERIFIED | `toon.ts` line 7: `addContentTypeParser(/^text\/toon/, ...)` calls `decode(body)`; test "POST with Content-Type text/toon decodes body" passes |
| 2 | Response is TOON-encoded when Accept header contains text/toon | VERIFIED | `toon.ts` line 53: `accept.includes('text/toon')`; onSend hook calls `encode(obj)` + sets `Content-Type: text/toon`; test "GET with Accept: text/toon returns Content-Type text/toon" passes |
| 3 | Response is TOON-encoded when Content-Type is text/toon (format symmetry) | VERIFIED | `toon.ts` line 53: `contentType.includes('text/toon')`; test "POST with Content-Type: text/toon (no Accept header) returns TOON response" passes |
| 4 | Response is JSON when Accept is application/json or unspecified | VERIFIED | `toon.ts` line 55: `if (!wantToon) return payload`; tests "GET with Accept: application/json" and "GET without Accept header" pass |
| 5 | Invalid TOON body returns 400 with code INVALID_TOON | VERIFIED | `toon.ts` lines 16-20: assigns `statusCode: 400, code: 'INVALID_TOON'`; `error-handler.ts` lines 9-10: checks `errWithCode.code === 'INVALID_TOON'` first; test passes |
| 6 | Error responses (401, 400, 500) are TOON-serialized when client requested TOON | VERIFIED | `error-handler.ts` lines 45-58: checks Accept/Content-Type then calls `encode(payload)` with `Content-Type: text/toon`; 3 tests for 401+400 TOON error serialization pass |
| 7 | Health/readiness endpoints always return JSON regardless of Accept header | VERIFIED | `toon.ts` lines 42-47: skips TOON if `routeConfig?.skipAuth`; test "Health endpoint with Accept: text/toon still returns JSON" passes |

**Plan 09-01 Score: 7/7 truths verified**

### Observable Truths — Plan 09-02 (OpenAPI Documentation)

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 8 | GET /docs returns 200 with Swagger UI HTML page | VERIFIED | `swagger.ts` line 113: registers `swaggerUi` with `routePrefix: '/docs'`; test "GET /docs returns 200 with Swagger UI HTML" passes |
| 9 | GET /docs/json returns valid OpenAPI 3.0 JSON spec | VERIFIED | `swagger.ts` lines 83-101: registers swagger with `openapi: '3.0.0'`; test confirms spec has `openapi`, `info`, `paths` keys |
| 10 | GET /docs/yaml returns 200 with YAML content | VERIFIED | @fastify/swagger serves /docs/yaml by default; test "GET /docs/yaml returns 200 with YAML content-type" passes |
| 11 | OpenAPI spec includes all registered route schemas | VERIFIED | Test "OpenAPI spec includes at least one path from feature routes" confirms `Object.keys(spec.paths).length > 0`; swagger registered before routes in `app.ts` line 33 |
| 12 | /docs endpoints are accessible without authentication | VERIFIED | `auth.ts` lines 24-27: `request.url.startsWith('/docs')` returns early; test "GET /docs without auth header returns 200" passes |
| 13 | OpenAPI spec documents bearer auth security scheme | VERIFIED | `swagger.ts` lines 93-100: `securitySchemes.bearerAuth`, `security: [{ bearerAuth: [] }]`; test "OpenAPI spec includes bearerAuth security scheme" passes |
| 14 | OpenAPI spec documents both application/json and text/toon as supported content types | VERIFIED | `swagger.ts` lines 42-80: `injectToonContentType()` copies application/json entries to text/toon in all non-health paths via `transformObject` hook; test "OpenAPI spec lists text/toon as supported content type" passes |

**Plan 09-02 Score: 7/7 truths verified**

### Additional Verified Properties

| # | Property | Status | Evidence |
|---|----------|--------|---------|
| 15 | toonPlugin registered in app.ts after auth, before infrastructure | VERIFIED | `app.ts` lines 36: `register(toonPlugin)` after authPlugin (line 31), before vaultPlugin (line 39) |
| 16 | swaggerPlugin registered in app.ts after auth, before feature routes | VERIFIED | `app.ts` line 33: `register(swaggerPlugin)` after authPlugin (line 31), before vaultRoutes (line 48) |
| 17 | 13 TOON integration tests pass | VERIFIED | `pnpm test -- --run src/plugins/__tests__/toon.test.ts` → 13 passed |
| 18 | 7 Swagger integration tests pass | VERIFIED | `pnpm test -- --run src/plugins/__tests__/swagger.test.ts` → 7 passed |
| 19 | TypeScript compiles with no errors | VERIFIED | `pnpm typecheck` exits 0 with no output |
| 20 | pnpm check fully passes | FAILED | Biome `assist/source/organizeImports` error in `src/plugins/__tests__/toon.test.ts` — import order not sorted |

**Overall Score: 19/20 truths verified**

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/plugins/toon.ts` | TOON content-type parser and onSend response hook | VERIFIED | 83 lines; `addContentTypeParser` + `onSend` hook; wrapped with `fp()`; real implementation |
| `src/plugins/__tests__/toon.test.ts` | Integration tests for TOON content negotiation (min 80 lines) | VERIFIED | 317 lines; 13 tests; uses `encode`/`decode` from `@toon-format/toon` |
| `src/plugins/swagger.ts` | Swagger + Swagger UI plugin registration | VERIFIED | 126 lines; registers `@fastify/swagger` + `@fastify/swagger-ui`; `injectToonContentType()` transformer; wrapped with `fp()` |
| `src/plugins/__tests__/swagger.test.ts` | Smoke tests for OpenAPI spec and Swagger UI (min 50 lines) | VERIFIED | 192 lines; 7 tests covering /docs, /docs/json, /docs/yaml, auth bypass, bearerAuth, paths, text/toon |
| `src/plugins/error-handler.ts` | TOON-aware error handler | VERIFIED | Imports `encode` from `@toon-format/toon`; checks Accept/Content-Type before formatting; INVALID_TOON code mapping |
| `src/plugins/auth.ts` | /docs auth bypass | VERIFIED | Lines 24-27: `request.url.startsWith('/docs')` skip pattern |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/plugins/toon.ts` | `@toon-format/toon` | `import encode, decode` | WIRED | Line 1: `import { decode, encode } from '@toon-format/toon'`; both used in parser and onSend hook |
| `src/app.ts` | `src/plugins/toon.ts` | `app.register(toonPlugin)` | WIRED | Line 16: `import toonPlugin`; line 36: `await app.register(toonPlugin)` |
| `src/plugins/swagger.ts` | `@fastify/swagger` | `import swagger` | WIRED | Line 1: `import swagger from '@fastify/swagger'`; line 83: `fastify.register(swagger, {...})` |
| `src/app.ts` | `src/plugins/swagger.ts` | `app.register(swaggerPlugin)` | WIRED | Line 15: `import swaggerPlugin`; line 33: `await app.register(swaggerPlugin)` |
| `src/plugins/error-handler.ts` | `@toon-format/toon` | `encode error payload when TOON requested` | WIRED | Line 1: `import { encode } from '@toon-format/toon'`; line 58: `reply.send(encode(payload))` inside `wantToon && !isHealthRoute` branch |
| `src/plugins/auth.ts` | `/docs bypass` | `request.url.startsWith('/docs')` | WIRED | Lines 24-27: URL prefix check returns early before verifyBearerAuth |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|---------|
| API-01 | 09-01-PLAN.md | Service accepts TOON-formatted requests (Content-Type: text/toon) | SATISFIED | `addContentTypeParser(/^text\/toon/, ...)` in toon.ts; 3 request parsing tests pass |
| API-02 | 09-01-PLAN.md | Service returns TOON-formatted responses when Accept: text/toon | SATISFIED | onSend hook checks `accept.includes('text/toon')`; test "GET with Accept: text/toon" passes |
| API-03 | 09-01-PLAN.md | Service returns JSON by default (Accept: application/json or unspecified) | SATISFIED | `!wantToon` guard returns payload unchanged; 2 tests confirm JSON default |
| INF-02 | 09-02-PLAN.md | Service auto-generates OpenAPI spec from route definitions | SATISFIED | @fastify/swagger generates spec from TypeBox schemas; /docs/json has paths matching registered routes |

**Requirements coverage: 4/4 — all phase 9 requirements satisfied**

**Orphaned requirements check:** REQUIREMENTS.md traceability table maps API-01, API-02, API-03, INF-02 to Phase 9 only. No additional Phase 9 requirements exist in REQUIREMENTS.md outside the plans. No orphans.

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/plugins/__tests__/toon.test.ts` | 1 | `assist/source/organizeImports` — import order not sorted (node:* builtins after third-party @toon-format) | Warning | Does not affect test execution or runtime behavior; `biome check` reports it as error; auto-fixable with `--write` |

No TODOs, FIXMEs, placeholder implementations, empty handlers, or stub returns found in any phase 09 files.

---

## Human Verification Required

### 1. Swagger UI Interactivity

**Test:** Start the server (`pnpm dev`) and open `http://localhost:3000/docs` in a browser
**Expected:** Full Swagger UI renders with all API routes (health, vault CRUD, search, context), bearer auth padlock icon present, text/toon listed in content-type dropdowns for non-health routes, and the "Try it out" functionality works for at least one endpoint
**Why human:** `app.inject()` confirms 200 + HTML body containing "swagger", but cannot verify interactive browser behavior, proper JS loading, or content-type dropdown population

### 2. TOON Token Savings in Practice

**Test:** Make a real search request with a non-trivial result set (e.g., 5+ results): once with `Accept: application/json` and once with `Accept: text/toon`, compare response byte sizes
**Expected:** TOON response is approximately 30-40% smaller than JSON for tabular/structured result data
**Why human:** Test assertions verify content-type negotiation correctness but do not measure actual byte savings on real vault data

---

## Gaps Summary

One gap was found — a fixable import ordering issue in `src/plugins/__tests__/toon.test.ts`. Biome's `assist/source/organizeImports` rule expects node built-ins (`node:fs/promises`, `node:os`, `node:path`) to be sorted after third-party imports alphabetically, but the rule actually fires because `node:*` imports are in the wrong position relative to `@toon-format/toon`. This is auto-fixable:

```
pnpm biome check --write src/plugins/__tests__/toon.test.ts
```

This does not affect test execution (all 13 tests pass), runtime behavior, TypeScript compilation, or any functional requirement. It is purely a code style/formatting gap that blocks `pnpm check` from exiting green.

All 4 requirements (API-01, API-02, API-03, INF-02) are substantively implemented with full test coverage. The core phase goal — TOON content negotiation and OpenAPI documentation — is achieved.

---

_Verified: 2026-03-12T10:05:00Z_
_Verifier: Claude (gsd-verifier)_
