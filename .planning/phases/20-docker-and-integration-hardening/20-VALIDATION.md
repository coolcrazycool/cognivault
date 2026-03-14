---
phase: 20
slug: docker-and-integration-hardening
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-14
---

# Phase 20 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.0.18 |
| **Config file** | `vitest.config.ts` (unit); `vitest.integration.config.ts` (new, for integration) |
| **Quick run command** | `pnpm test` |
| **Full suite command** | `pnpm test && vitest run --config vitest.integration.config.ts` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm check` (typecheck + lint + format)
- **After every plan wave:** Run `pnpm test` (all unit tests green)
- **Before `/gsd:verify-work`:** `pnpm test && vitest run --config vitest.integration.config.ts && bash test/docker-smoke.sh`
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 20-01-01 | 01 | 1 | INFRA-01 | smoke | `bash test/docker-smoke.sh` | ❌ W0 | ⬜ pending |
| 20-01-02 | 01 | 1 | INFRA-02 | smoke | `bash test/docker-smoke.sh` | ❌ W0 | ⬜ pending |
| 20-02-01 | 02 | 2 | INFRA-03 | integration | `vitest run --config vitest.integration.config.ts` | ❌ W0 | ⬜ pending |
| 20-02-02 | 02 | 2 | OBS-03 | integration | `vitest run --config vitest.integration.config.ts` | ❌ W0 | ⬜ pending |
| 20-03-01 | 03 | 2 | OBS-02 | manual | Verify in Grafana UI | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/isolation.test.ts` — stubs for INFRA-03, OBS-03
- [ ] `test/docker-smoke.sh` — stubs for INFRA-01, INFRA-02
- [ ] `vitest.integration.config.ts` — enables `test/` directory in vitest
- [ ] Integration test user setup helpers (createTestUser, cleanupTestUser) — shared fixtures

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Grafana dashboards filter by user_id template variable | OBS-02 | Dashboard variable population requires running Prometheus with scraped data | 1. Start stack via docker-compose 2. Open Grafana 3. Verify user_id dropdown populates 4. Select user and confirm panels filter |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
