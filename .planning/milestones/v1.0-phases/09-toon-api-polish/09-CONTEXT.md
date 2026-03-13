# Phase 9: TOON + API Polish - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Agents communicate with CogniVault using either JSON or TOON (Token-Oriented Object Notation) for ~40% token savings. Service supports content negotiation via Accept/Content-Type headers. OpenAPI spec is auto-generated from route definitions and accessible via endpoint with interactive Swagger UI.

</domain>

<decisions>
## Implementation Decisions

### TOON Format
- Use `@toon-format/toon` npm package (official TypeScript SDK)
- MIME type: `text/toon` (provisional)
- TOON support applies to ALL endpoints except health/readiness (which stay JSON-only for Docker/K8s probes)
- Invalid TOON input returns 400 Bad Request with `{ error: { code: 'INVALID_TOON', message: '...' } }`

### Content Negotiation Implementation
- Fastify `addContentTypeParser` for text/toon request parsing (decode TOON → JSON object)
- Fastify `onSend` hook or custom serializer for TOON response serialization
- TOON request bodies are decoded to JSON first, then validated against same TypeBox schemas as JSON — one source of truth for validation
- No extra response headers for TOON discovery — standard content negotiation only

### Content Negotiation Behavior
- If Accept header contains text/toon anywhere (regardless of q-values), prefer TOON response
- If Accept is unsupported (e.g., text/xml), fall back to JSON gracefully
- If TOON serialization fails, return TOON best-effort (let the format handle it)
- Format is symmetric: if agent sends Content-Type: text/toon, response is TOON; if JSON, response is JSON. Content-Type determines response format (must match)
- JSON is default when Accept is application/json or unspecified

### Error Responses in TOON Mode
- When agent requested TOON (via Accept or Content-Type), error responses are also TOON-serialized
- Same `{ error: { code, message } }` structure regardless of format — just serialized as TOON or JSON
- Even 401 auth errors check Accept header and return TOON if requested — full symmetry
- Health/readiness errors always JSON (those endpoints are JSON-only)

### OpenAPI Spec Generation
- Use @fastify/swagger for auto-generation from TypeBox route schemas
- Use @fastify/swagger-ui for interactive browser-based exploration
- Swagger UI served at /docs, JSON spec at /docs/json, YAML at /docs/yaml
- No authentication required for docs endpoints (like health endpoints)
- OpenAPI spec documents both text/toon and application/json as supported content types

### Claude's Discretion
- Exact Fastify plugin structure for TOON middleware (single plugin vs separate parser/serializer)
- How to integrate TOON content types into @fastify/swagger spec generation
- TOON serializer error handling internals

</decisions>

<specifics>
## Specific Ideas

- TOON format reference: https://github.com/toon-format/toon
- `@toon-format/toon` is the official TypeScript SDK on npm
- TOON achieves ~40% token savings on tabular data (arrays of objects with uniform fields) — CogniVault search results and context packs are ideal candidates
- Health/readiness endpoints explicitly excluded from TOON to keep infra probes simple

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `error-handler.ts` plugin: standardized `{ error: { code, message } }` format — TOON errors must serialize this same structure
- TypeBox schemas in each feature's `schemas.ts`: TOON validation reuses these after decode
- `@fastify/type-provider-typebox` already configured in app.ts

### Established Patterns
- Plugins registered via `fp()` wrapping with dependency declarations
- Plugin order in app.ts: error-handler → auth → infrastructure → feature routes
- Auth plugin skips health routes — same pattern needed for docs routes
- Route schemas defined with TypeBox in `schemas.ts` files per feature

### Integration Points
- `app.ts`: register TOON plugin (before feature routes), register swagger plugins
- `error-handler.ts`: needs TOON-awareness to serialize errors in correct format based on Accept header
- `auth.ts`: needs TOON-awareness for 401 error responses
- All feature routes in `src/features/`: automatically benefit from content-type parser once registered

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 09-toon-api-polish*
*Context gathered: 2026-03-12*
