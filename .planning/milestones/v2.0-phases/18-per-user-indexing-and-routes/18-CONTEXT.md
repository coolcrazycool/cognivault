# Phase 18: Per-User Indexing and Routes - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

<domain>
## Phase Boundary

The indexing pipeline and all API routes operate in multi-tenant mode with per-user OpenAI keys and metrics. Each user's vault is indexed independently using their own OpenAI API key. Prometheus metrics carry a user_id label on every counter/histogram increment. Adding or removing a user starts or stops that user's indexer without affecting other users. Search, context, and admin routes already use tenant-scoped decorators from Phase 17 — this phase focuses on the indexer/pipeline and embedder refactoring.

</domain>

<decisions>
## Implementation Decisions

### Indexer architecture
- Per-user VaultIndexer instances: `Map<userId, VaultIndexer>` managed by the indexer plugin
- Each user gets their own VaultIndexer watching their vaultPath
- Registry `user-added` creates an indexer, `user-removed` destroys it
- Each user gets their own PQueue (per-user pipeline queues, not shared global queue) — one user's bulk reindex doesn't starve others
- Indexer plugin manages the Map, listens to registry events, decorates `fastify.indexers`

### Pipeline data access
- Pipeline handler receives userId with each event batch
- Looks up user's DB from db plugin's Map via `fastify.getUserDbById(userId)` (new method)
- Creates `TenantQdrantClient` via `fastify.createTenantQdrant(userId)` (already exists)
- Gets user's embedder via `fastify.getUserEmbedder(userId)`
- No request decorators needed — pipeline runs outside request context

### Per-user embedder
- `Map<userId, EmbeddingProvider>` managed by the embedding plugin (refactored)
- Each user gets their own EmbeddingProvider initialized with their openaiKey
- Created on user-added, destroyed on user-removed, recreated if openaiKey changes on user-updated
- Decorated as `fastify.getUserEmbedder(userId)`
- Per-user embedders used everywhere — both indexing pipeline and search/context routes
- openaiKey is required in users.json Zod schema — users without it fail validation and can't be added

### Metrics labeling (OBS-01)
- All request-scoped and pipeline-scoped metrics get user_id label:
  - `cognivault_search_duration{type, user_id}`
  - `cognivault_search_requests{type, user_id}`
  - `cognivault_context_packs{user_id}`
  - `cognivault_embedding_requests{user_id}`
  - `cognivault_chunks_processed{user_id}`
  - `cognivault_pipeline_duration{user_id}`
  - `cognivault_stale_vector_cleanups{user_id}`
  - `cognivault_index_queue_depth{user_id}` — per-user gauge showing each user's queue size
- Global metrics stay without user_id: registry_users, registry_reloads, auth_failures
- On user-removed, call `.remove(userId)` on all user-labeled metrics to prevent stale labels accumulating

### Indexer lifecycle
- Indexers start eagerly at server boot for all existing users + on registry user-added events
- Vault path validated before starting indexer — if path doesn't exist, log warning and skip (retry on next registry reload)
- On user removal: clear pending queue items immediately, await in-progress items to finish (drain), then stop watcher and destroy indexer
- Manual reindex (admin routes) goes through the user's indexer instance — `fastify.indexers.get(userId).reindex()` — same pipeline path, no bypass

### Claude's Discretion
- Pipeline plugin internal refactoring details (how event handler is structured)
- PQueue concurrency setting per user
- Exact method signatures for getUserDbById and getUserEmbedder
- Test structure and helper organization
- How VaultIndexer.reindex() triggers a full scan internally
- Startup ordering between indexer creation and initial vault scan

</decisions>

<specifics>
## Specific Ideas

- Per-user indexers + per-user queues + per-user embedders form a consistent triple — each user has their own isolated indexing stack
- Pipeline runs outside request context, so it accesses user resources via fastify-level Map lookups (not request decorators)
- Admin reindex goes through the indexer (not bypass) — single code path for all indexing operations
- openaiKey being required prevents partial-user states — if they're in the registry, they can fully index and search

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/plugins/db.ts`: Per-user DB Map pattern — indexer plugin follows the same `Map<userId, Resource>` + registry events pattern
- `src/plugins/qdrant.ts`: `fastify.createTenantQdrant(userId)` factory — pipeline uses this directly
- `src/lib/tenant-qdrant-client.ts`: TenantQdrantClient auto-injects user_id filter — no changes needed
- `src/lib/indexer.ts`: VaultIndexer class with file watching — needs userId context but core logic reusable
- `src/plugins/pipeline.ts`: Pipeline processing logic — needs refactoring for userId context but chunking/embedding logic reusable

### Established Patterns
- `Map<userId, Resource>` with registry event listeners for lifecycle (db plugin pattern)
- `fastify.decorate()` + `fp()` with dependencies for plugin wiring
- `fastify.addHook('onClose', ...)` for cleanup on shutdown
- Per-instance prom-client Registry for test isolation

### Integration Points
- `src/plugins/indexer.ts`: Currently disabled stub — refactor into per-user indexer manager
- `src/plugins/pipeline.ts`: Currently disabled with @ts-nocheck — refactor for userId context in event processing
- `src/plugins/embedding.ts`: Currently single global instance — refactor to per-user Map
- `src/plugins/metrics.ts`: Add user_id label to existing counters/histograms
- `src/features/search/routes.ts`: Update to use `fastify.getUserEmbedder(userId)` instead of global embedder
- `src/features/context/routes.ts`: Update to use per-user embedder
- `src/features/admin/service.ts`: Simplify ReindexService to use per-user indexer instances
- `src/app.ts`: Re-enable indexer and pipeline plugins in correct dependency order

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 18-per-user-indexing-and-routes*
*Context gathered: 2026-03-14*
