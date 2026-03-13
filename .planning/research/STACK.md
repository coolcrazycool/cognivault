# Technology Stack

**Project:** CogniVault v2.0 — Multi-User Deployment
**Researched:** 2026-03-13
**Confidence:** HIGH (core recommendations verified against official docs and active sources)

---

> This file covers **new stack additions only** for v2.0 multi-user deployment.
> The v1.0 stack (Fastify 5, TypeBox, Drizzle ORM + SQLite, Qdrant, OpenAI embeddings,
> prom-client, @opentelemetry/sdk, Docker Compose) is validated and unchanged.

---

## New Stack: What Gets Added

### Containerized Obsidian with Browser-Based Access

| Technology | Version | Purpose | Why Recommended | Confidence |
|------------|---------|---------|-----------------|------------|
| `lscr.io/linuxserver/obsidian` | `:latest` | Obsidian desktop in Docker | KasmVNC-based, actively maintained by LinuxServer.io, auto-updated with Obsidian releases, ARM64 + x86-64 support, browser-accessible on ports 3000/3001, per-container credential isolation via `CUSTOM_USER`/`PASSWORD` env vars | HIGH |

**Chosen over `sytone/obsidian-remote`:** obsidian-remote uses KasmVNC too, but last release was October 2022 with limited recent activity. linuxserver/obsidian is actively maintained, updated continuously with new Obsidian versions, and has mature multi-architecture support.

**Chosen over `kasmweb/obsidian`:** Kasm Workspaces image is part of the commercial Kasm platform — heavy dependencies, session management overhead. linuxserver is a standalone container ideal for per-user deployment.

**How browser access works:** KasmVNC streams the Obsidian Electron desktop as video to a browser. Users connect to `https://<host>:3001/` (HTTPS required for WebCodecs). Each container is one user session. Per-user isolation is natural: each user = one container with their own `/config` volume mount and unique `CUSTOM_USER`/`PASSWORD`.

**Critical requirement:** `shm_size: "1gb"` is required — Electron apps (Obsidian) crash without shared memory. This must be set on every Obsidian container.

**Obsidian Sync compatibility:** Obsidian Sync uses the Obsidian client running inside the container to sync. The vault lives at `/config/data/` inside the container (the path Obsidian opens by default). CogniVault mounts the same host path as a read-write bind mount. Sync happens via the running Obsidian instance inside the container — no separate sync daemon needed.

```yaml
# Per-user Obsidian container example
obsidian-user1:
  image: lscr.io/linuxserver/obsidian:latest
  environment:
    - PUID=1000
    - PGID=1000
    - TZ=UTC
    - CUSTOM_USER=user1
    - PASSWORD=<generated>
  volumes:
    - /data/vaults/user1:/config
  ports:
    - "3101:3001"   # HTTPS browser access, per-user port offset
  shm_size: "1gb"
  restart: unless-stopped
```

---

### Qdrant Multi-Tenancy: Payload Filtering (Single Collection)

**Decision: payload-based partitioning with `is_tenant=true` index — NOT collection-per-tenant.**

| Technology | Purpose | Notes | Confidence |
|------------|---------|-------|------------|
| Qdrant 1.17.0 | Shared vector store, per-user data isolation | Same instance already deployed in v1.0 | HIGH |
| `tenant_id` keyword payload field | Isolates user vectors | Add `is_tenant=true` flag on index creation | HIGH |

**Why NOT collection-per-tenant:**
Qdrant explicitly warns against this: "creating a separate collection for each user leads to high costs, performance degradation and cluster instability." Each collection has its own HNSW index overhead. At 10-50 users, this creates 10-50x the index memory footprint for the same total data.

**Why payload filtering:**
- A query with a `tenant_id` payload filter is faster than a full collection scan
- `is_tenant=true` tells Qdrant to build per-tenant sub-indexes, making filtered search faster than global search
- Supports unlimited tenants in a single collection
- Simpler operations: one collection to back up, monitor, and maintain

**Implementation:**
```typescript
// On collection creation, add tenant payload index
await qdrantClient.createPayloadIndex(COLLECTION_NAME, {
  field_name: "tenant_id",
  field_schema: {
    type: "keyword",
    is_tenant: true,   // Critical: enables per-tenant HNSW sub-index
  },
});

// All inserts include tenant_id in payload
await qdrantClient.upsert(COLLECTION_NAME, {
  points: chunks.map(chunk => ({
    id: chunk.id,
    vector: { dense: chunk.embedding, sparse: chunk.sparseVector },
    payload: {
      tenant_id: userId,   // e.g. "user_abc123"
      ...chunk.metadata,
    },
  })),
});

// All queries filter by tenant_id
await qdrantClient.query(COLLECTION_NAME, {
  prefetch: [
    { query: denseVector, using: "dense", filter: { must: [{ key: "tenant_id", match: { value: userId } }] } },
    { query: sparseVector, using: "sparse", filter: { must: [{ key: "tenant_id", match: { value: userId } }] } },
  ],
  query: { fusion: "rrf" },
  filter: { must: [{ key: "tenant_id", match: { value: userId } }] },
});
```

**Migration from v1.0:** The existing collection uses per-vault collection names (one collection per vault). For v2.0, migrate to a single shared collection with `tenant_id` payload. This is a one-time reindex. Existing single-user deployment maps `tenant_id` to the sole user's ID.

**Global HNSW note:** The multitenancy article recommends setting `m: 0` in the collection's HNSW config to disable the global index when using tenant-only queries. This is only beneficial when you never do cross-tenant search (which CogniVault never does). Apply at collection creation time.

---

### Per-User API Key Management

**Decision: Extend existing `@fastify/bearer-auth` pattern with SQLite-backed key-to-user lookup.**

The v1.0 stack uses `@fastify/bearer-auth` with keys from config. For v2.0, keys must map to users (and thus to `tenant_id` for Qdrant filtering).

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Drizzle ORM + better-sqlite3 | Already in stack | API key store | Extend existing SQLite DB with `api_keys` table: `(key_hash, user_id, created_at, label)` | HIGH |
| `node:crypto` built-in | - | Key generation + hashing | `crypto.randomBytes(32).toString('hex')` for key generation; `crypto.createHash('sha256')` for storage — no new dependency | HIGH |
| `@fastify/bearer-auth` | Already in stack | Auth hook | Switch from static config to dynamic lookup via `allowedKeys` function | HIGH |

**`@fastify/bearer-auth` supports dynamic lookup:** Pass an async function instead of a Set. The function receives the key, queries SQLite, and returns true/false. Attach the resolved `userId` to the request via `fastify.decorateRequest('userId', '')`.

```typescript
// api_keys table schema (Drizzle)
export const apiKeys = sqliteTable('api_keys', {
  keyHash: text('key_hash').primaryKey(),   // SHA-256 of the raw key
  userId:  text('user_id').notNull(),
  label:   text('label'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

// Fastify auth hook
fastify.register(bearerAuthPlugin, {
  keys: new Set(),  // not used when addHook is set
  auth: async (key, request) => {
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    const row = db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).get();
    if (!row) return false;
    request.userId = row.userId;   // attach for downstream use
    return true;
  },
});
```

**Why NOT `fastify-api-key` npm package:** The `arkerone/fastify-api-key` plugin uses HMAC signatures (HTTP Signature draft spec) — overkill for this use case and requires clients to sign requests. CogniVault agents use simple Bearer tokens. Implementing directly on `@fastify/bearer-auth` with a custom `auth` function is 20 lines and uses the already-present dependency.

---

### Management CLI (cognivault-ctl)

**Decision: Commander.js 14 with `yaml` package for Docker Compose generation.**

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `commander` | 14.0.x | CLI argument parsing and subcommands | 213M weekly downloads, 0 dependencies, ~180KB install size, full TypeScript + ESM support, v14 is current stable (v15 moves to ESM-only May 2026), git-style subcommands, zero startup overhead | HIGH |
| `yaml` | 2.x | YAML read/write for docker-compose files | Pure TypeScript, actively maintained, `YAML.parse()` + `YAML.stringify()` API, supports comments preservation, minimum TypeScript 5.9 — ideal for generating and updating docker-compose.yml files | HIGH |

**Why Commander over alternatives:**

- **vs Yargs:** Commander has 0 deps vs Yargs' 7 deps + 850KB. For a sysadmin CLI, startup time matters.
- **vs Oclif:** Oclif adds 12MB and 30+ deps. It's designed for Salesforce-scale plugin ecosystems. cognivault-ctl has 5 commands.
- **vs Clipanion (Yarn):** Good but less ecosystem familiarity, better suited for plugin-based CLIs.

**Why `yaml` over `js-yaml`:**
`js-yaml` v4 types (`@types/js-yaml`) were last updated 2+ years ago. The `yaml` package has built-in TypeScript types, active maintenance, comment preservation (important for human-readable compose files), and native `stringify` support.

**CLI command structure:**

```
cognivault-ctl user add <username> [--port-offset <n>]
cognivault-ctl user remove <username>
cognivault-ctl user list
cognivault-ctl compose generate          # writes docker-compose.yml from SQLite user registry
cognivault-ctl compose apply             # runs docker compose up -d
```

**Compose generation approach:** Store user registry in the existing SQLite DB (new `users` table: `user_id`, `username`, `port_offset`, `created_at`). `compose generate` reads all users and builds the docker-compose YAML programmatically using `yaml` package. This avoids maintaining fragile template files.

```typescript
// packages/cognivault-ctl/src/compose.ts
import YAML from 'yaml';

export function generateComposeYaml(users: User[]): string {
  const services: Record<string, unknown> = {
    qdrant: { image: 'qdrant/qdrant:latest', ... },
    prometheus: { ... },
    grafana: { ... },
  };

  for (const user of users) {
    services[`cognivault-${user.username}`] = buildCogniVaultService(user);
    services[`obsidian-${user.username}`] = buildObsidianService(user);
  }

  return YAML.stringify({ services });
}
```

**CLI packaging:** Standalone Node.js script with a `bin` entry in `package.json`. Does NOT need to be a compiled binary — `node cognivault-ctl` or `pnpm exec cognivault-ctl` is sufficient for a sysadmin tool. Add to project's `packages/` directory (pnpm workspace).

---

## Supporting Infrastructure Changes

### Docker Compose Architecture (v2.0)

The v1.0 single-file `docker-compose.yml` becomes a generated file. The architecture expands to:

```
docker-compose.yml (generated by cognivault-ctl compose generate)
├── qdrant           (shared, existing)
├── prometheus       (shared, existing)
├── grafana          (shared, existing)
├── cognivault-user1 (per-user CogniVault instance)
├── obsidian-user1   (per-user Obsidian+KasmVNC)
├── cognivault-user2
├── obsidian-user2
└── ...
```

**Port allocation strategy:** Each user gets a port offset. Base ports:
- CogniVault API: 3000 + offset
- Obsidian HTTPS (KasmVNC): 3001 + (offset * 100)

With 50 users and offset=0 through 49, CogniVault ports 3000-3049, Obsidian ports 3001, 3101, 3201, ... 5901.

**Prometheus per-user metrics:** Each CogniVault instance exposes `/metrics`. Prometheus scrapes all of them. Each CogniVault instance labels its metrics with `user_id="user1"` (via prom-client `defaultLabels`). No stack change needed — just configuration.

### SQLite Schema Additions (v2.0)

```typescript
// users table
export const users = sqliteTable('users', {
  userId:      text('user_id').primaryKey(),       // UUID, used as Qdrant tenant_id
  username:    text('username').notNull().unique(),
  portOffset:  integer('port_offset').notNull().unique(),
  createdAt:   integer('created_at', { mode: 'timestamp' }).notNull(),
});

// api_keys table (replaces single-key config)
export const apiKeys = sqliteTable('api_keys', {
  keyHash:   text('key_hash').primaryKey(),
  userId:    text('user_id').notNull().references(() => users.userId),
  label:     text('label'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
```

---

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Collection-per-user in Qdrant | Official Qdrant docs: causes instability and performance degradation at scale, each collection has HNSW index overhead | Single collection with `tenant_id` payload field + `is_tenant=true` index |
| `sytone/obsidian-remote` Docker image | Last release October 2022, limited recent activity, maintenance unclear | `lscr.io/linuxserver/obsidian` — actively maintained, auto-updated |
| `kasmweb/obsidian` | Commercial Kasm platform image, heavy platform dependencies | `lscr.io/linuxserver/obsidian` — same KasmVNC technology, standalone |
| Oclif CLI framework | 12MB, 30+ dependencies for 5 commands — startup overhead in a sysadmin tool | Commander.js 14 — 0 deps, 180KB, full TypeScript + ESM |
| `fastify-api-key` npm package | HMAC signature scheme (HTTP Signature spec), requires clients to sign requests — incompatible with simple Bearer token pattern agents use | Extend `@fastify/bearer-auth` with custom `auth` function (already in stack) |
| JWT/OAuth for user auth | Overkill — agents authenticate, not humans; no SSO needed | API keys with SQLite lookup |
| `js-yaml` for compose generation | Types stale (2+ years), less active maintenance | `yaml` package — built-in TypeScript types, active, comment preservation |
| Separate VNC sidecar container | Extra container per user for no benefit | KasmVNC is built into `lscr.io/linuxserver/obsidian` |
| Kubernetes / Helm | Deployment target is a single host with Docker Compose | Docker Compose with generated per-user services |

---

## Alternatives Considered

| Category | Recommended | Alternative | When Alternative Makes Sense |
|----------|-------------|-------------|-------------------------------|
| Obsidian Docker image | `lscr.io/linuxserver/obsidian` | `sytone/obsidian-remote` | If you need an older Obsidian version pinned; obsidian-remote uses the same KasmVNC but with less frequent updates |
| Qdrant tenancy | Payload filtering with `is_tenant=true` | Collection per user | Only if you need strict data isolation guarantees for compliance/security reasons AND have a small fixed number of users (<10) |
| Qdrant tenancy | Payload filtering | Tiered multitenancy (Qdrant 1.16+) | If user base grows large (100+) with some power users generating 100x more data than others — promotes large tenants to dedicated shards |
| CLI framework | Commander.js 14 | Yargs | If you need built-in type coercion, typo suggestions, and don't mind 850KB; Yargs is solid for complex argument schemas |
| Compose generation | `yaml` package + programmatic | Handlebars/EJS templates | If compose file needs heavy human customization between uses — templates are more readable for partial edits |

---

## Version Compatibility

| Package | Version | Compatible With | Notes |
|---------|---------|-----------------|-------|
| `lscr.io/linuxserver/obsidian` | `:latest` | Docker Compose v2 | Requires `shm_size: "1gb"` — do not omit |
| `qdrant/qdrant` | `1.17.0` | `@qdrant/js-client-rest` latest | `is_tenant` field on payload index available since 1.12+; `1.17.0` is current stable as of Feb 2026 |
| `commander` | `14.0.x` | Node.js 22, ESM, TypeScript 5.x | v14 is current stable; v15 (ESM-only) expected May 2026 — v14 in maintenance through May 2027 |
| `yaml` | `2.x` | TypeScript 5.9+, ESM and CJS | Built-in types, no `@types/yaml` needed |

---

## Installation (New Dependencies Only)

```bash
# Production — cognivault service
pnpm add yaml  # if not already present for config reading

# CLI package (packages/cognivault-ctl)
pnpm add commander yaml
pnpm add -D @types/node tsx

# No new prod deps for Obsidian containers or Qdrant tenancy
# (Qdrant client already in stack; tenancy is a configuration change)
```

---

## Sources

- [linuxserver/docker-obsidian GitHub](https://github.com/linuxserver/docker-obsidian) — active maintenance, KasmVNC architecture confirmed
- [LinuxServer.io Obsidian docs](https://docs.linuxserver.io/images/docker-obsidian/) — port 3000/3001, `CUSTOM_USER`/`PASSWORD`, `shm_size` requirement, KasmVNC access
- [corelab.tech Obsidian Docker Compose guide (2026)](https://corelab.tech/obsidian/) — `lscr.io/linuxserver/obsidian:latest` recommended in 2026 guide, MEDIUM confidence
- [Qdrant Multitenancy docs](https://qdrant.tech/documentation/guides/multitenancy/) — payload filtering recommendation, `is_tenant=true` flag, collection-per-tenant warning
- [Qdrant multitenancy article](https://qdrant.tech/articles/multitenancy/) — `group_id` field name, HNSW `m=0` recommendation for tenant-only queries
- [Qdrant 1.16 tiered multitenancy](https://qdrant.tech/blog/qdrant-1.16.x/) — tiered multitenancy, tenant promotion mechanism
- [Qdrant releases](https://github.com/qdrant/qdrant/releases) — v1.17.0 is current stable (Feb 2026)
- [commander npm](https://www.npmjs.com/package/commander) — v14.0.x current, 213M weekly downloads, v15 ESM-only May 2026
- [yaml npm](https://www.npmjs.com/package/yaml) — actively maintained, TypeScript 5.9+, `YAML.stringify()` API
- [fastify-api-key GitHub](https://github.com/arkerone/fastify-api-key) — HMAC signature scheme confirmed, not suitable for simple Bearer auth

---
*Stack research for: CogniVault v2.0 multi-user deployment additions*
*Researched: 2026-03-13*
