# Phase 10: Multi-Format Indexing - Research

**Researched:** 2026-03-12
**Domain:** File parsing (PDF, CSV, Canvas JSON, Excalidraw JSON, image metadata) + Fastify pipeline extension
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**PDF text extraction**
- Text-layer extraction only — no OCR (skip scanned/image-only PDFs)
- Scanned PDFs with no extractable text: track in SQLite, log warning, no vectors in Qdrant
- Page-based chunking: each page is a chunk, split at paragraph boundaries if over 500 tokens
- section_path = "filename > Page N"
- Extract PDF properties (title, author, subject) into Qdrant payload metadata
- Apply minimum token threshold (~10 tokens) per page — skip pages with only headers/footers from scans
- Empty PDFs (no extractable text at all) tracked in SQLite, not indexed in Qdrant

**CSV chunking**
- Fixed row batches: group ~20-50 rows per chunk with column headers repeated in each chunk
- Chunk text format: "Column1: value1, Column2: value2" per row (header:value pairs, not tabular)
- section_path = "filename > Rows N-M"
- Skip empty CSVs (header-only, no data rows) — track in SQLite but no vectors
- Best-effort parsing for malformed CSVs: parse valid rows, skip malformed ones, log warnings
- Consistent with markdown error handling pattern (200 with warning, not failure)

**Canvas JSON parsing**
- Index text nodes only (type='text') — skip file/link nodes that reference other vault items
- One chunk per text node — canvas nodes are typically short self-contained thoughts
- section_path = "CanvasName > Node N"
- Parse .canvas files as JSON (Obsidian Canvas format)

**Excalidraw text extraction**
- Extract text elements only (type='text') — skip shapes, arrows, visual elements
- One chunk per text element (or merge very short elements)
- section_path = "DrawingName > Text N"
- Parse Excalidraw JSON format from .excalidraw files

**Image metadata**
- SQLite tracking only — NO vectors in Qdrant (images have no text to embed)
- Track: name, path, size, file type in indexed_files table
- Track backlinks: scan markdown notes for ![[image.png]] references, store linked notes list in SQLite
- Supported extensions: .png, .jpg, .jpeg, .gif, .svg, .webp, .bmp
- No EXIF extraction — vault images are mostly screenshots/diagrams, not photos
- Backlink tracking is lightweight: regex on existing markdown content during indexing

### Claude's Discretion
- PDF text extraction library choice (pdf-parse, pdf.js, etc.)
- CSV parsing library choice
- Exact row batch size for CSV chunks (within 20-50 range)
- How to extend VaultIndexer.scanVault() to support new extensions
- Pipeline architecture for format-specific handlers (strategy pattern vs switch/case)
- How to integrate image backlink tracking with existing markdown indexing flow
- Excalidraw file detection (extension-based vs content-based)
- Test fixture structure for each format

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| IDX-08 | Service extracts and indexes text from PDF files | pdfjs-dist v5 for text-layer extraction, page-based chunking, SQLite tracking for empty/scanned PDFs |
| IDX-09 | Service parses and indexes Canvas JSON node content | JSON Canvas 1.0 spec: parse .canvas as JSON, filter type='text' nodes, text field holds content |
| IDX-10 | Service extracts and indexes text elements from Excalidraw files | Excalidraw JSON: parse .excalidraw as JSON, filter elements[].type==='text', text field holds content |
| IDX-11 | Service indexes CSV content with row-level chunking | PapaParse v5.5 for robust CSV parsing with header:value chunk format, batch rows 20-50 |
| IDX-12 | Service tracks image files metadata (name, path, linked notes) | SQLite-only: extend indexed_files schema with file_type + linked_notes columns; regex backlink scan |
</phase_requirements>

---

## Summary

Phase 10 extends the existing markdown-only indexer (Phase 5) to handle four additional content formats — PDF, CSV, Canvas JSON, Excalidraw — plus SQLite-only tracking for image files. All five format handlers slot into the existing pipeline event loop via format dispatch in `processCreatedOrUpdated()`. No new API routes or Fastify plugins are needed; this is purely a pipeline and library extension.

The key architectural decision is where to dispatch: `pipeline.ts` already has a `switch (event.type)` for event types; we add a separate format dispatch (based on file extension) inside `processCreatedOrUpdated()`. Each format gets its own chunker module in `src/lib/` that returns the same `{ text, sectionPath, chunkIndex }` shape the pipeline already understands.

The DB schema needs one migration: add `file_type` and `linked_notes` columns to `indexed_files` to support image backlink tracking. The migration pattern is already established (`ALTER TABLE indexed_files ADD COLUMN`), confirmed by the `0001_military_whiplash.sql` precedent.

**Primary recommendation:** Use pdfjs-dist for PDF (ESM-native, active Mozilla project), PapaParse for CSV (best-in-class, ESM-friendly, battle-tested), and plain `JSON.parse` for Canvas and Excalidraw (no library needed — well-documented open formats).

---

## Standard Stack

### Core (new installs needed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| pdfjs-dist | ^5.5.x (latest) | PDF text-layer extraction | Mozilla-maintained, ESM-native via `pdfjs-dist/legacy/build/pdf.mjs`, no native binaries, built-in TypeScript types, handles malformed PDFs gracefully |
| papaparse | ^5.5.3 | CSV parsing | De-facto standard, ESM import `import Papa from 'papaparse'`, `@types/papaparse` available, best-effort malformed row handling built-in, `header:true` gives column-keyed objects |

### No New Library (handled inline)
| Format | Approach | Reason |
|--------|----------|--------|
| Canvas JSON | `JSON.parse()` | Obsidian JSON Canvas 1.0 is a trivial flat object with a `nodes` array; no parser library needed |
| Excalidraw JSON | `JSON.parse()` | `.excalidraw` files are plain JSON with an `elements` array; no library needed |
| Image metadata | Node.js `fs.stat()` | Size, name, path from stat; backlinks via regex on existing markdown content already in memory |

### Supporting (already in project)
| Library | Version | Purpose |
|---------|---------|---------|
| js-tiktoken | ^1.0.21 | Token counting for PDF page split threshold (already installed) |
| drizzle-orm | ^0.45.1 | DB schema migration for image tracking columns (already installed) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| pdfjs-dist | pdf-parse (original v1.x) | Original pdf-parse is CJS-only — requires `createRequire` workaround in ESM project. ESM fork (@cedrugs/pdf-parse) is less tested. pdfjs-dist is higher quality and ESM-native. |
| pdfjs-dist | unpdf | unpdf wraps pdfjs-dist anyway; adds abstraction with no benefit here |
| papaparse | csv-parse (Node streams) | csv-parse requires streaming; PapaParse handles sync string parsing cleanly for vault files which are small |

**Installation:**
```bash
pnpm add pdfjs-dist papaparse
pnpm add -D @types/papaparse
```

---

## Architecture Patterns

### Recommended Project Structure (additions only)
```
src/
  lib/
    chunker.ts           # existing: markdown only
    pdf-chunker.ts       # NEW: PDF page extraction + chunking
    csv-chunker.ts       # NEW: CSV row batch chunking
    canvas-chunker.ts    # NEW: Canvas JSON text node extraction
    excalidraw-chunker.ts # NEW: Excalidraw text element extraction
    __tests__/
      chunker.test.ts    # existing
      pdf-chunker.test.ts    # NEW
      csv-chunker.test.ts    # NEW
      canvas-chunker.test.ts # NEW
      excalidraw-chunker.test.ts # NEW
  plugins/
    pipeline.ts          # modify: add format dispatch
  db/
    schema.ts            # modify: add file_type + linked_notes to indexed_files
drizzle/
  0002_multi_format.sql  # NEW migration
```

### Pattern 1: Shared Chunk Shape
**What:** All format chunkers return `Array<{ text: string; sectionPath: string; chunkIndex: number }>` — the same `MarkdownChunk` type used for markdown. This means `pipeline.ts` can call any chunker and pass the result to `fastify.embedder.embed()` identically.

**When to use:** For all four text-producing formats (PDF, CSV, Canvas, Excalidraw).

```typescript
// Same shape as MarkdownChunk in src/lib/chunker.ts
export interface FormatChunk {
  text: string;
  sectionPath: string;
  chunkIndex: number;
}
```

### Pattern 2: Extension-Based Format Dispatch in pipeline.ts
**What:** Add a `getFileFormat()` helper at the top of `processCreatedOrUpdated()` that switches on `path.extname(event.path)` and calls the appropriate chunker.

```typescript
// Source: cognivault existing pattern (pipeline.ts)
async function processCreatedOrUpdated(
  fastify: FastifyInstance,
  event: FileChangeEvent,
): Promise<void> {
  const ext = path.extname(event.path).toLowerCase();

  // Image files: SQLite tracking only, no Qdrant vectors
  if (IMAGE_EXTENSIONS.has(ext)) {
    await processImage(fastify, event);
    return;
  }

  // Text formats: extract chunks, embed, upsert to Qdrant
  let chunks: FormatChunk[];
  switch (ext) {
    case '.md':
      chunks = await chunkMarkdownFile(fastify, event);
      break;
    case '.pdf':
      chunks = await chunkPdf(fastify, event);
      break;
    case '.csv':
      chunks = await chunkCsv(fastify, event);
      break;
    case '.canvas':
      chunks = await chunkCanvas(fastify, event);
      break;
    case '.excalidraw':
      chunks = await chunkExcalidraw(fastify, event);
      break;
    default:
      return; // Unknown extension — skip
  }

  if (chunks.length === 0) return; // Empty file handled by format-specific logic

  await embedAndUpsert(fastify, event, chunks);
}
```

### Pattern 3: VaultIndexer.scanVault() Extension
**What:** `scanVault()` currently calls `vault.listFiles({ ext: 'md' })`. Since `listFiles` only accepts one extension at a time, call it multiple times and merge results.

```typescript
// Multiple calls, merge results
private async scanVault(): Promise<string[]> {
  const extensions = ['md', 'pdf', 'canvas', 'excalidraw', 'csv',
                      'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'];
  const allPaths: string[] = [];
  for (const ext of extensions) {
    const { entries } = await this.vault.listFiles({ recursive: true, ext });
    allPaths.push(...entries.filter((e) => e.type === 'file').map((e) => e.path));
  }
  return allPaths;
}
```

**Note:** `VaultManager.TEXT_EXTENSIONS` already includes `.canvas`, `.excalidraw`, `.csv`, `.svg` — they pass the read check. PDF `.pdf` is NOT in that set — but `scanVault()` uses `listFiles` which only filters by extension, not TEXT_EXTENSIONS. Binary reads of PDF/images are fine because the indexer reads them via `fs.readFile` directly (not `vault.readContent`).

### Pattern 4: DB Migration for Image Tracking
**What:** Add two nullable columns to `indexed_files` via drizzle-kit generate + a new migration SQL file.

```typescript
// src/db/schema.ts — extend existing table
export const indexedFiles = sqliteTable(
  'indexed_files',
  {
    path: text('path').primaryKey(),
    contentHash: text('content_hash').notNull(),
    mtime: integer('mtime').notNull(),
    size: integer('size').notNull(),
    indexedAt: text('indexed_at').notNull(),
    embeddingModelVersion: text('embedding_model_version'),
    fileType: text('file_type'),           // NEW: 'pdf'|'csv'|'canvas'|'excalidraw'|'image'|'md'
    linkedNotes: text('linked_notes'),     // NEW: JSON array of paths e.g. '["notes/foo.md"]'
  },
  (table) => [index('content_hash_idx').on(table.contentHash)],
);
```

Migration SQL:
```sql
-- drizzle/0002_multi_format.sql
ALTER TABLE `indexed_files` ADD `file_type` text;
ALTER TABLE `indexed_files` ADD `linked_notes` text;
```

### Pattern 5: PDF Extraction with pdfjs-dist
**What:** Use `pdfjs-dist/legacy/build/pdf.mjs` for Node.js ESM. Set `GlobalWorkerOptions.workerSrc = ''` to use fake worker (server-side pattern — no worker thread needed). Iterate pages with `page.getTextContent()`, join `item.str` values.

```typescript
// Source: pdfjs-dist official pattern, verified via lirantal.com/blog
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

// Disable worker for Node.js server-side usage
pdfjsLib.GlobalWorkerOptions.workerSrc = '';

export interface PdfPage {
  pageNum: number;   // 1-based
  text: string;      // raw extracted text
  tokenCount: number;
}

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
}

export async function extractPdfPages(
  buffer: Buffer,
): Promise<{ pages: PdfPage[]; metadata: PdfMetadata }> {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const doc = await loadingTask.promise;

  // Extract metadata
  const meta = await doc.getMetadata().catch(() => null);
  const metadata: PdfMetadata = {
    title: (meta?.info as Record<string, string> | undefined)?.Title,
    author: (meta?.info as Record<string, string> | undefined)?.Author,
    subject: (meta?.info as Record<string, string> | undefined)?.Subject,
  };

  const pages: PdfPage[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .trim();
    pages.push({ pageNum, text, tokenCount: countTokens(text) });
  }

  return { pages, metadata };
}
```

### Pattern 6: PapaParse CSV
```typescript
// Source: PapaParse docs + papaparse.com/docs
import Papa from 'papaparse';

export function parseCsv(content: string): {
  headers: string[];
  rows: Record<string, string>[];
  errors: Papa.ParseError[];
} {
  const result = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    // Best-effort: don't throw on errors
  });
  return {
    headers: result.meta.fields ?? [],
    rows: result.data,
    errors: result.errors,
  };
}
```

### Anti-Patterns to Avoid
- **Reading PDF content via `vault.readContent()`:** That method returns a `string` and `.pdf` is NOT in `TEXT_EXTENSIONS`, so it will throw `UnsupportedMediaTypeError`. Read PDF files directly with `fs.readFile(absPath)` in the pipeline, bypassing `vault.readContent`.
- **Calling `vault.readContent()` for images:** Same issue. Image processing should use `fs.stat()` only (no file read needed for metadata tracking).
- **One scanVault() call with all extensions at once:** `listFiles` only accepts a single `ext` string — must iterate per-extension.
- **Setting `workerSrc` to a file URL in Node.js:** Empty string `''` causes pdf.js to use fake worker, which is the correct server-side pattern and avoids file path issues.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PDF text extraction | Custom PDF binary parser | pdfjs-dist | PDF binary format has complex cross-references, object streams, encoding variants — 10+ years of Mozilla's engineering handles edge cases |
| CSV parsing | Split on commas | PapaParse | CSV has quoted fields, embedded newlines, escaped quotes, BOM markers, encoding variants |
| Canvas/Excalidraw format parsing | Custom JSON walker | `JSON.parse()` + type guard | These ARE simple JSON formats with flat element arrays — JSON.parse is exactly right |
| Token counting | Character count / word count | js-tiktoken (already installed) | Already used in chunker.ts — consistent tokenization for the 500-token page-split threshold |

**Key insight:** PDF and CSV are deceptively complex binary/text formats with decades of quirks. Use established parsers. Canvas and Excalidraw are simple JSON structures that need no special library.

---

## Common Pitfalls

### Pitfall 1: vault.readContent() Rejects PDF and Image Files
**What goes wrong:** `vault.readContent()` checks `TEXT_EXTENSIONS` and throws `UnsupportedMediaTypeError` for `.pdf`, `.png`, `.jpg` etc.
**Why it happens:** VaultManager intentionally blocks binary reads via its public API.
**How to avoid:** In the pipeline handler, read binary files directly via `fs.readFile(this.abs(event.path))` as `Buffer`. Only markdown files use `vault.readContent()`.
**Warning signs:** UnsupportedMediaTypeError in pipeline logs during initial scan.

### Pitfall 2: pdfjs-dist Worker Configuration in Node.js
**What goes wrong:** `GlobalWorkerOptions.workerSrc` not set → warning spam + potential failure in some versions.
**Why it happens:** pdfjs-dist defaults to browser worker model; Node.js has no DOM.
**How to avoid:** Set `pdfjsLib.GlobalWorkerOptions.workerSrc = ''` before any `getDocument()` call. This activates the fake worker path which works correctly server-side.
**Warning signs:** `Warning: Setting up fake worker` in logs (harmless but noisy if not suppressed).

### Pitfall 3: PapaParse Default Export in ESM
**What goes wrong:** `import { parse } from 'papaparse'` fails — PapaParse uses a default export.
**Why it happens:** PapaParse exports `Papa` as default with `.parse`, `.unparse` etc. as methods.
**How to avoid:** Always `import Papa from 'papaparse'` and call `Papa.parse(...)`.
**Warning signs:** TypeScript error: "Module 'papaparse' has no exported member 'parse'".

### Pitfall 4: scanVault() Must Handle Multiple Extensions Separately
**What goes wrong:** Passing an array to `vault.listFiles({ ext: ['md', 'pdf'] })` — `ListOptions.ext` is typed as `string`, not `string[]`.
**Why it happens:** VaultManager only supports single-extension filtering.
**How to avoid:** Loop over extension array, call `listFiles` once per extension, merge results with `Set` deduplication.
**Warning signs:** TypeScript error or silent empty results.

### Pitfall 5: Scanned PDFs Return Zero-Length Text
**What goes wrong:** `extractPdfPages()` returns pages with empty `text` strings — PDF has only image layers, no text layer.
**Why it happens:** pdfjs-dist `getTextContent()` returns empty items for image-only pages (scans, screenshots embedded as PDF).
**How to avoid:** Apply minimum token threshold (~10 tokens). Track file in SQLite as indexed but log a warning and skip Qdrant upsert.
**Warning signs:** All pages in a PDF have `tokenCount === 0`.

### Pitfall 6: SQLite Migration Must Use drizzle-kit generate
**What goes wrong:** Manually editing `schema.ts` without regenerating migrations causes the schema to be out of sync with actual DB file.
**Why it happens:** `createDatabase()` auto-runs migrations from `drizzle/` folder — the SQL files are the source of truth at runtime.
**How to avoid:** Run `pnpm drizzle-kit generate` after editing `schema.ts`, which produces the `ALTER TABLE` SQL. Then commit both `schema.ts` and the new `.sql` file.
**Warning signs:** TypeScript type-checks fine but runtime throws "no such column: file_type".

### Pitfall 7: Canvas vs Excalidraw Detection Edge Cases
**What goes wrong:** Relying on file content to distinguish formats (both are JSON) when the extension is unambiguous.
**Why it happens:** Over-engineering detection.
**How to avoid:** Use extension-based detection only. `.canvas` → Canvas format, `.excalidraw` → Excalidraw format. Content-based detection adds complexity for no benefit (user decision: extension-based).
**Warning signs:** N/A — this pitfall is about avoiding unnecessary complexity.

### Pitfall 8: Image Backlink Regex Must Run on Already-Indexed Markdown
**What goes wrong:** Image backlinks never get populated because the pipeline processes files independently and doesn't cross-reference markdown content at image-processing time.
**Why it happens:** Images are indexed when they're seen as new/changed files — but they need content from markdown files to find backlinks.
**How to avoid:** During image file processing, scan ALL indexed markdown files for `![[imagename]]` patterns. Use the DB `indexed_files` table to find markdown file paths, then read their content. This is a one-time scan per image change event.
**Warning signs:** `linked_notes` column always `null` after indexing.

---

## Code Examples

Verified patterns from official sources and existing codebase:

### Canvas JSON Structure (verified from jsoncanvas.org/spec/1.0)
```typescript
// Source: https://jsoncanvas.org/spec/1.0
interface CanvasFile {
  nodes: CanvasNode[];
  edges?: CanvasEdge[];
}

interface CanvasTextNode {
  id: string;
  type: 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;       // Markdown content
  color?: string;
}

// Type guard
function isTextNode(node: { type: string }): node is CanvasTextNode {
  return node.type === 'text';
}
```

### Excalidraw JSON Structure (verified from excalidraw deepwiki docs)
```typescript
// Source: https://deepwiki.com/excalidraw/excalidraw/6.2-json-serialization
interface ExcalidrawFile {
  type: 'excalidraw';
  version: number;
  elements: ExcalidrawElement[];
  appState?: unknown;
  files?: unknown;
}

interface ExcalidrawTextElement {
  id: string;
  type: 'text';
  text: string;       // Actual text content
  x: number;
  y: number;
  width: number;
  height: number;
  // ... other visual properties
}

function isTextElement(el: { type: string }): el is ExcalidrawTextElement {
  return el.type === 'text';
}
```

### CSV Chunk Format (from user decision)
```typescript
// "Column1: value1, Column2: value2" per row
function rowToText(row: Record<string, string>, headers: string[]): string {
  return headers
    .filter((h) => row[h] !== undefined && row[h] !== '')
    .map((h) => `${h}: ${row[h]}`)
    .join(', ');
}

// Chunk with headers repeated in each batch
function buildCsvChunk(rows: Record<string, string>[], headers: string[], startRow: number): string {
  const rowTexts = rows.map((r) => rowToText(r, headers));
  return rowTexts.join('\n');
}
```

### Stale Vector Cleanup (existing pattern from pipeline.ts, reusable)
```typescript
// Source: existing src/plugins/pipeline.ts — same pattern applies for all formats
await fastify.qdrant.delete('cognivault', {
  filter: {
    must: [
      { key: 'path', match: { value: event.path } },
      { key: 'chunk_index', range: { gte: chunks.length } },
    ],
  },
});
```

### Drizzle Migration Pattern (from existing drizzle/0001_military_whiplash.sql)
```sql
-- drizzle/0002_multi_format.sql
ALTER TABLE `indexed_files` ADD `file_type` text;
ALTER TABLE `indexed_files` ADD `linked_notes` text;
```

### Image Backlink Regex (from user decision)
```typescript
// Match ![[image.png]] or ![[subfolder/image.jpg]]
const EMBED_REGEX = /!\[\[([^\]]+)\]\]/g;

function extractImageBacklinks(markdownContent: string, imageName: string): boolean {
  const matches = [...markdownContent.matchAll(EMBED_REGEX)];
  return matches.some((m) => {
    // Handle path variants: [[image.png]], [[subfolder/image.png]], [[image]] (no ext)
    const ref = m[1] as string;
    return ref === imageName || ref.endsWith(`/${imageName}`) || ref.split('|')[0] === imageName;
  });
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| pdf-parse v1.x (CJS-only) | pdfjs-dist v5.x (ESM-native) | 2024 | No require() workaround needed in ESM projects |
| Separate text/type definitions for canvas | JSON Canvas 1.0 open spec | 2024 (Obsidian open-sourced it) | Single canonical format, well-documented |
| pdf-parse v1 `module.parent` hack | pdfjs-dist with `workerSrc = ''` | — | Clean server-side PDF extraction without CJS hacks |

**Deprecated/outdated:**
- `pdf-parse` v1.x (original npm): CJS-only, uses `module.parent` which doesn't exist in ESM. Avoid.
- `pdf.js` direct import (browser build): Requires canvas polyfills in Node.js. Use `legacy/build/pdf.mjs` path.

---

## Open Questions

1. **pdfjs-dist standardFontDataUrl in Docker**
   - What we know: pdfjs-dist can require font data for accurate text positioning; `standardFontDataUrl` points to `node_modules/pdfjs-dist/standard_fonts/`
   - What's unclear: Whether skipping `standardFontDataUrl` causes extraction failures or just rendering issues (irrelevant for text-only extraction)
   - Recommendation: Omit `standardFontDataUrl` initially and test with real PDFs. Add only if text extraction produces garbled output.

2. **VaultManager.readContent() for .canvas and .excalidraw files**
   - What we know: These extensions ARE in `TEXT_EXTENSIONS` in vault.ts (line 187-189), so `vault.readContent()` works for them
   - What's unclear: Whether using `vault.readContent()` vs direct `fs.readFile` is more correct architecturally
   - Recommendation: Use `vault.readContent()` for `.canvas` and `.excalidraw` (they're text/JSON), use direct `fs.readFile` only for `.pdf` and image files.

3. **Image backlink scan performance at scale**
   - What we know: Backlink tracking requires reading all markdown files when an image is created/updated
   - What's unclear: Performance impact on large vaults (1000+ notes) when a single image changes
   - Recommendation: This is acceptable for Phase 10 scope — vault images rarely change. If performance becomes an issue, it can be optimized in Phase 11 or later.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.0.18 |
| Config file | vitest.config.ts (root) |
| Quick run command | `pnpm test -- --run src/lib/__tests__/pdf-chunker.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| IDX-08 | PDF text extraction + page chunking | unit | `pnpm test -- --run src/lib/__tests__/pdf-chunker.test.ts` | Wave 0 |
| IDX-08 | Empty/scanned PDF skips Qdrant, logs warning | unit | `pnpm test -- --run src/lib/__tests__/pdf-chunker.test.ts` | Wave 0 |
| IDX-09 | Canvas JSON text node extraction | unit | `pnpm test -- --run src/lib/__tests__/canvas-chunker.test.ts` | Wave 0 |
| IDX-10 | Excalidraw text element extraction | unit | `pnpm test -- --run src/lib/__tests__/excalidraw-chunker.test.ts` | Wave 0 |
| IDX-11 | CSV row-batch chunking with header:value format | unit | `pnpm test -- --run src/lib/__tests__/csv-chunker.test.ts` | Wave 0 |
| IDX-12 | Image SQLite tracking + backlink extraction | unit | `pnpm test -- --run src/lib/__tests__/image-tracker.test.ts` | Wave 0 |
| IDX-08..12 | Pipeline dispatch routes each extension correctly | unit | `pnpm test -- --run src/plugins/__tests__/pipeline.test.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test -- --run src/lib/__tests__/pdf-chunker.test.ts` (or relevant chunker)
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/lib/__tests__/pdf-chunker.test.ts` — covers IDX-08 (unit tests with Buffer fixtures, no real PDF.js calls — mock `extractPdfPages`)
- [ ] `src/lib/__tests__/canvas-chunker.test.ts` — covers IDX-09 (pure JSON input, no mocking needed)
- [ ] `src/lib/__tests__/excalidraw-chunker.test.ts` — covers IDX-10 (pure JSON input, no mocking needed)
- [ ] `src/lib/__tests__/csv-chunker.test.ts` — covers IDX-11 (string CSV input, PapaParse called directly)
- [ ] `src/lib/__tests__/image-tracker.test.ts` — covers IDX-12
- [ ] `src/plugins/__tests__/pipeline.test.ts` — covers format dispatch (mock all chunkers + embedder)
- [ ] `drizzle/0002_multi_format.sql` — required before runtime DB migration runs

---

## Sources

### Primary (HIGH confidence)
- JSON Canvas 1.0 spec at jsoncanvas.org/spec/1.0 — node types, text node schema, verified directly
- deepwiki.com/excalidraw/excalidraw/6.2-json-serialization — Excalidraw element format, text field confirmed
- Existing codebase (`src/plugins/pipeline.ts`, `src/lib/vault.ts`, `src/db/schema.ts`) — read directly

### Secondary (MEDIUM confidence)
- pdfjs-dist: lirantal.com/blog (verified ESM import path `pdfjs-dist/legacy/build/pdf.mjs`, page iteration pattern, `standardFontDataUrl` note)
- PapaParse: papaparse.com/docs (default export, `header:true` option, `skipEmptyLines`, `errors` array for malformed input)
- drizzle-orm SQLite ALTER TABLE pattern: confirmed from `drizzle/0001_military_whiplash.sql` in project

### Tertiary (LOW confidence)
- pdfjs-dist `GlobalWorkerOptions.workerSrc = ''` disabling worker in Node.js: documented in GitHub issues, widely used pattern but not in official pdfjs-dist Node.js docs

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — pdfjs-dist and PapaParse verified via official docs/npm; Canvas/Excalidraw formats verified via official specs
- Architecture: HIGH — based on reading actual existing code (pipeline.ts, vault.ts, schema.ts), not assumptions
- Pitfalls: HIGH for vault.readContent() binary file issue (confirmed in vault.ts source); MEDIUM for pdfjs-dist worker (GitHub issues pattern); HIGH for PapaParse default export (documented API)

**Research date:** 2026-03-12
**Valid until:** 2026-04-12 (stable libraries; pdfjs-dist releases frequently but API is stable)
