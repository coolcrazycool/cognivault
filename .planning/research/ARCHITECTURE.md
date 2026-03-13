# Architecture Research

**Domain:** Multi-user CogniVault deployment — per-user CogniVault+Obsidian containers with shared infrastructure
**Researched:** 2026-03-13
**Confidence:** HIGH (official Qdrant docs + linuxserver/obsidian confirmed; VNC routing patterns MEDIUM; compose templating MEDIUM)

---

## What Changed From v1.0

This is an additive milestone. The existing Fastify monolith, Qdrant collection, SQLite schema, and Docker Compose stack are all preserved. New components are inserted around and above the existing service, not replacing it.

**v1.0 architecture that stays unchanged:**
- Fastify feature plugin structure (`src/features/`, `src/plugins/`)
- Single Qdrant collection `cognivault` with payload-based filtering
- SQLite for index state (per-container, already isolated by volume)
- Prometheus + Grafana stack
- All existing REST endpoints

**v2.0 adds:**
- N user containers (each = CogniVault + Obsidian + VNC via linuxserver image)
- A management layer (CLI + new Fastify feature module) for user lifecycle
- Auth plugin upgrade: static env key → SQLite lookup against a user registry
- Prometheus scrape config upgrade: static target → file-based service discovery
- Caddy reverse proxy for VNC routing (new shared service)
- A generated `docker-compose.users.yml` managed by `cognivault-ctl`

---

## System Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            Shared Infrastructure                              │
│                                                                               │
│  ┌─────────────────┐   ┌─────────────────┐   ┌───────────────────────────┐  │
│  │    Caddy        │   │   Prometheus     │   │       Grafana             │  │
│  │  (VNC proxy)    │   │  (scrapes all)   │   │  (per-user dashboards)    │  │
│  │  port 7900+     │   │   port 9090      │   │      port 3001            │  │
│  └────────┬────────┘   └────────┬─────────┘   └───────────────────────────┘  │
│           │                    │                                              │
│  ┌────────┴────────────────────┴───────────────────┐                         │
│  │              Docker bridge network (cognivault)  │                         │
│  └──────────────────────────────────────────────────┘                         │
│                                                                               │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │  Qdrant (shared, single instance)  port 6333                          │   │
│  │  Collection: "cognivault"  (one collection, per-user tenant filter)   │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────┐   ┌─────────────────────────────┐
│      User: alice            │   │      User: bob              │
│                             │   │                             │
│  ┌──────────────────────┐  │   │  ┌──────────────────────┐  │
│  │  linuxserver/obsidian │  │   │  │  linuxserver/obsidian │  │
│  │  (Obsidian + desktop) │  │   │  │  (Obsidian + desktop) │  │
│  │  internal port 3000   │  │   │  │  internal port 3000   │  │
│  └──────────────────────┘  │   │  └──────────────────────┘  │
│            │               │   │            │               │
│  ┌─────────┴────────────┐  │   │  ┌─────────┴────────────┐  │
│  │   CogniVault API      │  │   │  │   CogniVault API      │  │
│  │   (existing Fastify)  │  │   │  │   (existing Fastify)  │  │
│  │   port 3000           │  │   │  │   port 3000           │  │
│  │   TENANT_ID=alice     │  │   │  │   TENANT_ID=bob       │  │
│  └──────────────────────┘  │   │  └──────────────────────┘  │
│            │               │   │            │               │
│  ┌─────────┴────────────┐  │   │  ┌─────────┴────────────┐  │
│  │  SQLite (per-user)    │  │   │  │  SQLite (per-user)    │  │
│  │  vault: bind mount    │  │   │  │  vault: bind mount    │  │
│  └──────────────────────┘  │   │  └──────────────────────┘  │
└─────────────────────────────┘   └─────────────────────────────┘
```

---

## Component Responsibilities (New + Modified)

| Component | New/Modified | Responsibility | Communicates With |
|-----------|-------------|----------------|-------------------|
| **cognivault-ctl** | NEW | Management CLI: user lifecycle (add/remove/list), generates compose fragment | Docker Compose, user registry SQLite |
| **User Registry** | NEW | Per-user API key → tenant_id mapping, SQLite file in shared data volume | Auth plugin |
| **Auth plugin** | MODIFIED | Replace static env key lookup with DB lookup; attach `tenant_id` to request context | User registry SQLite |
| **linuxserver/obsidian container** | NEW | Obsidian desktop + VNC/browser access for vault editing; s6-overlay process manager | Vault volume (shared with CogniVault) |
| **Caddy (VNC proxy)** | NEW | Routes `/vnc/{username}/` path or `{username}.host` subdomain to per-user Obsidian VNC port | linuxserver/obsidian containers |
| **Prometheus scrape config** | MODIFIED | File-based service discovery reads generated target list; adds `tenant_id` label to all metrics | All CogniVault containers |
| **Qdrant plugin** | MODIFIED | Add `user_id` payload index with `is_tenant: true`; all search/index operations pre-filter by tenant | Qdrant shared instance |
| **docker-compose.users.yml** | NEW | Generated file with one service block per user; `cognivault-ctl` writes it | Docker Compose `--file` merge |

---

## Decision 1: Qdrant — Single Collection with Payload Tenant Isolation

**Recommendation: Single collection `cognivault`, add `user_id` payload index with `is_tenant: true`.**

The existing `cognivault` collection already uses payload filtering by `path`, `tags`, `project`, etc. Adding `user_id` as a tenant field is additive — no data migration needed for the first user (existing data gets `user_id: "alice"` or whatever the first user is named).

**Configuration change to `src/plugins/qdrant.ts`:**

```typescript
// Add to PAYLOAD_INDEXES
{ field: 'user_id', type: 'keyword', isTenant: true },
```

The `is_tenant: true` flag (available in Qdrant ≥ v1.11.0; current deployed version is v1.17.0) co-locates vectors from the same tenant in storage, which improves sequential read performance for per-tenant queries. Queries with a tenant filter become _faster_ than unfiltered queries at this scale.

**Why not separate collections per user:**
- Each Qdrant collection has its own HNSW graph, optimizer threads, and WAL
- At 2-10 users with 5,000 notes each (max ~50K vectors/user), a single collection with `is_tenant: true` provides equivalent isolation with ~60-80% less memory overhead
- Qdrant's tiered multitenancy (v1.16+) allows promoting a large user to a dedicated shard if they exceed 20K vectors — this is an operational knob, not a redesign
- Already in v1.0 ARCHITECTURE.md as recommended pattern; this confirms it applies to the user dimension too

**Upgrade path for existing collection:**
```
1. Deploy cognivault-ctl add alice (first user)
2. Run migration that sets user_id="alice" on all existing Qdrant points (batch upsert of payload only, no re-embedding)
3. Create payload index on user_id with is_tenant: true
4. All subsequent CogniVault containers set TENANT_ID env var; all qdrant calls filter by it
```

---

## Decision 2: Obsidian Container — Use linuxserver/obsidian

**Recommendation: `lscr.io/linuxserver/obsidian:latest` as the Obsidian sidecar.**

The linuxserver/obsidian image is the canonical choice: actively maintained (as of 2026), based on Debian Trixie, uses s6-overlay for process supervision, and exposes browser-accessible VNC via Selkies (WebRTC/WebSocket). It runs Obsidian inside Openbox (X11) or Labwc (Wayland).

**Key facts:**
- Exposes port 3000 (HTTP, must be proxied) and port 3001 (HTTPS self-signed)
- Process manager is s6-overlay — Obsidian, Openbox/Labwc, display server, and the Selkies WebSocket server all run as supervised s6 services
- Requires `--shm-size="1gb"` (Electron uses shared memory heavily)
- Environment: `PUID`/`PGID` for filesystem permission, `CUSTOM_USER`/`PASSWORD` for HTTP basic auth on VNC
- Vault bind-mount: same host path as the CogniVault container's vault volume → shared read/write access to the vault from both containers

**Alternative considered: obsidian-remote (sytone)**
- Browser-based access via noVNC
- Less actively maintained than linuxserver; doesn't use s6-overlay
- No Selkies (newer WebRTC transport)
- Reject: linuxserver has better maintenance, ARM64 support, and Wayland path

**Process management inside the container:** s6-overlay (already used by linuxserver). No need to choose supervisord — the base image decides this. CogniVault does not run inside the Obsidian container; they are separate containers sharing a vault volume.

---

## Decision 3: CogniVault + Obsidian — Separate Containers, Not a Combined Image

**Recommendation: Two containers per user, sharing a vault volume.**

Running Obsidian and CogniVault in a single container via supervisord/s6-overlay was considered. Rejected because:

1. **linuxserver/obsidian already owns s6-overlay** — adding Node.js as an s6 service inside that image requires forking the linuxserver base, which means maintaining a custom Dockerfile that chases upstream linuxserver updates
2. **Independent scaling** — CogniVault crashes should not restart Obsidian and vice versa
3. **Container sizing** — Electron (Obsidian) requires `--shm-size=1gb`; CogniVault needs none of that
4. **Docker Compose native** — two named containers in a compose service group is idiomatic; one multi-process container fighting with an upstream base is not
5. **Image upgrades** — `docker pull lscr.io/linuxserver/obsidian:latest` remains clean; CogniVault image is built from the project Dockerfile independently

The two containers share a single named volume per user:
```
volumes:
  alice_vault:  # bind mount on host at ${VAULT_DIR}/alice
```

Both containers mount it:
- `linuxserver/obsidian`: `/config/Desktop/Vault` (or wherever Obsidian expects)
- `cognivault-alice`: `/vault` (existing convention)

---

## Decision 4: SQLite — Per-User Database Files

**Recommendation: Keep SQLite per-container (one DB file per user), not a shared DB.**

Rationale:
- v1.0 already does this: `COGNIVAULT_DATA_DIR=/data` with a named volume `cognivault_data`. In the multi-user world, each user container gets `alice_data`, `bob_data`, etc.
- SQLite's single-writer lock becomes a bottleneck only when multiple processes contend on the same file. Per-container means no contention.
- Per-user DB isolation is operationally superior: backup Alice's index state without touching Bob's
- The FTS5 full-text search index lives in SQLite — per-container means no cross-tenant leakage risk
- Shared SQLite across containers would require WAL + a volume shared across containers + careful connection management. Not worth it for N < 20 users.

**No schema changes needed.** The existing SQLite schema is already scoped to one vault. Multi-user is achieved by running N instances, each with their own DB file.

---

## Decision 5: Docker Compose Templating — CLI-Generated Fragment File

**Recommendation: `cognivault-ctl` generates a `docker-compose.users.yml` fragment that is merged at runtime.**

Docker Compose natively supports multiple `-f` flags:
```bash
docker compose -f docker-compose.yml -f docker-compose.users.yml up -d
```

The base `docker-compose.yml` contains shared services (Qdrant, Prometheus, Grafana, Caddy). `cognivault-ctl add alice` appends user blocks to `docker-compose.users.yml`. `cognivault-ctl remove bob` removes them. The file is committed to the repo or stored at a well-known path.

**Why not Jinja2 / Docker-Compose-Templer:**
- Adds a Python dependency for what is essentially "loop over users and emit YAML"
- `cognivault-ctl` is a Node.js CLI (same ecosystem as the project); it can emit YAML directly with the `js-yaml` package
- Jinja2-based tools are designed for static generation; the CLI approach allows dynamic add/remove without regenerating the entire file

**Why not `--scale`:**
- `docker compose --scale cognivault=3` requires all instances to be identical (same env vars, same vault). Multi-user requires different env vars (API key, vault path, tenant ID) per instance.

**Generated fragment structure:**
```yaml
# AUTO-GENERATED by cognivault-ctl — do not edit manually
# Run: cognivault-ctl add <username> or cognivault-ctl remove <username>
services:
  cognivault-alice:
    image: cognivault:latest
    environment:
      - COGNIVAULT_API_KEY=${ALICE_API_KEY}
      - TENANT_ID=alice
      - VAULT_PATH=/vault
      - QDRANT_URL=http://qdrant:6333
    volumes:
      - alice_vault:/vault:ro
      - alice_data:/data
    labels:
      - "prometheus.io/scrape=true"
      - "prometheus.io/port=3000"
      - "cognivault.tenant=alice"
    depends_on:
      qdrant:
        condition: service_healthy
    networks:
      - cognivault

  obsidian-alice:
    image: lscr.io/linuxserver/obsidian:latest
    shm_size: "1gb"
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/Moscow
      - CUSTOM_USER=alice
      - PASSWORD=${ALICE_VNC_PASSWORD}
    volumes:
      - alice_vault:/config/Desktop/Vault
    networks:
      - cognivault
    # No direct host port — Caddy proxies VNC access

volumes:
  alice_vault:
  alice_data:
```

---

## Decision 6: VNC Routing — Caddy Reverse Proxy with Path-Based Routing

**Recommendation: Caddy in the shared infrastructure stack, routing `/vnc/{username}/` to the per-user Obsidian container's port 3000.**

Each `linuxserver/obsidian` container exposes port 3000 (HTTP VNC via Selkies), but is **not** published to the host directly. Caddy handles routing on a single public port (e.g., 7900).

Caddy handles WebSocket upgrades transparently (no special config for the `Upgrade` header — it's automatic). noVNC/Selkies use WebSocket for the VNC stream.

**Caddyfile pattern:**
```
:7900 {
  handle /vnc/alice/* {
    uri strip_prefix /vnc/alice
    reverse_proxy obsidian-alice:3000
  }
  handle /vnc/bob/* {
    uri strip_prefix /vnc/bob
    reverse_proxy obsidian-bob:3000
  }
}
```

`cognivault-ctl add alice` appends a handle block to the Caddyfile and reloads Caddy (`docker exec cognivault-caddy caddy reload`).

**Why Caddy over Nginx:**
- Automatic HTTPS (self-signed or ACME) without additional config
- Caddyfile is significantly simpler than nginx.conf for this pattern
- WebSocket proxying is zero-config in Caddy; Nginx requires explicit `Upgrade` header handling
- `caddy reload` is graceful (no connection drops); `nginx -s reload` can drop active WebSocket connections briefly

**Why path-based over subdomain-based:**
- Subdomains require DNS wildcard (`*.host`) — not available in simple self-hosted setups
- Path-based (`/vnc/alice/`) works on any hostname with zero DNS config
- linuxserver Selkies is designed to be run behind a path prefix proxy

**Alternative considered: Websockify token plugin**
- Websockify `--token-plugin TokenFile` can route a single WebSocket endpoint to multiple VNC backends by token
- But linuxserver/obsidian uses Selkies (WebRTC + WebSocket transport), not bare VNC. Websockify sits below the noVNC layer; it can't proxy Selkies' HTTP+WebSocket bundle cleanly
- Reject: Caddy proxy is simpler, more general, handles full HTTP context (not just TCP tunnel)

---

## Decision 7: Auth Plugin — Static Key → User Registry SQLite Lookup

**Recommendation: Replace `@fastify/bearer-auth` static key set with a custom `onRequest` hook that queries a shared user registry.**

Current auth plugin (`src/plugins/auth.ts`):
```typescript
keys: new Set([config.COGNIVAULT_API_KEY])
```

This is a single static key from the environment. For multi-user, each CogniVault container runs with its own `COGNIVAULT_API_KEY` env var (set by `cognivault-ctl` at user creation time and stored in the compose fragment). This means **no change to the auth plugin itself** is required for basic multi-user isolation — each container still validates against its own single key.

**However, a user registry is still needed** for the management CLI (`cognivault-ctl`) to:
- Generate and store API keys at user creation time
- Allow key rotation without recreating containers
- Support future multi-key scenarios (agent key + admin key)

**User registry location:** A SQLite file in the **management host path** (not inside any user container), at e.g. `./data/users.db`. `cognivault-ctl` reads/writes it. Individual CogniVault containers do not access it directly — their API key is injected via env var at startup.

**If per-container single key is insufficient** (e.g., key rotation without restart), the auth plugin can be upgraded to query a SQLite user registry mounted as a read-only volume:
```typescript
// Upgraded auth.ts (optional, for key rotation)
const user = await db.prepare(
  'SELECT tenant_id, api_key_hash FROM users WHERE api_key_hash = ?'
).get(sha256(bearerToken));
if (!user) throw new Unauthorized();
request.tenantId = user.tenant_id;
```

**Build order:** Start with the simpler approach (one env var per container, static key). Upgrade to DB lookup only if key rotation without restart is a stated requirement.

**`TENANT_ID` env var on requests:** The tenant ID is known at container startup (it's the username), so it can be injected directly as `config.TENANT_ID` without any DB lookup per request. All Qdrant calls then filter `{ user_id: config.TENANT_ID }`.

---

## Data Flow Changes

### Existing Write Path (unchanged within a user container)

```
Agent → CogniVault API → File Ops → Vault (shared volume)
                                  ↓ (async, via FS Poller)
                         Indexing Pipeline → Qdrant (adds user_id to payload)
                                          → SQLite (per-container)
```

### New: Management CLI Path

```
cognivault-ctl add alice
    ↓
1. Generate API key (random 32 bytes, hex-encoded)
2. Write to users.db: INSERT user (username=alice, api_key, tenant_id=alice, created_at)
3. Append alice services to docker-compose.users.yml
4. Append alice handle block to Caddyfile
5. Add alice scrape target to prometheus/targets/users.json
6. docker compose -f docker-compose.yml -f docker-compose.users.yml up -d cognivault-alice obsidian-alice
7. Print: "alice API key: cv_..., VNC URL: http://host:7900/vnc/alice/"
```

### New: Prometheus Multi-Tenant Scrape

Prometheus file-based service discovery reads `./monitoring/prometheus/targets/users.json` (generated by `cognivault-ctl`):

```json
[
  {
    "targets": ["cognivault-alice:3000"],
    "labels": { "tenant": "alice", "job": "cognivault" }
  },
  {
    "targets": ["cognivault-bob:3000"],
    "labels": { "tenant": "bob", "job": "cognivault" }
  }
]
```

`prometheus.yml` change:
```yaml
# Replace static_configs with file_sd_configs
- job_name: cognivault
  file_sd_configs:
    - files:
        - /etc/prometheus/targets/users.json
      refresh_interval: 30s
```

This avoids restarting Prometheus when users are added/removed — the file is updated by `cognivault-ctl` and Prometheus picks it up within 30s.

Grafana dashboard variables are updated with `{tenant="alice"}` filter selectors, enabling per-user metric views in a single dashboard.

---

## Component Interaction Diagram (New Components)

```
cognivault-ctl (CLI, runs on host)
    │
    ├── writes ──→ users.db (host SQLite, management only)
    ├── writes ──→ docker-compose.users.yml
    ├── writes ──→ Caddyfile (or reload via admin API)
    ├── writes ──→ monitoring/prometheus/targets/users.json
    └── runs  ──→ docker compose ... up -d

Per-user runtime (alice example):
    cognivault-alice ──→ Qdrant (filter user_id=alice)
    cognivault-alice ──→ alice_data (SQLite index state)
    cognivault-alice ──→ alice_vault (read vault files)
    obsidian-alice   ──→ alice_vault (Obsidian writes vault files)
    Caddy            ──→ obsidian-alice:3000 (proxies /vnc/alice/)
    Prometheus       ──→ cognivault-alice:3000/metrics (scrapes with tenant label)
```

---

## New vs Modified Summary

| Component | Change Type | What Changes |
|-----------|-------------|--------------|
| `src/plugins/qdrant.ts` | MODIFIED | Add `user_id` payload index with `is_tenant: true` |
| `src/plugins/auth.ts` | MODIFIED (minor) | Optionally add tenant context attachment; single-key-per-container stays valid for MVP |
| `src/config.ts` | MODIFIED | Add `TENANT_ID` required env var |
| All indexing code | MODIFIED | Pass `user_id: config.TENANT_ID` in all Qdrant payloads and search filters |
| `docker-compose.yml` | MODIFIED | Add Caddy service; change Prometheus to file_sd_configs |
| `docker-compose.users.yml` | NEW | Auto-generated user service definitions |
| `Caddyfile` | NEW | VNC routing per user |
| `monitoring/prometheus/targets/users.json` | NEW | Auto-generated scrape targets |
| `cognivault-ctl` (CLI tool) | NEW | User lifecycle management |
| `users.db` | NEW | Management-layer user registry (host-side only) |
| `src/features/users/` | NEW | Optional: REST API surface for user management (if admin API preferred over CLI-only) |

---

## Suggested Build Order (Dependency Graph)

### Phase 1: Qdrant Tenant Isolation (foundation for all per-user data)

**Goal:** CogniVault instances can run concurrently without data leakage in Qdrant.

1. Add `TENANT_ID` env var to `src/config.ts` (required, no default)
2. Modify `src/plugins/qdrant.ts`: add `user_id` payload index with `is_tenant: true`
3. Thread `TENANT_ID` through all indexing calls (payload upserts get `user_id` field)
4. Thread `TENANT_ID` through all search calls (filter `{ user_id: config.TENANT_ID }`)
5. Write migration script: set `user_id="default"` on all existing Qdrant points

**Rationale:** Every other component depends on this working. Until Qdrant is tenant-aware, running two CogniVault containers would cause one to see the other's search results.

### Phase 2: Docker Compose Multi-User Stack

**Goal:** `docker compose up` brings up N user containers against shared Qdrant and monitoring.

6. Create `docker-compose.users.yml` structure (manual for 1-2 users initially)
7. Add `obsidian-alice` and `obsidian-bob` service blocks using `linuxserver/obsidian`
8. Configure vault volume sharing (both `cognivault-alice` and `obsidian-alice` mount `alice_vault`)
9. Add Caddy service to `docker-compose.yml`
10. Write `Caddyfile` with path-based VNC routing
11. Validate: browser → `http://host:7900/vnc/alice/` → Obsidian desktop

**Rationale:** The compose structure must be validated before building the CLI that generates it.

### Phase 3: Prometheus Multi-Tenant Metrics

**Goal:** Grafana shows per-user metrics without restarting Prometheus.

12. Convert `prometheus.yml` static scrape configs to `file_sd_configs`
13. Create `monitoring/prometheus/targets/users.json` with one entry per user
14. Update Grafana dashboard: add `tenant` variable, filter all panels by `{tenant="$tenant"}`
15. Test: add a new entry to `users.json` and confirm Prometheus discovers it within 30s

### Phase 4: Management CLI (`cognivault-ctl`)

**Goal:** Single command to add/remove users instead of manual file editing.

16. Create `tools/cognivault-ctl/` as a standalone Node.js CLI (or as a script in `package.json`)
17. Implement `cognivault-ctl add <username>`: generates API key, writes compose fragment, Caddyfile block, Prometheus target, runs docker compose up
18. Implement `cognivault-ctl remove <username>`: removes services, stops containers, removes volumes (with confirmation)
19. Implement `cognivault-ctl list`: shows users, their API keys (masked), and container status

### Phase 5: Obsidian Sync Integration (deferred if needed)

20. Mount Obsidian Sync credentials into `obsidian-alice` container (env var or secret file)
21. Validate that Obsidian inside the container connects to Obsidian Sync and the FS Poller detects changes

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: One CogniVault + Obsidian in a Single Container

**What people do:** Combine Obsidian and CogniVault into one Docker image to simplify deployment, running Node.js as an s6 service inside `linuxserver/obsidian`.

**Why it's wrong:** Forces forking the `linuxserver/obsidian` image and chasing upstream s6 service changes. Couples Electron crash/restart to CogniVault uptime. Container sizing conflicts (`--shm-size` for Electron, unnecessary for Node.js API). Independent versioning becomes impossible.

**Do this instead:** Two containers per user, sharing a named vault volume. Docker Compose `depends_on` for startup ordering if needed.

### Anti-Pattern 2: Publishing VNC Ports Directly to Host

**What people do:** Add `ports: "7901:3000"` to each obsidian container for easy access.

**Why it's wrong:** Port numbers must be pre-allocated per user, creating manual bookkeeping. No auth proxy in front of VNC (Caddy provides HTTP basic auth as a backstop). Adding a 5th user requires remembering port 7905. Firewall rules multiply.

**Do this instead:** All Obsidian containers on the internal Docker network, Caddy as the single ingress point with path-based routing. Users access `http://host:7900/vnc/alice/`.

### Anti-Pattern 3: Separate Qdrant Collections Per User

**What people do:** Create `cognivault_alice`, `cognivault_bob` collections so data is "obviously separate."

**Why it's wrong:** Each Qdrant collection creates its own HNSW graph, WAL, and optimizer threads. At 10 users this is a measurable resource drain. Payload filtering with `is_tenant: true` provides equivalent isolation with less overhead. Already documented in v1.0 ARCHITECTURE.md for vault isolation — same reasoning applies to user isolation.

**Do this instead:** Single collection `cognivault`, `user_id` field with `is_tenant: true` index.

### Anti-Pattern 4: Shared SQLite for Index State

**What people do:** Use one SQLite file mounted across all CogniVault containers for "centralized" index state.

**Why it's wrong:** SQLite has one writer at a time. If Alice and Bob both have active indexing pipelines (triggered by FS Poller), they contend on the write lock. This causes `SQLITE_BUSY` errors and retry loops, slowing both users down.

**Do this instead:** Each user container gets its own SQLite volume. State is partitioned by the Docker Compose volume, not by SQL rows.

### Anti-Pattern 5: Hardcoding User Count in docker-compose.yml

**What people do:** Write a static compose file with services `cognivault-alice`, `cognivault-bob`, `cognivault-charlie` and edit it manually.

**Why it's wrong:** Adding user 4 means editing YAML by hand, risking malformed files. Removing a user means manually tracking which volumes to delete. No safety net.

**Do this instead:** `cognivault-ctl` generates the compose fragment. The CLI is the single point of truth for user lifecycle. Manual YAML editing is locked out by convention.

---

## Integration Points: New vs Existing

### Existing Components That Need Code Changes

| File | What Changes | Why |
|------|-------------|-----|
| `src/config.ts` | Add `TENANT_ID: z.string().min(1)` | Every container must declare its tenant |
| `src/plugins/qdrant.ts` | Add `user_id` index with `is_tenant: true`; existing collection migration | Tenant isolation in Qdrant |
| `src/features/*/service.ts` (indexer, search, context) | Pass `user_id: config.TENANT_ID` in all Qdrant operations | Without this, containers cross-contaminate |
| `monitoring/prometheus/prometheus.yml` | Replace `static_configs` with `file_sd_configs` | Dynamic scrape target list |
| `docker-compose.yml` | Add Caddy service | VNC routing |

### New Components

| Component | Path | Depends On |
|-----------|------|-----------|
| Management CLI | `tools/cognivault-ctl/` | users.db, docker-compose.users.yml, Caddyfile |
| User registry | `data/users.db` (host) | cognivault-ctl only |
| Compose fragment | `docker-compose.users.yml` | generated by cognivault-ctl |
| Caddyfile | `caddy/Caddyfile` | generated/updated by cognivault-ctl |
| Prometheus targets | `monitoring/prometheus/targets/users.json` | generated by cognivault-ctl |

---

## Scaling Considerations

| Concern | 2-5 users | 10-20 users | 20+ users |
|---------|-----------|-------------|-----------|
| Qdrant vectors | ~50K-250K total, trivial | ~500K, fine | Consider tiered multitenancy shard promotion |
| Docker Compose services | 2N+4 services, fine | 24-44 services, compose handles it | Consider Docker Swarm or k3s |
| Caddy handle blocks | Trivially small | Small | Fine |
| Prometheus scrape targets | File SD handles dynamically | Fine | Fine |
| SQLite contention | Zero (per-container) | Zero | Zero |
| Host port exposure | 1 (Caddy) | 1 | 1 |
| VNC session performance | CPU: Electron × N | Add dedicated GPU for Selkies encode | Consider Kasm Workspaces |

The target scale (PROJECT.md: 1-3 concurrent agents, self-hosted) means this architecture will not encounter the 20+ user ceiling in the foreseeable future.

---

## Sources

- [Qdrant Multitenancy Guide](https://qdrant.tech/documentation/guides/multitenancy/) — single collection with `is_tenant: true` is official recommendation (HIGH confidence)
- [Qdrant 1.16 Tiered Multitenancy](https://qdrant.tech/blog/qdrant-1.16.x/) — tiered multitenancy and ACORN algorithm details (HIGH confidence)
- [linuxserver/docker-obsidian GitHub](https://github.com/linuxserver/docker-obsidian) — s6-overlay, Selkies base, port layout (HIGH confidence, official repo)
- [LinuxServer.io Obsidian Docs](https://docs.linuxserver.io/images/docker-obsidian/) — environment variables, port mapping, `--shm-size` requirement (HIGH confidence)
- [s6-overlay GitHub](https://github.com/just-containers/s6-overlay) — process supervision for containers, container lifecycle semantics (HIGH confidence)
- [Caddy reverse_proxy directive](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) — WebSocket automatic upgrade, path strip (HIGH confidence)
- [Websockify Token Plugin](https://github.com/novnc/websockify/wiki/Token-based-target-selection) — considered and rejected for VNC routing (MEDIUM confidence)
- [Prometheus file_sd_configs](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#file_sd_config) — dynamic target discovery (HIGH confidence)
- [SQLite per-tenant database pattern](https://turso.tech/blog/give-each-of-your-users-their-own-sqlite-database-b74445f4) — per-user SQLite rationale (MEDIUM confidence, corroborated by SQLite docs on write-lock contention)

---

*Architecture research for: CogniVault v2.0 multi-user deployment*
*Researched: 2026-03-13*
