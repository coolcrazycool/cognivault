---
phase: 17
slug: data-isolation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-14
---

# Phase 17 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `pnpm test -- --run src/lib/__tests__/tenant-qdrant-client.test.ts src/plugins/__tests__/db.test.ts src/plugins/__tests__/qdrant.test.ts` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run src/lib/__tests__/tenant-qdrant-client.test.ts src/plugins/__tests__/db.test.ts src/plugins/__tests__/qdrant.test.ts`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 17-01-01 | 01 | 1 | DATA-01 | unit | `pnpm test -- --run src/lib/__tests__/tenant-qdrant-client.test.ts` | ❌ W0 | ⬜ pending |
| 17-01-02 | 01 | 1 | DATA-01 | unit | `pnpm test -- --run src/plugins/__tests__/qdrant.test.ts` | ✅ (update) | ⬜ pending |
| 17-01-03 | 01 | 1 | DATA-01 | unit | `pnpm test -- --run src/plugins/__tests__/qdrant.test.ts` | ✅ (update) | ⬜ pending |
| 17-01-04 | 01 | 1 | DATA-01 | integration | `pnpm test -- --run src/plugins/__tests__/qdrant-isolation.test.ts` | ❌ W0 | ⬜ pending |
| 17-02-01 | 02 | 1 | DATA-02 | unit | `pnpm test -- --run src/plugins/__tests__/db.test.ts` | ✅ (rewrite) | ⬜ pending |
| 17-02-02 | 02 | 1 | DATA-02 | unit | `pnpm test -- --run src/plugins/__tests__/db.test.ts` | ✅ (rewrite) | ⬜ pending |
| 17-02-03 | 02 | 1 | DATA-02 | unit | `pnpm test -- --run src/plugins/__tests__/db.test.ts` | ✅ (rewrite) | ⬜ pending |
| 17-02-04 | 02 | 1 | DATA-02 | unit | `pnpm test -- --run src/plugins/__tests__/db.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/lib/__tests__/tenant-qdrant-client.test.ts` — stubs for DATA-01 (filter injection, all 5 methods)
- [ ] `src/plugins/__tests__/qdrant-isolation.test.ts` — stubs for DATA-01 (cross-tenant isolation integration test)
- [ ] Update `src/plugins/__tests__/db.test.ts` — stubs for DATA-02 (per-user DB lifecycle)
- [ ] Update `src/plugins/__tests__/qdrant.test.ts` — stubs for DATA-01 (user_id index, legacy purge)

*Existing infrastructure covers framework/tooling — only test file stubs needed.*

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
