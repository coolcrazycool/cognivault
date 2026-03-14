# Phase 18: Per-User Indexing and Routes - Research

**Researched:** 2026-03-14
**Domain:** Multi-tenant indexing pipeline, per-user embedding, Prometheus metrics labeling
**Confidence:** HIGH

## Summary

Phase 18 transforms the indexing pipeline from a disabled single-tenant stub into a fully multi-tenant system. Three major subsystems need refactoring: (1) the embedding plugin must manage per-user `EmbeddingProvider` instances keyed by each user's `openaiKey`, (2) the indexer plugin must manage per-user `VaultIndexer` instances each with their own `PQueue`, and (3) the pipeline must be refactored to receive `userId` context and look up user resources via fastify-level Maps rather than request decorators. Additionally, all Prometheus metrics that track per-request or per-pipeline activity must gain a `user_id` label, with label cleanup on user removal.

The codebase is well-prepared for this phase. The `db.ts` plugin already establishes the `Map<userId, Resource>` + registry event listener pattern. The `pipeline.ts` is annotated with `@ts-nocheck` and both indexer and pipeline are commented out in `app.ts` with explicit Phase 18 TODO markers. The `VaultIndexer` class, `OpenAIEmbeddingProvider`, and `TenantQdrantClient` are all standalone classes that can be instantiated per-user without structural changes to the classes themselves.

**Primary recommendation:** Follow the db plugin's `Map<userId, Resource>` pattern exactly for both embedding and indexer plugins. Refactor pipeline to accept userId as a parameter rather than relying on request context. Add `user_id` to all non-global metric label sets.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Per-user VaultIndexer instances: `Map<userId, VaultIndexer>` managed by the indexer plugin
- Each user gets their own VaultIndexer watching their vaultPath
- Registry `user-added` creates an indexer, `user-removed` destroys it
- Each user gets their own PQueue (per-user pipeline queues, not shared global queue)
- Indexer plugin manages the Map, listens to registry events, decorates `fastify.indexers`
- Pipeline handler receives userId with each event batch
- Looks up user's DB from db plugin's Map via `fastify.getUserDbById(userId)` (new method)
- Creates `TenantQdrantClient` via `fastify.createTenantQdrant(userId)` (already exists)
- Gets user's embedder via `fastify.getUserEmbedder(userId)`
- No request decorators needed -- pipeline runs outside request context
- `Map<userId, EmbeddingProvider>` managed by the embedding plugin (refactored)
- Each user gets their own EmbeddingProvider initialized with their openaiKey
- Created on user-added, destroyed on user-removed, recreated if openaiKey changes on user-updated
- Decorated as `fastify.getUserEmbedder(userId)`
- Per-user embedders used everywhere -- both indexing pipeline and search/context routes
- openaiKey is required in users.json Zod schema -- users without it fail validation
- All request-scoped and pipeline-scoped metrics get user_id label (see CONTEXT.md for full list)
- Global metrics stay without user_id: registry_users, registry_reloads, auth_failures
- On user-removed, call `.remove(userId)` on all user-labeled metrics
- Indexers start eagerly at server boot + on registry user-added events
- Vault path validated before starting indexer -- log warning and skip if path doesn't exist
- On user removal: clear pending queue, await in-progress, stop watcher, destroy indexer
- Manual reindex goes through the user's indexer instance -- same pipeline path, no bypass

### Claude's Discretion
- Pipeline plugin internal refactoring details (how event handler is structured)
- PQueue concurrency setting per user
- Exact method signatures for getUserDbById and getUserEmbedder
- Test structure and helper organization
- How VaultIndexer.reindex() triggers a full scan internally
- Startup ordering between indexer creation and initial vault scan

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| OBS-01 | Every metric emitted carries a user_id label matching the request's tenant | Metrics plugin refactoring: add `user_id` to labelNames on all non-global metrics; prom-client `.remove()` verified working for Counter, Histogram, and Gauge |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| prom-client | (existing) | Prometheus metrics with user_id labels | Already in use; `.remove()` method verified for Counter, Histogram, Gauge |
| p-queue | (existing) | Per-user concurrency control | Already in use in pipeline; one instance per user |
| openai | (existing) | Per-user embedding API calls | Already in use via `OpenAIEmbeddingProvider` |
| fastify-plugin (fp) | (existing) | Plugin encapsulation with dependency ordering | Already in use for all plugins |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| drizzle-orm | (existing) | Per-user SQLite access in pipeline | Already in use; pipeline accesses via getUserDbById |
| @qdrant/js-client-rest | (existing) | Vector operations via TenantQdrantClient | Already in use; pipeline creates tenant client per userId |

No new dependencies needed. All required libraries are already installed.

## Architecture Patterns

### Recommended Changes by Plugin

```
src/
  plugins/
    embedding.ts       # REFACTOR: Map<userId, EmbeddingProvider> + getUserEmbedder()
    indexer.ts          # REWRITE: Map<userId, VaultIndexer> + per-user PQueue
    pipeline.ts         # REWRITE: Remove @ts-nocheck, accept userId, use fastify-level lookups
    metrics.ts          # REFACTOR: Add user_id label to non-global metrics
    db.ts               # ADD: getUserDbById(userId) fastify-level method (for pipeline)
  features/
    search/routes.ts    # UPDATE: Replace fastify.embedder with fastify.getUserEmbedder(userId)
    context/routes.ts   # UPDATE: Replace fastify.embedder with fastify.getUserEmbedder(userId)
    admin/service.ts    # REWRITE: Use per-user indexer instead of global
  app.ts                # UPDATE: Re-enable indexer + pipeline plugins
```

### Pattern 1: Per-User Resource Map (established pattern from db.ts)

**What:** Map<userId, Resource> with registry event lifecycle
**When to use:** Any resource that must exist per-user (DB, embedder, indexer)

```typescript
// Source: src/plugins/db.ts (existing pattern)
const userResources = new Map<string, Resource>();

// Create for all existing users at plugin init
for (const user of fastify.registry.getAllUsers()) {
  userResources.set(user.userId, createResource(user));
}

// Listen for registry lifecycle events
fastify.registry.on('user-added', (user) => {
  userResources.set(user.userId, createResource(user));
});

fastify.registry.on('user-removed', (user) => {
  const resource = userResources.get(user.userId);
  if (resource) {
    resource.cleanup();
    userResources.delete(user.userId);
  }
});

// Cleanup on server close
fastify.addHook('onClose', async () => {
  for (const [, resource] of userResources) {
    resource.cleanup();
  }
  userResources.clear();
});
```

### Pattern 2: Fastify-Level Accessor (for pipeline, outside request context)

**What:** Decorate fastify with a function that looks up per-user resources from the Map
**When to use:** When code runs outside request context (pipeline, indexer)

```typescript
// Embedding plugin
fastify.decorate('getUserEmbedder', (userId: string): EmbeddingProvider => {
  const embedder = userEmbedders.get(userId);
  if (!embedder) throw new Error(`No embedder for user: ${userId}`);
  return embedder;
});

// DB plugin (new method, alongside existing request decorators)
fastify.decorate('getUserDbById', (userId: string): DbInstance => {
  const entry = userDbs.get(userId);
  if (!entry) throw new Error(`No database for user: ${userId}`);
  return entry.db;
});
```

### Pattern 3: Per-User Pipeline with userId Context

**What:** Pipeline receives userId from indexer events, looks up all resources via fastify-level methods
**When to use:** Pipeline processing (runs outside request context)

```typescript
// Indexer emits events with userId attached
interface UserFileChangeEvent extends FileChangeEvent {
  userId: string;
}

// Pipeline processes with userId context
async function processEvent(fastify: FastifyInstance, event: UserFileChangeEvent): Promise<void> {
  const db = fastify.getUserDbById(event.userId);
  const qdrant = fastify.createTenantQdrant(event.userId);
  const embedder = fastify.getUserEmbedder(event.userId);
  // ... rest of processing
}
```

### Pattern 4: Metrics with user_id Label

**What:** Add user_id to labelNames, pass with every .inc() / .startTimer() / .set()
**When to use:** All per-user metrics

```typescript
// Definition
const searchDuration = new Histogram({
  name: 'cognivault_search_duration_seconds',
  help: 'Duration of search requests in seconds',
  labelNames: ['type', 'user_id'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

// Usage in route (has request.user)
fastify.metrics.searchDuration.startTimer({ type: 'semantic', user_id: request.user.userId });
fastify.metrics.searchRequests.inc({ type: 'semantic', user_id: request.user.userId });

// Usage in pipeline (has userId from event)
fastify.metrics.pipelineDuration.startTimer({ user_id: event.userId });
fastify.metrics.embeddingRequests.inc({ user_id: event.userId });

// Cleanup on user-removed
fastify.metrics.searchDuration.remove(userId);
fastify.metrics.searchRequests.remove(userId);
// ... all user-labeled metrics
```

### Anti-Patterns to Avoid
- **Global embedder in search/context routes:** Currently `fastify.embedder` is used -- must switch to `fastify.getUserEmbedder(userId)` sourced from request.user
- **Pipeline accessing request decorators:** Pipeline runs outside request context. Use fastify-level `getUserDbById()` / `getUserEmbedder()` / `createTenantQdrant()`, not request.getUserDb()
- **Shared PQueue across users:** One user's bulk reindex must not starve others. Each user gets their own PQueue instance
- **Forgetting metric .remove() on user deletion:** Stale label combinations accumulate in Prometheus if not cleaned up

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Per-user concurrency control | Custom queue/semaphore | PQueue (one per user) | Handles timeout, concurrency, event-based depth tracking |
| Metric label cleanup | Manual registry iteration | `metric.remove(labelValues)` | prom-client has built-in support, verified working |
| Tenant-scoped Qdrant | Manual filter injection | TenantQdrantClient (existing) | Already auto-injects user_id filter |
| Per-user VaultManager | New vault manager per user | Existing VaultManager with per-user vaultPath | Class already supports arbitrary root paths |

## Common Pitfalls

### Pitfall 1: Pipeline Using Wrong DB/Qdrant/Embedder
**What goes wrong:** Pipeline uses global or wrong user's resources, causing data cross-contamination
**Why it happens:** Pipeline runs outside request context. Easy to accidentally use fastify.embedder (global) or miss userId parameter
**How to avoid:** Pipeline functions must receive userId explicitly. All resource lookups must go through getUserDbById/getUserEmbedder/createTenantQdrant with that userId
**Warning signs:** Tests showing vectors in wrong user's namespace, embedding calls using wrong API key

### Pitfall 2: Startup Ordering Between Plugins
**What goes wrong:** Indexer plugin tries to use embedder or db before those plugins are ready
**Why it happens:** fp() dependency ordering is critical. Indexer depends on db, embedding, qdrant, registry, metrics, vault
**How to avoid:** Declare all dependencies in fp() call. Start indexers in onReady hook (after all plugins registered), not during plugin init
**Warning signs:** "No embedder for user" errors on startup, undefined fastify decorations

### Pitfall 3: Race Between user-added Events Across Plugins
**What goes wrong:** Indexer plugin's user-added handler fires before db plugin has created the user's database
**Why it happens:** EventEmitter listeners fire in registration order. If indexer registers before db, indexer tries to use db that doesn't exist yet
**How to avoid:** Register plugins in correct order (db before indexer) so db's event listener fires first. Alternatively, indexer can defer start until resources are confirmed available
**Warning signs:** "No database for user" errors when adding users at runtime

### Pitfall 4: Forgetting to Update chunkId() for Per-User Context
**What goes wrong:** chunkId currently takes `(filePath, chunkIndex)` in the old code (line 81 in pipeline.ts) but the function signature takes userId. The actual call site is wrong
**Why it happens:** Pipeline has @ts-nocheck so this wasn't caught
**How to avoid:** Remove @ts-nocheck, ensure chunkId receives userId from event context
**Warning signs:** TypeScript errors after removing @ts-nocheck, UUID collisions between users

### Pitfall 5: Embedder Validation on Startup
**What goes wrong:** Current embedding plugin calls `provider.validate()` which makes a real OpenAI API call. Doing this per-user at startup = N API calls
**Why it happens:** validate() embeds a test string to verify API key works
**How to avoid:** Skip validate() during bulk initialization. Log warning if embedding fails on first real use instead. Or validate lazily on first embed call
**Warning signs:** Slow startup with many users, startup failure if any user's key is temporarily invalid

### Pitfall 6: PQueue Gauge Per User
**What goes wrong:** indexQueueDepth gauge currently has no labels. Adding user_id means the gauge tracks per-user depth, but PQueue events need to carry userId context
**Why it happens:** PQueue's `next` and `idle` events don't carry custom context
**How to avoid:** Wrap PQueue add() to update the gauge with the correct userId label. Or update gauge inside the task wrapper rather than PQueue events
**Warning signs:** Queue depth always shows 0, or shows combined depth without user attribution

### Pitfall 7: VaultManager Per User
**What goes wrong:** Current vault plugin creates a single VaultManager for config.VAULT_PATH. Per-user indexing needs per-user vaultPaths
**Why it happens:** VaultManager is path-bound. Each user has a different vaultPath in their UserRecord
**How to avoid:** Create VaultManager instances per-user in the indexer plugin (VaultIndexer already takes a vault option). Don't modify the global vault plugin
**Warning signs:** All users indexing the same vault directory

## Code Examples

### Embedding Plugin Refactoring

```typescript
// Source: Based on existing src/plugins/embedding.ts + db.ts pattern
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { EmbeddingProvider } from '../lib/embedding.js';
import { OpenAIEmbeddingProvider } from '../lib/embedding.js';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    getUserEmbedder: (userId: string) => EmbeddingProvider;
  }
}

const userEmbedders = new Map<string, EmbeddingProvider>();

function createEmbedder(openaiKey: string): EmbeddingProvider {
  return new OpenAIEmbeddingProvider({
    apiKey: openaiKey,
    baseUrl: config.OPENAI_BASE_URL,
    model: config.EMBEDDING_MODEL,
  });
}

async function embeddingPlugin(fastify: FastifyInstance): Promise<void> {
  // Create embedders for existing users
  for (const user of fastify.registry.getAllUsers()) {
    userEmbedders.set(user.userId, createEmbedder(user.openaiKey));
  }

  fastify.registry.on('user-added', (user) => {
    userEmbedders.set(user.userId, createEmbedder(user.openaiKey));
  });

  fastify.registry.on('user-removed', (user) => {
    userEmbedders.delete(user.userId);
  });

  fastify.registry.on('user-updated', (user, previous) => {
    if (user.openaiKey !== previous.openaiKey) {
      userEmbedders.set(user.userId, createEmbedder(user.openaiKey));
    }
  });

  fastify.decorate('getUserEmbedder', (userId: string): EmbeddingProvider => {
    const embedder = userEmbedders.get(userId);
    if (!embedder) throw new Error(`No embedder for user: ${userId}`);
    return embedder;
  });
}

export default fp(embeddingPlugin, { name: 'embedder', dependencies: ['registry'] });
```

### Metrics user_id Label Addition

```typescript
// Source: Based on existing src/plugins/metrics.ts
// Only showing the changed metric definitions (add 'user_id' to labelNames)

const searchDuration = new Histogram({
  name: 'cognivault_search_duration_seconds',
  help: 'Duration of search requests in seconds',
  labelNames: ['type', 'user_id'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

const indexQueueDepth = new Gauge({
  name: 'cognivault_index_queue_depth',
  help: 'Current number of items in the index processing queue',
  labelNames: ['user_id'] as const,
  registers: [register],
});

// MetricsCollection interface adds user_id to all generics:
interface MetricsCollection {
  searchDuration: Histogram<'type' | 'user_id'>;
  searchRequests: Counter<'type' | 'user_id'>;
  indexQueueDepth: Gauge<'user_id'>;
  staleVectorCleanups: Counter<'user_id'>;
  embeddingRequests: Counter<'user_id'>;
  chunksProcessed: Counter<'user_id'>;
  pipelineDuration: Histogram<'user_id'>;
  contextPacks: Counter<'user_id'>; // NEW metric
  promRegistry: Registry;
  removeUserMetrics: (userId: string) => void; // cleanup helper
}
```

### User Metric Cleanup Helper

```typescript
// Convenience method to remove all user-scoped metric labels on user-removed
function removeUserMetrics(userId: string): void {
  searchDuration.remove({ type: 'semantic', user_id: userId });
  searchDuration.remove({ type: 'hybrid', user_id: userId });
  searchDuration.remove({ type: 'lexical', user_id: userId });
  searchRequests.remove({ type: 'semantic', user_id: userId });
  searchRequests.remove({ type: 'hybrid', user_id: userId });
  searchRequests.remove({ type: 'lexical', user_id: userId });
  indexQueueDepth.remove({ user_id: userId });
  staleVectorCleanups.remove({ user_id: userId });
  embeddingRequests.remove({ user_id: userId });
  chunksProcessed.remove({ user_id: userId });
  pipelineDuration.remove({ user_id: userId });
  contextPacks.remove({ user_id: userId });
}
```

### Search Route Update (embedder swap)

```typescript
// Before (global embedder):
const searchService = new SearchService(request.getUserQdrant(), fastify.embedder);

// After (per-user embedder):
const userId = request.user!.userId;
const searchService = new SearchService(
  request.getUserQdrant(),
  fastify.getUserEmbedder(userId),
);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Single global embedder | Per-user embedder Map | Phase 18 | Each user's OpenAI key used for their embeddings |
| Single VaultIndexer | Per-user VaultIndexer Map | Phase 18 | Each user's vault indexed independently |
| Shared PQueue | Per-user PQueue | Phase 18 | One user's reindex doesn't block others |
| Metrics without user_id | All per-user metrics labeled | Phase 18 | Prometheus/Grafana can filter by user |
| Pipeline via global DB | Pipeline via userId lookup | Phase 18 | Pipeline runs in tenant context without request |

## Open Questions

1. **VaultManager per-user instantiation**
   - What we know: VaultIndexer takes a `vault: VaultManager` option. Each user has a `vaultPath` in UserRecord. The global vault plugin uses config.VAULT_PATH.
   - What's unclear: Should indexer plugin create VaultManager instances per user, or should there be a per-user vault Map?
   - Recommendation: Create VaultManager per-user inside the indexer plugin. Keep the global vault plugin as-is for now (vault routes still use it). Per-user VaultManagers are internal to indexing -- routes don't need them for file browsing since routes already scope by auth.

2. **OPENAI_API_KEY env var still required?**
   - What we know: config.ts requires OPENAI_API_KEY. With per-user keys, the global key may no longer be needed.
   - What's unclear: Whether to make it optional or remove it entirely.
   - Recommendation: Make OPENAI_API_KEY optional in config.ts (`.optional()`) since all embedding now uses per-user keys. The qdrant plugin needs embedder dimensions at init -- could use a constant or derive from EMBEDDING_MODEL without an API key.

3. **Qdrant plugin dependency on embedder for dimensions**
   - What we know: qdrant plugin uses `fastify.embedder.dimensions` to create the collection. With per-user embedders, there's no single global embedder.
   - What's unclear: How to get dimensions without a global embedder.
   - Recommendation: Use `DIMENSION_MAP[config.EMBEDDING_MODEL]` directly in the qdrant plugin instead of depending on embedder. The DIMENSION_MAP is already exported from `src/lib/embedding.ts`.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest |
| Config file | vitest.config.ts (existing) |
| Quick run command | `pnpm test -- --run` |
| Full suite command | `pnpm test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| OBS-01 | Metrics carry user_id label | unit | `pnpm test -- --run src/plugins/__tests__/metrics.test.ts` | Exists (needs update) |
| SC-1 | Each user's vault indexed with own OpenAI key | unit | `pnpm test -- --run src/plugins/__tests__/embedding.test.ts` | New file needed |
| SC-2 | Routes return only user's data | integration | `pnpm test -- --run src/plugins/__tests__/db.test.ts` | Exists (already tests this) |
| SC-3 | Metrics carry user_id on every increment | unit | `pnpm test -- --run src/plugins/__tests__/metrics.test.ts` | Exists (needs update) |
| SC-4 | Add/remove user starts/stops indexer | unit | `pnpm test -- --run src/plugins/__tests__/indexer.test.ts` | Exists (needs rewrite) |

### Sampling Rate
- **Per task commit:** `pnpm test -- --run`
- **Per wave merge:** `pnpm test && pnpm check`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/plugins/__tests__/embedding.test.ts` -- needs new tests for per-user embedder Map lifecycle
- [ ] `src/plugins/__tests__/indexer.test.ts` -- needs complete rewrite for per-user indexer Map
- [ ] `src/plugins/__tests__/pipeline.test.ts` -- needs rewrite for userId context
- [ ] `src/plugins/__tests__/metrics.test.ts` -- needs updates for user_id label assertions

## Sources

### Primary (HIGH confidence)
- Codebase analysis: All source files in src/plugins/ and src/features/ read directly
- prom-client `.remove()` method: Verified working for Counter, Histogram, and Gauge via direct Node.js execution
- Existing db.ts pattern: Map<userId, Resource> + registry events verified as established pattern

### Secondary (MEDIUM confidence)
- VaultIndexer constructor options: Takes db, vault, config, logger -- confirmed from src/lib/indexer.ts
- OpenAIEmbeddingProvider constructor: Takes apiKey, baseUrl, model -- confirmed from src/lib/embedding.ts
- PQueue: Already used in pipeline.ts with concurrency and timeout options

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already in use, no new dependencies
- Architecture: HIGH -- following established db.ts pattern, all integration points identified
- Pitfalls: HIGH -- based on direct codebase analysis, verified prom-client behavior
- Metrics (OBS-01): HIGH -- prom-client remove() verified, label addition is straightforward

**Research date:** 2026-03-14
**Valid until:** 2026-04-14 (stable -- no external dependencies changing)
