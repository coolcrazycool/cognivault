# Phase 11: Observability + Admin - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Service is production-ready with structured logging, metrics, tracing, and admin reindex controls. Delivers: enriched Pino logging with request ID correlation, Prometheus /metrics endpoint with search and process metrics, optional OpenTelemetry tracing with OTLP export, and async admin reindex endpoints (full, by path, by folder).

</domain>

<decisions>
## Implementation Decisions

### Logging enrichment
- Keep Fastify's built-in Pino request logging (reqId, method, url, statusCode, responseTime)
- Accept X-Request-ID from agent via header; if absent, generate UUID server-side
- Echo request ID back in X-Request-ID response header for agent correlation
- Redact Authorization header value in request logs (Pino redact option)
- Do not log request/response bodies (Pino default behavior)

### Metrics design
- Use prom-client directly (not fastify-metrics wrapper) for full control
- Enable collectDefaultMetrics() for CPU, memory, GC, event loop lag
- /metrics endpoint unauthenticated (like health/readiness — infrastructure tool access)
- Search latency histogram labeled by type: `cognivault_search_duration_seconds{type="semantic|lexical|hybrid"}`
- Additional required metrics: throughput counter, index queue depth gauge, stale vector cleanup counter
- Metric prefix: `cognivault_`

### Tracing scope
- Request lifecycle instrumentation only (HTTP entry through response) — no deep Qdrant/embedding client spans
- Manual spans for search and context assembly operations
- OTLP exporter configured via OTEL_EXPORTER_OTLP_ENDPOINT env var
- Tracing is optional: only initialize OTel SDK if OTEL_EXPORTER_OTLP_ENDPOINT is set — zero overhead when disabled
- Inject OTel trace ID into Pino log context when tracing is active (traceId field in log entries)

### Reindex API
- Async pattern: POST /api/admin/reindex returns 202 Accepted with job ID
- GET /api/admin/reindex/status returns progress (files processed, total, errors)
- Three scopes: `{scope: "full"}`, `{scope: "path", path: "notes/foo.md"}`, `{scope: "folder", folder: "projects/"}`
- Requires API key authentication (admin/write operation)
- Supports TOON format via existing content negotiation plugin (same as all non-health endpoints)

### Claude's Discretion
- Exact histogram bucket boundaries for search latency
- OTel SDK initialization pattern (instrumentation.ts file structure)
- Reindex job storage (in-memory map vs SQLite)
- Metric naming for non-search operations
- Pino serializer configuration details

</decisions>

<specifics>
## Specific Ideas

- /metrics follows same pattern as /health — no auth, infrastructure access
- Reindex leverages existing VaultIndexer which already has isIndexing state and change event emitter
- Request ID correlation enables end-to-end debugging: agent sends X-Request-ID, sees it in response, matches to server logs

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `VaultIndexer` (src/lib/indexer.ts): Has `start()`, `stop()`, `isIndexing` state, emits `changes` events — reindex endpoints wrap this
- `error-handler.ts`: Already uses `fastify.log.error()` — structured error logging in place
- `config.ts`: Zod schema with LOG_LEVEL already defined — extend for OTEL_EXPORTER_OTLP_ENDPOINT
- Auth plugin: `skipAuth` config flag pattern used by health routes — reuse for /metrics

### Established Patterns
- Plugins registered via `fp()` wrapping with dependency declarations
- Plugin order: error-handler -> auth -> swagger -> toon -> infrastructure -> feature routes
- Health routes use `config: { skipAuth: true }` to bypass auth — /metrics should use same pattern
- Feature routes registered with prefix (`/api/vault`, etc.)

### Integration Points
- `app.ts`: Register metrics plugin and tracing plugin in plugin section
- `server.ts`: OTel SDK must initialize BEFORE Fastify starts (instrumentation requirement)
- `config.ts`: Add optional OTEL_EXPORTER_OTLP_ENDPOINT env var
- Search routes: Instrument with latency histogram recording
- Pipeline plugin: Expose index queue depth and stale cleanup counts for metrics

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 11-observability-admin*
*Context gathered: 2026-03-12*
