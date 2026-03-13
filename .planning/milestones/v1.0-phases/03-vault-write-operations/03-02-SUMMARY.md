---
phase: 03-vault-write-operations
plan: "02"
subsystem: vault
tags: [vault, write, delete, move, metadata, tdd, rest-api, typebox]

requires:
  - phase: 03-01
    provides: VaultManager createNote/updateContent/appendContent, resolveWritePath, atomicWrite, FileExistsError

provides:
  - VaultManager.deleteNote
  - VaultManager.moveNote
  - VaultManager.updateMetadata
  - DELETE /api/vault/content
  - POST /api/vault/move
  - PATCH /api/vault/metadata

affects:
  - src/lib/vault.ts
  - src/features/vault/schemas.ts
  - src/features/vault/routes.ts

tech-stack:
  added: []
  patterns:
    - stat-before-unlink for file-type validation before delete
    - try-catch-ENOENT-pattern for destination conflict detection in moveNote
    - null-value-delete pattern for metadata merge (null removes key)

key-files:
  created: []
  modified:
    - src/lib/vault.ts
    - src/features/vault/schemas.ts
    - src/features/vault/routes.ts
    - src/lib/__tests__/vault.test.ts
    - src/features/vault/__tests__/routes.test.ts

key-decisions:
  - "deleteNote rejects directories via stat.isFile() check before unlink, throws FileNotFoundError"
  - "moveNote uses try/catch on fs.stat(dest) to detect ENOENT vs conflict atomically"
  - "updateMetadata uses null values as delete-key signal in merge operation"
  - "updateMetadata auto-creates frontmatter block when file has none (matter.stringify handles it)"

patterns-established:
  - "moveNote: resolvePath(source) for existence check, resolveWritePath(dest) for validation without existence requirement"
  - "Metadata patch: shallow merge pattern with null=delete semantics"

requirements-completed: [FILE-06, FILE-07]

duration: 4min
completed: 2026-03-10
---

# Phase 3 Plan 02: Vault Write Operations (Delete + Move) Summary

**DELETE /api/vault/content and POST /api/vault/move endpoints with file-type validation, atomic conflict detection, and auto-directory creation; plus PATCH /api/vault/metadata for frontmatter updates**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-10T15:47:04Z
- **Completed:** 2026-03-10T15:51:00Z
- **Tasks:** 1 (TDD: failing tests written, then all implemented in one commit)
- **Files modified:** 3 source + 2 test files (tests pre-committed in prior session)

## Accomplishments
- `deleteNote(filePath)` — validates file existence and type, unlinks, returns `{ path, deleted: true }`
- `moveNote(from, to)` — validates source existence + isFile, detects destination conflicts, auto-creates dirs, renames atomically
- `updateMetadata(filePath, updates)` — shallow-merges updates into frontmatter; null values remove keys; preserves note body
- Three new REST endpoints: DELETE /content (200/404/403), POST /move (200/409/404/403), PATCH /metadata (200/404/403)
- 131 total tests pass (71 unit + 52 route + 4 auth + 4 health)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add deleteNote, moveNote, updateMetadata to VaultManager, schemas, and routes** - `955dbd6` (feat)

**Plan metadata:** (to be created below)

_Note: TDD RED phase tests were pre-committed from 03-03 session; GREEN phase implemented all in single task commit._

## Files Created/Modified
- `src/lib/vault.ts` - Added deleteNote, moveNote, updateMetadata methods + UpdateMetadataResult interface
- `src/features/vault/schemas.ts` - Added DeleteNoteBodySchema, MoveNoteBodySchema, UpdateMetadataBodySchema and their response schemas + route schema objects
- `src/features/vault/routes.ts` - Added DELETE /content, POST /move, PATCH /metadata route handlers

## Decisions Made
- `deleteNote` rejects directories by calling `fs.stat(resolved).isFile()` after `resolvePath` — throws `FileNotFoundError` for directories (consistent behavior)
- `moveNote` uses try/catch on `fs.stat(dest)` to detect ENOENT: ENOENT means proceed, anything else or `FileExistsError` thrown means conflict
- `updateMetadata` treats `null` values in the updates object as delete-key signals; other values are merged/overwritten
- `matter.stringify(parsed.content, merged)` handles frontmatter creation even when file had no frontmatter (gray-matter adds `---` block)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Implemented updateMetadata method and PATCH /api/vault/metadata endpoint**
- **Found during:** Task 1 (pnpm check typecheck)
- **Issue:** Test files `src/lib/__tests__/vault.test.ts` and `src/features/vault/__tests__/routes.test.ts` had been pre-committed from plan 03-03 TDD RED phase (tests for `updateMetadata` and `PATCH /metadata`). TypeScript typecheck failed because `VaultManager.updateMetadata` didn't exist yet.
- **Fix:** Implemented `updateMetadata` on VaultManager, added `UpdateMetadataBodySchema`/`UpdateMetadataResponseSchema`/`updateMetadataSchema` to schemas.ts, added `PATCH /metadata` route to routes.ts
- **Files modified:** src/lib/vault.ts, src/features/vault/schemas.ts, src/features/vault/routes.ts
- **Verification:** pnpm check exits clean, 131 tests pass
- **Committed in:** 955dbd6 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 3 - blocking typecheck failure from pre-committed test content)
**Impact on plan:** updateMetadata is plan 03-03 content accelerated. All tests pass, no scope creep beyond what was already committed as failing tests.

## Issues Encountered
- Test files were modified externally between sessions with 03-03 failing tests already committed. This caused TypeScript typecheck failures requiring 03-03 implementation to be included in this plan's execution. Addressed via Rule 3 auto-fix.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All vault write operations complete: create, update, append, delete, move, metadata update
- 03-03 `updateMetadata` implementation is done (pre-empted); plan 03-03 can proceed directly to pnpm check + summary if its tests already pass
- REST API has full CRUD coverage for notes and metadata

---
*Phase: 03-vault-write-operations*
*Completed: 2026-03-10*

## Self-Check: PASSED

- [x] `src/lib/vault.ts` exists and contains `deleteNote`, `moveNote`, `updateMetadata`
- [x] `src/features/vault/schemas.ts` exists and contains `DeleteNoteBodySchema`
- [x] `src/features/vault/routes.ts` exists and contains `fastify.delete`
- [x] Commit 955dbd6 exists
- [x] All 131 tests pass (`pnpm test`)
- [x] `pnpm check` exits 0 (clean typecheck + biome)
