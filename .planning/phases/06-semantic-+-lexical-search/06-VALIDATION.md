---
phase: 6
slug: semantic-lexical-search
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.0.18 |
| **Config file** | vitest.config.ts (implicit — `pnpm test` runs `vitest run`) |
| **Quick run command** | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run src/features/search/__tests__/routes.test.ts`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 06-01-01 | 01 | 1 | RET-01 | unit (inject) | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |
| 06-01-02 | 01 | 1 | RET-05 | unit (inject) | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |
| 06-02-01 | 02 | 1 | RET-02 | unit (inject) | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |
| 06-02-02 | 02 | 1 | RET-05 | unit (inject) | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |
| 06-03-01 | 03 | 1 | RET-06 | unit (inject) | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/features/search/__tests__/routes.test.ts` — stubs for RET-01, RET-02, RET-05, RET-06
- [ ] Qdrant mock fixtures: `ScoredPoint[]` for semantic, `ScrollResult` for lexical
- [ ] Pipeline test update: assert `text` field presence in upserted payload

*Existing Vitest infrastructure covers framework requirements.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Full reindex populates text field | RET-06 | Requires running pipeline against real vault | Run `POST /api/vault/index`, verify chunk has `text` in Qdrant payload |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
