---
phase: 13-search-reindex-correctness
verified: 2026-03-12T20:27:00Z
status: passed
score: 5/5 must-haves verified
re_verification: false
---

# Phase 13: Search & Reindex Correctness Verification Report

**Phase Goal:** Fix integration correctness issues in search filtering and reindex status tracking
**Verified:** 2026-03-12T20:27:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | Semantic search with folder filter returns only results whose path starts with the folder prefix | VERIFIED | `service.ts` line 63-66: `.filter((hit) => folderPrefix === undefined \|\| (hit.payload?.path ?? '').startsWith(folderPrefix))`; test at routes.test.ts line 251 confirms single matching result |
| 2 | Hybrid search with folder filter returns only results from the requested folder (semantic leg filtered) | VERIFIED | `hybrid()` delegates to `this.semantic(query, limit * 2, filters)` (line 114); semantic applies folder filter; test at routes.test.ts line 493 verifies all results match `^Projects/` |
| 3 | Full reindex job status transitions to 'completed' only after pipeline queue fully drains | VERIFIED | `service.ts` line 72: `await this.fastify.pipelineQueue.onIdle()` runs before `job.status = 'completed'` (line 73); test at service.test.ts line 149 confirms 'running' persists until `onIdleResolve()` fires |
| 4 | Path-scoped reindex emits real contentHash from indexed_files DB, not empty string | VERIFIED | `service.ts` lines 108-114: drizzle `.get()` lookup against `indexedFiles` before emit; `contentHash = row?.contentHash ?? ''`; tests at service.test.ts lines 182 and 196 verify both found and not-found cases |
| 5 | Pipeline plugin exposes pipelineQueue as a Fastify decoration with proper TypeScript types | VERIFIED | `pipeline.ts` line 19-23: `declare module 'fastify'` augmentation; line 334: `fastify.decorate('pipelineQueue', queue)`; typecheck passes clean |

**Score:** 5/5 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/features/search/service.ts` | Folder post-filter in `semantic()` via `path.startsWith` | VERIFIED | Lines 51, 63-66: `folderPrefix` extraction and `.filter()` present. Pattern mirrors existing `lexical()` implementation at lines 72, 104-107. |
| `src/features/search/__tests__/routes.test.ts` | Tests for semantic and hybrid folder filtering | VERIFIED | Lines 251-295: "folder filter in semantic search returns only matching paths". Lines 493-570: "hybrid search with folder filter excludes results outside folder". 27 total tests pass. |
| `src/plugins/pipeline.ts` | Exposed `pipelineQueue` decoration on `FastifyInstance` | VERIFIED | Line 19-23: TypeScript module augmentation. Line 334: `fastify.decorate('pipelineQueue', queue)` immediately after `new PQueue(...)`. |
| `src/features/admin/service.ts` | Fixed `createFullJob` awaiting `queue.onIdle()` and `createPathJob` reading real contentHash | VERIFIED | Line 65: `onScanComplete` is `async`. Line 72: `await this.fastify.pipelineQueue.onIdle()`. Lines 108-114: drizzle `.get()` lookup. Lines 1-4: static imports for `eq`, `like`, `indexedFiles` (no dynamic imports). |
| `src/features/admin/__tests__/service.test.ts` | Tests for queue drain timing and real contentHash | VERIFIED | Lines 47-53: `mockOnIdle`, `pipelineQueue`, `qdrant.delete` mock additions. Lines 117-178: 3 tests for queue drain (onIdle called, .on() not .once(), completion timing). Lines 181-207: 2 tests for contentHash (found and not-found). 12 total tests pass. |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `search/service.ts semantic()` | `hit.payload.path` | `path.startsWith(folderPrefix)` post-filter | WIRED | Pattern `folderPrefix.*startsWith` confirmed at line 64: `folderPrefix === undefined \|\| (hit.payload?.path ?? '').startsWith(folderPrefix)` |
| `search/service.ts hybrid()` | `semantic()` with folder filter | `this.semantic` delegates with same `filters` | WIRED | Line 114: `this.semantic(query, limit * 2, filters)` — `filters` object (including `folder`) passed through |
| `admin/service.ts createFullJob()` | `fastify.pipelineQueue.onIdle()` | `await` after `scanComplete` fires | WIRED | Line 72: `await this.fastify.pipelineQueue.onIdle()` inside async `onScanComplete` handler |
| `admin/service.ts createPathJob()` | `fastify.db indexed_files` | drizzle `.get()` single-row lookup | WIRED | Lines 108-114: `.select().from(indexedFiles).where(eq(indexedFiles.path, filePath)).get()` |
| `src/plugins/pipeline.ts` | `fastify.pipelineQueue` | `fastify.decorate` | WIRED | Line 334: `fastify.decorate('pipelineQueue', queue)`; TypeScript augmentation at lines 19-23 |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|---------|
| RET-05 | 13-01-PLAN.md | Agent can filter search by tags, project, status, folder path, note type | SATISFIED | Folder filter now applied in `semantic()` and propagates to `hybrid()`. Both test cases pass. |
| IDX-13 | 13-02-PLAN.md | Admin can trigger full or partial reindex via API endpoint | SATISFIED | `createFullJob` now correctly awaits `pipelineQueue.onIdle()` before marking 'completed', fixing premature status reporting. |
| IDX-06 | 13-02-PLAN.md | Service handles created/updated/moved/deleted files incrementally | SATISFIED | `createPathJob` now emits real `contentHash` from `indexed_files` DB for cache-aware incremental processing. |

No orphaned requirements found — all three IDs declared in plan frontmatter are accounted for.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/features/search/service.ts` | 65, 106 | `TODO: At scale, add a text index on path field to push filtering to Qdrant.` | Info | Pre-existing note on scalability optimization. Not a stub — filter is fully implemented in-memory. Does not block goal. |

No stub implementations, empty handlers, or placeholder returns found in modified files.

---

### Human Verification Required

None. All observable truths verified programmatically:
- Tests run and pass (27 search tests, 12 admin service tests)
- TypeScript type check passes clean
- Commit hashes 8210a54, fe78920, c671f41, 032619a all verified in git history

---

### Commits Verified

| Commit | Description |
|--------|-------------|
| `8210a54` | test(13-01): add failing tests for semantic and hybrid folder filter (TDD RED) |
| `fe78920` | feat(13-01): add folder post-filter to semantic() search method (TDD GREEN) |
| `c671f41` | feat(13-02): expose pipelineQueue and await drain before marking full reindex completed |
| `032619a` | fix(13-02): read real contentHash from indexed_files in createPathJob |

---

### Summary

Phase 13 fully achieves its goal. All five observable must-haves are verified at all three levels (exists, substantive, wired):

**Plan 01 (RET-05):** `semantic()` now post-filters results via `path.startsWith(folderPrefix)`, mirroring the pattern already in `lexical()`. `hybrid()` inherits the fix for free because it delegates to `this.semantic()`. Two new integration tests cover both search modes.

**Plan 02 (IDX-13, IDX-06):** The pipeline plugin decorates `fastify.pipelineQueue` (with TypeScript module augmentation) so the admin service layer can reach it. `createFullJob` registers its `onScanComplete` handler with `.on()` (not `.once()`) and awaits `pipelineQueue.onIdle()` before writing `job.status = 'completed'` — eliminating the premature completion race. `createPathJob` performs a synchronous Drizzle `.get()` lookup against `indexed_files` and propagates the real `contentHash` to the synthetic `FileChangeEvent`. Dynamic `await import()` calls in `createFolderJob` were replaced with static top-level imports for consistency.

---

_Verified: 2026-03-12T20:27:00Z_
_Verifier: Claude (gsd-verifier)_
