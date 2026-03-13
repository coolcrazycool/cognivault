# Phase 9: TOON + API Polish - Research

**Researched:** 2026-03-12
**Domain:** Content negotiation (TOON/JSON), Fastify content-type parsing, OpenAPI spec generation
**Confidence:** HIGH

## Summary

Phase 9 adds two independent capabilities to the existing Fastify v5 service: (1) dual-format content negotiation via the `@toon-format/toon` SDK, and (2) auto-generated OpenAPI documentation via `@fastify/swagger` + `@fastify/swagger-ui`. Both are implemented as Fastify plugins registered in `app.ts` before feature routes.

TOON support requires a content-type parser registered for `text/toon` (decodes TOON bodies to JS objects before TypeBox validation runs), plus an `onSend` hook that checks `request.headers.accept` and re-serializes the already-serialized JSON response into TOON when the client requests it. The `error-handler.ts` and `auth.ts` plugins need TOON-awareness so error responses mirror the requested format. Health/readiness endpoints explicitly opt out via the existing `skipAuth`-style route config pattern.

OpenAPI generation is straightforward: `@fastify/swagger` v9 is compatible with Fastify v5 and already ingests TypeBox schemas from route definitions. `@fastify/swagger-ui` v5 serves the interactive UI. Both plugins are registered before feature routes so all route schemas are included. The docs endpoints skip auth using the same `config: { skipAuth: true }` route-level config the health routes already use.

**Primary recommendation:** Implement TOON as a single Fastify plugin (`src/plugins/toon.ts`) that registers the content-type parser and the `onSend` hook globally, then modify `error-handler.ts` and `auth.ts` to serialize error payloads in the format the client requested.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**TOON Format:**
- Use `@toon-format/toon` npm package (official TypeScript SDK)
- MIME type: `text/toon` (provisional)
- TOON support applies to ALL endpoints except health/readiness (which stay JSON-only for Docker/K8s probes)
- Invalid TOON input returns 400 Bad Request with `{ error: { code: 'INVALID_TOON', message: '...' } }`

**Content Negotiation Implementation:**
- Fastify `addContentTypeParser` for text/toon request parsing (decode TOON to JSON object)
- Fastify `onSend` hook or custom serializer for TOON response serialization
- TOON request bodies are decoded to JSON first, then validated against same TypeBox schemas as JSON — one source of truth for validation
- No extra response headers for TOON discovery — standard content negotiation only

**Content Negotiation Behavior:**
- If Accept header contains text/toon anywhere (regardless of q-values), prefer TOON response
- If Accept is unsupported (e.g., text/xml), fall back to JSON gracefully
- If TOON serialization fails, return TOON best-effort (let the format handle it)
- Format is symmetric: if agent sends Content-Type: text/toon, response is TOON; if JSON, response is JSON. Content-Type determines response format (must match)
- JSON is default when Accept is application/json or unspecified

**Error Responses in TOON Mode:**
- When agent requested TOON (via Accept or Content-Type), error responses are also TOON-serialized
- Same `{ error: { code, message } }` structure regardless of format — just serialized as TOON or JSON
- Even 401 auth errors check Accept header and return TOON if requested — full symmetry
- Health/readiness errors always JSON (those endpoints are JSON-only)

**OpenAPI Spec Generation:**
- Use @fastify/swagger for auto-generation from TypeBox route schemas
- Use @fastify/swagger-ui for interactive browser-based exploration
- Swagger UI served at /docs, JSON spec at /docs/json, YAML at /docs/yaml
- No authentication required for docs endpoints (like health endpoints)
- OpenAPI spec documents both text/toon and application/json as supported content types

### Claude's Discretion
- Exact Fastify plugin structure for TOON middleware (single plugin vs separate parser/serializer)
- How to integrate TOON content types into @fastify/swagger spec generation
- TOON serializer error handling internals

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| API-01 | Service accepts TOON-formatted requests (Content-Type: text/toon) | `addContentTypeParser('text/toon', { parseAs: 'string' }, ...)` pattern documented; `decode()` from `@toon-format/toon` converts to JS object before TypeBox validation |
| API-02 | Service returns TOON-formatted responses when Accept: text/toon | `onSend` hook pattern: check `request.headers.accept`, call `encode()` on already-serialized object; set `Content-Type: text/toon` on reply |
| API-03 | Service returns JSON by default (Accept: application/json or unspecified) | Default Fastify JSON serialization unchanged; TOON hook only fires when `text/toon` detected in Accept header |
| INF-02 | Service auto-generates OpenAPI spec from route definitions | `@fastify/swagger` v9 (Fastify v5 compatible) reads TypeBox schemas automatically; `@fastify/swagger-ui` v5 serves interactive UI |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@toon-format/toon` | latest (1.x) | TOON encode/decode | Official SDK; the only TypeScript implementation |
| `@fastify/swagger` | ^9.x | OpenAPI spec auto-generation | Official Fastify plugin; v9 required for Fastify v5 compat |
| `@fastify/swagger-ui` | ^5.x | Swagger UI serving | Official companion; v5 required for Fastify v5 compat |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@fastify/accepts-serializer` | ^6.x | Accept-header based serializer routing | Alternative to manual `onSend` hook; adds per-route config surface |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Manual `onSend` hook | `@fastify/accepts-serializer` | `@fastify/accepts-serializer` adds per-route config flexibility but is another plugin dependency; manual hook is simpler for two formats |
| `@fastify/swagger-ui` | Scalar API reference | Scalar is more modern UI but requires separate package (`@scalar/fastify-api-reference`); `@fastify/swagger-ui` is the standard |

**Installation:**
```bash
pnpm add @toon-format/toon @fastify/swagger @fastify/swagger-ui
```

## Architecture Patterns

### Recommended Plugin Registration Order in app.ts
```
error-handler        (registers setErrorHandler — must be first)
auth                 (registers onRequest hook)
toon                 (registers addContentTypeParser + onSend hook — before feature routes)
swagger              (registers @fastify/swagger — before feature routes)
swagger-ui           (registers @fastify/swagger-ui — after swagger)
vault / db / ...     (infrastructure plugins)
feature routes       (health, vault, search, context)
```

### Pattern 1: TOON Content-Type Parser (addContentTypeParser)
**What:** Registers a custom parser so Fastify calls `decode()` on incoming `text/toon` bodies before the route handler sees `request.body`. The decoded JS object is then validated by the existing TypeBox schema — no schema changes needed.
**When to use:** Any Fastify service accepting a custom MIME type.

```typescript
// Source: https://fastify.dev/docs/latest/Reference/ContentTypeParser/
import { decode } from '@toon-format/toon';
import type { FastifyInstance } from 'fastify';

fastify.addContentTypeParser(
  'text/toon',
  { parseAs: 'string' },
  (req, body: string, done) => {
    try {
      const parsed = decode(body);
      done(null, parsed as Record<string, unknown>);
    } catch (err) {
      const error = new Error('Invalid TOON format') as Error & { statusCode: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  },
);
```

### Pattern 2: TOON Response Serialization (onSend hook)
**What:** After Fastify serializes the route response to JSON string, the `onSend` hook intercepts, parses back to object, and re-serializes as TOON if client requested it. Sets `Content-Type: text/toon` on reply.
**When to use:** Any time the response format must differ from Fastify's default JSON serialization.

**Important:** `onSend` receives a string (already JSON-serialized). Must parse it back to object before calling `encode()`. The hook must also skip health/readiness routes.

```typescript
// Source: https://fastify.dev/docs/latest/Reference/Hooks/
import { encode } from '@toon-format/toon';

fastify.addHook('onSend', async (request, reply, payload) => {
  // Skip health/readiness (JSON-only)
  if ((request.routeOptions.config as Record<string, unknown>)?.skipAuth) {
    return payload;
  }

  const accept = request.headers.accept ?? '';
  if (!accept.includes('text/toon')) {
    return payload; // JSON passthrough
  }

  try {
    const obj = JSON.parse(payload as string);
    void reply.header('Content-Type', 'text/toon');
    return encode(obj);
  } catch {
    return payload; // best-effort: fall back to JSON on encode failure
  }
});
```

### Pattern 3: TOON-Aware Error Handler
**What:** Modified `error-handler.ts` that checks `request.headers.accept` (and `request.headers['content-type']`) to decide whether to serialize error payload as TOON or JSON.
**When to use:** Whenever error responses must match the client's requested format.

**Key constraint:** `setErrorHandler` receives `request` object. The `reply.send()` call goes through the `onSend` hook only for route handlers, NOT for error handlers. Error handler must explicitly call `encode()` and set Content-Type when appropriate.

```typescript
// Pattern — error handler with TOON awareness
fastify.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
  const statusCode = error.statusCode ?? 500;
  const payload = {
    error: {
      code: mapErrorToCode(statusCode, error),
      message: statusCode >= 500 ? 'Internal server error' : error.message,
    },
  };

  const accept = request.headers.accept ?? '';
  const contentType = request.headers['content-type'] ?? '';
  const wantToon = accept.includes('text/toon') || contentType.includes('text/toon');
  const isHealthRoute = (request.routeOptions.config as Record<string, unknown>)?.skipAuth;

  if (wantToon && !isHealthRoute) {
    return reply
      .status(statusCode)
      .header('Content-Type', 'text/toon')
      .send(encode(payload));
  }
  return reply.status(statusCode).send(payload);
});
```

### Pattern 4: OpenAPI Swagger Registration
**What:** Register `@fastify/swagger` in OpenAPI 3.0 mode before feature routes so it captures all route schemas. Register `@fastify/swagger-ui` with `routePrefix: '/docs'` and `uiHooks` to skip auth.

```typescript
// Source: https://deepwiki.com/fastify/fastify-swagger/2-getting-started
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

// Register before feature routes
await fastify.register(swagger, {
  openapi: {
    openapi: '3.0.0',
    info: {
      title: 'CogniVault API',
      description: 'Knowledge access layer for AI agents',
      version: '1.0.0',
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
});

await fastify.register(swaggerUi, {
  routePrefix: '/docs',
  uiHooks: {
    onRequest: (_request, _reply, next) => next(),  // no auth
  },
});
```

The `/docs` route serves the UI, `/docs/json` the spec JSON, `/docs/yaml` the YAML.

### Pattern 5: Documenting text/toon in OpenAPI Spec
**What:** `@fastify/swagger` auto-documents `application/json` only. To add `text/toon` as an accepted content type in the spec, use the `transform` option or add it in `consumes`/`produces` at the global level.

**Approach:** Add a global `consumes` and `produces` array in the swagger options, or document it in the `info.description`. Per-route `text/toon` documentation in the generated spec is a "Claude's Discretion" area — the simpler approach is noting it in the API description rather than per-route schema overrides.

### Anti-Patterns to Avoid
- **Registering `addContentTypeParser` inside a feature plugin:** It will only apply to that plugin's scope. Register at root scope (in the TOON plugin using `fp()` wrapper) for global coverage.
- **Using `preSerialization` instead of `onSend` for TOON:** `preSerialization` runs before Fastify's JSON serialization and its payload is the raw JS object — but it only fires for non-string payloads. `onSend` fires on ALL responses and receives the final payload, making it the correct hook for re-serialization.
- **Parsing TOON inside TypeBox schemas:** TypeBox validates structure, not format. TOON decoding happens in the content-type parser, before validation.
- **Registering swagger plugins after feature routes:** Swagger must be registered before routes to capture their schemas.
- **Forgetting `onSend` runs after error handler:** Error handler's `reply.send()` does NOT go through `onSend`. Error handler must check format itself.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| TOON encoding/decoding | Custom TOON parser | `@toon-format/toon` encode/decode | Format has edge cases (tabular compression, strict whitespace, streaming); official SDK handles all variants |
| OpenAPI spec generation | Manual OpenAPI JSON | `@fastify/swagger` | Keeping spec in sync with route schemas manually is a maintenance trap; dynamic generation is the only sane approach |
| Content-type detection | Custom Accept header parser | String `.includes('text/toon')` check | Simple substring check is sufficient for two-format negotiation; `@fastify/accepts-serializer` only needed if many formats |
| Swagger UI serving | Custom HTML/JS | `@fastify/swagger-ui` | Swagger UI assets, versioning, and CSP headers are complex; plugin handles all of it |

**Key insight:** TOON's token-saving magic is in its tabular encoding of uniform arrays (search results, context chunks) — the SDK handles this automatically. Hand-rolling will miss the exact table format that achieves the 40% savings.

## Common Pitfalls

### Pitfall 1: onSend doesn't fire for error handler responses
**What goes wrong:** Developer adds TOON serialization only to `onSend` hook, expecting it to cover error responses. 401 and 400 errors from `error-handler.ts` and `auth.ts` still return JSON even when client sent `Accept: text/toon`.
**Why it happens:** `fastify.setErrorHandler` and `fastify.addHook('onRequest', ...)` bypass the normal send pipeline that runs `onSend`. Error handler's `reply.send()` skips hooks.
**How to avoid:** Explicitly add TOON serialization in both `error-handler.ts` and `auth.ts` (or any plugin that calls `reply.send()` in hooks).
**Warning signs:** Test for 401 with `Accept: text/toon` — if it returns JSON, the error handler is not TOON-aware.

### Pitfall 2: Content-type parser scope — global vs plugin
**What goes wrong:** `addContentTypeParser('text/toon', ...)` registered inside a feature plugin. Routes in other features reject `text/toon` bodies with 415 Unsupported Media Type.
**Why it happens:** Fastify encapsulates content-type parsers within the plugin scope where they are registered.
**How to avoid:** Register the parser in a root-scope plugin using `fp()` wrapper (no encapsulation). This ensures it applies to all routes.
**Warning signs:** Parser works on one route but not others.

### Pitfall 3: @fastify/swagger registered after feature routes
**What goes wrong:** Only routes registered AFTER swagger is registered appear in the spec. Feature routes registered before swagger show no documentation.
**Why it happens:** `@fastify/swagger` hooks into Fastify's `onRoute` event to collect schemas. Routes defined before registration are not captured.
**How to avoid:** Register swagger and swagger-ui before all feature routes in `app.ts`.

### Pitfall 4: onSend payload is already a JSON string
**What goes wrong:** `onSend` hook tries to call `encode(payload)` directly on the string payload. Result is TOON-encoding a JSON string literal, not the object.
**Why it happens:** Unlike `preSerialization`, `onSend` receives the already-serialized string. `encode('{"foo":1}')` encodes a string primitive, not the object.
**How to avoid:** `JSON.parse(payload as string)` before calling `encode()`.

### Pitfall 5: Docs endpoint auto-protected by auth plugin
**What goes wrong:** `/docs` routes created by `@fastify/swagger-ui` get caught by the auth plugin's `onRequest` hook. Documentation becomes inaccessible without API key.
**Why it happens:** Auth plugin's `onRequest` hook applies to all routes unless `skipAuth: true` is in route config. Swagger-UI creates its own routes without this config.
**How to avoid:** Use `uiHooks` option in `@fastify/swagger-ui` to pass an empty `onRequest` that skips auth. Alternatively, check the route URL prefix in the auth plugin and skip `/docs/*` paths — but the `uiHooks` approach is cleaner.

### Pitfall 6: text/toon charset variations
**What goes wrong:** Client sends `Content-Type: text/toon; charset=utf-8`. Fastify's content-type parser registered for `'text/toon'` (exact string) does not match.
**Why it happens:** Fastify strips parameters from Content-Type for matching, but only for built-in parsers. Custom parsers with string matching may or may not strip params depending on version.
**How to avoid:** Register parser with regex `/^text\/toon/` to match with or without charset suffix.

## Code Examples

Verified patterns from official sources:

### TOON Plugin (Root Scope)
```typescript
// src/plugins/toon.ts
// Source: https://fastify.dev/docs/latest/Reference/ContentTypeParser/
import { decode, encode } from '@toon-format/toon';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

async function toonPlugin(fastify: FastifyInstance): Promise<void> {
  // Register parser — /^text\/toon/ handles charset suffixes
  fastify.addContentTypeParser(
    /^text\/toon/,
    { parseAs: 'string' },
    (req, body: string, done) => {
      try {
        done(null, decode(body) as Record<string, unknown>);
      } catch {
        const err = new Error('Invalid TOON format') as Error & { statusCode: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  // Response hook — fires after JSON serialization
  fastify.addHook('onSend', async (request, reply, payload) => {
    const routeConfig = request.routeOptions.config as Record<string, unknown>;
    if (routeConfig?.skipAuth) return payload; // health/readiness: JSON only

    const accept = request.headers.accept ?? '';
    if (!accept.includes('text/toon')) return payload;

    try {
      const obj = JSON.parse(payload as string);
      void reply.header('Content-Type', 'text/toon');
      return encode(obj);
    } catch {
      return payload; // fallback to JSON
    }
  });
}

export default fp(toonPlugin, { name: 'toon' });
```

### Swagger Plugin Registration
```typescript
// src/plugins/swagger.ts
// Source: https://deepwiki.com/fastify/fastify-swagger/2-getting-started
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

async function swaggerPlugin(fastify: FastifyInstance): Promise<void> {
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'CogniVault API',
        description:
          'Knowledge access layer for AI agents. Supports application/json and text/toon (Content-Type / Accept headers).',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiHooks: {
      // Bypass auth — docs are public like health endpoints
      onRequest: (_req, _reply, next) => next(),
    },
  });
}

export default fp(swaggerPlugin, { name: 'swagger' });
```

### Testing TOON Parse Round-Trip
```typescript
// In __tests__/toon.test.ts
it('accepts text/toon body and returns toon response', async () => {
  const { encode, decode } = await import('@toon-format/toon');
  const body = encode({ query: 'test', limit: 10 });

  const response = await app.inject({
    method: 'POST',
    url: '/api/vault/search',
    headers: {
      authorization: 'Bearer test-key',
      'content-type': 'text/toon',
      accept: 'text/toon',
    },
    payload: body,
  });

  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toMatch(/text\/toon/);
  const result = decode(response.payload);
  expect(result).toHaveProperty('results');
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `fastify-swagger` (old) | `@fastify/swagger` v9 | Fastify v5 release | Plugin version major bump required |
| `fastify-swagger-ui` (old) | `@fastify/swagger-ui` v5 | Fastify v5 release | Separate package, v5 required |
| Per-route content negotiation | Global `onSend` hook + `addContentTypeParser` | Fastify v4+ | Cleaner; single plugin handles all routes |

**Deprecated/outdated:**
- `fastify-swagger` (non-scoped package): Replaced by `@fastify/swagger`. Do not use.
- `preSerialization` for format switching: Fires before serialization, payload is raw object — works only for responses that haven't been serialized yet, and fires per-plugin scope. `onSend` is more reliable for cross-cutting format conversion.

## Open Questions

1. **How does @fastify/swagger document text/toon as an accepted content type per-route?**
   - What we know: `@fastify/swagger` reads `schema.body` and `schema.response` TypeBox schemas. It generates `requestBody.content['application/json']` by default.
   - What's unclear: Whether adding `text/toon` to the per-route OpenAPI spec requires a custom `transform` function or a global `consumes` override in the swagger config.
   - Recommendation: In Plan 09-03, spike the transform approach. If it adds complexity, document TOON support in the API `info.description` string instead — the spec is still accurate about JSON; TOON is additive.

2. **Does `onSend` receive the actual error payload when `setErrorHandler` calls `reply.send()`?**
   - What we know: Official docs say error handler's `reply.send()` does NOT trigger `onSend` hooks — confirmed by multiple sources.
   - What's unclear: Whether this changed in Fastify v5.
   - Recommendation: Write an explicit test for `POST /api/vault/search` with invalid auth + `Accept: text/toon`. If `onSend` fires, simplify the error handler. If it doesn't, error handler needs explicit TOON encoding (as shown in Pattern 3).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.0.18 |
| Config file | vitest.config.ts (or inferred from package.json) |
| Quick run command | `pnpm test -- --run src/plugins/__tests__/toon.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| API-01 | Service accepts `Content-Type: text/toon` bodies | integration | `pnpm test -- --run src/plugins/__tests__/toon.test.ts` | ❌ Wave 0 |
| API-01 | Invalid TOON body returns 400 INVALID_TOON | unit | `pnpm test -- --run src/plugins/__tests__/toon.test.ts` | ❌ Wave 0 |
| API-02 | `Accept: text/toon` returns TOON-encoded response | integration | `pnpm test -- --run src/plugins/__tests__/toon.test.ts` | ❌ Wave 0 |
| API-02 | Error responses (401, 400) are TOON when Accept: text/toon | integration | `pnpm test -- --run src/plugins/__tests__/toon.test.ts` | ❌ Wave 0 |
| API-03 | Default response is JSON when Accept is unspecified | integration | `pnpm test -- --run src/plugins/__tests__/toon.test.ts` | ❌ Wave 0 |
| API-03 | Health/readiness always return JSON regardless of Accept | integration | `pnpm test -- --run src/features/health/__tests__/routes.test.ts` | ✅ (extend) |
| INF-02 | GET /docs returns 200 HTML (Swagger UI) | smoke | `pnpm test -- --run src/plugins/__tests__/swagger.test.ts` | ❌ Wave 0 |
| INF-02 | GET /docs/json returns valid OpenAPI JSON spec | smoke | `pnpm test -- --run src/plugins/__tests__/swagger.test.ts` | ❌ Wave 0 |
| INF-02 | /docs endpoints accessible without auth | smoke | `pnpm test -- --run src/plugins/__tests__/swagger.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test -- --run src/plugins/__tests__/toon.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/plugins/__tests__/toon.test.ts` — covers API-01, API-02, API-03
- [ ] `src/plugins/__tests__/swagger.test.ts` — covers INF-02
- [ ] `pnpm add @toon-format/toon @fastify/swagger @fastify/swagger-ui` — packages not yet installed

## Sources

### Primary (HIGH confidence)
- [TOON API Reference](https://toonformat.dev/reference/api) — `encode()`, `decode()`, option types, streaming APIs
- [TOON Getting Started](https://toonformat.dev/guide/getting-started) — MIME type `text/toon`, install command
- [Fastify ContentTypeParser docs](https://fastify.dev/docs/latest/Reference/ContentTypeParser/) — `addContentTypeParser`, `parseAs`, scope encapsulation
- [Fastify Hooks docs](https://fastify.dev/docs/latest/Reference/Hooks/) — `onSend`, `preSerialization` signatures and payload constraints
- [fastify-swagger DeepWiki](https://deepwiki.com/fastify/fastify-swagger/2-getting-started) — `@fastify/swagger` v9 Fastify v5 compatibility, registration pattern

### Secondary (MEDIUM confidence)
- [@fastify/swagger-ui GitHub](https://github.com/fastify/fastify-swagger-ui) — v5.x Fastify v5 compat, `routePrefix`, `uiHooks`, `/docs/json`, `/docs/yaml` endpoint paths
- [@fastify/accepts-serializer GitHub](https://github.com/fastify/fastify-accepts-serializer) — v6 Fastify v5 compat, alternative content-negotiation pattern

### Tertiary (LOW confidence)
- WebSearch results on error handler + onSend interaction — needs runtime validation per Open Question 2

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — official npm/GitHub sources confirm versions and compatibility
- Architecture: HIGH — Fastify documentation is authoritative for `addContentTypeParser` and `onSend` patterns
- TOON SDK usage: HIGH — official toonformat.dev API reference confirms all function signatures
- Error handler + onSend interaction: LOW — needs runtime test to confirm Fastify v5 behavior
- OpenAPI text/toon documentation: LOW — no official example found for documenting custom MIME types per-route

**Research date:** 2026-03-12
**Valid until:** 2026-06-12 (stable ecosystem; packages change slowly)
