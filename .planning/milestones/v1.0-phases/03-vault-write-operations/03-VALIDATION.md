---
phase: 3
slug: vault-write-operations
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.0.18 |
| **Config file** | vitest.config.ts |
| **Quick run command** | `pnpm test -- --run src/features/vault/__tests__/routes.test.ts` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run src/features/vault/__tests__/routes.test.ts`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 1 | FILE-03 | unit (inject) | `pnpm test -- --run src/features/vault/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |
| 03-01-02 | 01 | 1 | FILE-03 | unit (inject) | same | ❌ W0 | ⬜ pending |
| 03-01-03 | 01 | 1 | FILE-04 | unit (inject) | same | ❌ W0 | ⬜ pending |
| 03-01-04 | 01 | 1 | FILE-05 | unit (inject) | same | ❌ W0 | ⬜ pending |
| 03-02-01 | 02 | 1 | FILE-06 | unit (inject) | same | ❌ W0 | ⬜ pending |
| 03-02-02 | 02 | 1 | FILE-07 | unit (inject) | same | ❌ W0 | ⬜ pending |
| 03-03-01 | 03 | 2 | FILE-09 | unit (inject) | same | ❌ W0 | ⬜ pending |
| 03-03-02 | 03 | 2 | FILE-09 | unit | `pnpm test -- --run src/lib/__tests__/vault.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/features/vault/__tests__/routes.test.ts` — add describe blocks for POST/PUT/PATCH/DELETE `/api/vault/content`, POST `/api/vault/move`, PATCH `/api/vault/metadata`
- [ ] `src/lib/__tests__/vault.test.ts` — add describe blocks for `createNote`, `updateContent`, `appendContent`, `deleteNote`, `moveNote`, `updateMetadata`, `resolveWritePath`

*Existing infrastructure covers framework installation — extend existing test files only.*

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
