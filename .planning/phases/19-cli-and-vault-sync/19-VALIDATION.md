---
phase: 19
slug: cli-and-vault-sync
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-14
---

# Phase 19 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.x |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `pnpm test -- --run src/cli/__tests__/ src/plugins/__tests__/sync.test.ts` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run src/cli/__tests__/ src/plugins/__tests__/sync.test.ts`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 19-01-01 | 01 | 0 | CLI-01 | unit | `pnpm test -- --run src/cli/__tests__/add-user.test.ts` | ❌ W0 | ⬜ pending |
| 19-01-02 | 01 | 0 | CLI-02 | unit | `pnpm test -- --run src/cli/__tests__/remove-user.test.ts` | ❌ W0 | ⬜ pending |
| 19-01-03 | 01 | 0 | CLI-03 | unit | `pnpm test -- --run src/cli/__tests__/list-users.test.ts` | ❌ W0 | ⬜ pending |
| 19-01-04 | 01 | 0 | SYNC-01 | unit | `pnpm test -- --run src/plugins/__tests__/sync.test.ts` | ❌ W0 | ⬜ pending |
| 19-01-05 | 01 | 0 | SYNC-02 | unit | `pnpm test -- --run src/plugins/__tests__/sync.test.ts` | ❌ W0 | ⬜ pending |
| 19-01-06 | 01 | 0 | SYNC-03 | unit | `pnpm test -- --run src/plugins/__tests__/sync.test.ts` | ❌ W0 | ⬜ pending |
| 19-01-07 | 01 | 0 | SYNC-04 | unit | `pnpm test -- --run src/plugins/__tests__/sync.test.ts` | ❌ W0 | ⬜ pending |
| 19-02-01 | 02 | 1 | CLI-01 | unit | `pnpm test -- --run src/cli/__tests__/add-user.test.ts` | ❌ W0 | ⬜ pending |
| 19-02-02 | 02 | 1 | CLI-04 | unit | `pnpm test -- --run src/cli/__tests__/add-user.test.ts` | ❌ W0 | ⬜ pending |
| 19-03-01 | 03 | 1 | SYNC-01 | unit | `pnpm test -- --run src/plugins/__tests__/sync.test.ts` | ❌ W0 | ⬜ pending |
| 19-03-02 | 03 | 1 | SYNC-02 | unit | `pnpm test -- --run src/plugins/__tests__/sync.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/cli/__tests__/add-user.test.ts` — stubs for CLI-01, CLI-04 (mock execFile, mock UserRegistry)
- [ ] `src/cli/__tests__/remove-user.test.ts` — stubs for CLI-02 (mock UserRegistry, mock readline)
- [ ] `src/cli/__tests__/list-users.test.ts` — stubs for CLI-03 (mock UserRegistry, capture stdout)
- [ ] `src/plugins/__tests__/sync.test.ts` — stubs for SYNC-01 through SYNC-04 (mock child_process.spawn, test backoff logic, test metrics)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| ob login + ob sync-setup runs correctly | CLI-04 | Requires real Obsidian credentials | Run `cognivault-ctl add-user test --email x --password y --openai-key z` with real credentials, verify vault syncs |
| Long-running sync stability | SYNC-01 | Requires multi-hour uptime observation | Start sync, monitor for 1+ hour, verify restarts on simulated failures |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
