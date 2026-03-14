# Phase 15: Registry Foundation - Research

**Researched:** 2026-03-14
**Domain:** File-backed user registry with hot-reload, atomic writes, typed events
**Confidence:** HIGH

## Summary

Phase 15 builds a `UserRegistry` class that manages multi-user configuration from a `users.json` file. The class loads at startup, provides O(1) lookups by API key or userId via internal Maps, watches the parent directory for changes using Node's `fs.watch`, debounces reloads, validates with Zod, and emits typed lifecycle events. Writes use atomic tmp+rename to prevent corruption.

The project already has established patterns for every component needed: typed `EventEmitter` (VaultIndexer), Zod config validation (config.ts), Fastify plugin wrapping with `fp()` (indexer.ts), `fastify.decorate()` for services, and prom-client metrics. This phase follows all existing patterns closely. No new dependencies are needed -- everything uses Node.js built-ins and Zod (already installed at v4.3.6).

**Primary recommendation:** Build `UserRegistry` as a standalone class in `src/lib/user-registry.ts` following the VaultIndexer pattern (typed EventEmitter, constructor injection, no Fastify dependency), with a thin plugin wrapper in `src/plugins/registry.ts` that decorates `fastify.registry` and wires lifecycle hooks.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Top-level structure: JSON array of user objects
- Core fields: userId, apiKey, vaultPath, openaiKey
- Nested obsidian object: email, password, vault (all required), token (optional, populated after login)
- Both password and token stored -- token for sync, password for re-auth fallback
- API keys must have `cv-` prefix (validated by Zod schema)
- userId format: lowercase alphanumeric + hyphens only (slug format)
- Uniqueness enforced on both userId and apiKey -- duplicate of either is a validation error
- File location: `{COGNIVAULT_DATA_DIR}/users.json` (default `.cognivault/users.json`)
- Auto-creates empty `[]` file if none exists at startup
- Use Node's built-in `fs.watch` on the parent directory (not the file itself) to detect atomic rename-over writes
- Debounce ~500ms after last change event before reloading
- Content hashing to skip reload when file is touched but content unchanged
- Survives file deletion and recreation -- keeps last valid registry in memory, re-establishes watch when file reappears
- Full field comparison on reload -- detects added/removed users AND field changes within existing users
- Registry extends EventEmitter, emits `user-added`, `user-removed`, `user-updated` events with affected user record
- Info-level log on successful reload, warn on validation rejection
- Prometheus metrics: `cognivault_registry_reloads_total` counter (labels: status=success|rejected) and `cognivault_registry_users` gauge
- Graceful shutdown via `fastify.addHook('onClose', ...)` to close fs.watch handle
- No manual reload endpoint -- fs.watch only
- Standalone `UserRegistry` class in `src/lib/user-registry.ts` (no Fastify dependency)
- Thin Fastify plugin wrapper in `src/plugins/registry.ts` that decorates `fastify.registry`
- Lookup methods: `getUserByApiKey(key)`, `getUserById(userId)`, `getAllUsers()`, `getUserCount()` -- all O(1) via Maps
- Write methods: `addUser(record)`, `removeUser(userId)` -- validate, update in-memory, atomic write to disk
- Static utility: `UserRegistry.generateApiKey()` -- generates `cv-`-prefixed cryptographically random keys
- Returned user records are `Object.freeze`'d copies
- Sensitive fields (openaiKey, obsidian.password, obsidian.token) redacted in Pino log serialization
- Zod schema for users.json validation
- Reject entire file on any invalid entry -- no partial loads
- On startup: if malformed, refuse to start (fatal error); if missing, create empty `[]`
- Atomic write: private method within UserRegistry, not extracted as shared utility

### Claude's Discretion
- Exact SHA algorithm for content hashing
- Internal Map structure (single Map<apiKey, UserRecord> + Map<userId, UserRecord>, or combined)
- Debounce implementation details
- Test file organization within `src/lib/__tests__/`
- Zod schema field ordering and error message wording

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| TENANT-02 | User registry (users.json) is hot-reloaded via filesystem watch without restarting CogniVault | fs.watch on parent directory with debounce, content hashing, Zod re-validation on each reload |
| TENANT-03 | Registry writes are atomic (tmp + rename) to prevent corrupted state on crash | fs.writeFile to temp file in same directory + fs.rename for atomic POSIX rename |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| node:fs/promises | Node 22+ | Async file read/write/rename | Built-in, no dependency needed |
| node:fs | Node 22+ | `fs.watch()` for directory watching | Built-in, no wrapper library needed for single-file watch |
| node:crypto | Node 22+ | SHA-256 content hashing + `randomBytes` for API key generation | Built-in, cryptographically secure |
| node:path | Node 22+ | Path manipulation for data dir / temp files | Built-in |
| node:events | Node 22+ | Typed `EventEmitter<Events>` base class | Already used by VaultIndexer in this project |
| zod | ^4.3.6 | Schema validation for users.json | Already in project, matches config.ts pattern |
| prom-client | ^15.1.3 | Counter + Gauge metrics | Already in project metrics plugin |
| fastify-plugin | ^5.1.0 | `fp()` wrapper for plugin encapsulation | Already in all project plugins |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none) | - | - | All needs met by existing deps |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| fs.watch | chokidar | Overkill for single-file watch; adds dependency; user locked `fs.watch` |
| SHA-256 | MD5/xxhash | SHA-256 is fast enough for small JSON, already in node:crypto |
| Custom debounce | lodash.debounce | Trivial to implement (setTimeout), avoids dependency |

**Installation:**
```bash
# No new packages needed -- all dependencies already installed
```

## Architecture Patterns

### Recommended Project Structure
```
src/
  lib/
    user-registry.ts          # Standalone UserRegistry class (no Fastify dep)
    __tests__/
      user-registry.test.ts   # Unit tests for UserRegistry
  plugins/
    registry.ts               # Thin Fastify plugin wrapper
    __tests__/
      registry.test.ts        # Integration tests (plugin lifecycle)
```

### Pattern 1: Standalone Class + Plugin Wrapper (from VaultIndexer)
**What:** Business logic in `src/lib/` as a plain class, Fastify wiring in `src/plugins/`
**When to use:** When the class needs to be reusable outside Fastify (CLI in Phase 19)
**Example:**
```typescript
// src/lib/user-registry.ts
// Source: Existing VaultIndexer pattern in src/lib/indexer.ts
import { EventEmitter } from 'node:events';

interface RegistryEvents {
  'user-added': [user: UserRecord];
  'user-removed': [user: UserRecord];
  'user-updated': [user: UserRecord, previous: UserRecord];
}

export class UserRegistry extends EventEmitter<RegistryEvents> {
  constructor(options: UserRegistryOptions) {
    super();
    // ...
  }
}
```

```typescript
// src/plugins/registry.ts
// Source: Existing indexer plugin pattern in src/plugins/indexer.ts
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { UserRegistry } from '../lib/user-registry.js';

declare module 'fastify' {
  interface FastifyInstance {
    registry: UserRegistry;
  }
}

async function registryPlugin(fastify: FastifyInstance): Promise<void> {
  const registry = new UserRegistry({ /* options */ });
  await registry.load();    // Initial load (throws if malformed)
  registry.startWatching(); // Begin fs.watch

  fastify.decorate('registry', registry);

  fastify.addHook('onClose', async () => {
    registry.stopWatching();
  });
}

export default fp(registryPlugin, { name: 'registry', dependencies: [] });
```

### Pattern 2: Typed EventEmitter (from VaultIndexer)
**What:** Node.js 22+ supports generic `EventEmitter<EventMap>` for type-safe event emission
**When to use:** Any class that emits domain events
**Example:**
```typescript
// Source: src/lib/indexer.ts lines 42-46, 89
interface RegistryEvents {
  'user-added': [user: UserRecord];
  'user-removed': [user: UserRecord];
  'user-updated': [user: UserRecord, previous: UserRecord];
}

export class UserRegistry extends EventEmitter<RegistryEvents> {
  // this.emit('user-added', userRecord)  -- fully type-checked
  // this.on('user-added', (user) => {})  -- user is typed as UserRecord
}
```

### Pattern 3: Atomic Write (tmp + rename)
**What:** Write to temp file, then rename atomically to prevent corruption on crash
**When to use:** Any file that must never be partially written
**Example:**
```typescript
// Source: POSIX rename(2) guarantees
import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

private async atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmpPath, data, 'utf-8');
  await rename(tmpPath, filePath);  // Atomic on POSIX (same filesystem)
}
```

### Pattern 4: Directory Watch with Debounce
**What:** Watch parent directory (not file) to detect atomic rename-over writes, debounce rapid events
**When to use:** When watching a file that gets replaced via rename (atomic write)
**Example:**
```typescript
// Source: Node.js fs.watch docs + CONTEXT.md decision
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

private watcher: FSWatcher | null = null;
private debounceTimer: NodeJS.Timeout | null = null;

startWatching(): void {
  const dir = dirname(this.filePath);
  const fileName = basename(this.filePath);

  this.watcher = watch(dir, (eventType, changedFile) => {
    if (changedFile !== fileName) return;

    // Debounce: reset timer on each event
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.handleFileChange(), 500);
  });

  this.watcher.on('error', (err) => {
    this.logger?.warn({ err }, 'fs.watch error');
  });
}

stopWatching(): void {
  if (this.debounceTimer) clearTimeout(this.debounceTimer);
  this.watcher?.close();
  this.watcher = null;
}
```

### Pattern 5: Content Hash for Skip-Reload
**What:** Hash file content after read, compare to last hash, skip processing if unchanged
**When to use:** Avoid unnecessary reloads when file is touched but content is same
**Example:**
```typescript
import { createHash } from 'node:crypto';

private lastContentHash: string = '';

private computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

private async handleFileChange(): Promise<void> {
  const content = await readFile(this.filePath, 'utf-8');
  const hash = this.computeHash(content);
  if (hash === this.lastContentHash) return; // No actual change
  // ... validate and reload
}
```

### Pattern 6: Zod Validation (following config.ts)
**What:** Define Zod schema for user records, parse entire file, reject on any error
**When to use:** Validating untrusted JSON input
**Example:**
```typescript
// Source: Existing config.ts pattern + Zod v4 API
import { z } from 'zod';

const obsidianSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
  vault: z.string().min(1),
  token: z.string().optional(),
});

const userRecordSchema = z.object({
  userId: z.string().regex(/^[a-z0-9-]+$/, 'userId must be lowercase alphanumeric + hyphens'),
  apiKey: z.string().regex(/^cv-/, 'apiKey must start with cv-'),
  vaultPath: z.string().min(1),
  openaiKey: z.string().min(1),
  obsidian: obsidianSchema,
});

const usersFileSchema = z.array(userRecordSchema);

export type UserRecord = z.infer<typeof userRecordSchema>;
```

### Anti-Patterns to Avoid
- **Watching the file directly with fs.watch:** Atomic rename-over replaces the inode; watching the file loses the watch. Watch the parent directory instead.
- **Partial loads on validation error:** Never load "valid" entries and skip invalid ones. The entire file is valid or the entire file is rejected. This prevents confusing states where some users silently disappear.
- **Storing Maps by reference:** User records returned from lookup methods must be `Object.freeze`'d copies to prevent callers from mutating internal state.
- **Using default prom-client registry:** Project uses per-instance `Registry` in the metrics plugin. Registry metrics must be registered on the same instance, passed via constructor or plugin wiring.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Schema validation | Custom JSON field checks | Zod `z.array(z.object({...}))` | Type inference, consistent error messages, project convention |
| Crypto-random API keys | `Math.random()` based | `crypto.randomBytes(24).toString('base64url')` | Cryptographically secure, URL-safe output |
| File watching | Polling with setInterval | `fs.watch()` on parent directory | OS-native events, sub-second detection, lower CPU |
| Debouncing | Full lodash import | Inline setTimeout/clearTimeout pattern | 5 lines of code, no dependency |
| Atomic file write | Direct `writeFile` | `writeFile` to `.tmp` + `rename` | POSIX rename is atomic; direct write can leave partial content |

**Key insight:** This phase uses exclusively Node.js built-ins plus Zod (already installed). No new dependencies needed.

## Common Pitfalls

### Pitfall 1: fs.watch on file vs directory
**What goes wrong:** Watching the file directly loses the watch when the file is atomically replaced (the old inode is gone).
**Why it happens:** Atomic writes create a new file and rename over the old one. The watcher is bound to the old inode.
**How to avoid:** Watch the parent directory and filter events by filename match.
**Warning signs:** Watch works once but stops detecting changes after the first atomic write.

### Pitfall 2: fs.watch fires multiple events per change
**What goes wrong:** A single file save triggers 2-4 `change`/`rename` events in rapid succession.
**Why it happens:** OS-level file operations are multi-step (truncate + write, or create-tmp + rename).
**How to avoid:** Debounce with ~500ms window. Reset timer on each event.
**Warning signs:** Duplicate reload logs, race conditions in validation.

### Pitfall 3: Race between read and write during reload
**What goes wrong:** `handleFileChange` triggers while `addUser`/`removeUser` is mid-write, causing stale data to overwrite the new write.
**Why it happens:** fs.watch detects our own atomic writes.
**How to avoid:** Use a "writing" flag or ignore events within a short window after the registry itself writes. Alternatively, compare content hash -- if the file content matches what we just wrote, skip reload.
**Warning signs:** User added via `addUser()` disappears on next lookup.

### Pitfall 4: Zod v4 API differences
**What goes wrong:** Using Zod v3 syntax like `z.string().email()` or `z.record(valueSchema)`.
**Why it happens:** Project uses Zod v4 (^4.3.6) which moved string formats to top-level and requires two args for record.
**How to avoid:** Use `z.string().regex(...)` for custom formats, `z.object({...})` for records. The user record schema uses basic Zod v4 features (object, string, array, regex, optional) which are unchanged from v3.
**Warning signs:** TypeScript errors or runtime Zod errors about unexpected arguments.

### Pitfall 5: File deletion breaks watch permanently
**What goes wrong:** If users.json is deleted, the watcher might not detect recreation.
**Why it happens:** Directory-level watch should detect new files appearing, but edge cases exist.
**How to avoid:** On "rename" events where the file disappears, keep the directory watcher alive. On next event where the file reappears, reload. Content hash comparison handles the rest.
**Warning signs:** Deleting and recreating users.json doesn't trigger reload.

### Pitfall 6: Forgetting Object.freeze depth
**What goes wrong:** `Object.freeze` is shallow -- nested `obsidian` object remains mutable.
**Why it happens:** JavaScript freeze is non-recursive by default.
**How to avoid:** Either deep-freeze (recursive freeze) or freeze at each nesting level. For this schema (one level of nesting), freeze both the outer record and the `obsidian` sub-object.
**Warning signs:** Tests pass but consumers can mutate `user.obsidian.token` and affect registry state.

### Pitfall 7: Metrics registration on wrong Registry
**What goes wrong:** Metrics don't appear on `/metrics` endpoint.
**Why it happens:** Using prom-client's global default registry instead of the per-instance `Registry` from the metrics plugin.
**How to avoid:** The registry plugin must accept a prom-client `Registry` instance and register Counter/Gauge on it. Or: register metrics in the plugin wrapper where `fastify.metrics` access is available, and pass metric increment callbacks into UserRegistry.
**Warning signs:** Counter/Gauge created but never scraped.

## Code Examples

### Complete UserRecord Type (Zod v4)
```typescript
// Source: CONTEXT.md locked decisions + Zod v4 API
import { z } from 'zod';

const obsidianSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
  vault: z.string().min(1),
  token: z.string().optional(),
});

const userRecordSchema = z.object({
  userId: z.string().regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/),
  apiKey: z.string().regex(/^cv-.+$/),
  vaultPath: z.string().min(1),
  openaiKey: z.string().min(1),
  obsidian: obsidianSchema,
});

const usersFileSchema = z.array(userRecordSchema);

export type UserRecord = z.infer<typeof userRecordSchema>;
export type ObsidianConfig = z.infer<typeof obsidianSchema>;
```

### API Key Generation
```typescript
// Source: Node.js crypto docs
import { randomBytes } from 'node:crypto';

static generateApiKey(): string {
  const random = randomBytes(24).toString('base64url');
  return `cv-${random}`;
}
```

### Uniqueness Validation (post-parse)
```typescript
private validateUniqueness(users: UserRecord[]): void {
  const userIds = new Set<string>();
  const apiKeys = new Set<string>();

  for (const user of users) {
    if (userIds.has(user.userId)) {
      throw new Error(`Duplicate userId: ${user.userId}`);
    }
    if (apiKeys.has(user.apiKey)) {
      throw new Error(`Duplicate apiKey for user: ${user.userId}`);
    }
    userIds.add(user.userId);
    apiKeys.add(user.apiKey);
  }
}
```

### Deep Freeze Helper
```typescript
function deepFreeze<T extends Record<string, unknown>>(obj: T): Readonly<T> {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value as Record<string, unknown>);
    }
  }
  return Object.freeze(obj);
}
```

### Diff Detection for Events
```typescript
private diffUsers(
  oldUsers: Map<string, UserRecord>,
  newUsers: Map<string, UserRecord>,
): void {
  // Detect removed users
  for (const [userId, oldUser] of oldUsers) {
    if (!newUsers.has(userId)) {
      this.emit('user-removed', oldUser);
    }
  }
  // Detect added and updated users
  for (const [userId, newUser] of newUsers) {
    const oldUser = oldUsers.get(userId);
    if (!oldUser) {
      this.emit('user-added', newUser);
    } else if (JSON.stringify(oldUser) !== JSON.stringify(newUser)) {
      this.emit('user-updated', newUser, oldUser);
    }
  }
}
```

### Pino Redaction for Sensitive Fields
```typescript
// Source: Existing pattern in src/app.ts for Authorization header redaction
// In app.ts buildLoggerOptions, extend redact paths:
redact: [
  'req.headers.authorization',
  // User registry sensitive fields (when logged)
  '*.openaiKey',
  '*.obsidian.password',
  '*.obsidian.token',
]
```

### Metrics Integration Pattern
```typescript
// In src/plugins/registry.ts -- register metrics on Fastify's prom-client Registry
// The metrics plugin creates a per-instance Registry. Registry plugin needs access to it.
// Option A: Depend on metrics plugin, access its registry
// Option B: Accept metric callbacks in UserRegistry constructor (keeps it Fastify-free)

// Recommended: Option B -- UserRegistry accepts optional callbacks
interface UserRegistryOptions {
  filePath: string;
  logger?: { info: Function; warn: Function; error: Function };
  onReload?: (status: 'success' | 'rejected') => void;
  onUserCountChange?: (count: number) => void;
}

// In plugin wrapper:
const reloadsCounter = new Counter({
  name: 'cognivault_registry_reloads_total',
  help: 'Total registry reload attempts',
  labelNames: ['status'] as const,
  registers: [promRegistry],  // from metrics plugin
});
const usersGauge = new Gauge({
  name: 'cognivault_registry_users',
  help: 'Current number of registered users',
  registers: [promRegistry],
});

const registry = new UserRegistry({
  filePath: usersJsonPath,
  logger: fastify.log,
  onReload: (status) => reloadsCounter.inc({ status }),
  onUserCountChange: (count) => usersGauge.set(count),
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `EventEmitter` untyped | `EventEmitter<EventMap>` typed generic | Node.js 22 (2024) | Full type safety on emit/on without wrappers |
| Zod v3 `z.string().email()` | Zod v4 `z.email()` (top-level) | Zod 4.0 (2025) | Not relevant here (we use `.regex()` not format validators) |
| chokidar for file watching | chokidar v5 ESM-only | Nov 2025 | Not using chokidar -- user locked `fs.watch` |

**Deprecated/outdated:**
- `fs.watchFile` (polling-based): Use `fs.watch` instead (OS-native events)
- Untyped EventEmitter: Node 22+ supports `EventEmitter<EventMap>` generics

## Open Questions

1. **Metrics Registry Access Pattern**
   - What we know: Metrics plugin creates a per-instance `Registry` but doesn't expose it as a Fastify decoration. Current metrics are all defined inside the metrics plugin.
   - What's unclear: How the registry plugin accesses the same prom-client `Registry` to register its Counter and Gauge.
   - Recommendation: Either (a) add the prom-client Registry to the Fastify decoration alongside the metrics collection, or (b) define registry metrics inside the metrics plugin and add them to `fastify.metrics`, or (c) use callback injection in UserRegistry constructor (keeps UserRegistry Fastify-free, recommended).

2. **app.ts Registration Order**
   - What we know: Registry plugin must be registered early (before auth, per CONTEXT.md), but metrics plugin is currently registered after auth and swagger.
   - What's unclear: If registry depends on metrics for prom-client Registry access, the ordering may need adjustment.
   - Recommendation: Register registry plugin after metrics plugin. Or use approach (c) above where metrics are wired in the plugin wrapper using its own prom-client Counter/Gauge instances registered on a separate or the default registry. Simplest: register metrics plugin earlier (it has no dependencies).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.0.18 |
| Config file | `vitest.config.ts` |
| Quick run command | `pnpm test -- --run src/lib/__tests__/user-registry.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TENANT-02 | Load users.json at startup, lookup by API key | unit | `pnpm test -- --run src/lib/__tests__/user-registry.test.ts` | No -- Wave 0 |
| TENANT-02 | Hot-reload on file change via fs.watch | unit | `pnpm test -- --run src/lib/__tests__/user-registry.test.ts` | No -- Wave 0 |
| TENANT-02 | Reject malformed file, keep last valid registry | unit | `pnpm test -- --run src/lib/__tests__/user-registry.test.ts` | No -- Wave 0 |
| TENANT-02 | Content hash skip on unchanged file | unit | `pnpm test -- --run src/lib/__tests__/user-registry.test.ts` | No -- Wave 0 |
| TENANT-02 | Emit user-added/removed/updated events on reload diff | unit | `pnpm test -- --run src/lib/__tests__/user-registry.test.ts` | No -- Wave 0 |
| TENANT-03 | Atomic write (tmp+rename) on addUser/removeUser | unit | `pnpm test -- --run src/lib/__tests__/user-registry.test.ts` | No -- Wave 0 |
| TENANT-03 | Crash during write never corrupts file | unit | `pnpm test -- --run src/lib/__tests__/user-registry.test.ts` | No -- Wave 0 |
| - | Plugin lifecycle (decorate, onClose cleanup) | integration | `pnpm test -- --run src/plugins/__tests__/registry.test.ts` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test -- --run src/lib/__tests__/user-registry.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/lib/__tests__/user-registry.test.ts` -- covers TENANT-02, TENANT-03 (UserRegistry unit tests)
- [ ] `src/plugins/__tests__/registry.test.ts` -- covers plugin integration (decorate, lifecycle hooks)
- No framework install needed -- Vitest already configured

## Sources

### Primary (HIGH confidence)
- Project source code: `src/lib/indexer.ts` -- typed EventEmitter pattern, constructor injection
- Project source code: `src/plugins/indexer.ts` -- plugin wrapper pattern with lifecycle hooks
- Project source code: `src/config.ts` -- Zod validation pattern
- Project source code: `src/plugins/metrics.ts` -- prom-client per-instance Registry, Counter/Gauge registration
- Project source code: `src/app.ts` -- plugin registration order, Pino redact config
- Project source code: `src/plugins/auth.ts` -- current single-key auth (Phase 16 will replace)
- [Node.js fs.watch documentation](https://nodejs.org/api/fs.html) -- FSWatcher API, directory watching behavior

### Secondary (MEDIUM confidence)
- [Zod v4 migration guide](https://zod.dev/v4/changelog) -- confirmed API differences from v3
- [Node.js fs.watch caveats](https://nodejs.org/api/fs.html) -- platform-specific behavior, multiple event firing

### Tertiary (LOW confidence)
- None -- all findings verified against project source or official docs

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already in project, no new deps
- Architecture: HIGH -- follows established VaultIndexer + plugin wrapper pattern exactly
- Pitfalls: HIGH -- verified against Node.js docs and project codebase patterns

**Research date:** 2026-03-14
**Valid until:** 2026-04-14 (stable domain, no fast-moving dependencies)
