---
phase: 9
slug: toon-api-polish
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-03-12
---

# Phase 9 -- Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.0.18 |
| **Config file** | vitest.config.ts |
| **Quick run command** | `pnpm test -- --run src/plugins/__tests__/toon.test.ts` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run src/plugins/__tests__/toon.test.ts`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 09-01-01 | 01 | 1 | API-01 | integration | `pnpm test -- --run src/plugins/__tests__/toon.test.ts` | W0 (TDD creates) | pending |
| 09-01-02 | 01 | 1 | API-01 | unit | `pnpm test -- --run src/plugins/__tests__/toon.test.ts` | W0 (TDD creates) | pending |
| 09-01-03 | 01 | 1 | API-02 | integration | `pnpm test -- --run src/plugins/__tests__/toon.test.ts` | W0 (TDD creates) | pending |
| 09-01-04 | 01 | 1 | API-02 | integration | `pnpm test -- --run src/plugins/__tests__/toon.test.ts` | W0 (TDD creates) | pending |
| 09-01-05 | 01 | 1 | API-03 | integration | `pnpm test -- --run src/plugins/__tests__/toon.test.ts` | W0 (TDD creates) | pending |
| 09-02-01 | 02 | 1 | INF-02 | smoke | `pnpm test -- --run src/plugins/__tests__/swagger.test.ts` | W0 (TDD creates) | pending |
| 09-02-02 | 02 | 1 | INF-02 | smoke | `pnpm test -- --run src/plugins/__tests__/swagger.test.ts` | W0 (TDD creates) | pending |
| 09-02-03 | 02 | 1 | INF-02 | smoke | `pnpm test -- --run src/plugins/__tests__/swagger.test.ts` | W0 (TDD creates) | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `src/plugins/__tests__/toon.test.ts` -- created by TDD task in Plan 01 (RED phase)
- [ ] `src/plugins/__tests__/swagger.test.ts` -- created by TDD task in Plan 02 (RED phase)
- [ ] `pnpm add @toon-format/toon @fastify/swagger @fastify/swagger-ui` -- packages not yet installed

*Wave 0 is handled within each TDD task: test file created first (RED), then implementation (GREEN).*

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (TDD tasks create test files first)
- [x] No watch-mode flags
- [x] Feedback latency < 5s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
