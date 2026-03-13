---
phase: 06-semantic-+-lexical-search
plan: 01
subsystem: api
tags: [qdrant, vector-search, full-text-search, lexical-search, pipeline, embeddings]

# Dependency graph
requires:
  - phase: 05-markdown-indexing-pipeline
    provides: pipeline plugin that upserts chunks to Qdrant

provides:
  - chunk text stored in Qdrant payload (no disk read required for search results)
  - full-text indexes on text/title/section_path fields for lexical search
  - COLLECTION_NAME exported from qdrant.ts for shared use

affects:
  - 06-02 (search routes: needs text in payload and COLLECTION_NAME import)
  - Any future search/retrieval features using Qdrant

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Idempotent index creation with try/catch outside if-exists block
    - Multilingual tokenizer for mixed Russian/English token boundaries

key-files:
  created: []
  modified:
    - src/plugins/pipeline.ts
    - src/plugins/qdrant.ts
    - src/plugins/__tests__/pipeline.test.ts
    - src/plugins/__tests__/qdrant.test.ts

key-decisions:
  - "Text indexes created outside if(!exists) block so they apply to pre-existing collections (Phase 5 upgrade path)"
  - "Multilingual tokenizer chosen for Russian + English token boundary handling"
  - "lowercase: true for case-insensitive matching in lexical search"
  - "COLLECTION_NAME exported from qdrant.ts to avoid hardcoding in search service"

patterns-established:
  - "Idempotent Qdrant index creation: try/catch around createPayloadIndex ignores already-exists errors"

requirements-completed:
  - RET-06

# Metrics
duration: 8min
completed: 2026-03-11
---

# Phase 6 Plan 01: Qdrant Text Payload and Full-Text Index Setup Summary

**Chunk text stored in Qdrant payload and full-text indexes on text/title/section_path with multilingual tokenizer for lexical search**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-11T08:26:00Z
- **Completed:** 2026-03-11T08:34:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Added `text: chunk.text` to Qdrant upsert payload so search endpoints can return chunk text without disk reads
- Exported `COLLECTION_NAME` from `qdrant.ts` for reuse by the search service (Plan 02)
- Created full-text indexes on `text`, `title`, `section_path` fields with multilingual tokenizer and lowercase matching
- Index creation is idempotent (outside `if (!exists)` block with try/catch) so it runs on restart and upgrades existing collections
- Updated pipeline tests to assert `text` field presence in upsert payload
- Updated qdrant tests to reflect new 9-index behavior and added test for multilingual tokenizer config

## Task Commits

Each task was committed atomically:

1. **Task 1: Add text field to pipeline payload and create full-text indexes in Qdrant plugin** - `3098fbe` (feat)
2. **Task 2: Update existing pipeline test to assert text field presence** - `6f89807` (test)

## Files Created/Modified

- `src/plugins/pipeline.ts` - Added `text: chunk.text` to point payload in `processCreatedOrUpdated()`
- `src/plugins/qdrant.ts` - Exported `COLLECTION_NAME`, added `TEXT_INDEXES` array, added idempotent full-text index creation
- `src/plugins/__tests__/pipeline.test.ts` - Added assertions for `text` field presence and non-empty string
- `src/plugins/__tests__/qdrant.test.ts` - Updated call count expectations, replaced old test with behavior-correct test, added multilingual tokenizer test

## Decisions Made

- Text indexes created **outside** `if (!exists)` block: ensures they are created even on existing Phase 5 collections (upgrade path). Idempotent via try/catch on already-exists errors.
- `multilingual` tokenizer selected over `word` to handle Russian and English mixed-language token boundaries per CONTEXT.md requirement.
- `lowercase: true` locked in for case-insensitive matching.
- `COLLECTION_NAME` exported for use by Plan 02 search service to avoid string duplication.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated qdrant tests broken by intended behavior change**
- **Found during:** Task 2 (pipeline test update), discovered during full test suite run
- **Issue:** Existing qdrant tests expected 6 `createPayloadIndex` calls (only keyword/integer indexes) and expected zero calls on existing collections. New code adds 3 text index calls always (idempotent outside if-exists block), breaking both assertions.
- **Fix:** Updated `toHaveBeenCalledTimes(6)` to `9`; replaced "does not create indexes on existing collection" test with correct behavior test; added test for multilingual tokenizer config. Also fixed unsorted imports in qdrant.test.ts (Biome organizeImports error).
- **Files modified:** `src/plugins/__tests__/qdrant.test.ts`
- **Verification:** All 6 qdrant tests pass; biome check passes with no errors
- **Committed in:** `6f89807` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug: tests needed updating to match new intended behavior)
**Impact on plan:** Auto-fix essential for correctness — tests now accurately document the intended idempotent index behavior. No scope creep.

## Issues Encountered

None — changes were straightforward modifications to pipeline.ts and qdrant.ts. Test updates required due to changed behavior being correct and intentional.

## User Setup Required

None - no external service configuration required. Qdrant full-text indexes are created automatically on next service startup.

## Next Phase Readiness

- Qdrant collection will have full-text indexes on text/title/section_path on next restart
- `COLLECTION_NAME` exported for Plan 02 search service import
- Chunk text stored in payload for search result assembly without disk reads
- Plan 02 (semantic + lexical search endpoints) can proceed

---
*Phase: 06-semantic-+-lexical-search*
*Completed: 2026-03-11*
