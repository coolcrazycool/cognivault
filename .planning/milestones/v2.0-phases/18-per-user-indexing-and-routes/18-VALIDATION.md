---
phase: 18
slug: per-user-indexing-and-routes
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-14
---

# Phase 18 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `pnpm test -- --run` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run`
- **After every plan wave:** Run `pnpm test && pnpm check`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 18-01-01 | 01 | 1 | OBS-01 | unit | `pnpm test -- --run src/plugins/__tests__/metrics.test.ts` | ✅ (needs update) | ⬜ pending |
| 18-01-02 | 01 | 1 | SC-1 | unit | `pnpm test -- --run src/plugins/__tests__/embedding.test.ts` | ❌ W0 | ⬜ pending |
| 18-01-03 | 01 | 1 | SC-4 | unit | `pnpm test -- --run src/plugins/__tests__/indexer.test.ts` | ✅ (needs rewrite) | ⬜ pending |
| 18-02-01 | 02 | 1 | SC-2 | integration | `pnpm test -- --run src/plugins/__tests__/db.test.ts` | ✅ | ⬜ pending |
| 18-02-02 | 02 | 1 | SC-2 | unit | `pnpm test -- --run src/plugins/__tests__/pipeline.test.ts` | ✅ (needs rewrite) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/plugins/__tests__/embedding.test.ts` — new tests for per-user embedder Map lifecycle (SC-1)
- [ ] `src/plugins/__tests__/indexer.test.ts` — rewrite for per-user indexer Map lifecycle (SC-4)
- [ ] `src/plugins/__tests__/pipeline.test.ts` — rewrite for userId context passing (SC-2)
- [ ] `src/plugins/__tests__/metrics.test.ts` — update for user_id label assertions (OBS-01)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Adding user at runtime starts indexer | SC-4 | Requires running server + file watcher | 1. Start server 2. Add user to users.json 3. Check logs for indexer start 4. Create file in user's vault 5. Verify indexed |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
