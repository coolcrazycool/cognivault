---
phase: 13
slug: search-reindex-correctness
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-12
---

# Phase 13 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `pnpm test -- --run src/features/search/__tests__/routes.test.ts src/features/admin/__tests__/service.test.ts` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run src/features/search/__tests__/routes.test.ts src/features/admin/__tests__/service.test.ts`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 13-01-01 | 01 | 1 | RET-05 | unit | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` | Yes (new case) | ⬜ pending |
| 13-01-02 | 01 | 1 | RET-05 | unit | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` | Yes (new case) | ⬜ pending |
| 13-02-01 | 02 | 1 | IDX-13 | unit | `pnpm test -- --run src/features/admin/__tests__/service.test.ts` | Yes (update) | ⬜ pending |
| 13-02-02 | 02 | 1 | IDX-06 | unit | `pnpm test -- --run src/features/admin/__tests__/service.test.ts` | Yes (new case) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. New test cases are additions to existing files, not new files.

---

## Manual-Only Verifications

All phase behaviors have automated verification.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
