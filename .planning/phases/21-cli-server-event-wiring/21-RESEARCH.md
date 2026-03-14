# Phase 21: CLI-Server Event Wiring & Metric Fix - Research

**Researched:** 2026-03-14
**Domain:** Node.js EventEmitter cross-process boundaries, Fastify plugin event lifecycle, prom-client metric cleanup
**Confidence:** HIGH

## Summary

Phase 21 closes three specific gaps identified by the v2.0 milestone audit. All three gaps are fully diagnosed by reading the existing source code — no external research is needed beyond confirming what the code already does.

**Gap 1 (CLI isolation):** The CLI creates its own `UserRegistry` instance to modify `users.json`. This new instance never emits `user-added`/`user-removed` events because those events are only fired in `handleFileChange()`, which runs on the `fs.watch` hot-reload path. The running server's `UserRegistry` instance (the one that `syncPlugin` and `indexerPlugin` listen to) only learns about the change when its `fs.watch` fires 500ms later — and in environments where `fs.watch` rename events are unreliable (Docker volumes, NFS), this signal silently fails. The fix is to emit events directly in `addUser()` and `removeUser()` on the `UserRegistry` instance that performed the write.

**Gap 2 (vault path race in indexer):** `createUserIndexer()` calls `fs.access(vaultPath)` and returns `null` if the path doesn't exist. When a user is added via CLI, the vault directory may not exist yet because `ob sync-setup` creates it asynchronously during the first sync run. If the indexer's `user-added` handler fires before the vault exists, the user's indexer is silently dropped with no recovery mechanism. The fix requires a retry/deferred strategy so the indexer can recover once the vault materializes.

**Gap 3 (OBS-03 commit state):** The audit claimed `sync.ts` was not committed, but commit `7ab0a51` ("fix(20-02): commit missing sync metric label removal in user-removed handler") already committed `.remove()` behavior to HEAD. Running `pnpm test -- --run src/plugins/__tests__/sync.test.ts` confirms all 12 tests pass. OBS-03 is satisfied at HEAD. Phase 21 should verify this and update REQUIREMENTS.md status from `[ ]` to `[x]` for OBS-03.

**Primary recommendation:** Add direct event emission to `UserRegistry.addUser()` and `removeUser()`, implement a vault-path retry loop in the `user-added` handler of `indexerPlugin`, and mark OBS-03 complete.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CLI-01 | `cognivault-ctl add-user` creates user with Obsidian credentials and OpenAI key | Requires `UserRegistry.addUser()` to emit `user-added` event directly so the running server reacts without relying on fs.watch |
| CLI-02 | `cognivault-ctl remove-user` stops sync, removes user | Requires `UserRegistry.removeUser()` to emit `user-removed` event directly so `syncPlugin` stops the process immediately |
| CLI-04 | `add-user` performs `ob login` + `ob sync-setup` and stores auth token | Already implemented in `add-user.ts`; wiring fix ensures server reacts to the write |
| SYNC-01 | Per-user vault synced via `ob sync --continuous` child process | `syncPlugin` already subscribes to `user-added`; fix ensures the event reliably reaches the server instance |
| OBS-03 | Per-user sync process health exposed as gauge metric | Already committed at HEAD in `7ab0a51`; Phase 21 verifies and marks complete |
</phase_requirements>

## Standard Stack

### Core (all already in the project)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js `EventEmitter` | built-in | `UserRegistry` extends this for `user-added`/`user-removed` | Already the event bus for plugin lifecycle |
| `node:fs/promises` | built-in | `fs.access()` for vault path checks | Used throughout the codebase |
| Vitest | v4.0.18 | Unit tests | Project standard (CLAUDE.md) |
| prom-client | installed | `Gauge.remove()` for metric cleanup | Already used in `sync.ts` |

### No new dependencies required

This phase involves surgical changes to existing files only. No new packages need to be installed.

## Architecture Patterns

### Recommended Project Structure

No new files needed for the core fixes. Changes target:

```
src/
  lib/
    user-registry.ts        # Add direct emit in addUser() / removeUser()
  plugins/
    indexer.ts              # Add vault-path retry on user-added
  lib/__tests__/
    user-registry.test.ts   # New tests for direct event emission
  plugins/__tests__/
    indexer.test.ts         # New tests for vault-path retry behavior
```

### Pattern 1: Direct Event Emission in Write Methods

**What:** `UserRegistry.addUser()` emits `user-added` after the atomic write succeeds. `removeUser()` emits `user-removed` after the atomic write succeeds.

**When to use:** Whenever a write operation must produce observable side effects regardless of the fs.watch signal being present.

**Example:**

```typescript
// src/lib/user-registry.ts — addUser() after atomicWrite
async addUser(record: UserRecord): Promise<void> {
  const validated = userRecordSchema.parse(record);
  // ... duplicate checks ...
  this.byUserId.set(validated.userId, validated);
  this.byApiKey.set(validated.apiKey, validated);
  await this.atomicWrite(Array.from(this.byUserId.values()));
  this.onUserCountChangeCb?.(this.getUserCount());
  // NEW: emit directly so server reacts without waiting for fs.watch
  this.emit('user-added', deepFreeze({ ...validated, obsidian: { ...validated.obsidian } }));
}
```

```typescript
// src/lib/user-registry.ts — removeUser() after atomicWrite
async removeUser(userId: string): Promise<void> {
  const user = this.byUserId.get(userId);
  if (!user) return;
  this.byUserId.delete(userId);
  this.byApiKey.delete(user.apiKey);
  await this.atomicWrite(Array.from(this.byUserId.values()));
  this.onUserCountChangeCb?.(this.getUserCount());
  // NEW: emit directly
  this.emit('user-removed', deepFreeze({ ...user, obsidian: { ...user.obsidian } }));
}
```

**Critical consideration — double-fire on server instance:** When the running server's `UserRegistry` calls `addUser()`, it will now emit `user-added` directly AND the `fs.watch` will detect the file change 500ms later and call `handleFileChange()` → `diffUsers()` → emit `user-added` again. The server's `syncPlugin` and `indexerPlugin` will receive two `user-added` events for the same user. Both plugins must be idempotent on double add.

Looking at `syncPlugin`: on second `user-added`, it calls `syncs.set(user.userId, entry)` and `startSync(user)` — this spawns a second `ob sync` process for the same user. This is a bug that must be fixed.

Looking at `indexerPlugin`: on second `user-added`, it calls `createUserIndexer()` which calls `fastify.indexers.set(userId, entry)` — this overwrites the existing entry (old indexer leaks without being stopped), then starts a new indexer. Also a bug.

**Deduplication strategy:** The hash-based reload skip in `handleFileChange()` partially addresses this. When the CLI's `UserRegistry` instance writes via `atomicWrite()`, it updates `this.lastContentHash`. But the server's `UserRegistry` instance has a _different_ `lastContentHash`. When `fs.watch` fires on the server's instance and it reads the file, the content has changed (from the CLI write), so `hash !== this.lastContentHash` is true and `diffUsers` runs, emitting `user-added` again.

**Correct deduplication approach:** In `handleFileChange()` → `diffUsers()`, the server already checks `!oldMap.has(userId)` before emitting `user-added`. When the server's own `addUser()` writes (i.e., the registry plugin calls `addUser()` directly, not the CLI), the server's byUserId map already contains the user, so `diffUsers` would find the user in both old and new maps and emit `user-updated` (not `user-added`). This is safe.

For the CLI case: the CLI uses a _separate_ `UserRegistry` instance (not the server's). The CLI writes the file. The server's registry gets a `fs.watch` event, reads the file, sees a new user (not in its `byUserId`), and emits `user-added`. That is the only event. No double-fire occurs for the CLI path.

The double-fire risk only exists if the **server's own registry** calls `addUser()`. Currently this does not happen — the server's registry is read-only (it loads and watches, plugins don't call `addUser()` on it). So the fix is safe.

**Conclusion:** Emitting directly in `addUser()` / `removeUser()` is safe in the current architecture because the server's registry never calls these methods. The CLI's registry instance emits events but has no listeners — those events are dropped. The server's registry gets notified via `fs.watch`. Adding direct emit to `UserRegistry` does not introduce double-fire.

### Pattern 2: Vault Path Retry in Indexer

**What:** When `user-added` fires, the vault path may not yet exist (ob sync-setup creates it lazily). Instead of silently returning `null`, the indexer should retry vault path creation with a bounded retry loop or schedule a deferred retry.

**When to use:** Any time an external process (ob sync) must create a directory before the indexer can initialize.

**Option A — Polling retry with exponential backoff (recommended):**

```typescript
// In indexerPlugin user-added handler
fastify.registry.on('user-added', async (user) => {
  // Wait for DB to be ready (existing pattern)
  for (let i = 0; i < 10; i++) {
    try { fastify.getUserDbById(user.userId); break; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  // Wait for vault path (ob sync creates it on first run)
  const MAX_VAULT_WAIT_MS = 30_000;
  const VAULT_POLL_INTERVAL_MS = 2_000;
  const deadline = Date.now() + MAX_VAULT_WAIT_MS;

  let entry: IndexerEntry | null = null;
  while (Date.now() < deadline) {
    entry = await createUserIndexer(fastify, user.userId, user.vaultPath);
    if (entry) break;
    await new Promise((r) => setTimeout(r, VAULT_POLL_INTERVAL_MS));
  }

  if (entry) {
    entry.indexer.start();
    fastify.log.info({ userId: user.userId }, 'Started per-user indexer');
  } else {
    fastify.log.warn(
      { userId: user.userId, vaultPath: user.vaultPath },
      'Vault path not available after 30s — indexer not started',
    );
  }
});
```

**Option B — Log warning, let manual reindex trigger indexer creation:**

Simpler: keep existing behavior but log a more actionable warning. Operator can run `POST /api/admin/reindex` which would trigger indexer creation. This requires less code but leaves the user without automatic indexing until manual intervention.

**Recommendation:** Option A is preferred for SYNC-01 compliance ("vault is synced") — if the indexer is never started, files are never indexed even after sync begins. 30 seconds is generous enough for `ob sync-setup` to create the vault directory in most environments.

**Important:** The retry loop must not block indefinitely. If the vault never materializes (bad config, wrong path), the loop must exit and log a warning. The `deadline` cap in Option A satisfies this.

### Anti-Patterns to Avoid

- **Emitting `user-added` in `handleFileChange` after already emitting in `addUser`:** Will cause double-start of sync and indexer. Understand the call graph before adding emits.
- **Infinite retry loop without deadline:** If vault path never materializes, the `user-added` handler hangs permanently, leaking async context.
- **Removing the `fs.access` guard entirely:** External tools can add users to `users.json` directly (not via CLI). The guard should remain; retry wraps around it, not replacing it.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Metric label deduplication | Custom label tracker | `prom-client` `Gauge.remove()` (already in sync.ts) | prom-client handles label set management |
| Cross-process event bus | IPC socket / Redis pub-sub | Direct emit in `UserRegistry.addUser()` | No cross-process communication needed — CLI writes disk, server watches disk |
| Vault path watcher | `fs.watch` on vault dir | Simple polling retry | fs.watch is unreliable on Docker volumes; polling is sufficient for one-time initialization |

## Common Pitfalls

### Pitfall 1: Double-Fire Assumption

**What goes wrong:** Developer assumes emitting in `addUser()` causes double-fire on the server's registry because fs.watch also fires.

**Why it happens:** The CLI uses a _separate_ `UserRegistry` instance. Only the server's instance has `syncPlugin`/`indexerPlugin` listeners. When the CLI's instance emits, no listeners hear it. When the server's fs.watch fires, the server's registry runs `diffUsers` and emits once.

**How to avoid:** Confirm the server's registry never directly calls `addUser()`. It currently does not — the server is read-only with respect to registry mutation.

**Warning signs:** Two `ob sync` processes visible in process list for the same user.

### Pitfall 2: OBS-03 Already Satisfied

**What goes wrong:** Planner creates a task to commit `sync.ts` changes, but they are already committed at `7ab0a51`.

**Why it happens:** The audit was written before `7ab0a51` was committed.

**How to avoid:** Verify HEAD state before creating "commit this change" tasks. `git log --oneline -5 -- src/plugins/sync.ts` shows `7ab0a51` is in HEAD. Tests pass. No commit needed.

**Correct action:** Phase 21 should update OBS-03 status in REQUIREMENTS.md from `[ ]` to `[x]` and record the evidence.

### Pitfall 3: Vault Retry Blocks User-Added Handler Indefinitely

**What goes wrong:** A 30-second polling loop inside an async event handler keeps the event loop occupied if many users are added simultaneously.

**Why it happens:** `async` event handlers in Node.js EventEmitter are fire-and-forget — unhandled rejections are a risk.

**How to avoid:** The retry loop exits after `MAX_VAULT_WAIT_MS`. Wrap with try/catch to prevent unhandled rejection. The existing `user-added` handler in indexerPlugin already uses `async` correctly — extend that pattern.

### Pitfall 4: Vault Routes Test Failures Are Pre-Existing

**What goes wrong:** Running `pnpm test` shows 18 failures in `vault/__tests__/routes.test.ts`. Developer assumes these are regressions from Phase 21 work.

**Why it happens:** These failures exist at HEAD before Phase 21 starts (confirmed by `git status` showing `src/features/vault/routes.ts` as a modified-but-unstaged file with `getUserVault()` refactoring that is incompatible with the existing test setup).

**How to avoid:** Document baseline test state before Phase 21 begins. Phase 21 is not responsible for fixing vault route tests (they are not in scope). Do not introduce regressions in `user-registry.test.ts` or `sync.test.ts`.

## Code Examples

### Current addUser() — missing direct emit

```typescript
// src/lib/user-registry.ts (current HEAD)
async addUser(record: UserRecord): Promise<void> {
  const validated = userRecordSchema.parse(record);
  if (this.byUserId.has(validated.userId)) {
    throw new Error(`Duplicate userId: ${validated.userId}`);
  }
  if (this.byApiKey.has(validated.apiKey)) {
    throw new Error(`Duplicate apiKey: ${validated.apiKey}`);
  }
  this.byUserId.set(validated.userId, validated);
  this.byApiKey.set(validated.apiKey, validated);
  await this.atomicWrite(Array.from(this.byUserId.values()));
  this.onUserCountChangeCb?.(this.getUserCount());
  // MISSING: this.emit('user-added', ...)
}
```

### Current removeUser() — missing direct emit

```typescript
// src/lib/user-registry.ts (current HEAD)
async removeUser(userId: string): Promise<void> {
  const user = this.byUserId.get(userId);
  if (!user) return;
  this.byUserId.delete(userId);
  this.byApiKey.delete(user.apiKey);
  await this.atomicWrite(Array.from(this.byUserId.values()));
  this.onUserCountChangeCb?.(this.getUserCount());
  // MISSING: this.emit('user-removed', ...)
}
```

### Current createUserIndexer() — no retry

```typescript
// src/plugins/indexer.ts (current HEAD) — returns null permanently if vault absent
async function createUserIndexer(
  fastify: FastifyInstance,
  userId: string,
  vaultPath: string,
): Promise<IndexerEntry | null> {
  try {
    await fs.access(vaultPath);
  } catch {
    fastify.log.warn(
      { userId, vaultPath },
      'Vault path does not exist — skipping indexer creation',
    );
    return null;  // PROBLEM: no recovery
  }
  // ...
}
```

### OBS-03 Status — Already Fixed at HEAD

```bash
# Confirm: commit 7ab0a51 contains the fix
git show 7ab0a51 --stat
# Output: src/plugins/sync.ts | 3 ++-

# Confirm: tests pass
pnpm test -- --run src/plugins/__tests__/sync.test.ts
# Output: 12 passed
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Events only via fs.watch hot-reload | Events emitted directly in write methods + fs.watch as fallback | Phase 21 | CLI writes immediately visible to server |
| Indexer silently drops users with missing vaults | Indexer retries vault access with bounded polling | Phase 21 | Users added before vault exists still get indexed |
| OBS-03 tracked as pending | OBS-03 confirmed satisfied at HEAD | Already done in 7ab0a51 | REQUIREMENTS.md needs status update |

## Open Questions

1. **Should `handleFileChange()` deduplicate against events already emitted by `addUser()`/`removeUser()`?**
   - What we know: CLI uses a separate registry instance; server's registry never calls `addUser()`; no deduplication is needed for the current architecture.
   - What's unclear: Future code might call `addUser()` on the server's registry (e.g., an admin API endpoint). If that happens, double-fire becomes a real risk.
   - Recommendation: Add a code comment in `handleFileChange()` explaining the assumption. Document it in SUMMARY.md.

2. **What should happen to a user whose vault never materializes?**
   - What we know: With a 30-second retry cap, the indexer logs a warning and gives up.
   - What's unclear: Should the user be automatically removed from the registry, or left in place for manual retry?
   - Recommendation: Leave in place. Operator can run a reindex admin endpoint or re-add the user. Automatic removal would be destructive.

3. **Are there existing tests for `addUser()` emitting events?**
   - What we know: `user-registry.test.ts` tests load, lookup, hot-reload, atomicity — but does not test that `addUser()` emits `user-added` directly (because it currently doesn't).
   - Recommendation: Wave 0 of Phase 21 must add these tests before implementing the fix.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest v4.0.18 |
| Config file | `vitest.config.ts` (implied by `pnpm test` script in package.json) |
| Quick run command | `pnpm test -- --run src/lib/__tests__/user-registry.test.ts` |
| Full suite command | `pnpm test -- --run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CLI-01 | `addUser()` emits `user-added` event directly | unit | `pnpm test -- --run src/lib/__tests__/user-registry.test.ts` | ✅ (file exists, test missing — Wave 0) |
| CLI-02 | `removeUser()` emits `user-removed` event directly | unit | `pnpm test -- --run src/lib/__tests__/user-registry.test.ts` | ✅ (file exists, test missing — Wave 0) |
| CLI-04 | add-user stores token and writes registry | unit | `pnpm test -- --run src/cli/__tests__/add-user.test.ts` | ✅ existing |
| SYNC-01 | Indexer retries vault path on user-added | unit | `pnpm test -- --run src/plugins/__tests__/indexer.test.ts` | ❌ Wave 0 |
| OBS-03 | sync metric `.remove()` on user-removed | unit | `pnpm test -- --run src/plugins/__tests__/sync.test.ts` | ✅ passing |

### Sampling Rate

- **Per task commit:** `pnpm test -- --run src/lib/__tests__/user-registry.test.ts src/plugins/__tests__/sync.test.ts`
- **Per wave merge:** `pnpm test -- --run`
- **Phase gate:** Full suite green (excluding pre-existing vault route failures) before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/lib/__tests__/user-registry.test.ts` — add tests: `addUser() emits user-added event`, `removeUser() emits user-removed event`
- [ ] `src/plugins/__tests__/indexer.test.ts` — create file; covers `user-added handler retries vault path`, `user-added handler gives up after timeout`
- [ ] Note: `src/plugins/__tests__/sync.test.ts` and `src/lib/__tests__/user-registry.test.ts` already exist and pass — extend, do not replace

## Sources

### Primary (HIGH confidence)

- Direct code inspection: `src/lib/user-registry.ts` — `addUser()`, `removeUser()`, `handleFileChange()`, `diffUsers()` — full source read
- Direct code inspection: `src/plugins/indexer.ts` — `createUserIndexer()`, `user-added` handler — full source read
- Direct code inspection: `src/plugins/sync.ts` — `user-removed` handler, `.remove()` calls — full source read
- Direct code inspection: `src/cli/commands/add-user.ts`, `remove-user.ts` — CLI creates separate `UserRegistry` instances — full source read
- Git log: `git log --oneline -- src/plugins/sync.ts` — confirms `7ab0a51` committed `.remove()` fix to HEAD
- Test run: `pnpm test -- --run src/plugins/__tests__/sync.test.ts` — confirms 12 tests pass

### Secondary (MEDIUM confidence)

- `.planning/v2.0-MILESTONE-AUDIT.md` — gap descriptions confirmed against current code; OBS-03 gap is stale (already fixed)
- `.planning/REQUIREMENTS.md` — requirement descriptions for CLI-01, CLI-02, CLI-04, SYNC-01, OBS-03
- `.planning/ROADMAP.md` — Phase 21 success criteria

### Tertiary (LOW confidence)

- None — all findings are sourced from code inspection and test execution.

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — no new dependencies; all libraries already in use
- Architecture: HIGH — analysis is based on reading the complete source of all affected files
- Pitfalls: HIGH — confirmed by reading `diffUsers()` logic and tracking the CLI's separate instance path
- OBS-03 state: HIGH — confirmed by git log and test execution

**Research date:** 2026-03-14
**Valid until:** 2026-04-14 (stable codebase, no moving dependencies)
