# Technology Stack

**Project:** CogniVault
**Researched:** 2026-03-10

## Recommended Stack

### Runtime & Language

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Node.js | 22 LTS | Runtime | LTS with good performance, native fetch, stable ESM. v22 is current LTS through April 2027. | HIGH |
| TypeScript | 5.7+ | Language | Type safety across the entire codebase. Fastify, Drizzle, Zod all have first-class TS support. | HIGH |
| ESM-only | - | Module system | All modern deps (Fastify v5, chokidar v5, Zod v4) are ESM-first. No CommonJS compatibility headaches. | HIGH |

### Web Framework

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Fastify | 5.8.x | REST API framework | 2-3x faster than Express, schema-based validation (integrates with Zod), encapsulated plugin architecture, first-class TypeScript, built-in JSON serialization optimization. Actively maintained (5.8.2 released March 2026). v4 retired June 2025 -- v5 is the only path. | HIGH |

**Why not Express:** Slower, middleware-based architecture is messier for a service with distinct domains (files, search, indexing). Express 5 has been in beta for years.

**Why not Hono:** Good for edge/serverless, but CogniVault is a long-running Docker service with filesystem access. Fastify's plugin encapsulation is better for this architecture.

### Validation

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Zod | 4.3.x | Schema validation & type inference | 14x faster string parsing vs Zod 3, `.toJSONSchema()` for OpenAPI generation, native Fastify integration via `fastify-type-provider-zod`. Dual use: request validation + config validation. | HIGH |

**Why not Ajv directly:** Fastify uses Ajv internally, but Zod gives TypeScript type inference from schemas. Use `fastify-type-provider-zod` to bridge Zod schemas to Fastify's Ajv-based validation.

### Database (Index State)

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| better-sqlite3 | 11.x | SQLite driver | Synchronous API (perfect for index state checks in hot path), zero config, ACID, fastest SQLite driver for Node.js. | HIGH |
| Drizzle ORM | 0.45.x | Type-safe query builder | SQL-centric (not ActiveRecord-style), uses better-sqlite3 as driver, type-safe schema definitions, migration support via drizzle-kit, sync API support. Lightweight -- not a heavy ORM. | HIGH |
| drizzle-kit | latest | Schema migrations | Generates SQL migrations from schema diffs. Essential for schema evolution. | HIGH |

**Why not Prisma:** Too heavy for index state management. Prisma Client adds ~2MB, requires engine binary, async-only. Drizzle is <100KB, sync-capable, SQL-first.

**Why not raw better-sqlite3:** Works fine, but Drizzle adds type-safe queries and migration management with negligible overhead. The schema (file hashes, embedding versions, timestamps) will evolve.

### Vector Database

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Qdrant | 1.15+ (Docker) | Vector storage & search | Native sparse vector support (BM25 built-in since 1.15.2), Query API for hybrid search server-side, multilingual tokenizer with Russian stemming support, payload filtering, collection-level multi-vault isolation. | HIGH |
| @qdrant/js-client-rest | latest (aligned with Qdrant version) | Qdrant client | Official REST client, typed API, lightweight. REST is simpler to debug than gRPC for this scale. | HIGH |

**Why not Weaviate/Pinecone/Milvus:** Qdrant has native BM25 sparse vectors (no external BM25 computation needed), built-in Russian language stemming, and the Query API handles RRF fusion server-side. Self-hosted, no cloud dependency. Other options would require client-side BM25 + separate fusion logic.

**Critical for this project:** Qdrant 1.15+ has built-in multilingual BM25 with Russian stemming and stopwords. This eliminates the need for a separate lexical search engine (no Elasticsearch/MeiliSearch sidecar needed). Hybrid search (dense + sparse) with RRF fusion happens entirely server-side via the Query API.

### Embedding

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| openai (SDK) | 6.x | OpenAI API client | Official SDK, typed, handles retries/rate limiting. Used for text-embedding-3-small/large. | HIGH |
| text-embedding-3-small | - | Default embedding model | 1536 dimensions, strong multilingual performance (Russian + English), cheap ($0.02/M tokens), supports dimension reduction via API parameter. | HIGH |

**Embedding provider abstraction:** Define an `EmbeddingProvider` interface (`embed(texts: string[]): Promise<number[][]>`) with an OpenAI implementation first. Future providers (BGE-M3 via Ollama, nomic-embed) implement the same interface. Store provider name + model version in SQLite for reindex tracking.

**Why text-embedding-3-small over large:** For 500-5K notes, small is sufficient. Cost is 5x lower. Can upgrade to large later without code changes (just config + reindex).

### Reranking

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| cohere-ai | latest | Cross-encoder reranking | Cohere Rerank 3.5+ has excellent multilingual support, simple API (query + documents in, scored list out). TypeScript SDK available. | HIGH |

**Reranker abstraction:** Same pattern as embeddings. `Reranker` interface with Cohere implementation. Future: local BGE-reranker-v2 via ONNX or API.

**Why not skip reranking:** Mixed Russian/English technical queries benefit enormously from cross-encoder reranking. BM25 finds "Compass catalog" exactly; dense finds semantically similar notes; reranker sorts the combined results by actual relevance to the full query.

### File Processing

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| pdf-parse | 2.4.x | PDF text extraction | Pure TypeScript, no native deps, supports Node 22. Good enough for text extraction from vault PDFs. | MEDIUM |
| gray-matter | 4.x | YAML frontmatter parsing | De facto standard for parsing markdown frontmatter. Used by Astro, Gatsby, Hugo toolchains. | HIGH |
| csv-parse | 5.x | CSV parsing | Streaming parser, handles edge cases (quoted fields, BOM). Part of the well-maintained csv ecosystem. | HIGH |

**Markdown chunking:** Build custom. No existing library handles Obsidian-specific markdown (wikilinks, callouts, embeds) with section hierarchy preservation well enough. Use a markdown tokenizer (marked or markdown-it) to detect headings, then chunk by section with configurable max token size. Track section path (e.g., `# Parent > ## Child > ### Subsection`) as metadata for each chunk.

**Why custom chunking over LangChain/LlamaIndex TS:** Those frameworks are designed for full RAG pipelines. CogniVault only needs the chunking step. Pulling in langchain adds massive dependency weight for one function. A ~200-line custom chunker with heading-aware splitting is simpler and more maintainable.

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| marked | 15.x | Markdown tokenizer | Fast, extensible, produces AST tokens. Use for heading detection and section boundary identification, not rendering. | MEDIUM |

**Canvas/Excalidraw:** Custom parsers. Canvas is JSON (parse, extract text from nodes). Excalidraw is JSON (extract text elements). Both are simple enough to handle with 50-100 lines each.

### Filesystem Watching

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Custom polling | - | Filesystem change detection | Obsidian Sync doesn't trigger FS events reliably. Polling + content hashing is the only robust approach per PROJECT.md constraints. No chokidar needed. | HIGH |

**Implementation:** Poll vault directories on configurable interval (default 30s). Compare file mtimes against SQLite state. For changed files, compute content hash (xxhash via xxhash-wasm for speed) and compare against stored hash. Queue changed files for reindexing.

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| xxhash-wasm | 1.x | Fast content hashing | WASM-based xxHash, ~10x faster than crypto.createHash('sha256') for content comparison. No native deps. | MEDIUM |

**Why not chokidar:** PROJECT.md explicitly states Obsidian Sync doesn't trigger FS events reliably. Polling is the correct approach. chokidar adds complexity for a mechanism that won't work for the primary use case.

### TOON Support

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| @toon-format/toon | 3.x | TOON serialization/deserialization | Official SDK. JSON-to-TOON and TOON-to-JSON conversion. Content negotiation: `Accept: text/toon` triggers TOON response serialization. | HIGH |

### Observability

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| @opentelemetry/sdk-node | 0.57+ | OTel SDK | Official Node.js SDK. Auto-instrumentation for HTTP, Fastify, better-sqlite3. | HIGH |
| @opentelemetry/instrumentation-fastify | latest | Fastify tracing | Auto-instruments Fastify routes. Note: OTel team deprecated their version June 2025; use `@fastify/otel` (official Fastify plugin) instead. | HIGH |
| @opentelemetry/instrumentation-http | latest | HTTP tracing | Required alongside Fastify instrumentation for proper span parenting. | HIGH |
| @opentelemetry/exporter-trace-otlp-http | latest | Trace export | Export traces to any OTLP-compatible backend (Jaeger, Grafana Tempo). | HIGH |
| @opentelemetry/exporter-metrics-otlp-http | latest | Metrics export | Export metrics to OTLP-compatible backend. | HIGH |
| prom-client | 15.x | Prometheus metrics | De facto standard Node.js Prometheus client. Expose `/metrics` endpoint for Prometheus scraping. Default metrics (event loop lag, GC, memory). Custom metrics (search latency, index queue size, embedding API calls). | HIGH |
| pino | 9.x | Structured logging | Fastify's default logger. JSON output, low overhead, child loggers for request context. | HIGH |

**Why pino over winston:** Fastify uses pino natively. Zero config. 5x faster than winston. Structured JSON by default.

**Observability strategy:**
- **Logs:** pino (JSON, stdout, collected by Docker logging driver)
- **Metrics:** prom-client exposed at `/metrics` + OTLP export
- **Traces:** OpenTelemetry with OTLP export to Jaeger/Tempo

### Authentication

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| @fastify/bearer-auth | latest | API key auth | Simple bearer token validation. Supports multiple keys with role metadata (read-only vs admin). Fastify plugin, minimal code. | HIGH |

**Why not JWT/OAuth:** Overkill. 1-3 local agents, no user auth needed. API keys stored in config, validated per-request via Fastify hook.

### Docker & Deployment

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Node.js 22-slim | - | Base Docker image | Alpine has native module issues with better-sqlite3. Slim is small enough (~180MB) and avoids compilation problems. | HIGH |
| docker-compose | 3.8+ | Service orchestration | CogniVault service + Qdrant sidecar. Simple, standard. | HIGH |
| Qdrant | 1.15+ | Vector DB container | `qdrant/qdrant:latest` from Docker Hub. Persistent volume for data. | HIGH |

### Development

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| tsx | latest | TypeScript execution | Run TS directly in dev without compilation step. Fast, ESM-native. | HIGH |
| vitest | 3.x | Testing | Fast, ESM-native, TypeScript-first, built-in mocking. Works with Fastify's `inject()` for API testing. | HIGH |
| @biomejs/biome | latest | Linting & formatting | Single tool replaces ESLint + Prettier. Faster (Rust-based), zero-config for most cases. | MEDIUM |

**Why not Jest:** Jest has poor ESM support and requires transforms for TypeScript. Vitest is designed for ESM + TS.

**Why not ESLint + Prettier:** Biome is a single Rust-based tool that handles both. 10-100x faster. Fewer config files.

## Full Dependency List

### Production Dependencies

```bash
# Core framework
npm install fastify @fastify/bearer-auth @fastify/cors @fastify/swagger @fastify/swagger-ui

# Validation
npm install zod fastify-type-provider-zod

# Database
npm install better-sqlite3 drizzle-orm

# Vector DB
npm install @qdrant/js-client-rest

# Embedding & Reranking
npm install openai cohere-ai

# File processing
npm install gray-matter pdf-parse csv-parse marked

# TOON format
npm install @toon-format/toon

# Hashing
npm install xxhash-wasm

# Observability
npm install pino prom-client @opentelemetry/sdk-node @opentelemetry/instrumentation-fastify @opentelemetry/instrumentation-http @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http @fastify/otel
```

### Dev Dependencies

```bash
npm install -D typescript tsx vitest @biomejs/biome drizzle-kit @types/better-sqlite3 @types/node
```

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Framework | Fastify v5 | Express v5 | Slower, less structured plugin system, middleware hell |
| Framework | Fastify v5 | Hono | Designed for edge/serverless, not long-running FS-access services |
| ORM | Drizzle | Prisma | Too heavy (~2MB engine), async-only, overkill for index state |
| ORM | Drizzle | Raw SQL | Loses type safety and migration tooling for marginal perf gain |
| Vector DB | Qdrant | Weaviate | No built-in BM25 sparse vectors, heavier resource usage |
| Vector DB | Qdrant | Milvus | More complex setup, less JS ecosystem support |
| Lexical search | Qdrant BM25 | Elasticsearch | Separate sidecar adds operational complexity; Qdrant BM25 handles it in one service |
| Lexical search | Qdrant BM25 | MeiliSearch | Same -- extra service for what Qdrant now handles natively |
| Chunking | Custom | LangChain TS | Massive dependency for one function; doesn't handle Obsidian-specific markdown |
| Chunking | Custom | Chonkie-TS | Too generic; no heading-aware hierarchy preservation |
| Logger | pino | winston | Fastify native; 5x faster; structured JSON by default |
| Test | vitest | Jest | Poor ESM support; requires babel/ts-jest transforms |
| Lint | Biome | ESLint+Prettier | Two tools vs one; 10-100x slower |
| FS watch | Polling | chokidar | Obsidian Sync doesn't trigger FS events; polling is required |
| Validation | Zod v4 | Ajv | Zod gives TS type inference; Ajv is used under the hood by Fastify anyway |
| Docker base | node:22-slim | node:22-alpine | better-sqlite3 native module compilation issues on Alpine |

## Architecture-Relevant Stack Notes

### Qdrant Collection Design

One collection per vault (multi-vault isolation). Each collection has:
- **Dense vector:** `text-embedding-3-small` (1536 dims) for semantic search
- **Sparse vector:** Qdrant built-in BM25 for keyword/lexical search (with Russian stemming configured)
- **Payload fields:** path, title, chunk_id, section_path, tags, project, status, content_hash, content_type, vault_name

Hybrid search uses Qdrant's Query API with `prefetch` (dense + sparse) and RRF fusion, all server-side. No client-side fusion code needed.

### Embedding Provider Interface

```typescript
interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}
```

### Reranker Interface

```typescript
interface Reranker {
  readonly name: string;
  readonly model: string;
  rerank(query: string, documents: string[], topK?: number): Promise<RankedResult[]>;
}
```

### SQLite Schema (Core Tables)

- `vaults` -- vault name, root path, collection name
- `indexed_files` -- path, content_hash, mtime, last_indexed_at, embedding_model, chunk_count
- `index_runs` -- vault, type (full/incremental), started_at, completed_at, files_processed, errors

## Sources

- [Fastify official site](https://fastify.dev/) -- v5.8.2, March 2026
- [Qdrant text search docs](https://qdrant.tech/documentation/guides/text-search/) -- BM25 native support
- [Qdrant 1.15 release](https://qdrant.tech/blog/qdrant-1.15.x/) -- multilingual tokenizer, Russian stemming
- [Qdrant JS client](https://github.com/qdrant/qdrant-js) -- official TypeScript SDK
- [OpenAI embedding models](https://platform.openai.com/docs/models/text-embedding-3-small) -- text-embedding-3-small specs
- [Cohere Rerank docs](https://docs.cohere.com/docs/rerank) -- Rerank 3.5, multilingual
- [Cohere TypeScript SDK](https://github.com/cohere-ai/cohere-typescript) -- official SDK
- [Zod v4 release](https://zod.dev/v4) -- v4.3.x, performance improvements
- [Drizzle ORM SQLite](https://orm.drizzle.team/docs/get-started-sqlite) -- better-sqlite3 integration
- [OpenTelemetry Node.js](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/) -- SDK setup
- [@fastify/otel](https://github.com/fastify/otel) -- official Fastify OTel plugin
- [TOON format](https://github.com/toon-format/toon) -- v3.0, official npm package
- [pdf-parse](https://github.com/mehmet-kozan/pdf-parse) -- v2.4.x, pure TypeScript
- [prom-client](https://github.com/siimon/prom-client) -- Prometheus metrics for Node.js
