# CogniVault

Knowledge access layer for AI agents working with Obsidian vaults. REST API service built with Fastify + TypeScript.

## Stack

- **Runtime:** Node.js v22 LTS, ESM modules
- **Framework:** Fastify
- **Language:** TypeScript (strict mode)
- **Package manager:** pnpm
- **Test runner:** Vitest
- **Linting/formatting:** Biome (single tool for both lint and format)
- **Route schemas:** TypeBox (Fastify-native, drives OpenAPI generation)
- **Config validation:** Zod (fail fast on startup)
- **Database:** SQLite via Drizzle ORM (index state)
- **Vector store:** Qdrant (embeddings, search)
- **Deployment:** Docker + docker-compose (service + Qdrant sidecar)

## Project Structure

```
src/
  app.ts              # Fastify app factory
  server.ts           # Entry point (starts server)
  config.ts           # Zod-validated env config
  plugins/            # Fastify plugins (auth, error handler, etc.)
  features/           # Feature modules
    {name}/
      routes.ts       # Route definitions
      schemas.ts      # TypeBox request/response schemas
      service.ts      # Business logic
      __tests__/      # Colocated tests
        routes.test.ts
  lib/                # Shared utilities
```

## Coding Conventions

### TypeScript
- ESM imports only (`import/export`, no `require`)
- Use `type` imports for type-only imports: `import type { Foo } from './bar.js'`
- File extensions in imports: `'./config.js'` (ESM requirement, even for .ts files)
- Prefer `interface` over `type` for object shapes
- No `any` — use `unknown` and narrow

### Fastify Patterns
- Register features as Fastify plugins via `fastify.register()`
- Define route schemas with TypeBox in `schemas.ts`, reference in route options
- Use `fastify.decorate()` for shared services, access via `fastify.serviceName`
- Auth: `onRequest` hook via Fastify plugin, not per-route middleware
- Error responses: `{ error: { code: "ERROR_CODE", message: "Human-readable" } }`

### Testing
- Test files: `src/features/{name}/__tests__/*.test.ts`
- Use `fastify.inject()` for route testing (no real HTTP server needed)
- Integration tests use `test/` directory at project root
- Run tests: `pnpm test`
- Run single test: `pnpm test -- --run src/features/health/__tests__/routes.test.ts`

### Code Quality
- Format before commit: `pnpm format`
- Lint: `pnpm lint`
- Type check: `pnpm typecheck`
- All three must pass: `pnpm check` (runs all)

### Docker
- Multi-stage Dockerfile: build stage (tsc), production stage (node:22-slim)
- `docker-compose up` starts service + Qdrant
- Vault directory: bind mount via `VAULT_PATH` env var
- Dev workflow: run outside Docker (`pnpm dev`), Docker for integration/deployment

### Git
- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`
- Scope by feature: `feat(health): add readiness endpoint`
- One logical change per commit

## Environment Variables

```
# Required
COGNIVAULT_API_KEY=        # API key for authenticating requests
VAULT_PATH=                # Absolute path to Obsidian vault directory

# Optional
PORT=3000                  # HTTP port (default: 3000)
HOST=0.0.0.0              # Bind address (default: 0.0.0.0)
LOG_LEVEL=info             # Pino log level (default: info)
QDRANT_URL=http://localhost:6333  # Qdrant connection URL
```

## Key Decisions

- **No `default` exports** — named exports only for clarity and refactoring safety
- **Feature-based structure** — each feature is a self-contained Fastify plugin
- **Auth on public endpoints only** — health/readiness skip auth for Docker/K8s probes
- **Zod for config, TypeBox for routes** — Zod validates env at startup; TypeBox provides Fastify-native JSON Schema for routes and OpenAPI
- **Pino for logging** — Fastify's default logger, structured JSON output
