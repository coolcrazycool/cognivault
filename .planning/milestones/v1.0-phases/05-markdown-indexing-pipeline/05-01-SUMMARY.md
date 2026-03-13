---
phase: 05-markdown-indexing-pipeline
plan: "01"
subsystem: indexing
tags: [remark-parse, unified, remark-gfm, js-tiktoken, markdown, chunking, obsidian]

requires:
  - phase: 04-index-state-change-detection
    provides: VaultIndexer and indexed_files DB schema used by embedding pipeline

provides:
  - "src/lib/chunker.ts: chunkMarkdown() pure function, MarkdownChunk/ChunkOptions interfaces, normalizeObsidianSyntax(), MIN/MAX_CHUNK_TOKENS constants"
  - "src/lib/__tests__/chunker.test.ts: 27 unit tests covering IDX-03 and IDX-04 requirements"

affects:
  - 05-02-embedding-infrastructure (consumes chunkMarkdown to produce embeddings)
  - 05-03-qdrant-pipeline (consumes chunks via embedding pipeline)

tech-stack:
  added:
    - "remark-parse 11.0.0 — markdown to mdast AST parser (ESM-native)"
    - "unified 11.0.5 — AST pipeline processor (required peer)"
    - "remark-gfm 4.0.1 — GFM tables/strikethrough extension for remark-parse"
    - "js-tiktoken 1.0.21 — pure-JS tiktoken port for cl100k_base token counting"
  patterns:
    - "TDD RED→GREEN→REFACTOR with per-phase commits"
    - "Module-level encoder initialization to avoid per-call WASM overhead"
    - "H1 headings treated as transparent (section boundaries only, not added to path)"

key-files:
  created:
    - "src/lib/chunker.ts"
    - "src/lib/__tests__/chunker.test.ts"
  modified:
    - "package.json (added remark-parse, unified, remark-gfm, js-tiktoken dependencies)"
    - "pnpm-lock.yaml"

key-decisions:
  - "H1 headings are transparent — they create section boundaries but are NOT added to section_path (H2+ build the path)"
  - "Short sections (<100 tokens) merge into the immediately preceding pending section bucket, preserving the first section's path"
  - "js-tiktoken getEncoding() called once at module level, not per-chunk, to avoid repeated WASM initialization overhead"
  - "Test content for heading-boundary and hierarchy tests must be >=100 tokens per section to prevent short-merge from collapsing expected separate chunks"
  - "normalizeObsidianSyntax strips embeds first, then resolves wikilink aliases, then plain wikilinks"

patterns-established:
  - "nodeToText(): recursive AST walker extracting text values without remark-stringify, preserving code block content"
  - "splitAtParagraphBoundaries(): atomic-block-aware paragraph splitter that keeps tables and code blocks whole"
  - "Section struct: {depth, headingStack, nodes} tracks heading depth separately from the stack to enable transparent H1 handling"

requirements-completed: [IDX-03, IDX-04]

duration: 15min
completed: 2026-03-10
---

# Phase 5 Plan 01: Heading-Aware Markdown Chunker Summary

**AST-based markdown chunker using remark-parse + js-tiktoken that splits at heading boundaries, keeps code/tables atomic, merges short sections, and normalizes Obsidian wikilinks**

## Performance

- **Duration:** 15 min
- **Started:** 2026-03-10T21:20:00Z
- **Completed:** 2026-03-10T21:30:00Z
- **Tasks:** 2 (RED + GREEN TDD phases)
- **Files modified:** 4 (chunker.ts, chunker.test.ts, package.json, pnpm-lock.yaml)

## Accomplishments

- `chunkMarkdown()` splits markdown at heading boundaries (H1 transparent, H2+ build section_path hierarchy)
- Code blocks and GFM tables are atomic — never split mid-element even when section exceeds MAX_CHUNK_TOKENS
- Short sections (<100 tokens) merge into previous pending bucket; long sections (>500 tokens) split at paragraph boundaries
- `normalizeObsidianSyntax()` strips embeds `![[...]]`, resolves `[[Page|Alias]]` → "Alias", resolves `[[Page]]` → "Page"
- 27 unit tests covering all IDX-03 and IDX-04 behaviors
- js-tiktoken encoder initialized once at module level for efficient token counting

## Task Commits

1. **Task RED: Failing tests** - `d12e02e` (test)
2. **Task GREEN: Chunker implementation** - `f783863` (feat)

## Files Created/Modified

- `src/lib/chunker.ts` — Heading-aware chunker with TDD implementation; exports chunkMarkdown, normalizeObsidianSyntax, MarkdownChunk, ChunkOptions, MIN/MAX_CHUNK_TOKENS
- `src/lib/__tests__/chunker.test.ts` — 27 unit tests covering normalizeObsidianSyntax, heading boundary splitting, short section merging, long section splitting, section path hierarchy, chunk text format, sequential chunkIndex
- `package.json` — Added remark-parse, unified, remark-gfm, js-tiktoken to dependencies
- `pnpm-lock.yaml` — Updated lockfile

## Decisions Made

- **H1 transparency**: H1 headings reset the heading stack and start a new section, but the heading text is NOT added to section_path. This matches Obsidian's convention where H1 is often the note title (which is already the title parameter).
- **Short merge strategy**: A short section merges into the most recent pending bucket. This preserves the first section's path as the chunk's sectionPath. The trade-off: sub-sections with tiny content lose their specific path. This is acceptable for the search use case — tiny sections add no semantic value.
- **js-tiktoken API**: The package exports `getEncoding` (camelCase), not `get_encoding` (snake_case) as documented in some research. Fixed as Rule 1 deviation during GREEN phase.
- **Test content requirements**: Tests for heading boundary and hierarchy behavior require section content >=100 tokens to prevent the short-merge from collapsing expected separate chunks into one. Tests updated to use `generateLongParagraph(110)` helper.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] js-tiktoken export name was get_encoding, actual export is getEncoding**
- **Found during:** GREEN phase (implementation)
- **Issue:** Plan and research referenced `get_encoding('cl100k_base')` but the js-tiktoken package exports `getEncoding` (camelCase)
- **Fix:** Changed import and usage from `get_encoding` to `getEncoding`
- **Files modified:** src/lib/chunker.ts
- **Verification:** Module loaded successfully, all 27 tests pass
- **Committed in:** f783863

**2. [Rule 1 - Bug] Test content was too short for heading-boundary tests**
- **Found during:** GREEN phase (test debugging)
- **Issue:** Tests for "splits at H1/H2", "creates hierarchical section path", "resets hierarchy", "H3 after H1" used content like "Paragraph 1" (3 tokens) which triggered short-merge, producing fewer chunks than expected
- **Fix:** Updated those tests to use `generateLongParagraph(110)` (110+ tokens per section) so each section stands as its own chunk
- **Files modified:** src/lib/__tests__/chunker.test.ts
- **Verification:** All 27 tests pass
- **Committed in:** f783863

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both fixes necessary for correct behavior — API name discovery is a normal part of library integration, test content correction was needed to properly test the heading-boundary behavior.

## Issues Encountered

The short-section merging and heading-boundary splitting behaviors have an inherent tension: both tests use small content (under 100 tokens by nature of being examples), but the short-merge would collapse expected separate sections. Resolution: heading-boundary tests use generated long content, short-merge tests use genuinely minimal content.

## Next Phase Readiness

- `chunkMarkdown()` is ready for consumption by Phase 05-02 (embedding infrastructure)
- The function is pure (no I/O), accepts string + title, returns `MarkdownChunk[]`
- `normalizeObsidianSyntax()` exported for independent testing in downstream phases
- All dependencies (remark-parse, unified, remark-gfm, js-tiktoken) installed and working

---
*Phase: 05-markdown-indexing-pipeline*
*Completed: 2026-03-10*
