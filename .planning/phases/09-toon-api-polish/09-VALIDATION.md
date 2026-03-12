---
phase: 9
slug: toon-api-polish
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-12
---

# Phase 9 — Validation Strategy

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
| 09-01-01 | 01 | 1 | API-01 | integration | `pnpm test -- --run src/plugins/__tests__/toon.test.ts` | ❌ W0 | ⬜ pending |
| 09-01-02 | 01 | 1 | API-01 | unit | `pnpm test -- --run src/plugins/__tests__/toon.test.ts` | ❌ W0 | ⬜ pending |
| 09-01-03 | 01 | 1 | API-02 | integration | `pnpm test -- --run src/plugins/__tests__/toon.test.ts` | ❌ W0 | ⬜ pending |
| 09-01-04 | 01 | 1 | API-02 | integration | `pnpm test -- --run src/plugins/__tests__/toon.test.ts` | ❌ W0 | ⬜ pending |
| 09-01-05 | 01 | 1 | API-03 | integration | `pnpm test -- --run src/plugins/__tests__/toon.test.ts` | ❌ W0 | ⬜ pending |
| 09-02-01 | 02 | 1 | API-03 | integration | `pnpm test -- --run src/features/health/__tests__/routes.test.ts` | ✅ (extend) | ⬜ pending |
| 09-03-01 | 03 | 2 | INF-02 | smoke | `pnpm test -- --run src/plugins/__tests__/swagger.test.ts` | ❌ W0 | ⬜ pending |
| 09-03-02 | 03 | 2 | INF-02 | smoke | `pnpm test -- --run src/plugins/__tests__/swagger.test.ts` | ❌ W0 | ⬜ pending |
| 09-03-03 | 03 | 2 | INF-02 | smoke | `pnpm test -- --run src/plugins/__tests__/swagger.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/plugins/__tests__/toon.test.ts` — stubs for API-01, API-02, API-03
- [ ] `src/plugins/__tests__/swagger.test.ts` — stubs for INF-02
- [ ] `pnpm add @toon-format/toon @fastify/swagger @fastify/swagger-ui` — packages not yet installed

*Wave 0 installs dependencies and creates test file stubs.*

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
