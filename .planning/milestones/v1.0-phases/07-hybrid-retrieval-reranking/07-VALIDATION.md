---
phase: 7
slug: hybrid-retrieval-reranking
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-11
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.0.18 |
| **Config file** | vitest.config.ts (project root) |
| **Quick run command** | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run src/features/search/__tests__/routes.test.ts`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green + eval harness report showing recall@10 >= 0.7
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 07-01-01 | 01 | 1 | RET-03 | unit | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` | ✅ (extend) | ⬜ pending |
| 07-01-02 | 01 | 1 | RET-03 | unit | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` | ✅ (extend) | ⬜ pending |
| 07-01-03 | 01 | 1 | RET-03 | unit | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` | ✅ (extend) | ⬜ pending |
| 07-02-01 | 02 | 1 | RET-04 | — | DEFERRED — not implemented | — | ⬜ deferred |
| 07-03-01 | 03 | 2 | RET-07 | manual eval | `npx tsx test/eval/eval.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/eval/eval.ts` — evaluation harness CLI script (covers RET-07)
- [ ] `test/eval/queries.json` — query set with 30-35 multilingual queries and expected relevant paths

*Existing infrastructure at `src/features/search/__tests__/routes.test.ts` covers all RET-03 unit tests — extend, don't create new file.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Mixed Russian/English query relevance | RET-07 | Requires human judgment on relevance thresholds | Run `npx tsx test/eval/eval.ts`, review recall@10 per category |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
