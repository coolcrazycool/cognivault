---
phase: 03-vault-write-operations
plan: "01"
subsystem: vault
tags: [vault, write, atomic, tdd, rest-api]
dependency_graph:
  requires: []
  provides: [VaultManager.createNote, VaultManager.updateContent, VaultManager.appendContent, POST /api/vault/content, PUT /api/vault/content, PATCH /api/vault/content]
  affects: [src/lib/vault.ts, src/features/vault/schemas.ts, src/features/vault/routes.ts]
tech_stack:
  added: []
  patterns: [atomic-write-via-temp-rename, exclusive-open-wx-for-conflict-detection, gray-matter-stringify-for-frontmatter-preservation]
key_files:
  created: []
  modified:
    - src/lib/vault.ts
    - src/lib/__tests__/vault.test.ts
    - src/features/vault/schemas.ts
    - src/features/vault/routes.ts
    - src/features/vault/__tests__/routes.test.ts
decisions:
  - "Atomic writes use crypto.randomUUID() for temp file names to avoid collisions"
  - "createNote uses fs.open(path, 'wx') for exclusive atomic create detection"
  - "resolveWritePath rejects empty paths (unlike resolvePath which maps empty to vault root)"
  - "appendContent always uses matter.stringify for reassembly to preserve frontmatter regardless of whether file has one"
  - "Biome style infos (useTemplate) left as-is since pnpm check exits 0 (infos not errors)"
metrics:
  duration: "4min"
  completed_date: "2026-03-10"
  tasks_completed: 2
  files_modified: 5
---

# Phase 3 Plan 01: Vault Write Operations Summary

Atomic write methods (createNote, updateContent, appendContent) added to VaultManager and exposed as REST endpoints POST/PUT/PATCH /api/vault/content with TypeBox validation.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add write methods to VaultManager (TDD) | c163455 | src/lib/vault.ts, src/lib/__tests__/vault.test.ts |
| 2 | Add create/update/append schemas and route handlers | aebd058 | src/features/vault/schemas.ts, src/features/vault/routes.ts, src/features/vault/__tests__/routes.test.ts |

## What Was Built

### VaultManager Write Methods (src/lib/vault.ts)

- **FileExistsError** — new error class, code `FILE_EXISTS`, statusCode 409
- **resolveWritePath(relativePath)** — validates path segments (traversal, dotfile) without requiring file existence; rejects empty paths
- **atomicWrite(filePath, content)** — private method using `crypto.randomUUID()` temp file + `fs.rename()` for atomicity; cleans up temp on error
- **createNote(filePath, content, frontmatter?)** — exclusive create via `fs.open('wx')`; auto-creates parent dirs with `fs.mkdir({ recursive: true })`; assembles frontmatter via `matter.stringify` when provided
- **updateContent(filePath, content)** — uses `resolvePath` (existence required), then atomicWrite
- **appendContent(filePath, text, mode)** — reads existing file, parses with gray-matter, appends/prepends to body, reassembles with `matter.stringify` to preserve frontmatter

### REST Endpoints (src/features/vault/routes.ts + schemas.ts)

- **POST /api/vault/content** — creates note, returns 201; 409 on conflict, 403 on traversal
- **PUT /api/vault/content** — replaces content, returns 200; 404 on missing
- **PATCH /api/vault/content** — appends or prepends text preserving frontmatter, returns 200; 404 on missing

All endpoints: auth-required (401), TypeBox body validation (400 on bad body).

## Test Results

- 54 unit tests in `src/lib/__tests__/vault.test.ts` — all pass
- 37 route tests in `src/features/vault/__tests__/routes.test.ts` — all pass (20 new)
- 4 test files, 99 tests total — all pass
- `pnpm check` exits 0 (typecheck clean, biome clean)

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- [x] `src/lib/vault.ts` exists and contains `resolveWritePath`, `atomicWrite`, `createNote`, `updateContent`, `appendContent`
- [x] `src/features/vault/schemas.ts` exists and contains `CreateNoteBodySchema`
- [x] `src/features/vault/routes.ts` exists and contains `fastify.post`
- [x] Commit c163455 exists (VaultManager write methods)
- [x] Commit aebd058 exists (schemas and route handlers)
- [x] All 99 tests pass
