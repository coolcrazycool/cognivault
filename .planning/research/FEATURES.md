# Feature Research

**Domain:** Knowledge access layer / vault API / RAG-as-a-service for AI agents
**Researched:** 2026-03-10
**Confidence:** HIGH (multiple products analyzed, well-established domain patterns)

## Competitive Landscape Summary

Products analyzed:
- **Obsidian Local REST API** -- CRUD + search over Obsidian vault, no vector/semantic layer
- **Khoj** -- personal AI with semantic search, chat, agents; PostgreSQL + pgvector
- **Onyx (Danswer)** -- enterprise search + RAG; 40+ connectors, hybrid search, document permissions
- **PrivateGPT** -- private document chat; ingestion + chunks + completions API; LlamaIndex-based
- **AnythingLLM** -- workspace-based RAG; document upload, embedding, chat; developer API
- **RAGFlow** -- open-source RAG engine; deep document parsing, hybrid search

CogniVault occupies a unique niche: none of these products combine Obsidian-native file operations with vector indexing and structured context assembly in a single agent-facing API. Obsidian Local REST API has no semantic search. RAG tools have no Obsidian file awareness. This gap is the opportunity.

## Feature Landscape

### Table Stakes (Users Expect These)

Features that any knowledge-access API for AI agents must have. Missing these means agents cannot function.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Note CRUD (list, read, create, update, delete)** | Every vault API provides this. Agents need to read and write notes. | MEDIUM | Must handle Markdown, preserve frontmatter. Obsidian Local REST API sets baseline. |
| **Frontmatter read/write** | Metadata is how agents tag, categorize, and filter notes. All Obsidian tools expose this. | LOW | YAML parsing with freeform schema support. Must not corrupt existing frontmatter. |
| **Semantic/vector search** | Khoj, PrivateGPT, AnythingLLM, Onyx all provide this. Keyword search alone is insufficient for agents. | HIGH | Requires embedding pipeline, vector store, chunking strategy. |
| **Keyword/lexical search** | Exact term matching for technical identifiers, acronyms, code references. All search products support this. | MEDIUM | BM25 or full-text index. Critical for mixed-language queries with short technical terms. |
| **Document ingestion with chunking** | PrivateGPT, AnythingLLM, Onyx all auto-chunk documents on ingest. Agents expect indexed content. | HIGH | Markdown-aware chunking preserving section hierarchy is harder than generic chunking. |
| **Multi-format support (MD, PDF, CSV)** | PrivateGPT supports "most common formats." AnythingLLM handles PDF, DOCX, CSV. | MEDIUM | Start with MD as primary; PDF text extraction, CSV, Canvas JSON are secondary. |
| **API key authentication** | Every product uses API keys or bearer tokens. Minimum security expectation. | LOW | Role separation (read-only vs write) adds value without complexity. |
| **Health/readiness endpoints** | Standard for any deployable service. Docker/k8s health checks depend on this. | LOW | /health and /ready -- trivial but required. |
| **OpenAPI/Swagger documentation** | Obsidian REST API provides /openapi.yaml. PrivateGPT uses FastAPI auto-docs. Agents and developers expect machine-readable API specs. | LOW | Auto-generated from route definitions. |
| **Metadata filtering on search** | Onyx filters by document source/permissions. PrivateGPT filters by document ID. Agents need to scope queries. | MEDIUM | Filter by tags, project, status, folder path, content type. |
| **Incremental indexing** | No product requires full reindex on every change. File-level change detection is expected. | HIGH | Content hashing + timestamp tracking in SQLite. Must handle Obsidian Sync's non-standard FS events. |
| **Stale content cleanup** | Agents must not get results from deleted/renamed notes. All production RAG systems handle this. | MEDIUM | Detect obsolete vectors, propagate deletes, handle renames as delete+create. |

### Differentiators (Competitive Advantage)

Features that no single competitor provides, or that CogniVault does uniquely well for the AI agent use case.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Unified file ops + vector search in one API** | No existing product combines Obsidian CRUD with semantic retrieval. Agents currently need 2+ services. Eliminates integration overhead. | HIGH | This is the core value proposition. Single endpoint for "find relevant notes, read them, update them." |
| **Context pack assembly endpoint** | No competitor offers structured, token-budgeted knowledge bundles. Agents currently do manual chunk assembly. Reduces agent complexity and token waste. | HIGH | Assemble ~32K token context from search results with section hierarchy, metadata, source attribution. Configurable budget per request. |
| **TOON content negotiation** | ~40% token reduction vs JSON. No other API supports TOON. Direct cost savings for agent operations. | MEDIUM | Accept: text/toon returns TOON format. Unique to CogniVault. Requires TOON serializer. |
| **Hybrid retrieval with RRF fusion + cross-encoder reranking** | Most RAG tools offer basic semantic search. Onyx does hybrid search. Few expose reranking as a configurable pipeline. Critical for mixed-language precision. | HIGH | Reciprocal Rank Fusion merges semantic + lexical results. Cross-encoder (Cohere/BGE) reranks top-K. Measurable precision improvement for Russian/English queries. |
| **Markdown-aware chunking with section hierarchy** | Generic chunkers (LlamaIndex, LangChain) split on token count. Obsidian notes have meaningful structure (headings, sections). Preserving this hierarchy improves retrieval precision. | MEDIUM | Chunk boundaries at section breaks. Each chunk carries section_path metadata (e.g., "Note Title > H2 > H3"). |
| **Multi-vault isolation** | Khoj supports one knowledge base. PrivateGPT has flat document space. Onyx uses connectors but no vault-level isolation. Multi-vault from v1 enables clean workspace separation. | MEDIUM | vault_name as namespace in Qdrant collections + SQLite. Complete data isolation between vaults. |
| **Embedding model versioning and migration** | No competitor exposes embedding model version tracking. When upgrading models, you need to know which chunks use which embeddings. Prevents silent degradation. | MEDIUM | Track model version per chunk in SQLite. Reindex endpoint can target specific model versions. Migration path when switching providers. |
| **Async write-then-index pipeline** | Most RAG tools block on ingestion. Async write decouples file write latency from embedding latency. Agents get fast write acknowledgment. | MEDIUM | Write to disk immediately, return success. Filesystem watcher triggers background reindexing. Eventually consistent (seconds, not minutes). |
| **Structured Qdrant payload schema** | Most RAG tools treat vector metadata as opaque. Explicit payload schema (path, title, chunk_id, section_path, tags, project, status) enables rich filtering and debugging. | LOW | Well-defined schema documented in API. Enables agents to construct precise filtered queries. |

### Anti-Features (Commonly Requested, Often Problematic)

Features to explicitly NOT build. Each has been considered and rejected for specific reasons.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Chat/completions endpoint (LLM integration)** | Khoj, PrivateGPT, AnythingLLM all bundle LLM chat. "Why not just add chat?" | Couples retrieval to specific LLM providers. Agents already have their own LLM. Duplicates agent's existing capability. Adds massive complexity (streaming, model management, prompt engineering). | Provide excellent retrieval + context packs. Let agents use their own LLM with the retrieved context. |
| **Wikilink/backlink graph traversal** | Obsidian's graph view is iconic. "Agents should follow links." | Graph traversal is a different retrieval paradigm. Agents use semantic search, not link-following. Implementing graph queries adds significant complexity for minimal agent benefit. | Semantic search with metadata filtering achieves same "find related notes" goal more reliably. |
| **Real-time WebSocket push** | "Agents should get notified when notes change." | Agents are request/response oriented. WebSocket connections are stateful, complex to manage, and most agent frameworks don't support them. Adds connection management overhead. | Agents poll search endpoints or use request/response pattern. Index staleness is seconds, not problematic. |
| **UI/dashboard/admin panel** | Onyx and AnythingLLM have dashboards. "Need a UI for monitoring." | UI development is a separate product. Admin operations should be API-first. Prometheus + Grafana provide better monitoring than any custom dashboard. | REST admin endpoints + Prometheus metrics + structured JSON logs. Use Grafana for visualization. |
| **Multi-user authentication (OAuth, SSO)** | Enterprise RAG tools (Onyx) support SSO/RBAC. "Need user management." | CogniVault serves local agents, not end users. Multi-user auth adds massive complexity. API keys with role separation is sufficient for 1-3 agents. | API key auth with read-only vs write/admin roles. If multi-user ever needed, add it as a later layer. |
| **Aggressive query caching** | "Cache search results for performance." | Qdrant latency is already < 100ms. Cache invalidation with continuous indexing creates stale results. Complexity outweighs benefit at 500-5000 note scale. | Direct Qdrant queries. Optimize embedding/reranking latency instead. |
| **Obsidian plugin / direct integration** | "Ship an Obsidian plugin for seamless access." | CogniVault is a server-side service. Obsidian plugins run in Electron, have limited capabilities, and create a dependency on Obsidian's plugin API. The vault is accessed via filesystem. | Standalone Docker service. Access vault via mounted filesystem. Compatible with any sync method. |
| **Web search / internet access** | Khoj and Onyx integrate web search. "Combine vault + web knowledge." | Scope creep. Web search is a fundamentally different retrieval domain. Mixing web results with vault results degrades precision. Agents can use separate web search tools. | Stay focused on vault knowledge. Agents compose CogniVault results with their own web search capabilities. |
| **Document permissions / ACL** | Onyx mirrors source system permissions. "Control who sees what." | Single-user vault. No users to restrict. Permission systems add query-time overhead and index complexity. | Multi-vault isolation provides workspace separation. Within a vault, all content is accessible. |

## Feature Dependencies

```
[Semantic Search]
    |--requires--> [Document Ingestion + Chunking]
    |                   |--requires--> [Note CRUD / File Access]
    |                   |--requires--> [Embedding Pipeline]
    |--requires--> [Qdrant Vector Store]

[Keyword/Lexical Search]
    |--requires--> [Document Ingestion + Chunking]
    |--requires--> [Full-text Index (SQLite FTS or similar)]

[Hybrid Retrieval with RRF]
    |--requires--> [Semantic Search]
    |--requires--> [Keyword/Lexical Search]

[Cross-encoder Reranking]
    |--enhances--> [Hybrid Retrieval with RRF]
    |--requires--> [Reranker Model (Cohere API or local BGE)]

[Context Pack Assembly]
    |--requires--> [Hybrid Retrieval with RRF]
    |--requires--> [Note CRUD / File Access] (to fetch full note content)
    |--enhances--> [TOON Content Negotiation]

[Metadata Filtering]
    |--requires--> [Frontmatter Read/Write]
    |--requires--> [Structured Qdrant Payload Schema]
    |--enhances--> [Semantic Search]
    |--enhances--> [Keyword/Lexical Search]

[Incremental Indexing]
    |--requires--> [Document Ingestion + Chunking]
    |--requires--> [SQLite Index State Tracking]
    |--enhances--> [Stale Content Cleanup]

[Multi-vault Isolation]
    |--requires--> [Qdrant Collection Namespacing]
    |--requires--> [SQLite Per-vault State]
    |--enhances--> [Note CRUD] (vault_name prefix on all operations)

[TOON Content Negotiation]
    |--independent-- (serialization layer, can be added at any phase)

[Embedding Model Versioning]
    |--requires--> [SQLite Index State Tracking]
    |--enhances--> [Incremental Indexing] (selective reindex by model version)
```

### Dependency Notes

- **Hybrid Retrieval requires both search types:** Semantic and lexical search must both work before RRF fusion can combine them. This is the critical path.
- **Context Pack Assembly requires working retrieval:** Cannot assemble context packs without functioning hybrid search. This should be a later phase feature.
- **Metadata Filtering requires frontmatter parsing:** Structured Qdrant payloads depend on frontmatter extraction during ingestion.
- **TOON is independent:** Serialization format can be layered on at any point without architectural changes. Just content negotiation middleware.
- **Multi-vault requires namespacing:** Must be designed into the data model from the start (collection naming, path prefixes) even if only one vault is used initially.

## MVP Definition

### Launch With (v1)

Minimum viable service that an AI agent can use to replace the existing REST API + Smart Connections setup.

- [ ] **Note CRUD operations** -- list, read, create, update, delete, append/prepend via REST
- [ ] **Frontmatter read/write** -- YAML metadata extraction and update
- [ ] **Document ingestion with Markdown-aware chunking** -- section hierarchy preservation
- [ ] **Semantic search via Qdrant** -- embedding with OpenAI text-embedding-3
- [ ] **Keyword search** -- exact term matching for technical identifiers
- [ ] **Hybrid retrieval with RRF fusion** -- combine semantic + lexical results
- [ ] **Metadata filtering** -- filter by tags, project, folder, status
- [ ] **Incremental indexing** -- filesystem polling + content hashing
- [ ] **Stale vector cleanup** -- delete/rename propagation
- [ ] **API key authentication** -- read-only vs write roles
- [ ] **Health/readiness endpoints** -- Docker deployment support
- [ ] **SQLite index state** -- hash, timestamp, model version tracking
- [ ] **Single vault support** -- multi-vault data model designed but single vault operational

### Add After Validation (v1.x)

Features to add once core retrieval is proven accurate and performant.

- [ ] **Cross-encoder reranking** -- add Cohere/BGE reranker to hybrid pipeline; trigger: when precision on mixed-language queries is measured and found wanting
- [ ] **Context pack assembly** -- structured token-budgeted bundles; trigger: when agents are observed manually assembling context from search results
- [ ] **TOON content negotiation** -- token-efficient responses; trigger: when token costs become a concern or TOON library is stable
- [ ] **Multi-vault support** -- activate namespace isolation; trigger: when user needs second vault
- [ ] **Multi-format indexing (PDF, CSV, Canvas)** -- extend beyond Markdown; trigger: when non-MD content in vault needs retrieval
- [ ] **OpenAPI spec endpoint** -- auto-generated API documentation
- [ ] **Prometheus metrics + structured logging** -- operational observability

### Future Consideration (v2+)

Features to defer until core product is stable and patterns emerge from real usage.

- [ ] **Embedding model migration tooling** -- bulk reindex with new model; defer: only matters when switching embedding providers
- [ ] **Excalidraw/image metadata extraction** -- specialized parsers; defer: low volume content type
- [ ] **OpenTelemetry tracing** -- distributed tracing; defer: useful at scale, unnecessary for 1-3 agents
- [ ] **Embedding provider abstraction (local models)** -- swap to BGE/nomic-embed; defer: OpenAI is good enough initially

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Note CRUD | HIGH | MEDIUM | P1 |
| Frontmatter read/write | HIGH | LOW | P1 |
| Semantic search (Qdrant) | HIGH | HIGH | P1 |
| Keyword/lexical search | HIGH | MEDIUM | P1 |
| Hybrid retrieval (RRF) | HIGH | MEDIUM | P1 |
| Markdown-aware chunking | HIGH | MEDIUM | P1 |
| Incremental indexing | HIGH | HIGH | P1 |
| Stale vector cleanup | HIGH | MEDIUM | P1 |
| Metadata filtering | HIGH | MEDIUM | P1 |
| API key auth | MEDIUM | LOW | P1 |
| Health endpoints | LOW | LOW | P1 |
| Cross-encoder reranking | HIGH | MEDIUM | P2 |
| Context pack assembly | HIGH | HIGH | P2 |
| TOON negotiation | MEDIUM | MEDIUM | P2 |
| Multi-vault isolation | MEDIUM | MEDIUM | P2 |
| Multi-format (PDF, CSV) | MEDIUM | MEDIUM | P2 |
| Prometheus metrics | MEDIUM | LOW | P2 |
| OpenAPI spec | LOW | LOW | P2 |
| Embedding migration | LOW | MEDIUM | P3 |
| OpenTelemetry tracing | LOW | MEDIUM | P3 |
| Local embedding models | LOW | HIGH | P3 |

**Priority key:**
- P1: Must have for launch -- agents cannot function without these
- P2: Should have, add post-validation -- improves precision, DX, or efficiency
- P3: Nice to have, future consideration -- only when triggered by real need

## Competitor Feature Analysis

| Feature | Obsidian REST API | Khoj | PrivateGPT | Onyx | AnythingLLM | CogniVault |
|---------|-------------------|------|------------|------|-------------|------------|
| Note CRUD | Yes (full) | No (read-only indexing) | No (ingest only) | No (connector-based) | No (upload only) | Yes (full, Obsidian-native) |
| Frontmatter R/W | Yes | No | No | N/A | No | Yes |
| Semantic search | No | Yes (pgvector) | Yes (LlamaIndex) | Yes (custom) | Yes (built-in) | Yes (Qdrant) |
| Keyword search | Basic text search | No | No | Yes (hybrid) | No | Yes (BM25/FTS) |
| Hybrid search | No | No | No | Yes | No | Yes (RRF fusion) |
| Reranking | No | No | No | Yes | No | Yes (cross-encoder) |
| Context pack assembly | No | No | No | No | No | Yes (unique) |
| TOON format | No | No | No | No | No | Yes (unique) |
| Token budget control | No | No | No | No | No | Yes (unique) |
| Multi-vault | N/A (one Obsidian instance) | No | No | N/A | Workspaces | Yes (isolated namespaces) |
| Incremental indexing | N/A | Yes | Manual | Yes (connectors) | Manual | Yes (filesystem polling) |
| LLM chat built-in | No | Yes | Yes | Yes | Yes | No (by design) |
| Multi-format | N/A | PDF, MD, org, Word | Most formats | 40+ connectors | PDF, DOCX, CSV | MD, PDF, CSV, Canvas |
| Self-hosted | Obsidian plugin | Yes (Docker) | Yes (Docker) | Yes (Docker) | Yes (Docker) | Yes (Docker) |
| Agent-first API | No (human automation) | No (human UI first) | Partial (OpenAI-compatible) | No (enterprise UI) | Partial (workspace API) | Yes (designed for agents) |

### Key Competitive Insight

Every competitor is either:
1. **File-aware but not search-capable** (Obsidian REST API) -- can read/write notes but cannot find relevant content semantically
2. **Search-capable but not file-aware** (Khoj, PrivateGPT, Onyx, AnythingLLM) -- can find content but cannot operate on the source files natively
3. **Human-UI-first with API bolted on** (all of the above) -- APIs are afterthoughts, not designed for agent consumption

CogniVault is unique in being **agent-first, combining file operations with retrieval, and offering structured context assembly**. No competitor occupies this exact position.

## Sources

- [Obsidian Local REST API - GitHub](https://github.com/coddingtonbear/obsidian-local-rest-api)
- [Obsidian Local REST API - Interactive Documentation](https://coddingtonbear.github.io/obsidian-local-rest-api/)
- [Khoj AI Documentation](https://docs.khoj.dev/)
- [Khoj - GitHub](https://github.com/khoj-ai/khoj)
- [Onyx (Danswer) - GitHub](https://github.com/onyx-dot-app/onyx)
- [Onyx Documentation](https://docs.onyx.app/welcome)
- [PrivateGPT Documentation](https://docs.privategpt.dev/api-reference)
- [PrivateGPT - GitHub](https://github.com/zylon-ai/private-gpt)
- [AnythingLLM Documentation](https://docs.anythingllm.com/)
- [RAGFlow - RAG Review 2025](https://ragflow.io/blog/rag-review-2025-from-rag-to-context)
- [Weaviate - Context Engineering for AI Agents](https://weaviate.io/blog/context-engineering)
- [Superlinked - Optimizing RAG with Hybrid Search & Reranking](https://superlinked.com/vectorhub/articles/optimizing-rag-with-hybrid-search-reranking)

---
*Feature research for: CogniVault - Knowledge access layer for AI agents*
*Researched: 2026-03-10*
