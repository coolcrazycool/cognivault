# Stack Research

**Domain:** Multi-tenant vault sync service — adding obsidian-headless sync and multi-tenant routing to existing CogniVault
**Researched:** 2026-03-14
**Confidence:** MEDIUM (obsidian-headless is beta v0.0.6; auth flow details partially inferred from forum posts)

---

## Existing Stack (Do Not Re-research)

The following are validated and in production. This document covers additions only.

Fastify 5, TypeBox, Zod, Drizzle + SQLite, Qdrant, OpenAI SDK, prom-client, OpenTelemetry, pino, Docker Compose.

---

## New Stack Additions

### Core Technologies

| Technology | Version | Purpose | Why Recommended | Confidence |
|------------|---------|---------|-----------------|------------|
| obsidian-headless | 0.0.6 (beta) | Run `ob sync --continuous` per user to keep vaults synced from Obsidian Sync | Only official headless client for Obsidian Sync; Node.js 22 native match; required by Obsidian credential model — no alternative exists | MEDIUM |
| commander | 14.0.x | Parse CLI subcommands (`add-user`, `remove-user`, `list-users`) | De facto Node.js CLI parsing standard; 14.x is current stable, TypeScript-native, subcommand model matches the user lifecycle operations | HIGH |
| child_process (built-in) | Node.js 22 built-in | Spawn/manage one `ob sync --continuous` process per registered user | No library needed — Node.js `spawn()` with `env` option handles per-process env isolation cleanly; use `SpawnedProcess` map keyed by user_id | HIGH |

### Supporting Libraries

| Library | Version | Purpose | When to Use | Confidence |
|---------|---------|---------|-------------|------------|
| execa | 9.6.x | Higher-level `child_process.spawn` wrapper | Use for the process manager that supervises `ob sync --continuous` processes — better TypeScript types, cleaner stdout/stderr piping, automatic cleanup on process exit | HIGH |
| @fastify/bearer-auth | current | Already in stack — extend for per-user API key → user_id lookup | Extend existing auth plugin to carry `user_id` on request context after key lookup; no new library needed | HIGH |

### Development Tools

No new dev tooling required. Existing Vitest, Biome, tsx, drizzle-kit cover the new features.

---

## Installation

```bash
# New production dependencies only
pnpm add commander execa

# obsidian-headless is a CLI tool — install globally in Docker image, not as project dep
# In Dockerfile: RUN npm install -g obsidian-headless@0.0.6
```

obsidian-headless must be installed globally (`npm install -g obsidian-headless`) because it is invoked as the `ob` CLI binary, not imported as a module. It has no programmatic Node.js API — it is CLI-only.

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| execa | Native child_process.spawn | For trivial one-shot commands; execa's TypeScript types and stdout stream handling justify the dependency for long-running supervised processes |
| commander | yargs | yargs when you need complex argument coercion or `.completion()` shell scripts; commander is simpler for 3 subcommands |
| commander | oclif | oclif when building a plugin-based CLI with many commands; overkill for a 3-command admin tool |
| Single SQLite DB (per-user rows) | Per-user SQLite file | Per-user files make cross-user queries harder; a single DB with `user_id` FK on all tables is simpler for an admin CLI that lists all users |
| Qdrant payload-based multitenancy | One Qdrant collection per user | Multiple collections are fine for small user counts (< 50) but payload-based with `user_id` filter is more efficient and matches Qdrant's official recommendation for shared infrastructure |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| PM2 | Process supervisor that duplicates what a simple Map + execa already handles; adds config file, daemonization complexity, and a non-trivial dependency for what is just N supervised child processes | Node.js built-in child_process via execa with restart logic in the process manager service |
| Docker-in-Docker / per-user containers | v1.0 approach (Phase 16) — discarded because it requires VNC/Selkies GUI, per-user Docker networking, and Caddy routing complexity. Architectural pivot to single-container multi-tenant is the active direction per PROJECT.md | Single CogniVault process with per-user child process supervision |
| keytar / gnome-keyring in Docker | obsidian-headless 0.0.3+ fixed keychain dependency for `ob sync-setup` on headless Linux, but do not introduce keytar as a project dependency — rely on `OBSIDIAN_AUTH_TOKEN` env var pattern instead | Store auth token as encrypted value in SQLite at user registration time; inject via child process `env` option |
| Cross-tenant Qdrant queries | Querying without `must: [{ key: "user_id", match: { value: userId } }]` filter will bleed across tenants | Always inject `user_id` filter at the service layer; enforce at the middleware/decorator level, not call-site |
| LangChain / LlamaIndex | Unchanged from v1.0 decision — massive dependency for no new capability | Already using custom chunker |

---

## Stack Patterns by Variant

**If obsidian-headless beta breaks between patch versions:**
- Pin to exact version in Dockerfile (`npm install -g obsidian-headless@0.0.6`)
- Add a smoke test in the Docker build: `RUN ob --version`
- Treat the `ob sync --continuous` process as a black box — watch stdout/stderr for error patterns and restart on non-zero exit

**If OBSIDIAN_AUTH_TOKEN env var approach is insufficient (token expiry, interactive MFA):**
- Surface a "vault sync broken" status per user in the `/admin/users` endpoint
- The CLI `add-user` command must run `ob login` interactively at user registration time, capture the resulting token from `~/.config/obsidian-headless/auth_token` or `$HOME/.obsidian-headless/auth_token`, and store it encrypted in SQLite
- Token path is not officially documented — verify against `obsidian-headless@0.0.6` source or `ob login --help`

**If Qdrant tiered multitenancy is needed (large per-user collections):**
- Qdrant 1.16+ supports tiered multitenancy: small users share a fallback shard, large users get promoted to dedicated shards via a single API call
- For the current scale (500-5K notes per user, 1-10 users), single collection with `user_id` payload filter is sufficient

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| obsidian-headless@0.0.6 | Node.js 22+ | Requires Node.js 22 explicitly per official docs; matches our runtime |
| commander@14.x | Node.js 18+ / ESM | Full ESM support; import `{ Command } from 'commander'` |
| execa@9.x | Node.js 18+ / ESM-only | ESM-only package; `import { execa } from 'execa'` — no CJS compat |
| execa@9.x | TypeScript 5.x | Full type definitions included |

---

## Architecture Integration Notes

### Multi-tenant Qdrant Pattern

Existing: one Qdrant collection per vault (single-user). New: one Qdrant collection per embedding model, shared across all users, with `user_id` payload field on every point. All search queries must include `filter: { must: [{ key: "user_id", match: { value: req.userId } }] }`.

This matches Qdrant's official multitenancy recommendation (single collection + payload partitioning) and avoids the 1,000-collection Cloud limit.

### API Key → User Registry Pattern

Existing auth: `@fastify/bearer-auth` validates a static key. New pattern: bearer-auth plugin extended to look up the API key in SQLite `users` table, resolve `user_id`, and decorate `request.userId`. All downstream service calls receive `userId` parameter.

New SQLite tables needed:
- `users` — `user_id`, `api_key_hash`, `obsidian_email`, `obsidian_auth_token` (encrypted), `openai_api_key` (encrypted), `vault_path`, `created_at`, `status`
- Existing `indexed_files` — add `user_id` FK column for per-user index state

### Process Supervision Pattern

```typescript
// ProcessManager service (conceptual)
interface SyncProcess {
  userId: string;
  process: ChildProcess;
  restarts: number;
  lastStarted: Date;
}

// Map<userId, SyncProcess> — one entry per active user
// On CogniVault startup: spawn ob sync --continuous for all active users
// On add-user: spawn and register
// On remove-user: SIGTERM + remove from map
// On crash (exit code !== 0): exponential backoff restart, max 5 attempts/hour
```

Each child process gets isolated env: `{ OBSIDIAN_AUTH_TOKEN: user.authToken, HOME: user.vaultPath, ... }`. Parent process env is NOT inherited to prevent cross-tenant credential leakage.

### CLI Tool Pattern

```typescript
// src/cli/index.ts — separate entry point from src/server.ts
import { Command } from 'commander';
const program = new Command();
program.name('cognivault-admin').version('2.0.0');
program.addCommand(addUserCommand);
program.addCommand(removeUserCommand);
program.addCommand(listUsersCommand);
program.parse();
```

Add `"bin": { "cognivault-admin": "./dist/cli/index.js" }` to package.json.

---

## Known Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| obsidian-headless is beta (v0.0.6) — breaking changes expected | HIGH | Pin exact version, test `ob sync --continuous` process lifecycle in integration test, wrap in restart-on-crash supervisor |
| OBSIDIAN_AUTH_TOKEN path not officially documented | MEDIUM | Verify against `obsidian-headless@0.0.6` installed package; add a smoke test to CLI `add-user` that confirms token can be read after `ob login` |
| keychain unavailability on headless Linux (fixed in 0.0.3+) | LOW | Verified fixed; still add Docker build smoke test |
| Qdrant filter omission causes cross-tenant data bleed | HIGH | Enforce `user_id` filter injection at Fastify plugin level (decorator), not per-route; add integration test that verifies user B cannot see user A's vectors |

---

## Sources

- [obsidian-headless GitHub](https://github.com/obsidianmd/obsidian-headless) — CLI commands, auth flow, Node.js 22 requirement
- [Obsidian changelog 2026-02-27](https://obsidian.md/changelog/2026-02-27-sync/) — official release announcement
- [Obsidian Forum: OBSIDIAN_AUTH_TOKEN](https://forum.obsidian.md/t/headless-sync-how-to-get-obsidian-auth-token-variable/111740) — token file location, keychain behavior (MEDIUM confidence — community forum)
- [Obsidian Forum: headless Linux keychain bug](https://forum.obsidian.md/t/ob-sync-setup-fails-on-headless-linux-keychain-unavailable/111679) — fixed in v0.0.3 (MEDIUM confidence)
- [npm: obsidian-headless](https://www.npmjs.com/package/obsidian-headless) — version 0.0.6, published March 2026
- [npm: commander](https://www.npmjs.com/package/commander) — version 14.0.3 current stable
- [npm: execa](https://www.npmjs.com/package/execa) — version 9.6.1, ESM-only
- [Qdrant multitenancy docs](https://qdrant.tech/documentation/guides/multitenancy/) — single collection + payload partitioning recommendation
- [Qdrant 1.16 tiered multitenancy](https://qdrant.tech/blog/qdrant-1.16.x/) — tiered approach for unequal tenant sizes
- [Node.js child_process docs](https://nodejs.org/api/child_process.html) — spawn env isolation

---

*Stack research for: CogniVault v2.0 Multi-User — obsidian-headless sync + multi-tenant routing*
*Researched: 2026-03-14*
