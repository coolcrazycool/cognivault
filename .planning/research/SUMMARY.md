# Project Research Summary

**Project:** CogniVault v2.0 — Multi-User Deployment
**Domain:** Multi-tenant containerized API service with per-user Obsidian+VNC access
**Researched:** 2026-03-13
**Confidence:** HIGH (core architecture and stack decisions verified against official docs; VNC routing and compose templating patterns MEDIUM)

## Executive Summary

CogniVault v2.0 is an additive milestone on an already-working v1.0 foundation. The goal is to expand a single-user Fastify REST API with Qdrant-backed semantic search into a multi-user platform where each user gets isolated vault storage, isolated compute (per-user containers), and optional browser-based Obsidian access via VNC — all managed from a single operator CLI. The v1.0 architecture is preserved wholesale; no redesign is required. New components wrap around it: a shared Qdrant collection gains tenant-scoped payload filtering, Docker Compose gains generated per-user service blocks, and a new `cognivault-ctl` CLI handles user lifecycle (add/remove/list).

The recommended approach is a three-tier isolation model: per-user Docker Compose service stacks (each with a CogniVault instance + optional Obsidian VNC container) sharing a single Qdrant instance (with `user_id` payload filtering + `is_tenant: true` index), shared Prometheus/Grafana monitoring, and Caddy as the single VNC ingress point. Obsidian Sync is handled via the new official `obsidian-headless` client (released February 2026), which runs as a sidecar container without requiring VNC — decoupling sync from GUI access entirely. The management CLI uses Commander.js + the `yaml` package to generate compose fragments and Caddyfile blocks programmatically, eliminating manual YAML editing as an error-prone anti-pattern.

The central risk is data isolation: Qdrant has no row-level security, so every code path that touches Qdrant must inject a `user_id` filter. A `QdrantTenantClient` wrapper class is mandatory — it eliminates the entire class of silent cross-tenant data leakage errors. Secondary risks are operational: Electron-in-Docker rendering failures (`shm_size: 1gb` is non-negotiable, image version must be pinned), VNC port security (Caddy proxy with internal-only container networking, never direct port exposure), and API key storage (Docker secrets, not compose environment blocks). All of these must be addressed in the initial compose template design — retrofitting network isolation or resource limits after per-user containers are provisioned requires restarting every container.

## Key Findings

### Recommended Stack

The v1.0 stack (Fastify 5, TypeBox, Drizzle ORM + SQLite, Qdrant, OpenAI embeddings, prom-client, OpenTelemetry, Docker Compose) is unchanged. V2.0 adds five technologies.

**Core new technologies:**
- `lscr.io/linuxserver/obsidian:latest` (pinned tag): Obsidian desktop in Docker via KasmVNC/Selkies browser access — the only actively maintained Electron-in-Docker option (ARM64 + x86-64, s6-overlay process supervision); requires `shm_size: "1gb"` which is mandatory and non-negotiable; chosen over `sytone/obsidian-remote` (abandoned Oct 2022) and `kasmweb/obsidian` (commercial platform dependencies)
- `obsidianmd/obsidian-headless` (npm, pinned version): Official Obsidian headless sync client released Feb 2026; `ob sync --continuous` as sidecar process; auth via `OBSIDIAN_AUTH_TOKEN` env var; still in beta — pin the exact version; requires active Obsidian Sync subscription per user (~$8/month)
- `commander` 14.0.x: CLI argument parsing for `cognivault-ctl`; 0 dependencies, 180KB, full ESM + TypeScript support; v14 in maintenance through May 2027
- `yaml` 2.x: YAML read/write for programmatic compose fragment generation; built-in TypeScript types, comment preservation; chosen over `js-yaml` (stale types)
- Caddy: VNC reverse proxy in shared infrastructure stack; automatic WebSocket upgrade handling (zero-config vs Nginx's explicit Upgrade header requirement), path-based routing to per-user Obsidian containers, graceful reload without dropping active WebSocket connections

**What NOT to add:** No collection-per-user in Qdrant (official Qdrant docs explicitly warn this causes cluster instability and performance degradation), no Kubernetes (single-host Docker Compose target), no OAuth/SSO (agents use API keys, not browser auth), no web UI for user management (CLI is sufficient at this scale), no Oclif CLI framework (12MB + 30 deps for 5 commands).

**See:** `.planning/research/STACK.md` for version compatibility table, installation commands, and full alternative comparison.

### Expected Features

V2.0 must ship six table-stakes features for the multi-user platform to be operationally safe. Three additional differentiators follow in v2.x patches.

**Must have (v2.0 launch — P1):**
- Qdrant tenant isolation (`user_id` payload field + keyword index + `is_tenant: true` + filter on every upsert and query) — the data boundary; must be the first code change made, everything else builds on it
- Per-user container provisioning (CogniVault + obsidian-headless sidecar per user, generated compose fragment) — the isolation unit
- Per-user API key authentication (key generated at provisioning time, mapped to `user_id` in `users.db`) — the auth boundary
- Container resource limits (`deploy.resources.limits` in Compose with CPU + memory) — noisy neighbor prevention; one Electron memory leak OOM-kills all users without this
- Vault data persistence (named Docker volumes per user with scoped names: `cognivault_alice_vault`) — data durability
- `cognivault-ctl add/remove/list` CLI — operator lifecycle management; manual YAML editing at scale is catastrophically error-prone

**Should have (v2.x, add after core is validated — P2):**
- VNC/browser Obsidian GUI per user (`linuxserver/obsidian`) — optional; agents do not need it; add when users request visual vault access
- Per-user metrics labels + Grafana `$tenant` template variable — add when per-user performance debugging becomes necessary
- Graceful user removal with volume backup (`--backup` flag) — add before first user offboarding event

**Defer (v3+):**
- Cross-user search with explicit permission grants (requires a new access control model)
- Tiered Qdrant multitenancy with dedicated shards for heavy users (only relevant at 50+ users with uneven load distributions)
- Kubernetes/Helm deployment (not justified until single-host Docker Compose hits its ceiling)

**Critical discovery:** `obsidianmd/obsidian-headless` decouples VNC from sync. VNC is now a UI convenience feature only — sync works without it. The v2.0 MVP can ship with headless sync sidecars and defer VNC entirely, reducing Phase 1 scope significantly.

**See:** `.planning/research/FEATURES.md` for the full feature dependency graph and prioritization matrix.

### Architecture Approach

V2.0 is architecturally additive: the existing Fastify monolith, Qdrant collection, and Docker Compose stack are all preserved. New components insert around them. The topology is N user stacks (each: `cognivault-{user}` + `obsidian-headless-{user}`, optionally `obsidian-gui-{user}`) sharing four infrastructure services (Qdrant, Prometheus, Grafana, Caddy) via a Docker bridge network. SQLite remains per-container — one uniquely named volume per user, no shared SQLite across containers. Qdrant remains a single shared instance with payload-based tenant filtering.

**Major components:**
1. **cognivault-ctl** (new) — Management CLI; maintains `users.db` (host-side SQLite, not inside any user container); generates `docker-compose.users.yml`, `Caddyfile` blocks, and `monitoring/prometheus/targets/users.json`; calls `docker compose up/down` for user lifecycle
2. **QdrantTenantClient wrapper** (new, modifies `src/plugins/qdrant.ts`) — wraps raw Qdrant client; injects `user_id` filter into every operation automatically; `TENANT_ID` env var injected at container startup; makes unfiltered cross-tenant queries structurally impossible
3. **Caddy reverse proxy** (new shared service) — single ingress point for all VNC sessions; path-based routing (`/vnc/{username}/` → `obsidian-{username}:3000`); handles WebSocket upgrades transparently; updated by `cognivault-ctl` on add/remove via `caddy reload`
4. **Prometheus file_sd_configs** (modifies `prometheus.yml`) — replaces static scrape targets with file-based service discovery reading `monitoring/prometheus/targets/users.json`; users added/removed without Prometheus restart (30s refresh interval)
5. **Per-user container stacks** (new, generated by CLI) — two containers per user in `docker-compose.users.yml`; share a named vault volume; each with scoped resource limits and isolated Docker network

**Architecture rules established by research:**
- CogniVault and Obsidian run in separate containers sharing a named vault volume — never combine into one container (forces forking linuxserver base image, couples Electron crash/restart to CogniVault uptime)
- Never publish VNC ports directly to host — all Obsidian containers on internal Docker network only
- Always set `COMPOSE_PROJECT_NAME` per user to prevent volume and network name collisions
- `TENANT_ID` is injected as env var at container startup; no per-request DB lookup needed for tenant context

**Suggested build order from research:** Qdrant tenant isolation first (foundation for all per-user data isolation), then manual compose structure with 1-2 users (validate before automating), then Prometheus multi-tenant metrics, then `cognivault-ctl` CLI (automate what was validated manually), then obsidian-headless sync integration.

**See:** `.planning/research/ARCHITECTURE.md` for full component diagram, all five anti-patterns with explanations, data flow changes, and integration point breakdown.

### Critical Pitfalls

Eight pitfalls identified; five are Phase 1 concerns that must be built into the initial compose template:

1. **Qdrant tenant filter omission leaks all user data** — Every Qdrant operation without a `user_id` filter is a silent cross-tenant data breach; Qdrant has no row-level security. Prevention: `QdrantTenantClient` wrapper class that injects the filter at the call site; integration test asserting user A's search never returns user B's results. This is the highest-severity issue in the entire milestone — a missing filter compiles and runs without errors while silently exposing all vaults.

2. **Electron/Obsidian black screen and seccomp crashes** — `shm_size: "1gb"` is mandatory in every Obsidian compose service block; missing it crashes Chromium silently. The `:latest` image tag has had rendering regressions; pin a validated version tag. Set `DISPLAY_WIDTH=1920 DISPLAY_HEIGHT=1080` to prevent 4-8GB framebuffer allocation at the default 16K virtual resolution.

3. **VNC ports exposed without encryption or network isolation** — Docker Compose port bindings default to `0.0.0.0`, exposing VNC sessions on the public IP. Never expose VNC ports directly; all Obsidian containers on internal Docker network only; Caddy is the sole ingress point with HTTPS. In a 10-user deployment, sequential direct VNC ports are discoverable in a single subnet scan.

4. **SQLite corruption from shared volume mounts** — Generic volume names (`db_data`) reused across user compose files cause multiple containers to write to the same SQLite file, resulting in corruption (not just "database is locked" — actual data corruption on macOS Docker Desktop and network volumes where `fcntl()` locking is unreliable across containers). Always prefix with user: `cognivault_alice_db`. Set `COMPOSE_PROJECT_NAME` per user.

5. **Per-user resource exhaustion kills all users** — No resource limits means one Electron memory leak triggers the OOM killer on the host, killing containers from other users. Set `memory: "2g"`, `cpus: "1.5"` per Obsidian container; `memory: "1g"`, `cpus: "1.0"` per CogniVault container. Must be in the initial compose template — adding later requires restarting all running containers.

6. **obsidian-headless auth token requires interactive setup** — `ob login` cannot run inside a non-interactive Docker container; there is no programmatic API for token generation. The provisioning workflow must include a mandatory manual step: operator runs `ob login` interactively, captures token from `~/.obsidian-headless/auth_token`, stores as Docker secret. Design `cognivault-ctl add-user` output to print explicit instructions for this step.

7. **API key plaintext in compose environment blocks** — Keys in `environment:` blocks are visible via `docker inspect`. Use Docker secrets (`/run/secrets/`) or `chmod 600` `.env` files never committed to git. Store hashed keys (SHA-256) in `users.db`, never plaintext.

8. **Docker Compose port conflicts and container name collisions** — Hardcoded sequential ports in a shared compose file collide when adding the second user. `cognivault-ctl` must maintain a port registry and generate per-user compose fragments. Never set `container_name` in user templates — let Docker Compose derive it from `COMPOSE_PROJECT_NAME` + service name.

**See:** `.planning/research/PITFALLS.md` for the full "looks done but isn't" checklist, per-pitfall recovery strategies, and phase mapping.

## Implications for Roadmap

The research dependency graph enforces a specific build order. Phase 1 must establish all safety and isolation boundaries before any user containers are created. Retrofitting data isolation, network isolation, or resource limits after containers are provisioned is expensive and requires full restarts. The architecture research explicitly recommends validating the compose structure manually before building the CLI that generates it.

### Phase 1: Qdrant Tenant Isolation + Compose Safety Boundaries
**Rationale:** Every subsequent component depends on Qdrant being tenant-aware and on the compose template having correct safety properties. Running two CogniVault containers against a non-tenant-aware Qdrant would cause immediate cross-user data contamination. All five Phase 1 pitfalls (Qdrant filter omission, shm_size, VNC network exposure, SQLite volume naming, resource limits) must be embedded in the initial template before any users are provisioned.
**Delivers:** A modified CogniVault that can run as one of N isolated instances against shared Qdrant (`TENANT_ID` env var, `QdrantTenantClient` wrapper, `user_id` payload index); migration script for existing single-user data (`user_id="default"` on all existing points); a validated base compose template with correct volume naming, resource limits, and network isolation; integration tests asserting zero cross-tenant data leakage.
**Features addressed:** Qdrant tenant isolation, vault data persistence (volume naming scheme), container resource limits.
**Code changes required:** `src/config.ts` (add `TENANT_ID` required env var), `src/plugins/qdrant.ts` (tenant wrapper + payload index creation), all `src/features/*/service.ts` touching Qdrant (add `user_id` to all payloads and filter all queries), `docker-compose.yml` (add Caddy service, isolate container networks).
**Pitfalls addressed:** Tenant filter omission (wrapper class), SQLite volume collision (naming scheme), resource exhaustion (limits in template), VNC network exposure (internal-only container networking baked in from the start).

### Phase 2: Multi-User Compose Stack (Manual Validation with 2 Users)
**Rationale:** Before building the CLI that generates compose configurations, validate the compose structure manually with 2 real users. This catches VNC routing issues, vault volume sharing problems, Caddy path-prefix behavior, and obsidian-headless interactive auth requirements before the CLI encodes wrong assumptions. ARCHITECTURE.md explicitly recommends this order.
**Delivers:** A working 2-user deployment validated end-to-end: browser → Caddy → Obsidian VNC, two CogniVault instances → shared Qdrant with proven tenant isolation, per-user SQLite files with scoped volumes, resource limits verified via `docker inspect`. The per-user compose fragment structure that `cognivault-ctl` will later automate.
**Stack used:** `lscr.io/linuxserver/obsidian` (pinned validated tag), Caddy reverse proxy, `obsidian-headless` sidecar.
**Pitfalls addressed:** Electron rendering (validated on target host architecture before building CLI on top), VNC port exposure (Caddy-only ingress confirmed), obsidian-headless interactive auth (manual token injection documented as a first-class provisioning step), port collision pattern (port registry approach validated manually first).

### Phase 3: Prometheus Multi-Tenant Metrics
**Rationale:** Convert Prometheus scrape config from static to file-based service discovery before building the CLI. This way `cognivault-ctl add-user` can write to `targets/users.json` and get dynamic scrape configuration automatically. Converting after the CLI would require a second pass over CLI code.
**Delivers:** Prometheus scraping all user containers dynamically without restarts; `monitoring/prometheus/targets/users.json` as the generated target list; Grafana dashboard updated with `$tenant` variable for per-user metric filtering.
**Code changes:** `monitoring/prometheus/prometheus.yml` (replace `static_configs` with `file_sd_configs`), create `monitoring/prometheus/targets/users.json` with validated structure.
**Pitfalls addressed:** Metric cardinality explosion (consistent `tenant` label schema established from the start, limiting per-user metric dimensions).

### Phase 4: cognivault-ctl CLI
**Rationale:** Only after the compose structure, VNC routing, and Prometheus targets are manually validated should the CLI codify that structure. The CLI is a code generator — generating wrong configs for 10 users is worse than manually managing correct configs for 2 users. The template must be right before automation begins.
**Delivers:** `cognivault-ctl add/remove/list`; programmatic compose fragment generation using the `yaml` package; port registry (SQLite-backed) preventing collisions; Caddyfile block generation + graceful reload; Prometheus target generation; API key generation (SHA-256 hashed, stored in `users.db`); explicit CLI output instructing operators to capture obsidian-headless auth tokens manually.
**Stack used:** Commander.js 14.0.x, `yaml` 2.x, `users.db` SQLite file (host-side, separate from per-user container DBs).
**Pitfalls addressed:** Port conflicts (port registry in `users.db`), name collisions (`COMPOSE_PROJECT_NAME` per user embedded in generated files), API key plaintext (Docker secrets or `chmod 600` `.env` files, hashed storage in `users.db`).

### Phase 5: obsidian-headless Sync Integration
**Rationale:** The headless sync sidecar is independent of VNC (per FEATURES.md critical discovery) and can be integrated after the container stack is validated. The interactive auth token requirement is a known constraint; this phase formalizes the provisioning workflow with the manual step as a first-class requirement.
**Delivers:** Per-user Obsidian Sync sidecar (`ob sync --continuous`) added to the compose template; auth token injected as Docker secret; container configured to fail fast and loudly without valid token; `cognivault-ctl add-user` output includes explicit operator instructions for the manual token capture step; `obsidian-headless` package pinned to a specific validated version.
**Pitfalls addressed:** obsidian-headless interactive auth (explicit manual step in CLI output, not hidden in automation), beta package breakage (pinned version), token security (Docker secrets at `/run/secrets/obsidian_auth_token`, not environment variables).

### Phase Ordering Rationale

- **Data isolation before anything else:** Qdrant tenant filtering is a cross-cutting code change touching every search and index operation. Any interim test data from multiple containers without tenant filtering is cross-contaminated and requires full reindex to resolve.
- **Manual validation before automation:** The CLI generates compose configs. Generating wrong configs for 10 users is worse than manually writing correct configs for 2 users. Validate the template by hand first, then automate it.
- **Infrastructure setup before CLI encoding it:** Prometheus file_sd_configs must be working before the CLI writes to the target file — Phase 3 before Phase 4.
- **VNC GUI is explicitly out of v2.0 scope:** The obsidian-headless sidecar provides sync without VNC. The optional `linuxserver/obsidian` GUI container is a P2 feature that can be added as a `--with-gui` flag to `cognivault-ctl add-user` in a v2.x patch with no architectural changes required.
- **All Phase 1 pitfalls are template decisions:** `shm_size`, network isolation, resource limits, and volume naming are compose template properties. There is no safe way to add them after containers are provisioned; they require restarting every running container.

### Research Flags

Phases likely needing `/gsd:research-phase` during planning:
- **Phase 2 (Obsidian container validation):** Image tag pinning requires checking `linuxserver/docker-obsidian` releases for the current stable tag at planning time. ARM64 rendering issues are host-architecture-specific and may require targeted investigation if the deployment host is ARM64.
- **Phase 5 (obsidian-headless):** Beta package — auth flow has changed between releases. Needs current version verification and validation of the token capture workflow before writing the provisioning runbook.

Phases with well-documented standard patterns (skip deep research):
- **Phase 1 (Qdrant tenant isolation):** Official Qdrant multitenancy docs are complete and unambiguous; `is_tenant: true` API is stable since v1.11.0 (current deployed version is v1.17.0).
- **Phase 3 (Prometheus file_sd_configs):** Standard Prometheus pattern, fully documented, no CogniVault-specific edge cases.
- **Phase 4 (CLI with Commander.js + yaml):** Both libraries have stable, clear APIs; no edge cases identified in research.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Core recommendations verified against official docs: Qdrant multitenancy guide, linuxserver.io docs, Commander.js npm, yaml npm, obsidianmd/obsidian-headless GitHub. Version compatibility table in STACK.md confirmed. |
| Features | MEDIUM-HIGH | P1 features (Qdrant isolation, container provisioning, CLI, resource limits) are well-defined with clear implementation paths. P2 features (VNC, per-user metrics) follow standard patterns. obsidian-headless is HIGH for core sync capability but MEDIUM for operational stability given beta status. |
| Architecture | HIGH | Qdrant single-collection tenancy is the official recommendation with explicit warnings against the alternative. Caddy WebSocket proxying is fully documented. Separate containers vs combined image decision confirmed correct. Compose fragment generation pattern is established. SQLite per-container isolation reasoning is sound. |
| Pitfalls | MEDIUM-HIGH | Container/VNC/Electron pitfalls are well-documented with real GitHub issues and CVE references. Qdrant isolation pitfall confirmed from official docs. obsidian-headless auth pitfall is MEDIUM (beta + community forum sourcing, not official documentation). |

**Overall confidence:** HIGH

### Gaps to Address

- **obsidian-headless stability:** The headless sync client is in beta (2026-03). The auth flow has changed between beta releases. Mitigation: pin the exact npm package version at planning time; build the sidecar container to fail fast with a clear error on auth failure. Validate token capture workflow before writing `cognivault-ctl add-user` code.
- **linuxserver/obsidian image tag:** Research used `:latest` throughout. At planning time, identify and pin a specific stable version tag. Do not use `:latest` in production compose templates — upstream rendering regressions have occurred in minor releases.
- **Target host architecture:** Research notes ARM64 rendering issues with `linuxserver/obsidian` (black screen on some Raspberry Pi and Apple Silicon VM configurations). If the deployment host is ARM64, additional GPU/Mesa flag validation is needed before committing to the compose template.
- **Obsidian Sync subscription cost:** `obsidian-headless` requires an active Obsidian Sync subscription per user (~$8/month). This is an ongoing per-user external cost — not a technical gap, but a business constraint that `cognivault-ctl add-user` output should surface explicitly to operators.
- **VNC GUI as truly optional:** The roadmap should treat `linuxserver/obsidian` as an optional service block enabled via `cognivault-ctl add-user --with-gui`. Phase 2 should validate it, but the default provisioning path should not require it.

## Sources

### Primary (HIGH confidence)
- [Qdrant Multitenancy Guide](https://qdrant.tech/documentation/guides/multitenancy/) — single-collection recommendation, `is_tenant: true` payload index, collection-per-tenant warning
- [Qdrant 1.16 Tiered Multitenancy](https://qdrant.tech/blog/qdrant-1.16.x/) — shard promotion mechanism for large tenants
- [linuxserver/docker-obsidian GitHub](https://github.com/linuxserver/docker-obsidian) — s6-overlay architecture, Selkies base, shm_size requirement, ARM64 rendering issues (#25)
- [LinuxServer.io Obsidian Docs](https://docs.linuxserver.io/images/docker-obsidian/) — environment variables, port layout, CUSTOM_USER/PASSWORD
- [obsidianmd/obsidian-headless GitHub](https://github.com/obsidianmd/obsidian-headless) — OBSIDIAN_AUTH_TOKEN, `ob sync --continuous`, Node.js 22 requirement
- [Prometheus file_sd_configs docs](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#file_sd_config) — dynamic target discovery pattern
- [Caddy reverse_proxy directive](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) — WebSocket automatic upgrade, path strip
- [Docker Resource Constraints](https://docs.docker.com/engine/containers/resource_constraints/) — deploy.resources.limits syntax

### Secondary (MEDIUM confidence)
- [corelab.tech Obsidian Docker Compose guide (2026)](https://corelab.tech/obsidian/) — `lscr.io/linuxserver/obsidian:latest` as 2026 community recommendation
- [Obsidian Sync Headless Client announcement](https://devops-geek.net/devops-lab/obsidian-sync-gets-a-headless-client-a-game-changer-for-linux-automation-and-devops-workflows/) — February 2026 release confirmation
- [Obsidian Forum: Headless Sync auth token](https://forum.obsidian.md/t/headless-sync-how-to-get-obsidian-auth-token-variable/111740) — interactive auth requirement confirmed by community
- [SQLite per-tenant database pattern](https://turso.tech/blog/give-each-of-your-users-their-own-sqlite-database-b74445f4) — per-user SQLite isolation rationale
- [Docker Compose project isolation best practices](https://www.kubeblogs.com/how-to-avoid-issues-with-docker-compose-due-to-same-folder-names-project-isolation-best-practices/) — COMPOSE_PROJECT_NAME pattern

### Tertiary (LOW confidence — validate during implementation)
- [Electron SIGSEGV in Docker issue #41975](https://github.com/electron/electron/issues/41975) — seccomp/sandbox crash mechanism; host-specific, needs validation on target architecture
- [VNC password encryption weakness — FortiGuard](https://www.fortiguard.com/encyclopedia/ips/21976/vnc-server-weak-password-encryption) — VNC 8-char truncation; mitigated by using KasmVNC HTTPS layer instead of raw VNC auth

---
*Research completed: 2026-03-13*
*Ready for roadmap: yes*
