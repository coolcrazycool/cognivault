# Phase 19: CLI and Vault Sync - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Operators manage users via `cognivault-ctl` CLI commands (`add-user`, `remove-user`, `list-users`) and each user's vault stays continuously synced via obsidian-headless child processes. The CLI writes directly to users.json; the running server picks up changes via hot-reload. A new Fastify sync plugin supervises per-user `ob sync --continuous` child processes.

</domain>

<decisions>
## Implementation Decisions

### CLI architecture
- `cognivault-ctl` is a standalone CLI entrypoint at `src/cli/index.ts` with `bin` field in package.json
- Direct file access via UserRegistry class — no running server needed for add/remove/list
- Commander.js for argument parsing (subcommands, flags, help generation)
- Full lifecycle on `add-user`: ob login + ob sync-setup + write to registry. Server's hot-reload then starts indexer/sync automatically

### Obsidian auth flow
- `add-user` runs `ob login` and `ob sync-setup` via `child_process.execFile`, passing credentials as env vars
- If ob login fails (wrong creds, network, ob not installed), the user is NOT written to registry — CLI exits with error, operator retries
- No ob preflight check (no `ob --version` validation) — let commands fail naturally with their own error messages
- Auth token from ob login stored in users.json `obsidian.token` field (already in Zod schema as optional)

### Sync process supervision
- New `src/plugins/sync.ts` Fastify plugin manages child processes within server lifecycle
- Listens to registry `user-added`/`user-removed` events to start/stop sync processes
- Each user gets an `ob sync --continuous` child process with their auth token injected as env var
- Exponential backoff on failure: 1s base, 30s max, 2x factor (1s, 2s, 4s, 8s, 16s, 30s, 30s...), resets on successful sync
- Stale `.obsidian/.sync.lock` files cleaned up before every sync process start (SYNC-03)
- On user removal: SIGTERM immediately, wait 5s, then SIGKILL if still running. Sync is read-only — no data loss risk

### Sync metrics (SYNC-04)
- Per-user gauge: `cognivault_sync_running{user_id}` (1=running, 0=stopped)
- Per-user failure counter: `cognivault_sync_failures_total{user_id}`
- Matches existing per-user metric patterns from Phase 18

### CLI output & UX
- `list-users`: table format by default, `--json` flag for scripting/automation
- Table columns: USER | VAULT_PATH | SYNC_STATUS
- Sync status shows 'unknown' when server not running (CLI reads file only, no live status)
- `add-user` executes immediately (no confirmation)
- `remove-user` prompts "Are you sure?" unless `--force` flag
- Proper exit codes for scripting (0=success, 1=error)

### Claude's Discretion
- Commander.js subcommand structure details
- Table rendering library choice (or manual formatting)
- Exact env var names for passing obsidian credentials to ob commands
- Sync plugin internal state management details
- How sync backoff timer resets on success
- Test structure and organization

</decisions>

<specifics>
## Specific Ideas

- CLI follows the same UserRegistry class used by the server — single source of truth, no divergence
- Full lifecycle on add-user ensures users are never in a half-provisioned state (no token = no entry)
- Sync plugin pattern mirrors existing plugin patterns (Map<userId, Resource>, registry events, onClose cleanup)
- Lock file cleanup before sync start prevents obsidian-headless from refusing to sync after unclean shutdown

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/lib/user-registry.ts`: UserRegistry class with addUser(), removeUser(), getAllUsers(), atomicWrite() — CLI uses this directly
- `src/lib/user-registry.ts`: UserRegistry.generateApiKey() static method — CLI calls this for new users
- `src/plugins/registry.ts`: Registry plugin pattern (events, metrics, lifecycle) — sync plugin follows same structure

### Established Patterns
- `Map<userId, Resource>` with registry event listeners for lifecycle (db, embedding, indexer plugins)
- `fp()` wrapper with dependencies array for plugin wiring
- `fastify.addHook('onClose', ...)` for cleanup on shutdown
- Per-instance prom-client Registry for test isolation
- Per-user metrics with user_id label (Phase 18 pattern)

### Integration Points
- `src/plugins/sync.ts` (new): Fastify plugin managing ob sync child processes, depends on registry + metrics
- `src/cli/index.ts` (new): CLI entrypoint, imports UserRegistry directly from lib/
- `src/app.ts`: Register sync plugin after registry (dependency order)
- `package.json`: Add bin field for cognivault-ctl, add commander dependency

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 19-cli-and-vault-sync*
*Context gathered: 2026-03-14*
