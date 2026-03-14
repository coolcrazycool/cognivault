---
phase: 21
slug: cli-server-event-wiring
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-14
---

# Phase 21 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest v4.0.18 |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `pnpm test -- --run src/lib/__tests__/user-registry.test.ts src/plugins/__tests__/indexer.test.ts` |
| **Full suite command** | `pnpm test -- --run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run src/lib/__tests__/user-registry.test.ts src/plugins/__tests__/sync.test.ts`
- **After every plan wave:** Run `pnpm test -- --run`
- **Before `/gsd:verify-work`:** Full suite must be green (excluding pre-existing vault route failures)
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 21-01-01 | 01 | 1 | CLI-01, CLI-02 | unit | `pnpm test -- --run src/lib/__tests__/user-registry.test.ts` | ✅ (extend) | ⬜ pending |
| 21-01-02 | 01 | 1 | SYNC-01 | unit | `pnpm test -- --run src/plugins/__tests__/indexer.test.ts` | ❌ W0 | ⬜ pending |
| 21-02-01 | 02 | 1 | OBS-03 | unit | `pnpm test -- --run src/plugins/__tests__/sync.test.ts` | ✅ passing | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/lib/__tests__/user-registry.test.ts` — add tests: `addUser() emits user-added event`, `removeUser() emits user-removed event`
- [ ] `src/plugins/__tests__/indexer.test.ts` — create or extend; covers `user-added handler retries vault path`, `user-added handler gives up after timeout`
- [ ] Note: `src/plugins/__tests__/sync.test.ts` and `src/lib/__tests__/user-registry.test.ts` already exist and pass — extend, do not replace

*Existing infrastructure covers OBS-03. Wave 0 needed for event emission and indexer retry tests.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Docker volume fs.watch reliability | CLI-01 | Requires real Docker environment | Run `docker-compose up`, then `cognivault-ctl add-user test-user ...` and verify sync starts |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
