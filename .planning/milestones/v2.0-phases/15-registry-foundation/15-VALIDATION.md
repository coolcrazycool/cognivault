---
phase: 15
slug: registry-foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-14
---

# Phase 15 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `pnpm test -- --run` |
| **Full suite command** | `pnpm test -- --run` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run`
- **After every plan wave:** Run `pnpm test -- --run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 15-01-01 | 01 | 1 | TENANT-02 | unit | `pnpm test -- --run src/lib/__tests__/user-registry.test.ts` | ❌ W0 | ⬜ pending |
| 15-01-02 | 01 | 1 | TENANT-02 | unit | `pnpm test -- --run src/lib/__tests__/user-registry.test.ts` | ❌ W0 | ⬜ pending |
| 15-01-03 | 01 | 1 | TENANT-03 | unit | `pnpm test -- --run src/lib/__tests__/user-registry.test.ts` | ❌ W0 | ⬜ pending |
| 15-02-01 | 02 | 1 | TENANT-02 | integration | `pnpm test -- --run src/plugins/__tests__/registry.test.ts` | ❌ W0 | ⬜ pending |
| 15-02-02 | 02 | 1 | TENANT-03 | integration | `pnpm test -- --run src/plugins/__tests__/registry.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/lib/__tests__/user-registry.test.ts` — stubs for TENANT-02, TENANT-03
- [ ] `src/plugins/__tests__/registry.test.ts` — stubs for plugin integration
- [ ] Test fixtures for users.json samples (valid, malformed, empty)

*Existing vitest infrastructure covers framework needs.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| fs.watch reload on file edit | TENANT-03 | File system events timing varies | 1. Start server 2. Edit users.json 3. Verify reload within 2s |
| Crash during write leaves valid file | TENANT-03 | Requires process kill simulation | 1. Add breakpoint after tmp write 2. Kill process 3. Verify users.json intact |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
