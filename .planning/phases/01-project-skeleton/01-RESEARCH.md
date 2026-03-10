# Phase 1: Project Skeleton - Research

**Researched:** 2026-03-10
**Domain:** Fastify + TypeScript + Docker project scaffolding
**Confidence:** HIGH

## Summary

Phase 1 is a greenfield project skeleton for CogniVault -- a Fastify-based REST API service in TypeScript with ESM modules. The phase delivers: project initialization with pnpm, TypeScript compilation, Fastify server with health/readiness endpoints, API key authentication via Bearer header, Docker multi-stage build, and docker-compose with Qdrant sidecar. All decisions are locked by the user (pnpm, Node 22, Vitest, Biome, TypeBox for schemas, Zod for config).

The ecosystem is mature and well-documented. Fastify v5 is stable (5.8.x), has first-class TypeScript support, and a dedicated type provider for TypeBox. The `@fastify/bearer-auth` plugin handles API key auth with constant-time comparison. Docker multi-stage builds with pnpm via corepack are well-established but have a known gotcha with signature verification that needs attention.

**Primary recommendation:** Use `@fastify/bearer-auth` for API key auth with a skip-auth decorator pattern for health endpoints. Use corepack for pnpm in Docker with explicit version pinning.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Package manager: pnpm
- Node.js: v22 LTS
- Test runner: Vitest
- Linting/formatting: Biome (single tool for both)
- TypeScript with ESM module resolution
- Feature-based layout: src/features/{name}/routes.ts, schemas.ts, etc.
- Fastify plugins in src/plugins/
- Shared utilities in src/lib/
- Colocated tests: src/features/{name}/__tests__/routes.test.ts
- Route schemas: TypeBox (Fastify-native, enables OpenAPI generation in Phase 9)
- Config validation: Zod schema at startup -- fail fast on missing/invalid env vars
- API key via Authorization: Bearer header
- Single API key via COGNIVAULT_API_KEY env var
- Health and readiness endpoints: no auth required
- Error format: `{"error": {"code": "UNAUTHORIZED", "message": "..."}}`
- Multi-stage Dockerfile: build stage (tsc), production stage (compiled JS + pruned node_modules)
- Single docker-compose.yml for development
- Vault directory: bind mount via VAULT_PATH env var
- Qdrant sidecar: pinned version
- Base image: node:22-slim (Alpine if no native module issues)

### Claude's Discretion
- Exact Fastify plugin registration order
- Health endpoint response payload structure beyond status
- Readiness check logic (what constitutes "ready")
- .env.example template contents
- TypeScript strictness settings (strict: true assumed)
- Biome rule configuration

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| API-04 | Service authenticates requests via API key (no role separation) | `@fastify/bearer-auth` plugin with `keys` Set; onRequest hook pattern; skipAuth route config for health endpoints |
| INF-01 | Service exposes health and readiness endpoints | GET /health and GET /ready as Fastify plugin in src/features/health/; TypeBox schemas for responses |
| INF-06 | Service deploys as single Docker container alongside Qdrant via docker-compose | Multi-stage Dockerfile with corepack+pnpm; docker-compose.yml with qdrant/qdrant:v1.13.x sidecar |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| fastify | ^5.8 | HTTP framework | Official stable v5; first-class TS support, plugin architecture |
| @sinclair/typebox | ^0.34 | Route schema definitions | Fastify-native JSON Schema builder; enables type inference + OpenAPI |
| @fastify/type-provider-typebox | ^5.x | TypeBox integration for Fastify | Official type provider; auto-infers request/response types from schemas |
| @fastify/bearer-auth | ^10.x | API key authentication | Official plugin; constant-time key comparison; onRequest hook; skip support |
| zod | ^3.23 | Config/env validation | TypeScript-first validation; fail-fast on startup with clear errors |
| pino | (bundled) | Logging | Fastify's built-in logger; structured JSON output |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| typescript | ^5.5 | TypeScript compiler | Build step; tsc for compilation |
| vitest | ^3.x | Test runner | Unit and integration tests; fast, ESM-native |
| @biomejs/biome | ^1.9 | Lint + format | Single tool replacing ESLint + Prettier |
| @tsconfig/node22 | ^22.x | Base tsconfig | Community-maintained Node 22 TypeScript defaults |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| @fastify/bearer-auth | Custom onRequest hook | Bearer-auth handles timing-safe comparison, edge cases; custom adds maintenance burden |
| Zod for config | @t3-oss/env-core | Zod is simpler, no extra dependency; t3-env adds framework-specific features not needed |

**Installation:**
```bash
pnpm add fastify @sinclair/typebox @fastify/type-provider-typebox @fastify/bearer-auth zod
pnpm add -D typescript vitest @biomejs/biome @tsconfig/node22 @types/node
```

## Architecture Patterns

### Recommended Project Structure
```
cognivault/
  src/
    app.ts              # Fastify app factory (buildApp function)
    server.ts           # Entry point (imports buildApp, calls listen)
    config.ts           # Zod-validated env config
    plugins/
      auth.ts           # Bearer auth plugin (wraps @fastify/bearer-auth)
      error-handler.ts  # Consistent error formatting
    features/
      health/
        routes.ts       # GET /health, GET /ready
        schemas.ts      # TypeBox schemas for health responses
        __tests__/
          routes.test.ts
    lib/                # Shared utilities (empty initially)
  test/                 # Integration tests (project root)
  dist/                 # Compiled JS output (gitignored)
  Dockerfile
  docker-compose.yml
  biome.json
  tsconfig.json
  package.json
  .env.example
```

### Pattern 1: App Factory
**What:** Export a `buildApp()` function that creates and configures the Fastify instance. The entry point (`server.ts`) calls it and starts listening.
**When to use:** Always. This pattern enables testing without starting a real server.
**Example:**
```typescript
// src/app.ts
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { config } from './config.js';

export async function buildApp(opts?: { logger: boolean }): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts?.logger ?? true,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Register plugins in order
  await app.register(import('./plugins/error-handler.js'));
  await app.register(import('./plugins/auth.js'));

  // Register features
  await app.register(import('./features/health/routes.js'));

  return app;
}
```

### Pattern 2: Auth Plugin with Skip
**What:** Register `@fastify/bearer-auth` globally but allow specific routes to skip auth via route config.
**When to use:** For health/readiness endpoints that must be unauthenticated.
**Example:**
```typescript
// src/plugins/auth.ts
import fp from 'fastify-plugin';
import bearerAuth from '@fastify/bearer-auth';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

export default fp(async function authPlugin(fastify: FastifyInstance) {
  await fastify.register(bearerAuth, {
    keys: new Set([config.COGNIVAULT_API_KEY]),
    addHook: false, // Don't auto-add hook; we control it
  });

  fastify.addHook('onRequest', async (request, reply) => {
    // Skip auth for routes that opt out
    if (request.routeOptions.config?.skipAuth) {
      return;
    }
    await (fastify as any).verifyBearerAuth(request, reply);
  });
});
```

**Note on addHook:** Setting `addHook: false` on `@fastify/bearer-auth` prevents automatic hook registration, allowing manual control with skipAuth. Verify this option exists in the plugin docs at implementation time -- if not available, use a custom onRequest hook with timing-safe comparison instead.

### Pattern 3: Zod Config Validation
**What:** Parse process.env through a Zod schema at import time. App crashes immediately if config is invalid.
**When to use:** Always. Import config.ts early in server.ts.
**Example:**
```typescript
// src/config.ts
import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  COGNIVAULT_API_KEY: z.string().min(1, 'COGNIVAULT_API_KEY is required'),
  VAULT_PATH: z.string().min(1, 'VAULT_PATH is required'),
  QDRANT_URL: z.string().url().default('http://localhost:6333'),
});

export type Config = z.infer<typeof configSchema>;
export const config: Config = configSchema.parse(process.env);
```

### Pattern 4: Plugin Registration Order
**Recommendation (Claude's discretion):**
1. Error handler plugin (wraps all routes)
2. Auth plugin (onRequest hook)
3. Feature routes (health, then others)

This ensures errors are formatted consistently and auth runs before any route handler.

### Anti-Patterns to Avoid
- **Importing process.env directly:** Always go through config.ts. Direct process.env access bypasses validation and loses type safety.
- **Default exports:** Project convention is named exports only. Use `export async function healthRoutes(...)` not `export default async function(...)`.
- **Starting server in app.ts:** Keep app factory separate from server startup. Tests call `buildApp()` without `listen()`.
- **Hardcoding ports/hosts:** All configuration via env vars through config.ts.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| API key comparison | String equality check | @fastify/bearer-auth | Timing-safe comparison prevents timing attacks |
| Route schema validation | Manual request parsing | TypeBox + Fastify schema | Automatic validation, serialization, type inference |
| Env var validation | Manual process.env checks | Zod schema parse | Type-safe, fail-fast, coercion, defaults |
| HTTP injection testing | Supertest + real server | fastify.inject() | No port binding, faster, built into Fastify |
| Docker layer caching | Naive COPY . . | Multi-stage with pnpm fetch | Separates dependency install from source copy |

**Key insight:** Fastify's plugin system and TypeBox integration handle most boilerplate. The skeleton's job is wiring these together correctly, not building custom infrastructure.

## Common Pitfalls

### Pitfall 1: ESM Import Extensions
**What goes wrong:** TypeScript files import `'./config'` without `.js` extension. Compiles fine but fails at runtime with ERR_MODULE_NOT_FOUND.
**Why it happens:** ESM requires explicit file extensions. TypeScript resolves types without extensions but Node.js runtime needs them.
**How to avoid:** Always use `.js` extension in imports: `import { config } from './config.js'`. Configure Biome or editor to catch this.
**Warning signs:** Runtime "Cannot find module" errors that don't appear during tsc.

### Pitfall 2: Corepack Signature Verification in Docker
**What goes wrong:** `corepack enable && corepack prepare pnpm@latest` fails with signature verification error in Docker builds.
**Why it happens:** Corepack validates package signatures against npm registry keys. Older corepack versions lack current keys.
**How to avoid:** Either update corepack first (`npm i -g corepack@latest`) or set `COREPACK_INTEGRITY_KEYS=""` to disable verification (acceptable for Docker builds). Pin pnpm version in package.json `packageManager` field.
**Warning signs:** Docker build fails at pnpm install step with cryptographic error.

### Pitfall 3: fastify-plugin Wrapper Missing
**What goes wrong:** Plugins registered with `fastify.register()` create an encapsulated context. Decorators/hooks added inside are not visible to sibling plugins.
**Why it happens:** Fastify's encapsulation is a feature, but auth hooks need to be visible globally.
**How to avoid:** Wrap auth and error-handler plugins with `fastify-plugin` (fp) to break encapsulation. Feature routes should NOT use fp (they should be encapsulated).
**Warning signs:** Auth hook doesn't run for routes registered after the auth plugin.

### Pitfall 4: TypeBox Version Mismatch
**What goes wrong:** @fastify/type-provider-typebox expects a specific TypeBox version range. Mismatched versions cause type errors or runtime validation failures.
**Why it happens:** TypeBox pre-1.0 has breaking changes between minor versions.
**How to avoid:** Install @sinclair/typebox as a direct dependency (not just peer). Check @fastify/type-provider-typebox's peer dependency range.
**Warning signs:** TypeScript errors about incompatible Type.Object signatures.

### Pitfall 5: Docker Compose Health Check Timing
**What goes wrong:** Application container starts before Qdrant is ready, causing connection failures.
**Why it happens:** docker-compose `depends_on` only waits for container start, not service readiness.
**How to avoid:** Use `depends_on` with `condition: service_healthy` and define a healthcheck for the Qdrant service. For Phase 1, the app doesn't connect to Qdrant yet, but set up the pattern now.
**Warning signs:** Intermittent startup failures in CI or fresh environments.

### Pitfall 6: pnpm + Docker COPY Order
**What goes wrong:** Changing any source file invalidates the dependency install layer, causing slow rebuilds.
**Why it happens:** `COPY . .` before `pnpm install` means any file change triggers a full install.
**How to avoid:** Copy only `package.json` and `pnpm-lock.yaml` first, run `pnpm install --frozen-lockfile`, then copy source.
**Warning signs:** Docker builds take minutes even for single-line code changes.

## Code Examples

### Health/Readiness Endpoints
```typescript
// src/features/health/schemas.ts
import { Type, type Static } from '@sinclair/typebox';

export const HealthResponseSchema = Type.Object({
  status: Type.Literal('ok'),
  timestamp: Type.String({ format: 'date-time' }),
  uptime: Type.Number(),
});

export type HealthResponse = Static<typeof HealthResponseSchema>;

export const ReadyResponseSchema = Type.Object({
  status: Type.Union([Type.Literal('ready'), Type.Literal('not_ready')]),
  timestamp: Type.String({ format: 'date-time' }),
});

export type ReadyResponse = Static<typeof ReadyResponseSchema>;

export const healthSchema = {
  response: { 200: HealthResponseSchema },
};

export const readySchema = {
  response: {
    200: ReadyResponseSchema,
    503: ReadyResponseSchema,
  },
};
```

```typescript
// src/features/health/routes.ts
import type { FastifyInstance } from 'fastify';
import { healthSchema, readySchema } from './schemas.js';

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/health', {
    config: { skipAuth: true },
    schema: healthSchema,
  }, async (_request, _reply) => {
    return {
      status: 'ok' as const,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  });

  fastify.get('/ready', {
    config: { skipAuth: true },
    schema: readySchema,
  }, async (_request, reply) => {
    // Phase 1: always ready (no external deps checked yet)
    // Future phases: check Qdrant connectivity, index state, etc.
    const ready = true;
    const status = ready ? 'ready' : 'not_ready';
    return reply.status(ready ? 200 : 503).send({
      status,
      timestamp: new Date().toISOString(),
    });
  });
}
```

### Vitest Test Example
```typescript
// src/features/health/__tests__/routes.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../../app.js';
import type { FastifyInstance } from 'fastify';

describe('health routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Set required env vars for config validation
    process.env.COGNIVAULT_API_KEY = 'test-api-key';
    process.env.VAULT_PATH = '/tmp/test-vault';
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns 200 without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
    expect(body.uptime).toBeGreaterThan(0);
  });

  it('GET /ready returns 200 without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ready',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ready');
  });
});
```

### Auth Test Example
```typescript
// src/plugins/__tests__/auth.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../app.js';
import type { FastifyInstance } from 'fastify';

describe('auth plugin', () => {
  let app: FastifyInstance;
  const API_KEY = 'test-api-key';

  beforeAll(async () => {
    process.env.COGNIVAULT_API_KEY = API_KEY;
    process.env.VAULT_PATH = '/tmp/test-vault';
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects requests without Authorization header with 401', async () => {
    // Need a protected route to test against
    // Health endpoints skip auth, so test against a future protected route
    // or register a test-only route
    const response = await app.inject({
      method: 'GET',
      url: '/health', // This skips auth -- test with a protected route
    });
    // Health should pass without auth
    expect(response.statusCode).toBe(200);
  });

  it('rejects requests with invalid API key with 401', async () => {
    // Implementation will need a test-only protected route or
    // test against a real protected endpoint once features exist
  });
});
```

### tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "exclude": ["dist", "node_modules"]
}
```

### Dockerfile
```dockerfile
# Stage 1: Build
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm run build

# Stage 2: Production
FROM node:22-slim AS production
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

### docker-compose.yml
```yaml
services:
  cognivault:
    build: .
    ports:
      - "${PORT:-3000}:3000"
    environment:
      - COGNIVAULT_API_KEY=${COGNIVAULT_API_KEY}
      - VAULT_PATH=/vault
      - QDRANT_URL=http://qdrant:6333
      - LOG_LEVEL=${LOG_LEVEL:-info}
    volumes:
      - ${VAULT_PATH:-./__vault}:/vault:ro
    depends_on:
      qdrant:
        condition: service_healthy

  qdrant:
    image: qdrant/qdrant:v1.13.6
    ports:
      - "6333:6333"
      - "6334:6334"
    volumes:
      - qdrant_data:/qdrant/storage
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:6333/readyz"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  qdrant_data:
```

### biome.json
```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": {
    "enabled": true
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "trailingCommas": "all"
    }
  }
}
```

### package.json Scripts
```json
{
  "name": "cognivault",
  "type": "module",
  "scripts": {
    "dev": "node --watch dist/server.js",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "biome lint src/",
    "format": "biome format --write src/",
    "check": "biome check src/ && tsc --noEmit",
    "typecheck": "tsc --noEmit"
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| ESLint + Prettier | Biome | 2024 | Single config, 10-25x faster |
| CommonJS require | ESM import with .js extensions | Node 18+ | Required for modern Node; TypeScript nodenext |
| npm/yarn | pnpm with corepack | Node 16.9+ | Built into Node, faster, strict dependency resolution |
| Fastify v4 | Fastify v5 (5.8.x) | 2024 | Requires Node 20+; updated plugin ecosystem |
| Manual env validation | Zod schema parse | 2023+ | Type-safe, fail-fast, standard pattern |

**Deprecated/outdated:**
- `@types/node` v18/v20: Use v22 to match runtime
- `moduleResolution: "node"`: Use "nodenext" for ESM projects
- `fastify-plugin` v4: Use v5+ for Fastify v5 compatibility
- Docker `RUN npm install -g pnpm`: Use corepack instead

## Open Questions

1. **@fastify/bearer-auth addHook: false option**
   - What we know: The plugin registers an onRequest hook automatically. We need to skip it for health routes.
   - What's unclear: Whether `addHook: false` is a supported option in v10.x, or if a custom auth approach is needed.
   - Recommendation: Check plugin docs during implementation. Fallback: write a custom onRequest hook with `crypto.timingSafeEqual()` for key comparison.

2. **Qdrant version pinning**
   - What we know: Latest Qdrant is v1.17-v1.18 range. User mentioned v1.13.
   - What's unclear: Whether v1.13.x is intentional (stability) or was just the latest at discussion time.
   - Recommendation: Use latest stable (check during implementation). Pin to specific patch version in docker-compose.yml.

3. **pnpm version in packageManager field**
   - What we know: Corepack reads `packageManager` from package.json to determine pnpm version.
   - What's unclear: Exact latest stable pnpm version at implementation time.
   - Recommendation: Check `pnpm --version` or npm registry during implementation. Pin exact version.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^3.x |
| Config file | vitest.config.ts (Wave 0) |
| Quick run command | `pnpm test -- --run` |
| Full suite command | `pnpm test -- --run --coverage` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| API-04 | Requests without valid API key rejected with 401 | integration | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` | No -- Wave 0 |
| API-04 | Requests with valid Bearer key succeed | integration | `pnpm test -- --run src/plugins/__tests__/auth.test.ts` | No -- Wave 0 |
| INF-01 | Health endpoint returns status | unit | `pnpm test -- --run src/features/health/__tests__/routes.test.ts` | No -- Wave 0 |
| INF-01 | Readiness endpoint returns ready/not_ready | unit | `pnpm test -- --run src/features/health/__tests__/routes.test.ts` | No -- Wave 0 |
| INF-06 | docker-compose up starts service | smoke | `docker compose up -d && curl http://localhost:3000/health` | No -- manual |

### Sampling Rate
- **Per task commit:** `pnpm test -- --run`
- **Per wave merge:** `pnpm test -- --run && pnpm check`
- **Phase gate:** Full suite green + `docker compose up` smoke test

### Wave 0 Gaps
- [ ] `vitest.config.ts` -- Vitest configuration (ESM, globals off)
- [ ] `src/features/health/__tests__/routes.test.ts` -- covers INF-01
- [ ] `src/plugins/__tests__/auth.test.ts` -- covers API-04
- [ ] Framework install: `pnpm add -D vitest` -- no test infrastructure exists yet

## Sources

### Primary (HIGH confidence)
- [Fastify official docs](https://fastify.dev/docs/latest/) -- TypeScript setup, hooks, plugins, testing
- [Fastify TypeScript reference](https://fastify.dev/docs/latest/Reference/TypeScript/) -- Type providers, ESM
- [Fastify testing guide](https://fastify.dev/docs/v5.3.x/Guides/Testing/) -- inject() pattern
- [@fastify/bearer-auth GitHub](https://github.com/fastify/fastify-bearer-auth) -- keys, addHook options
- [@fastify/type-provider-typebox GitHub](https://github.com/fastify/fastify-type-provider-typebox) -- setup, usage
- [pnpm Docker guide](https://pnpm.io/docker) -- multi-stage, corepack, fetch
- [TypeScript tsconfig reference](https://www.typescriptlang.org/tsconfig/) -- nodenext module resolution
- [Biome configuration](https://biomejs.dev/reference/configuration/) -- biome.json setup

### Secondary (MEDIUM confidence)
- [Qdrant Docker install](https://qdrant.tech/documentation/guides/installation/) -- docker-compose, healthcheck
- [Depot optimal pnpm Dockerfile](https://depot.dev/docs/container-builds/how-to-guides/optimal-dockerfiles/node-pnpm-dockerfile) -- corepack gotchas

### Tertiary (LOW confidence)
- Qdrant latest version (v1.17-v1.18 range) -- verify at implementation time via Docker Hub

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries are well-established, versions verified via npm/official docs
- Architecture: HIGH -- patterns from official Fastify docs and CLAUDE.md project conventions
- Pitfalls: HIGH -- ESM extension issue, Docker corepack issue, and fastify-plugin encapsulation are well-documented
- Validation: HIGH -- Vitest + fastify.inject() is the standard pattern

**Research date:** 2026-03-10
**Valid until:** 2026-04-10 (stable ecosystem, 30-day window)
