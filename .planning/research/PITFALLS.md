# Pitfalls Research

**Domain:** Multi-tenant Fastify service with obsidian-headless process management, per-user API keys, registry hot-reload, single-container architecture
**Researched:** 2026-03-14
**Confidence:** HIGH for process management and multi-tenancy patterns (well-documented); MEDIUM for obsidian-headless specifics (beta software, limited production usage data)

---

## Critical Pitfalls

### Pitfall 1: Stale .sync.lock Blocks All Future Syncs After Unclean ob Exit

**What goes wrong:**
When an `ob sync --continuous` process is hard-killed (SIGKILL, container crash, OOM kill), it leaves behind a lock directory at `<vault>/.obsidian/.sync.lock`. Every subsequent `ob sync` call fails with "Another sync instance is already running" even though no `ob` process is running. In a single container managing N user sync processes, one crash can silently halt that user's vault sync indefinitely — with no external signal that sync has stopped.

**Why it happens:**
The `ob` lock implementation uses directory-based locking (not file-based) and only removes the lock directory if a `verify()` check passes on shutdown. `verify()` compares modification timestamps with required exact equality. If the process is hard-killed before the clean shutdown hook runs, or if filesystem timestamp precision causes a mismatch, the lock is never released. SIGTERM (graceful stop) releases locks correctly; SIGKILL does not.

**How to avoid:**
- Before spawning an `ob sync --continuous` child process, detect and remove any stale lock: `rmdir <vault>/.obsidian/.sync.lock` if the directory exists. This is safe because the lock auto-expires after ~5 seconds anyway — any lock older than 10 seconds is definitionally stale.
- In the process manager, implement a pre-start lock cleanup routine run as part of user sync initialization.
- After any child process exit with a non-zero code, remove the lock before attempting restart.
- Log lock cleanup operations with `user_id` for observability.
- Add a health check metric: `cognivault_sync_stale_locks_cleared_total` per user.

**Warning signs:**
- `ob sync` exits immediately with "Another sync instance is already running" on startup.
- Child process for a user exits instantly (exit code non-zero) without any sync activity in logs.
- Process manager shows user's sync process in a restart loop.
- Vault on disk stops updating after a container restart.

**Phase to address:**
Phase covering `ob sync` process lifecycle management (process manager implementation). Lock cleanup must be the first step in the start sequence.

---

### Pitfall 2: obsidian-headless Auth Token Stored in $HOME — Breaks Multi-User Process Management

**What goes wrong:**
`ob login` stores credentials in `$HOME/.obsidian-headless/auth_token` (or `$HOME/.config/obsidian-headless/auth_token`). When running N user sync processes inside one container as the same system user, all users share the same `$HOME`. Running `ob login` for user B overwrites user A's stored token. Subsequent user A sync calls authenticate as user B and attempt to sync to the wrong remote vault — or fail entirely.

**Why it happens:**
obsidian-headless is designed for single-user CLI use. It has no concept of per-profile token storage. The `$HOME`-based credential store is a standard Unix pattern for single-user tools that becomes a collision point in multi-user server scenarios.

**How to avoid:**
- Use the `OBSIDIAN_AUTH_TOKEN` environment variable instead of stored credentials. Extract the token from `$HOME/.obsidian-headless/auth_token` after initial `ob login` setup and inject it per-process via environment variables.
- Spawn each user's `ob sync` child process with a separate `env` object that includes only that user's `OBSIDIAN_AUTH_TOKEN` — never fall through to the shared filesystem credential.
- Store each user's `auth_token` value encrypted in the registry or a separate secrets store, not in `$HOME`.
- Never run `ob login` inside the live container — token enrollment must happen at `add-user` time via CLI and be stored securely before the container starts.

**Warning signs:**
- User A's vault syncing content from user B's remote vault.
- `ob sync` failing with authentication errors for some users after adding a new user.
- `$HOME/.obsidian-headless/auth_token` contains a single token (not per-user).
- Adding user C causes user A or B's sync to break.

**Phase to address:**
Phase covering user registry design and CLI `add-user` command. The token isolation model must be decided before any process spawning code is written.

---

### Pitfall 3: Global SDK State in OpenAI Client Causes Per-Request Key Leakage

**What goes wrong:**
The OpenAI Node.js SDK allows setting a default API key globally (`openai.apiKey = ...`). In a concurrent Fastify service with per-user OpenAI API keys, using any global or singleton OpenAI client causes key leakage: concurrent requests for users A and B can swap keys mid-flight. User A's embedding gets charged to user B's OpenAI account, or worse, user A's key is used for user B's embeddings, causing their budget to be consumed.

**Why it happens:**
The natural pattern for single-tenant apps is a singleton client constructed at startup. Multi-tenant per-request key switching requires constructing a new client instance (or a scoped client) per request. Developers often assume the SDK is stateless between calls, but the default key is stored in module-level state.

**How to avoid:**
- Construct a new `OpenAI({ apiKey: user.openaiApiKey })` instance per request, not per application startup. The SDK is lightweight — per-request instantiation is safe at 5-20 concurrent users.
- Never call any method that sets global SDK state.
- Pass the user's `openaiApiKey` through the Fastify request lifecycle (resolve from registry after auth, attach to `request.user`) so embedding calls always have explicit access to the correct key.
- Add integration tests that assert user A's embeddings cannot be generated when user A's key is intentionally wrong but user B's key is correct.

**Warning signs:**
- OpenAI API errors (401/403) appearing intermittently under concurrent load.
- OpenAI usage dashboard showing unexpected spikes attributed to specific users.
- Embeddings succeeding for a user whose API key is known to be invalid.
- Flaky tests that pass in isolation but fail when run concurrently.

**Phase to address:**
Phase covering per-user embeddings and OpenAI client architecture. Design the per-request client pattern before implementing any multi-user embedding calls.

---

### Pitfall 4: Missing user_id Filter in Any Qdrant Query Leaks Cross-Tenant Vectors

**What goes wrong:**
CogniVault v1.0 already uses Qdrant with `user_id` payload filtering. But every new query path, reindex trigger, and admin operation must consistently apply the `user_id` filter — one missed `filter` parameter in any search or scroll call exposes all users' vectors to the requesting user. The v1.0 codebase has a single tenant, so any query without a filter "accidentally" works correctly. In multi-tenant operation, the same code becomes a data leak.

**Why it happens:**
Query functions written for single-tenant use have no `user_id` parameter — they never needed one. When migrating to multi-tenant, developers add the filter to the happy path but miss admin endpoints, reconciliation jobs, cleanup routines, reindex paths, and error recovery flows. These code paths are less tested and the omission is invisible until a user accidentally sees another's content.

**How to avoid:**
- Wrap all Qdrant interactions in a `UserScopedQdrant` service that requires `user_id` as a mandatory first argument. Make it structurally impossible to call any query without passing a `user_id`.
- Audit every existing Qdrant call site in the v1.0 codebase during the migration phase. Search for all `qdrant.search(`, `qdrant.scroll(`, `qdrant.delete(`, `qdrant.upsert(` and verify each carries a `must: [{ key: 'user_id', match: { value: userId } }]` condition.
- Confirm `user_id` payload index exists with `is_tenant: true` (required since Qdrant v1.11.0) for performance optimization.
- Add cross-tenant leak detection test: index a doc for user A, query as user B — assert zero results.

**Warning signs:**
- Search results returning content from unexpected sources.
- Reconciliation counts not matching expected per-user document counts.
- Any Qdrant call site that does not accept `userId` as a parameter.
- Shared reindex or cleanup utilities that operate on the whole collection.

**Phase to address:**
Phase covering multi-tenant auth layer and Qdrant scoping. This is the first security boundary to establish before any per-user data is written.

---

### Pitfall 5: Node.js as PID 1 in Docker Does Not Reap Zombie ob Processes

**What goes wrong:**
When CogniVault (a Node.js process) runs as PID 1 in a Docker container and spawns `ob sync` child processes, Node.js does not implement init-process semantics. When an `ob` child process exits, Linux sends SIGCHLD to the parent (Node.js). If `ob` itself spawned grandchild processes (e.g., for file watching or sync workers), those grandchildren become orphans adopted by PID 1. Node.js as PID 1 does not call `waitpid()` on adopted processes — they become zombie entries in the process table. Under sustained restarts (stale lock cycles, auth retries), the zombie count grows until the process table fills.

**Why it happens:**
Node.js is not designed to be an init process. The Linux kernel assigns orphaned processes to PID 1, which is responsible for reaping them. Standard init systems (systemd, tini, s6) handle this; Node.js does not.

**How to avoid:**
- Add `tini` as PID 1 in the Dockerfile: `ENTRYPOINT ["/sbin/tini", "--", "node", "dist/server.js"]`. Tini handles zombie reaping and signal forwarding correctly.
- Alternatively, use the `--init` flag in Docker Compose for each service.
- In the Node.js process manager, attach `child.on('exit', ...)` handlers that call `child.kill()` on the child's process group (not just the child PID) using negative PIDs (`process.kill(-child.pid, 'SIGTERM')`) to signal all members of the process group.
- Spawn `ob sync` with `{ detached: false }` to keep it in the same process group as the parent.

**Warning signs:**
- `ps aux | grep Z` shows zombie processes after container uptime > a few hours.
- Process table entries with state `Z` accumulating over time.
- Container OOM or slowdown without corresponding memory growth in the Node.js heap.
- Docker container failing to stop cleanly within the grace period (SIGTERM not reaching child processes).

**Phase to address:**
Phase covering Docker containerization and process supervisor setup. Tini must be added to the Dockerfile before the process manager is implemented.

---

### Pitfall 6: Registry File Hot-Reload Race Condition Corrupts User Mappings

**What goes wrong:**
The API-key-to-user-id registry is a JSON file watched with `fs.watch()`. The CLI writes a new user entry while the server is reading the file for an incoming request. The read gets a partial write (the file write is not atomic by default), resulting in invalid JSON that crashes the parser. The registry is now `null` in memory, routing all requests to "unknown user" until the server rereads. In the worst case, a stale mapping persists and a new user's API key routes to an existing user's vault.

**Why it happens:**
`fs.writeFile()` is not atomic — it truncates then writes, creating a window where the file is empty or incomplete. `fs.watch()` fires on file open (before write completes), not on close. A server read triggered by the watch event catches the file mid-write. This is a classic TOCTOU (time-of-check to time-of-use) race condition.

**How to avoid:**
- Use atomic writes for the registry file: write to a temp file in the same directory, then `fs.rename()` (rename is atomic on POSIX filesystems). The `write-file-atomic` npm package implements this correctly.
- In the `fs.watch()` handler, add a 50-100ms debounce before rereading. Multiple rapid events (editors, atomic rename) collapse into one read.
- Parse the JSON in a try/catch; on parse failure, keep the previous in-memory registry and log an error — do not replace a valid registry with a failed parse.
- Add a file integrity check: after parsing, verify the registry contains at least one user before replacing the in-memory copy.
- Validate with Zod before swapping into the active registry.

**Warning signs:**
- "Unexpected end of JSON input" or "SyntaxError: JSON Parse error" in logs during `add-user` or `remove-user` CLI operations.
- Requests returning 401 "unknown API key" immediately after user management operations.
- `fs.watch` events firing twice for a single CLI write (common on macOS).

**Phase to address:**
Phase covering registry design and CLI user management. The atomic write and defensive parse pattern must be in the initial implementation, not patched in after seeing corruption in production.

---

### Pitfall 7: fs.watch Is Unreliable on Linux for Single-File Watching

**What goes wrong:**
`fs.watch()` has documented unreliability on Linux: it can miss events, fire duplicate events, and behaves differently from macOS (kqueue/FSEvents) and Linux (inotify). For a single registry JSON file, missed events mean the server runs on a stale registry (a new user cannot authenticate) and duplicate events cause redundant — and potentially concurrent — reload operations. In Docker on Linux (the production environment), `inotify` event behavior differs from macOS development environments, causing bugs that only appear in production.

**Why it happens:**
`fs.watch()` is a thin wrapper over OS-specific file notification APIs with explicitly documented cross-platform inconsistencies. Node.js documentation warns: "The behavior of fs.watch() is not consistent across platforms and is unavailable in some situations." Linux inotify fires IN_CLOSE_WRITE, IN_MOVED_FROM/TO events — but the mapping to Node.js event types is not always 1:1 with macOS FSEvents.

**How to avoid:**
- Use `chokidar` instead of raw `fs.watch()` for registry file watching. Chokidar abstracts platform differences and provides stable `add`, `change`, `unlink` events with proper debouncing.
- Alternatively, implement a polling fallback: check the registry file's mtime every 2-3 seconds. At one small JSON file, polling overhead is negligible. This is 100% reliable cross-platform.
- Do not depend solely on file watching — also poll on a slow interval as a safety net even if using watch events.
- Test file watching explicitly on Linux (in Docker) during development, not just macOS.

**Warning signs:**
- `add-user` CLI completes successfully but new user cannot authenticate until server restarts.
- Duplicate reload logs (same timestamp, two "registry reloaded" log entries).
- Works correctly on macOS dev machine, breaks in Docker Linux production.

**Phase to address:**
Phase covering registry file watching implementation. Choose the watching strategy before building CLI commands — the write side must be tested against the read side.

---

### Pitfall 8: Single-Tenant SQLite Schema Applied to Multi-Tenant Data Without user_id Columns

**What goes wrong:**
The existing v1.0 SQLite schema tracks index state (file paths, content hashes, chunk counts, embedding model version) without a `user_id` column — it was single-tenant. Migrating to multi-tenant by simply running multiple file paths for different users in the same tables without `user_id` causes: incorrect change detection (user B's file looks like a rename of user A's file with the same content hash), cascading cross-user reindexes, and reconciliation that cannot distinguish which Qdrant vectors belong to which user.

**Why it happens:**
Single-tenant schema assumes globally unique file paths. Multi-tenant requires `(user_id, vault_path)` as the composite key. Adding `user_id` to a live SQLite database requires a migration, and developers often defer the schema change, instead prefixing paths (e.g., `alice:/notes/foo.md`) as a workaround — which breaks all existing path-based queries and logic.

**How to avoid:**
- Write and run a SQLite migration that adds `user_id TEXT NOT NULL DEFAULT 'default'` to all index state tables as the first step of the multi-tenant migration phase.
- Update all primary keys to `(user_id, vault_path)` composite keys.
- Update all Drizzle ORM queries to include `where(eq(table.userId, userId))` before any other filter.
- For the initial migration, assign the existing single tenant's data to a designated `user_id` (e.g., the first user in the registry).
- Test the migration path: run the migration against the existing production SQLite file and verify zero data loss.

**Warning signs:**
- Content hash collisions between users causing one user's unchanged file to be skipped for reindex (because its hash matches another user's file in the table).
- Reconciliation jobs operating on wrong users' data.
- Path-based queries returning results across users.

**Phase to address:**
Phase covering SQLite multi-tenant migration. Must be the first database change in the v2.0 milestone — all other phases depend on correct user-scoped index state.

---

### Pitfall 9: Child Process Manager Does Not Handle ob Crash-Restart Loop

**What goes wrong:**
If `ob sync --continuous` fails repeatedly (bad credentials, Obsidian Sync outage, stale lock that is not cleaned up), the process manager restarts it immediately on each exit. Without backoff, the container spawns processes at a rate that exhausts file descriptors, CPU, and piles up stale lock directories faster than cleanup can remove them. In a container with 5-20 users, one user's sync failure in a tight restart loop degrades service for all others.

**Why it happens:**
Naive restart logic: `child.on('exit', () => spawn(user))`. This is straightforward to implement but has no concept of failure rate. The process manager cannot distinguish a clean restart (new vault content available) from a crash loop (unrecoverable auth error).

**How to avoid:**
- Implement exponential backoff with a cap: first restart after 1s, then 2s, 4s, 8s, up to 60s maximum. Reset the backoff counter after a process has been running cleanly for at least 60 seconds.
- Track consecutive failures per user. After 5 consecutive failures within 5 minutes, mark that user's sync as "degraded" and stop auto-restarting. Emit a metric and alert.
- Expose the per-user sync status via the health endpoint (`/health` or `/admin/users`) so operators can observe degraded sync states.
- Perform lock cleanup before each restart attempt (Pitfall 1 prevention), not only on first start.

**Warning signs:**
- Logs show rapid-fire "starting sync for user X" / "sync exited for user X" cycles.
- File descriptor count (`/proc/<pid>/fd`) growing in the container.
- CPU spike not correlated with actual vault activity.
- One user's sync issue affecting request latency for other users.

**Phase to address:**
Phase covering process manager implementation. Backoff and failure threshold must be in the initial design, not added after observing runaway restart loops.

---

### Pitfall 10: obsidian-headless Native Binaries Not Available for Linux ARM64

**What goes wrong:**
The `obsidian-headless` package ships prebuilt native binaries only for Windows (x64, ARM64, ia32) and macOS (x64, ARM64). Linux ARM64 is not listed among the prebuilt targets. If the production Docker host is ARM64 (Apple Silicon Mac running Docker via qemu, AWS Graviton, Raspberry Pi), `npm install -g obsidian-headless` will fail to install the native module, and `ob sync` will not work.

**Why it happens:**
obsidian-headless is a beta tool (v0.0.3+, released February 2026) with limited platform coverage. Linux x86_64 appears to be supported (the documented deployment target), but ARM64 Linux support is not confirmed in available documentation as of this research date.

**How to avoid:**
- Explicitly test `npm install -g obsidian-headless` inside the target Docker image (linux/amd64 base) before committing to the architecture.
- Pin to `linux/amd64` in the Dockerfile `FROM` directive: `FROM --platform=linux/amd64 node:22-slim`. This forces x86_64 emulation on ARM64 hosts.
- Track the obsidian-headless GitHub releases for Linux ARM64 native binary additions — this is likely to be added as the tool matures.
- Have a fallback plan if native binaries are missing: the `ob` CLI can potentially run without native modules for basic sync (the `birthtime` limitation is documented as graceful degradation on Linux), but this needs explicit testing.

**Warning signs:**
- `npm install -g obsidian-headless` fails with "No native binary found for platform linux arm64".
- `ob` command not found after installation.
- Docker build fails on ARM64 CI runners.

**Phase to address:**
Phase covering Dockerfile and container build. The platform target must be verified in the first Dockerfile iteration before any process manager code depends on `ob` being available.

---

### Pitfall 11: CLI Modifying Live System State Without IPC — TOCTOU on User Add/Remove

**What goes wrong:**
The CLI writes to the user registry file to add or remove users while the CogniVault server is running. The CLI does not know whether the server has picked up the change. An operator adds a user, the server is mid-request when the registry reloads, and the new user's first API request arrives before the registry is fully loaded — they get a 401. More dangerously: `remove-user` removes a user from the registry while the server is mid-flight on a request from that user, causing the request to fail partway through (vectors written to Qdrant for a user whose index state has been partially torn down).

**Why it happens:**
File-based IPC (registry file + fs.watch) is inherently asynchronous. The CLI writes, the server reads eventually — there is no acknowledgement. This is acceptable for reads but problematic for destructive operations like `remove-user` where partial state is worse than no change.

**How to avoid:**
- For `add-user`: the TOCTOU risk is low (a delayed 401 on first request is recoverable). Acceptable if registry reload is fast (< 500ms).
- For `remove-user`: implement a soft-delete approach. Mark the user as `status: "removing"` in the registry, let the server stop accepting new requests for that user (returns 503 "user being removed"), wait for in-flight requests to drain (a configurable grace period, e.g., 10 seconds), then write the final removal. The CLI should wait for the grace period before confirming removal.
- Consider adding an admin REST endpoint (`DELETE /admin/users/:userId`) that the CLI calls instead of writing to the file directly. The server can handle the state transition atomically.
- Log all registry mutations with timestamps and operation type for audit trail.

**Warning signs:**
- `remove-user` completing on the CLI while the server is still processing requests for that user.
- Partial Qdrant vector deletion (some vectors removed, some still present for a removed user).
- 401 errors for a newly added user within the first second after `add-user` completes.

**Phase to address:**
Phase covering CLI user management commands. The soft-delete pattern for `remove-user` must be designed before the CLI is implemented.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Single OpenAI client singleton instead of per-request instances | Simpler code | Cross-tenant key leakage under concurrency | Never — instantiating per-request is cheap |
| Storing auth tokens in $HOME instead of env vars | Easier `ob login` | Multi-user token collision, impossible to manage N users | Never for server-side multi-user use |
| Non-atomic registry file writes (`fs.writeFile` directly) | Less code | Race condition corrupts registry on concurrent CLI use | Never — `write-file-atomic` is a trivial dependency |
| No backoff on child process restart | Simpler process manager | Crash loops exhaust resources and degrade all users | Never — exponential backoff must be in initial implementation |
| Skipping `user_id` SQLite migration, using path prefixes instead | Avoids schema migration | All path-based queries break, cross-user hash collisions | Never — schema migration is the only safe approach |
| `fs.watch()` without polling fallback | Less code | Missed events on Linux, stale registry in production | MVP only if development is macOS-only; add fallback before Docker deployment |
| Immediate `remove-user` without graceful drain | Simpler CLI | Partial cleanup of in-flight requests, orphaned Qdrant vectors | Never for production; acceptable in development with no live traffic |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| obsidian-headless `ob sync` | Relying on `ob login` credentials in `$HOME` for multi-user | Inject per-user `OBSIDIAN_AUTH_TOKEN` as environment variable in each spawned process |
| obsidian-headless `ob sync` | Not removing stale `.sync.lock` before restart | Check and remove `<vault>/.obsidian/.sync.lock` before every process start |
| OpenAI Node.js SDK | Using a singleton client with global API key | Construct `new OpenAI({ apiKey })` per-request; never set module-level defaults |
| Qdrant | Calling `search()` or `scroll()` without `user_id` filter | Wrap all Qdrant operations in a `UserScopedQdrant` class that requires `userId` parameter |
| Qdrant | Not setting `is_tenant: true` on the `user_id` payload index | Recreate the index with `is_tenant: true` — omitting it degrades multi-tenant search performance |
| SQLite (Drizzle) | Adding multi-tenant data to single-tenant schema without migration | Write and run a Drizzle migration adding `user_id` column with composite primary key before any multi-user operations |
| Docker / Node.js PID 1 | Running `node` as PID 1 without tini | Add `tini` to Dockerfile `ENTRYPOINT` to handle zombie reaping and signal forwarding |
| Docker Compose | Not pinning platform in FROM directive | Use `--platform=linux/amd64` if obsidian-headless Linux ARM64 binaries are unavailable |
| Registry file watching | Using `fs.watch()` directly | Use `chokidar` or polling with debounce; never trust `fs.watch()` alone on Linux |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Starting all N user sync processes simultaneously on container start | Obsidian Sync rate limiting, thundering herd on first startup | Stagger process starts with 2-5 second delays between each user | > 5 users starting simultaneously |
| Per-request `new OpenAI()` client construction without connection reuse | Increased TLS handshake overhead per embedding call | Node.js HTTP keep-alive is maintained per-instance — at 5-20 users this is acceptable, but monitor latency | > 50 concurrent embedding calls/second |
| SQLite write contention from N concurrent indexing loops | "Database is locked" errors, slow reindex | WAL mode already in v1.0 — verify WAL is enabled; index in serial per-user, not all-users-parallel | > 10 concurrent users all reindexing simultaneously |
| Registry file reloads triggering expensive validation on every fs.watch event | Validation latency spike on each user management operation | Cache the last-known-good registry; validate only on file change events, not on reads | Immediate — validation should always be cheap (Zod schema is fast) |
| Polling vault directories for N users with existing single-tenant poll interval | N × file stat operations per poll cycle | Verify CPU usage with N users; consider increasing poll interval or staggering user polls | > 10 users × 5000 files = 50,000 stat() calls per poll cycle |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Storing Obsidian credentials (email/password) in registry file | Credential exposure if registry file is read by other container processes or leaked | Store only the `auth_token` value (opaque token), never the raw credentials; encrypt at rest if possible |
| User A's API key working for User B's vault endpoints | Full cross-tenant data access | Enforce `user_id` extraction from API key as the first middleware step; all downstream operations use only this resolved `user_id`, never a user-supplied one |
| Admin CLI accessible without authentication | Any container process can add/remove users | CLI commands operate only on the local filesystem (not network-accessible); Docker volume permissions restrict registry file access to the container operator |
| Per-user OpenAI keys logged in debug output | API key exposure in log files | Redact all API key values from logs; log only the key prefix (first 8 chars) for debugging identity, never the full value |
| `remove-user` not cleaning Qdrant vectors | Removed user's vault content remains searchable by future users assigned same `user_id` | `remove-user` must delete all Qdrant vectors for that `user_id` before completion; verify with a scroll query that returns zero results |

---

## "Looks Done But Isn't" Checklist

- [ ] **Multi-tenant auth:** Often missing cross-tenant rejection test — verify User A's API key returns 401 on all of User B's routes, not just the primary search route
- [ ] **Qdrant scoping:** Often missing `user_id` filter on the reindex and cleanup code paths — verify that a full reindex triggered by User A does not touch User B's vectors
- [ ] **ob process management:** Often missing lock cleanup on startup — verify that the process manager successfully starts `ob sync` after a simulated unclean kill (leave a `.sync.lock` behind, then start)
- [ ] **Registry hot-reload:** Often missing error handling on parse failure — verify that corrupting the registry JSON file does not clear the in-memory registry (server should log error and keep old registry)
- [ ] **Per-user OpenAI keys:** Often missing concurrent request test — verify that two simultaneous embedding calls for User A and User B use the correct respective keys (inject intentionally wrong keys and assert 401)
- [ ] **SQLite migration:** Often missing existing data migration — verify the migration assigns existing single-tenant data to the first user's `user_id`, not loses it
- [ ] **remove-user cleanup:** Often missing Qdrant cleanup verification — after `remove-user`, scroll Qdrant with that `user_id` filter and assert zero results
- [ ] **Tini / PID 1:** Often missing from Dockerfile — verify `ps aux` inside container shows tini as PID 1, not node
- [ ] **ob auth token isolation:** Often tested single-user only — verify adding User C does not break User A's or User B's ongoing sync

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Stale .sync.lock blocking a user's sync | LOW | `rmdir <vault>/.obsidian/.sync.lock`; process manager restart for that user |
| Cross-tenant auth token collision ($HOME) | MEDIUM | Re-run `add-user` with correct token for affected users; verify each user's sync process is using the correct `OBSIDIAN_AUTH_TOKEN` env var |
| OpenAI key leakage between users | MEDIUM | Rotate all affected users' OpenAI API keys immediately; audit OpenAI usage dashboard for anomalous charges; restart server with corrected per-request client pattern |
| Corrupted registry JSON | LOW | Restore last-known-good registry from backup (implement registry versioned backup in CLI); restart triggers clean reload |
| SQLite schema without user_id (data loss risk) | HIGH | Stop server; write and run migration with Drizzle; verify no data loss; restart. Do not attempt in-place column addition without transaction |
| Zombie process accumulation | LOW | Add tini to Dockerfile and redeploy; existing zombies cleared on container restart |
| Cross-tenant Qdrant data leak | HIGH | Audit all query paths; add `UserScopedQdrant` wrapper; force full test suite pass before redeploying; notify affected users |
| User removal with incomplete cleanup | MEDIUM | Re-run cleanup: delete all Qdrant vectors for that `user_id`; remove SQLite rows; verify empty state |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Stale .sync.lock | Process manager implementation phase | Simulate unclean kill; verify manager starts cleanly after lock removal |
| Auth token collision ($HOME) | Registry design + CLI add-user phase | Add User C; verify User A and B sync continues without errors |
| OpenAI global SDK state | Per-user embeddings phase | Concurrent embedding test with intentionally mismatched keys |
| Missing user_id Qdrant filter | Multi-tenant auth layer phase | Cross-tenant search returns zero results |
| Node.js PID 1 zombie | Docker / Dockerfile phase | Verify tini is PID 1; run for 30 min under restart load; `ps aux | grep Z` shows zero zombies |
| Registry file race condition | Registry design phase | Concurrent CLI write + server read; verify no parse errors and no stale registry |
| fs.watch unreliability | Registry watching implementation | Deploy to Linux Docker; add-user; verify server picks up change within 5 seconds |
| SQLite single-tenant schema | Database migration phase | Migration runs clean on v1.0 SQLite file; all existing data assigned to first user |
| Crash-restart loop (no backoff) | Process manager implementation phase | Kill user's ob process 10 times in 60s; verify restart interval grows and sync is eventually marked degraded |
| Linux ARM64 native binary missing | Dockerfile / container build phase | Build Docker image on linux/amd64 target; verify `ob sync --version` runs inside container |
| CLI TOCTOU on remove-user | CLI implementation phase | Issue remove-user while server is handling that user's request; verify no partial Qdrant cleanup |

---

## Sources

- [obsidian-headless GitHub — Stale .sync.lock Issue #4](https://github.com/obsidianmd/obsidian-headless/issues/4)
- [obsidian-headless GitHub README](https://github.com/obsidianmd/obsidian-headless)
- [Obsidian Help — Headless Sync](https://help.obsidian.md/headless)
- [OBSIDIAN_AUTH_TOKEN token storage discussion — Obsidian Forum](https://forum.obsidian.md/t/headless-sync-how-to-get-obsidian-auth-token-variable/111740)
- [Obsidian Sync Headless Client announcement — Hacker News](https://news.ycombinator.com/item?id=47197267)
- [Qdrant Multitenancy Guide](https://qdrant.tech/documentation/guides/multitenancy/)
- [OpenAI per-user key safety in multi-tenant Node.js — openai-agents-js Issue #642](https://github.com/openai/openai-agents-js/issues/642)
- [Node.js Child Process — Process signals in Docker](https://maximorlov.com/process-signals-inside-docker-containers/)
- [Node.js as PID 1 and zombie process pitfalls — nodebestpractices](https://github.com/goldbergyoni/nodebestpractices/blob/master/sections/docker/graceful-shutdown.md)
- [write-file-atomic npm package](https://www.npmjs.com/package/write-file-atomic)
- [fs.watch reliability issues — Node.js issue #47058](https://github.com/nodejs/node/issues/47058)
- [Drizzle ORM SQLite WAL concurrent writes discussion](https://github.com/drizzle-team/drizzle-orm/discussions/1994)
- [Multi-tenant Node.js patterns](https://medium.com/@shital.pimpale5/creating-scalable-multi-tenant-applications-with-node-js-0a49babc97d5)

---
*Pitfalls research for: CogniVault v2.0 — Multi-tenant migration with obsidian-headless sync*
*Researched: 2026-03-14*
