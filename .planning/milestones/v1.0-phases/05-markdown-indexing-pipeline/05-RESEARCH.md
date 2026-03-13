# Phase 5: Markdown Indexing Pipeline - Research

**Researched:** 2026-03-10
**Domain:** Markdown AST chunking, OpenAI embeddings, Qdrant vector storage, event-driven pipeline wiring
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Chunking strategy:**
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

**Embedding provider:**
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

**Qdrant collection design:**
- Single collection named "cognivault", auto-created on startup if missing
- Cosine distance metric
- Official `@qdrant/js-client-rest` library
- Deterministic chunk IDs: UUID v5 or SHA-256 of "{file_path}:{chunk_index}"
- Payload schema: path (keyword), title (keyword), chunk_index (integer), section_path (keyword), tags (keyword[]), project (keyword), status (keyword), type (keyword), content_hash (keyword), extra_metadata (text)
- Payload indexes on: path, tags, project, status, type

**Pipeline wiring:**
- Pipeline registers as Fastify plugin, listens to 'changes' events on `fastify.indexer`
- On 'created'/'updated': read → chunk → embed → upsert to Qdrant
- On 'deleted': delete all vectors matching path in Qdrant
- On 'moved': setPayload to update path field only — no re-embedding
- Stale vector cleanup on edit: delete vectors where chunk_index >= new_chunk_count (count-based, uses deterministic IDs)
- `embedding_model_version` column added to `indexed_files` SQLite table in this phase
- Listener removed on Fastify shutdown (onClose hook)
- Partial failures (single note) don't block pipeline

### Claude's Discretion
- Exact markdown parser/AST library choice for heading-aware chunking
- Token counting implementation (tiktoken vs approximation)
- UUID v5 namespace vs SHA-256 truncation for chunk IDs
- Qdrant payload index configuration details
- Test fixture structure for chunker and pipeline tests
- Internal queue implementation details (p-queue vs p-limit)

### Deferred Ideas (OUT OF SCOPE)
- Embedding model version-based selective reindex (EMB-02)
- Multi-vault collection namespacing — v2 requirement (MVLT-02)
- PDF/Canvas/CSV/image chunking strategies — Phase 10
- Lexical/BM25 sparse vectors in Qdrant — Phase 6
- Admin reindex endpoints — Phase 11
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| IDX-03 | Service chunks markdown by heading/section boundaries preserving hierarchy | remark-parse + mdast AST; heading nodes have `depth` 1-6; walk root.children to collect nodes per section |
| IDX-04 | Each chunk carries section_path metadata (e.g. "Note Title > H2 > H3") | Build heading stack during AST walk; serialize as ">" delimited string stored in Qdrant payload |
| IDX-05 | Service extracts and indexes frontmatter fields into Qdrant payload | gray-matter already installed; strip frontmatter before chunking, pass parsed data as Qdrant payload fields |
| IDX-07 | Service removes stale vectors when notes are deleted or chunks change | Qdrant `delete()` with keyword filter on `path` field for deletions; deterministic IDs enable delete-by-ID range for edit cleanup |
</phase_requirements>

---

## Summary

Phase 5 wires together four distinct technical components: a heading-aware markdown chunker, an OpenAI embedding client, Qdrant collection management, and an event-driven pipeline that connects them to the existing `VaultIndexer`. All four areas have stable, well-documented libraries available; the primary implementation work is algorithmic (the chunker) and integration (the pipeline plugin).

The AST-based chunker uses `remark-parse` (unified ecosystem, MIT, ESM-native) to parse markdown into a typed mdast tree. Heading nodes carry a `depth` field (1–6) that drives section boundary detection. Code (`code` node type) and table nodes can be identified by type and kept whole. The chunker never touches the filesystem directly — it receives a string from `VaultManager.readContent()` after gray-matter strips frontmatter.

For embeddings, the official `openai` SDK v6 accepts an array of strings as `input` to `embeddings.create()`, making per-note batching a single call. `p-queue` (v9, ESM-native) provides concurrency control across notes being processed in parallel. Qdrant upsert uses deterministic UUID v5 IDs keyed on `{file_path}:{chunk_index}`, enabling clean count-based stale cleanup without querying existing vectors.

**Primary recommendation:** Use `remark-parse` for AST chunking (not regex or string splitting), `openai` SDK v6 for batch embedding, `@qdrant/js-client-rest` v1.17 for vector storage, and `p-queue` v9 for pipeline concurrency.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `openai` | ^6.27.0 | OpenAI API calls (embeddings) | Official TypeScript SDK; accepts string[] input for batch embedding; ESM-native |
| `@qdrant/js-client-rest` | ^1.17.0 | Qdrant vector database REST client | Official client; typed operations for upsert, delete, setPayload, createPayloadIndex |
| `remark-parse` | ^11.0.0 | Markdown → mdast AST | Parses into structured tree with typed heading/code/table nodes; unified ecosystem |
| `unified` | ^11.0.5 | AST pipeline processor | Required peer for remark-parse; runs parser to produce Root node |
| `p-queue` | ^9.1.0 | Concurrency-limited async queue | ESM-native; concurrency option; onIdle() for pipeline drain; well-maintained (sindresorhus) |
| `uuid` | ^13.0.0 | UUID v5 deterministic chunk IDs | RFC9562; v5() produces SHA-1 based deterministic UUIDs; no deps; ESM |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `js-tiktoken` | ^1.0.21 | Token counting for chunk sizing | Pure JS port of tiktoken; no WASM; works cleanly in Node.js ESM; needed for accurate ~100/~500 thresholds |
| `gray-matter` | ^4.0.3 | Frontmatter extraction | **Already installed** — strip frontmatter before chunking body; parse YAML fields into payload |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `remark-parse` | `marked` or regex | marked produces HTML, not AST; regex cannot reliably handle nested fenced blocks and tables |
| `js-tiktoken` | Character/word approximation (÷4 per token) | Approximation is ~20% error rate; for ~100 min / ~500 max thresholds, error can cause under-merge or over-split; js-tiktoken adds ~22MB but eliminates WASM complexity of `tiktoken` |
| `uuid` v5 | SHA-256 hex truncation | Both work; UUID v5 is RFC-compliant, slightly more portable; SHA-256 avoids a dependency; either is fine per CONTEXT.md discretion |
| `p-queue` | `p-limit` (already installed) | p-limit controls per-invocation concurrency but lacks queue semantics (onIdle, pause, clear); p-queue is better for sustained pipeline operations |

### Installation

```bash
pnpm add openai @qdrant/js-client-rest remark-parse unified p-queue uuid js-tiktoken
pnpm add -D @types/uuid
```

---

## Architecture Patterns

### Recommended Project Structure

```
src/
  lib/
    chunker.ts          # Markdown AST chunker (pure function, no I/O)
    embedding.ts        # EmbeddingProvider interface + OpenAI implementation
  plugins/
    qdrant.ts           # Qdrant client plugin, collection init, fastify.qdrant
    pipeline.ts         # Indexing pipeline plugin, event listener wiring
  db/
    schema.ts           # Add embedding_model_version column (existing file)
  config.ts             # Add OPENAI_API_KEY, OPENAI_BASE_URL, EMBEDDING_MODEL (existing)
drizzle/
  0001_add_embedding_model_version.sql  # New migration
```

### Pattern 1: remark-parse AST Walk for Heading-Aware Chunking

**What:** Parse markdown string into mdast Root, walk children, accumulate nodes per heading section, serialize each section back to markdown string.

**When to use:** Any time markdown must be split at semantic boundaries, preserving code blocks and tables whole.

**Example:**

```typescript
// Source: https://unifiedjs.com/explore/package/remark-parse/
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, Heading, Code, Table, Node } from 'mdast';

const processor = unified().use(remarkParse);

export function parseMarkdown(content: string): Root {
  return processor.parse(content) as Root;
}

// Walk root.children — each heading node is a section boundary
function isHeading(node: Node): node is Heading {
  return node.type === 'heading';
}

function isAtomicBlock(node: Node): node is Code | Table {
  return node.type === 'code' || node.type === 'table';
}
```

### Pattern 2: mdast → Text Serialization (without remark-stringify)

**What:** Convert mdast nodes back to plain text for embedding — strip markdown syntax, keep content.

**When to use:** When chunk text should be clean prose, not raw markdown syntax with `##`, `**`, etc.

**Example:**

```typescript
// Walk node tree extracting text values
function nodeToText(node: Node): string {
  if ('value' in node && typeof node.value === 'string') {
    return node.value;  // Text, InlineCode, Code nodes
  }
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.map(nodeToText).join('');
  }
  return '';
}
```

Note: Per CONTEXT.md decisions, prepend `"Note Title > H2 > H3\n\n"` to each chunk text before embedding.

### Pattern 3: Obsidian Syntax Normalization

**What:** Normalize wikilinks and strip embeds from chunk text before embedding.

**When to use:** After serializing mdast nodes to text, before token counting.

**Example:**

```typescript
// Applied to chunk text after AST serialization
export function normalizeObsidianSyntax(text: string): string {
  // [[Page|Alias]] → "Alias"
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  // [[Page Name]] → "Page Name"
  text = text.replace(/\[\[([^\]]+)\]\]/g, '$1');
  // ![[embed]] → ""
  text = text.replace(/!\[\[[^\]]*\]\]/g, '');
  return text.trim();
}
```

### Pattern 4: Qdrant Upsert with Deterministic IDs

**What:** Generate UUID v5 from `{file_path}:{chunk_index}`, upsert points with full payload.

**When to use:** Every 'created' and 'updated' file event.

**Example:**

```typescript
// Source: https://qdrant.tech/documentation/concepts/points/
import { v5 as uuidv5 } from 'uuid';

const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // UUID v5 DNS namespace

export function chunkId(filePath: string, chunkIndex: number): string {
  return uuidv5(`${filePath}:${chunkIndex}`, NAMESPACE);
}

// Upsert
await qdrant.upsert('cognivault', {
  points: chunks.map((chunk, i) => ({
    id: chunkId(filePath, i),
    vector: embeddings[i],
    payload: {
      path: filePath,
      title: chunk.title,
      chunk_index: i,
      section_path: chunk.sectionPath,
      tags: chunk.tags ?? [],
      project: chunk.project ?? null,
      status: chunk.status ?? null,
      type: chunk.type ?? null,
      content_hash: fileHash,
      extra_metadata: JSON.stringify(chunk.extraMetadata),
    },
  })),
});
```

### Pattern 5: Stale Vector Cleanup (Count-Based)

**What:** After upserting N new chunks, delete old chunks at indices >= N by ID.

**When to use:** On 'updated' events — file was shorter previously.

**Example:**

```typescript
// Deterministic IDs make this clean: old chunk IDs are predictable
// Delete by filter is simpler for edit case when old count is unknown
await qdrant.delete('cognivault', {
  filter: {
    must: [
      { key: 'path', match: { value: filePath } },
      { key: 'chunk_index', range: { gte: newChunkCount } },
    ],
  },
});
```

### Pattern 6: Move Event — Payload Update Only

**What:** When a note is moved/renamed, update `path` field in Qdrant payload without re-embedding.

**Example:**

```typescript
// Source: https://qdrant.tech/documentation/concepts/payload/
await qdrant.setPayload('cognivault', {
  payload: { path: newPath },
  filter: {
    must: [{ key: 'path', match: { value: oldPath } }],
  },
});
```

### Pattern 7: Delete All Vectors for a Path

**What:** On 'deleted' event, remove all vectors with matching path.

**Example:**

```typescript
await qdrant.delete('cognivault', {
  filter: {
    must: [{ key: 'path', match: { value: deletedPath } }],
  },
});
```

### Pattern 8: Qdrant Collection Initialization

**What:** On plugin startup, check if collection exists; create with cosine distance if not.

**Example:**

```typescript
// Source: https://qdrant.tech/documentation/concepts/collections/
import { QdrantClient } from '@qdrant/js-client-rest';

const qdrant = new QdrantClient({ url: config.QDRANT_URL });

const collections = await qdrant.getCollections();
const exists = collections.collections.some(c => c.name === 'cognivault');

if (!exists) {
  await qdrant.createCollection('cognivault', {
    vectors: { size: dimensions, distance: 'Cosine' },
  });

  // Create payload indexes for filtered search
  for (const field of ['path', 'project', 'status', 'type'] as const) {
    await qdrant.createPayloadIndex('cognivault', {
      field_name: field,
      field_schema: 'keyword',
    });
  }
  // tags is a keyword array
  await qdrant.createPayloadIndex('cognivault', {
    field_name: 'tags',
    field_schema: 'keyword',
  });
}
```

### Pattern 9: Fastify Plugin with decorate

**What:** Following the established project pattern, plugins expose services via `fastify.decorate()`.

**Example:**

```typescript
// Source: project SKILL.md and existing plugins (src/plugins/indexer.ts)
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { QdrantClient } from '@qdrant/js-client-rest';

declare module 'fastify' {
  interface FastifyInstance {
    qdrant: QdrantClient;
  }
}

async function qdrantPlugin(fastify: FastifyInstance): Promise<void> {
  const client = new QdrantClient({ url: config.QDRANT_URL });
  // ... collection setup ...
  fastify.decorate('qdrant', client);
}

export default fp(qdrantPlugin, { name: 'qdrant', dependencies: ['db'] });
```

### Pattern 10: p-queue for Note-Level Concurrency

**What:** Queue indexing operations per-note with concurrency limit 3.

**Example:**

```typescript
// Source: https://github.com/sindresorhus/p-queue
import PQueue from 'p-queue';

const queue = new PQueue({ concurrency: 3 });

// For each 'changes' event batch
for (const event of events) {
  void queue.add(async () => {
    try {
      await processFileEvent(event);
    } catch (err) {
      fastify.log.error({ event, err }, 'Pipeline processing failed — will retry on next poll');
    }
  });
}
```

### Anti-Patterns to Avoid

- **Splitting markdown by regex on `^##`**: Fails on headings inside code blocks. Always use AST.
- **Including frontmatter text in chunk content**: Frontmatter belongs only in Qdrant payload, not embedded text.
- **Re-embedding on 'moved' events**: Waste of API quota — content is identical. Use `setPayload` with a filter.
- **Creating a new Qdrant collection per startup without existence check**: Causes 409 errors after first run.
- **Using `p-limit` instead of `p-queue` for sustained pipeline**: `p-limit` is per-invocation; doesn't queue subsequent work, loses backpressure.
- **Passing `require()` in ESM context**: `p-queue`, `uuid`, `unified`, and `remark-parse` are all ESM-only — project already uses ESM (`"type": "module"` in package.json), so this is naturally handled.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Markdown parsing | Regex heading detection | `remark-parse` + mdast | Regex splits inside fenced code blocks; AST gives node types |
| Token counting | `text.length / 4` approximation | `js-tiktoken` with `cl100k_base` | ±20% error on approximation; embeddings models use cl100k_base; real token counts prevent silent chunk size violations |
| Deterministic IDs | Custom hash-to-UUID conversion | `uuid` v5 | RFC-compliant, no collision risk, no truncation ambiguity |
| API retry/backoff | Custom setTimeout retry loop | Exponential backoff utility or openai SDK built-in retries | OpenAI SDK has built-in `maxRetries` option that handles 429/500; avoids reimplementing jitter |
| Qdrant client | fetch() calls to REST API | `@qdrant/js-client-rest` | Typed operations; handles authentication, serialization |

**Key insight:** The chunker is the one genuinely custom piece — no library handles Obsidian-specific wikilink normalization + heading-aware splitting + token budget simultaneously. Everything else is delegation to well-tested libraries.

---

## Common Pitfalls

### Pitfall 1: remark-parse ESM Import

**What goes wrong:** `import remarkParse from 'remark-parse'` works fine, but `const processor = unified().use(remarkParse)` must be called with the default export, not named export.
**Why it happens:** remark-parse v11 is ESM; exports a default function as the plugin.
**How to avoid:** Use `import remarkParse from 'remark-parse'` (default import); never `import { remarkParse }`.
**Warning signs:** TypeScript error "does not have a default export" resolved by checking that `remark-parse` v11 is installed (not v10 which had different export shape).

### Pitfall 2: Qdrant Collection Already Exists on Restart

**What goes wrong:** Calling `createCollection()` on every startup throws a 409 conflict after the first run.
**Why it happens:** The collection persists in Qdrant across service restarts.
**How to avoid:** Call `getCollections()` first, check `collections.collections.some(c => c.name === 'cognivault')`, only call `createCollection()` if absent.
**Warning signs:** Unhandled promise rejection on plugin startup with HTTP 409.

### Pitfall 3: Payload Index Creation Order

**What goes wrong:** Trying to create payload indexes before the collection exists.
**Why it happens:** `createPayloadIndex()` requires the collection to already exist.
**How to avoid:** Create collection first, then create all payload indexes in the same startup sequence.

### Pitfall 4: js-tiktoken WASM / Initialization

**What goes wrong:** `js-tiktoken` requires calling `get_encoding('cl100k_base')` once at module load, not per chunk. Calling it per-chunk is expensive.
**Why it happens:** Loading the encoding initializes WASM/token tables.
**How to avoid:** Initialize encoder once at module top-level or chunker constructor: `const enc = get_encoding('cl100k_base')`. Call `enc.free()` on process exit if needed (though in long-running server processes this is rarely critical).

### Pitfall 5: Drizzle Migration for New Column

**What goes wrong:** Adding `embedding_model_version` column to `indexedFiles` Drizzle schema without generating a new migration SQL file causes the column to not exist at runtime.
**Why it happens:** `drizzle-orm/better-sqlite3/migrator` reads from `./drizzle/` folder; schema.ts changes alone don't update the DB.
**How to avoid:** Run `pnpm drizzle-kit generate` after editing `schema.ts` to produce `drizzle/0001_*.sql`. The generated SQL file must be committed. Migration runs automatically on next `createDatabase()` call.
**Warning signs:** `SqliteError: table indexed_files has no column named embedding_model_version`.

### Pitfall 6: OpenAI SDK `maxRetries` vs Manual Retry

**What goes wrong:** Building a manual retry loop around `embeddings.create()` duplicates logic already in the SDK.
**Why it happens:** Developers reach for manual retry before checking SDK options.
**How to avoid:** Pass `maxRetries: 3` to the `OpenAI` constructor. The SDK handles 429 (rate limit), 500, and network errors with exponential backoff automatically.

### Pitfall 7: Qdrant `delete()` with Integer `chunk_index` Range

**What goes wrong:** Using `{ range: { gte: newChunkCount } }` on `chunk_index` requires `chunk_index` to be indexed as an integer field in Qdrant for range queries to work efficiently (and at all in some Qdrant versions).
**Why it happens:** Range filters on un-indexed integer fields may not work correctly.
**How to avoid:** Add `createPayloadIndex` for `chunk_index` with `field_schema: 'integer'` during collection init, or delete by explicit point IDs computed from deterministic chunk IDs.

### Pitfall 8: Table Node in mdast is GFM Extension

**What goes wrong:** Standard `remark-parse` alone does not parse GitHub Flavored Markdown tables. Table nodes (`type: 'table'`) only appear when `remark-gfm` plugin is added.
**Why it happens:** Tables are a GFM extension, not CommonMark.
**How to avoid:** Add `remark-gfm` to the unified processor: `unified().use(remarkParse).use(remarkGfm)`. Install `remark-gfm` (v4, ESM).
**Warning signs:** Markdown tables are left as paragraph nodes with pipe characters.

---

## Code Examples

### Chunker Shape

```typescript
// src/lib/chunker.ts
export interface MarkdownChunk {
  text: string;           // Normalized text with section_path prepended
  sectionPath: string;    // "Note Title > H2 > H3"
  chunkIndex: number;     // 0-based position within note
}

export interface ChunkOptions {
  title: string;          // Note title (filename without extension)
  frontmatter: Record<string, unknown>;  // From gray-matter
}

export function chunkMarkdown(body: string, opts: ChunkOptions): MarkdownChunk[] {
  // 1. Parse to AST via unified().use(remarkParse).use(remarkGfm)
  // 2. Walk root.children, group nodes by heading boundaries
  // 3. For each section: serialize to text, normalize Obsidian syntax
  // 4. Count tokens with js-tiktoken cl100k_base
  // 5. Merge short sections (<100 tokens) into parent
  // 6. Split long sections (>500 tokens) at paragraph boundaries
  // 7. Prepend "Title > H2 > H3\n\n" to each chunk text
  // Return MarkdownChunk[]
}
```

### EmbeddingProvider Interface

```typescript
// src/lib/embedding.ts
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  private model: string;
  private dimensions: number;

  constructor(opts: { apiKey: string; baseUrl?: string; model: string }) {
    this.model = opts.model;
    this.dimensions = DIMENSION_MAP[opts.model];  // fail fast on unknown model
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
      maxRetries: 3,
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,  // Array<string> — batch all chunks in one call
    });
    return response.data
      .sort((a, b) => a.index - b.index)
      .map(e => e.embedding);
  }
}
```

### Pipeline Plugin Shape

```typescript
// src/plugins/pipeline.ts — event listener pattern matching src/plugins/indexer.ts
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import PQueue from 'p-queue';
import type { FileChangeEvent } from '../lib/indexer.js';

async function pipelinePlugin(fastify: FastifyInstance): Promise<void> {
  const queue = new PQueue({ concurrency: 3 });

  const onChanges = (events: FileChangeEvent[]): void => {
    for (const event of events) {
      void queue.add(async () => {
        await processEvent(fastify, event);
      });
    }
  };

  fastify.indexer.on('changes', onChanges);

  fastify.addHook('onClose', async () => {
    fastify.indexer.removeListener('changes', onChanges);
    await queue.onIdle();  // drain in-flight work
  });
}

export default fp(pipelinePlugin, {
  name: 'pipeline',
  dependencies: ['indexer', 'qdrant'],
});
```

### Qdrant Client Constructor

```typescript
// Source: https://qdrant.tech/documentation/quickstart/
import { QdrantClient } from '@qdrant/js-client-rest';

const qdrant = new QdrantClient({ url: 'http://localhost:6333' });
// url is the full URL including port; no separate host/port options needed
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `@dqbd/tiktoken` (community) | `js-tiktoken` (official port) | 2023 | js-tiktoken is the maintained pure-JS port; `tiktoken` npm is WASM-based and requires special loader config |
| `qdrant-js` v1.x (older API) | `@qdrant/js-client-rest` v1.17 | Ongoing | Version tracking follows Qdrant engine; 1.17 aligns with Qdrant 1.17.x features |
| `openai` v4 | `openai` v6 | 2024-2025 | v6 is current; project state says v6 is what to install; batch embedding array input unchanged from v4 |
| CommonJS `require('p-queue')` | ESM `import PQueue from 'p-queue'` | p-queue v8+ | p-queue dropped CJS; project is ESM (`"type": "module"`) so this is naturally compatible |
| `remark-gfm` v3 (CJS) | `remark-gfm` v4 (ESM) | remark-gfm v4 | Must install v4 for ESM compatibility with unified v11/remark-parse v11 |

**Deprecated/outdated:**
- `@dqbd/tiktoken`: Predecessor package; use `js-tiktoken` or `tiktoken` instead
- `remark-parse` v10: CJS; v11 is ESM and required for unified v11 compatibility

---

## Open Questions

1. **remark-gfm for table parsing**
   - What we know: Standard CommonMark parsing in `remark-parse` does not produce `table` nodes
   - What's unclear: Whether Obsidian vault content uses GFM tables (very likely) or only simple lists
   - Recommendation: Install `remark-gfm` v4 unconditionally; adds ~zero overhead and ensures tables are recognized as atomic blocks

2. **chunk_index range delete in Qdrant without integer payload index**
   - What we know: Qdrant requires payload indexes for efficient filter operations; range filters on integer fields work best with integer indexes
   - What's unclear: Whether Qdrant throws an error or just does a full scan on un-indexed integer filters
   - Recommendation: Add `chunk_index` integer payload index during collection init to ensure range-delete works correctly and efficiently

3. **OpenAI batch size limits**
   - What we know: OpenAI embeddings API accepts array input; LangChain's default batch size is 512
   - What's unclear: Whether very large notes (100+ chunks) need sub-batching within the single-note call
   - Recommendation: For v1, batch all chunks per note in one call; add sub-batching if practical testing reveals 413 errors (unlikely for typical Obsidian notes)

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest v4.0.18 |
| Config file | `vitest.config.ts` (root) — `include: ['src/**/__tests__/**/*.test.ts']` |
| Quick run command | `pnpm test -- --run src/lib/__tests__/chunker.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| IDX-03 | Chunks split at heading boundaries; code/table not split mid-element | unit | `pnpm test -- --run src/lib/__tests__/chunker.test.ts` | Wave 0 |
| IDX-03 | Short sections (<100 tokens) merge into parent | unit | `pnpm test -- --run src/lib/__tests__/chunker.test.ts` | Wave 0 |
| IDX-03 | Long sections (>500 tokens) split at paragraph boundaries | unit | `pnpm test -- --run src/lib/__tests__/chunker.test.ts` | Wave 0 |
| IDX-04 | section_path reflects heading hierarchy correctly | unit | `pnpm test -- --run src/lib/__tests__/chunker.test.ts` | Wave 0 |
| IDX-04 | Obsidian wikilinks normalized in chunk text | unit | `pnpm test -- --run src/lib/__tests__/chunker.test.ts` | Wave 0 |
| IDX-05 | Frontmatter fields extracted into payload; body not included | unit | `pnpm test -- --run src/lib/__tests__/chunker.test.ts` | Wave 0 |
| IDX-07 | Deleted note removes all vectors from Qdrant (mocked) | unit | `pnpm test -- --run src/plugins/__tests__/pipeline.test.ts` | Wave 0 |
| IDX-07 | Updated note removes stale vectors (chunk_index >= new count) | unit | `pnpm test -- --run src/plugins/__tests__/pipeline.test.ts` | Wave 0 |
| IDX-07 | Moved note updates path in Qdrant payload without re-embedding | unit | `pnpm test -- --run src/plugins/__tests__/pipeline.test.ts` | Wave 0 |

### Sampling Rate

- **Per task commit:** `pnpm test -- --run src/lib/__tests__/chunker.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/lib/__tests__/chunker.test.ts` — covers IDX-03, IDX-04, IDX-05 (chunker pure function, no I/O, no mocks needed)
- [ ] `src/lib/__tests__/embedding.test.ts` — covers EmbeddingProvider interface; mock OpenAI client
- [ ] `src/plugins/__tests__/pipeline.test.ts` — covers IDX-07; mock qdrant and embedder decorators
- [ ] `src/plugins/__tests__/qdrant.test.ts` — covers collection init and payload index creation; mock QdrantClient

---

## Sources

### Primary (HIGH confidence)

- Official Qdrant docs (qdrant.tech/documentation) — points upsert, delete by filter, setPayload with filter, payload indexing, collection creation
- openai npm package v6.27.0 — embeddings.create() API, array input, response shape (verified via npm info + OpenAI API reference)
- remark-parse npm v11.0.0 / unified v11.0.5 — ESM-native, mdast AST structure, heading depth field (verified via unifiedjs.com)
- @qdrant/js-client-rest v1.17.0 — official client, Apache-2.0 (verified via npm info)
- p-queue v9.1.0 — ESM module, concurrency option, onIdle() (verified via sindresorhus/p-queue GitHub)
- uuid v13.0.0 — v5() deterministic UUID, RFC9562 (verified via npm info)
- js-tiktoken v1.0.21 — pure JS tiktoken port, cl100k_base encoding for text-embedding-3-small (verified via npm info + openai-cookbook)

### Secondary (MEDIUM confidence)

- Qdrant payload `range` filter for integer fields — verified via Qdrant API reference (api.qdrant.tech) search results
- OpenAI SDK `maxRetries` option — inferred from SDK v4/v6 consistency; SDK docs confirm built-in retry handling
- remark-gfm v4 required for ESM + table parsing — verified via unified ecosystem ESM requirement pattern

### Tertiary (LOW confidence — flag for validation)

- js-tiktoken initialization cost per encoding load — stated as common knowledge in tiktoken ecosystem; verify by benchmarking if startup time is a concern
- Qdrant range filter on un-indexed integer field behavior — Qdrant may do full scan without index; recommend adding integer index proactively

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages verified via npm registry with current versions
- Architecture: HIGH — patterns directly derived from official Qdrant and OpenAI docs + existing project code
- Pitfalls: HIGH (remark-gfm, Drizzle migration) / MEDIUM (Qdrant integer range without index)

**Research date:** 2026-03-10
**Valid until:** 2026-04-10 (stable libraries; Qdrant client minor updates expected but API-compatible)
