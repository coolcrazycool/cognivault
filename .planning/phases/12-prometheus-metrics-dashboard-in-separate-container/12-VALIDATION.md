---
phase: 12
slug: prometheus-metrics-dashboard-in-separate-container
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-12
---

# Phase 12 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (existing) |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `pnpm test -- --run src/plugins/__tests__/metrics.test.ts src/plugins/__tests__/pipeline.test.ts` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run src/plugins/__tests__/metrics.test.ts src/plugins/__tests__/pipeline.test.ts`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 12-01-01 | 01 | 1 | New metrics in `/metrics` | unit | `pnpm test -- --run src/plugins/__tests__/metrics.test.ts` | ✅ | ⬜ pending |
| 12-01-02 | 01 | 1 | embeddingRequests increments | unit | `pnpm test -- --run src/plugins/__tests__/pipeline.test.ts` | ✅ | ⬜ pending |
| 12-01-03 | 01 | 1 | chunksProcessed increments | unit | `pnpm test -- --run src/plugins/__tests__/pipeline.test.ts` | ✅ | ⬜ pending |
| 12-01-04 | 01 | 1 | pipelineDuration observes timing | unit | `pnpm test -- --run src/plugins/__tests__/pipeline.test.ts` | ✅ | ⬜ pending |
| 12-02-01 | 02 | 1 | Prometheus + Grafana start | smoke | manual: `docker-compose up -d prometheus grafana` | N/A | ⬜ pending |
| 12-02-02 | 02 | 1 | Grafana anonymous access | smoke | manual: `curl http://localhost:3001/api/health` | N/A | ⬜ pending |
| 12-02-03 | 02 | 1 | Prometheus scrapes cognivault | smoke | manual: `curl http://localhost:9090/api/v1/targets` | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. `metrics.test.ts` and `pipeline.test.ts` already exist and will be extended.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Prometheus + Grafana services start | Docker infra | Requires Docker runtime | `docker-compose up -d prometheus grafana` — verify both healthy |
| Grafana anonymous access works | Dashboard access | Requires running Grafana container | `curl http://localhost:3001/api/health` — expect 200 |
| Prometheus scrapes cognivault | Metrics pipeline | Requires Docker network + running service | `curl http://localhost:9090/api/v1/targets` — verify cognivault target is UP |
| Dashboard panels render data | Visualization | Requires running stack + metric data | Open Grafana at localhost:3001, verify panels show data |
| Alert rules fire correctly | Alerting | Requires metric thresholds to be breached | Check Prometheus alerts UI at localhost:9090/alerts |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
