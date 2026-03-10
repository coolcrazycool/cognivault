# Requirements: CogniVault

**Defined:** 2026-03-10
**Core Value:** AI agents can find and retrieve the right knowledge from an Obsidian vault in under one second, with high precision across mixed Russian/English content, exact technical terms, and freeform metadata.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### File Operations

- [x] **FILE-01**: Agent can list files and folders in vault with path filtering
- [x] **FILE-02**: Agent can read note content by path
- [x] **FILE-03**: Agent can create new note with content and optional frontmatter
- [x] **FILE-04**: Agent can update note content (full replace)
- [x] **FILE-05**: Agent can append or prepend content to existing note
- [x] **FILE-06**: Agent can delete note by path
- [x] **FILE-07**: Agent can rename or move note to new path
- [x] **FILE-08**: Agent can read frontmatter metadata from any note
- [ ] **FILE-09**: Agent can update frontmatter fields without corrupting note content
- [x] **FILE-10**: Service rejects paths that traverse outside vault boundary

### Indexing

- [ ] **IDX-01**: Service performs full initial index of all markdown files on startup
- [ ] **IDX-02**: Service detects file changes via filesystem polling with content hashing
- [ ] **IDX-03**: Service chunks markdown by heading/section boundaries preserving hierarchy
- [ ] **IDX-04**: Each chunk carries section_path metadata (e.g. "Note Title > H2 > H3")
- [ ] **IDX-05**: Service extracts and indexes frontmatter fields into Qdrant payload
- [ ] **IDX-06**: Service handles created/updated/moved/deleted files incrementally
- [ ] **IDX-07**: Service removes stale vectors when notes are deleted or chunks change
- [ ] **IDX-08**: Service extracts and indexes text from PDF files
- [ ] **IDX-09**: Service parses and indexes Canvas JSON node content
- [ ] **IDX-10**: Service extracts and indexes text elements from Excalidraw files
- [ ] **IDX-11**: Service indexes CSV content with row-level chunking
- [ ] **IDX-12**: Service tracks image files metadata (name, path, linked notes)
- [ ] **IDX-13**: Admin can trigger full or partial reindex via API endpoint

### Retrieval

- [ ] **RET-01**: Agent can perform semantic search with embedding similarity
- [ ] **RET-02**: Agent can perform lexical search for exact terms and acronyms
- [ ] **RET-03**: Agent can perform hybrid search combining semantic + lexical via RRF fusion
- [ ] **RET-04**: Hybrid results are reranked by cross-encoder (Cohere/BGE) for top-K precision
- [ ] **RET-05**: Agent can filter search by tags, project, status, folder path, note type
- [ ] **RET-06**: Search results include chunk text, source note path, section_path, and relevance score
- [ ] **RET-07**: Search handles mixed Russian/English queries with technical terms accurately

### Context Assembly

- [ ] **CTX-01**: Agent can request structured context pack for a given task/query
- [ ] **CTX-02**: Context pack respects configurable token budget (default ~32K)
- [ ] **CTX-03**: Context pack includes project summary, architecture notes, ADRs, glossary, implementation notes with source citations
- [ ] **CTX-04**: Context pack applies relevance floor filtering (not greedy bin-packing)

### Agent Interface

- [ ] **API-01**: Service accepts TOON-formatted requests (Content-Type: text/toon)
- [ ] **API-02**: Service returns TOON-formatted responses when Accept: text/toon
- [ ] **API-03**: Service returns JSON by default (Accept: application/json or unspecified)
- [x] **API-04**: Service authenticates requests via API key (no role separation)

### Infrastructure

- [x] **INF-01**: Service exposes health and readiness endpoints
- [ ] **INF-02**: Service auto-generates OpenAPI spec from route definitions
- [ ] **INF-03**: Service emits structured JSON logs with request context
- [ ] **INF-04**: Service exposes Prometheus metrics (latency, throughput, index stats)
- [ ] **INF-05**: Service supports OpenTelemetry distributed tracing
- [x] **INF-06**: Service deploys as single Docker container alongside Qdrant via docker-compose

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Multi-vault

- **MVLT-01**: Service supports multiple vaults with namespace isolation
- **MVLT-02**: Each vault has independent Qdrant collection and SQLite state
- **MVLT-03**: API routes accept vault identifier for all operations

### Auth & Roles

- **AUTH-01**: API key auth with role separation (read-only vs write vs admin)
- **AUTH-02**: Admin endpoints protected from read-only keys

### Embedding Management

- **EMB-01**: Service tracks embedding model version per chunk in SQLite
- **EMB-02**: Admin can trigger selective reindex by embedding model version
- **EMB-03**: Embedding provider abstraction allows swapping to local models (BGE, nomic-embed)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Chat/LLM completions endpoint | Agents have their own LLM; coupling retrieval to LLM adds complexity without value |
| Wikilink/backlink graph traversal | Agents use retrieval, not graph navigation; high complexity, low agent benefit |
| Real-time WebSocket push | Agents are request/response; WebSocket adds stateful connection management |
| UI/admin dashboard | API-first; use Grafana for visualization, REST for admin |
| Multi-user auth (OAuth, SSO) | Local agents only; API key sufficient |
| Query caching | Qdrant latency acceptable; cache invalidation complexity outweighs benefit |
| Obsidian plugin | Server-side service; vault accessed via filesystem |
| Web search integration | Scope creep; agents compose vault search with their own web tools |
| Document permissions/ACL | Single-user vault; multi-vault isolation provides workspace separation |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| FILE-01 | Phase 2 | Complete |
| FILE-02 | Phase 2 | Complete |
| FILE-03 | Phase 3 | Complete |
| FILE-04 | Phase 3 | Complete |
| FILE-05 | Phase 3 | Complete |
| FILE-06 | Phase 3 | Complete |
| FILE-07 | Phase 3 | Complete |
| FILE-08 | Phase 2 | Complete |
| FILE-09 | Phase 3 | Pending |
| FILE-10 | Phase 2 | Complete |
| IDX-01 | Phase 4 | Pending |
| IDX-02 | Phase 4 | Pending |
| IDX-03 | Phase 5 | Pending |
| IDX-04 | Phase 5 | Pending |
| IDX-05 | Phase 5 | Pending |
| IDX-06 | Phase 4 | Pending |
| IDX-07 | Phase 5 | Pending |
| IDX-08 | Phase 10 | Pending |
| IDX-09 | Phase 10 | Pending |
| IDX-10 | Phase 10 | Pending |
| IDX-11 | Phase 10 | Pending |
| IDX-12 | Phase 10 | Pending |
| IDX-13 | Phase 11 | Pending |
| RET-01 | Phase 6 | Pending |
| RET-02 | Phase 6 | Pending |
| RET-03 | Phase 7 | Pending |
| RET-04 | Phase 7 | Pending |
| RET-05 | Phase 6 | Pending |
| RET-06 | Phase 6 | Pending |
| RET-07 | Phase 7 | Pending |
| CTX-01 | Phase 8 | Pending |
| CTX-02 | Phase 8 | Pending |
| CTX-03 | Phase 8 | Pending |
| CTX-04 | Phase 8 | Pending |
| API-01 | Phase 9 | Pending |
| API-02 | Phase 9 | Pending |
| API-03 | Phase 9 | Pending |
| API-04 | Phase 1 | Complete |
| INF-01 | Phase 1 | Complete |
| INF-02 | Phase 9 | Pending |
| INF-03 | Phase 11 | Pending |
| INF-04 | Phase 11 | Pending |
| INF-05 | Phase 11 | Pending |
| INF-06 | Phase 1 | Complete |

**Coverage:**
- v1 requirements: 44 total
- Mapped to phases: 44
- Unmapped: 0

---
*Requirements defined: 2026-03-10*
*Last updated: 2026-03-10 after roadmap creation*
