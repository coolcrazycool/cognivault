# Architecture Research

**Domain:** Multi-tenant knowledge access service — single-container, registry-driven, per-user vault sync
**Researched:** 2026-03-14
**Confidence:** HIGH (codebase read directly; obsidian-headless docs verified via GitHub; patterns from v1.0 code confirmed)

---

## Context: v2.0 Milestone Scope

This document focuses exclusively on the **new** and **modified** components for v2.0 multi-tenant support. The v1.0 architecture (Fastify plugin system, chunking pipeline, Qdrant hybrid search, context pack assembly) is proven and unchanged in design. The research question is: **what changes, what is new, and what must be built first?**

---

## Standard Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Single Docker Container                      │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                   CLI Layer (Commander.js)                    │    │
│  │  add-user | remove-user | list-users | docker-start          │    │
│  └──────────────────────────┬──────────────────────────────────┘    │
│                             │ reads/writes users.json                │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                 User Registry (users.json)                    │    │
│  │  { apiKey → { userId, vaultPath, openaiKey, obsidianCreds }} │    │
│  └──────────────────────────┬──────────────────────────────────┘    │
│                             │ fs.watch hot-reload                    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │              Fastify API Process (existing)                   │    │
│  │                                                              │    │
│  │  Auth Plugin (MODIFIED)                                      │    │
│  │    Bearer token → registry lookup → user context attached    │    │
│  │                                                              │    │
│  │  Registry Plugin (NEW)                                       │    │
│  │    Loads users.json, fs.watch hot-reload, apiKey→user map    │    │
│  │                                                              │    │
│  │  Embedder Plugin (MODIFIED)                                  │    │
│  │    Per-request user context → per-user OpenAI key            │    │
│  │                                                              │    │
│  │  Vault Plugin (MODIFIED)                                     │    │
│  │    Per-request vault path from registry (not env var)        │    │
│  │                                                              │    │
│  │  Indexer Plugin (MODIFIED)                                   │    │
│  │    Map<userId, VaultIndexer> — one poller per user           │    │
│  │                                                              │    │
│  │  Pipeline Plugin (MODIFIED)                                  │    │
│  │    Per-user PQueue + per-user embedder from registry         │    │
│  │                                                              │    │
│  │  Feature Routes (MINOR MODIFICATION)                         │    │
│  │    Pass userId from request context to Qdrant filter         │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  obsidian-   │  │  obsidian-   │  │  obsidian-   │              │
│  │  headless    │  │  headless    │  │  headless    │              │
│  │  (user-a)    │  │  (user-b)    │  │  (user-n)    │              │
│  │  child proc  │  │  child proc  │  │  child proc  │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         │ sync writes      │ sync writes      │ sync writes          │
│  ┌──────▼───────┐  ┌──────▼───────┐  ┌──────▼───────┐              │
│  │  vault-a/    │  │  vault-b/    │  │  vault-n/    │              │
│  │  (bind mount)│  │  (bind mount)│  │  (bind mount)│              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    External Sidecars (unchanged)                      │
│         Qdrant | Prometheus | Grafana | SQLite (per-user DB)         │
└─────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Status | Responsibility |
|-----------|--------|----------------|
| **UserRegistry** | NEW | In-memory apiKey→UserRecord map, loaded from `users.json`, hot-reloaded via `fs.watch`. Zero-downtime user adds/removes. |
| **CLI (`src/cli/`)** | NEW | Commander.js program: `add-user`, `remove-user`, `list-users`, `docker-start`. Reads/writes `users.json`. Spawns obsidian-headless child processes. |
| **Auth Plugin** | MODIFIED | Was: validate against single `COGNIVAULT_API_KEY` env var. Now: look up apiKey in UserRegistry, attach `request.user = { userId, vaultPath, openaiKey }` on success. |
| **Registry Plugin** | NEW | Fastify plugin that loads UserRegistry from disk, starts `fs.watch`, decorates `fastify.registry`. Depends on: nothing (loads before other plugins). |
| **Vault Plugin** | MODIFIED | Was: single VaultManager from `VAULT_PATH` env var. Now: per-request VaultManager constructed from `request.user.vaultPath`. Vault is still resolved per-request, not cached (VaultManager is cheap to construct). |
| **Embedder Plugin** | MODIFIED | Was: single OpenAI provider from global `OPENAI_API_KEY`. Now: per-request embedder from `request.user.openaiKey` (cached per-user by registry). |
| **Indexer Plugin** | MODIFIED | Was: single VaultIndexer on `fastify.indexer`. Now: `Map<userId, VaultIndexer>` with start/stop on user add/remove. |
| **Pipeline Plugin** | MODIFIED | Was: one PQueue listening to single indexer. Now: per-user PQueue, per-user embedder from registry, all wired in `onReady`. |
| **DB Plugin** | MODIFIED | Was: single SQLite at `COGNIVAULT_DATA_DIR/index.db`. Now: per-user SQLite at `COGNIVAULT_DATA_DIR/{userId}/index.db`. |
| **Qdrant Plugin** | MINOR MODIFICATION | Single QdrantClient unchanged. Collection name: single `cognivault` collection with `user_id` payload field (already present in v1 metrics, just not as index filter). |
| **Search/Context/Admin Routes** | MINOR MODIFICATION | Pass `request.user.userId` as Qdrant filter on every search operation. |
| **Metrics Plugin** | MINOR MODIFICATION | Counters/histograms already have `user_id` label slots from Phase 12. Wire actual userId from request context. |
| **Config (Zod)** | MODIFIED | Remove `COGNIVAULT_API_KEY`, `VAULT_PATH`, `OPENAI_API_KEY` as required. Replace with `USERS_FILE` path and `COGNIVAULT_DATA_DIR`. |
| **obsidian-headless processes** | NEW | One `ob sync --continuous` child process per user. Managed by CLI. Writes to per-user vault directory. CogniVault pollers detect sync'd changes. |

---

## Recommended Project Structure (new/modified files only)

```
src/
├── cli/                          # NEW — Commander.js CLI
│   ├── index.ts                  # Entry point: program.parse(process.argv)
│   ├── commands/
│   │   ├── add-user.ts           # ob login + ob sync-setup + users.json write
│   │   ├── remove-user.ts        # users.json write + kill sync proc
│   │   ├── list-users.ts         # Pretty-print users.json
│   │   └── docker-start.ts       # spawn obsidian-headless procs + exec API server
│   └── registry-file.ts          # Read/write users.json with schema validation
│
├── lib/
│   ├── user-registry.ts          # NEW — UserRegistry class (in-memory map + fs.watch)
│   ├── sync-manager.ts           # NEW — spawn/kill obsidian-headless child processes
│   └── ... (existing lib files unchanged)
│
├── plugins/
│   ├── registry.ts               # NEW — Fastify plugin: load UserRegistry, hot-reload
│   ├── auth.ts                   # MODIFIED — registry lookup instead of single key
│   ├── vault.ts                  # MODIFIED — per-request VaultManager
│   ├── embedding.ts              # MODIFIED — per-user OpenAI provider
│   ├── indexer.ts                # MODIFIED — Map<userId, VaultIndexer>
│   ├── pipeline.ts               # MODIFIED — per-user PQueue + embedder
│   ├── db.ts                     # MODIFIED — per-user SQLite path
│   ├── qdrant.ts                 # MINOR MOD — ensure user_id payload index exists
│   └── metrics.ts                # MINOR MOD — wire userId labels from request context
│
├── config.ts                     # MODIFIED — schema changes
└── ... (existing app.ts, server.ts, features/ unchanged in structure)

data/                             # COGNIVAULT_DATA_DIR (bind-mounted volume)
├── users.json                    # Registry file (written by CLI)
├── {userId}/
│   ├── index.db                  # Per-user SQLite index state
│   └── vault/                    # Per-user vault directory (obsidian-headless syncs here)
```

### Structure Rationale

- **`src/cli/` directory:** CLI is a separate entry point (`bin` in package.json), not part of the Fastify app. It shares `src/lib/registry-file.ts` with the server for consistent schema validation.
- **`src/lib/user-registry.ts`:** The hot-reload logic lives in a plain class, not inside a Fastify plugin, so it can be tested without starting a server.
- **Per-user data dirs:** `{userId}/index.db` and `{userId}/vault/` keep all user state isolated and trivially removable (delete directory on `remove-user`).

---

## Architectural Patterns

### Pattern 1: Registry Plugin — Single Source of Truth for User Context

**What:** A Fastify plugin (`registry.ts`) loads `users.json` at startup, builds an in-memory `Map<apiKey, UserRecord>` (where `UserRecord = { userId, vaultPath, openaiKey, obsidianEmail }`), and starts `fs.watch` on the file. The Auth plugin uses `fastify.registry.lookup(apiKey)` to resolve user context. On file change, the registry atomically rebuilds the map.

**When to use:** Every request that needs to know who the caller is. The registry is the only place this mapping lives.

**Trade-offs:**
- Zero-downtime user adds: operator runs `cogvault add-user`, CLI writes `users.json`, server hot-reloads within ~1s without restart.
- File corruption risk: if `users.json` is malformed mid-write, `fs.watch` fires on a partial file. Mitigation: CLI writes atomically via temp file + rename; registry skips reload if JSON parse fails.

```typescript
// src/lib/user-registry.ts
export interface UserRecord {
  userId: string;
  vaultPath: string;       // absolute path to vault directory
  openaiKey: string;       // per-user OpenAI API key
  obsidianEmail: string;   // stored for display only, creds managed by ob CLI
}

export class UserRegistry {
  private map = new Map<string, UserRecord>(); // apiKey → UserRecord

  load(usersFilePath: string): void { /* parse JSON, build map */ }
  lookup(apiKey: string): UserRecord | undefined { return this.map.get(apiKey); }
  all(): UserRecord[] { return Array.from(this.map.values()); }
}
```

```typescript
// src/plugins/registry.ts
declare module 'fastify' {
  interface FastifyInstance { registry: UserRegistry; }
}

async function registryPlugin(fastify: FastifyInstance): Promise<void> {
  const registry = new UserRegistry();
  registry.load(config.USERS_FILE);

  const watcher = fs.watch(config.USERS_FILE, () => {
    try { registry.load(config.USERS_FILE); }
    catch { fastify.log.error('users.json parse failed — keeping previous registry'); }
  });

  fastify.decorate('registry', registry);
  fastify.addHook('onClose', async () => watcher.close());
}
export default fp(registryPlugin, { name: 'registry' });
```

### Pattern 2: Request-Scoped User Context via Modified Auth Plugin

**What:** Auth plugin now does a registry lookup on every request. On success, attaches user context to `request`. Downstream plugins (vault, embedder, search service) read from `request.user` rather than from process-level config.

**When to use:** Every authenticated request. Health/readiness routes skip auth (unchanged from v1.0).

**Trade-offs:**
- VaultManager construction per-request: VaultManager is a thin path-resolver (no I/O at construction time). Cost is negligible.
- Embedder per-request: OpenAIEmbeddingProvider construction is also cheap. Cache at plugin level keyed by apiKey if profiling reveals overhead.

```typescript
// src/plugins/auth.ts (modified)
declare module 'fastify' {
  interface FastifyRequest { user: UserRecord; }
}

fastify.addHook('onRequest', async (request, reply) => {
  if (request.routeOptions.config?.skipAuth) return;
  const token = extractBearerToken(request.headers.authorization);
  const user = fastify.registry.lookup(token ?? '');
  if (!user) {
    return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
  }
  request.user = user;
});
```

### Pattern 3: Per-User Indexer Map with Start/Stop Lifecycle

**What:** The indexer plugin maintains a `Map<userId, VaultIndexer>`. On startup (`onReady`), start one poller per user in the registry. Registry hot-reload triggers start/stop of individual pollers when users are added/removed.

**When to use:** This is the core multi-tenant indexing pattern. Each user's vault is polled independently.

**Trade-offs:**
- Memory: each VaultIndexer holds a poll timer and in-memory file state (~1KB per indexed file, so ~5MB for 5000 files per user). Acceptable for single-digit user counts.
- SQLite: each user gets their own SQLite DB file (`{userId}/index.db`). No cross-user contention.

```typescript
// src/plugins/indexer.ts (modified)
declare module 'fastify' {
  interface FastifyInstance { indexers: Map<string, VaultIndexer>; }
}

// On registry hot-reload: start new indexers, stop removed ones
registry.on('change', (added: UserRecord[], removed: UserRecord[]) => {
  for (const user of added) { startIndexer(user); }
  for (const user of removed) { stopIndexer(user.userId); }
});
```

### Pattern 4: Per-User obsidian-headless Child Processes (CLI-Managed)

**What:** The CLI's `docker-start` command spawns one `ob sync --continuous` process per user, then starts the Fastify server. Each sync process writes to the user's vault directory. The Fastify pollers detect these writes.

**When to use:** `docker-start` is the container entrypoint command. Individual `add-user` / `remove-user` commands do not spawn processes — they only update `users.json`. The running container re-reads the registry; sync processes must be restarted separately or the container restarted.

**Trade-offs:**
- obsidian-headless stores credentials in its own config dir (`--config-dir`). The CLI's `add-user` command runs `ob login` and `ob sync-setup` interactively (or with `--email`/`--password` flags for scripted use). Credentials persist to disk in the data dir.
- Child process failures: if `ob sync` exits (network loss, bad credentials), the container does not die. `docker-start` should restart failed sync processes with exponential backoff.
- Sync latency: obsidian-headless syncs over WebSocket; typical latency is seconds. The FS poller detects changes within its poll interval (default 5s). End-to-end sync → indexed latency is `sync_latency + poll_interval`. Acceptable for the use case.

```typescript
// src/lib/sync-manager.ts
export class SyncManager {
  private processes = new Map<string, ChildProcess>();

  start(user: UserRecord): void {
    const proc = spawn('ob', ['sync', '--continuous',
      '--config-dir', `${dataDir}/${user.userId}/.ob-config`,
      '--vault', user.vaultPath,
    ], { stdio: 'pipe' });
    this.processes.set(user.userId, proc);
    // restart on exit with backoff
  }

  stop(userId: string): void {
    this.processes.get(userId)?.kill('SIGTERM');
    this.processes.delete(userId);
  }
}
```

---

## Data Flow

### Request Flow (v2.0)

```
Agent: Bearer <api-key> → POST /api/vault/search
    ↓
Auth Plugin (MODIFIED)
  registry.lookup(apiKey) → UserRecord { userId, vaultPath, openaiKey }
  request.user = userRecord
    ↓
Search Route Handler
  new VaultManager(request.user.vaultPath)           ← per-request vault
  new OpenAIEmbeddingProvider(request.user.openaiKey) ← per-request embedder
  filter: { must: [{ key: 'user_id', match: request.user.userId }] }
    ↓
Qdrant (single 'cognivault' collection)
  user_id payload filter applied — returns only this user's vectors
    ↓
Response
```

### Indexing Flow (v2.0)

```
obsidian-headless (user-a) writes file → /data/user-a/vault/note.md
    ↓
VaultIndexer[user-a] poll cycle detects content hash change
    ↓
FileChangeEvent emitted (path, type, hash)
    ↓
PQueue[user-a] picks up event
    ↓
chunkMarkdown() → chunks[]
    ↓
OpenAIEmbeddingProvider(user-a.openaiKey).embed(chunks)
    ↓
qdrant.upsert('cognivault', {
  points: [{ payload: { user_id: 'user-a', path: '...', ... } }]
})
    ↓
SQLite[user-a/index.db] updated
```

### Registry Hot-Reload Flow

```
CLI: cogvault add-user --email x@x.com --vault "My Vault" --openai-key sk-...
    ↓
ob login --email x@x.com --password ... --config-dir /data/{userId}/.ob-config
    ↓
ob sync-setup --config-dir /data/{userId}/.ob-config --vault "My Vault"
    ↓
Write users.json atomically (tmp file + rename)
    ↓
fs.watch fires in Fastify process (within ~1s)
    ↓
UserRegistry.load() rebuilds in-memory map
    ↓
New VaultIndexer started for new user
New PQueue created for new user
```

### Key Data Flows

1. **Auth → Request context:** Every authenticated request resolves apiKey → UserRecord in-memory. No DB lookup, no I/O. O(1) hash map.

2. **Registry hot-reload → indexer lifecycle:** UserRegistry emits an EventEmitter event on change. The indexer plugin listens and starts/stops VaultIndexers. No restart required.

3. **Qdrant tenant isolation:** Single collection `cognivault`. All upserts include `user_id` payload. All searches include `{ key: 'user_id', match: userId }` filter. The `user_id` payload index must be created at collection setup.

4. **Per-user SQLite:** Each user's `indexed_files` table is in their own DB file. No schema changes needed — existing `indexed_files` table works per-user as-is.

---

## New vs Modified Components (Explicit)

### Purely New (build from scratch)

| Component | File | Notes |
|-----------|------|-------|
| UserRegistry class | `src/lib/user-registry.ts` | In-memory map, `load()`, `lookup()`, EventEmitter for changes |
| Registry Fastify plugin | `src/plugins/registry.ts` | Wraps UserRegistry, adds `fs.watch`, decorates `fastify.registry` |
| SyncManager | `src/lib/sync-manager.ts` | spawn/kill/restart obsidian-headless child processes |
| CLI entry point | `src/cli/index.ts` | Commander.js `program`, registered in `package.json` bin |
| `add-user` command | `src/cli/commands/add-user.ts` | Runs `ob login`, `ob sync-setup`, writes users.json |
| `remove-user` command | `src/cli/commands/remove-user.ts` | Removes from users.json, kills sync process |
| `list-users` command | `src/cli/commands/list-users.ts` | Table output of registry |
| `docker-start` command | `src/cli/commands/docker-start.ts` | Spawns all sync processes, then starts Fastify |
| Registry file schema | `src/cli/registry-file.ts` | Zod schema for users.json, read/write with atomic rename |

### Modified (existing files that need changes)

| Component | File | What Changes |
|-----------|------|-------------|
| Config | `src/config.ts` | Remove: `COGNIVAULT_API_KEY`, `VAULT_PATH`, `OPENAI_API_KEY` (required). Add: `USERS_FILE` (path to users.json), keep `COGNIVAULT_DATA_DIR`. |
| Auth plugin | `src/plugins/auth.ts` | Replace `@fastify/bearer-auth` key set with `fastify.registry.lookup()`. Attach `request.user`. Drop `@fastify/bearer-auth` dep. |
| Vault plugin | `src/plugins/vault.ts` | Remove single VaultManager decoration. Export `createVaultManager(vaultPath)` factory used per-request in routes. |
| Embedder plugin | `src/plugins/embedding.ts` | Remove single provider decoration. Export `createEmbedder(openaiKey)` factory, cached per-userId in a Map on the plugin. |
| Indexer plugin | `src/plugins/indexer.ts` | Replace single `fastify.indexer` with `fastify.indexers: Map<userId, VaultIndexer>`. Start all on `onReady`. |
| Pipeline plugin | `src/plugins/pipeline.ts` | Replace single queue/listener with per-user queues. Each queue uses per-user embedder from registry. |
| DB plugin | `src/plugins/db.ts` | Replace single `index.db` with `{userId}/index.db` per user. `fastify.dbs: Map<userId, BetterSQLite3Database>`. |
| Qdrant plugin | `src/plugins/qdrant.ts` | Add `user_id` keyword payload index at collection setup (idempotent). |
| Metrics plugin | `src/plugins/metrics.ts` | Wire `user_id` label from `request.user.userId` in counters/histograms already defined with label names. |
| Search service | `src/features/search/service.ts` | Accept `userId` parameter, add to Qdrant `must` filter. |
| Context routes | `src/features/context/routes.ts` | Pass `request.user.userId` to search service. |
| Admin routes | `src/features/admin/routes.ts` | Reindex operations scoped to `request.user` (vault path + DB). |
| Dockerfile | `Dockerfile` | Change base from `linuxserver/obsidian` to `node:22-slim`. Add `obsidian-headless` npm install. |
| docker-compose.yml | `docker-compose.yml` | Rewrite: single CogniVault container + Qdrant + Prometheus + Grafana. Remove per-user container model. |
| .env.example | `.env.example` | Remove per-user API key env vars. Add `USERS_FILE`. |

### Unchanged (explicitly out of scope for v2.0)

- Chunking logic (`src/lib/chunker.ts`, `src/lib/pdf-chunker.ts`, etc.)
- VaultManager class itself (`src/lib/vault.ts`) — just the plugin wrapper changes
- Retrieval logic in search/context services (only userId filter added)
- Qdrant collection schema (adding user_id index is additive, non-breaking)
- TOON plugin, Swagger plugin, error handler, health routes
- Feature route schemas (TypeBox schemas unchanged)
- Grafana dashboards (user_id label was already designed in)

---

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| obsidian-headless (`ob`) | Child process via `node:child_process.spawn` | CLI spawns per-user; `ob sync --continuous` runs indefinitely. Requires `obsidian-headless` npm package installed globally or in node_modules. Credentials stored in `--config-dir`. |
| Qdrant | Single QdrantClient (unchanged) | All queries add `user_id` filter. Collection setup adds `user_id` keyword index on first run. |
| OpenAI API | Per-user `OpenAIEmbeddingProvider` instances | Constructed from `request.user.openaiKey`. Cached per userId in a Map on the embedder plugin to avoid construction overhead. |
| SQLite | Per-user `better-sqlite3` database | Path: `COGNIVAULT_DATA_DIR/{userId}/index.db`. Existing schema works unchanged. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| CLI ↔ API server | File system (`users.json`) | CLI writes; server reads via `fs.watch`. No IPC. CLI does not call the API. |
| Auth plugin ↔ UserRegistry | Direct method call | `fastify.registry.lookup(token)` — O(1), synchronous, no async. |
| Indexer plugin ↔ UserRegistry | EventEmitter | Registry emits `'user-added'` / `'user-removed'` events. Indexer plugin subscribes to start/stop individual pollers. |
| Pipeline plugin ↔ VaultIndexer | Node EventEmitter `'changes'` event | Unchanged from v1.0. Per-user pipeline subscribes to per-user indexer. |
| Route handlers ↔ UserRecord | `request.user` | Set by auth plugin, read by vault/embedder/search. Type-augmented via `declare module 'fastify'`. |
| SyncManager ↔ obsidian-headless | `stdin`/`stdout`/`stderr` pipes + exit events | Log stdout/stderr per-user. Restart on non-zero exit with exponential backoff. |

---

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1-5 users | Current design — single process, all in-memory, single node:22-slim container. No changes needed. |
| 6-20 users | Monitor memory (5MB index state per user at 5K notes). If event loop lag increases, move indexing to worker threads. SQLite per-user is still fine. |
| 20+ users | Per-user SQLite becomes many open file handles. Pool them or switch to single multi-tenant SQLite with `user_id` column. This is a schema migration, not an architecture change. |

**First bottleneck at scale:** Memory from per-user VaultIndexer instances (file state maps). At 10 users × 5000 notes × ~200 bytes state, that is ~10MB — well within container limits. Not a real concern for the target user count.

**Second bottleneck:** OpenAI API rate limits. Each user has their own API key, so rate limits are per-user. This design naturally sidesteps the shared-key rate limit problem.

---

## Anti-Patterns

### Anti-Pattern 1: Per-User Containers (Phase 16 approach, now superseded)

**What people do:** Run one Docker container per user (linuxserver/obsidian + CogniVault via s6-overlay, as built in Phase 16).
**Why it's wrong:** Resource overhead scales linearly: each container has its own Node.js process, its own Qdrant connection pool, and its own monitoring overhead. Managing 5 containers is 5x the ops burden. The s6-overlay + linuxserver/obsidian base adds 2GB+ per container for VNC support that is no longer needed.
**Do this instead:** Single CogniVault container with registry-based multi-tenancy. obsidian-headless replaces the need for Obsidian GUI and VNC.

### Anti-Pattern 2: Reading users.json on Every Request

**What people do:** Open and parse `users.json` on every authenticated request for "freshness."
**Why it's wrong:** Synchronous file I/O on every request will block the event loop and add 1-5ms to every request. At 3 concurrent agents this becomes a bottleneck.
**Do this instead:** Load users.json once into an in-memory Map at startup. Use `fs.watch` for hot-reload. Auth is O(1) map lookup.

### Anti-Pattern 3: Sharing a Single OpenAI API Key Across Users

**What people do:** Use the operator's single `OPENAI_API_KEY` for all user embeddings.
**Why it's wrong:** Rate limits are shared; heavy vault indexing for one user degrades embedding quality for others. Billing is unattributable. One compromised user can exhaust the operator's quota.
**Do this instead:** Per-user OpenAI keys stored in the registry. Each user's indexing pipeline uses their own key.

### Anti-Pattern 4: Blocking the API on obsidian-headless Sync Completion

**What people do:** Wait for `ob sync` to finish before starting Fastify on first boot.
**Why it's wrong:** Initial sync of a large vault (5000 notes) can take minutes. The API should be available immediately; the indexer will catch up asynchronously.
**Do this instead:** Start obsidian-headless processes and Fastify concurrently. The FS poller will detect files as they sync. Search results improve gradually as indexing completes.

### Anti-Pattern 5: Global `fastify.vault` and `fastify.embedder` Decorations for Multi-User

**What people do:** Keep `fastify.vault` and `fastify.embedder` as single-user decorations and try to swap them per-request via plugin options.
**Why it's wrong:** Fastify decorations are process-level singletons. Mutating them per-request creates race conditions under concurrent requests.
**Do this instead:** Remove vault and embedder from `FastifyInstance` decoration. Construct them per-request from `request.user` context (or cache per-userId in a registry-managed Map). Pass them explicitly to service constructors.

---

## Build Order (Dependency-First)

The dependency graph for v2.0 is:

```
UserRegistry (lib) ← no deps, pure class
    ↓
Registry Plugin ← depends on UserRegistry + config (USERS_FILE)
    ↓
Auth Plugin (modified) ← depends on Registry Plugin
    ↓
Config (modified) ← prerequisite for everything, modify first
    ↓
Per-user DB Plugin ← depends on Registry (to know all userIds)
    ↓
Per-user Vault Plugin ← per-request, depends on Auth (request.user)
Per-user Embedder Plugin ← per-request, depends on Auth (request.user)
    ↓
Per-user Indexer Plugin ← depends on Registry, DB, Vault
Per-user Pipeline Plugin ← depends on Indexer, Embedder, Qdrant
    ↓
Route modifications (search, context, admin) ← depends on Auth, Vault, Embedder
    ↓
CLI (add-user, remove-user, list-users, docker-start) ← depends on UserRegistry schema
    ↓
Dockerfile + docker-compose.yml rewrite ← depends on CLI entry point existing
    ↓
Integration tests (multi-tenant auth, cross-user isolation) ← depends on all above
```

**Recommended phase structure for v2.0 roadmap:**

| Phase | Content | Why This Order |
|-------|---------|----------------|
| 1 | Config schema changes + UserRegistry class + Registry plugin | Everything else depends on the registry data model. Establish the contract first. |
| 2 | Modified Auth plugin + request.user type augmentation | Auth is the most cross-cutting change. All features depend on `request.user` being available. |
| 3 | Per-user DB plugin + per-user Indexer + per-user Pipeline | The indexing stack must be validated per-user before wiring to routes. |
| 4 | Per-user Vault + Embedder per-request + Route modifications | Search and context routes are the API surface agents use. Validate tenant isolation. |
| 5 | CLI (Commander.js) + obsidian-headless integration + SyncManager | CLI depends on the server-side registry format being finalized. Headless sync is the delivery mechanism. |
| 6 | Dockerfile rewrite (node:22-slim) + docker-compose rewrite + integration tests | Deployment layer comes last; tests prove end-to-end isolation. |

---

## Sources

- CogniVault v1.0 source code (read directly, March 2026) — `src/plugins/auth.ts`, `src/plugins/indexer.ts`, `src/plugins/pipeline.ts`, `src/plugins/embedding.ts`, `src/plugins/db.ts`, `src/config.ts`
- [obsidian-headless GitHub](https://github.com/obsidianmd/obsidian-headless) — credential flags (`--email`, `--password`), `--config-dir`, `--continuous` mode (HIGH confidence, official Obsidian repo)
- [Commander.js GitHub](https://github.com/tj/commander.js) — CLI framework for Node.js (HIGH confidence)
- [Fastify plugin system docs](https://fastify.dev/docs/latest/Reference/Plugins/) — `fp()` dependency declarations, `fastify.decorate()` patterns (HIGH confidence)
- Qdrant multitenancy guide — single collection with payload-based tenant isolation (already verified in v1.0 ARCHITECTURE.md, unchanged for v2.0)
- Node.js `fs.watch` docs — hot-reload mechanism (HIGH confidence, built-in)
- `.planning/PROJECT.md` — v2.0 milestone scope, out-of-scope decisions (per-user containers, VNC/GUI access, Caddy proxy)

---

*Architecture research for: CogniVault v2.0 multi-tenant*
*Researched: 2026-03-14*
