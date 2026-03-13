# Feature Research

**Domain:** Multi-user containerized deployment — per-user CogniVault+Obsidian+VNC with shared infrastructure (v2.0 milestone)
**Researched:** 2026-03-13
**Confidence:** MEDIUM-HIGH (key facts verified via official sources; operational patterns from community sources)

---

## Context: Scope Boundary

This research is scoped exclusively to **what is NEW in v2.0**. The following already exist in v1.0 and must not be re-implemented:

- REST API CRUD, hybrid search, context assembly, multi-format indexing
- Single API key authentication
- Docker Compose deployment (CogniVault + Qdrant + Prometheus + Grafana)
- Prometheus metrics, OpenTelemetry tracing, structured logging
- Health/readiness endpoints

---

## Critical Discovery: Obsidian Headless Client (February 2026)

Obsidian released an official headless sync client (`obsidianmd/obsidian-headless`) in February 2026. This **eliminates the need for a full GUI+VNC container purely for sync purposes**.

Key facts (HIGH confidence — verified via official GitHub):
- NPM package: `ob login`, `ob sync`, `ob sync --continuous`
- Requires Node.js 22+ (matches existing project runtime)
- Non-interactive auth via `OBSIDIAN_AUTH_TOKEN` environment variable
- Supports continuous sync mode, bidirectional/pull-only/mirror-remote modes
- E2EE support, conflict resolution, selective file type sync
- Requires an active **Obsidian Sync subscription** per user (~$8/month per user)

**Architectural implication:** VNC is now decoupled from sync. VNC is needed only for users who want to visually edit their vault via a browser. Sync via `obsidian-headless` runs as a sidecar process in each user's container stack — no display server, no X11, no VNC required for it.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features that must exist for the multi-user platform to be operational. Missing any of these means the platform cannot serve multiple users safely.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Per-user container provisioning | Each user needs isolated CogniVault + vault storage | MEDIUM | Docker Compose per-user service stack; generated `compose.user.yml` + `.env` per user; CLI wraps docker operations |
| Per-user API key authentication | Tenants must not access each other's data via API | LOW | Extend existing single-key auth; map API key → `user_id` in management registry; minimal code change to auth plugin |
| Qdrant tenant isolation via payload filtering | Shared Qdrant must not leak vectors across users | MEDIUM | Add `user_id` payload field to all vectors; filter on every upsert and query; requires keyword payload index on `user_id`; change to search service + indexing subsystem |
| Vault data persistence across restarts | User data must survive container restarts | LOW | Named Docker volumes per user (e.g., `cognivault-vault-alice`); standard Docker practice |
| Obsidian headless sync sidecar | Each user's vault syncs from Obsidian Sync | MEDIUM | `obsidian-headless` sidecar service in user's Compose stack; `OBSIDIAN_AUTH_TOKEN` env var; `ob sync --continuous` as main process; Node.js 22 base image |
| Container resource limits | Prevent one user starving others (noisy neighbor) | LOW | `deploy.resources.limits` in Compose — `cpus` + `memory` per service; recommended defaults: CogniVault 0.5 CPU/512M, headless sidecar 0.25 CPU/256M |
| cognivault-ctl CLI (add/remove/list) | Operators need lifecycle management for user containers | MEDIUM | Node.js or shell CLI; generates per-user configs, calls Docker SDK (Dockerode) or shell exec; maintains user registry (JSON or SQLite) |
| Health check per user container | Orchestration needs liveness signals | LOW | Reuse existing `/health` and `/readiness` endpoints; add `healthcheck` stanza to each Compose service |

### Differentiators (Competitive Advantage)

Features that add real value beyond baseline isolation. Not required for v2.0 launch, but differentiate the platform.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| VNC/browser access to Obsidian GUI | Users can visually manage their vault from a browser — no local Obsidian install needed | MEDIUM | `linuxserver/obsidian` image (noVNC on ports 3000/3001); per-container `PASSWORD` env var; port range allocated by CLI (e.g., user 1: 3000/3001, user 2: 3002/3003); optional service in user stack |
| Per-user metrics labels in shared Prometheus | Operators can debug per-user performance in Grafana without separate Prometheus instances | MEDIUM | Add `user_id` default label to `prom-client` Registry at CogniVault startup; inject via env var; touches existing metrics registration code |
| Shared Grafana with per-user dashboard variables | Single monitoring interface for all users via `$user_id` template variable | LOW | Grafana variable filters existing dashboards; no new dashboards needed; depends on per-user metrics labels |
| Graceful user removal with volume backup | Safe offboarding — user data not silently deleted | MEDIUM | `cognivault-ctl remove --backup <user>` exports vault volume as tar via Alpine container before `docker volume rm` |
| cognivault-ctl status output | Operators see all users, container state, and resource usage at a glance | LOW | Wraps `docker ps` + `docker stats` + container inspect; formats as table with user, status, CPU%, memory |
| Per-user API key rotation | Security hygiene for long-running deployments | LOW | `cognivault-ctl rotate-key <user>` regenerates key in user's `.env`, restarts CogniVault container for that user |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Separate Qdrant instance per user | "True" isolation feels safer | Qdrant is memory-intensive; 10 users = 10 Qdrant instances; operational overhead is unjustified; Qdrant's own docs recommend payload-based filtering for multi-tenancy | Single shared Qdrant with `user_id` payload field + keyword filter index — Qdrant-recommended approach |
| Separate Prometheus per user | Per-user metrics without label management | Prometheus is not lightweight; instance multiplication not justified at this scale (5-10 users) | Add `user_id` default label to prom-client; use Grafana template variables to filter by user |
| Web UI for user management | Nicer UX for operators | Scope explosion; operators at this scale are technical; not worth the build cost | CLI (`cognivault-ctl`) is sufficient; Grafana covers observability; zero UI needed |
| SSO / OAuth / per-user login for agents | "Real" auth for the REST API | Obsidian Sync already handles user identity; OAuth adds auth stack complexity with no benefit for the agent use case; agents do not use browser auth | API keys per user are sufficient; agents are not humans logging in via browser |
| Kubernetes / Helm deployment | Enterprise-grade orchestration | Not justified for a self-hosted single-server deployment; massive operational surface area; no current need | Docker Compose with Dockerode-based CLI is the right tool at this scale |
| Shared vault across users | Collaborative editing | Conflicts with Obsidian Sync's per-user vault model; requires CRDT-level merge logic; fundamentally different architecture | Per-user vault; cross-user search is a future feature if genuinely needed |
| Real-time user session monitoring | See who is active in Obsidian VNC | Requires WebSocket / event stream infrastructure not in project scope | Prometheus connection count metrics are sufficient; container CPU activity is a proxy signal |

---

## Feature Dependencies

```
Per-user container provisioning
    └──requires──> Per-user API key authentication (key gen + mapping)
    └──requires──> Qdrant tenant isolation (user_id on all vectors)
    └──requires──> Vault data persistence (named volumes)
    └──requires──> Container resource limits (deploy.resources)

cognivault-ctl CLI
    └──requires──> Per-user container provisioning (CLI wraps it)
    └──enhances──> Graceful user removal with volume backup
    └──enhances──> cognivault-ctl status output
    └──enhances──> Per-user API key rotation

Obsidian headless sync sidecar
    └──requires──> Per-user container provisioning (runs in user's stack)
    └──requires──> OBSIDIAN_AUTH_TOKEN per user (external: Obsidian Sync subscription)
    └──independent of──> VNC/browser access (sync works without GUI)

VNC/browser Obsidian GUI
    └──requires──> Per-user container provisioning (optional service in stack)
    └──requires──> Port range allocation per user (managed by CLI registry)
    └──independent of──> Obsidian headless sync (GUI access != sync)

Per-user metrics labels
    └──requires──> Per-user container provisioning (user_id known at startup)
    └──depends on──> Existing Prometheus + Grafana (already in v1.0)
    └──enhances──> Shared Grafana per-user dashboard views

Shared Grafana per-user dashboard views
    └──requires──> Per-user metrics labels
    └──depends on──> Existing Grafana (already in v1.0)

Qdrant tenant isolation
    └──modifies──> Existing CogniVault search service (add user_id filter to every query)
    └──modifies──> Existing CogniVault indexing subsystem (add user_id to every upsert)
    └──requires──> user_id keyword payload index in Qdrant (one-time setup per collection)
```

### Dependency Notes

- **Qdrant isolation is a cross-cutting code change:** Every Qdrant upsert and every search query in CogniVault must be modified to include `user_id`. This touches `src/features/search/service.ts` and the indexing subsystem. It must be the first code change made — everything else builds on top of it.
- **VNC is independent of sync:** Thanks to `obsidian-headless`, VNC is purely a UI convenience feature. Sync works without VNC. These can be developed and shipped in separate phases.
- **Per-user metrics labels require startup-time injection:** `user_id` is available as an env var when the container starts. The `prom-client` Registry default labels must be set at app initialization, not per-request. This is a small but early change.
- **CLI depends on container provisioning design being settled first:** The CLI is a wrapper; the per-user Compose template must be defined before the CLI can generate instances of it.
- **VNC port allocation must be managed by CLI registry:** Without coordinated port assignment, two users can be allocated overlapping ports. The CLI user registry must track port assignments.

---

## MVP Definition

### Launch With (v2.0)

Minimum viable multi-user platform — what is needed to run multiple users safely and operationally.

- [ ] Qdrant tenant isolation (`user_id` payload field + keyword index + filter on all queries) — data boundary; must be first
- [ ] Per-user container provisioning (CogniVault + obsidian-headless sidecar) — isolation unit
- [ ] Per-user API key (generated at provisioning time, mapped to `user_id`) — auth boundary
- [ ] Container resource limits in Compose config — noisy neighbor prevention
- [ ] Vault data persistence via named Docker volumes — data durability
- [ ] `cognivault-ctl add/remove/list` CLI — operational lifecycle management

### Add After Validation (v2.x)

Features to add once core multi-user operation is confirmed stable.

- [ ] VNC/browser Obsidian GUI per user — add when users request visual vault access; not needed for agent-only workflows
- [ ] Per-user metrics labels + Grafana `$user_id` template variable — add when debugging per-user performance becomes necessary
- [ ] Graceful user removal with volume backup (`--backup` flag) — add before first user offboarding event
- [ ] Per-user API key rotation (`cognivault-ctl rotate-key`) — add as part of ops hardening pass
- [ ] `cognivault-ctl status` with resource usage — add when managing more than 3 users

### Future Consideration (v3+)

- [ ] Cross-user search with explicit permission grants — defer; requires access control model
- [ ] Tiered Qdrant multitenancy (dedicated shards for heavy users) — defer; only relevant at 50+ users with uneven load
- [ ] Kubernetes / Helm deployment — defer until scale justifies orchestration overhead

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Qdrant tenant isolation | HIGH | MEDIUM | P1 |
| Per-user container provisioning | HIGH | MEDIUM | P1 |
| Per-user API key auth | HIGH | LOW | P1 |
| Container resource limits | HIGH | LOW | P1 |
| Vault data persistence | HIGH | LOW | P1 |
| cognivault-ctl add/remove/list | HIGH | MEDIUM | P1 |
| Obsidian headless sync sidecar | HIGH | MEDIUM | P1 |
| VNC/browser Obsidian GUI | MEDIUM | MEDIUM | P2 |
| Per-user metrics labels + Grafana | MEDIUM | LOW | P2 |
| Graceful removal with volume backup | MEDIUM | MEDIUM | P2 |
| cognivault-ctl status output | LOW | LOW | P2 |
| Per-user API key rotation | LOW | LOW | P2 |
| Shared Grafana per-user dashboard views | LOW | LOW | P3 |

**Priority key:**
- P1: Must have for v2.0 launch
- P2: Should have, add when possible in v2.x
- P3: Nice to have, future consideration

---

## Implementation Notes by Feature Area

### Qdrant Tenant Isolation

Qdrant's official recommendation for multi-tenancy is a **single collection with payload-based filtering** (not separate collections per user). This approach:
- Is resource-efficient (one collection, shared HNSW index structure)
- Supported natively: `filter: { must: [{ key: "user_id", match: { value: "alice" } }] }`
- Requires creating a **keyword payload index** on `user_id` for efficient filtering (one API call at collection setup)
- Tiered multitenancy (v1.16+) adds dedicated shards for heavy tenants if load becomes uneven — defer this

All existing CogniVault vector upserts must add `user_id` to the Qdrant payload. All queries must add a `user_id` filter. This is surgical but mandatory change to `src/features/search/service.ts` and the indexing subsystem.

**Confidence:** HIGH — documented at qdrant.tech/documentation/guides/multitenancy/

### Obsidian Headless Sync

`obsidian-headless` runs as `ob sync --continuous` as the main process in a sidecar service within each user's Compose stack. Auth token is `OBSIDIAN_AUTH_TOKEN` env var — fully non-interactive, suitable for containers. Node.js 22 base image required, which matches the project's existing runtime. No display server, VNC, or X11 needed for sync.

The headless client requires an active **Obsidian Sync subscription** per user. This is a per-user external recurring cost (~$8/month) that operators must be aware of when provisioning users.

**Confidence:** HIGH — official repository `obsidianmd/obsidian-headless` confirmed.

### VNC Access via linuxserver/obsidian

The `linuxserver/obsidian` image (based on Docker Baseimage Selkies) exposes Obsidian via noVNC on ports 3000 (HTTP) and 3001 (HTTPS). Per-container VNC passwords are set via the `PASSWORD` environment variable. Per-user isolation requires unique port allocation — the management CLI must track and assign port ranges (e.g., user 1: 3000/3001, user 2: 3002/3003). Users access their Obsidian GUI at `http://host:PORT`.

**Confidence:** MEDIUM — confirmed from linuxserver.io docs; per-user port range allocation pattern is community convention.

### cognivault-ctl CLI Architecture

A Node.js CLI (compatible with the existing TypeScript stack) that:
1. Maintains a user registry (JSON file or SQLite) mapping: username → API key, port assignments, volume names, container names
2. Generates per-user Docker Compose override files (`compose.user-alice.yml`) and `.env` files from templates
3. Calls `docker compose -f compose.base.yml -f compose.user-alice.yml up -d` via Dockerode or shell exec
4. Handles removal: `docker compose down`, optional volume export to tar via Alpine container, `docker volume rm`
5. `list` command wraps `docker ps --filter name=cognivault-` and formats as table

Dockerode (Node.js Docker SDK) is the appropriate library — active, well-maintained, supports promise-based API.

**Confidence:** MEDIUM — standard operational pattern; no framework-specific gotchas identified.

### Container Resource Limits

Docker Compose `deploy.resources.limits` supports `cpus` (fractional core count) and `memory` (with M/G suffix). Recommended starting defaults for a host running 5-10 users:

- CogniVault API service: `cpus: '0.5'`, `memory: '512M'`
- Obsidian headless sidecar: `cpus: '0.25'`, `memory: '256M'`
- VNC/Obsidian GUI (if enabled): `cpus: '0.5'`, `memory: '512M'`

These are tunable via env vars in each user's `.env` file. Operators adjust based on actual host capacity.

**Confidence:** HIGH — from Docker official docs.

---

## Sources

- [obsidianmd/obsidian-headless — GitHub](https://github.com/obsidianmd/obsidian-headless)
- [Obsidian Sync Headless Client announcement — devops-geek.net](https://devops-geek.net/devops-lab/obsidian-sync-gets-a-headless-client-a-game-changer-for-linux-automation-and-devops-workflows/)
- [Obsidian Headless Sync docs — help.obsidian.md](https://help.obsidian.md/sync/headless)
- [Qdrant Multitenancy Guide — qdrant.tech](https://qdrant.tech/documentation/guides/multitenancy/)
- [Qdrant Tiered Multitenancy v1.16 — qdrant.tech](https://qdrant.tech/blog/qdrant-1.16.x/)
- [linuxserver/obsidian Docker image — docs.linuxserver.io](https://docs.linuxserver.io/images/docker-obsidian/)
- [obsidian-remote (sytone) — GitHub](https://github.com/sytone/obsidian-remote)
- [Docker Compose Deploy Resources — docs.docker.com](https://docs.docker.com/reference/compose-file/deploy/)
- [Dockerode (Node.js Docker SDK) — GitHub](https://github.com/apocas/dockerode)
- [docker-volume-backup (offen) — GitHub](https://github.com/offen/docker-volume-backup)
- [Multi-tenant observability with Grafana — Medium](https://sollybombe.medium.com/creating-multi-tenant-observability-dashboards-with-grafana-loki-2025-edition-85a673eff596)

---
*Feature research for: CogniVault v2.0 multi-user deployment*
*Researched: 2026-03-13*
