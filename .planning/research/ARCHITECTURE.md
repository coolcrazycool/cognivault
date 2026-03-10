# Architecture Patterns

**Domain:** Unified knowledge access service (file ops + indexing + hybrid retrieval + context assembly)
**Researched:** 2026-03-10

## Recommended Architecture

CogniVault is a single-process Node.js/TypeScript service with internally modular subsystems communicating through in-process event bus and direct function calls. No microservices, no message queues -- simplicity for 1-3 concurrent agents.

```
                         REST API Layer
                    (Fastify + TOON negotiation)
                              |
         +--------------------+--------------------+
         |                    |                    |
    File Ops            Retrieval            Context Pack
    Module              Pipeline             Assembler
         |                    |                    |
         |          +---------+---------+          |
         |          |         |         |          |
         |      Semantic   Lexical   Metadata      |
         |      Search     Search    Filter         |
         |          |         |         |          |
         |          +----+----+---------+          |
         |               |                         |
         |          RRF Fusion                     |
         |               |                         |
         |          Cross-Encoder                  |
         |          Reranker                       |
         |               |                         |
         +-------+-------+-------+---------+-------+
                 |               |         |
            Vault Manager    Qdrant    SQLite
            (filesystem)    (vectors)  (index state)
                 |
            FS Poller
            (change detection)
                 |
           Indexing Pipeline
           (chunk -> embed -> store)
```

### Component Boundaries

| Component | Responsibility | Communicates With | Data Owned |
|-----------|---------------|-------------------|------------|
| **API Layer** | HTTP routing, auth, content negotiation (JSON/TOON), request validation | All modules via direct calls | None (stateless) |
| **Vault Manager** | Multi-vault registry, path resolution, path traversal protection, file CRUD | API Layer, FS Poller, Indexing Pipeline | Vault configs, path mappings |
| **File Ops Module** | Note/file CRUD, frontmatter parsing, atomic writes | API Layer, Vault Manager | None (filesystem is source of truth) |
| **FS Poller** | Periodic filesystem scanning, content hash comparison, change event emission | Vault Manager, Indexing Pipeline, SQLite (index state) | Poll state (last scan timestamps) |
| **Indexing Pipeline** | Markdown-aware chunking, multi-format parsing, embedding generation, Qdrant upsert, stale vector cleanup | FS Poller (triggered by), Vault Manager, Embedding Provider, Qdrant, SQLite | Chunk metadata, processing queue |
| **Embedding Provider** | Abstract interface over embedding models, batching, rate limiting | Indexing Pipeline, Retrieval Pipeline | Provider config |
| **Retrieval Pipeline** | Hybrid search orchestration: semantic + lexical + metadata filtering, RRF fusion, reranking | API Layer, Qdrant, Reranker, Vault Manager | None (stateless query path) |
| **Reranker** | Cross-encoder scoring of candidate results | Retrieval Pipeline | Provider config |
| **Context Pack Assembler** | Token-budget-aware assembly of search results into structured knowledge bundles | API Layer, Retrieval Pipeline, File Ops (for full note fetching) | None (stateless) |
| **Observability** | Structured logging, Prometheus metrics, OpenTelemetry tracing | Cross-cutting (all components) | None (emits to external collectors) |

### Critical Boundary Rule

The filesystem is the single source of truth. Qdrant and SQLite are derived state. If they are lost, a full reindex from disk restores everything. This means:
- Writes always go to disk first, then trigger reindexing
- Reads of note content come from disk (not Qdrant payloads)
- Qdrant stores embeddings + metadata for search, not authoritative content

## Data Flow

### Write Path (Async)

```
Agent POST /vaults/:vault/notes/:path
    |
    v
API Layer (validate, auth)
    |
    v
File Ops Module (atomic write to disk via temp-file + rename)
    |
    v
Return 201/200 to agent immediately
    |
    (async, decoupled)
    v
FS Poller detects change on next scan cycle
    |
    v
Indexing Pipeline:
  1. Read file from disk
  2. Parse frontmatter + extract metadata
  3. Chunk content (markdown-aware, section hierarchy)
  4. Hash chunks, compare to SQLite index state
  5. Embed only changed/new chunks (batch to embedding provider)
  6. Upsert vectors to Qdrant with payload
  7. Delete stale vectors (removed chunks, renamed files)
  8. Update SQLite index state (hashes, timestamps, model version)
```

**Why async write:** Embedding latency (100-500ms per batch via OpenAI API) must not block the agent's write request. The agent gets a fast 200, and indexing catches up within the poll interval.

### Read/Search Path (Synchronous)

```
Agent GET /vaults/:vault/search?q=...&filters=...
    |
    v
API Layer (validate, auth, parse content negotiation)
    |
    v
Retrieval Pipeline (parallel execution):
    |
    +---> Semantic Search: embed query -> Qdrant ANN search
    |     (filtered by vault_id payload + metadata filters)
    |
    +---> Lexical Search: BM25/trigram over indexed content
    |     (SQLite FTS5 or in-memory index)
    |
    v
RRF Fusion: merge ranked lists using Reciprocal Rank Fusion
    |
    v
Cross-Encoder Reranker: score top-K candidates (Cohere or BGE)
    |
    v
Return ranked results (JSON or TOON based on Accept header)
```

### Context Pack Assembly

```
Agent POST /vaults/:vault/context-pack
  body: { query, token_budget: 32000, filters, include_metadata: true }
    |
    v
Retrieval Pipeline (hybrid search as above)
    |
    v
Context Pack Assembler:
  1. Take reranked results
  2. Fetch full note content from disk for top results
  3. Extract relevant sections (not full notes if over budget)
  4. Assemble structured bundle:
     - Summary of sources
     - Ranked content blocks with source attribution
     - Metadata (tags, projects, dates)
  4. Token counting: fit within budget, prioritize by relevance score
  5. Format as TOON or JSON per Accept header
    |
    v
Return context pack to agent
```

### Indexing Pipeline Detail

```
File Change Detected
    |
    v
Format Router:
  .md  --> Markdown Parser (frontmatter + AST)
  .pdf --> PDF text extractor
  .canvas --> Canvas JSON parser
  .excalidraw --> Excalidraw text extractor
  .csv --> CSV/tabular parser
  image --> Metadata extractor (EXIF, filename)
    |
    v
Markdown-Aware Chunker:
  - Split on heading boundaries (H1, H2, H3...)
  - Preserve heading hierarchy in chunk metadata
    (e.g., section_path: ["Project Setup", "Database", "Migrations"])
  - Respect code block boundaries (never split mid-block)
  - Target chunk size: 512-1024 tokens (tunable)
  - Overlap: include parent heading in each chunk for context
    |
    v
Chunk Differ (SQLite):
  - Hash each chunk (content_hash)
  - Compare against stored hashes
  - Only embed NEW or CHANGED chunks
  - Mark DELETED chunks for removal
    |
    v
Embedding Batcher:
  - Batch chunks (e.g., 20-50 per API call)
  - Rate limit per provider config
  - Retry with exponential backoff
    |
    v
Qdrant Upsert:
  - Point ID: deterministic from vault_id + path + chunk_index
  - Vector: embedding
  - Payload: {
      vault_id, path, title, chunk_index, section_path,
      tags, project, status, content_hash, content_preview,
      language, updated_at, embedding_model
    }
    |
    v
Stale Cleanup:
  - Delete points for removed chunks
  - Handle renames: detect via content_hash match + path change
  - Handle deletes: remove all points for deleted file
```

## Qdrant Collection Design

**Use a single collection per embedding model with payload-based vault isolation.** This is Qdrant's officially recommended multitenancy approach.

```
Collection: "cognivault_embeddings"
  - vault_id field with keyword index, is_tenant: true
  - This co-locates vectors from same vault for sequential read performance
  - At <5 vaults with <5000 notes each, well under the 20K promotion threshold
```

**Payload index configuration:**
- `vault_id`: keyword index, `is_tenant: true` (tenant isolation)
- `path`: keyword index (exact path lookups)
- `tags`: keyword index (multi-value filtering)
- `project`: keyword index (project filtering)
- `status`: keyword index (status filtering)
- `content_hash`: keyword index (dedup/stale detection)
- `updated_at`: integer index (recency filtering)

**Why not separate collections per vault:**
- Resource overhead: each collection has its own HNSW graph, WAL, optimizer threads
- At 2-5 vaults, the overhead is manageable but unnecessary
- Payload filtering with `is_tenant: true` gives equivalent isolation with better resource utilization
- If a vault grows beyond 20K points, Qdrant's tiered multitenancy can promote it to a dedicated shard transparently

## Lexical Search Strategy

For BM25/lexical search alongside Qdrant's semantic search, use **SQLite FTS5**. This avoids adding another external dependency (like Elasticsearch/Meilisearch) while providing solid full-text search:

- FTS5 is built into SQLite, zero additional infrastructure
- Supports tokenization customization (important for mixed Russian/English)
- Handles exact term matching well (technical identifiers, acronyms)
- Query-time performance is excellent for the 500-5000 note range
- Already using SQLite for index state, so no new connection management

**Table structure:**
```sql
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  title,
  tags,
  vault_id UNINDEXED,
  path UNINDEXED,
  chunk_id UNINDEXED,
  tokenize='unicode61'  -- handles Russian + English
);
```

## Patterns to Follow

### Pattern 1: Provider Abstraction with Strategy Pattern

Abstract embedding and reranking behind interfaces so providers are swappable without touching business logic.

```typescript
interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly modelId: string;
}

interface RerankerProvider {
  rerank(query: string, documents: string[], topK: number): Promise<RerankResult[]>;
}

// Implementations
class OpenAIEmbeddingProvider implements EmbeddingProvider { ... }
class LocalBGEEmbeddingProvider implements EmbeddingProvider { ... }
class CohereRerankerProvider implements RerankerProvider { ... }
class BGERerankerProvider implements RerankerProvider { ... }
```

**Why:** The project explicitly requires starting with OpenAI embeddings but swapping to local models later. Baking provider details into business logic creates painful migrations.

### Pattern 2: Event-Driven Indexing with Backpressure

The FS Poller emits change events; the Indexing Pipeline consumes them with bounded concurrency.

```typescript
// FS Poller emits typed events
type FileChangeEvent = {
  vault_id: string;
  path: string;
  type: 'created' | 'modified' | 'deleted' | 'renamed';
  content_hash?: string;
};

// Indexing Pipeline processes with concurrency control
class IndexingPipeline {
  private queue: PQueue; // concurrency: 1-3 files at a time

  async processChange(event: FileChangeEvent): Promise<void> {
    await this.queue.add(() => this.indexFile(event));
  }
}
```

**Why:** Without backpressure, a full reindex (500-5000 files) will overwhelm the embedding API rate limit and consume all available memory loading files simultaneously.

### Pattern 3: Deterministic Point IDs in Qdrant

Generate Qdrant point IDs deterministically from vault + path + chunk index so upserts are idempotent.

```typescript
function pointId(vaultId: string, path: string, chunkIndex: number): string {
  return createHash('sha256')
    .update(`${vaultId}:${path}:${chunkIndex}`)
    .digest('hex')
    .slice(0, 32); // UUID-length hex
}
```

**Why:** Without deterministic IDs, reindexing the same file creates duplicate vectors. With them, upsert naturally replaces the old vector.

### Pattern 4: Content Hash for Change Detection

Hash file content (not just mtime) to avoid unnecessary reindexing when Obsidian Sync touches files without changing them.

```typescript
function contentHash(content: Buffer): string {
  return createHash('xxhash64').update(content).digest('hex');
  // xxhash for speed; cryptographic strength unnecessary
}
```

**Why:** Obsidian Sync may update file metadata (mtime) without changing content. Content hashing prevents wasted embedding API calls.

### Pattern 5: Graceful Degradation

The service should remain functional even when external providers are unavailable:

- **Qdrant down:** File ops still work. Search returns error. Health endpoint reports degraded.
- **Embedding API down:** File ops still work. New indexing queued for retry. Existing vectors still searchable.
- **Reranker API down:** Fall back to RRF-only ranking (no cross-encoder). Log warning.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Storing Full Content in Qdrant Payloads
**What:** Putting entire note content into Qdrant point payloads for "convenience."
**Why bad:** Bloats Qdrant storage, slows queries, creates a second source of truth that can drift from disk. Qdrant payloads are for metadata and short previews, not full documents.
**Instead:** Store content_preview (first 200 chars) in payload. Fetch full content from disk when needed.

### Anti-Pattern 2: Synchronous Embedding in Write Path
**What:** Embedding chunks before returning the write response to the agent.
**Why bad:** OpenAI embedding calls take 100-500ms per batch. Agent write latency balloons from <50ms to >500ms. If the embedding API is down, writes fail entirely.
**Instead:** Write to disk, return immediately, let FS Poller trigger async indexing.

### Anti-Pattern 3: Global HNSW Without Tenant Filtering
**What:** Building a single HNSW graph without per-tenant optimization, then applying vault_id filter post-search.
**Why bad:** Post-filtering can miss relevant results because ANN search returns approximate top-K before filtering. Pre-filtering with `is_tenant: true` builds per-tenant sub-indexes.
**Instead:** Configure vault_id payload index with `is_tenant: true` for pre-filtered ANN search.

### Anti-Pattern 4: One Collection Per Vault
**What:** Creating a separate Qdrant collection for each vault.
**Why bad:** Each collection has its own HNSW graph, optimizer threads, WAL. At 2-5 vaults this is manageable but wasteful. At 10+ vaults it becomes a resource drain.
**Instead:** Single collection with payload-based tenant isolation.

### Anti-Pattern 5: Monolithic Request Handler
**What:** Putting search logic, reranking, context assembly, and formatting in a single route handler.
**Why bad:** Untestable, impossible to reuse search logic across endpoints, difficult to add new search strategies.
**Instead:** Compose pipeline stages as independent modules with clear interfaces.

## Scalability Considerations

| Concern | At 500 notes | At 5,000 notes | At 50,000 notes |
|---------|-------------|----------------|-----------------|
| **Qdrant vectors** | ~5K points (10 chunks/note avg) | ~50K points | ~500K points, consider HNSW tuning |
| **Full reindex time** | ~2 min (OpenAI embeddings) | ~20 min | ~3 hours, must be resumable |
| **SQLite FTS5** | Instant queries | Instant queries | May need WAL mode tuning |
| **Poll interval** | 5-10 seconds | 5-10 seconds | 15-30 seconds to reduce I/O |
| **Memory** | ~100MB | ~200MB | ~500MB+, consider streaming chunks |
| **Embedding costs** | ~$0.05 full reindex | ~$0.50 full reindex | ~$5.00, incremental-only critical |

CogniVault's target range (500-5000 notes) is comfortably within single-process, single-Qdrant-node capacity. The architecture does not need to plan for distributed systems.

## Suggested Build Order

The dependency graph dictates a bottom-up build order:

### Phase 1: Foundation (no external dependencies except filesystem)
1. **Vault Manager** -- multi-vault config, path resolution, traversal protection
2. **File Ops Module** -- CRUD operations on disk
3. **API Layer skeleton** -- Fastify setup, routing, auth middleware, health endpoints

*Rationale:* These components have zero external dependencies and are testable in isolation. File ops are the most basic capability agents need.

### Phase 2: Index State + Change Detection
4. **SQLite index state** -- schema, migrations, hash storage
5. **FS Poller** -- periodic scanning, content hashing, change event emission

*Rationale:* Change detection requires index state tracking. Both are prerequisites for the indexing pipeline.

### Phase 3: Indexing Pipeline
6. **Markdown-aware chunker** -- heading-based splitting, hierarchy preservation
7. **Multi-format parsers** -- PDF, Canvas, CSV, etc.
8. **Embedding Provider abstraction** -- OpenAI implementation first
9. **Qdrant integration** -- collection setup, upsert, delete, payload indexes
10. **Indexing Pipeline orchestrator** -- ties chunking + embedding + Qdrant together

*Rationale:* Each sub-component can be built and tested independently. The orchestrator composes them. This is the most complex phase.

### Phase 4: Retrieval
11. **Semantic search** -- query embedding + Qdrant ANN with filters
12. **Lexical search** -- FTS5 integration, BM25 scoring
13. **RRF Fusion** -- merge ranked lists
14. **Reranker integration** -- Cohere/BGE cross-encoder
15. **Search API endpoint** -- wire retrieval pipeline to HTTP

*Rationale:* Retrieval depends on having indexed data. Semantic search is simplest, then add lexical, then fuse, then rerank -- each layer improves precision.

### Phase 5: Context Assembly + Polish
16. **Context Pack Assembler** -- token budgeting, section extraction, structured output
17. **TOON content negotiation** -- serialize/deserialize TOON format
18. **Observability** -- OpenTelemetry tracing, Prometheus metrics, structured logging

*Rationale:* Context packs depend on retrieval working. TOON is a serialization concern that can be added late. Observability is cross-cutting and best added once the core works.

## Technology Notes

### Framework: Fastify over Express
Fastify provides schema-based validation, built-in serialization hooks (useful for TOON negotiation), and significantly better performance. Its plugin system maps well to CogniVault's modular architecture.

### Concurrency Model
Node.js single-threaded event loop is sufficient for 1-3 concurrent agents. CPU-intensive work (chunking, hashing) should use worker threads only if profiling reveals bottlenecks. Embedding and reranking are I/O-bound (API calls), not CPU-bound.

### SQLite Access
Use `better-sqlite3` for synchronous access (simpler code, no callback hell) with WAL mode enabled for concurrent reads during writes. The index state DB is small enough that synchronous access won't block the event loop.

## Sources

- [Qdrant Multitenancy Guide](https://qdrant.tech/documentation/guides/multitenancy/) -- official recommendation for payload-based tenant isolation (HIGH confidence)
- [Qdrant Tiered Multitenancy](https://qdrant.tech/blog/qdrant-1.16.x/) -- v1.16 promotion thresholds and sharding
- [Pinecone Chunking Strategies](https://www.pinecone.io/learn/chunking-strategies/) -- heading-based markdown chunking patterns
- [Firecrawl Chunking Best Practices 2026](https://www.firecrawl.dev/blog/best-chunking-strategies-rag) -- section hierarchy preservation
- [Cohere Rerank on AWS](https://aws.amazon.com/blogs/big-data/enhancing-search-relevancy-with-cohere-rerank-3-5-and-amazon-opensearch-service/) -- cross-encoder reranking architecture
- [SBERT Retrieve & Re-Rank](https://sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html) -- two-stage retrieval pipeline pattern
- [Chokidar](https://github.com/paulmillr/chokidar) -- filesystem watching library for Node.js
- [Building Production RAG Systems 2026](https://brlikhon.engineer/blog/building-production-rag-systems-in-2026-complete-architecture-guide) -- modular RAG architecture patterns
