---
phase: 14
slug: infrastructure-hardening-cleanup
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-12
---

# Phase 14 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `pnpm test -- --run <changed-test>` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run <changed-test>` + `pnpm typecheck`
- **After every plan wave:** Run `pnpm check && pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 14-01-01 | 01 | 1 | SC-1 (Docker volume) | static | `grep -c 'cognivault_data' docker-compose.yml` >= 2 | ✅ | ⬜ pending |
| 14-01-02 | 01 | 1 | SC-2 (getter) | unit | `pnpm typecheck` | ✅ | ⬜ pending |
| 14-01-03 | 01 | 1 | SC-3 (Biome) | static | `pnpm check` exits 0 | ✅ | ⬜ pending |
| 14-01-04 | 01 | 1 | SC-4 (db.test) | unit | `pnpm test -- --run src/plugins/__tests__/db.test.ts` | ✅ | ⬜ pending |
| 14-01-05 | 01 | 1 | SC-5 (alert) | static | `grep 'for: 30m' monitoring/prometheus/rules/cognivault.yml` | ✅ | ⬜ pending |
| 14-01-06 | 01 | 1 | SC-6 (REQUIREMENTS) | static | `grep -c 'MON-0' .planning/REQUIREMENTS.md` >= 8 | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. No new test files needed — changes are to existing files and config.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Docker volume persists across restarts | SC-1 | Requires `docker-compose down && docker-compose up` | 1. `docker-compose up -d` 2. Index a file 3. `docker-compose down` 4. `docker-compose up -d` 5. Verify indexed file still present |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
