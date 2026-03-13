# Pitfalls Research

**Domain:** Multi-user containerized deployment — adding per-user Obsidian+VNC+CogniVault containers with shared Qdrant to an existing single-user Node.js REST API service
**Researched:** 2026-03-13
**Confidence:** MEDIUM-HIGH (container/VNC/Electron-in-Docker pitfalls well-documented; Obsidian headless sync pitfalls MEDIUM due to beta status; Qdrant multi-tenancy HIGH based on official docs)

---

## Critical Pitfalls

### Pitfall 1: Qdrant Tenant Filter Omission Leaks All User Data

**What goes wrong:**
A query to Qdrant that omits the `tenant_id` filter returns vectors from all users. Every search, scroll, or delete operation without an explicit tenant payload filter is a cross-tenant data breach. This is not a Qdrant bug — it is a design requirement. Qdrant has no concept of row-level security; it is the application layer's responsibility to add the filter to every single operation. One missing filter in a code path (e.g., the reindex cleanup loop, a reconciliation endpoint, or an admin search) exposes the entire vault of every user.

**Why it happens:**
CogniVault v1.0 is single-user. No filters existed because there was one collection for one user. When adding multi-tenancy, developers add a `user_id` field to new upserts but forget to audit every existing read/scroll/delete call path. The single-user code paths often have no tenant filter and continue to compile and run without errors — they just silently query all tenants.

**How to avoid:**
- Create a `QdrantTenantClient` wrapper class that accepts a `userId` on construction and automatically injects the tenant filter into every query, scroll, and delete call. No raw Qdrant client calls outside this wrapper.
- Enable the `is_tenant: true` flag on the `user_id` payload index (available since Qdrant v1.11.0). This co-locates vectors by tenant for performance and is the correct signal to Qdrant's storage layer.
- Write a single integration test that: (1) indexes 3 notes for user A and 3 for user B, (2) asserts user A's search never returns user B's notes, (3) runs this against every search endpoint and every service method that touches Qdrant.
- Code review checklist: any file touching the Qdrant client must use the tenant wrapper, never the raw client.

**Warning signs:**
- Search results return notes from unexpected vaults or users.
- Vector count per collection grows faster than expected (everyone indexing into one namespace).
- The cleanup/reindex path counts more vectors than the current user has notes.

**Phase to address:**
Phase 1 (Qdrant tenant isolation). This is the highest-severity issue. Must be the first architectural decision and must ship with the first multi-user container. Build the tenant wrapper before any other multi-user code.

---

### Pitfall 2: Electron/Obsidian in Docker Black Screen and Sandbox Crashes

**What goes wrong:**
Electron apps require a display server and specific Linux kernel capabilities to render. In Docker, this breaks in several ways: (1) Black screen on launch — Obsidian starts, the process is running, but nothing renders. Confirmed in `linuxserver/docker-obsidian` issues: versions after 1.8.7 show black screen on ARM64/Raspberry Pi due to GPU/Mesa rendering failures. (2) Electron SIGSEGV crash — Docker's default seccomp profile blocks several syscalls that Chromium (Electron's renderer) requires, causing silent crashes. (3) Memory exhaustion from virtual framebuffer — the KasmVNC/Selkies-based containers default to a 16K virtual resolution; each container allocates a full framebuffer at that resolution, eating gigabytes of RAM before Obsidian even opens.

**Why it happens:**
Electron is not designed for containerized headless deployment. It uses `--sandbox` mode by default, which requires `clone()` and `unshare()` syscalls that Docker's default seccomp policy blocks. GPU acceleration, even with no physical GPU, requires DRI device access. The linuxserver Docker image works around most of this, but not all host/architecture combinations work cleanly.

**How to avoid:**
- Use the official `linuxserver/obsidian` image — it has the required seccomp adjustments and display server configured correctly. Do not attempt to build a custom Electron-in-Docker image from scratch.
- Always set `shm_size: "1gb"` in docker-compose — Chromium uses `/dev/shm` for IPC and crashes without adequate shared memory.
- Add `--no-sandbox` as the Obsidian launch argument only if seccomp issues persist; this reduces isolation but is necessary for some host kernel configurations.
- Clamp the virtual display resolution to 1920x1080 via environment variable (e.g., `DISPLAY_WIDTH=1920 DISPLAY_HEIGHT=1080`). The default 16K resolution wastes memory without benefit.
- On ARM64 (Raspberry Pi, Apple Silicon VMs): disable GPU acceleration device mapping — it breaks rendering more than it helps. Use CPU rendering.
- Test the exact container image version before pinning it. Pin the working version tag; do not use `latest`. Upstream image updates have broken rendering in minor releases.

**Warning signs:**
- Container logs show `V3D GPU` or `Mesa` warnings during startup.
- VNC session connects but shows only a black or grey screen.
- Container restarts in a loop with no error in application logs (seccomp SIGSEGV is often silent).
- Memory usage grows continuously without Obsidian being actively used (framebuffer leak at high virtual resolution).

**Phase to address:**
Phase 1 (Container image selection and base compose file). Validate the chosen image works on the target host architecture before building anything on top of it. Discovering this in Phase 3 requires major rework.

---

### Pitfall 3: VNC Ports Exposed Without Encryption or Network Isolation

**What goes wrong:**
VNC's built-in authentication uses DES encryption with a static key and truncates all passwords to 8 characters maximum. An 8-character VNC password is brute-forceable in hours with modern hardware. If VNC ports (5900-5901, or KasmVNC's 3000) are exposed on the host network without TLS or an SSH tunnel, the session is both sniffable (plaintext video stream) and brute-forceable. In a multi-user deployment where each user gets their own VNC port, the attack surface multiplies: with 10 users and sequential port assignments (5901-5910), all sessions are discoverable via a single port scan.

**Why it happens:**
Docker Compose port bindings like `5901:5900` bind to `0.0.0.0` by default, exposing the port on all network interfaces including the host's external interface. Developers test locally where this is fine, then deploy to a server without changing the binding. VNC's weak encryption is a historical design choice — it was never designed for internet exposure.

**How to avoid:**
- Never expose VNC ports directly to the internet. Bind to `127.0.0.1` only: `"127.0.0.1:5901:5900"` in docker-compose. Access through a reverse proxy (nginx, Caddy) with TLS termination, or via SSH port forwarding.
- For KasmVNC/Selkies-based images (linuxserver): use the built-in HTTPS/WSS access on port 3000 with a signed TLS certificate. This provides proper encryption and is the preferred path over raw VNC.
- Use a per-user web subdomain (e.g., `user1.vault.internal`) behind a single TLS-terminated reverse proxy. This exposes one HTTPS port, not N VNC ports.
- Set unique, strong VNC passwords per user (minimum 16 characters for the `PASSWORD` environment variable on linuxserver containers, even though VNC internally truncates to 8 — the container's HTTP layer enforces the full password).
- Put per-user containers on an isolated Docker network. Only the reverse proxy container joins that network. No direct host port exposure.

**Warning signs:**
- `docker ps` shows port bindings like `0.0.0.0:5901->5900/tcp` instead of `127.0.0.1:5901->5900/tcp`.
- VNC sessions accessible from outside the host machine without a VPN or SSH tunnel.
- All user VNC ports are sequential and discoverable via a single subnet scan.

**Phase to address:**
Phase 1 (Network architecture and compose file design). Correct binding and network isolation must be built into the base compose template. Retrofitting network isolation after container templates are established is painful.

---

### Pitfall 4: SQLite Per-Container Isolation Broken by Shared Volume Mounts

**What goes wrong:**
CogniVault uses SQLite for index state. In a multi-user deployment, each user gets their own CogniVault container with their own SQLite database. If the SQLite files are stored on a volume that is accidentally shared across containers — or worse, if a single SQLite file is mounted into multiple containers — SQLite's file locking breaks catastrophically. On macOS Docker Desktop and on any network-mounted volume (NFS, CIFS, EFS), SQLite's `fcntl()` locking does not work reliably across processes in different containers. This causes silent database corruption, not just "database is locked" errors.

**Why it happens:**
Volume naming conflicts in Docker Compose. When multiple compose files are run from the same directory with the same project name, Docker Compose reuses volume names. A `volumes: db_data:` defined without a user-scoped prefix in multiple container definitions resolves to the same underlying volume. The schema "one container = one volume" is easy to state but hard to enforce without naming discipline.

**How to avoid:**
- Each user's container must have a uniquely named volume for their SQLite database: `cognivault_user1_db`, `cognivault_user2_db`, etc. Never use a generic name like `db_data` that collides across users.
- Use Docker Compose project names (`COMPOSE_PROJECT_NAME`) scoped per user to prevent any cross-user volume sharing.
- On Linux with local Docker storage (not Docker Desktop), SQLite across containers sharing a volume technically works because they share the same kernel for lock coordination. But this is fragile; the safe design keeps each user's SQLite in their own container with a bind mount to a user-scoped host directory (e.g., `/data/users/user1/db/`).
- Validate at startup: if the CogniVault container detects it cannot exclusively lock the SQLite file, fail fast with a clear error rather than running in a degraded state.
- Enable WAL mode regardless: `PRAGMA journal_mode=WAL` reduces lock contention within a single container for concurrent agent reads during background reindex.

**Warning signs:**
- "database is locked" errors in CogniVault logs when no agent is actively querying.
- SQLite database file timestamp shows writes from two different container process IDs.
- Index state reports files as indexed that the current user never created.
- Docker volume inspect shows the same volume mounted in multiple containers.

**Phase to address:**
Phase 1 (Volume naming scheme and directory structure). Define the per-user directory layout before writing any container management code. A mistake here causes data corruption that may not be immediately visible.

---

### Pitfall 5: Per-User Resource Exhaustion Kills All Users

**What goes wrong:**
Without memory and CPU limits, a single misbehaving user container kills the entire host. Obsidian + VNC + KasmVNC desktop environment consumes 500MB-1GB RAM at idle. If a user triggers a full vault reindex (embedding 5,000 notes via OpenAI API), the CogniVault container pegs one CPU core for 20-30 minutes. With 5 users, that is 5 concurrent potential full reindexes, consuming 5 CPU-hours if limits are not set. One container hitting a memory leak (Electron is known for memory leaks) will trigger the Linux OOM killer, which can kill containers from other users on the same host.

**Why it happens:**
Docker containers run without resource limits by default. Developers test with one or two containers and never hit resource contention. Multi-user scale is assumed to work because "containers are isolated" — but isolation is namespace-based (process/network/filesystem), not resource-based. Resource limits require explicit configuration.

**How to avoid:**
- Set memory and CPU limits on every container in the docker-compose template:
  ```yaml
  deploy:
    resources:
      limits:
        cpus: "1.5"
        memory: "2g"
      reservations:
        cpus: "0.25"
        memory: "512m"
  ```
- Obsidian+VNC container: 1.5 CPU, 2GB RAM limit is a reasonable starting point. CogniVault API container: 1 CPU, 1GB RAM.
- Set `--memory-swap` equal to `--memory` to disable swap for containers (swapping makes other containers' performance unpredictable).
- Add PID limits (`pids_limit: 200`) to prevent fork bombs.
- For the reindex operation specifically: rate-limit the OpenAI embedding calls in CogniVault's indexer to 1-2 concurrent requests per user, regardless of system load. This prevents one user's full reindex from saturating the OpenAI rate limit for all users.
- Monitor per-container resource usage via `docker stats` and expose it in the shared Grafana dashboard with per-user labels.

**Warning signs:**
- `docker stats` shows one container consuming 90%+ of host memory.
- OOM killer entries in `/var/log/syslog` (`kernel: oom-kill event`).
- VNC sessions for all users become unresponsive when one user initiates a reindex.
- Container restarts without an explicit stop command (OOM kill).

**Phase to address:**
Phase 1 (Compose template design). Resource limits must be in the initial compose template, not added later. Adding them later requires restarting all running user containers.

---

### Pitfall 6: Obsidian Headless Sync Auth Token — Interactive Setup Required, Breaks Docker Automation

**What goes wrong:**
Obsidian's headless sync client (`obsidian-headless`) requires an interactive `ob login` command to generate an `OBSIDIAN_AUTH_TOKEN`. This token is stored in `~/.obsidian-headless/auth_token` after a successful interactive login with email, password, and MFA. There is no way to generate this token programmatically without going through the interactive flow. In a Docker container lifecycle (user provisioning, container recreation, host migration), the token must be extracted manually from an interactive session, stored securely as a secret, and injected into the container via environment variable. Running `ob logout` invalidates the token permanently. The headless sync client is still in beta (as of 2026-03) and the API has already broken between beta releases.

**Why it happens:**
The `cognivault-ctl add-user` command is expected to automate user provisioning. Developers assume they can script the auth token generation. They cannot. The Obsidian auth API is not documented or exposed for programmatic use. The token acquisition step requires a human to run `ob login` interactively.

**How to avoid:**
- Design the user provisioning workflow to have a mandatory manual step: after running `cognivault-ctl add-user <username>`, the operator must run `ob login` in an interactive shell, capture the token from `~/.obsidian-headless/auth_token`, and store it as a Docker secret or in the secrets manager before the container can start successfully.
- Document this clearly in the CLI output: `cognivault-ctl add-user` should print explicit instructions for the token capture step.
- Store the token as a Docker secret (not in environment variables in the compose file, not in `.env` files on disk). Inject via `secrets:` in docker-compose v3.
- Build the headless sync container to fail fast and loudly if `OBSIDIAN_AUTH_TOKEN` is missing or invalid, rather than starting in a degraded state.
- Pin the `obsidian-headless` package version. Beta releases have broken the auth flow between versions. Do not use `latest` or `*`.
- Consider using the full Obsidian GUI (VNC-based) as the primary sync mechanism rather than the headless client, using the headless client only as a future optimization. The GUI Obsidian container handles auth via its own UI, avoiding the headless auth complexity entirely.

**Warning signs:**
- `ob login` fails inside a container (expected — requires interactive terminal).
- Container starts but vault is empty and sync never begins (silent auth failure).
- Token suddenly stops working after an `obsidian-headless` package update.
- Provisioning scripts hang waiting for interactive input that never comes.

**Phase to address:**
Phase 2 (Obsidian Sync integration). Design the provisioning workflow with the manual auth step as a first-class requirement. Attempting to fully automate this without the headless sync API being stable will cause repeated breakage.

---

### Pitfall 7: Docker Compose Scaling — Port Conflicts and Container Name Collisions

**What goes wrong:**
Deploying multiple per-user containers from the same compose file template causes port conflicts if host ports are hardcoded, and container name collisions if `container_name` is set. Docker Compose's `scale` command and replicas only work if no fixed host port or container name is specified. With 10 users each needing a VNC port and an API port, manually maintaining port assignments in a monolithic compose file is error-prone and does not scale. Volume names derived from the compose project name collide if multiple users are deployed from compose files in the same directory.

**Why it happens:**
The natural Docker Compose mental model is one `docker-compose.yml` per service. Developers extend this to one file per user, or one file with all users, and immediately hit naming collisions. The compose project name defaults to the directory name, making it identical for all user compose files in the same directory.

**How to avoid:**
- Use a dynamic compose file generation approach: `cognivault-ctl add-user` generates a `docker-compose.user1.yml` with user-scoped names and a unique port assignment tracked in a central registry (e.g., `~/.cognivault/ports.json`). Port ranges: VNC 15900-15999, API 13000-13099, one port per user.
- Always set `COMPOSE_PROJECT_NAME=cognivault_user1` when running a user's compose file. Embed this in the generated file's `.env` or in a wrapper script.
- Never set `container_name` in user compose templates — let Docker Compose derive it from the project name + service name. This ensures uniqueness without manual tracking.
- Bind host ports to `127.0.0.1` only. The reverse proxy (nginx/Caddy) routes to `127.0.0.1:<user_port>` by subdomain/path. Users never connect directly to user ports.
- Track port assignments in a state file managed by `cognivault-ctl`. On `remove-user`, release the port back to the pool. On `list-users`, show the port assignment.

**Warning signs:**
- `docker-compose up` fails with "port already in use" when adding a second user.
- `docker ps` shows containers with duplicate names with a `_2` suffix (Compose resolving conflicts automatically).
- Volumes from user A appear in user B's container (`docker volume inspect` shows unexpected mounts).

**Phase to address:**
Phase 1 (Architecture decision) and Phase 3 (CLI implementation). The port assignment and naming strategy must be decided in Phase 1. The `cognivault-ctl` tool that implements it is Phase 3.

---

### Pitfall 8: API Key Storage — Plaintext Keys in Compose Files or Docker Env

**What goes wrong:**
Per-user CogniVault instances require a unique `COGNIVAULT_API_KEY` per user. The naive approach is to put this in the `environment:` block of the compose file or in a `.env` file next to the compose file. Both approaches store the API key in plaintext on disk, readable by any process with filesystem access. If the compose directory is in a git repository, the key gets committed to version history. If the host is compromised, all user API keys are immediately available. Additionally, v1.0 used a single global API key — migrating to per-user keys requires the key validation logic to consult a key registry (database, secrets manager) rather than a simple environment variable comparison.

**Why it happens:**
Single-user v1.0 put `COGNIVAULT_API_KEY` in `.env`. The path of least resistance for multi-user is to generate a new `.env` per user. This works but stores secrets in a predictable filesystem location. Docker secrets are the correct mechanism but require Swarm mode or explicit compose v3 secrets configuration, which is more complex to set up.

**How to avoid:**
- Use Docker secrets for per-user API keys: store as `docker secret create cognivault_apikey_user1 -` (piped from a secure source). Mount via `secrets:` in compose. The container reads from `/run/secrets/cognivault_apikey` rather than an environment variable.
- If Docker secrets are too complex for the deployment environment, use a `.env` file per user in a directory with `chmod 600` permissions, owned by root. Never commit these files to git (add `**/.env` to `.gitignore` globally).
- For the API key registry: store a bcrypt hash of each user's API key in a central SQLite database managed by `cognivault-ctl`. CogniVault instances validate against this hash (or are issued unique keys and validate locally). Never store plaintext keys in any database.
- Implement key revocation: `cognivault-ctl revoke-key <username>` must immediately invalidate the key. If keys are validated locally per-container (env var comparison), revocation requires container restart — design the key validation to check a shared source if immediate revocation is required.
- Implement key rotation without service interruption: support a 30-minute overlap window where both old and new keys are valid during rotation.

**Warning signs:**
- `docker inspect <container>` shows API key in `Env` section (visible to any user with Docker socket access).
- `.env` files present in the git repository.
- All users share the same API key (no per-user isolation).
- Removing a user does not invalidate their API key immediately.

**Phase to address:**
Phase 2 (Per-user API key architecture) and Phase 3 (CLI key management). The key storage mechanism must be designed before any user containers are created. Changing the storage mechanism later requires reissuing all keys.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Single shared Qdrant collection with `user_id` filter, no wrapper class | Faster initial implementation | One missing filter anywhere = full data breach; no compile-time safety | Never — the wrapper class is 50 lines and eliminates the class of error |
| Sequential VNC port assignment in compose files | Simple to understand | Port conflicts on host, all ports exposed on `0.0.0.0`, security risk | Never in production; acceptable in local dev only with explicit firewall |
| Plaintext API keys in environment variables | Simple `.env` pattern reuse from v1.0 | Keys visible in `docker inspect`, leaked in git, not rotatable without restart | Local dev only, never in any shared or deployed environment |
| Global `obsidian-headless` package version (`*`) | Always get latest sync features | Beta breaks between releases, auth flow may change | Never — always pin the version |
| No per-container resource limits | Simpler compose template | One user OOM-kills neighbors, host becomes unresponsive | Never in multi-user; single-user dev is acceptable |
| Skipping `COMPOSE_PROJECT_NAME` per user | Fewer configuration steps | Volume and network name collisions between users | Never — two lines in a script, prevents catastrophic collisions |
| Reusing v1.0 single-user SQLite without per-user path isolation | Reuse existing code | Multiple containers writing to the same SQLite file causes corruption | Never — even if accidentally prevented by volume isolation today |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Qdrant multitenancy | Not creating payload index with `is_tenant: true` on `user_id` field | `PUT /collections/{name}/index` with `field_name: "user_id"`, `field_schema: { type: "keyword", is_tenant: true }` — without this, filter queries do full scans |
| Qdrant multitenancy | Reusing v1.0 collection without adding `user_id` payload index | Create new v2 collection with proper tenant index; do not migrate vectors into a structurally different collection |
| linuxserver/obsidian | Using `latest` tag | Pin to a specific version tag; `latest` has had rendering regressions between minor releases |
| linuxserver/obsidian | Not setting `shm_size` | Always set `shm_size: "1gb"` — Chromium/Electron crashes without adequate `/dev/shm` |
| obsidian-headless | Attempting `ob login` inside a non-interactive Docker container | Run `ob login` on the host (or a temp interactive container), extract token, inject as Docker secret |
| Docker Compose networking | Default `bridge` network allows all containers to reach each other | Create isolated per-user networks; only the reverse proxy joins the shared frontend network |
| Docker Compose volumes | Generic volume names (`db_data`) reused across user compose files | Always prefix with user ID: `cognivault_user1_db_data` |
| VNC / KasmVNC | `PASSWORD` env var on linuxserver image truncated to 8 chars internally | Use the HTTPS/WSS interface with its own auth layer, not raw VNC password auth |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| No memory limits + Electron memory leak | Host OOM, all containers killed | Set `memory: "2g"` limit per user container | First time a user leaves Obsidian open for 24+ hours |
| Per-user full reindex at same time (e.g., on host restart) | OpenAI rate limit hit, all reindexes fail | Stagger reindex startup with per-user delay; respect OpenAI rate limit headers globally across all user containers | 3+ users on same host restarting simultaneously |
| Virtual display at default 16K resolution | Each container uses 4-8GB for framebuffer | Set `DISPLAY_WIDTH=1920 DISPLAY_HEIGHT=1080` | On any machine with less than 16GB RAM per user |
| All user VNC sessions streaming at high resolution | Host network saturation | VNC quality and color depth settings; default to 16-bit color | 4+ concurrent active VNC users on same host |
| Shared Prometheus scraping all user containers | Metric cardinality explosion with per-user labels | Use consistent label schema; limit per-user metric dimensions | 10+ users generating distinct time series |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Missing `user_id` filter on any Qdrant operation | Full cross-tenant data breach — any user can read all vaults | Tenant wrapper class enforces filter at every call site; integration test asserts isolation |
| VNC ports bound to `0.0.0.0` | All user sessions exposed on host's public IP | Bind to `127.0.0.1` in compose; route through TLS reverse proxy |
| API keys stored in docker-compose `environment:` block | Keys visible via `docker inspect`, leaked in logs, git | Use Docker secrets or `chmod 600` env files; never in compose YAML |
| Per-user containers on shared Docker bridge network | Cross-container lateral movement; user A can probe user B's API port | Isolated per-user bridge networks; only reverse proxy on shared network |
| `obsidian-headless` auth token in environment variable | Token visible in `docker inspect`, process environment | Use Docker secrets; mount at `/run/secrets/obsidian_auth_token` |
| No container restart policy + no OOM monitoring | Failed user containers not restarted; silent vault sync outage | Set `restart: unless-stopped`; Grafana alerts on container-down metrics |
| Shared host Docker socket mounted in management container | Full Docker control = root on host | Avoid Docker socket in containers; use Docker CLI over SSH or a restricted API proxy |

---

## "Looks Done But Isn't" Checklist

- [ ] **Qdrant tenant isolation:** All code paths that touch Qdrant have been audited for missing `user_id` filter — verify by running user B's search while user A's notes are indexed and checking zero results from user A appear
- [ ] **VNC port exposure:** Run `ss -tlnp` on the host and verify no VNC or KasmVNC port is bound to `0.0.0.0` — only `127.0.0.1` bindings are acceptable
- [ ] **Resource limits active:** Run `docker inspect <container> | jq '.[0].HostConfig.Memory'` and verify it returns a non-zero value for every user container
- [ ] **SQLite isolation:** Run `docker volume ls` and verify no volume name appears in more than one user's container mounts
- [ ] **API key revocation:** Remove a user via `cognivault-ctl`, then verify their API key returns 401 immediately without restarting any containers
- [ ] **Obsidian sync continuity:** Restart a user's container (simulating OOM kill), verify Obsidian Sync resumes automatically without manual re-authentication
- [ ] **Compose project isolation:** Run two users' compose files from the same directory and verify no volume or network name collisions in `docker ps`, `docker volume ls`, `docker network ls`
- [ ] **Headless sync token security:** Run `docker inspect <user_container> | jq '.[0].Config.Env'` and verify the auth token does not appear as a plaintext environment variable

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Qdrant tenant filter missing — data leakage discovered | HIGH | Immediately take shared Qdrant offline; audit which queries ran without filter; notify affected users; add wrapper class; full reindex all affected users' vaults |
| VNC ports exposed publicly — brute force attempted | HIGH | Rotate all VNC passwords immediately; audit access logs; rebind all ports to `127.0.0.1`; deploy firewall rules |
| SQLite corruption from shared volume | MEDIUM | Stop affected containers; delete corrupted SQLite files; restart — CogniVault will rebuild index state from Qdrant on next startup via reconciliation |
| User container OOM-killed | LOW | Container auto-restarts if `restart: unless-stopped` is set; Obsidian Sync resumes on next start; no data loss (vault on disk is source of truth) |
| obsidian-headless auth token invalid after update | LOW | Run `ob login` interactively to generate new token; update Docker secret; restart user's container |
| API key leaked (found in git history) | HIGH | Immediately revoke via `cognivault-ctl revoke-key`; issue new key; rotate all other keys as precaution; audit git history for other secrets |
| Port conflict on host restart | LOW | `cognivault-ctl` port registry identifies the conflict; reassign port to the newer user's container; restart that container only |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Qdrant tenant filter omission | Phase 1: Tenant isolation architecture | Integration test: user A search returns zero results from user B's vault |
| Electron black screen / seccomp crash | Phase 1: Container image validation | VNC session renders Obsidian correctly on target host architecture |
| VNC ports exposed on public interface | Phase 1: Network architecture | `ss -tlnp` shows only `127.0.0.1` VNC bindings |
| SQLite shared volume corruption | Phase 1: Volume naming scheme | `docker volume inspect` shows each user has a uniquely named volume |
| Per-user resource exhaustion | Phase 1: Compose template with resource limits | `docker inspect` shows non-zero memory and CPU limits on all containers |
| obsidian-headless auth interactive requirement | Phase 2: Obsidian Sync integration | Provisioning runbook includes explicit manual auth token step; container fails fast without token |
| Compose port conflicts and name collisions | Phase 3: cognivault-ctl CLI | `cognivault-ctl add-user` for 3 users produces no port conflicts or naming collisions |
| API key plaintext storage | Phase 2: Per-user auth key architecture | `docker inspect` shows no plaintext keys in Env; Docker secrets in use |

---

## Sources

- [linuxserver/docker-obsidian GitHub Issues — Black Screen #25](https://github.com/linuxserver/docker-obsidian/issues/25)
- [linuxserver/obsidian Docker Documentation](https://docs.linuxserver.io/images/docker-obsidian/)
- [Qdrant Multitenancy Official Documentation](https://qdrant.tech/documentation/guides/multitenancy/)
- [Qdrant How to Implement Multitenancy and Custom Sharding](https://qdrant.tech/articles/multitenancy/)
- [Qdrant v1.16 — Tiered Multitenancy Release](https://qdrant.tech/blog/qdrant-1.16.x/)
- [Qdrant Feature Request: Automatic Tenant-ID Injection via JWT — GitHub Issue #8015](https://github.com/qdrant/qdrant/issues/8015)
- [Obsidian Forum: Headless Sync — How to get OBSIDIAN_AUTH_TOKEN](https://forum.obsidian.md/t/headless-sync-how-to-get-obsidian-auth-token-variable/111740)
- [Obsidian Sync Gets a Headless Client — devops-geek.net](https://devops-geek.net/devops-lab/obsidian-sync-gets-a-headless-client-a-game-changer-for-linux-automation-and-devops-workflows/)
- [Docker Resource Constraints — Official Docs](https://docs.docker.com/engine/containers/resource_constraints/)
- [Docker Security 2025: Hardening Containers](https://www.onlinehashcrack.com/guides/best-practices/docker-security-2025-hardening-containers.php)
- [VNC Server Weak Password Encryption — FortiGuard](https://www.fortiguard.com/encyclopedia/ips/21976/vnc-server-weak-password-encryption)
- [VNC RDP for all to see — Pen Test Partners](https://www.pentestpartners.com/security-blog/vnc-rdp-for-all-to-see/)
- [Docker Compose Networking Mysteries — Netdata Academy](https://www.netdata.cloud/academy/docker-compose-networking-mysteries/)
- [Docker Compose Folder Name Conflicts: Fix and Best Practices](https://www.kubeblogs.com/how-to-avoid-issues-with-docker-compose-due-to-same-folder-names-project-isolation-best-practices/)
- [SQLite WAL mode across Docker containers — SQLite User Forum](https://sqlite.org/forum/info/87824f1ed837cdbb)
- [Sharing an SQLite database across containers — Rick Branson / Medium](https://rbranson.medium.com/sharing-sqlite-databases-across-containers-is-surprisingly-brilliant-bacb8d753054)
- [API Key Management Best Practices 2025 — MultitaskAI](https://multitaskai.com/blog/api-key-management-best-practices/)
- [Obsidian License Overview](https://obsidian.md/license) — commercial use is free; commercial license is optional/voluntary support
- [Docker Network Isolation Pitfalls — Medium / Hex Shift](https://hexshift.medium.com/docker-network-isolation-pitfalls-that-put-your-applications-at-risk-b60356a14033)
- [Electron SIGSEGV in Docker — GitHub electron/electron #41975](https://github.com/electron/electron/issues/41975)

---
*Pitfalls research for: CogniVault v2.0 — Multi-user containerized deployment with Obsidian VNC, Qdrant multi-tenancy, and per-user resource isolation*
*Researched: 2026-03-13*
