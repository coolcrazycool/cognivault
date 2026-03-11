---
phase: 8
slug: context-pack-assembly
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-11
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.0.18 |
| **Config file** | `vitest.config.ts` (root) |
| **Quick run command** | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run src/features/context/__tests__/routes.test.ts`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 08-01-01 | 01 | 1 | CTX-01 | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |
| 08-01-02 | 01 | 1 | CTX-01 | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |
| 08-01-03 | 01 | 1 | CTX-02 | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |
| 08-02-01 | 02 | 1 | CTX-03 | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |
| 08-02-02 | 02 | 1 | CTX-03 | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |
| 08-02-03 | 02 | 1 | CTX-04 | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |
| 08-03-01 | 03 | 2 | CTX-03 | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |
| 08-03-02 | 03 | 2 | CTX-04 | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/features/context/__tests__/routes.test.ts` — stubs for CTX-01 through CTX-04
- [ ] `src/features/context/routes.ts` — route handler
- [ ] `src/features/context/schemas.ts` — TypeBox schemas
- [ ] `src/features/context/service.ts` — ContextService assembly pipeline

*Existing infrastructure covers test framework — Vitest and mock patterns already established.*

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
