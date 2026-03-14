---
phase: 16
slug: per-user-container-stack
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-14
---

# Phase 16 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | package.json script |
| **Quick run command** | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run src/plugins/__tests__/auth.test.ts`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 16-01-01 | 01 | 0 | TENANT-01c | unit | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` | ❌ W0 | ⬜ pending |
| 16-01-02 | 01 | 0 | TENANT-01d | unit | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` | ❌ W0 | ⬜ pending |
| 16-01-03 | 01 | 0 | TENANT-01g | unit | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` | ❌ W0 | ⬜ pending |
| 16-01-04 | 01 | 1 | TENANT-01a | unit | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` | ✅ (rewrite) | ⬜ pending |
| 16-01-05 | 01 | 1 | TENANT-01b | unit | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` | ✅ (rewrite) | ⬜ pending |
| 16-01-06 | 01 | 1 | TENANT-01e | unit | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` | ✅ (rewrite) | ⬜ pending |
| 16-01-07 | 01 | 1 | TENANT-01f | unit | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` | ✅ (rewrite) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/plugins/__tests__/auth.test.ts` — full rewrite: switch from static key to registry-based users, add tests for TENANT-01c, TENANT-01d, TENANT-01g
- [ ] Test users fixture — shared test UserRecord objects for auth tests

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
