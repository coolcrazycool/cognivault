---
phase: 2
slug: vault-read-operations
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.0.18 |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `pnpm test -- --run src/features/vault/__tests__/routes.test.ts src/lib/__tests__/vault.test.ts` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run src/features/vault/__tests__/routes.test.ts src/lib/__tests__/vault.test.ts`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | FILE-10 | unit | `pnpm test -- --run src/lib/__tests__/vault.test.ts` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 1 | FILE-10 | unit | `pnpm test -- --run src/lib/__tests__/vault.test.ts` | ❌ W0 | ⬜ pending |
| 02-02-01 | 02 | 2 | FILE-01 | integration | `pnpm test -- --run src/features/vault/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |
| 02-02-02 | 02 | 2 | FILE-02 | integration | `pnpm test -- --run src/features/vault/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |
| 02-03-01 | 03 | 2 | FILE-08 | integration | `pnpm test -- --run src/features/vault/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/lib/__tests__/vault.test.ts` — VaultManager unit tests (path resolution, dotfile filtering, symlink rejection)
- [ ] `src/features/vault/__tests__/routes.test.ts` — route integration tests (all three endpoints, auth, error codes)
- [ ] Test fixture: temporary vault directory structure with markdown files, subdirectories, dotfolders, symlinks, binary files
- [ ] `pnpm add gray-matter` — new dependency needed

*Wave 0 creates test stubs and fixtures before implementation begins.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Symlink escape prevention | FILE-10 | Requires OS-level symlink setup outside test fixture | Create symlink pointing outside vault, verify 403 response |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
