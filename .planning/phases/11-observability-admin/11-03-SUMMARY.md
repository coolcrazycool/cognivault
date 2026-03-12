---
phase: 11-observability-admin
plan: "03"
subsystem: infra
tags: [opentelemetry, otel, tracing, distributed-tracing, otlp, pino, fastify]

# Dependency graph
requires:
  - phase: 11-01
    provides: Pino logging enrichment and Prometheus metrics — tracing adds third observability pillar

provides:
  - Conditional OTel NodeSDK initialization (only when OTEL_EXPORTER_OTLP_ENDPOINT is set)
  - Manual spans in search routes (semantic, hybrid, lexical) with search.results_count attribute
  - Manual span in context assembly route with context.chunks_count and context.token_budget attributes
  - Trace ID injection into Pino request log context when span is sampled
  - Graceful SDK shutdown on SIGTERM (flushes buffered spans)

affects: []

# Tech tracking
tech-stack:
  added:
    - "@opentelemetry/sdk-node 0.213.0"
    - "@opentelemetry/api 1.9.0"
    - "@opentelemetry/exporter-trace-otlp-http 0.213.0"
    - "@opentelemetry/auto-instrumentations-node 0.71.0"
    - "@opentelemetry/resources 2.6.0"
    - "@opentelemetry/semantic-conventions 1.40.0"
  patterns:
    - "Conditional OTel SDK init: check env var at startup, dynamically import and call initTracing only when set"
    - "Module-level no-op tracer pattern: trace.getTracer() returns no-op when SDK uninitialized — zero overhead"
    - "TraceFlags.SAMPLED guard for log injection: avoids polluting logs with all-zeros trace IDs from no-op tracer"
    - "resourceFromAttributes() used instead of new Resource() for @opentelemetry/resources v2 compatibility"

key-files:
  created:
    - src/lib/tracing.ts
    - src/lib/__tests__/tracing.test.ts
  modified:
    - src/config.ts
    - src/server.ts
    - src/features/search/routes.ts
    - src/features/context/routes.ts

key-decisions:
  - "resourceFromAttributes() used (not new Resource()) — @opentelemetry/resources v2 removed Resource class, replaced with resourceFromAttributes factory"
  - "TraceFlags.SAMPLED guard for log injection — no-op tracer returns all-zeros traceId (00000000...) with traceFlags=0; checking SAMPLED flag prevents polluting Pino logs with meaningless zeros"
  - "shutdownTracing exported at top level in server.ts — safe to import unconditionally, returns Promise.resolve() when SDK not initialized"
  - "Dynamic import for initTracing in server.ts — conditional import pattern avoids loading OTel SDK when not needed"

patterns-established:
  - "OTel conditional init: check config env var, dynamic import, call init before app build"
  - "Span error pattern: try/catch with recordException + setStatus(ERROR) + finally span.end()"
  - "Sampled-only log injection: traceFlags & TraceFlags.SAMPLED guards child logger creation"

requirements-completed: [INF-05]

# Metrics
duration: 4min
completed: 2026-03-12
---

# Phase 11 Plan 03: OpenTelemetry Distributed Tracing Summary

**Optional OTLP tracing via NodeSDK with manual search/context spans and Pino trace ID correlation — zero overhead when disabled**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-12T12:54:42Z
- **Completed:** 2026-03-12T12:58:40Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Conditional OTel SDK initialization: NodeSDK starts only when `OTEL_EXPORTER_OTLP_ENDPOINT` env var is set; zero overhead otherwise (no-op tracer is transparent)
- Manual spans on all 4 key routes: `search.semantic`, `search.hybrid`, `search.lexical`, `context.assemble` with relevant attributes and error recording
- Trace ID injected into Pino log context via `request.log.child({ traceId })` only when span is sampled — enables log/trace correlation in Grafana Tempo or Jaeger
- Graceful SDK shutdown on SIGTERM flushes buffered spans before process exit

## Task Commits

Each task was committed atomically:

1. **Task 1: OTel SDK module, config extension, and server integration** - `9ba2eb5` (feat)
2. **Task 2: Manual spans in search/context routes with trace ID log injection** - `83d8a0c` (feat)

## Files Created/Modified

- `src/lib/tracing.ts` - OTel NodeSDK init/shutdown module with `initTracing`/`shutdownTracing` exports
- `src/lib/__tests__/tracing.test.ts` - Unit tests for export shape and no-op shutdown behavior
- `src/config.ts` - Added `OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional()` to configSchema
- `src/server.ts` - Conditional dynamic import of `initTracing` before `buildApp`; `shutdownTracing` in graceful shutdown
- `src/features/search/routes.ts` - `startActiveSpan` wrapping all three search handlers with result count attributes
- `src/features/context/routes.ts` - `startActiveSpan` wrapping context assembly with chunk count and budget attributes

## Decisions Made

- **`resourceFromAttributes()` instead of `new Resource()`:** `@opentelemetry/resources` v2 removed the `Resource` class; the new API is `resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'cognivault' })`. Fixed during Task 1 typecheck.
- **`TraceFlags.SAMPLED` guard for trace ID log injection:** When OTel is not initialized, `trace.getTracer()` returns a no-op tracer whose spans have `traceId = '00000000000000000000000000000000'` and `traceFlags = 0`. Checking `spanCtx.traceFlags & TraceFlags.SAMPLED` prevents injecting meaningless zeros into Pino logs when tracing is disabled.
- **Dynamic import for `initTracing`, static import for `shutdownTracing`:** `shutdownTracing` is safe to import statically (returns `Promise.resolve()` when SDK is null); `initTracing` is guarded by an `if` block with dynamic import to avoid loading the OTel SDK when the endpoint is not configured.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `@opentelemetry/resources` v2 API change: `Resource` class removed**
- **Found during:** Task 1 (OTel SDK module creation)
- **Issue:** Plan specified `import { Resource } from '@opentelemetry/resources'` and `new Resource(...)` but v2 exports only `resourceFromAttributes` factory function; TypeScript reported TS2693 (`'Resource' only refers to a type`)
- **Fix:** Changed import to `resourceFromAttributes` from `@opentelemetry/resources` and called `resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'cognivault' })`
- **Files modified:** `src/lib/tracing.ts`
- **Verification:** `pnpm typecheck` passes; tracing tests pass
- **Committed in:** `9ba2eb5` (Task 1 commit)

**2. [Rule 2 - Missing Critical] Added `TraceFlags.SAMPLED` guard for log injection**
- **Found during:** Task 2 (trace ID log injection)
- **Issue:** Plan used `if (traceId)` check for log injection, but no-op tracer returns all-zeros trace ID which is truthy — this would inject `traceId: '00000000000000000000000000000000'` into every log entry when tracing is disabled
- **Fix:** Added `TraceFlags` import and changed guard to `spanCtx.traceFlags & TraceFlags.SAMPLED`
- **Files modified:** `src/features/search/routes.ts`, `src/features/context/routes.ts`
- **Verification:** `pnpm typecheck` passes; search and context route tests pass
- **Committed in:** `83d8a0c` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 missing critical correctness guard)
**Impact on plan:** Both fixes necessary for correctness. No scope creep.

## Issues Encountered

None beyond the two deviations above.

## User Setup Required

**Optional OTLP backend configuration.** To enable distributed tracing, add to your environment:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318  # Grafana Tempo, Jaeger, or any OTLP-compatible backend
```

Without this variable, the service starts normally with zero tracing overhead.

## Next Phase Readiness

- All three observability pillars complete: structured logging (11-01), Prometheus metrics (11-01), distributed tracing (11-03)
- Phase 11 admin endpoints (11-02) already complete
- Phase 11 is fully complete

---
*Phase: 11-observability-admin*
*Completed: 2026-03-12*

## Self-Check: PASSED

- src/lib/tracing.ts: FOUND
- src/lib/__tests__/tracing.test.ts: FOUND
- 11-03-SUMMARY.md: FOUND
- Commit 9ba2eb5: FOUND
- Commit 83d8a0c: FOUND
