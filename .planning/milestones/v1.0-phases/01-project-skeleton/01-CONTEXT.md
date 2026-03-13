# Phase 1: Project Skeleton - Context

**Gathered:** 2026-03-10
**Status:** Ready for planning

<domain>
## Phase Boundary

A running Fastify service in Docker that authenticates requests and reports health. Delivers: TypeScript project scaffold, health/readiness endpoints, API key authentication, Docker deployment with Qdrant sidecar. No business logic — this is the foundation every subsequent phase builds on.

</domain>

<decisions>
## Implementation Decisions

### Runtime & tooling
- Package manager: pnpm
- Node.js: v22 LTS
- Test runner: Vitest
- Linting/formatting: Biome (single tool for both)
- TypeScript with ESM module resolution

### Project structure
- Feature-based layout: src/features/{name}/routes.ts, schemas.ts, etc.
- Fastify plugins in src/plugins/
- Shared utilities in src/lib/
- Colocated tests: src/features/{name}/__tests__/routes.test.ts
- Route schemas: TypeBox (Fastify-native, enables OpenAPI generation in Phase 9)
- Config validation: Zod schema at startup — fail fast on missing/invalid env vars

### Auth mechanism
- API key delivered via Authorization: Bearer header
- Single API key configured via COGNIVAULT_API_KEY env var
- Health and readiness endpoints: no auth required (Docker/K8s probe compatibility)
- Error response format: `{"error": {"code": "UNAUTHORIZED", "message": "..."}}` — structured JSON with code + message, consistent across all error types

### Docker setup
- Multi-stage Dockerfile: build stage (TypeScript compile), production stage (compiled JS + pruned node_modules)
- Single docker-compose.yml optimized for development (prod profile deferred)
- Vault directory: bind mount via VAULT_PATH env var
- Qdrant sidecar: pinned to specific version (v1.13 or latest stable at implementation time)
- Base image: node:22-slim (Alpine if no native module issues)

### Claude's Discretion
- Exact Fastify plugin registration order
- Health endpoint response payload structure beyond status
- Readiness check logic (what constitutes "ready")
- .env.example template contents
- TypeScript strictness settings (strict: true assumed)
- Biome rule configuration

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches. User consistently chose recommended/standard options, indicating preference for well-established patterns over novel approaches.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- None — greenfield project, no existing code

### Established Patterns
- None yet — this phase establishes the foundational patterns all subsequent phases will follow

### Integration Points
- Every subsequent phase registers as a Fastify plugin under src/features/
- Config module (src/config.ts) will be extended with new env vars as phases add requirements
- Auth middleware will be reused by all authenticated routes in Phases 2-11

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-project-skeleton*
*Context gathered: 2026-03-10*
