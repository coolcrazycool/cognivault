# Phase 11: Observability + Admin - Research

**Researched:** 2026-03-12
**Domain:** Pino logging enrichment, Prometheus metrics (prom-client), OpenTelemetry tracing, admin reindex API
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Logging enrichment**
- Keep Fastify's built-in Pino request logging (reqId, method, url, statusCode, responseTime)
- Accept X-Request-ID from agent via header; if absent, generate UUID server-side
- Echo request ID back in X-Request-ID response header for agent correlation
- Redact Authorization header value in request logs (Pino redact option)
- Do not log request/response bodies (Pino default behavior)

**Metrics design**
- Use prom-client directly (not fastify-metrics wrapper) for full control
- Enable collectDefaultMetrics() for CPU, memory, GC, event loop lag
- /metrics endpoint unauthenticated (like health/readiness — infrastructure tool access)
- Search latency histogram labeled by type: `cognivault_search_duration_seconds{type="semantic|lexical|hybrid"}`
- Additional required metrics: throughput counter, index queue depth gauge, stale vector cleanup counter
- Metric prefix: `cognivault_`

**Tracing scope**
- Request lifecycle instrumentation only (HTTP entry through response) — no deep Qdrant/embedding client spans
- Manual spans for search and context assembly operations
- OTLP exporter configured via OTEL_EXPORTER_OTLP_ENDPOINT env var
- Tracing is optional: only initialize OTel SDK if OTEL_EXPORTER_OTLP_ENDPOINT is set — zero overhead when disabled
- Inject OTel trace ID into Pino log context when tracing is active (traceId field in log entries)

**Reindex API**
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

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INF-03 | Service emits structured JSON logs with request context | Pino requestIdHeader, genReqId, redact, onSend hook for response header |
| INF-04 | Service exposes Prometheus metrics (latency, throughput, index stats) | prom-client v15 — Histogram, Counter, Gauge, collectDefaultMetrics, Registry |
| INF-05 | Service supports OpenTelemetry distributed tracing | @opentelemetry/sdk-node + OTLP HTTP exporter, conditional init pattern, manual spans via @opentelemetry/api |
| IDX-13 | Admin can trigger full or partial reindex via API endpoint | VaultIndexer.start() reuse, in-memory job map, 202 Accepted async pattern |
</phase_requirements>

---

## Summary

Phase 11 delivers production observability by layering four capabilities onto the existing Fastify + Pino + VaultIndexer stack. All four plans build on established project patterns (fp() plugins, skipAuth config flag, TypeBox schemas) — none requires architectural changes.

**Logging (Plan 11-01):** Fastify 5 accepts X-Request-ID via `requestIdHeader` server option. UUID generation falls back via `genReqId` when the header is absent. Response header echo uses `onSend` hook with `reply.header('X-Request-ID', request.id)`. Authorization header redaction uses Pino's `redact` option at Fastify construction time. No custom serializer is needed since Fastify's default req serializer already omits bodies.

**Metrics (Plan 11-02):** prom-client v15 is the industry standard for Node.js Prometheus metrics. Use a single shared `Registry` instance, `collectDefaultMetrics({ register })` for process metrics, and typed metric constructors with `labelNames`. The `/metrics` route follows the same `skipAuth: true` pattern as `/health`. Metrics are decorated onto the Fastify instance so search routes and the pipeline plugin can record observations.

**Tracing (Plan 11-03):** OpenTelemetry JS requires ESM-specific loader configuration (`--experimental-loader=@opentelemetry/instrumentation/hook.mjs` alongside `--import`). For this project's scope (request lifecycle + manual spans only), the simpler approach is to initialize the SDK conditionally in `server.ts` before `buildApp()`, use `@opentelemetry/sdk-node` with `@opentelemetry/exporter-trace-otlp-http`, and add manual spans in search/context routes via `@opentelemetry/api`. Trace ID injection into Pino uses a per-request child logger binding.

**Reindex Admin (Plan 11-04):** `VaultIndexer` already has `start()`, `stop()`, `isIndexing`, and emits `changes` events — reindex wraps this. An in-memory `Map<string, ReindexJob>` is appropriate for job state (single-process, non-critical persistence). The async 202 pattern with GET status polling matches the decisions exactly.

**Primary recommendation:** Follow the four-plan sequence in order; Plans 11-01 through 11-03 are infrastructure changes to shared plugins, while Plan 11-04 is an independent feature route.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| prom-client | ^15.1.3 | Prometheus metrics (Histogram, Counter, Gauge, Registry, collectDefaultMetrics) | De facto standard for Node.js Prometheus metrics; TypeScript support with generic label types |
| @opentelemetry/sdk-node | ^0.x (latest) | OTel SDK for Node.js — wraps trace provider, span processors, OTLP exporter setup | Official SDK from OpenTelemetry project; single entry point for Node.js setup |
| @opentelemetry/api | ^1.x (latest) | OTel public API — `trace.getTracer()`, `startActiveSpan()`, `SpanStatusCode` | Stable public API separate from SDK; importable from route handlers without SDK coupling |
| @opentelemetry/exporter-trace-otlp-http | ^0.x (latest) | HTTP/JSON OTLP trace exporter | Simpler than proto variant; works with Grafana Tempo, Jaeger, and all major OTLP backends |
| @opentelemetry/auto-instrumentations-node | ^0.x (latest) | Auto-instruments http, node core, etc. | Provides HTTP span lifecycle without manual onRequest/onResponse hooks |
| @opentelemetry/resources | ^1.x (latest) | Resource attributes (service.name, service.version) | Required for proper service identification in trace backends |
| @opentelemetry/semantic-conventions | ^1.x (latest) | Standard attribute names (`ATTR_SERVICE_NAME`) | Avoids hardcoding string keys |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| uuid (already installed) | ^13.0.0 | UUID v4 generation for request IDs | genReqId fallback when X-Request-ID absent |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| prom-client directly | fastify-metrics plugin | fastify-metrics wraps prom-client but adds less control over metric registration and endpoint config; decided against in CONTEXT.md |
| @opentelemetry/exporter-trace-otlp-http | @opentelemetry/exporter-trace-otlp-proto | Proto is more efficient but requires protobuf dependency; HTTP/JSON simpler for this scope |
| In-memory job map | SQLite for reindex jobs | SQLite adds persistence but jobs are transient and single-process; in-memory sufficient |

**Installation:**
```bash
pnpm add prom-client @opentelemetry/sdk-node @opentelemetry/api @opentelemetry/exporter-trace-otlp-http @opentelemetry/auto-instrumentations-node @opentelemetry/resources @opentelemetry/semantic-conventions
```

---

## Architecture Patterns

### Recommended Project Structure

```
src/
  plugins/
    metrics.ts          # prom-client plugin — creates Registry, registers metrics, exposes /metrics route
    tracing.ts          # OTel SDK init (optional, conditional on OTEL_EXPORTER_OTLP_ENDPOINT)
  features/
    admin/
      routes.ts         # POST /api/admin/reindex, GET /api/admin/reindex/status
      schemas.ts        # TypeBox: ReindexRequestBody, ReindexResponse, StatusResponse
      service.ts        # ReindexService — job map, scope dispatch
      __tests__/
        routes.test.ts
  app.ts                # Register metrics plugin + tracing plugin (if enabled)
  server.ts             # Call initTracing() before buildApp() if OTEL_EXPORTER_OTLP_ENDPOINT set
  config.ts             # Add OTEL_EXPORTER_OTLP_ENDPOINT optional field
```

### Pattern 1: Pino Logging with X-Request-ID (INF-03)

**What:** Configure Fastify server options at `buildApp()` time — not a plugin. Pino handles request/response serialization automatically; only add request ID header acceptance, UUID fallback, Authorization redaction, and response header echo.

**When to use:** Applies globally to all requests via Fastify server options + one `onSend` hook.

**Fastify server construction in app.ts:**
```typescript
// Source: https://fastify.dev/docs/latest/Reference/Server/
import { randomUUID } from 'node:crypto';

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    redact: ['req.headers.authorization'],
  },
  requestIdHeader: 'x-request-id',  // accept from agent; false disables, string enables
  genReqId: () => randomUUID(),      // fallback when header absent
  requestIdLogLabel: 'reqId',        // default field name in Pino output
}).withTypeProvider<TypeBoxTypeProvider>();

// Echo request ID in response header (global onSend hook)
app.addHook('onSend', async (request, reply) => {
  reply.header('X-Request-ID', request.id);
});
```

**Key points:**
- `requestIdHeader: 'x-request-id'` is case-insensitive — matches `X-Request-ID` from agents
- `genReqId` is NOT called when the header is present (Fastify uses the header value directly)
- `redact: ['req.headers.authorization']` replaces the Authorization value with `[Redacted]` in logs
- The `onSend` hook applies to all routes; fires before response is sent to client

### Pattern 2: prom-client Metrics Plugin (INF-04)

**What:** Create a Fastify plugin that owns a single `Registry`, registers all `cognivault_*` metrics, calls `collectDefaultMetrics()`, decorates metric instances onto `fastify`, and registers the `/metrics` GET route.

**When to use:** Registered once in `app.ts` after auth plugin; search routes and pipeline plugin access metrics via `fastify.metrics.*`.

**Plugin structure:**
```typescript
// Source: GitHub siimon/prom-client README
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    metrics: {
      searchDuration: Histogram<'type'>;
      searchRequests: Counter<'type'>;
      indexQueueDepth: Gauge<never>;
      staleVectorCleanups: Counter<never>;
    };
  }
}

async function metricsPlugin(fastify: FastifyInstance): Promise<void> {
  const register = new Registry();
  collectDefaultMetrics({ register, prefix: 'cognivault_' });

  const searchDuration = new Histogram<'type'>({
    name: 'cognivault_search_duration_seconds',
    help: 'Search request latency by type',
    labelNames: ['type'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [register],
  });

  const searchRequests = new Counter<'type'>({
    name: 'cognivault_search_requests_total',
    help: 'Total search requests by type',
    labelNames: ['type'],
    registers: [register],
  });

  const indexQueueDepth = new Gauge<never>({
    name: 'cognivault_index_queue_depth',
    help: 'Number of files pending in the indexing queue',
    registers: [register],
  });

  const staleVectorCleanups = new Counter<never>({
    name: 'cognivault_stale_vector_cleanups_total',
    help: 'Number of stale vectors cleaned from Qdrant',
    registers: [register],
  });

  fastify.decorate('metrics', {
    searchDuration, searchRequests, indexQueueDepth, staleVectorCleanups,
  });

  fastify.get('/metrics', { config: { skipAuth: true } }, async (_request, reply) => {
    reply.header('Content-Type', register.contentType);
    return reply.send(await register.metrics());
  });
}

export default fp(metricsPlugin, { name: 'metrics', dependencies: [] });
```

**Instrument search routes** (in search/routes.ts):
```typescript
const end = fastify.metrics.searchDuration.startTimer({ type: 'semantic' });
const results = await searchService.semantic(query, limit, filters);
end();  // records duration automatically
fastify.metrics.searchRequests.inc({ type: 'semantic' });
```

**Histogram bucket guidance (Claude's Discretion):**
- `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]` seconds
- Rationale: search target is <1s; captures p50 (~25ms embedding+Qdrant), p95 (~250ms), p99 (~1s)

### Pattern 3: OpenTelemetry Tracing (INF-05)

**What:** Conditional SDK initialization in `server.ts` (before `buildApp()`). SDK setup in a separate `src/lib/tracing.ts` module. Manual spans in search routes and context routes via `@opentelemetry/api`.

**ESM Critical Note:** Node.js ESM requires the `--experimental-loader=@opentelemetry/instrumentation/hook.mjs` flag for auto-instrumentation to work. For compiled TypeScript (dist/*.js with ESM output), the loader is needed in the `start` script.

**tracing.ts module:**
```typescript
// Source: https://opentelemetry.io/docs/languages/js/exporters/
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | null = null;

export function initTracing(endpoint: string): void {
  sdk = new NodeSDK({
    resource: new Resource({ [ATTR_SERVICE_NAME]: 'cognivault' }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
}

export function shutdownTracing(): Promise<void> {
  return sdk?.shutdown() ?? Promise.resolve();
}
```

**server.ts integration:**
```typescript
import { config } from './config.js';
import { initTracing, shutdownTracing } from './lib/tracing.js';

// OTel MUST initialize before buildApp
if (config.OTEL_EXPORTER_OTLP_ENDPOINT) {
  initTracing(config.OTEL_EXPORTER_OTLP_ENDPOINT);
}

const app = await buildApp({ logger: true });
// ... listen ...
process.on('SIGTERM', async () => { await app.close(); await shutdownTracing(); });
```

**Manual spans in routes:**
```typescript
// Source: https://opentelemetry.io/docs/languages/js/instrumentation/
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('cognivault-search');

// In route handler:
return tracer.startActiveSpan('search.semantic', async (span) => {
  try {
    const results = await searchService.semantic(query, limit, filters);
    span.setAttribute('search.results_count', results.length);
    return results;
  } catch (err) {
    span.recordException(err as Error);
    throw err;
  } finally {
    span.end();
  }
});
```

**Trace ID injection into Pino (when tracing active):**
```typescript
// In onRequest hook (tracing plugin):
import { trace } from '@opentelemetry/api';

fastify.addHook('onRequest', async (request) => {
  const span = trace.getActiveSpan();
  if (span) {
    const traceId = span.spanContext().traceId;
    request.log = request.log.child({ traceId });
  }
});
```

**config.ts addition:**
```typescript
OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
```

**Package.json script update for ESM loader (production):**
```json
"start": "node --experimental-loader=@opentelemetry/instrumentation/hook.mjs --import ./dist/lib/tracing.js dist/server.js"
```
Note: loader is only needed when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. A wrapper script or conditional NODE_OPTIONS is appropriate.

### Pattern 4: Admin Reindex API (IDX-13)

**What:** Feature route at `src/features/admin/` with async job pattern. `VaultIndexer.start()` already runs the full scan and emits `changes` events — reindex triggers a fresh scan. Job state lives in a module-level `Map`.

**Scope dispatch logic:**
- `full`: call `indexer.stop()` then `indexer.start()` (resets poll cycle + triggers full scan)
- `path`: emit synthetic `['updated', path]` event via `indexer.emit('changes', [{ type: 'updated', path, contentHash: '' }])` — pipeline handles it
- `folder`: scan all indexed files matching folder prefix from SQLite, emit batch `updated` events

**In-memory job storage (Claude's Discretion):**
```typescript
interface ReindexJob {
  id: string;
  scope: 'full' | 'path' | 'folder';
  status: 'running' | 'completed' | 'failed';
  filesProcessed: number;
  totalFiles: number;
  errors: string[];
  startedAt: string;
  completedAt?: string;
}

const jobs = new Map<string, ReindexJob>();
```

**Route signatures:**
```
POST /api/admin/reindex
  Body: { scope: "full" } | { scope: "path", path: string } | { scope: "folder", folder: string }
  Response 202: { jobId: string, status: "running", message: string }

GET /api/admin/reindex/status
  Query: ?jobId=<uuid>
  Response 200: { jobId, status, filesProcessed, totalFiles, errors, startedAt, completedAt? }
```

**Auth:** Standard Bearer auth — NO `skipAuth: true`. These are write operations.

**TOON:** No special handling needed — TOON plugin applies to all non-health routes automatically.

### Anti-Patterns to Avoid

- **Double-registering prom-client metrics:** prom-client throws on duplicate metric names against the default global registry. Always use a custom `Registry` instance (`new Registry()`) and pass `registers: [register]` to each metric constructor. This avoids conflicts between tests and multiple `buildApp()` calls.
- **Global OTel singleton in tests:** `@opentelemetry/sdk-node` initialization is global and cannot be re-initialized per test. Keep `initTracing()` behind the `OTEL_EXPORTER_OTLP_ENDPOINT` guard and do not call it in test setups.
- **Calling `indexer.start()` without `stop()` for reindex:** The indexer schedules a poll timer in `finally` after each scan. Calling `start()` without `stop()` first will leave a dangling poll timer. Always `stop()` first, then `start()`.
- **Mutable metric labels at scrape time:** Do not dynamically add label combinations to Histograms after initialization. Pre-define all `type` values (`semantic`, `lexical`, `hybrid`) so Prometheus scrapes a stable metric family.
- **Using `--import` without ESM loader for OTel auto-instrumentation:** The `--import` flag alone does not hook into ESM module loading for patching. The `--experimental-loader=@opentelemetry/instrumentation/hook.mjs` flag is required alongside `--import` when auto-instrumentation is enabled.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Process/GC/event loop metrics | Custom perf_hooks instrumentation | `collectDefaultMetrics({ register })` in prom-client | prom-client handles GC hooks, perf_hooks, event loop lag with correct histogram buckets |
| Histogram timing | Manual `Date.now()` difference + observe | `histogram.startTimer()` returning end function | startTimer uses `process.hrtime.bigint()` for nanosecond precision |
| UUID generation for request IDs | Custom ID scheme | `randomUUID()` from `node:crypto` (already in project) | Already used in Phase 3 atomic writes; consistent with project patterns |
| OTLP protobuf serialization | Custom gRPC/proto code | `@opentelemetry/exporter-trace-otlp-http` | Handles HTTP/JSON OTLP transport, batching, retries |
| Request-scoped trace context | Manual context threading | `trace.getActiveSpan()` from `@opentelemetry/api` | OTel context propagation is async-context-aware via AsyncLocalStorage |

**Key insight:** prom-client and OTel each have significant edge-case complexity (GC hooks, async context propagation, OTLP batching) that makes custom implementations error-prone. Both are stable, well-typed, and actively maintained.

---

## Common Pitfalls

### Pitfall 1: prom-client Duplicate Registration in Tests

**What goes wrong:** Each `buildApp()` call in tests registers prom-client metrics against the same registry, throwing `Error: A metric with that name already exists`.

**Why it happens:** prom-client's default global registry persists across test runs within the same Vitest worker process.

**How to avoid:** Always use `new Registry()` (not the default registry). Pass `registers: [register]` to every metric constructor. In tests, the metrics plugin creates a fresh Registry per `buildApp()` call — no conflict.

**Warning signs:** `Error: A metric with that name already exists` in test output.

### Pitfall 2: OTel ESM Loader Not Applied in Production

**What goes wrong:** OTel auto-instrumentation silently does nothing — HTTP spans never appear in the trace backend.

**Why it happens:** Node.js ESM bypasses CommonJS `require()` hooks. OTel's patching mechanism relies on intercepting `require()`. Without `--experimental-loader=@opentelemetry/instrumentation/hook.mjs`, ESM imports are not intercepted.

**How to avoid:** Update `package.json` `start` script to include both flags when tracing is configured. For dev workflow (`pnpm dev`), set `NODE_OPTIONS` in the shell or `.env.local`.

**Warning signs:** Traces appear with no child spans from HTTP libraries; only manual spans are visible.

### Pitfall 3: Reindex Race Condition (Concurrent Jobs)

**What goes wrong:** Two simultaneous POST /api/admin/reindex calls both call `indexer.stop()` then `indexer.start()`, causing undefined behavior.

**Why it happens:** VaultIndexer has no concurrency guard for `start()` calls.

**How to avoid:** Check `indexer.isIndexing` before starting a new full reindex. Return 409 Conflict if a job is already running.

**Warning signs:** Multiple active job IDs in the job map with status `running`.

### Pitfall 4: Pino redact Path vs Fastify Logger Key

**What goes wrong:** `redact: ['authorization']` does not redact the header; only full path from the logged object works.

**Why it happens:** Pino's redact operates on the serialized object structure. Fastify's default req serializer places headers under `req.headers`. The correct path is `req.headers.authorization`.

**How to avoid:** Use `redact: ['req.headers.authorization']` exactly. Test by checking log output contains `[Redacted]` for the Authorization field.

**Warning signs:** Authorization header value appears in plain text in logs.

### Pitfall 5: OTel SDK Shutdown Not Awaited on SIGTERM

**What goes wrong:** Buffered spans are not flushed before process exit, causing trace gaps at the end of a run.

**Why it happens:** The BatchSpanProcessor holds spans in memory until the buffer is full or the flush interval fires. Process exit kills the buffer.

**How to avoid:** Await `sdk.shutdown()` in SIGTERM/SIGINT handlers before calling `process.exit()`.

**Warning signs:** Last few requests before shutdown have no traces.

---

## Code Examples

Verified patterns from official sources:

### Fastify Server Construction with Logging Enrichment

```typescript
// Source: https://fastify.dev/docs/latest/Reference/Server/ + https://fastify.dev/docs/latest/Reference/Logging/
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    redact: ['req.headers.authorization'],
  },
  requestIdHeader: 'x-request-id',
  genReqId: () => randomUUID(),
  requestIdLogLabel: 'reqId',
});

app.addHook('onSend', async (request, reply) => {
  reply.header('X-Request-ID', request.id);
});
```

### prom-client Histogram with Labels and startTimer

```typescript
// Source: GitHub siimon/prom-client README
import { Histogram, Registry } from 'prom-client';

const register = new Registry();
const searchDuration = new Histogram<'type'>({
  name: 'cognivault_search_duration_seconds',
  help: 'Search latency by type',
  labelNames: ['type'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

// In route handler:
const end = searchDuration.startTimer({ type: 'semantic' });
await doSearch();
end(); // records seconds since startTimer
```

### Conditional OTel Initialization (server.ts)

```typescript
// Source: https://opentelemetry.io/docs/languages/js/getting-started/nodejs/
import { config } from './config.js';

if (config.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const { initTracing } = await import('./lib/tracing.js');
  initTracing(config.OTEL_EXPORTER_OTLP_ENDPOINT);
}

const app = await buildApp({ logger: true });
```

### Manual Span with Error Recording

```typescript
// Source: https://opentelemetry.io/docs/languages/js/instrumentation/
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('cognivault');

async function searchWithSpan(query: string): Promise<Result[]> {
  return tracer.startActiveSpan('search.semantic', async (span) => {
    try {
      const results = await searchService.semantic(query, 10, {});
      span.setAttribute('search.results_count', results.length);
      span.setStatus({ code: SpanStatusCode.OK });
      return results;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}
```

### ReindexService: Full Scope

```typescript
// Pattern from VaultIndexer usage in plugins/indexer.ts
async function triggerFullReindex(
  fastify: FastifyInstance,
  job: ReindexJob,
): Promise<void> {
  const indexer = fastify.indexer;
  if (indexer.isIndexing) {
    throw new Error('Indexer already running');
  }
  indexer.stop();
  // Listen for pipeline completions to track progress
  indexer.once('changes', (events) => {
    job.totalFiles = events.length;
  });
  indexer.start();
  // Note: start() is non-blocking; job status updated via event listener
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Winston/Morgan for Node.js logging | Pino (already in use via Fastify) | ~2019 | Pino is 5x faster than Winston; structured JSON native |
| Manual Prometheus counters via promjs | prom-client with collectDefaultMetrics | ~2016 | Default metrics now include event loop lag, GC buckets |
| OpenCensus for distributed tracing | OpenTelemetry (unified standard) | 2021 | OTel is CNCF standard; OpenCensus deprecated |
| OTel auto-instrumentation via require() hook | ESM loader (`--experimental-loader`) | 2023 | CJS require patching does not apply to ESM imports |
| prom-client default global registry | Custom Registry per service instance | Best practice ~2020 | Prevents test pollution and multi-instance conflicts |

**Deprecated/outdated:**
- `prom-client` default global `register`: Still works but causes test pollution — always use `new Registry()`
- `@opentelemetry/exporter-jaeger`: Deprecated; use OTLP exporter targeting Jaeger's OTLP endpoint instead
- `--experimental-loader` flag: Will eventually be replaced by `module.register(...)` but `--experimental-loader` is stable for Node.js 22 as of 2026

---

## Open Questions

1. **OTel ESM loader in dev workflow**
   - What we know: `pnpm dev` uses `node --watch dist/server.js` without the OTel loader flags
   - What's unclear: Whether developers will need NODE_OPTIONS set in their shell for tracing to work in dev mode
   - Recommendation: Document in plan that tracing in dev requires `NODE_OPTIONS='--experimental-loader=@opentelemetry/instrumentation/hook.mjs'`; since tracing is optional (zero overhead when OTEL_EXPORTER_OTLP_ENDPOINT absent), this is acceptable

2. **Index queue depth metric accuracy**
   - What we know: `PQueue` in pipeline.ts has a `queue.size` property for pending tasks
   - What's unclear: Whether `fastify.metrics.indexQueueDepth` should be a Gauge polled periodically or set imperatively on each enqueue/dequeue
   - Recommendation: Set gauge imperatively in the pipeline's `onChanges` handler (`gauge.set(queue.size + queue.pending)`) — more accurate than polling

3. **Reindex scope: path vs folder — how to drive pipeline**
   - What we know: Pipeline processes `FileChangeEvent` objects from the `changes` event emitter; `VaultIndexer` is the event source
   - What's unclear: Whether emitting synthetic events directly on `fastify.indexer` is architecturally clean or whether a new `triggerReindex(paths: string[])` method on VaultIndexer is preferable
   - Recommendation: Add a `reindexPaths(paths: string[]): Promise<void>` method to VaultIndexer that hashes files and emits change events — cleaner than synthetic event injection from the route layer

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest ^4.0.18 |
| Config file | vitest.config.ts (or package.json vitest field) |
| Quick run command | `pnpm test -- --run src/features/admin/__tests__/routes.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INF-03 | X-Request-ID echoed in response header | unit | `pnpm test -- --run src/plugins/__tests__/logging.test.ts` | Wave 0 |
| INF-03 | Authorization header redacted from logs | unit | `pnpm test -- --run src/plugins/__tests__/logging.test.ts` | Wave 0 |
| INF-03 | UUID generated when X-Request-ID absent | unit | `pnpm test -- --run src/plugins/__tests__/logging.test.ts` | Wave 0 |
| INF-04 | /metrics returns 200 without auth | unit | `pnpm test -- --run src/plugins/__tests__/metrics.test.ts` | Wave 0 |
| INF-04 | /metrics contains cognivault_search_duration_seconds | unit | `pnpm test -- --run src/plugins/__tests__/metrics.test.ts` | Wave 0 |
| INF-04 | /metrics contains process default metrics | unit | `pnpm test -- --run src/plugins/__tests__/metrics.test.ts` | Wave 0 |
| INF-05 | initTracing not called when env var absent | unit | `pnpm test -- --run src/lib/__tests__/tracing.test.ts` | Wave 0 |
| INF-05 | Span attributes recorded on search operations | unit | `pnpm test -- --run src/lib/__tests__/tracing.test.ts` | Wave 0 |
| IDX-13 | POST /api/admin/reindex returns 202 with jobId | unit | `pnpm test -- --run src/features/admin/__tests__/routes.test.ts` | Wave 0 |
| IDX-13 | GET /api/admin/reindex/status returns job progress | unit | `pnpm test -- --run src/features/admin/__tests__/routes.test.ts` | Wave 0 |
| IDX-13 | Reindex requires API key (returns 401 without) | unit | `pnpm test -- --run src/features/admin/__tests__/routes.test.ts` | Wave 0 |
| IDX-13 | 409 returned when reindex already in progress | unit | `pnpm test -- --run src/features/admin/__tests__/routes.test.ts` | Wave 0 |

### Sampling Rate

- **Per task commit:** `pnpm test -- --run src/plugins/__tests__/metrics.test.ts src/features/admin/__tests__/routes.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/plugins/__tests__/logging.test.ts` — covers INF-03 (X-Request-ID behavior, Authorization redaction)
- [ ] `src/plugins/__tests__/metrics.test.ts` — covers INF-04 (/metrics endpoint, metric registration)
- [ ] `src/lib/__tests__/tracing.test.ts` — covers INF-05 (conditional init, span creation)
- [ ] `src/features/admin/__tests__/routes.test.ts` — covers IDX-13 (reindex API endpoints)
- [ ] `src/features/admin/` directory — routes.ts, schemas.ts, service.ts

---

## Sources

### Primary (HIGH confidence)

- Fastify docs — requestIdHeader, genReqId, requestIdLogLabel, Pino redact, onSend hook: https://fastify.dev/docs/latest/Reference/Server/ and https://fastify.dev/docs/latest/Reference/Logging/
- prom-client GitHub README — Registry, collectDefaultMetrics, Histogram, Counter, Gauge, ESM import: https://github.com/siimon/prom-client
- OpenTelemetry JS Exporters docs — OTLP HTTP exporter packages and config: https://opentelemetry.io/docs/languages/js/exporters/
- OpenTelemetry JS Instrumentation docs — manual spans, startActiveSpan, SpanStatusCode: https://opentelemetry.io/docs/languages/js/instrumentation/
- OpenTelemetry Node.js getting started — NodeSDK, instrumentation.ts pattern: https://opentelemetry.io/docs/languages/js/getting-started/nodejs/

### Secondary (MEDIUM confidence)

- ESM loader requirement for OTel auto-instrumentation verified across multiple sources: https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md and https://oneuptime.com/blog/post/2026-02-06-fix-otel-auto-instrumentation-nodejs-esm/view
- prom-client v15.1.3 as latest stable version with TypeScript generic labels: https://libraries.io/npm/prom-client (June 2024 release)
- onSend hook for X-Request-ID response header: https://github.com/fastify/fastify/discussions/4813

### Tertiary (LOW confidence)

- OTel `--experimental-loader` flag behavior on Node.js 22 specifically — only Node.js 20 explicitly documented; assumed compatible with Node.js 22 based on backwards compatibility

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — prom-client, OTel packages verified via npm/official docs; versions from npm registry
- Architecture: HIGH — based on existing codebase patterns (fp() plugins, skipAuth pattern, TypeBox schemas) directly observable in repo
- Pitfalls: HIGH for prom-client registry and Pino redact (directly verifiable); MEDIUM for OTel ESM loader (multiple sources agree but Node.js 22 specifics not explicitly confirmed)

**Research date:** 2026-03-12
**Valid until:** 2026-06-12 (OTel API is stable; prom-client v15 stable; Fastify 5 API stable)
