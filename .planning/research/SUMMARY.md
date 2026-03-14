# Project Research Summary

**Project:** CogniVault v2.0 — Multi-User / Multi-Tenant Migration
**Domain:** Single-container multi-tenant knowledge access service with per-user Obsidian Sync
**Researched:** 2026-03-14
**Confidence:** MEDIUM-HIGH (obsidian-headless is beta; auth token flow partially inferred from forum posts; all other areas HIGH)

## Executive Summary

CogniVault v2.0 migrates an existing single-tenant Fastify knowledge-access API to a multi-tenant architecture supporting N operator-provisioned users, each with their own Obsidian vault kept in sync via `obsidian-headless`. The architectural decision is settled and locked in PROJECT.md: a single Node.js container with registry-based tenant routing replaces the per-user Docker container model discarded in Phase 16 due to resource explosion and VNC complexity. The recommended approach is a `users.json` registry loaded into an in-memory map at startup, chokidar-based hot-reload for zero-downtime user management, per-user `ob sync --continuous` child processes managed inside the Fastify process, and Qdrant payload-based tenant isolation — all patterns confirmed by Qdrant's official multitenancy documentation and Node.js process management best practices.

The key risk is `obsidian-headless` itself: it is a beta tool (v0.0.6, released March 2026) with an undocumented auth token file path, unconfirmed non-interactive headless behavior, and no Linux ARM64 native binary. Every other component in the stack (Fastify, Drizzle, Qdrant, Commander.js, execa, chokidar) is stable and well-documented. The project must treat `ob sync --continuous` as a black box that can crash at any time and build the process manager with exponential backoff restart and pre-start stale lock cleanup from day one. The stale `.sync.lock` pitfall is the single highest-probability failure mode: it silently halts a user's vault sync indefinitely after any unclean process exit.

The migration is additive. The v1.0 feature set (hybrid search, context packs, multi-format indexing, Prometheus metrics, Grafana dashboards) is fully preserved and unchanged in design. V2.0 adds a user registry layer, modifies auth and indexing plugins to be multi-user-aware, adds a CLI for user lifecycle management, and rewrites the Dockerfile from the Phase 16 `linuxserver/obsidian` base to `node:22-slim` with `obsidian-headless` installed globally. The dependency graph is explicit and the build order is non-negotiable: registry first, then auth, then data layer, then routes and indexing, then CLI, then Docker.

## Key Findings

### Recommended Stack

The existing stack (Fastify 5, TypeBox, Zod, Drizzle + SQLite, Qdrant, OpenAI SDK, prom-client, pino, Docker Compose) requires no architectural replacement. Two production dependencies are added: `commander@14.x` for the admin CLI and `execa@9.x` for supervised child process management of `ob sync` processes. `obsidian-headless@0.0.6` is installed globally in the Docker image (`npm install -g obsidian-headless`) — it is CLI-only with no programmatic Node.js API. The Dockerfile base changes from `linuxserver/obsidian` to `node:22-slim`, dropping the VNC and GUI stack entirely.

**Core new technologies:**
- `obsidian-headless@0.0.6`: run `ob sync --continuous` per user — the only official headless Obsidian Sync client; no alternative exists
- `commander@14.x`: parse `add-user`, `remove-user`, `list-users` CLI subcommands — de facto standard, TypeScript-native, full ESM support
- `execa@9.x`: supervise long-running `ob sync` child processes — better TypeScript types and stdout piping than raw `child_process.spawn`; ESM-only, matches existing codebase
- `chokidar` (or mtime polling): watch `users.json` for hot-reload — raw `fs.watch()` is unreliable on Linux/Docker and must not be used alone
- Qdrant single collection with `user_id` payload index (`is_tenant: true`): official recommended multitenancy pattern; avoids the 1,000-collection Cloud limit

**Critical version/platform constraints:**
- `obsidian-headless` requires Node.js 22 — matches existing runtime
- `execa@9.x` is ESM-only — compatible with existing ESM codebase
- Docker image must target `linux/amd64` — Linux ARM64 binaries for obsidian-headless not confirmed available
- `commander@14.x` requires Node.js 18+ — compatible

**What NOT to add:**
- PM2 — duplicates what a Map + execa already handles; unnecessary complexity
- Per-user Docker containers — resource explosion, architectural decision closed
- LangChain / LlamaIndex — unchanged from v1.0 rejection; custom chunker is sufficient
- keytar / gnome-keyring — rely on `OBSIDIAN_AUTH_TOKEN` env var pattern instead

### Expected Features

The registry is the keystone dependency for every v2.0 feature. It must be implemented and validated before anything else is built.

**Must have — v2.0 launch blockers (P1):**
- `users.json` registry with atomic writes (temp file + rename) and hot-reload via chokidar — fundamental tenant config store
- API key → `user_id` in-memory O(1) lookup with per-request tenant context — zero I/O on hot path
- Qdrant `user_id` payload index (`is_tenant: true`) + mandatory `must` filter on all queries — vector isolation
- SQLite `user_id` column migration with composite primary keys — index state isolation
- Per-user OpenAI API key injection at embedding time — cost attribution and rate limit isolation
- `ob login` + `ob sync-setup` integration in `add-user` CLI — user provisioning
- `ob sync --continuous` process spawn + exponential backoff restart + stale lock cleanup before every start — continuous sync
- `add-user`, `remove-user`, `list-users` CLI commands — operator lifecycle management

**Should have — post-core-validation (P2):**
- Multi-tenant Prometheus metrics with `user_id` label — per-user observability
- `/admin/sync-status` REST endpoint — programmatic process health monitoring
- Per-user Grafana dashboard filter variable — operational visibility
- Sync process crash alerting with consecutive failure threshold — production stability signaling

**Defer to v3+:**
- User-level rate limiting — not needed at 1-5 users
- Vault encryption key management (`ob sync-setup --password`) — only when encrypted vaults required
- Cross-encoder reranking (RET-04, previously deferred from v1.0)

**Explicit anti-features (never build):**
- Per-user Docker containers — resource explosion, architectural decision closed in PROJECT.md
- Per-user Qdrant collections — collection limit, management overhead, Qdrant docs advise against
- Caddy reverse proxy for tenant routing — overkill; tenant resolved by API key, not subdomain
- OAuth / SSO — massive complexity for an operator-managed self-hosted tool
- Cross-user vault search — security violation
- Obsidian GUI / VNC access — superseded by obsidian-headless

### Architecture Approach

The system is a single CogniVault container containing: a Commander.js CLI layer that reads/writes `users.json` atomically; a `UserRegistry` class (in-memory `Map<apiKey, UserRecord>`, EventEmitter for change events, hot-reload via chokidar with debounce + Zod validation + parse-failure safety); a modified Fastify auth plugin that resolves `request.user` from the registry on every request; per-user `VaultIndexer` instances in a `Map<userId, VaultIndexer>`; per-user SQLite databases at `{dataDir}/{userId}/index.db`; per-user `ob sync --continuous` child processes managed by a `SyncManager` class with exponential backoff and pre-start lock cleanup; and a single shared Qdrant collection filtered by `user_id` payload field. The CLI communicates with the server exclusively via the filesystem (`users.json` + chokidar watch) — no IPC socket needed.

**Major components (build order = dependency order):**

1. **UserRegistry class** (`src/lib/user-registry.ts`) — pure class, no Fastify deps; in-memory `Map<apiKey, UserRecord>`, `load()`, `lookup()`, EventEmitter change events; testable without a server
2. **Registry Fastify plugin** (`src/plugins/registry.ts`) — wraps UserRegistry, adds chokidar watch, decorates `fastify.registry`; must load before all other plugins
3. **Auth plugin (modified)** (`src/plugins/auth.ts`) — replaces `@fastify/bearer-auth` static key with `fastify.registry.lookup(token)`; attaches `request.user: UserRecord`; type-augments `FastifyRequest`
4. **Config (modified)** (`src/config.ts`) — remove `COGNIVAULT_API_KEY`, `VAULT_PATH`, `OPENAI_API_KEY`; add `USERS_FILE`, keep `COGNIVAULT_DATA_DIR`
5. **Per-user DB plugin** (`src/plugins/db.ts`) — `fastify.dbs: Map<userId, BetterSQLite3Database>`; path `{dataDir}/{userId}/index.db`; SQLite migration adds `user_id` column to existing tables
6. **Per-user Vault + Embedder** — factory functions per-request from `request.user`; embedder cached per-userId in a Map to avoid repeated instantiation overhead
7. **Per-user Indexer + Pipeline** — `Map<userId, VaultIndexer>` + `Map<userId, PQueue>`; start/stop wired to registry change EventEmitter events
8. **Route modifications** — pass `request.user.userId` as Qdrant `must` filter in all search, context, and admin operations; `UserScopedQdrant` wrapper enforces this structurally
9. **SyncManager** (`src/lib/sync-manager.ts`) — spawn `ob sync --continuous` per user with isolated `env`; exponential backoff restart (1s→2s→4s→...→60s cap); pre-start stale lock removal; mark degraded after 5 consecutive failures in 5 minutes
10. **CLI** (`src/cli/`) — Commander.js `add-user`, `remove-user`, `list-users`, `docker-start`; shared `registry-file.ts` Zod schema with server; atomic writes via temp file + rename
11. **Dockerfile + docker-compose rewrite** — `node:22-slim`, global obsidian-headless, tini as PID 1, `linux/amd64` platform pin; `docker-start` CLI as container entrypoint
12. **Integration tests** — cross-tenant isolation (User A cannot see User B's vectors), process lifecycle (stale lock recovery), registry hot-reload under concurrent CLI write + API request, zombie process check

### Critical Pitfalls

1. **Stale `.sync.lock` blocks all future syncs after unclean ob exit** — Before every `ob sync --continuous` spawn, check and remove `<vault>/.obsidian/.sync.lock`. Any lock older than 10 seconds is definitionally stale. Implement lock cleanup in `SyncManager.start()` as the first step, not an afterthought. Also run cleanup before each backoff restart.

2. **obsidian-headless auth token collision via shared `$HOME`** — Never rely on `$HOME/.obsidian-headless/auth_token` in multi-user context. Extract the auth token after `ob login` at `add-user` time, store it in the registry (encrypted at rest if possible), and inject it per-process via `OBSIDIAN_AUTH_TOKEN` env var. Spawn each child process with an isolated `env` object; never inherit parent env.

3. **Missing `user_id` filter in any Qdrant query leaks cross-tenant vectors** — Wrap all Qdrant interactions in a `UserScopedQdrant` service requiring `userId` as a mandatory first argument. Audit every v1.0 Qdrant call site during migration. Add cross-tenant isolation integration test: index for User A, search as User B, assert zero results.

4. **Node.js as PID 1 accumulates zombie `ob` processes** — Add `tini` to the Dockerfile `ENTRYPOINT`. Without it, grandchild processes from `ob sync` become orphans that Node.js cannot reap. Spawn `ob` with `detached: false` and kill the process group (negative PID) on SIGTERM.

5. **Registry file hot-reload race condition corrupts user mappings** — CLI must write `users.json` atomically: write to temp file in same directory, then `fs.rename()` (`write-file-atomic` npm package). The server's chokidar handler must debounce by 50-100ms, parse in try/catch, and keep the last-known-good registry on parse failure — never swap in a failed parse.

6. **`ob sync --continuous` crash-restart loop exhausts resources** — Implement exponential backoff (1s, 2s, 4s... cap 60s) with a consecutive failure threshold. After 5 failures in 5 minutes, mark the user's sync as degraded and stop auto-restarting. Emit a metric. This must be in the initial SyncManager design.

7. **OpenAI singleton client causes per-request API key leakage** — Construct `new OpenAI({ apiKey: user.openaiKey })` per-request or cache instances per-userId in a Map on the embedder plugin. Never set global SDK state. At 5-20 concurrent users, per-request or cached instantiation is both safe and correct.

## Implications for Roadmap

The architecture research provides an explicit dependency graph and a 6-phase build order. The ordering is non-negotiable due to hard data-flow dependencies.

### Phase 1: Registry Foundation
**Rationale:** `UserRegistry` is the keystone dependency — auth, indexing, CLI, and process management all depend on it. Establish the data contract and plugin structure first so all subsequent phases can build against a stable interface. The registry file format and Zod schema must be finalized here because both CLI (writes) and server (reads) share it.
**Delivers:** `UserRegistry` class, Registry Fastify plugin, modified `config.ts` (remove single-user env vars, add `USERS_FILE`), `users.json` schema (Zod-validated), atomic file write utility, chokidar-based hot-reload with debounce + parse-failure safety that keeps last-known-good registry.
**Addresses:** users.json registry (P1 table stake), registry hot-reload (P1 table stake)
**Avoids:** Registry hot-reload race condition (Pitfall 6), `fs.watch` unreliability on Linux (Pitfall 7)
**Research flag:** Standard patterns — no phase research needed

### Phase 2: Multi-Tenant Auth Layer
**Rationale:** Auth is the most cross-cutting change. `request.user` must be established as the tenant context source before any per-user data layer work. Once auth decorates `request.user`, every downstream plugin builds against a stable interface and the security boundary is clear.
**Delivers:** Modified `auth.ts` (registry lookup replaces static key), `FastifyRequest` type augmentation for `request.user: UserRecord`, integration test proving cross-tenant rejection (User A key returns 401 on all User B routes).
**Addresses:** API key → user_id lookup (P1 table stake)
**Avoids:** Cross-tenant auth bypass; establishes per-user context early, preventing the OpenAI singleton key leakage pattern (Pitfall 7)
**Research flag:** Standard Fastify `onRequest` hook patterns — no phase research needed

### Phase 3: Data Layer Migration
**Rationale:** SQLite migration must precede any per-user data writes. Qdrant `user_id` payload index must exist before the first user is provisioned (creating it on a populated collection works but creating it before data is cheaper). These are the data isolation foundations; all phases that write data depend on correct multi-tenant schema.
**Delivers:** Drizzle migration adding `user_id TEXT NOT NULL DEFAULT 'default'` to all index state tables with composite primary keys; per-user SQLite plugin (`fastify.dbs: Map<userId, BetterSQLite3Database>`); Qdrant `user_id` payload index with `is_tenant: true`; `UserScopedQdrant` wrapper class enforcing mandatory `userId` parameter on all query/upsert methods.
**Addresses:** SQLite user_id migration (P1), Qdrant user_id isolation (P1)
**Avoids:** Single-tenant schema applied to multi-tenant data causing hash collisions and cross-user reindexes (Pitfall 8), missing Qdrant filter (Pitfall 4)
**Research flag:** Standard patterns — migration is additive; Qdrant multitenancy and `is_tenant` index syntax are well-documented

### Phase 4: Per-User Indexing and Search Routes
**Rationale:** With auth context and data layer in place, the indexing stack and API routes can be wired for multi-tenancy. Per-user VaultIndexer and Pipeline instances depend on the registry change EventEmitter model (Phase 1) and the per-user DB (Phase 3). Route modifications are minor — passing `userId` as a Qdrant filter via the `UserScopedQdrant` wrapper.
**Delivers:** `fastify.indexers: Map<userId, VaultIndexer>` with registry-event-driven start/stop; per-user PQueue + embedder (per-user OpenAI client cached by userId); per-request VaultManager factory; search/context/admin routes updated to pass `request.user.userId` through `UserScopedQdrant`; cross-tenant leak integration test (index for User A, search as User B, assert zero results); per-user Prometheus metric labels wired.
**Addresses:** Qdrant user_id isolation (P1), per-user OpenAI key injection (P1), per-user vault path routing (P1)
**Avoids:** Global OpenAI SDK key leakage under concurrency (Pitfall 3), missing Qdrant filter on non-happy-path operations (Pitfall 4), singleton vault/embedder Fastify decoration causing race conditions (Architecture Anti-Pattern 5)
**Research flag:** Standard patterns — extends existing v1.0 plugin structure; no novel integration surface

### Phase 5: CLI and obsidian-headless Integration
**Rationale:** The CLI depends on the registry file format being finalized (Phase 1) and the SyncManager process model being designed. Isolating CLI and obsidian-headless work from the core API phases means CLI failures do not block multi-tenant routing. This is the highest-complexity phase due to obsidian-headless beta behavior — it must not be tangled with data layer work.
**Delivers:** Commander.js CLI entry point (`src/cli/`); `add-user` command (runs `ob login`, `ob sync-setup`, writes registry atomically); `remove-user` command (soft-delete via `status: "removing"`, grace period drain, Qdrant/SQLite cleanup, SIGTERM to sync process); `list-users` command (table + JSON output); `docker-start` command (staggered obsidian-headless process spawning then Fastify start); `SyncManager` class with exponential backoff restart, stale lock cleanup before every start, degraded-state threshold; per-user `OBSIDIAN_AUTH_TOKEN` env var injection (never shared `$HOME`).
**Addresses:** `add-user`/`remove-user`/`list-users` CLI (P1), obsidian-headless sync process management (P1)
**Avoids:** Auth token `$HOME` collision (Pitfall 2), stale `.sync.lock` (Pitfall 1), crash-restart loop exhausting resources (Pitfall 9), CLI TOCTOU on remove-user leaving orphaned Qdrant vectors (Pitfall 11)
**Research flag:** NEEDS PHASE RESEARCH — `ob login` non-interactive behavior (`--email`/`--password` flags without TTY) is not confirmed by official documentation. Must run `ob login --email test@x.com --password secret < /dev/null` inside a target container and verify non-interactive exit before designing the `add-user` command flow. If interactive TTY is required, the workaround (capture token during interactive `add-user`, store in registry for process restart use) must be designed explicitly. Also: verify auth token file path (`$HOME/.obsidian-headless/auth_token` vs `$HOME/.config/obsidian-headless/auth_token`) against installed package source.

### Phase 6: Docker Rewrite and Integration Hardening
**Rationale:** Deployment layer comes last. All application code must be complete before the Dockerfile is finalized. Tini must be added here (as PID 1) and the `linux/amd64` platform target locked. Integration tests at this phase prove end-to-end isolation and process lifecycle recovery in the actual container environment.
**Delivers:** Dockerfile rewrite (`node:22-slim`, `--platform=linux/amd64`, global `npm install -g obsidian-headless@0.0.6`, tini as PID 1, Docker build smoke test `RUN ob --version`); `docker-compose.yml` rewrite (single CogniVault container + Qdrant + Prometheus + Grafana); end-to-end integration tests (multi-user auth isolation, stale lock recovery after simulated unclean kill, registry hot-reload under concurrent CLI write + API request, zombie process check via `ps aux | grep Z`); `/admin/sync-status` endpoint (P2); updated `.env.example`.
**Addresses:** Docker containerization (P1), platform compatibility, P2 observability features
**Avoids:** Node.js PID 1 zombie accumulation (Pitfall 5), Linux ARM64 binary missing (Pitfall 10)
**Research flag:** NEEDS PHASE RESEARCH — verify obsidian-headless installs cleanly on `node:22-slim` (`linux/amd64`) before committing to this base. Confirm the Linux x86_64 prebuilt binary is present by running `npm install -g obsidian-headless && ob --version` inside a fresh container. If the binary is absent, evaluate `--platform=linux/amd64` emulation overhead. Also confirm tini is available in `node:22-slim` or document the `apt-get install -y tini` step.

### Phase Ordering Rationale

- Registry before auth (Phase 1 before 2): auth plugin calls `fastify.registry.lookup()` — registry must be a decorated Fastify plugin dependency before auth can reference it
- Data layer before indexing (Phase 3 before 4): SQLite migration must run before any per-user indexer writes index state; Qdrant payload index must exist before any vector upserts or the `is_tenant` optimization is missed entirely
- API complete before CLI (Phases 1–4 before Phase 5): `add-user` CLI writes a `users.json` that the server must parse correctly — registry file schema must be finalized first; CLI cannot be integration-tested before the server can read what the CLI writes
- CLI complete before Docker (Phase 5 before 6): `docker-start` CLI command is the container entrypoint; it must exist and be tested before the Dockerfile is written
- Pitfalls 1, 2, 6, 7, and 9 are all process/registry lifecycle issues addressed across Phases 1 and 5 — the write side (CLI) and read side (server) are separate work streams that both require hardening

### Research Flags

**Phases needing deeper research during planning:**

- **Phase 5 (CLI + obsidian-headless):** The `ob login` non-interactive flow is the single most uncertain point in all of v2.0. Run the command in a headless container before any design work. If interactive TTY is required, the entire `add-user` command design changes. Also verify the auth token file path from the installed package source — the forum-sourced path should not be treated as stable.
- **Phase 6 (Docker):** Verify obsidian-headless installs and executes on `node:22-slim` (`linux/amd64`). The package ships prebuilt binaries — confirm the Linux x86_64 binary is present. This must be validated before any Dockerfile is committed.

**Phases with standard patterns (skip research-phase):**
- **Phase 1 (Registry):** Fastify plugin patterns, chokidar, `write-file-atomic`, Zod validation are all well-documented with extensive examples
- **Phase 2 (Auth):** Fastify `onRequest` hook + request decoration is canonical; type augmentation pattern is established
- **Phase 3 (Data Layer):** Drizzle migration workflow and Qdrant payload index creation are documented with official code examples
- **Phase 4 (Indexing + Routes):** Extends existing v1.0 patterns; adds `userId` parameter to existing service method signatures

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | commander, execa, chokidar all stable and well-documented; obsidian-headless is MEDIUM due to beta status but no alternative exists; all other existing stack unchanged |
| Features | HIGH | P1/P2 feature split is clear and load-bearing; anti-features are explicitly documented with rationale; obsidian-headless auth flow remains MEDIUM due to non-interactive behavior uncertainty |
| Architecture | HIGH | Read directly from v1.0 source code; Fastify, Qdrant, Node.js child_process patterns are HIGH confidence; build order dependency graph is explicit and verified |
| Pitfalls | HIGH for process/multi-tenancy patterns; MEDIUM for obsidian-headless specifics | 11 pitfalls documented with prevention, recovery, and phase mapping; obsidian-headless pitfalls partially inferred from beta software behavior and forum posts rather than official documentation |

**Overall confidence:** MEDIUM-HIGH — all infrastructure and architecture decisions are HIGH confidence; the MEDIUM ceiling comes solely from obsidian-headless beta status. The workarounds for obsidian-headless uncertainty are well-defined and must be verified empirically in Phase 5 research before implementation begins.

### Gaps to Address

- **`ob login` non-interactive behavior:** Must be verified empirically before Phase 5 planning begins. Run `ob login --email test@x.com --password secret < /dev/null` in a target container. If a TTY prompt appears, the `add-user` command must be explicitly interactive and the auth token captured at that time. This changes the `add-user` UX design.
- **Auth token file path:** Not officially documented. Verify by inspecting the obsidian-headless package source after install. The forum-sourced path (`$HOME/.obsidian-headless/auth_token`) must not be treated as stable until confirmed against v0.0.6 package contents.
- **obsidian-headless Linux ARM64:** If the production Docker host is ARM64, `linux/amd64` emulation adds overhead. Track the obsidian-headless GitHub releases for ARM64 binary additions. For now, pin to `--platform=linux/amd64`.
- **Obsidian Sync WebSocket protocol stability:** obsidian-headless wraps Obsidian's sync protocol, which is not a public API. If Obsidian changes the protocol, `ob sync --continuous` breaks silently. Pin to exact version in Dockerfile and build the process manager to detect sync staleness (no events for N minutes triggers restart + alert).
- **`users.json` plaintext credentials:** `obs_password` and `openai_key` are stored in plaintext in v2.0. This is acceptable for a self-hosted operator-controlled deployment but must be prominently documented in `add-user` CLI output. Future: env var references instead of inline values.

## Sources

### Primary (HIGH confidence)
- CogniVault v1.0 source code (read directly, March 2026) — plugin system, auth pattern, indexer, pipeline, config schema
- [obsidian-headless GitHub (obsidianmd)](https://github.com/obsidianmd/obsidian-headless) — command reference, `--email`/`--password` flags, `--config-dir`, `--continuous` mode
- [obsidian-headless GitHub — Stale .sync.lock Issue #4](https://github.com/obsidianmd/obsidian-headless/issues/4) — stale lock behavior confirmed
- [Qdrant Multitenancy Documentation](https://qdrant.tech/documentation/guides/multitenancy/) — single collection + payload partitioning, `is_tenant: true` optimization
- [Qdrant 1.16 tiered multitenancy](https://qdrant.tech/blog/qdrant-1.16.x/) — tiered approach for unequal tenant sizes (not needed at 1-10 users)
- [Commander.js GitHub](https://github.com/tj/commander.js) — CLI subcommand patterns, ESM support
- [npm: execa@9.x](https://www.npmjs.com/package/execa) — ESM-only, TypeScript types
- [npm: commander@14.x](https://www.npmjs.com/package/commander) — current stable
- [npm: obsidian-headless@0.0.6](https://www.npmjs.com/package/obsidian-headless) — published March 2026
- [npm: obsidian-headless changelog 2026-02-27](https://obsidian.md/changelog/2026-02-27-sync/) — official release announcement
- [Fastify plugin system docs](https://fastify.dev/docs/latest/Reference/Plugins/) — `fp()`, `fastify.decorate()`, type augmentation
- [write-file-atomic npm package](https://www.npmjs.com/package/write-file-atomic) — atomic registry writes
- [Node.js child_process docs](https://nodejs.org/api/child_process.html) — spawn, SIGTERM, process group kill, env isolation
- [Node.js as PID 1 zombie pitfalls — nodebestpractices](https://github.com/goldbergyoni/nodebestpractices/blob/master/sections/docker/graceful-shutdown.md) — tini requirement
- [Drizzle ORM SQLite WAL concurrent writes](https://github.com/drizzle-team/drizzle-orm/discussions/1994) — WAL mode verification

### Secondary (MEDIUM confidence)
- [Obsidian Forum: OBSIDIAN_AUTH_TOKEN retrieval](https://forum.obsidian.md/t/headless-sync-how-to-get-obsidian-auth-token-variable/111740) — token file location; community forum, not official docs
- [Obsidian Forum: ob sync-setup keychain issue](https://forum.obsidian.md/t/ob-sync-setup-fails-on-headless-linux-keychain-unavailable/111679) — v0.0.3 keychain fix; community report
- [OpenAI per-user key safety in multi-tenant Node.js — openai-agents-js Issue #642](https://github.com/openai/openai-agents-js/issues/642) — per-request instantiation pattern validated
- [fs.watch reliability issues — Node.js issue #47058](https://github.com/nodejs/node/issues/47058) — cross-platform unreliability confirmed
- [Obsidian Sync Headless Client — Hacker News](https://news.ycombinator.com/item?id=47197267) — community discussion, deployment notes
- [Node.js Child Process signals in Docker](https://maximorlov.com/process-signals-inside-docker-containers/) — signal forwarding behavior

### Tertiary (LOW confidence)
- [Multi-tenant Node.js patterns](https://medium.com/@shital.pimpale5/creating-scalable-multi-tenant-applications-with-node-js-0a49babc97d5) — general multi-tenancy patterns; used for anti-pattern validation only

---
*Research completed: 2026-03-14*
*Ready for roadmap: yes*
