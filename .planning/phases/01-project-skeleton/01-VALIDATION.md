---
phase: 1
slug: project-skeleton
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^3.x |
| **Config file** | vitest.config.ts (Wave 0 creates) |
| **Quick run command** | `pnpm test -- --run` |
| **Full suite command** | `pnpm test -- --run --coverage` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run`
- **After every plan wave:** Run `pnpm test -- --run && pnpm check`
- **Before `/gsd:verify-work`:** Full suite must be green + docker compose smoke test
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | INF-06 | smoke | `pnpm build` | ❌ W0 | ⬜ pending |
| 01-01-02 | 01 | 1 | INF-06 | unit | `pnpm test -- --run` | ❌ W0 | ⬜ pending |
| 01-02-01 | 02 | 1 | INF-01 | unit | `pnpm test -- --run src/features/health/__tests__/routes.test.ts` | ❌ W0 | ⬜ pending |
| 01-02-02 | 02 | 1 | API-04 | integration | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` | ❌ W0 | ⬜ pending |
| 01-03-01 | 03 | 2 | INF-06 | smoke | `docker compose up -d && curl http://localhost:3000/health` | ❌ manual | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `vitest.config.ts` — Vitest configuration (ESM, globals off)
- [ ] `src/features/health/__tests__/routes.test.ts` — stubs for INF-01
- [ ] `src/plugins/__tests__/auth.test.ts` — stubs for API-04
- [ ] Framework install: `pnpm add -D vitest` — no test infrastructure exists yet

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| docker-compose up starts service + Qdrant | INF-06 | Requires Docker daemon, network, bind mounts | Run `docker compose up -d`, wait 10s, `curl http://localhost:3000/health`, verify 200 OK |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
