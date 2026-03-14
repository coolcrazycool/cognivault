# Phase 16: Multi-Tenant Auth - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Every API request is authenticated against the user registry and carries a resolved user context. The single static COGNIVAULT_API_KEY is removed entirely. Auth resolves API keys to UserRecord via the registry, attaches the full user context to the request, and returns generic 401 for any auth failure. Route handlers access `request.user.userId` to determine the calling tenant.

</domain>

<decisions>
## Implementation Decisions

### Auth transition
- Remove COGNIVAULT_API_KEY from config.ts Zod schema entirely (clean break, v2.0 is a major version)
- Drop @fastify/bearer-auth dependency — replace with a custom onRequest hook that calls `registry.getUserByApiKey()`
- Server starts with zero users in registry (empty users.json) — all authenticated requests get 401 until users are added
- No fallback auth path — all auth goes through registry exclusively

### User context scope
- `request.user` contains the full frozen UserRecord from registry (userId, apiKey, vaultPath, openaiKey, obsidian creds)
- Same Object.freeze'd record from registry — no copy or sanitization (sensitive fields already redacted in Pino serialization from Phase 15)
- TypeScript typing via Fastify declaration merging: `declare module 'fastify' { interface FastifyRequest { user?: UserRecord } }`
- Optional type (`user?: UserRecord`) — routes that skip auth (health, readiness, /docs) have no user; authenticated routes check/assert

### Hot-reload auth behavior
- Auth check happens once at request start (onRequest hook) — in-flight requests complete even if user is removed mid-request
- No key rotation grace period — old key stops working immediately on registry reload
- New users work immediately on next request after registry reload
- Add userId to request log context on successful auth — enables per-user log filtering (early prep for OBS-01 in Phase 18)

### Auth error responses
- Generic 401 for all auth failures: missing header, invalid key, removed user — no information leakage
- Response format: `{ error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" } }` — matches existing error-handler.ts pattern
- Missing Authorization header gets 401 (same as invalid key), not 400
- Prometheus counter `cognivault_auth_failures_total` tracks failed auth attempts (no labels that leak key info)

### Claude's Discretion
- Bearer token extraction implementation details
- Exact log enrichment approach (child logger vs request.log bindings)
- Test structure and organization
- Auth hook ordering relative to other onRequest hooks

</decisions>

<specifics>
## Specific Ideas

- Custom hook is simpler than @fastify/bearer-auth for a single registry lookup — fewer moving parts
- userId in request logs early (Phase 16) so downstream phases (17, 18) can rely on it being there
- No key rotation support — keys are managed by editing users.json directly; rotation is out of scope (OPS-01 deferred)

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/plugins/registry.ts`: Registry plugin decorates `fastify.registry` with UserRegistry instance — auth plugin calls `fastify.registry.getUserByApiKey()`
- `src/lib/user-registry.ts`: Standalone UserRegistry class with `getUserByApiKey()` returning frozen UserRecord or undefined
- `src/plugins/metrics.ts`: Per-instance prom-client Registry on `fastify.metrics.promRegistry` — auth failure counter registers here
- `src/plugins/error-handler.ts`: Existing `{ error: { code, message } }` format — auth errors follow same shape

### Established Patterns
- `fp()` wrapper with dependencies array (e.g., `{ name: 'registry', dependencies: ['metrics'] }`) — auth plugin declares `dependencies: ['registry']`
- `skipAuth` route config flag in onRequest hook — already implemented, must be preserved
- `/docs` URL prefix skip — already implemented, must be preserved
- Pino redaction paths in `app.ts` buildLoggerOptions — already includes `*.openaiKey`, `*.obsidian.password`, `*.obsidian.token`

### Integration Points
- `src/app.ts` line 96: Auth plugin registered after registry — dependency order already correct
- `src/plugins/auth.ts`: Current auth plugin to be rewritten (not extended) — custom hook replaces @fastify/bearer-auth
- `src/config.ts`: COGNIVAULT_API_KEY to be removed from Zod schema
- All feature routes: Will gain access to `request.user` without code changes (type augmentation is global)

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 16-per-user-container-stack*
*Context gathered: 2026-03-14*
