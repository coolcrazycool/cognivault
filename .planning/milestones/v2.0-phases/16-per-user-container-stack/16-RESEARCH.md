# Phase 16: Multi-Tenant Auth - Research

**Researched:** 2026-03-14
**Domain:** Fastify authentication, multi-tenant request context
**Confidence:** HIGH

## Summary

Phase 16 replaces the single static API key authentication with a registry-backed multi-tenant auth system. The existing `@fastify/bearer-auth` dependency is removed entirely and replaced with a custom `onRequest` hook that resolves API keys to `UserRecord` objects via `fastify.registry.getUserByApiKey()`. Each authenticated request gets a `request.user` property containing the frozen UserRecord.

This is a well-bounded phase. The UserRegistry class (Phase 15) already provides `getUserByApiKey()`. The auth plugin already has the hook structure with `skipAuth` support. The work is: rewrite `auth.ts` to call registry instead of comparing against a static key set, add Fastify declaration merging for `request.user`, remove `COGNIVAULT_API_KEY` from config, add an auth failure counter metric, and update tests.

**Primary recommendation:** Rewrite `src/plugins/auth.ts` as a custom onRequest hook (no external auth library), remove `COGNIVAULT_API_KEY` from Zod config schema, and add `request.user` via Fastify declaration merging.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Remove COGNIVAULT_API_KEY from config.ts Zod schema entirely (clean break, v2.0 is a major version)
- Drop @fastify/bearer-auth dependency -- replace with a custom onRequest hook that calls `registry.getUserByApiKey()`
- Server starts with zero users in registry (empty users.json) -- all authenticated requests get 401 until users are added
- No fallback auth path -- all auth goes through registry exclusively
- `request.user` contains the full frozen UserRecord from registry (userId, apiKey, vaultPath, openaiKey, obsidian creds)
- Same Object.freeze'd record from registry -- no copy or sanitization
- TypeScript typing via Fastify declaration merging: `declare module 'fastify' { interface FastifyRequest { user?: UserRecord } }`
- Optional type (`user?: UserRecord`) -- routes that skip auth have no user
- Auth check happens once at request start (onRequest hook) -- in-flight requests complete even if user is removed mid-request
- No key rotation grace period -- old key stops working immediately on registry reload
- Generic 401 for all auth failures: missing header, invalid key, removed user -- no information leakage
- Response format: `{ error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" } }`
- Missing Authorization header gets 401 (same as invalid key), not 400
- Prometheus counter `cognivault_auth_failures_total` tracks failed auth attempts (no labels that leak key info)

### Claude's Discretion
- Bearer token extraction implementation details
- Exact log enrichment approach (child logger vs request.log bindings)
- Test structure and organization
- Auth hook ordering relative to other onRequest hooks

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| TENANT-01 | CogniVault serves multiple users from a single process, routing each request to the correct user's vault and Qdrant tenant by API key | Auth plugin resolves API key to UserRecord via registry; `request.user` carries userId, vaultPath, openaiKey for downstream routing (actual vault/Qdrant scoping is Phase 17) |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| fastify | existing | HTTP framework, onRequest hooks, declaration merging | Already in use; native hook system is the standard auth pattern |
| fastify-plugin (fp) | existing | Plugin encapsulation with dependency declaration | Already in use; auth plugin declares `dependencies: ['registry']` |
| prom-client | existing | Auth failure counter metric | Already in use via `fastify.metrics.promRegistry` |

### Removed
| Library | Why Removed |
|---------|-------------|
| @fastify/bearer-auth | Replaced by custom onRequest hook; simpler for single registry lookup |

### No New Dependencies
This phase requires zero new npm packages. All functionality is built with Fastify's native hook system and the existing UserRegistry class.

**Uninstall:**
```bash
pnpm remove @fastify/bearer-auth
```

## Architecture Patterns

### Modified Files
```
src/
  config.ts              # Remove COGNIVAULT_API_KEY, VAULT_PATH (optional), OPENAI_API_KEY (optional)
  plugins/
    auth.ts              # REWRITE: custom onRequest hook using registry
    __tests__/
      auth.test.ts       # REWRITE: test against registry users, not static key
```

### Pattern 1: Custom Auth Hook with Registry Lookup
**What:** onRequest hook extracts Bearer token, looks up user in registry, attaches to request
**When to use:** Every request (skipped for routes with `skipAuth` config or `/docs` prefix)
**Example:**
```typescript
// src/plugins/auth.ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { Counter } from 'prom-client';
import type { UserRecord } from '../lib/user-registry.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRecord;
  }
}

function extractBearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return undefined;
  }
  return header.slice(7);
}

async function authPlugin(fastify: FastifyInstance): Promise<void> {
  const authFailures = new Counter({
    name: 'cognivault_auth_failures_total',
    help: 'Total number of failed authentication attempts',
    registers: [fastify.metrics.promRegistry],
  });

  fastify.addHook('onRequest', async (request, reply) => {
    // Skip auth for routes that opt out
    if ((request.routeOptions.config as Record<string, unknown>)?.skipAuth) {
      return;
    }
    // Skip auth for Swagger docs
    if (request.url.startsWith('/docs')) {
      return;
    }

    const token = extractBearerToken(request);
    if (!token) {
      authFailures.inc();
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key' },
      });
    }

    const user = fastify.registry.getUserByApiKey(token);
    if (!user) {
      authFailures.inc();
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API key' },
      });
    }

    request.user = user;
    // Enrich request log context with userId
    request.log = request.log.child({ userId: user.userId });
  });
}

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['registry', 'metrics'],
});
```

### Pattern 2: Log Enrichment via Child Logger
**What:** After successful auth, replace `request.log` with a child logger that includes `userId`
**Why child logger over bindings:** `request.log.child()` is the Pino-idiomatic way to add context. All subsequent log calls in the request lifecycle (route handlers, serializers, error handler) automatically include `userId`. Fastify's `request.log` is designed to be replaceable.
**Confidence:** HIGH -- this is the standard Pino pattern documented in Fastify's logging guide.

### Pattern 3: Config Cleanup
**What:** Remove `COGNIVAULT_API_KEY` from Zod config schema
**Impact:** The env var is no longer required at startup. Existing `.env` files with the var will not break (Zod ignores extra fields via `parse`), but the value will not be used.
**Also consider:** `VAULT_PATH` and `OPENAI_API_KEY` become per-user (from UserRecord) rather than global. However, these are still used by vault plugin and embedding plugin in their current form. Phase 17 handles the per-user scoping of these plugins. For Phase 16, keep them in config but note they will be superseded.

### Anti-Patterns to Avoid
- **Sending error details that differ by failure reason:** All auth failures MUST return the identical response body. No "invalid token format" vs "unknown key" distinction.
- **Using `reply.send()` without `return`:** In Fastify onRequest hooks, you MUST `return reply.send()` to stop the request lifecycle. Without `return`, the handler continues executing.
- **Registering the Counter on the global prom-client registry:** Use `fastify.metrics.promRegistry` (per-instance) to avoid test pollution between test suites.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Bearer token parsing | Custom regex or split logic | Simple `startsWith('Bearer ') + slice(7)` | The format is trivially simple; a library would be overkill, but don't over-engineer the extraction either |
| Request-scoped logging | Manual `{ userId }` in every log call | `request.log.child({ userId })` | Pino child loggers propagate context automatically |
| Auth error responses | Custom error classes thrown to error handler | Direct `reply.status(401).send()` in the hook | Cleaner control flow; the hook knows immediately whether auth passed |

## Common Pitfalls

### Pitfall 1: Forgetting to `return` reply.send() in onRequest Hook
**What goes wrong:** Without `return`, Fastify continues to the route handler even after sending 401
**Why it happens:** Fastify hooks are async functions; `reply.send()` queues the response but does not stop execution
**How to avoid:** Always `return reply.status(401).send(...)` in the hook
**Warning signs:** Route handler errors after 401 response, "Reply already sent" warnings in logs

### Pitfall 2: Auth Plugin Registered Before Registry
**What goes wrong:** `fastify.registry` is undefined when auth hook runs
**Why it happens:** Plugin registration order matters in Fastify
**How to avoid:** Declare `dependencies: ['registry', 'metrics']` in `fp()` options. The current `app.ts` already registers registry before auth (line 95-96).
**Warning signs:** "Cannot read properties of undefined (reading 'getUserByApiKey')" at startup

### Pitfall 3: Config Validation Fails After Removing COGNIVAULT_API_KEY
**What goes wrong:** Existing test files set `process.env.COGNIVAULT_API_KEY` before importing config; removing the field from Zod schema is fine, but tests that still set it won't break (Zod ignores unknown keys). The risk is tests that RELY on this env var for auth assertions.
**How to avoid:** Update ALL test files that use `COGNIVAULT_API_KEY` for auth. Switch them to use registry-based users instead.
**Warning signs:** Tests passing with wrong auth mechanism

### Pitfall 4: VAULT_PATH and OPENAI_API_KEY Still Required Globally
**What goes wrong:** Removing these from config.ts breaks vault and embedding plugins
**Why it happens:** Phase 16 only changes auth; vault/embedding scoping is Phase 17
**How to avoid:** Keep VAULT_PATH and OPENAI_API_KEY in config.ts for Phase 16. Only remove COGNIVAULT_API_KEY.
**Warning signs:** App fails to start because Zod rejects missing env vars

### Pitfall 5: Test Isolation with Module-Level Config Parsing
**What goes wrong:** `config.ts` uses `configSchema.parse(process.env)` at module level. Tests must set env vars BEFORE importing any module that transitively imports config.
**How to avoid:** Follow the existing test pattern: set `process.env` vars at top of test file, then dynamic `import()` of `buildApp`.
**Warning signs:** "COGNIVAULT_API_KEY is required" errors in tests (if removal is incomplete)

## Code Examples

### Bearer Token Extraction
```typescript
// Simple, correct, no dependencies needed
function extractBearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return undefined;
  }
  return header.slice(7);
}
```

### Fastify Declaration Merging for request.user
```typescript
// Place in auth.ts (the plugin that sets the value)
import type { UserRecord } from '../lib/user-registry.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRecord;
  }
}
```
**Source:** Fastify documentation on decorators and TypeScript. Declaration merging is the standard pattern for extending request/reply types. The `?` optional modifier is correct because unauthenticated routes (health, docs) will not have a user.

### Config Schema After COGNIVAULT_API_KEY Removal
```typescript
const configSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // COGNIVAULT_API_KEY: removed — auth now uses registry
  VAULT_PATH: z.string().min(1, 'VAULT_PATH is required'),      // kept for Phase 16; per-user in Phase 17
  QDRANT_URL: z.string().url().default('http://localhost:6333'),
  COGNIVAULT_DATA_DIR: z.string().default('./.cognivault'),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  STABILITY_DELAY_MS: z.coerce.number().int().positive().default(2000),
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'), // kept for Phase 16; per-user in Phase 17
  OPENAI_BASE_URL: z.string().url().optional(),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});
```

### Auth Test Pattern (Registry-Based)
```typescript
// Set up test users in users.json, then verify auth works through registry
const testUsers: UserRecord[] = [
  {
    userId: 'alice',
    apiKey: 'cv-alice-test-key',
    vaultPath: '/vaults/alice',
    openaiKey: 'sk-alice-openai',
    obsidian: { email: 'alice@test.com', password: 'pass', vault: 'v1' },
  },
];

// Write users.json BEFORE importing app
await fs.writeFile(usersJsonPath, JSON.stringify(testUsers));

// Test: valid key returns 200 with request.user populated
// Test: invalid key returns 401 with standard error body
// Test: removed user's key returns 401 after registry reload
// Test: health endpoint still works without auth
// Test: request.user.userId is accessible in route handler
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| @fastify/bearer-auth with static key set | Custom onRequest hook with registry lookup | Phase 16 (now) | Enables multi-tenant auth, removes dependency |
| Global COGNIVAULT_API_KEY env var | Per-user apiKey in users.json | Phase 16 (now) | Breaking change for v2.0; all clients must use registry-issued keys |

**Deprecated/outdated:**
- `COGNIVAULT_API_KEY` env var: Removed entirely in v2.0. Auth is exclusively via user registry.
- `@fastify/bearer-auth` package: No longer needed; uninstall.

## Open Questions

1. **Should VAULT_PATH and OPENAI_API_KEY become optional in config.ts now or in Phase 17?**
   - What we know: These are still used by vault and embedding plugins. Phase 17 makes them per-user.
   - What's unclear: Whether to make them optional (with defaults) in Phase 16 to reduce env var requirements
   - Recommendation: Keep them required in Phase 16 for minimal blast radius. Phase 17 handles the transition.

2. **Log enrichment: child logger vs request.log bindings**
   - What we know: Both work. `request.log.child()` is more idiomatic. Direct bindings via `request.log = fastify.log.child({...})` also work.
   - Recommendation: Use `request.log = request.log.child({ userId: user.userId })` -- this preserves the existing reqId binding while adding userId.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (via pnpm test) |
| Config file | vitest implicit config (package.json script) |
| Quick run command | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TENANT-01a | Valid API key from users.json gets 200 with user-scoped data | unit | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` | Exists but must be rewritten |
| TENANT-01b | Unknown API key gets 401 | unit | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` | Exists but must be rewritten |
| TENANT-01c | Removed user's key returns 401 after reload | unit | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` | No -- Wave 0 |
| TENANT-01d | Route handler can access request.user.userId | unit | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` | No -- Wave 0 |
| TENANT-01e | Missing Authorization header gets 401 | unit | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` | Exists but must be rewritten |
| TENANT-01f | Health/readiness skip auth | unit | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` | Exists but must be rewritten |
| TENANT-01g | Auth failure counter increments | unit | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test -- --run src/plugins/__tests__/auth.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/plugins/__tests__/auth.test.ts` -- full rewrite needed: switch from static key to registry-based users, add tests for TENANT-01c, TENANT-01d, TENANT-01g
- [ ] Test users fixture -- shared test UserRecord objects for auth tests

## Sources

### Primary (HIGH confidence)
- Existing codebase: `src/plugins/auth.ts`, `src/plugins/registry.ts`, `src/lib/user-registry.ts`, `src/config.ts`, `src/app.ts` -- direct inspection of current implementation
- Existing tests: `src/plugins/__tests__/auth.test.ts`, `src/plugins/__tests__/registry.test.ts` -- current test patterns
- CONTEXT.md -- locked decisions from user discussion

### Secondary (MEDIUM confidence)
- Fastify onRequest hook behavior (return reply.send() to short-circuit) -- from established project patterns and Fastify documentation knowledge
- Pino child logger pattern -- standard Pino usage

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all existing code inspected
- Architecture: HIGH -- straightforward rewrite of existing plugin with well-defined registry API
- Pitfalls: HIGH -- based on direct codebase analysis, known Fastify hook behavior

**Research date:** 2026-03-14
**Valid until:** 2026-04-14 (stable domain, no external dependencies changing)
