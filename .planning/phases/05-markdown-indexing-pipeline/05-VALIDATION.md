---
phase: 5
slug: markdown-indexing-pipeline
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-10
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest v4.0.18 |
| **Config file** | `vitest.config.ts` (root) — `include: ['src/**/__tests__/**/*.test.ts']` |
| **Quick run command** | `pnpm test -- --run src/lib/__tests__/chunker.test.ts` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run src/lib/__tests__/chunker.test.ts`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 05-01-01 | 01 | 1 | IDX-03 | unit | `pnpm test -- --run src/lib/__tests__/chunker.test.ts` | ❌ W0 | ⬜ pending |
| 05-01-02 | 01 | 1 | IDX-04 | unit | `pnpm test -- --run src/lib/__tests__/chunker.test.ts` | ❌ W0 | ⬜ pending |
| 05-01-03 | 01 | 1 | IDX-05 | unit | `pnpm test -- --run src/lib/__tests__/chunker.test.ts` | ❌ W0 | ⬜ pending |
| 05-02-01 | 02 | 1 | IDX-03 | unit | `pnpm test -- --run src/lib/__tests__/embedding.test.ts` | ❌ W0 | ⬜ pending |
| 05-03-01 | 03 | 1 | IDX-07 | unit | `pnpm test -- --run src/plugins/__tests__/qdrant.test.ts` | ❌ W0 | ⬜ pending |
| 05-04-01 | 04 | 2 | IDX-07 | unit | `pnpm test -- --run src/plugins/__tests__/pipeline.test.ts` | ❌ W0 | ⬜ pending |
| 05-04-02 | 04 | 2 | IDX-07 | unit | `pnpm test -- --run src/plugins/__tests__/pipeline.test.ts` | ❌ W0 | ⬜ pending |
| 05-04-03 | 04 | 2 | IDX-07 | unit | `pnpm test -- --run src/plugins/__tests__/pipeline.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/lib/__tests__/chunker.test.ts` — stubs for IDX-03, IDX-04, IDX-05 (chunker pure function tests)
- [ ] `src/lib/__tests__/embedding.test.ts` — stubs for EmbeddingProvider interface; mock OpenAI client
- [ ] `src/plugins/__tests__/pipeline.test.ts` — stubs for IDX-07; mock qdrant and embedder decorators
- [ ] `src/plugins/__tests__/qdrant.test.ts` — stubs for collection init and payload index creation; mock QdrantClient

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| OpenAI API connectivity on startup | IDX-03 | Requires live API key | Start server with valid OPENAI_API_KEY, verify no startup error |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
