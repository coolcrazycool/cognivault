# Phase 17: Data Isolation - Research

**Researched:** 2026-03-14
**Domain:** Multi-tenant data isolation (Qdrant payload filtering, per-user SQLite, tenant-scoped wrappers)
**Confidence:** HIGH

## Summary

Phase 17 transforms CogniVault from a single-tenant data layer to a multi-tenant one where each user's vectors and index state are structurally isolated. The approach uses Qdrant's payload filtering (single shared collection with mandatory `user_id` filter) and per-user SQLite databases at scoped paths. A `TenantQdrantClient` wrapper enforces that every Qdrant operation includes the user's filter, making bypass structurally impossible by never exposing the raw client.

The codebase is well-positioned for this work. The `createDatabase()` function in `src/db/client.ts` already handles SQLite creation with WAL mode and Drizzle migrations. The `UserRegistry` in `src/lib/user-registry.ts` already emits `user-added`/`user-removed` events. The auth plugin already sets `request.user` with the full `UserRecord`. The refactoring is primarily about replacing single-instance decorators (`fastify.db`, `fastify.qdrant`) with tenant-aware per-request decorators (`request.getUserDb()`, `request.getUserQdrant()`).

**Primary recommendation:** Build the `TenantQdrantClient` wrapper as a standalone class (easy to unit test), refactor the db plugin to manage a `Map<string, db>` keyed by userId, and add request decorators that resolve the correct tenant resources from `request.user.userId`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Single `cognivault` collection shared by all users -- no separate collections per user
- Every point payload includes a `user_id` field (keyword-indexed)
- `user_id` keyword index created at collection setup time alongside existing payload indexes in `qdrant.ts`
- Chunk UUIDs incorporate user_id: `uuidv5('{userId}:{path}:{chunkIndex}', namespace)` -- prevents ID collisions between users with identically-named files
- When a user is removed from registry, all their Qdrant vectors (points with matching user_id) are deleted immediately
- Each user gets a separate SQLite database at `{COGNIVAULT_DATA_DIR}/{userId}/index.db`
- Databases created eagerly when registry emits `user-added` -- user has a ready DB before their first request
- Drizzle migrations run on each database at creation time via existing `createDatabase()` function
- Route handlers access the correct DB via `request.getUserDb()` method (decorated on FastifyRequest)
- Internally backed by a `Map<userId, db>` that the DB plugin manages
- When a user is removed from registry, their SQLite database is closed and the `{userId}/` directory is deleted
- Clean break -- no migration of existing single-tenant data. Old `index.db` in DATA_DIR root is actively deleted on v2.0 startup
- Old Qdrant vectors (points without `user_id` payload) are purged on startup -- delete all points where user_id field is absent
- `TenantQdrantClient` wrapper injects mandatory `user_id` filter into every operation -- structurally impossible to forget
- Wrapper exposes only the 5 methods CogniVault actually uses: `search`, `scroll`, `upsert`, `delete`, `setPayload` -- minimal auditable surface
- Filter injection happens at the wrapper level (application-level), not via Qdrant JWT/ACL
- Raw QdrantClient is a local variable inside the qdrant plugin -- used only for setup operations (index creation, legacy purge). Never exposed on `fastify` or `request`
- Route handlers access tenant-scoped Qdrant via `request.getUserQdrant()` -- consistent pattern with `request.getUserDb()`
- Dedicated integration test: creates two users, indexes data for each, verifies User A search returns zero of User B's vectors

### Claude's Discretion
- TenantQdrantClient internal implementation details
- Filter merging strategy (how user_id is combined with caller-provided filters)
- DB connection pool/cache eviction strategy
- Exact startup purge implementation (batch delete vs scroll-and-delete)
- Test file organization and helper structure

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DATA-01 | Each user's Qdrant vectors are filtered by user_id payload; cross-tenant queries are structurally impossible | TenantQdrantClient wrapper pattern, mandatory user_id filter injection, integration test pattern |
| DATA-02 | Each user has a separate SQLite database for index state, stored at a user-scoped path | Per-user DB Map pattern, eager creation on user-added event, createDatabase() reuse |
</phase_requirements>

## Standard Stack

### Core (already in project)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @qdrant/js-client-rest | ^1.17.0 | Vector database client | Already used; provides search/scroll/upsert/delete/setPayload |
| better-sqlite3 | ^12.6.2 | SQLite driver | Already used; synchronous API, WAL mode support |
| drizzle-orm | ^0.45.1 | ORM + migrations | Already used; `createDatabase()` handles per-db migration |
| uuid | ^13.0.0 | Deterministic chunk IDs | Already used; uuidv5 for `{userId}:{path}:{chunkIndex}` |
| fastify-plugin (fp) | existing | Plugin encapsulation | Already used; dependency declarations |

### No New Dependencies Required

This phase requires zero new packages. Everything is built using existing libraries and Fastify patterns.

## Architecture Patterns

### Recommended Changes to Project Structure
```
src/
  lib/
    tenant-qdrant-client.ts    # NEW: TenantQdrantClient wrapper class
  plugins/
    db.ts                      # REFACTOR: single DB -> per-user Map + request decorator
    qdrant.ts                  # REFACTOR: raw client stays local, add user_id index, expose wrapper factory
  features/
    search/
      service.ts               # UPDATE: accept TenantQdrantClient instead of raw QdrantClient
```

### Pattern 1: TenantQdrantClient Wrapper

**What:** A class that wraps `QdrantClient` and injects `user_id` filter into every operation.
**When to use:** Every route handler and service that touches Qdrant.

```typescript
// src/lib/tenant-qdrant-client.ts
import type { QdrantClient } from '@qdrant/js-client-rest';
import { COLLECTION_NAME } from '../plugins/qdrant.js';

export class TenantQdrantClient {
  private readonly client: QdrantClient;
  private readonly userId: string;

  constructor(client: QdrantClient, userId: string) {
    this.client = client;
    this.userId = userId;
  }

  async search(params: { vector: number[]; limit: number; filter?: { must?: unknown[] }; with_payload?: boolean; score_threshold?: number }) {
    const userFilter = { key: 'user_id', match: { value: this.userId } };
    const must = [...(params.filter?.must ?? []), userFilter];
    return this.client.search(COLLECTION_NAME, {
      ...params,
      filter: { ...params.filter, must },
    });
  }

  async scroll(params: { filter?: { must?: unknown[]; should?: unknown[] }; limit: number; with_payload?: boolean }) {
    const userFilter = { key: 'user_id', match: { value: this.userId } };
    const must = [...(params.filter?.must ?? []), userFilter];
    return this.client.scroll(COLLECTION_NAME, {
      ...params,
      filter: { ...params.filter, must },
    });
  }

  async upsert(params: { points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> }) {
    // Inject user_id into every point's payload
    const points = params.points.map((p) => ({
      ...p,
      payload: { ...p.payload, user_id: this.userId },
    }));
    return this.client.upsert(COLLECTION_NAME, { points });
  }

  async delete(params: { filter: { must?: unknown[] } }) {
    const userFilter = { key: 'user_id', match: { value: this.userId } };
    const must = [...(params.filter.must ?? []), userFilter];
    return this.client.delete(COLLECTION_NAME, {
      filter: { ...params.filter, must },
    });
  }

  async setPayload(params: { payload: Record<string, unknown>; filter: { must?: unknown[] } }) {
    const userFilter = { key: 'user_id', match: { value: this.userId } };
    const must = [...(params.filter.must ?? []), userFilter];
    return this.client.setPayload(COLLECTION_NAME, {
      ...params,
      filter: { ...params.filter, must },
    });
  }
}
```

**Key design decisions:**
- Collection name is hardcoded inside the wrapper (callers never pass it) -- reduces another class of error
- `upsert` injects `user_id` into payload automatically, so pipeline code cannot forget it
- Filter merging uses spread on `must` array, preserving caller conditions while adding `user_id`
- For `scroll` with `should` conditions (lexical search), the `user_id` goes in `must` while `should` is preserved -- Qdrant evaluates `must AND (any of should)`

### Pattern 2: Per-User SQLite Database Map

**What:** The db plugin manages a `Map<string, { db, sqlite }>` keyed by userId. Databases are created eagerly on `user-added` events and cleaned up on `user-removed`.
**When to use:** Replaces the current single `fastify.db` pattern.

```typescript
// Conceptual pattern for refactored db plugin
interface UserDb {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: InstanceType<typeof Database>;
}

const userDbs = new Map<string, UserDb>();

// On user-added (from registry events or initial load)
function createUserDb(userId: string): UserDb {
  const userDir = join(dataDir, userId);
  mkdirSync(userDir, { recursive: true });
  const dbPath = join(userDir, 'index.db');
  return createDatabase(dbPath); // reuses existing function
}

// Request decorator
fastify.decorateRequest('getUserDb', function (this: FastifyRequest) {
  const userId = this.user!.userId;
  const entry = userDbs.get(userId);
  if (!entry) throw new Error(`No database for user: ${userId}`);
  return entry.db;
});
```

**Important:** `decorateRequest` in Fastify takes an initial value, not a factory function. For getter-style behavior, use a getter or decorate with `null` and set in an `onRequest` hook. The recommended approach:

```typescript
// Decorate with null, set per-request in onRequest hook
fastify.decorateRequest('userDb', null);
fastify.decorateRequest('userQdrant', null);

fastify.addHook('onRequest', async (request) => {
  if (!request.user) return; // unauthenticated routes (health, etc.)
  const userId = request.user.userId;
  request.userDb = userDbs.get(userId)?.db;
  request.userQdrant = new TenantQdrantClient(rawClient, userId);
});
```

Alternatively, use getter functions decorated on the request:

```typescript
fastify.decorateRequest('getUserDb', null);
// In onRequest hook after auth:
request.getUserDb = () => {
  const entry = userDbs.get(request.user!.userId);
  if (!entry) throw new Error(`No database for user: ${request.user!.userId}`);
  return entry.db;
};
```

**Recommendation:** Use the `request.userDb` / `request.userQdrant` pattern (set in `onRequest` hook) for simplicity. The CONTEXT.md says `request.getUserDb()` -- implement as a function property set in the hook.

### Pattern 3: Legacy Data Purge on Startup

**What:** On v2.0 startup, delete the old single-tenant `index.db` and purge Qdrant vectors without `user_id`.
**When to use:** Once, in the qdrant plugin and db plugin startup.

```typescript
// In qdrant plugin, after collection setup:
// Delete legacy vectors without user_id
await client.delete(COLLECTION_NAME, {
  filter: {
    must_not: [
      { key: 'user_id', match: { any: ['*'] } }, // This won't work
    ],
  },
});
```

**Note on purging vectors without user_id:** Qdrant does not have a "field exists" filter directly. The correct approach is to use `IsEmpty` condition:

```typescript
// Qdrant filter for "user_id field is null or missing"
await client.delete(COLLECTION_NAME, {
  filter: {
    must: [
      { is_empty: { key: 'user_id' } },
    ],
  },
});
```

The `is_empty` condition in Qdrant matches points where the field is absent, null, or an empty array. This is the correct way to find and delete legacy vectors. **Confidence: HIGH** -- verified from Qdrant documentation.

### Pattern 4: Chunk ID with User Prefix

**What:** The `chunkId()` function in pipeline.ts must incorporate `userId` to prevent ID collisions.
**When to use:** Every upsert operation.

```typescript
// Current:
function chunkId(filePath: string, chunkIndex: number): string {
  return uuidv5(`${filePath}:${chunkIndex}`, UUID_NAMESPACE);
}

// New:
function chunkId(userId: string, filePath: string, chunkIndex: number): string {
  return uuidv5(`${userId}:${filePath}:${chunkIndex}`, UUID_NAMESPACE);
}
```

**Why:** Two users with the same file path (e.g., `notes/todo.md`) would generate the same UUID and overwrite each other's vectors. The user_id prefix makes UUIDs unique per tenant.

### Anti-Patterns to Avoid
- **Exposing raw QdrantClient on `fastify` or `request`:** The entire isolation guarantee depends on the raw client being inaccessible to route handlers. Keep it as a local variable inside the qdrant plugin closure.
- **Lazy DB creation on first request:** Creates a race condition where concurrent first-requests trigger parallel `createDatabase()` calls. Use eager creation on `user-added` event instead.
- **Using `fastify.db` anywhere:** After this phase, `fastify.db` must not exist. All DB access goes through `request.getUserDb()`. Leaving `fastify.db` creates a bypass path.
- **Forgetting to add `user_id` to `must` array for `scroll` with `should`:** Qdrant evaluates `must AND should`. If `user_id` is only in `should`, it becomes optional. Always place `user_id` in `must`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Filter injection | Manual filter assembly in each route | TenantQdrantClient wrapper | Single enforcement point; auditable; tested once |
| DB lifecycle | Custom connection pool with TTLs | Simple Map<userId, db> with event-driven create/destroy | 5-20 users; no eviction needed; SQLite connections are cheap |
| Migration management | Manual SQL statements per user DB | Drizzle's `migrate()` via existing `createDatabase()` | Already handles WAL mode, schema migrations, idempotency |
| "Field absent" Qdrant filter | scroll-and-delete loop | `is_empty` condition in single batch delete | Qdrant handles this server-side efficiently |

**Key insight:** The complexity here is structural (making bypass impossible), not algorithmic. The wrapper pattern is simple code that provides strong guarantees.

## Common Pitfalls

### Pitfall 1: Fastify Request Decorator Timing
**What goes wrong:** `request.getUserDb()` is called before the auth hook sets `request.user`, returning undefined.
**Why it happens:** Fastify hooks run in registration order. If the tenant-resolution hook runs before auth, `request.user` is not yet set.
**How to avoid:** Register the tenant-resolution hook AFTER the auth plugin, or do it within the same hook. The auth plugin already sets `request.user` in `onRequest`. A subsequent `onRequest` hook (registered after auth) can resolve tenant resources.
**Warning signs:** `undefined` user in test logs, `No database for user: undefined` errors.

### Pitfall 2: SQLite Connection Leak on User Removal
**What goes wrong:** User is removed but their SQLite connection is not closed before the directory is deleted.
**Why it happens:** `fs.rm()` of the directory while the SQLite file is still open.
**How to avoid:** Close the `sqlite` handle first (synchronous `sqlite.close()`), then remove from the Map, then `fs.rm()` the directory.
**Warning signs:** EBUSY errors on directory deletion, SQLite WAL/SHM files left behind.

### Pitfall 3: Race Between User-Added Event and First Request
**What goes wrong:** User is added to registry, API key is immediately valid, but DB is not yet created.
**Why it happens:** The `user-added` event handler creates the DB asynchronously.
**How to avoid:** Use `await` in the event handler and create the DB synchronously (better-sqlite3 is sync). Or check in `getUserDb()` and create on-demand as a fallback.
**Warning signs:** Sporadic "No database for user" errors on first request after user creation.

### Pitfall 4: Existing Tests Break After Removing `fastify.db`
**What goes wrong:** Every test that accesses `app.db` or `fastify.db` fails.
**Why it happens:** The db plugin no longer decorates `fastify.db`; it only provides per-request access.
**How to avoid:** Update all existing tests to use the new per-request pattern. For plugin-level tests (pipeline), provide the tenant DB directly.
**Warning signs:** TypeScript compilation errors on `fastify.db`, test failures across the board.

### Pitfall 5: Pipeline Plugin Uses `fastify.qdrant` Directly
**What goes wrong:** Pipeline code still uses the raw client, bypassing tenant isolation.
**Why it happens:** Pipeline is a plugin (not a route handler), so it does not have a `request` context.
**How to avoid:** Pipeline must be refactored in Phase 18 to be user-aware. For Phase 17, the pipeline plugin should be temporarily disabled or adapted to accept a tenant-scoped client. Since Phase 18 handles per-user indexing, the pipeline refactoring may be deferred, but the raw client must still become inaccessible. **Recommended approach:** Have the qdrant plugin provide a factory function `createTenantClient(userId)` that pipeline (Phase 18) will use.
**Warning signs:** Pipeline still calling `fastify.qdrant.upsert(...)` without user_id.

### Pitfall 6: `user_id` Index Not Created for Existing Collections
**What goes wrong:** The `user_id` keyword index is only created when the collection is first created (inside `if (!exists)` block).
**Why it happens:** Current code only creates payload indexes during initial collection creation.
**How to avoid:** Add `user_id` index creation to the idempotent section (outside `if (!exists)`), similar to how text indexes are handled. Use try/catch for "already exists" errors.
**Warning signs:** Slow filtered queries, full scans on user_id field.

## Code Examples

### Qdrant Filter with is_empty (Legacy Purge)
```typescript
// Source: Qdrant documentation - filtering conditions
// Delete all points where user_id is absent/null
await client.delete(COLLECTION_NAME, {
  filter: {
    must: [
      { is_empty: { key: 'user_id' } },
    ],
  },
});
```

### TenantQdrantClient Filter Merging (Search)
```typescript
// Caller passes filter for tags:
// { must: [{ key: 'tags', match: { any: ['project-a'] } }] }
//
// TenantQdrantClient produces:
// { must: [{ key: 'tags', match: { any: ['project-a'] } }, { key: 'user_id', match: { value: 'alice' } }] }
```

### TenantQdrantClient Filter Merging (Lexical Scroll)
```typescript
// Caller passes filter with should:
// { should: [{ key: 'text', match: { text: 'query' } }] }
//
// TenantQdrantClient produces:
// { must: [{ key: 'user_id', match: { value: 'alice' } }], should: [{ key: 'text', match: { text: 'query' } }] }
// Qdrant evaluates: must AND (any of should)
```

### Fastify Request Decorator Pattern
```typescript
// Type augmentation
declare module 'fastify' {
  interface FastifyRequest {
    getUserDb: () => BetterSQLite3Database<typeof schema>;
    getUserQdrant: () => TenantQdrantClient;
  }
}

// In db plugin (after auth hook has run):
fastify.addHook('onRequest', async (request) => {
  if (!request.user) return;
  const userId = request.user.userId;

  request.getUserDb = () => {
    const entry = userDbs.get(userId);
    if (!entry) throw new Error(`No database for user: ${userId}`);
    return entry.db;
  };

  request.getUserQdrant = () => {
    return new TenantQdrantClient(rawClient, userId);
  };
});
```

### Eager DB Creation on User-Added
```typescript
registry.on('user-added', async (user) => {
  const userDir = join(dataDir, user.userId);
  await mkdir(userDir, { recursive: true });
  const dbPath = join(userDir, 'index.db');
  const { db, sqlite } = createDatabase(dbPath);
  userDbs.set(user.userId, { db, sqlite });
  fastify.log.info({ userId: user.userId }, 'Created per-user database');
});

registry.on('user-removed', async (user) => {
  const entry = userDbs.get(user.userId);
  if (entry) {
    entry.sqlite.close();
    userDbs.delete(user.userId);
  }
  const userDir = join(dataDir, user.userId);
  await rm(userDir, { recursive: true, force: true });
  fastify.log.info({ userId: user.userId }, 'Removed per-user database');
});
```

### Creating user_id Index (Idempotent)
```typescript
// In qdrant plugin, OUTSIDE the if (!exists) block:
try {
  await client.createPayloadIndex(COLLECTION_NAME, {
    field_name: 'user_id',
    field_schema: 'keyword',
  });
} catch {
  // Index already exists -- safe to ignore
}
```

## State of the Art

| Old Approach (v1.0) | New Approach (v2.0) | Impact |
|----------------------|---------------------|--------|
| Single `fastify.db` decorator | Per-user `request.getUserDb()` | Route handlers get tenant-scoped DB |
| Single `fastify.qdrant` (raw client) | `request.getUserQdrant()` (TenantQdrantClient) | All Qdrant ops are tenant-filtered |
| `chunkId(path, index)` | `chunkId(userId, path, index)` | No cross-user UUID collisions |
| No user_id in Qdrant payloads | user_id in every point, keyword-indexed | Enables filtered queries |
| Single index.db in DATA_DIR | `{DATA_DIR}/{userId}/index.db` | Per-user index state |

## Open Questions

1. **Pipeline plugin refactoring scope**
   - What we know: Pipeline currently uses `fastify.qdrant` and `fastify.db` directly. Phase 18 handles per-user indexing.
   - What's unclear: Should pipeline be temporarily broken/disabled in Phase 17, or should it be minimally adapted with a `createTenantClient(userId)` factory?
   - Recommendation: Provide a `createTenantClient(userId)` factory from the qdrant plugin (internal, not on request). Pipeline refactoring is Phase 18's concern, but the factory must exist for it to use.

2. **SearchService constructor change**
   - What we know: `SearchService` currently takes `QdrantClient` in constructor. It needs to take `TenantQdrantClient` instead.
   - What's unclear: Should `SearchService` be instantiated per-request or remain a singleton with tenant client passed per-call?
   - Recommendation: Instantiate per-request in the route handler with the tenant client from `request.getUserQdrant()`. The service is lightweight (no state beyond constructor args).

3. **DB connection count for many users**
   - What we know: For 5-20 users, keeping all SQLite connections open is fine (negligible memory).
   - What's unclear: If user count grows beyond expectations, would connection count become a problem?
   - Recommendation: Use a simple Map with no eviction for now. Add LRU eviction in a future phase if needed (YAGNI).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (via project config) |
| Config file | vitest.config.ts |
| Quick run command | `pnpm test -- --run src/lib/__tests__/tenant-qdrant-client.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DATA-01 | TenantQdrantClient always injects user_id filter | unit | `pnpm test -- --run src/lib/__tests__/tenant-qdrant-client.test.ts` | No - Wave 0 |
| DATA-01 | Search by User A returns zero results from User B | integration | `pnpm test -- --run src/plugins/__tests__/qdrant-isolation.test.ts` | No - Wave 0 |
| DATA-01 | user_id keyword index created on collection setup | unit | `pnpm test -- --run src/plugins/__tests__/qdrant.test.ts` | Yes (update needed) |
| DATA-01 | Legacy vectors (no user_id) purged on startup | unit | `pnpm test -- --run src/plugins/__tests__/qdrant.test.ts` | Yes (update needed) |
| DATA-02 | Per-user SQLite created at {DATA_DIR}/{userId}/index.db | unit | `pnpm test -- --run src/plugins/__tests__/db.test.ts` | Yes (rewrite needed) |
| DATA-02 | DB created on user-added event | unit | `pnpm test -- --run src/plugins/__tests__/db.test.ts` | Yes (rewrite needed) |
| DATA-02 | DB closed and directory deleted on user-removed event | unit | `pnpm test -- --run src/plugins/__tests__/db.test.ts` | Yes (rewrite needed) |
| DATA-02 | Old root index.db deleted on startup | unit | `pnpm test -- --run src/plugins/__tests__/db.test.ts` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test -- --run src/lib/__tests__/tenant-qdrant-client.test.ts src/plugins/__tests__/db.test.ts src/plugins/__tests__/qdrant.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/lib/__tests__/tenant-qdrant-client.test.ts` -- covers DATA-01 (filter injection, all 5 methods)
- [ ] `src/plugins/__tests__/qdrant-isolation.test.ts` -- covers DATA-01 (cross-tenant isolation integration test)
- [ ] Update `src/plugins/__tests__/db.test.ts` -- covers DATA-02 (per-user DB lifecycle)
- [ ] Update `src/plugins/__tests__/qdrant.test.ts` -- covers DATA-01 (user_id index, legacy purge)

## Sources

### Primary (HIGH confidence)
- Codebase analysis: `src/plugins/qdrant.ts`, `src/plugins/db.ts`, `src/db/client.ts`, `src/lib/user-registry.ts`, `src/plugins/auth.ts`, `src/plugins/pipeline.ts`, `src/features/search/service.ts`
- Qdrant JS client type definitions: `node_modules/@qdrant/js-client-rest/dist/types/qdrant-client.d.ts`
- Existing test patterns: `src/plugins/__tests__/qdrant.test.ts`, `src/plugins/__tests__/db.test.ts`, `src/features/search/__tests__/routes.test.ts`

### Secondary (MEDIUM confidence)
- Qdrant `is_empty` filter condition -- from Qdrant documentation for filtering on absent fields
- Fastify `decorateRequest` behavior -- from Fastify docs; getter functions set in hooks is a common pattern

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already in use, no new dependencies
- Architecture: HIGH -- patterns derive directly from existing codebase conventions
- Pitfalls: HIGH -- identified from direct code analysis of current implementations
- Qdrant is_empty filter: MEDIUM -- documented in Qdrant docs but not yet used in this codebase

**Research date:** 2026-03-14
**Valid until:** 2026-04-14 (stable dependencies, no fast-moving APIs)
