# Phase 10: Multi-Format Indexing - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Non-markdown vault content (PDF, Canvas, Excalidraw, CSV, images) is indexed and searchable. Extends the existing indexer (Phase 4) and pipeline (Phase 5) to handle additional file formats. Admin reindex endpoints are a separate phase (11).

</domain>

<decisions>
## Implementation Decisions

### PDF text extraction
- Text-layer extraction only — no OCR (skip scanned/image-only PDFs)
- Scanned PDFs with no extractable text: track in SQLite, log warning, no vectors in Qdrant
- Page-based chunking: each page is a chunk, split at paragraph boundaries if over 500 tokens
- section_path = "filename > Page N"
- Extract PDF properties (title, author, subject) into Qdrant payload metadata
- Apply minimum token threshold (~10 tokens) per page — skip pages with only headers/footers from scans
- Empty PDFs (no extractable text at all) tracked in SQLite, not indexed in Qdrant

### CSV chunking
- Fixed row batches: group ~20-50 rows per chunk with column headers repeated in each chunk
- Chunk text format: "Column1: value1, Column2: value2" per row (header:value pairs, not tabular)
- section_path = "filename > Rows N-M"
- Skip empty CSVs (header-only, no data rows) — track in SQLite but no vectors
- Best-effort parsing for malformed CSVs: parse valid rows, skip malformed ones, log warnings
- Consistent with markdown error handling pattern (200 with warning, not failure)

### Canvas JSON parsing
- Index text nodes only (type='text') — skip file/link nodes that reference other vault items
- One chunk per text node — canvas nodes are typically short self-contained thoughts
- section_path = "CanvasName > Node N"
- Parse .canvas files as JSON (Obsidian Canvas format)

### Excalidraw text extraction
- Extract text elements only (type='text') — skip shapes, arrows, visual elements
- One chunk per text element (or merge very short elements)
- section_path = "DrawingName > Text N"
- Parse Excalidraw JSON format from .excalidraw files

### Image metadata
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

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `VaultIndexer` (src/lib/indexer.ts): Currently scans `.md` only via `listFiles({ ext: 'md' })` — needs extension
- `chunkMarkdown` (src/lib/chunker.ts): Markdown-specific — new formats need separate chunking functions
- Pipeline (src/plugins/pipeline.ts): Tightly coupled to markdown (`gray-matter`, `chunkMarkdown`, `.md` title extraction) — needs format dispatch
- `chunkId()` in pipeline.ts: UUID v5 from `{path}:{chunk_index}` — reusable for all formats
- `omit()` helper in pipeline.ts — reusable for metadata extraction
- `p-queue` concurrency control in pipeline — reusable for all format processing

### Established Patterns
- Fastify plugin registration order: error-handler → auth → vault → db → indexer → qdrant → embedder → pipeline
- `FileChangeEvent` interface: `{ path, type, contentHash, oldPath? }` — format-agnostic, works for all file types
- Qdrant payload schema: `path`, `title`, `chunk_index`, `section_path`, `tags`, `project`, `status`, `type`, `content_hash`, `extra_metadata`, `text`
- Stale vector cleanup via `chunk_index >= new_count` filter
- Deterministic chunk IDs: UUID v5 from `{path}:{chunk_index}`

### Integration Points
- `src/lib/indexer.ts`: Extend `scanVault()` to include .pdf, .canvas, .excalidraw, .csv, image extensions
- `src/plugins/pipeline.ts`: Add format dispatch in `processCreatedOrUpdated()` based on file extension
- `src/db/schema.ts`: Potentially extend `indexed_files` for image backlink tracking
- New chunker modules: `src/lib/pdf-chunker.ts`, `src/lib/csv-chunker.ts`, `src/lib/canvas-chunker.ts`, `src/lib/excalidraw-chunker.ts`

</code_context>

<specifics>
## Specific Ideas

- User consistently chose recommended/standard approaches across all four areas (established pattern from all prior phases)
- Image backlink tracking via regex on markdown ![[]] embeds is lightweight and adds real value for "which notes reference this image?" queries
- CSV header:value pair format chosen specifically to help embedding models understand column semantics
- Canvas/Excalidraw text-only extraction avoids duplicating content from notes already indexed in Phase 5
- PDF page-based chunking avoids unreliable heading detection in PDFs

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 10-multi-format-indexing*
*Context gathered: 2026-03-12*
