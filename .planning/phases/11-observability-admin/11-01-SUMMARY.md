---
phase: 11-observability-admin
plan: "01"
subsystem: observability
tags: [metrics, logging, prometheus, prom-client, x-request-id, redaction]
dependency_graph:
  requires: []
  provides: [metrics-plugin, logging-enrichment, prometheus-endpoint]
  affects: [search-routes, context-routes, pipeline]
tech_stack:
  added: [prom-client@15.1.3]
  patterns: [per-instance-registry, request-id-correlation, pino-redact, histogram-timer]
key_files:
  created:
    - src/plugins/metrics.ts
    - src/plugins/__tests__/logging.test.ts
    - src/plugins/__tests__/metrics.test.ts
  modified:
    - src/app.ts
    - src/features/search/routes.ts
    - src/features/context/routes.ts
    - src/plugins/pipeline.ts
    - src/plugins/__tests__/pipeline.test.ts
    - src/features/search/__tests__/routes.test.ts
    - src/features/context/__tests__/routes.test.ts
decisions:
  - "Per-instance prom-client Registry (not global default) to prevent test pollution across parallel test runs"
  - "Custom Pino req serializer includes headers so redact path req.headers.authorization can fire"
  - "Metrics plugin registered after toon, before infrastructure plugins — no infrastructure dependencies"
  - "pipeline fp dependencies include 'metrics' to enforce registration order"
  - "Test mocks for OpenAI and Qdrant in new integration tests — fullbuildApp tests require service mocks since real services unavailable in test env"
metrics:
  duration: 17min
  completed_date: "2026-03-12"
  tasks: 2
  files: 10
---

# Phase 11 Plan 01: Logging Enrichment and Prometheus Metrics Summary

**One-liner:** Structured logging with X-Request-ID correlation and Authorization redaction; Prometheus /metrics endpoint with search duration histograms, throughput counters, queue depth gauge, and stale cleanup counter via per-instance prom-client Registry.

## What Was Built

### Logging Enrichment (src/app.ts)

- `requestIdHeader: 'x-request-id'` — Fastify accepts agent-provided request IDs
- `genReqId: () => randomUUID()` — UUID generated when header absent
- `requestIdLogLabel: 'reqId'` — request ID appears as `reqId` in all log entries
- Custom req serializer includes `headers` in the Pino log data, enabling Pino's `redact` path `req.headers.authorization` to replace the value with `[Redacted]`
- `onSend` hook echoes `request.id` as `X-Request-ID` response header on every response

### Metrics Plugin (src/plugins/metrics.ts)

- Per-instance `Registry` (not prom-client global) — avoids metric re-registration errors across test runs
- `collectDefaultMetrics({ register })` — CPU, memory, event loop lag, GC metrics
- `cognivault_search_duration_seconds` — Histogram with `type` label (semantic/hybrid/lexical), buckets 5ms–2.5s
- `cognivault_search_requests_total` — Counter with `type` label
- `cognivault_index_queue_depth` — Gauge tracking queue.size + queue.pending
- `cognivault_stale_vector_cleanups_total` — Counter for each qdrant.delete stale cleanup
- GET `/metrics` with `skipAuth: true` — Prometheus scraping without auth
- fastify.decorate('metrics', { ... }) — available to all routes and plugins

### Metrics Instrumentation

- **search/routes.ts**: `startTimer({ type })` before search, `endTimer()` after, `inc({ type })` on success — for all three search types
- **context/routes.ts**: `inc({ type: 'hybrid' })` after hybrid search within context assembly
- **pipeline.ts**: `indexQueueDepth.set()` on enqueue and in finally block after each task; `staleVectorCleanups.inc()` after each qdrant.delete stale cleanup in both `embedAndUpsert` and `processMarkdown`

## Tests Written

- **logging.test.ts** (3 tests): X-Request-ID echo, UUID generation, Authorization header redaction
- **metrics.test.ts** (7 tests): /metrics returns 200 without auth, correct content-type, all four custom metric names, process default metrics

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test suite requires mocking OpenAI and Qdrant for full-app tests**
- **Found during:** Task 1 test execution
- **Issue:** `buildApp` calls in integration tests fail because `embeddingPlugin.validate()` makes real API call and `qdrantPlugin` connects to localhost:6333 — both unavailable in CI/test env
- **Fix:** Added `vi.mock('openai', ...)` and `vi.mock('@qdrant/js-client-rest', ...)` at the top of `logging.test.ts` and `metrics.test.ts`
- **Files modified:** src/plugins/__tests__/logging.test.ts, src/plugins/__tests__/metrics.test.ts
- **Commit:** 5e15e79

**2. [Rule 1 - Bug] Pino req serializer doesn't log headers by default in Fastify v5**
- **Found during:** Task 1 redaction test
- **Issue:** Default Fastify v5 Pino serializer logs `method`, `url`, `hostname`, `remoteAddress` but NOT `req.headers` — so `redact: ['req.headers.authorization']` never fires
- **Fix:** Added custom `serializeRequest` function that includes `headers` in the serialized req object, enabling Pino's redact to operate on the authorization value
- **Files modified:** src/app.ts
- **Commit:** fb05b77

**3. [Rule 1 - Bug] Pipeline test fails due to missing 'metrics' dependency**
- **Found during:** Task 2 full test suite run
- **Issue:** Pipeline's `buildTestApp` test helper doesn't register a 'metrics' plugin; after adding `metrics` to fp dependencies, Fastify throws "dependency 'metrics' not registered"
- **Fix:** Added `metrics` mock decorator in `buildTestApp` and added `'metrics'` to the dependency registration loop
- **Files modified:** src/plugins/__tests__/pipeline.test.ts
- **Commit:** 6538493

**4. [Rule 1 - Bug] Search and context route tests fail due to missing metrics decorator**
- **Found during:** Task 2 full test suite run
- **Issue:** `fastify.metrics` undefined in test apps for search and context routes after adding instrumentation calls
- **Fix:** Added metrics mock decorator using `as unknown as FastifyInstance['metrics']` (no `any`, clean TypeScript)
- **Files modified:** src/features/search/__tests__/routes.test.ts, src/features/context/__tests__/routes.test.ts
- **Commit:** 6538493

### Pre-existing Issues (Not Fixed — Out of Scope)

- `src/lib/vault.ts` — 4 `useTemplate` lint warnings (string concatenation instead of template literals)
- `src/plugins/__tests__/pipeline.test.ts` — 5+ `useLiteralKeys` lint warnings (bracket notation on `payload['path']` etc.)
- `src/features/context/__tests__/service.test.ts` — `noNonNullAssertion` lint warnings
- 5 test files fail at module-level config parsing (missing OPENAI_API_KEY or Qdrant at import time) — pre-existing before Phase 11

### Admin Routes Discovery

The admin routes feature (`src/features/admin/routes.ts`, `src/features/admin/service.ts`) was pre-existing in the working tree from Phase 11 Plan 02 work. Biome's auto-import-organizer added the `adminRoutes` import to `app.ts`. Verified it compiles correctly and was left in place as it belongs to the next plan.

## Self-Check

**Files created/modified:**
- [x] src/plugins/metrics.ts — FOUND
- [x] src/plugins/__tests__/logging.test.ts — FOUND
- [x] src/plugins/__tests__/metrics.test.ts — FOUND
- [x] src/app.ts — FOUND
- [x] src/features/search/routes.ts — FOUND
- [x] src/features/context/routes.ts — FOUND
- [x] src/plugins/pipeline.ts — FOUND

**Commits:**
- [x] 5e15e79 — test(11-01): add failing tests
- [x] fb05b77 — feat(11-01): add logging enrichment and Prometheus metrics plugin
- [x] 6538493 — feat(11-01): instrument search routes, context routes, and pipeline

**Test results:** 343 tests pass, 5 file-level failures (all pre-existing)

## Self-Check: PASSED
