# Phase 19: CLI and Vault Sync - Research

**Researched:** 2026-03-14
**Domain:** CLI tooling (Commander.js), child process supervision, obsidian-headless integration
**Confidence:** HIGH

## Summary

Phase 19 builds two new subsystems: a `cognivault-ctl` CLI for operator-facing user management, and a Fastify sync plugin that supervises per-user `ob sync --continuous` child processes. The CLI is a standalone entrypoint that imports UserRegistry directly from `src/lib/user-registry.ts` -- no running server required. The sync plugin follows the established Map-based per-user resource pattern already used by db, embedding, and indexer plugins.

Commander.js v14 is the standard CLI framework (35M weekly downloads, full TypeScript/ESM support, maintained until May 2027). obsidian-headless v0.0.6 provides `ob login`, `ob sync-setup`, and `ob sync --continuous` commands. Authentication works via `--email`/`--password` flags for non-interactive login, with tokens stored at `~/.config/obsidian-headless/auth_token`. The `OBSIDIAN_AUTH_TOKEN` env var can bypass login for subsequent sync processes.

**Primary recommendation:** Use Commander.js v14 for the CLI, implement exponential backoff in-house (simple enough to not warrant a library), and pass `OBSIDIAN_AUTH_TOKEN` as env var to child processes running `ob sync --continuous`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- `cognivault-ctl` is a standalone CLI entrypoint at `src/cli/index.ts` with `bin` field in package.json
- Direct file access via UserRegistry class -- no running server needed for add/remove/list
- Commander.js for argument parsing (subcommands, flags, help generation)
- Full lifecycle on `add-user`: ob login + ob sync-setup + write to registry
- `add-user` runs `ob login` and `ob sync-setup` via `child_process.execFile`, passing credentials as env vars
- If ob login fails, user is NOT written to registry -- CLI exits with error
- No ob preflight check -- let commands fail naturally
- Auth token from ob login stored in users.json `obsidian.token` field
- New `src/plugins/sync.ts` Fastify plugin manages child processes within server lifecycle
- Listens to registry `user-added`/`user-removed` events to start/stop sync processes
- Each user gets `ob sync --continuous` child process with auth token as env var
- Exponential backoff: 1s base, 30s max, 2x factor, resets on successful sync
- Stale `.obsidian/.sync.lock` files cleaned up before every sync process start
- On user removal: SIGTERM, wait 5s, then SIGKILL
- Per-user gauge: `cognivault_sync_running{user_id}` (1=running, 0=stopped)
- Per-user failure counter: `cognivault_sync_failures_total{user_id}`
- `list-users`: table format by default, `--json` flag for scripting
- Table columns: USER | VAULT_PATH | SYNC_STATUS (shows 'unknown' when server not running)
- `add-user` executes immediately (no confirmation)
- `remove-user` prompts "Are you sure?" unless `--force` flag
- Proper exit codes (0=success, 1=error)

### Claude's Discretion
- Commander.js subcommand structure details
- Table rendering library choice (or manual formatting)
- Exact env var names for passing obsidian credentials to ob commands
- Sync plugin internal state management details
- How sync backoff timer resets on success
- Test structure and organization

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CLI-01 | `cognivault-ctl add-user <name>` with flags for credentials | Commander.js subcommand with required options; UserRegistry.addUser() for persistence |
| CLI-02 | `cognivault-ctl remove-user <name>` stops sync, removes from registry | Commander.js subcommand; UserRegistry.removeUser(); node:readline for confirmation prompt |
| CLI-03 | `cognivault-ctl list-users` shows users with sync status and vault path | Commander.js subcommand; UserRegistry.getAllUsers(); manual table formatting |
| CLI-04 | `add-user` performs `ob login` + `ob sync-setup` inline, stores auth token | child_process.execFile for ob commands; --email/--password flags; token read from ~/.config/obsidian-headless/auth_token |
| SYNC-01 | Per-user vault sync via `ob sync --continuous` with auth token env var | child_process.spawn with OBSIDIAN_AUTH_TOKEN env var; sync plugin with Map<userId, ChildProcess> |
| SYNC-02 | Auto-restart with exponential backoff | Hand-rolled backoff (1s/2x/30s cap); setTimeout-based restart; reset delay on success detection |
| SYNC-03 | Stale .obsidian/.sync.lock cleanup before sync start | fs.unlink before each spawn; path: `${vaultPath}/.obsidian/.sync.lock` |
| SYNC-04 | Structured logging and Prometheus metrics for sync failures | prom-client Gauge + Counter on fastify.metrics.promRegistry; per-user labels |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| commander | ^14.0.3 | CLI argument parsing, subcommands, help generation | 35M weekly downloads, full TypeScript types, ESM support, maintained until May 2027 |
| obsidian-headless | 0.0.6 | Vault sync via `ob` CLI commands | Official Obsidian tool, only option for headless Obsidian Sync |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:child_process | built-in | spawn/execFile for ob commands and sync processes | All interactions with obsidian-headless |
| node:readline | built-in | Confirmation prompt for remove-user | Only for interactive confirmation (not needed with --force) |
| prom-client | ^15.1.3 (existing) | Sync metrics (gauge, counter) | Already in project, follows Phase 18 per-user metric patterns |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Manual table formatting | cli-table3 / chalk | Extra dependency for one command; console.log with padEnd() is sufficient for 3 columns |
| Hand-rolled backoff | backoff npm | Extra dependency for trivial logic (5 lines of code) |
| Commander.js v14 | Commander.js v15 | v15 is ESM-only (released May 2026); v14 is safer, maintained until May 2027 |

**Installation:**
```bash
pnpm add commander@^14.0.3
```

Note: obsidian-headless is NOT a project dependency -- it must be installed globally on the host (`npm install -g obsidian-headless`). The CLI invokes it via `execFile('ob', ...)`.

## Architecture Patterns

### Recommended Project Structure
```
src/
  cli/
    index.ts           # CLI entrypoint (#!/usr/bin/env node shebang, Commander program)
    commands/
      add-user.ts      # add-user subcommand handler
      remove-user.ts   # remove-user subcommand handler
      list-users.ts    # list-users subcommand handler
  plugins/
    sync.ts            # Fastify plugin: per-user ob sync supervision
```

### Pattern 1: CLI Entrypoint with Commander.js
**What:** Standalone TypeScript entrypoint that uses Commander for subcommands
**When to use:** The `cognivault-ctl` CLI binary
**Example:**
```typescript
// src/cli/index.ts
#!/usr/bin/env node
import { Command } from 'commander';
import { registerAddUser } from './commands/add-user.js';
import { registerRemoveUser } from './commands/remove-user.js';
import { registerListUsers } from './commands/list-users.js';

const program = new Command();
program
  .name('cognivault-ctl')
  .description('CogniVault user management CLI')
  .version('1.0.0');

registerAddUser(program);
registerRemoveUser(program);
registerListUsers(program);

program.parse();
```

```json
// package.json addition
{
  "bin": {
    "cognivault-ctl": "dist/cli/index.js"
  }
}
```

### Pattern 2: Subcommand with Required Options
**What:** Commander subcommand with typed options
**When to use:** Each CLI command (add-user, remove-user, list-users)
**Example:**
```typescript
// src/cli/commands/add-user.ts
import type { Command } from 'commander';

interface AddUserOptions {
  obsidianEmail: string;
  obsidianPassword: string;
  vault: string;
  openaiKey: string;
}

export function registerAddUser(program: Command): void {
  program
    .command('add-user')
    .argument('<name>', 'User identifier (lowercase alphanumeric with hyphens)')
    .requiredOption('--obsidian-email <email>', 'Obsidian account email')
    .requiredOption('--obsidian-password <password>', 'Obsidian account password')
    .requiredOption('--vault <vault>', 'Remote vault name or ID')
    .requiredOption('--openai-key <key>', 'OpenAI API key')
    .action(async (name: string, opts: AddUserOptions) => {
      // 1. ob login --email <email> --password <password>
      // 2. Read auth token from ~/.config/obsidian-headless/auth_token
      // 3. ob sync-setup --vault <vault> --path <vaultPath>
      // 4. UserRegistry.addUser(...)
    });
}
```

### Pattern 3: Sync Plugin (Map + Registry Events)
**What:** Fastify plugin managing per-user child processes, following existing Map pattern
**When to use:** The sync.ts plugin
**Example:**
```typescript
// src/plugins/sync.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Counter, Gauge } from 'prom-client';

interface SyncEntry {
  process: ChildProcess | null;
  backoffDelay: number;
  restartTimer: NodeJS.Timeout | null;
}

// Plugin follows same Map<userId, Resource> pattern as indexer, db, embedding plugins
async function syncPlugin(fastify: FastifyInstance): Promise<void> {
  const syncs = new Map<string, SyncEntry>();

  const syncRunning = new Gauge({
    name: 'cognivault_sync_running',
    help: 'Whether sync process is running for user (1=yes, 0=no)',
    labelNames: ['user_id'] as const,
    registers: [fastify.metrics.promRegistry],
  });

  const syncFailures = new Counter({
    name: 'cognivault_sync_failures_total',
    help: 'Total sync process failures per user',
    labelNames: ['user_id'] as const,
    registers: [fastify.metrics.promRegistry],
  });

  // Listen for registry events
  fastify.registry.on('user-added', (user) => { /* start sync */ });
  fastify.registry.on('user-removed', (user) => { /* stop sync */ });

  fastify.addHook('onClose', async () => { /* stop all syncs */ });
}

export default fp(syncPlugin, {
  name: 'sync',
  dependencies: ['registry', 'metrics'],
});
```

### Pattern 4: Exponential Backoff for Child Process Restart
**What:** Simple backoff logic for restarting failed sync processes
**When to use:** When ob sync --continuous exits unexpectedly
**Example:**
```typescript
const BASE_DELAY = 1000;   // 1 second
const MAX_DELAY = 30000;   // 30 seconds
const BACKOFF_FACTOR = 2;

function nextDelay(current: number): number {
  return Math.min(current * BACKOFF_FACTOR, MAX_DELAY);
}

// On process exit (non-zero):
entry.backoffDelay = nextDelay(entry.backoffDelay);
entry.restartTimer = setTimeout(() => startSync(userId), entry.backoffDelay);

// On successful sync detection (process running stably):
entry.backoffDelay = BASE_DELAY;
```

### Anti-Patterns to Avoid
- **Importing config.ts in CLI code:** The CLI must NOT import the server config module -- it validates env vars like VAULT_PATH that are irrelevant for CLI-only operations. The CLI should construct UserRegistry with explicit paths.
- **Using spawn for ob login/sync-setup:** These are one-shot commands -- use `execFile` (simpler, captures stdout/stderr). Only use `spawn` for the long-running `ob sync --continuous`.
- **Polling for process health:** Do not poll child processes -- use the `exit` event on ChildProcess to detect failures.
- **Shared state between CLI and server:** The CLI writes to users.json; the server hot-reloads it. They never share in-memory state. This is by design.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| CLI argument parsing | Custom argv parsing | Commander.js | Subcommands, required options, help generation, error messages |
| Vault sync | Custom Obsidian API client | `ob sync --continuous` (obsidian-headless) | Official client, handles encryption, conflict resolution, delta sync |
| Atomic file writes | Custom tmp+rename | UserRegistry.atomicWrite() (existing) | Already implemented and tested in user-registry.ts |
| User registry CRUD | New data layer | UserRegistry class (existing) | Already has addUser, removeUser, getAllUsers, validation, events |

**Key insight:** The CLI is thin -- it orchestrates existing UserRegistry methods and shell commands. The sync plugin follows an established pattern in this codebase. Almost nothing in this phase requires novel infrastructure.

## Common Pitfalls

### Pitfall 1: ob login Token Location
**What goes wrong:** The auth token from `ob login` is stored at `~/.config/obsidian-headless/auth_token`, not returned on stdout
**Why it happens:** obsidian-headless stores credentials in its own config directory
**How to avoid:** After running `ob login`, read the token file from `$HOME/.config/obsidian-headless/auth_token` or the XDG config path
**Warning signs:** Token field empty in users.json after add-user

### Pitfall 2: CLI Importing Server Config
**What goes wrong:** `src/config.ts` validates all server env vars (VAULT_PATH, QDRANT_URL, etc.) at import time via Zod parse of process.env
**Why it happens:** Easy to accidentally import config.ts in CLI code
**How to avoid:** CLI should construct its own paths. Use `COGNIVAULT_DATA_DIR` env var or default `~/.cognivault` for finding users.json path. Do NOT import from `../config.js`.
**Warning signs:** CLI crashes with "VAULT_PATH is required" when operator hasn't set server env vars

### Pitfall 3: Zombie Child Processes on Server Shutdown
**What goes wrong:** sync child processes outlive the Fastify server if onClose hook doesn't kill them properly
**Why it happens:** Forgetting to handle the SIGTERM->wait->SIGKILL sequence
**How to avoid:** In onClose hook, iterate all sync entries, send SIGTERM, wait 5s with Promise + setTimeout, then SIGKILL. Clear all timers.
**Warning signs:** `ob sync` processes accumulating after repeated server restarts

### Pitfall 4: Lock File Race Condition
**What goes wrong:** Attempting to unlink `.obsidian/.sync.lock` that doesn't exist throws ENOENT
**Why it happens:** Lock file only exists after unclean shutdown, not always
**How to avoid:** Use `fs.unlink().catch(() => {})` or check with `fs.access()` first. ENOENT is not an error here.
**Warning signs:** Sync startup fails intermittently

### Pitfall 5: ob login MFA Requirement
**What goes wrong:** `ob login --email <email> --password <password>` hangs waiting for MFA input when account has 2FA enabled
**Why it happens:** obsidian-headless prompts for MFA interactively when 2FA is enabled
**How to avoid:** Document that 2FA accounts require the `--mfa` flag. Consider adding `--mfa <code>` as an optional flag to add-user.
**Warning signs:** add-user command hangs indefinitely

### Pitfall 6: OBSIDIAN_AUTH_TOKEN vs Per-User Tokens
**What goes wrong:** Setting a single global OBSIDIAN_AUTH_TOKEN env var for all users
**Why it happens:** Each user has their own Obsidian account and token
**How to avoid:** Pass the token as an env var scoped to each child process: `spawn('ob', [...], { env: { ...process.env, OBSIDIAN_AUTH_TOKEN: user.obsidian.token } })`
**Warning signs:** All users sync the same vault, or auth errors for all but one user

## Code Examples

### Executing ob login via execFile
```typescript
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function obLogin(email: string, password: string): Promise<string> {
  await execFileAsync('ob', ['login', '--email', email, '--password', password]);

  // Read the token from obsidian-headless config
  const configDir = process.env.XDG_CONFIG_HOME
    ?? join(process.env.HOME ?? '', '.config');
  const tokenPath = join(configDir, 'obsidian-headless', 'auth_token');
  const token = await readFile(tokenPath, 'utf-8');
  return token.trim();
}
```

### Spawning ob sync --continuous with Per-User Token
```typescript
import { spawn } from 'node:child_process';

function startSyncProcess(vaultPath: string, token: string): ChildProcess {
  const child = spawn('ob', ['sync', '--continuous'], {
    cwd: vaultPath,
    env: {
      ...process.env,
      OBSIDIAN_AUTH_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (data: Buffer) => {
    // Log sync output with structured context
  });

  child.stderr?.on('data', (data: Buffer) => {
    // Log sync errors
  });

  return child;
}
```

### Simple Table Output for list-users
```typescript
function printTable(users: Array<{ userId: string; vaultPath: string; syncStatus: string }>): void {
  const header = ['USER', 'VAULT_PATH', 'SYNC_STATUS'];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...users.map(u => [u.userId, u.vaultPath, u.syncStatus][i]?.length ?? 0))
  );

  const row = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  console.log(row(header));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const u of users) {
    console.log(row([u.userId, u.vaultPath, u.syncStatus]));
  }
}
```

### Confirmation Prompt with node:readline
```typescript
import { createInterface } from 'node:readline/promises';

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return answer.toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Interactive ob login only | `ob login --email --password` flags + OBSIDIAN_AUTH_TOKEN env var | obsidian-headless 0.0.3+ (Feb 2026) | Enables fully non-interactive auth flow |
| Keychain-required sync-setup | Fixed in 0.0.3 (no longer requires gnome-keyring) | Feb 2026 | Headless Linux servers work without GUI dependencies |
| Commander.js CJS | Commander.js v14 supports ESM natively | 2024+ | Direct `import { Command } from 'commander'` in ESM |

**Deprecated/outdated:**
- obsidian-headless < 0.0.3: has keychain bug on headless Linux, do not use
- Commander.js v15: ESM-only, released May 2026 -- use v14 for stability

## Open Questions

1. **ob login token persistence across multiple users**
   - What we know: `ob login` stores token at `~/.config/obsidian-headless/auth_token`; each login likely overwrites the previous token
   - What's unclear: Whether running `ob login` for user B invalidates user A's stored token, or if tokens are account-scoped files
   - Recommendation: Read the token immediately after each `ob login` and store it in users.json before running `ob login` for the next user. This serializes add-user operations but guarantees correct token capture.

2. **ob sync --continuous working directory requirement**
   - What we know: `ob sync` needs to know which local vault to sync
   - What's unclear: Whether `--path` flag works with `ob sync --continuous` or if cwd must be the vault directory
   - Recommendation: Set `cwd: vaultPath` on the spawn call as the safest approach. Also verify `ob sync-setup --path <path>` was run for that directory.

3. **obsidian-headless beta stability**
   - What we know: v0.0.6 is current, tool was released Feb 2026, described as beta
   - What's unclear: How stable `ob sync --continuous` is for long-running processes (days/weeks)
   - Recommendation: The exponential backoff with auto-restart handles instability. Log all process exits with exit codes for debugging.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.x |
| Config file | `vitest.config.ts` |
| Quick run command | `pnpm test -- --run src/cli/__tests__/` |
| Full suite command | `pnpm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CLI-01 | add-user creates user with flags | unit | `pnpm test -- --run src/cli/__tests__/add-user.test.ts -x` | No - Wave 0 |
| CLI-02 | remove-user stops sync, removes user | unit | `pnpm test -- --run src/cli/__tests__/remove-user.test.ts -x` | No - Wave 0 |
| CLI-03 | list-users shows table/json output | unit | `pnpm test -- --run src/cli/__tests__/list-users.test.ts -x` | No - Wave 0 |
| CLI-04 | add-user runs ob login + ob sync-setup | unit | `pnpm test -- --run src/cli/__tests__/add-user.test.ts -x` | No - Wave 0 |
| SYNC-01 | Per-user ob sync child process with token | unit | `pnpm test -- --run src/plugins/__tests__/sync.test.ts -x` | No - Wave 0 |
| SYNC-02 | Auto-restart with exponential backoff | unit | `pnpm test -- --run src/plugins/__tests__/sync.test.ts -x` | No - Wave 0 |
| SYNC-03 | Lock file cleanup before sync start | unit | `pnpm test -- --run src/plugins/__tests__/sync.test.ts -x` | No - Wave 0 |
| SYNC-04 | Sync metrics (gauge + counter) | unit | `pnpm test -- --run src/plugins/__tests__/sync.test.ts -x` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test -- --run src/cli/__tests__/ src/plugins/__tests__/sync.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/cli/__tests__/add-user.test.ts` -- covers CLI-01, CLI-04 (mock execFile, mock UserRegistry)
- [ ] `src/cli/__tests__/remove-user.test.ts` -- covers CLI-02 (mock UserRegistry, mock readline)
- [ ] `src/cli/__tests__/list-users.test.ts` -- covers CLI-03 (mock UserRegistry, capture stdout)
- [ ] `src/plugins/__tests__/sync.test.ts` -- covers SYNC-01 through SYNC-04 (mock child_process.spawn, test backoff logic, test metrics)

### Testing Strategy Notes
- **CLI tests:** Mock `child_process.execFile` and `child_process.spawn` -- never call real `ob` commands in tests
- **Sync plugin tests:** Use the existing buildApp + fastify.inject pattern but mock spawn. Verify metrics via `fastify.metrics.promRegistry.getSingleMetric()`
- **UserRegistry tests:** UserRegistry is already tested in Phase 15 -- CLI tests should mock it
- **Table output:** Capture console.log output and assert formatting
- **Confirmation prompt:** Mock readline interface in remove-user tests

## Sources

### Primary (HIGH confidence)
- [Commander.js GitHub](https://github.com/tj/commander.js) - API, subcommands, TypeScript support, ESM usage
- [obsidian-headless GitHub](https://github.com/obsidianmd/obsidian-headless) - CLI commands, flags, auth flow
- [obsidian-headless npm](https://www.npmjs.com/package/obsidian-headless) - version 0.0.6, Node.js 22 requirement
- Existing codebase: `src/lib/user-registry.ts`, `src/plugins/registry.ts`, `src/plugins/indexer.ts` - established patterns

### Secondary (MEDIUM confidence)
- [Obsidian Forum: OBSIDIAN_AUTH_TOKEN](https://forum.obsidian.md/t/headless-sync-how-to-get-obsidian-auth-token-variable/111740) - token location, env var usage
- [Obsidian Forum: keychain fix](https://forum.obsidian.md/t/ob-sync-setup-fails-on-headless-linux-keychain-unavailable/111679) - fixed in 0.0.3
- [Commander.js npm](https://www.npmjs.com/package/commander) - v14.0.3 current, v15 ESM-only May 2026

### Tertiary (LOW confidence)
- ob login token file location (`~/.config/obsidian-headless/auth_token`) -- confirmed by forum users but not official docs (docs load dynamically, couldn't verify)
- Multi-user token isolation -- not explicitly documented; research suggests tokens may overwrite each other

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Commander.js is well-established; obsidian-headless is the only official option
- Architecture: HIGH - follows patterns already established in this codebase (Map + registry events + fp() plugin)
- Pitfalls: MEDIUM - obsidian-headless is beta; token storage location from forum not official docs
- ob login flow: MEDIUM - non-interactive flags confirmed by GitHub README, token file path from community

**Research date:** 2026-03-14
**Valid until:** 2026-03-28 (obsidian-headless is beta, may change; Commander.js stable for much longer)
