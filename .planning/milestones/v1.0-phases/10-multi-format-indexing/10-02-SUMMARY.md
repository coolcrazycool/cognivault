---
phase: 10-multi-format-indexing
plan: 02
subsystem: indexing
tags: [canvas, excalidraw, json-parsing, chunking, text-extraction, tiktoken]

# Dependency graph
requires:
  - phase: 05-markdown-indexing-pipeline
    provides: MarkdownChunk interface and chunker.ts pattern used as reference
provides:
  - Canvas JSON text node extractor (chunkCanvas)
  - Excalidraw JSON text element extractor (chunkExcalidraw)
  - Both return same chunk shape as MarkdownChunk
affects: [10-03-pipeline-dispatch]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - JSON.parse with try/catch for graceful parse failure (returns empty array)
    - Type guard pattern: isCanvasFile / isExcalidrawFile for unknown JSON
    - Short-element merging: adjacent <5-token texts concatenated with newline

key-files:
  created:
    - src/lib/canvas-chunker.ts
    - src/lib/excalidraw-chunker.ts
    - src/lib/__tests__/canvas-chunker.test.ts
    - src/lib/__tests__/excalidraw-chunker.test.ts
  modified: []

key-decisions:
  - "Canvas sectionPath uses 'CanvasName > Node N' (1-based, counting text nodes only)"
  - "Excalidraw sectionPath uses 'DrawingName > Text N' (1-based, counting output chunks)"
  - "Short-element merging threshold: <5 tokens per element (js-tiktoken cl100k_base)"
  - "Short elements merge into accumulator groups joined by newline; long elements always standalone"
  - "Test basic extraction tests use long texts (>=5 tokens) to avoid triggering merge behavior"

patterns-established:
  - "Parse-and-guard pattern: JSON.parse in try/catch -> type guard -> process or return []"
  - "TDD: failing tests committed before implementation (RED -> GREEN -> verify)"

requirements-completed: [IDX-09, IDX-10]

# Metrics
duration: 4min
completed: 2026-03-12
---

# Phase 10 Plan 02: Canvas and Excalidraw Chunkers Summary

**Canvas text node extractor and Excalidraw text element extractor — both produce MarkdownChunk-compatible output with short-element merging via js-tiktoken cl100k_base**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-12T10:22:01Z
- **Completed:** 2026-03-12T10:25:31Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Canvas chunker parses .canvas JSON, extracts type='text' nodes, assigns "CanvasName > Node N" sectionPath
- Excalidraw chunker parses .excalidraw JSON, extracts text elements, merges adjacent short elements (<5 tokens), assigns "DrawingName > Text N" sectionPath
- Both modules return `Array<{ text, sectionPath, chunkIndex }>` — same shape as MarkdownChunk
- Both handle invalid JSON, missing fields, empty content gracefully (return [] without throwing)
- 33 tests total (15 canvas + 18 excalidraw), all passing

## Task Commits

Each task was committed atomically using TDD (RED -> GREEN):

1. **Task 1 RED: Canvas JSON chunker tests** - `4ac15bb` (test)
2. **Task 1 GREEN: Canvas JSON chunker implementation** - `ecb9204` (feat)
3. **Task 2 RED: Excalidraw JSON chunker tests** - `c2e1ca1` (test)
4. **Task 2 GREEN: Excalidraw JSON chunker implementation + lint fixes** - `fc42b3f` (feat)

**Plan metadata:** *(this commit)*

_Note: TDD tasks have multiple commits (test → feat)_

## Files Created/Modified
- `src/lib/canvas-chunker.ts` - Canvas JSON parser, exports `chunkCanvas(content, canvasName)`
- `src/lib/excalidraw-chunker.ts` - Excalidraw JSON parser with short-element merging, exports `chunkExcalidraw(content, drawingName)`
- `src/lib/__tests__/canvas-chunker.test.ts` - 15 tests covering extraction, filtering, error handling
- `src/lib/__tests__/excalidraw-chunker.test.ts` - 18 tests covering extraction, filtering, merging, error handling

## Decisions Made
- Short-element merging threshold for Excalidraw is <5 tokens (per plan), using same cl100k_base encoder as chunker.ts
- Test basic extraction suites use texts >=5 tokens to avoid interference with short-element merge behavior — this ensures tests are testing the right behavior at the right level
- Biome lint rule `useLiteralKeys` — used `obj.nodes` and `obj.elements` instead of bracket notation in type guards

## Deviations from Plan

None — plan executed exactly as written. Minor lint issues in initial implementation fixed inline before final commit.

## Issues Encountered
- Initial test suite for Excalidraw used short text labels ('Alpha', 'Beta') in basic extraction tests, causing unexpected merging. Fixed by using longer texts (>=5 tokens) in extraction tests, while keeping short texts in the merge-specific tests.

## Next Phase Readiness
- Both chunkers ready to be wired into the pipeline dispatch in Plan 03 (10-03)
- Chunkers accept `(content: string, name: string)` signature — straightforward to integrate
- No external dependencies added (js-tiktoken already in project)

---
*Phase: 10-multi-format-indexing*
*Completed: 2026-03-12*
