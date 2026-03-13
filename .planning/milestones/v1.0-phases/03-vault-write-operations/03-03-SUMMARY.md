---
phase: 03-vault-write-operations
plan: "03"
subsystem: api
tags: [fastify, gray-matter, typebox, frontmatter, metadata, shallow-merge]

requires:
  - phase: 03-01
    provides: VaultManager with atomicWrite, resolvePath, and gray-matter imported
  - phase: 03-02
    provides: deleteNote, moveNote endpoints

provides:
  - PATCH /api/vault/metadata endpoint with shallow-merge semantics
  - VaultManager.updateMetadata(filePath, updates) method
  - null-delete semantics for removing frontmatter fields
  - UpdateMetadataBodySchema and UpdateMetadataResponseSchema TypeBox schemas

affects:
  - future phases using metadata update operations
  - any plan referencing vault write endpoints

tech-stack:
  added: []
  patterns:
    - "Shallow merge for frontmatter updates: spread existing then apply updates"
    - "null-delete pattern: null value in updates removes key from frontmatter"
    - "matter.stringify(parsed.content, merged) preserves note body during metadata update"

key-files:
  created: []
  modified:
    - src/lib/vault.ts
    - src/features/vault/schemas.ts
    - src/features/vault/routes.ts
    - src/lib/__tests__/vault.test.ts
    - src/features/vault/__tests__/routes.test.ts

key-decisions:
  - "Shallow merge preserves unmentioned frontmatter fields; only specified keys change"
  - "null value in updates deletes the key from merged frontmatter (null-delete semantics)"
  - "matter.stringify(parsed.content, merged) used to reassemble file, preserving body exactly"
  - "UpdateMetadataResponseSchema has no warning field (write response, not read)"

patterns-established:
  - "Metadata update reuses resolvePath (throws FileNotFoundError if missing)"
  - "PATCH /metadata route follows same error-handling pattern as other vault routes"

requirements-completed: [FILE-09]

duration: 5min
completed: 2026-03-10
---

# Phase 03 Plan 03: Update Metadata Summary

**PATCH /api/vault/metadata endpoint using gray-matter shallow merge with null-delete semantics, backed by VaultManager.updateMetadata**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-10T15:46:14Z
- **Completed:** 2026-03-10T15:51:32Z
- **Tasks:** 1
- **Files modified:** 5

## Accomplishments
- VaultManager.updateMetadata method with shallow merge: preserves existing fields, adds/updates specified fields, deletes null-valued fields
- PATCH /api/vault/metadata route with TypeBox schema validation
- 6 unit tests for updateMetadata covering add, update, delete, no-frontmatter, body preservation, and 404
- 5 route tests for PATCH /metadata covering 200, null delete, 404, 403, and 401
- All 131 tests pass, pnpm check exits 0

## Task Commits

TDD flow:

1. **RED: Failing tests** - `36d736e` (test: add failing tests for updateMetadata and PATCH /metadata endpoint)
2. **GREEN: Implementation** - `955dbd6` (feat(03-02): add deleteNote, moveNote, updateMetadata — implementation was already present from prior plan)

## Files Created/Modified
- `src/lib/vault.ts` - Added updateMetadata method and UpdateMetadataResult interface
- `src/features/vault/schemas.ts` - Added UpdateMetadataBodySchema, UpdateMetadataResponseSchema, updateMetadataSchema
- `src/features/vault/routes.ts` - Added PATCH /metadata route handler
- `src/lib/__tests__/vault.test.ts` - Added 6 updateMetadata unit tests, added gray-matter import
- `src/features/vault/__tests__/routes.test.ts` - Added 5 PATCH /api/vault/metadata route tests

## Decisions Made
- Shallow merge semantics: `{ ...parsed.data }` then iterate updates — null deletes, others set
- matter.stringify(parsed.content, merged) chosen over raw string manipulation to avoid frontmatter corruption
- Response schema omits `warning` field (write operations don't return parse warnings)
- Used resolvePath (not resolveWritePath) since file must already exist for metadata updates

## Deviations from Plan

None — plan executed exactly as written. Implementation was already committed in plan 03-02 commit; this plan added tests to complete TDD coverage.

## Issues Encountered
- Pre-existing biome `lint/style/useTemplate` infos in vault.ts (from prior plans) appear during check but exit with code 0 — not blocking.

## Next Phase Readiness
- All vault write operations (create, update, append, delete, move, metadata update) are complete
- Phase 03 fully implemented — ready for next phase

---
*Phase: 03-vault-write-operations*
*Completed: 2026-03-10*
