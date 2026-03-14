# Phase 15: Registry Foundation - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

<domain>
## Phase Boundary

A UserRegistry class manages multi-user configuration stored in users.json. It loads at startup, provides in-memory lookup by API key or userId, hot-reloads on file changes via fs.watch, emits lifecycle events (user-added/removed/updated), uses atomic tmp+rename writes, and validates with Zod. Phase 16 (auth integration) and Phase 19 (CLI) consume the registry API.

</domain>

<decisions>
## Implementation Decisions

### User record schema
- Top-level structure: JSON array of user objects
- Core fields: userId, apiKey, vaultPath, openaiKey
- Nested obsidian object: email, password, vault (all required), token (optional, populated after login)
- Both password and token stored — token for sync, password for re-auth fallback
- API keys must have `cv-` prefix (validated by Zod schema)
- userId format: lowercase alphanumeric + hyphens only (slug format, safe for file paths and metric labels)
- Uniqueness enforced on both userId and apiKey — duplicate of either is a validation error
- File location: `{COGNIVAULT_DATA_DIR}/users.json` (default `.cognivault/users.json`)
- Auto-creates empty `[]` file if none exists at startup

### File watching
- Use Node's built-in `fs.watch` on the parent directory (not the file itself) to correctly detect atomic rename-over writes
- Debounce ~500ms after last change event before reloading
- Content hashing (SHA-256 or similar) to skip reload when file is touched but content unchanged
- Survives file deletion and recreation — keeps last valid registry in memory, re-establishes watch when file reappears
- Full field comparison on reload — detects added/removed users AND field changes within existing users
- Registry extends EventEmitter, emits `user-added`, `user-removed`, `user-updated` events with affected user record
- Info-level log on successful reload ("Registry reloaded: N users"), warn on validation rejection
- Prometheus metrics: `cognivault_registry_reloads_total` counter (labels: status=success|rejected) and `cognivault_registry_users` gauge
- Graceful shutdown via `fastify.addHook('onClose', ...)` to close fs.watch handle
- No manual reload endpoint — fs.watch only

### Registry API surface
- Standalone `UserRegistry` class in `src/lib/user-registry.ts` (no Fastify dependency)
- Thin Fastify plugin wrapper in `src/plugins/registry.ts` that instantiates and decorates as `fastify.registry`
- Lookup methods: `getUserByApiKey(key)`, `getUserById(userId)`, `getAllUsers()`, `getUserCount()` — all O(1) via internal Maps
- Write methods: `addUser(record)`, `removeUser(userId)` — validate, update in-memory, atomic write to disk
- Static utility: `UserRegistry.generateApiKey()` — generates `cv-`-prefixed cryptographically random keys
- Returned user records are `Object.freeze`'d copies — prevents accidental mutation of internal state
- Sensitive fields (openaiKey, obsidian.password, obsidian.token) redacted in Pino log serialization

### Validation & error behavior
- Zod schema for users.json validation (consistent with config.ts pattern)
- Reject entire file on any invalid entry — no partial loads. Last valid registry remains active
- On startup: if users.json exists but is malformed, refuse to start (fatal error, consistent with config.ts)
- On startup: if users.json doesn't exist, create empty `[]` and start with zero users
- Atomic write: private method within UserRegistry, not extracted as shared utility

### Claude's Discretion
- Exact SHA algorithm for content hashing
- Internal Map structure (single Map<apiKey, UserRecord> + Map<userId, UserRecord>, or combined)
- Debounce implementation details
- Test file organization within `src/lib/__tests__/`
- Zod schema field ordering and error message wording

</decisions>

<specifics>
## Specific Ideas

- UserRegistry must be usable standalone (no Fastify) for Phase 19 CLI reuse
- Follow existing plugin pattern: auth.ts uses `fp()` wrapper, registry should too
- API key generation should use `crypto.randomBytes` for security
- The `cv-` prefix helps operators visually distinguish CogniVault keys from OpenAI keys in config

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/config.ts`: Zod validation pattern for fail-fast startup config — registry follows same philosophy
- `src/plugins/auth.ts`: Current single-key auth via `@fastify/bearer-auth` — Phase 16 will replace the key set with registry lookups
- `src/plugins/metrics.ts`: Prometheus metrics registration pattern — registry adds its own counter + gauge

### Established Patterns
- Fastify plugin with `fp()` wrapper (fastify-plugin) for encapsulation — all plugins follow this
- `fastify.decorate()` for shared services (db, qdrant, etc.) — registry uses same pattern
- Pino structured logging with header redaction — registry adds user record redaction
- `fastify.addHook('onClose', ...)` for cleanup — registry closes fs.watch handle

### Integration Points
- `src/app.ts`: Registry plugin registered early (after error handler, before auth) — auth plugin will depend on it in Phase 16
- `src/config.ts`: COGNIVAULT_DATA_DIR already defined — registry uses it for users.json path
- `src/plugins/metrics.ts`: Per-instance prom-client Registry — registry metrics registered on same instance

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 15-registry-foundation*
*Context gathered: 2026-03-14*
