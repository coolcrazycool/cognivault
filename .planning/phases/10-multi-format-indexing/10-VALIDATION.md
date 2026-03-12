---
phase: 10
slug: multi-format-indexing
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-12
---

# Phase 10 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.0.18 |
| **Config file** | vitest.config.ts (root) |
| **Quick run command** | `pnpm test -- --run src/lib/__tests__/pdf-chunker.test.ts` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run relevant chunker test (e.g. `pnpm test -- --run src/lib/__tests__/pdf-chunker.test.ts`)
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 10-01-01 | 01 | 1 | IDX-08 | unit | `pnpm test -- --run src/lib/__tests__/pdf-chunker.test.ts` | ❌ W0 | ⬜ pending |
| 10-01-02 | 01 | 1 | IDX-08 | unit | `pnpm test -- --run src/lib/__tests__/pdf-chunker.test.ts` | ❌ W0 | ⬜ pending |
| 10-01-03 | 01 | 1 | IDX-11 | unit | `pnpm test -- --run src/lib/__tests__/csv-chunker.test.ts` | ❌ W0 | ⬜ pending |
| 10-02-01 | 02 | 1 | IDX-09 | unit | `pnpm test -- --run src/lib/__tests__/canvas-chunker.test.ts` | ❌ W0 | ⬜ pending |
| 10-02-02 | 02 | 1 | IDX-10 | unit | `pnpm test -- --run src/lib/__tests__/excalidraw-chunker.test.ts` | ❌ W0 | ⬜ pending |
| 10-03-01 | 03 | 1 | IDX-12 | unit | `pnpm test -- --run src/lib/__tests__/image-tracker.test.ts` | ❌ W0 | ⬜ pending |
| 10-XX-XX | XX | 2 | IDX-08..12 | unit | `pnpm test -- --run src/plugins/__tests__/pipeline.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/lib/__tests__/pdf-chunker.test.ts` — stubs for IDX-08 (unit tests with Buffer fixtures, mock `extractPdfPages`)
- [ ] `src/lib/__tests__/canvas-chunker.test.ts` — stubs for IDX-09 (pure JSON input, no mocking needed)
- [ ] `src/lib/__tests__/excalidraw-chunker.test.ts` — stubs for IDX-10 (pure JSON input, no mocking needed)
- [ ] `src/lib/__tests__/csv-chunker.test.ts` — stubs for IDX-11 (string CSV input, PapaParse called directly)
- [ ] `src/lib/__tests__/image-tracker.test.ts` — stubs for IDX-12
- [ ] `src/plugins/__tests__/pipeline.test.ts` — stubs for format dispatch (mock all chunkers + embedder)
- [ ] `drizzle/0002_multi_format.sql` — DB migration for file_type and linked_notes columns

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real PDF text extraction quality | IDX-08 | Requires actual PDF files with varying content | Test with sample PDFs in vault directory |
| Docker deployment with pdfjs-dist | IDX-08 | Environment-specific binary dependencies | Run `docker-compose up` and index a PDF |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
