---
phase: 10-multi-format-indexing
plan: "01"
subsystem: indexing
tags: [pdfjs-dist, papaparse, chunking, pdf, csv, text-extraction]

# Dependency graph
requires:
  - phase: 05-markdown-indexing-pipeline
    provides: chunker.ts with MarkdownChunk shape and MAX_CHUNK_TOKENS constant
provides:
  - PDF page extraction and chunking with pdfjs-dist (src/lib/pdf-chunker.ts)
  - CSV row-batch chunking with PapaParse (src/lib/csv-chunker.ts)
affects:
  - 10-03-multi-format-pipeline (wires pdf-chunker and csv-chunker into indexing pipeline)

# Tech tracking
tech-stack:
  added: [pdfjs-dist@5.5.207, papaparse@5.5.3, "@types/papaparse@5.5.2"]
  patterns:
    - "pdfjs-dist used with GlobalWorkerOptions.workerSrc = '' for server-side (no worker)"
    - "pdfjs-dist legacy build (pdfjs-dist/legacy/build/pdf.mjs) for Node.js compatibility"
    - "PapaParse imported as default export: import Papa from 'papaparse'"
    - "TextItem type narrowed via 'str' in item predicate (TextMarkedContent lacks str)"
    - "Vitest mocking: vi.mock('pdfjs-dist/legacy/build/pdf.mjs') before import for PDF tests"

key-files:
  created:
    - src/lib/pdf-chunker.ts
    - src/lib/csv-chunker.ts
    - src/lib/__tests__/pdf-chunker.test.ts
    - src/lib/__tests__/csv-chunker.test.ts
  modified:
    - package.json
    - pnpm-lock.yaml

key-decisions:
  - "pdfjs-dist GlobalWorkerOptions.workerSrc set to empty string disables web worker for server-side use"
  - "MIN_PAGE_TOKENS = 10 filters scanned headers/footers (pages with < 10 tokens are skipped)"
  - "PDF paragraph splitting: accumulate paragraphs split by double-newline, flush when exceeding 500 tokens"
  - "CSV default batch size: 30 rows (mid-range of user-specified 20-50 row range)"
  - "CSV row formatting: skip empty values — only include Header: value pairs where value is non-empty"
  - "pdfjs-dist text items filtered with 'str' in item type predicate to handle TextMarkedContent items"

patterns-established:
  - "PDF chunker: page-level granularity, paragraph splitting for large pages, minimum token filter for empty pages"
  - "CSV chunker: row-batch approach with header:value formatting, configurable batch size"
  - "Both chunkers return Array<{ text, sectionPath, chunkIndex }> matching MarkdownChunk shape"

requirements-completed: [IDX-08, IDX-11]

# Metrics
duration: 5min
completed: 2026-03-12
---

# Phase 10 Plan 01: PDF and CSV Chunker Modules Summary

**PDF page-based chunker with pdfjs-dist and CSV row-batch chunker with PapaParse, both returning MarkdownChunk-compatible shape for pipeline integration**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-12T10:21:57Z
- **Completed:** 2026-03-12T10:26:57Z
- **Tasks:** 2
- **Files modified:** 6 (2 source, 2 tests, package.json, pnpm-lock.yaml)

## Accomplishments

- PDF chunker extracts text by page using pdfjs-dist with server-side worker disabled; filters pages below 10-token minimum; splits large pages (>500 tokens) at paragraph boundaries; extracts metadata (title, author, subject)
- CSV chunker batches rows into chunks of 30 (default) using PapaParse header mode; formats each row as "Header: value" pairs; skips empty values; warns on malformed rows while still processing valid ones
- Both modules return the same shape as MarkdownChunk (`{ text, sectionPath, chunkIndex }`) and are ready for Plan 03 pipeline integration

## Task Commits

Each task was committed atomically:

1. **Task 1: PDF chunker with pdfjs-dist** - `4303d30` (feat)
2. **Task 2: CSV chunker with PapaParse** - `f197c09` (feat)

## Files Created/Modified

- `src/lib/pdf-chunker.ts` - PDF extraction (extractPdfPages) and chunking (chunkPdf) with pdfjs-dist
- `src/lib/__tests__/pdf-chunker.test.ts` - 11 tests covering extraction, chunking, splitting, edge cases
- `src/lib/csv-chunker.ts` - CSV row-batch chunking (chunkCsv) with PapaParse
- `src/lib/__tests__/csv-chunker.test.ts` - 11 tests covering batching, formatting, edge cases
- `package.json` - Added pdfjs-dist, papaparse, @types/papaparse
- `pnpm-lock.yaml` - Updated lockfile

## Decisions Made

- `pdfjs-dist` legacy build (`pdfjs-dist/legacy/build/pdf.mjs`) used for Node.js compatibility; `GlobalWorkerOptions.workerSrc = ''` disables web worker for server-side execution
- `TextItem` items filtered via `'str' in item` type predicate since `TextMarkedContent` lacks the `str` property
- CSV default batch size set to 30 rows (mid-range of 20-50 row guidance)
- Empty CSV values omitted from row formatting to avoid "Notes: " noise in chunk text

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed TypeScript type errors on pdfjs-dist types**
- **Found during:** Task 1 (PDF chunker implementation)
- **Issue:** `(item: { str: string })` predicate rejected by TypeScript — TextItem/TextMarkedContent union type required proper narrowing; mock return type needed `as unknown as` cast
- **Fix:** Changed filter to `(item): item is TextItem => 'str' in item`; imported `TextItem` from `pdfjs-dist/types/src/display/api.js`; added `as unknown as ReturnType<>` casts in test mock
- **Files modified:** src/lib/pdf-chunker.ts, src/lib/__tests__/pdf-chunker.test.ts
- **Verification:** `pnpm typecheck` passes
- **Committed in:** 4303d30 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking type error)
**Impact on plan:** Type fix necessary for correctness. No scope creep.

## Issues Encountered

- pdfjs-dist v5.5.x uses `TextItem | TextMarkedContent` union where `TextMarkedContent` lacks `str` — required type predicate narrowing in filter expression (resolved via Rule 3)

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- PDF chunker (`chunkPdf`) and CSV chunker (`chunkCsv`) are ready for Plan 03 pipeline wiring
- Both modules export functions matching the MarkdownChunk shape expected by the indexing pipeline
- No blockers

---
*Phase: 10-multi-format-indexing*
*Completed: 2026-03-12*

## Self-Check: PASSED

- src/lib/pdf-chunker.ts: FOUND
- src/lib/csv-chunker.ts: FOUND
- src/lib/__tests__/pdf-chunker.test.ts: FOUND
- src/lib/__tests__/csv-chunker.test.ts: FOUND
- .planning/phases/10-multi-format-indexing/10-01-SUMMARY.md: FOUND
- Commit 4303d30 (PDF chunker): FOUND
- Commit f197c09 (CSV chunker): FOUND
- Commit 7c906a1 (metadata): FOUND
