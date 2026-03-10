# Phase 5: Markdown Indexing Pipeline - Context

**Gathered:** 2026-03-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Markdown files are chunked, embedded, and stored in Qdrant with rich metadata. Delivers: heading-aware chunker, embedding pipeline with OpenAI integration, Qdrant collection setup with upsert and payload schema, stale vector cleanup on edit/delete/rename. Lexical search, hybrid retrieval, and multi-format indexing are separate phases (6-7, 10).

</domain>

<decisions>
## Implementation Decisions

### Chunking strategy
- Split markdown by heading boundaries (H1-H6); code blocks and tables are never split mid-element
- Short sections (<100 tokens) merge into parent section's chunk
- Maximum chunk size ~500 tokens; split at paragraph boundaries within a section if exceeded
- No overlap between chunks — heading-aware splitting preserves semantic boundaries
- Prepend note title + section_path to every chunk text: "Note Title > H2 > H3\n\n{chunk content}"
- Notes without headings treated as single section, split at paragraph boundaries if over max
- Frontmatter-only notes (no body content) skip indexing — metadata still tracked in SQLite
- Tables kept whole and attached to their section; if table alone exceeds max, it becomes its own chunk
- Frontmatter content NOT included in chunk text — goes to Qdrant payload as structured metadata only
- Obsidian-specific syntax normalized: [[Page Name]] → "Page Name", [[Page|Alias]] → "Alias", embeds (![[...]]) stripped, callouts kept as text
- Code blocks (fenced and inline) kept in chunks as-is; never split mid-block
- Chunk size thresholds hardcoded as constants (not env vars) — ~100 min, ~500 max tokens

### Embedding provider
- Configurable model via `EMBEDDING_MODEL` env var, default `text-embedding-3-small` (1536 dimensions)
- Dimension lookup table in code: `{ 'text-embedding-3-small': 1536, 'text-embedding-3-large': 3072 }` — fail fast on unknown model
- `OPENAI_API_KEY` env var (standard convention), validated at startup via Zod config
- Optional `OPENAI_BASE_URL` env var for custom endpoints (Azure OpenAI, local proxies) — no default, uses standard OpenAI endpoint
- Official OpenAI SDK (`openai` npm package) for API calls
- `EmbeddingProvider` interface: `embed(texts: string[]): Promise<number[][]>` — OpenAI implementation first, swappable
- Batch all chunks from one note in a single OpenAI API call (array input)
- p-queue with concurrency limit 3 for parallel note processing
- Retry with exponential backoff on transient errors (429, 500, network), 3 attempts, then skip file and log error — poller retries next cycle
- Validate API connectivity on startup — send small test embedding during plugin registration, fail fast if invalid

### Qdrant collection design
- Single collection named "cognivault", auto-created on startup if missing
- Cosine distance metric
- Official `@qdrant/js-client-rest` library
- Deterministic chunk IDs: UUID v5 or SHA-256 of "{file_path}:{chunk_index}"
- Payload schema per chunk:
  - `path` (keyword) — relative file path from vault root
  - `title` (keyword) — note title (filename without extension)
  - `chunk_index` (integer) — position within the note
  - `section_path` (keyword) — heading hierarchy e.g. "Note Title > H2 > H3"
  - `tags` (keyword[]) — from frontmatter, normalized to array
  - `project` (keyword) — from frontmatter
  - `status` (keyword) — from frontmatter
  - `type` (keyword) — from frontmatter
  - `content_hash` (keyword) — SHA-256 of source file for cleanup correlation
  - `extra_metadata` (text) — JSON string of remaining frontmatter fields for future use
- Payload indexes created on: path, tags, project, status, type

### Pipeline wiring
- Pipeline registers as Fastify plugin, listens to 'changes' events on `fastify.indexer`
- On 'created' / 'updated' events: read file → chunk → embed → upsert to Qdrant
- On 'deleted' events: delete all vectors with matching path from Qdrant
- On 'moved' events: update `path` field in Qdrant payload for all chunks — no re-embedding (content unchanged)
- Stale vector cleanup on edit: after upserting new chunks, delete vectors where chunk_index >= new_chunk_count (count-based, leverages deterministic IDs)
- `embedding_model_version` column added to `indexed_files` SQLite table in this phase (deferred from Phase 4) — set on successful embedding
- Listener removed on Fastify shutdown (onClose hook)
- Partial failures (single note) don't block pipeline — log error, skip, poller will re-detect on next cycle

### Claude's Discretion
- Exact markdown parser/AST library choice for heading-aware chunking
- Token counting implementation (tiktoken vs approximation)
- UUID v5 namespace vs SHA-256 truncation for chunk IDs
- Qdrant payload index configuration details
- Test fixture structure for chunker and pipeline tests
- Internal queue implementation details (p-queue vs p-limit)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `VaultIndexer` (src/lib/indexer.ts): Emits `FileChangeEvent[]` via EventEmitter — pipeline subscribes to 'changes' events
- `VaultManager` (src/lib/vault.ts): `readContent()` for reading note body, `readMetadata()` for frontmatter — used by pipeline to read files before chunking
- `config.ts`: Zod-validated config — extend with OPENAI_API_KEY, OPENAI_BASE_URL, EMBEDDING_MODEL
- `indexedFiles` DB schema (src/db/schema.ts): Add `embedding_model_version` column
- `gray-matter`: Already installed for frontmatter parsing — reuse in chunker for stripping frontmatter before body chunking
- `p-limit`: Already installed (used in indexer) — reuse for embedding concurrency control

### Established Patterns
- Fastify plugin registration in app.ts: error-handler → auth → vault → db → indexer → (pipeline goes here)
- `fastify.decorator()` pattern for shared services: `fastify.vault`, `fastify.db`, `fastify.indexer` → add `fastify.embedder` and `fastify.qdrant`
- Feature code in src/lib/ for business logic, src/plugins/ for Fastify integration
- Tests use `fastify.inject()` with top-level env vars and dynamic import

### Integration Points
- `src/config.ts`: Add OPENAI_API_KEY, OPENAI_BASE_URL, EMBEDDING_MODEL
- `src/db/schema.ts`: Add embedding_model_version column to indexed_files
- `src/app.ts`: Register embedding plugin, qdrant plugin, and pipeline plugin (after indexer)
- `src/lib/chunker.ts`: New — markdown-aware chunker module
- `src/lib/embedding.ts`: New — EmbeddingProvider interface + OpenAI implementation
- `src/plugins/qdrant.ts`: New — Qdrant client plugin, collection setup
- `src/plugins/pipeline.ts`: New — indexing pipeline wiring (listens to indexer events)

</code_context>

<specifics>
## Specific Ideas

- User consistently chose recommended/standard approaches across all four areas (established pattern from Phases 1-4)
- Deterministic chunk IDs enable count-based stale cleanup without querying Qdrant for existing vectors
- Move events avoid re-embedding by updating payload path only — preserves API budget
- EmbeddingProvider interface provides swapability to local models (BGE, nomic-embed) per PROJECT.md constraints
- Startup validation covers both OpenAI API key and Qdrant connectivity — fail fast on infrastructure issues

</specifics>

<deferred>
## Deferred Ideas

- Embedding model version-based selective reindex — v2 requirement (EMB-02), column added now for future use
- Multi-vault collection namespacing ("cognivault_{vault_name}") — v2 requirement (MVLT-02)
- PDF/Canvas/CSV/image chunking strategies — Phase 10
- Lexical/BM25 sparse vectors in Qdrant — Phase 6
- Admin reindex endpoints — Phase 11

</deferred>

---

*Phase: 05-markdown-indexing-pipeline*
*Context gathered: 2026-03-10*
