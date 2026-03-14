# Phase 17: Data Isolation - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Each user's Qdrant vectors and SQLite index state are stored in isolated data structures that prevent cross-tenant access. Single Qdrant collection with mandatory user_id payload filtering, per-user SQLite databases at user-scoped paths, tenant-aware wrappers that make bypass structurally impossible. Legacy single-tenant data is purged on startup. Phase 18 (per-user indexing and routes) consumes the isolation layer.

</domain>

<decisions>
## Implementation Decisions

### Qdrant isolation
- Single `cognivault` collection shared by all users — no separate collections per user
- Every point payload includes a `user_id` field (keyword-indexed)
- `user_id` keyword index created at collection setup time alongside existing payload indexes in `qdrant.ts`
- Chunk UUIDs incorporate user_id: `uuidv5('{userId}:{path}:{chunkIndex}', namespace)` — prevents ID collisions between users with identically-named files
- When a user is removed from registry, all their Qdrant vectors (points with matching user_id) are deleted immediately

### Per-user SQLite lifecycle
- Each user gets a separate SQLite database at `{COGNIVAULT_DATA_DIR}/{userId}/index.db`
- Databases created eagerly when registry emits `user-added` — user has a ready DB before their first request
- Drizzle migrations run on each database at creation time via existing `createDatabase()` function
- Route handlers access the correct DB via `request.getUserDb()` method (decorated on FastifyRequest)
- Internally backed by a `Map<userId, db>` that the DB plugin manages
- When a user is removed from registry, their SQLite database is closed and the `{userId}/` directory is deleted

### Data migration
- Clean break — no migration of existing single-tenant data. v2.0 is a major version, fresh start
- Old `index.db` in DATA_DIR root is actively deleted on v2.0 startup
- Old Qdrant vectors (points without `user_id` payload) are purged on startup — delete all points where user_id field is absent
- Re-indexing happens naturally when each user's vault is synced and indexed in Phase 18

### Enforcement guarantees
- `TenantQdrantClient` wrapper injects mandatory `user_id` filter into every operation — structurally impossible to forget
- Wrapper exposes only the 5 methods CogniVault actually uses: `search`, `scroll`, `upsert`, `delete`, `setPayload` — minimal auditable surface
- Filter injection happens at the wrapper level (application-level), not via Qdrant JWT/ACL
- Raw QdrantClient is a local variable inside the qdrant plugin — used only for setup operations (index creation, legacy purge). Never exposed on `fastify` or `request`
- Route handlers access tenant-scoped Qdrant via `request.getUserQdrant()` — consistent pattern with `request.getUserDb()`
- Dedicated integration test: creates two users, indexes data for each, verifies User A search returns zero of User B's vectors (directly validates DATA-01)

### Claude's Discretion
- TenantQdrantClient internal implementation details
- Filter merging strategy (how user_id is combined with caller-provided filters)
- DB connection pool/cache eviction strategy
- Exact startup purge implementation (batch delete vs scroll-and-delete)
- Test file organization and helper structure

</decisions>

<specifics>
## Specific Ideas

- `request.getUserDb()` and `request.getUserQdrant()` form a consistent per-request tenant API — downstream phases (18, 19) build on this pattern
- The raw QdrantClient being plugin-local (not decorated) is the key enforcement mechanism — there's no way for route code to bypass isolation
- Eager DB creation on `user-added` event means the indexer (Phase 18) can start immediately without lazy-init races

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/db/client.ts`: `createDatabase()` handles SQLite creation + Drizzle migrations — reusable for per-user DBs
- `src/plugins/qdrant.ts`: Collection setup with payload indexes — add `user_id` keyword index here
- `src/plugins/pipeline.ts`: `chunkId()` function using uuidv5 — needs user_id prefix added
- `src/lib/user-registry.ts`: EventEmitter with `user-added`/`user-removed` events — triggers DB creation/cleanup

### Established Patterns
- `fastify.decorate()` for shared services — used for db, qdrant, embedder, vault, registry
- `fp()` wrapper with dependencies array — qdrant depends on embedder, pipeline depends on qdrant/db
- Per-instance prom-client Registry prevents test pollution — tenant wrapper follows same isolation
- `fastify.addHook('onClose', ...)` for cleanup — DB connections and watcher handles

### Integration Points
- `src/plugins/db.ts`: Currently creates single `fastify.db` — must be refactored to per-user Map + request decorator
- `src/plugins/qdrant.ts`: Currently exposes raw client as `fastify.qdrant` — must keep raw internal, expose only tenant wrapper
- `src/features/search/service.ts`: Uses `this.qdrant.search/scroll` directly — will use tenant wrapper instead
- `src/plugins/pipeline.ts`: Upserts to `'cognivault'` collection without user_id — must add user_id to payloads
- `src/plugins/auth.ts`: Sets `request.user` — getUserDb()/getUserQdrant() depend on this being set first

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 17-data-isolation*
*Context gathered: 2026-03-14*
