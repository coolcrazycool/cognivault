---
phase: 22
slug: milestone-verification-closure
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-14
---

# Phase 22 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `pnpm test -- --run` |
| **Full suite command** | `pnpm test -- --run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run`
- **After every plan wave:** Run `pnpm test -- --run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 22-01-01 | 01 | 1 | CLI-01, CLI-02, CLI-03, CLI-04, SYNC-01, SYNC-02, SYNC-03, SYNC-04 | manual-verify | `grep -c "VERIFIED" .planning/phases/19-*/*-VERIFICATION.md` | ❌ W0 | ⬜ pending |
| 22-02-01 | 02 | 1 | OBS-03 | manual-verify | `grep "OBS-03" .planning/phases/20-*/*-VERIFICATION.md` | ✅ | ⬜ pending |
| 22-03-01 | 03 | 2 | ALL | manual-verify | `grep -c "satisfied" .planning/v2.0-MILESTONE-AUDIT.md` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Existing test suite passes (`pnpm test -- --run`) — confirms no regressions before verification docs are authored

*Existing infrastructure covers all phase requirements. This is a documentation-only phase.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Phase 19 VERIFICATION.md covers all CLI/SYNC reqs | CLI-01..04, SYNC-01..04 | Document authoring, not code | Review VERIFICATION.md for 8 requirement entries with code evidence |
| Phase 20 VERIFICATION.md reflects OBS-03 resolved | OBS-03 | Document update, not code | Check Truth 7 flipped from FAILED to VERIFIED |
| Milestone audit 3-source cross-reference | ALL 19 reqs | Cross-document consistency | Verify each requirement has code, test, and verification evidence |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
