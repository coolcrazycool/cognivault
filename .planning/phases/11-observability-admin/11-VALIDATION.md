---
phase: 11
slug: observability-admin
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-12
---

# Phase 11 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.0.18 |
| **Config file** | vitest.config.ts |
| **Quick run command** | `pnpm test -- --run src/features/admin/__tests__/routes.test.ts src/plugins/__tests__/logging.test.ts src/plugins/__tests__/metrics.test.ts` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run` on relevant test file(s)
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 11-01-01 | 01 | 1 | INF-03 | unit | `pnpm test -- --run src/plugins/__tests__/logging.test.ts` | ❌ W0 | ⬜ pending |
| 11-01-02 | 01 | 1 | INF-03 | unit | `pnpm test -- --run src/plugins/__tests__/logging.test.ts` | ❌ W0 | ⬜ pending |
| 11-01-03 | 01 | 1 | INF-03 | unit | `pnpm test -- --run src/plugins/__tests__/logging.test.ts` | ❌ W0 | ⬜ pending |
| 11-02-01 | 02 | 1 | INF-04 | unit | `pnpm test -- --run src/plugins/__tests__/metrics.test.ts` | ❌ W0 | ⬜ pending |
| 11-02-02 | 02 | 1 | INF-04 | unit | `pnpm test -- --run src/plugins/__tests__/metrics.test.ts` | ❌ W0 | ⬜ pending |
| 11-02-03 | 02 | 1 | INF-04 | unit | `pnpm test -- --run src/plugins/__tests__/metrics.test.ts` | ❌ W0 | ⬜ pending |
| 11-03-01 | 03 | 2 | INF-05 | unit | `pnpm test -- --run src/lib/__tests__/tracing.test.ts` | ❌ W0 | ⬜ pending |
| 11-03-02 | 03 | 2 | INF-05 | unit | `pnpm test -- --run src/lib/__tests__/tracing.test.ts` | ❌ W0 | ⬜ pending |
| 11-04-01 | 04 | 2 | IDX-13 | unit | `pnpm test -- --run src/features/admin/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |
| 11-04-02 | 04 | 2 | IDX-13 | unit | `pnpm test -- --run src/features/admin/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |
| 11-04-03 | 04 | 2 | IDX-13 | unit | `pnpm test -- --run src/features/admin/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |
| 11-04-04 | 04 | 2 | IDX-13 | unit | `pnpm test -- --run src/features/admin/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/plugins/__tests__/logging.test.ts` — stubs for INF-03 (X-Request-ID, auth redaction, UUID generation)
- [ ] `src/plugins/__tests__/metrics.test.ts` — stubs for INF-04 (/metrics endpoint, metric registration, default metrics)
- [ ] `src/lib/__tests__/tracing.test.ts` — stubs for INF-05 (conditional init, span attributes)
- [ ] `src/features/admin/__tests__/routes.test.ts` — stubs for IDX-13 (reindex endpoints, auth, conflict handling)
- [ ] `src/features/admin/` directory — routes.ts, schemas.ts, service.ts

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| OTel traces visible in collector | INF-05 | Requires running OTel collector | Start collector, make API requests, verify spans in UI |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
