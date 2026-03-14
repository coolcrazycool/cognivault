# Feature Research

**Domain:** Multi-tenant vault sync + user lifecycle management (v2.0 milestone)
**Researched:** 2026-03-14
**Confidence:** HIGH for multi-tenant routing patterns, MEDIUM for obsidian-headless auth flow (beta tool, limited documentation), HIGH for CLI management patterns

> **Scope:** This file covers ONLY the new features being added in v2.0. It does not re-document the v1.0 features (vault CRUD, hybrid search, context packs, etc.) which are fully shipped and stable. All v2.0 features build on top of the existing codebase.

---

## Existing Foundation (v1.0 — Do Not Rebuild)

The following are already production-complete and must be preserved intact:

- Single-user REST API with API key auth
- Hybrid search (semantic + lexical + RRF fusion)
- Context pack assembly
- Multi-format indexing (MD, PDF, Canvas, Excalidraw, CSV, images)
- Docker deployment with Qdrant sidecar
- Prometheus + Grafana dashboards
- SQLite index state, Qdrant vector store

---

## Feature Landscape (v2.0 — New Features Only)

### Table Stakes (Required for Multi-Tenant to Work)

Features that must exist for v2.0 to be viable. Without these, multi-tenancy breaks.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **API key → user_id registry lookup** | Every multi-tenant system maps credentials to tenants. Without this, there's no routing. | LOW | In-memory map loaded from users.json. O(1) lookup per request. Auth plugin reads map; no DB hit on hot path. |
| **Per-request tenant routing (vault path + Qdrant namespace)** | Each request must land in the correct user's data. Without namespace isolation, users see each other's data. | MEDIUM | Qdrant uses payload filter `user_id` field (is_tenant=true for perf). Vault path derived from registry. Fastify request decorator carries `tenantCtx`. |
| **users.json registry file** | Operator-editable user config is the simplest registry that avoids a new DB dependency. | LOW | JSON file: `{ users: [{ user_id, api_key, vault_name, openai_key, obs_email, obs_password }] }`. Loaded at startup, hot-reloaded on fs.watch change. |
| **Registry hot-reload via fs.watch** | Operators must be able to add/remove users without restarting the server. Restart causes downtime; downtime is unacceptable in production. | LOW | fs.watch (or chokidar) on users.json path. On change event: re-read, validate, swap in-memory map atomically. Log diff (added/removed users). |
| **Per-user OpenAI API key for embeddings** | Embedding costs must be attributed to the user whose vault is being indexed. Shared key conflates costs and exhausts a single quota. | LOW | OpenAI client instantiated per-user at index time using the user's `openai_key` from registry. Not hard — it's constructor injection on the embedding call. |
| **Qdrant per-user namespace via payload field** | Vector isolation prevents cross-tenant data leakage in search results. | MEDIUM | All Qdrant upserts include `user_id` in payload. All queries include `must: [{ key: 'user_id', match: { value } }]`. Collection stays shared (single `cognivault` collection). Create payload index on `user_id` with `is_tenant: true` for Qdrant v1.11+ optimization. |
| **SQLite per-user index state partitioning** | Index state (hash tracking, change detection) must be scoped to each user or they overwrite each other's tracking. | LOW | Add `user_id` column to existing `index_state` table. All queries filter by user_id. No schema redesign — additive migration. |

### Differentiators (Competitive Advantage in Multi-Tenant Context)

Features that go beyond functional correctness and make v2.0 operationally excellent.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **obsidian-headless sync process per user** | Each user gets a continuously-running `ob sync --continuous` process that keeps their vault up-to-date from Obsidian Sync cloud. Operators do not manage sync manually. | HIGH | Most complex new feature. Requires spawn, monitor, restart-on-crash, and auth setup per user. See Process Management section below. |
| **`add-user` CLI command** | Single command provisions a complete user: writes registry entry, runs `ob login`, runs `ob sync-setup`, starts sync process. Operator doesn't need to know internals. | HIGH | Interactive: prompts for Obsidian creds if not provided as flags. Sequence: validate inputs → append to users.json → run `ob login --email --password` → run `ob sync-setup --vault <name> --path <vault_path>` → hot-reload triggers sync process start. |
| **`remove-user` CLI command** | Single command tears down a user: stops sync process, removes registry entry, optionally purges vault data. Clean removal matters for billing and security. | MEDIUM | Sequence: send SIGTERM to sync process → wait for clean exit → remove from users.json → hot-reload triggers deregistration. Optionally: delete Qdrant vectors for user_id, delete SQLite rows, delete vault directory. |
| **`list-users` CLI command** | Operator visibility into who is active, which vaults are syncing, and process health at a glance. | LOW | Output: table of user_id, vault_name, sync process PID, last sync timestamp, process uptime. JSON flag for machine-readable output. |
| **Process health monitoring with auto-restart** | `ob sync --continuous` is a beta tool. It will crash. When it does, data goes stale. Auto-restart keeps sync running without operator intervention. | MEDIUM | Exponential backoff restart (not tight loop). Track consecutive crashes; alert (log ERROR) if crash rate exceeds threshold. Expose process status via `/admin/sync-status` endpoint. |
| **Multi-tenant Prometheus metrics (user_id label)** | Operators need per-user observability. Which user is hammering search? Which vault is slow to index? Per-user labels enable Grafana filtering. | MEDIUM | Add `user_id` label to existing prom-client metrics: request duration, search latency, index events, embedding calls. Grafana dashboard gains user dropdown filter variable. |
| **`/admin/sync-status` endpoint** | Operator-facing REST endpoint showing all sync process states. Complements CLI for programmatic monitoring (alerting, dashboards). | LOW | Returns: `[{ user_id, vault_name, pid, status: running|crashed|starting, uptime_s, restart_count, last_sync_at }]`. Admin-only (API key with admin scope or separate admin token). |

### Anti-Features (Commonly Requested, Explicitly Rejected)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Per-user Docker containers** | Seems like natural isolation unit | Resource explosion: each container needs 2G RAM, 1 CPU. N=10 users = 20G RAM, 10 CPUs. Also rejected in PROJECT.md architectural pivot. Single-container multi-tenant is the explicit decision. | Single Fastify process, per-request tenant routing, Qdrant payload isolation |
| **Separate Qdrant collection per user** | Feels like the most isolated option | Qdrant Cloud limits 1,000 collections per cluster. Creates schema drift risk. Management overhead scales with user count. Official Qdrant docs say "Don't do this at scale." | Single shared collection with `user_id` payload index + `is_tenant: true` optimization |
| **Caddy reverse proxy for multi-tenant routing** | Common in multi-tenant web apps | Overkill for single-host operator deployment. Adds Caddy config maintenance. Single-container multi-tenant doesn't need external routing — tenant is determined by API key, not subdomain. OUT OF SCOPE per PROJECT.md. | API key → user_id in-process routing |
| **Per-user separate databases (SQLite files)** | Each user gets their own SQLite | File proliferation, no atomic cross-user queries, migration coordination nightmare. | Single SQLite with `user_id` column and indexed queries |
| **Obsidian GUI / VNC access** | Per-user container stack (Phase 16, now abandoned) required VNC. | Out of scope after architectural pivot. VNC+GUI was the old approach. obsidian-headless replaces it cleanly. | obsidian-headless `ob sync --continuous` |
| **OAuth / SSO user authentication** | "Real" multi-tenant systems use OAuth | Massive complexity for an operator-managed self-hosted tool. The operator IS the admin. API keys are sufficient. | API key per user, generated by `add-user` CLI, stored in users.json |
| **Automatic user discovery from Obsidian** | "Can't you just read vault list from Obsidian API?" | Obsidian Sync API is not a public API. `ob sync-list-remote` lists vaults but requires interactive auth. Operator must explicitly configure each user. | `add-user` CLI with explicit vault name |
| **Cross-user vault search** | "Can user A search user B's vault?" | Security violation. Multi-tenancy means strict isolation. Never expose cross-tenant data, even to admin users. | Admin can query any single user's vault by authenticating as that user |

---

## Feature Dependencies (v2.0 Specific)

```
[Multi-tenant Routing]
    |--requires--> [users.json Registry]
    |                   |--requires--> [Registry Hot-reload]
    |--requires--> [API key → user_id Lookup]
    |--requires--> [Qdrant user_id Payload Index]
    |--requires--> [SQLite user_id Column Migration]

[obsidian-headless Sync Process]
    |--requires--> [users.json Registry] (reads obs_email, obs_password, vault_name)
    |--requires--> [ob login --email --password] (non-interactive auth)
    |--requires--> [ob sync-setup --vault --path] (one-time per user)
    |--requires--> [Process Manager] (spawn, monitor, restart)
    |--enhances--> [Incremental Indexing] (vault on disk updated by sync, filesystem poller picks up changes)

[CLI: add-user]
    |--requires--> [users.json Registry] (writes to it)
    |--requires--> [obsidian-headless CLI] (runs ob login + ob sync-setup)
    |--triggers--> [Registry Hot-reload] (server picks up new user automatically)
    |--triggers--> [obsidian-headless Sync Process] (new user starts syncing)

[CLI: remove-user]
    |--requires--> [users.json Registry] (removes entry)
    |--requires--> [Process Manager] (stops sync process)
    |--triggers--> [Registry Hot-reload] (server stops routing to removed user)

[CLI: list-users]
    |--requires--> [users.json Registry] (reads entries)
    |--requires--> [Process Manager] (reads process status)
    |--independent-- (read-only, no side effects)

[Process Health Monitoring]
    |--requires--> [Process Manager]
    |--enhances--> [/admin/sync-status endpoint]
    |--enhances--> [Multi-tenant Prometheus Metrics]

[Per-user Prometheus Metrics]
    |--requires--> [Multi-tenant Routing] (user_id available per request)
    |--enhances--> [Grafana Dashboards] (existing dashboards gain user_id filter)

[Per-user OpenAI Keys]
    |--requires--> [users.json Registry] (reads openai_key per user)
    |--requires--> [Multi-tenant Routing] (user context available at embedding time)
```

### Dependency Notes

- **Registry is the keystone dependency:** Every other v2.0 feature reads from users.json. It must be implemented first.
- **ob sync-setup is a one-time operation:** Must run exactly once per user (when `add-user` is called). Running it again for an already-configured vault may fail or create duplicate configs. The process manager just runs `ob sync --continuous`; setup is CLI-only.
- **Hot-reload must be atomic:** If hot-reload fails mid-read (malformed JSON during write), the server must keep the last-good registry, not crash. Read-validate-swap pattern.
- **Qdrant payload index must exist before first user is added:** Creating the index on a populated collection works, but creating it before any data is cheaper. Migration phase must create the `user_id` payload index with `is_tenant: true` before first user is provisioned.
- **SQLite migration is additive:** Adding `user_id` column with NOT NULL DEFAULT '' to existing tables, then backfilling with a known user_id for any legacy data from v1.0 single-user operation.
- **Per-user OpenAI keys do not affect routing:** They only affect which client is used during embedding calls. The routing (API key → user_id) uses CogniVault API keys, not OpenAI keys.

---

## MVP Definition (v2.0 Milestone)

### Launch With (v2.0)

Minimum viable multi-tenant system. Every item is load-bearing.

- [ ] **users.json registry with hot-reload** — fundamental tenant configuration store
- [ ] **API key → user_id lookup with per-request tenant context** — core routing mechanism
- [ ] **Qdrant user_id payload index + query filter** — data isolation in vector store
- [ ] **SQLite user_id column migration** — data isolation in index state
- [ ] **Per-user OpenAI API key injection at embedding time** — cost attribution
- [ ] **`ob login` + `ob sync-setup` integration in `add-user` CLI** — user provisioning
- [ ] **`ob sync --continuous` process spawn + health monitoring + restart** — continuous vault sync
- [ ] **`add-user` CLI command** — operator-facing user provisioning
- [ ] **`remove-user` CLI command** — operator-facing user deprovisioning
- [ ] **`list-users` CLI command** — operator visibility

### Add After Core Works (v2.x)

Features to add once multi-tenant routing and sync are verified working.

- [ ] **Multi-tenant Prometheus metrics (user_id labels)** — trigger: when operator needs per-user performance visibility
- [ ] **`/admin/sync-status` REST endpoint** — trigger: when programmatic monitoring needed
- [ ] **Per-user Grafana dashboard filter** — trigger: when per-user observability is needed
- [ ] **Sync process crash alerting** — trigger: when production stability becomes priority

### Future Consideration (v3+)

- [ ] **User-level rate limiting** — per-user request quotas; defer: not needed at 1-5 users
- [ ] **Vault encryption key management** — `ob sync-setup --password`; defer: only when encrypted vaults are in use
- [ ] **Cross-encoder reranking (RET-04)** — deferred from v1.0; add to shared retrieval pipeline when per-user precision metrics expose gaps

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| users.json registry + hot-reload | HIGH | LOW | P1 |
| API key → user_id routing | HIGH | LOW | P1 |
| Qdrant user_id isolation | HIGH | MEDIUM | P1 |
| SQLite user_id migration | HIGH | LOW | P1 |
| Per-user OpenAI key injection | HIGH | LOW | P1 |
| `add-user` CLI + ob auth flow | HIGH | HIGH | P1 |
| `ob sync --continuous` process mgmt | HIGH | HIGH | P1 |
| `remove-user` CLI | HIGH | MEDIUM | P1 |
| `list-users` CLI | MEDIUM | LOW | P1 |
| Multi-tenant Prometheus metrics | MEDIUM | MEDIUM | P2 |
| `/admin/sync-status` endpoint | MEDIUM | LOW | P2 |
| Per-user Grafana filter | MEDIUM | LOW | P2 |
| Sync crash alerting | LOW | LOW | P2 |

**Priority key:**
- P1: Must have for v2.0 launch — multi-tenancy doesn't work without these
- P2: Should have, add post-validation — improves operations, not correctness
- P3: Deferred — future milestone material

---

## Implementation Notes by Feature

### obsidian-headless Auth Flow (MEDIUM confidence — beta tool)

The auth flow for non-interactive server use is the most uncertain part of v2.0. Current state as of 2026-03-14 (obsidian-headless v0.0.3+):

1. **`ob login --email <email> --password <password>`** — flags exist for non-interactive auth. MFA flag `--mfa` available if user has 2FA enabled. This produces an auth token stored in `~/.config/obsidian-headless/auth_token` (or `OBSIDIAN_AUTH_TOKEN` env var equivalent).

2. **`ob sync-setup --vault <name> --path <path>`** — links a local directory to a named remote vault. Historically failed on headless Linux due to missing keychain (gnome-keyring D-Bus). Version 0.0.3+ resolved this for non-encrypted vaults. The `--password` flag handles encrypted vaults.

3. **`ob sync --continuous`** — long-running WebSocket process that watches for Obsidian Sync cloud changes and applies them to the local vault directory.

**Critical unknown:** Whether `ob login` with `--email`/`--password` flags works fully non-interactively (no TTY prompt at all) is not confirmed by official docs. The flags exist but the forum notes suggest interactive was the original design. Must verify by running `ob login --email test@test.com --password secret < /dev/null` during phase research. If interactive TTY is required, workaround is to pre-generate auth tokens during `add-user` (which IS interactive) and store them for process restart use.

**Keychain workaround:** v0.0.3 resolved headless keychain issues for non-encrypted vaults. If vault encryption is used (`--password` flag on sync-setup), the keychain dependency may resurface. For v2.0: assume no vault encryption (simplest case) and document as known constraint.

### Process Manager Pattern

The sync process manager lives inside the CogniVault Fastify process (not a separate daemon). Standard Node.js `child_process.spawn()` is sufficient — no external process manager needed.

Pattern:
```
SyncProcessManager class:
  - Map<user_id, SyncProcess> (PID, status, restart_count, last_crash_at)
  - start(user): spawn("ob", ["sync", "--continuous"], { cwd: vaultPath, env: { HOME: userConfigDir } })
  - stop(user): process.kill(pid, 'SIGTERM') → wait for exit
  - onExit(user, code): if code !== 0, schedule restart with exponential backoff
  - maxRestarts: 10, backoff: [1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 512s] (cap at 512s)
  - status(): returns array of { user_id, pid, status, restart_count, uptime_s }
```

Per-user HOME directory isolation is critical: each user's `ob` config (auth token, vault linkage) must live in a separate directory. Use `userConfigDir = /data/users/<user_id>/.config` and set `HOME` env var when spawning.

### users.json Registry Schema

```json
{
  "users": [
    {
      "user_id": "alice",
      "api_key": "cv-abc123...",
      "vault_name": "My Vault",
      "vault_path": "/data/vaults/alice",
      "openai_key": "sk-...",
      "obs_email": "alice@example.com",
      "obs_password": "..."
    }
  ]
}
```

**Security note:** `obs_password` and `openai_key` are secrets stored in plaintext. In v2.0 this is acceptable for a self-hosted operator-controlled deployment. Document clearly. Future: reference to env vars instead of inline values.

### Qdrant Isolation Strategy

Use single shared `cognivault` collection (already exists). Add `user_id` to all point payloads on upsert. Create payload index:

```
PUT /collections/cognivault/index
{ "field_name": "user_id", "field_schema": { "type": "keyword", "is_tenant": true } }
```

All search queries get an implicit must-filter:
```json
{ "must": [{ "key": "user_id", "match": { "value": "<user_id>" } }] }
```

This is Qdrant's recommended pattern for multi-tenancy. `is_tenant: true` co-locates vectors by tenant, making per-user queries significantly faster via sequential reads.

---

## Sources

- [obsidian-headless GitHub (obsidianmd)](https://github.com/obsidianmd/obsidian-headless) — command reference, auth flags
- [Obsidian Forum: OBSIDIAN_AUTH_TOKEN retrieval](https://forum.obsidian.md/t/headless-sync-how-to-get-obsidian-auth-token-variable/111740) — non-interactive auth workarounds
- [Obsidian Forum: ob sync-setup keychain issue](https://forum.obsidian.md/t/ob-sync-setup-fails-on-headless-linux-keychain-unavailable/111679) — v0.0.3 fix confirmed
- [Qdrant Multitenancy Documentation](https://qdrant.tech/documentation/guides/multitenancy/) — is_tenant, payload filter, single-collection recommendation
- [Qdrant Multitenancy Article](https://qdrant.tech/articles/multitenancy/) — payload_m=16 optimization for per-tenant HNSW indices
- [Node.js child_process documentation](https://nodejs.org/api/child_process.html) — spawn, SIGTERM, exit event
- [Commander.js GitHub](https://github.com/tj/commander.js) — CLI framework for add-user/remove-user/list-users

---
*Feature research for: CogniVault v2.0 — Multi-tenant vault sync + user lifecycle*
*Researched: 2026-03-14*
