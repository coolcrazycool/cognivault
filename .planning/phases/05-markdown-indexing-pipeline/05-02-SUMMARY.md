---
phase: 05-markdown-indexing-pipeline
plan: 02
subsystem: infra
tags: [openai, qdrant, embeddings, vector-store, sqlite, drizzle]

# Dependency graph
requires:
  - phase: 05-01
    provides: chunker.ts and markdown parsing infrastructure used by pipeline
  - phase: 04-index-state-change-detection
    provides: SQLite db plugin, indexed_files schema, drizzle migrations

provides:
  - OpenAI embedding provider with DIMENSION_MAP (1536 for small, 3072 for large)
  - Qdrant client plugin with auto-created cognivault collection (cosine distance)
  - Payload indexes on path, tags, project, status, type, chunk_index
  - embedding_model_version column on indexed_files with Drizzle migration
  - fastify.embedder and fastify.qdrant decorators available to downstream plugins

affects: [05-03-pipeline-wiring, future search/retrieval phases]

# Tech tracking
tech-stack:
  added:
    - openai 6.27.0 (OpenAI SDK for embeddings)
    - "@qdrant/js-client-rest 1.17.0 (Qdrant vector store client)"
    - uuid 13.0.0
    - p-queue 9.1.0
    - remark-parse 11.0.0
    - unified 11.0.5
    - remark-gfm 4.0.1
    - js-tiktoken 1.0.21
    - "@types/mdast 4.0.4"
  patterns:
    - EmbeddingProvider interface for swappable embedding backends
    - Idempotent collection init: check existence before create (no 409)
    - Fastify plugin dependency chain: db -> embedder -> qdrant
    - TDD flow: failing test commit (RED) then implementation (GREEN)

key-files:
  created:
    - src/lib/embedding.ts
    - src/lib/__tests__/embedding.test.ts
    - src/plugins/embedding.ts
    - src/plugins/qdrant.ts
    - src/plugins/__tests__/qdrant.test.ts
    - drizzle/0001_military_whiplash.sql
  modified:
    - src/config.ts (OPENAI_API_KEY, OPENAI_BASE_URL, EMBEDDING_MODEL added)
    - src/db/schema.ts (embeddingModelVersion column added)
    - src/app.ts (embeddingPlugin and qdrantPlugin registered)
    - package.json (8 new dependencies)

key-decisions:
  - "embedding plugin named 'embedder' (not 'embedding') so qdrant plugin dependency declaration matches plugin name"
  - "DIMENSION_MAP as exported constant allows downstream plugins to look up dimensions without constructing provider"
  - "Qdrant plugin skips collection creation entirely when collection already exists — no partial-update on restart"
  - "payload indexes created only during initial collection creation, not on subsequent restarts"
  - "vi.mock with class syntax (class MockOpenAI) required for OpenAI mock — arrow function mocks not constructable"

patterns-established:
  - "EmbeddingProvider interface: allows test mocks and future provider swaps without changing pipeline code"
  - "fp(plugin, { name, dependencies }) pattern for all plugins requiring ordered startup"
  - "Fake plugin pattern in tests: fp(async (f) => f.decorate(...), { name }) satisfies dependency checking"

requirements-completed: [IDX-05]

# Metrics
duration: 4min
completed: 2026-03-10
---

# Phase 5 Plan 02: Embedding Infrastructure Summary

**OpenAI embedding provider with Qdrant collection auto-init, payload indexes, and config extension for OPENAI_API_KEY/EMBEDDING_MODEL**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-10T18:20:16Z
- **Completed:** 2026-03-10T18:24:XX Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments

- Config extended with OPENAI_API_KEY, OPENAI_BASE_URL, EMBEDDING_MODEL (fail-fast on missing key)
- OpenAIEmbeddingProvider class with DIMENSION_MAP (text-embedding-3-small=1536, text-embedding-3-large=3072)
- Qdrant plugin auto-creates 'cognivault' collection with cosine distance on first startup, skips on restart
- Six payload indexes created: path, tags, project, status, type, chunk_index
- DB schema updated with embedding_model_version column + Drizzle migration generated
- fastify.embedder and fastify.qdrant decorators available for Plan 03 pipeline

## Task Commits

Each task was committed atomically:

1. **TDD RED - Failing embedding tests** - `2614f11` (test)
2. **Task 1: Config extension, DB migration, EmbeddingProvider** - `aa9a640` (feat)
3. **Task 2: Qdrant plugin + app.ts wiring** - `94e6f17` (feat)

## Files Created/Modified

- `src/config.ts` - Added OPENAI_API_KEY (required), OPENAI_BASE_URL (optional), EMBEDDING_MODEL (default: text-embedding-3-small)
- `src/db/schema.ts` - Added embeddingModelVersion nullable column to indexedFiles
- `drizzle/0001_military_whiplash.sql` - ALTER TABLE migration for embedding_model_version
- `src/lib/embedding.ts` - DIMENSION_MAP, EmbeddingProvider interface, OpenAIEmbeddingProvider class
- `src/lib/__tests__/embedding.test.ts` - 9 tests for DIMENSION_MAP, constructor, and embed() behavior
- `src/plugins/embedding.ts` - Fastify plugin: creates OpenAIEmbeddingProvider, validates API, decorates fastify.embedder
- `src/plugins/qdrant.ts` - Fastify plugin: creates QdrantClient, auto-inits collection and indexes, decorates fastify.qdrant
- `src/plugins/__tests__/qdrant.test.ts` - 5 tests for collection creation, idempotency, indexes, and decorator
- `src/app.ts` - Added embeddingPlugin and qdrantPlugin registrations after indexerPlugin

## Decisions Made

- **Plugin name 'embedder' not 'embedding':** Qdrant plugin declares `dependencies: ['embedder']`; named the fp wrapper `'embedder'` to satisfy Fastify dependency checking
- **Idempotent Qdrant init:** Check `getCollections()` before creating; skip collection AND indexes if collection already exists
- **Class mock for OpenAI:** `vi.fn().mockImplementation(() => ({...}))` is not constructable; used `class MockOpenAI {}` pattern instead
- **Fake plugin pattern for dependency tests:** `fp(async (f) => f.decorate(...), { name: 'embedder' })` registered before qdrantPlugin to satisfy dependency checks

## Deviations from Plan

None - plan executed exactly as written, with minor test mock correction (class syntax for OpenAI mock) as auto-fix.

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed OpenAI mock not constructable in tests**
- **Found during:** Task 1 (embedding test GREEN phase)
- **Issue:** `vi.mock('openai', () => ({ default: vi.fn().mockImplementation(() => (...)) }))` — arrow function mock cannot be called with `new`, causing TypeError
- **Fix:** Changed to `class MockOpenAI { embeddings = { create: mockEmbeddingsCreate }; }` syntax
- **Files modified:** src/lib/__tests__/embedding.test.ts
- **Verification:** All 9 tests pass
- **Committed in:** aa9a640 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (mock constructor bug)
**Impact on plan:** Minor test infrastructure fix; no scope creep.

## Issues Encountered

Pre-existing typecheck errors in `src/lib/chunker.ts` and `src/lib/__tests__/chunker.test.ts` from Plan 05-01 — out of scope, logged to deferred items. No new typecheck errors introduced.

## User Setup Required

**External service required:** `OPENAI_API_KEY` must be set in environment before starting the server. The embedding plugin will fail fast on startup if the key is missing or invalid.

## Next Phase Readiness

- fastify.embedder (OpenAIEmbeddingProvider) ready for pipeline use
- fastify.qdrant (QdrantClient) with 'cognivault' collection initialized on first run
- Plan 03 (pipeline wiring) can proceed: chunker + embedder + qdrant all available

---
*Phase: 05-markdown-indexing-pipeline*
*Completed: 2026-03-10*
