---
phase: 04-index-state-+-change-detection
plan: "02"
subsystem: indexer
tags: [indexer, change-detection, polling, events, sqlite, drizzle]
dependency_graph:
  requires: [04-01]
  provides: [VaultIndexer, FileChangeEvent, fastify.indexer]
  affects: [05-embedding-pipeline]
tech_stack:
  added: [p-limit (moved to production deps)]
  patterns:
    - EventEmitter with typed event map
    - Two-pass stability check for partial-write detection
    - Move detection via content hash matching
    - Chunked batch emission (100 events per emit)
    - Fire-and-forget background scan (non-blocking startup)
key_files:
  created:
    - src/lib/indexer.ts
    - src/plugins/indexer.ts
    - src/lib/__tests__/indexer.test.ts
    - src/plugins/__tests__/indexer.test.ts
  modified:
    - src/app.ts
    - package.json
key_decisions:
  - isIndexing set to false before emitting events so listeners observe final state correctly
  - vaultRoot accessed via cast on VaultManager instance (rootPath is private but accessible at runtime)
  - p-limit moved from devDependencies to dependencies (used in production indexer code)
  - catch+rethrow pattern in runInitialScan ensures _isIndexing=false always runs before finally calls schedulePoll
metrics:
  duration: 578s
  completed: "2026-03-10"
  tasks: 2
  files_created: 4
  files_modified: 2
---

# Phase 04 Plan 02: VaultIndexer — Change Detection Engine Summary

VaultIndexer class implementing full vault scan, hash-based change detection, two-pass stability checks, move detection, and batched event emission via typed EventEmitter; wired into Fastify as the `fastify.indexer` decorator.

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 (RED) | Failing tests for VaultIndexer class | 8503816 | src/lib/__tests__/indexer.test.ts |
| 1 (GREEN) | Implement VaultIndexer class | 5abcc2c | src/lib/indexer.ts, package.json |
| 2 | Indexer Fastify plugin + app.ts wiring | 98c091a | src/plugins/indexer.ts, src/app.ts, src/plugins/__tests__/indexer.test.ts |

## Verification Results

- `pnpm test` — 174 tests pass (8 test files)
- `pnpm check` — Biome lint + TypeScript compilation clean (exit 0)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] isIndexing false before event emission**
- **Found during:** Task 1 GREEN, test "poller starts only after initial scan completes" failing
- **Issue:** `_isIndexing = false` was in the `finally` block, but events were emitted before `finally`. Listeners checking `isIndexing` during the `changes` event saw `true` instead of `false`.
- **Fix:** Moved `_isIndexing = false` to execute before `emitInChunks()`, added explicit catch+rethrow pattern to maintain `finally` for `schedulePoll()`
- **Files modified:** src/lib/indexer.ts
- **Commit:** 5abcc2c (part of GREEN commit)

**2. [Rule 2 - Missing Critical] p-limit in devDependencies**
- **Found during:** Task 1 implementation
- **Issue:** `p-limit` was listed as `devDependencies` but is used in `src/lib/indexer.ts` (production code). Would fail in production Docker builds with `--prod` install.
- **Fix:** Moved `p-limit: ^7.3.0` from `devDependencies` to `dependencies` in package.json
- **Files modified:** package.json
- **Commit:** 5abcc2c

**3. [Rule 1 - Bug] TypeScript strict errors in test file**
- **Found during:** Task 2, `pnpm check`
- **Issue:** `fs.readdir` without explicit encoding returns `Dirent<Buffer>` in @types/node v25. Also array element access produced possibly-undefined TS errors.
- **Fix:** Added `encoding: 'utf-8'` to readdir call, added explicit `Dirent<string>[]` type annotation, used optional chaining `?.` for array element access
- **Files modified:** src/lib/__tests__/indexer.test.ts
- **Commit:** 98c091a

**4. [Rule 1 - Bug] Biome import organization and lint in new files**
- **Found during:** Task 2, `pnpm check`
- **Issue:** Import ordering (type imports before value imports) and unused crypto import in test, unused `collectChanges` function, `forEach` with return value in test
- **Fix:** Ran `biome check --write` for safe fixes, manually removed unused import/function, converted `forEach` to `for...of`
- **Files modified:** src/lib/__tests__/indexer.test.ts, src/lib/indexer.ts, src/plugins/indexer.ts
- **Commit:** 98c091a

## Self-Check: PASSED

All files exist and all commits are present in git history.
