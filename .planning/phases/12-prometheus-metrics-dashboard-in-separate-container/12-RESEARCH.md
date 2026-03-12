# Phase 12: Prometheus Metrics Dashboard in Separate Container - Research

**Researched:** 2026-03-12
**Domain:** Prometheus + Grafana observability stack, Docker Compose service composition, prom-client instrumentation
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Dashboard organization**
- Three separate Grafana dashboards: Search, Indexing, System
- Auto-provisioned via JSON files + YAML datasource config loaded on Grafana startup (version-controlled, reproducible)
- Dark theme
- Default time range: last 6 hours
- Auto-refresh: every 30 seconds

**Search dashboard**
- Detailed breakdown: 6-8 panels
- Latency p50/p95/p99 by search type (semantic, lexical, hybrid)
- Latency heatmap (Y-axis = latency buckets, color = request count per bucket over time)
- Request volume heatmap by search type
- Request rate and error rate panels
- HTTP overview row at top: total requests, status code breakdown, response time

**Indexing dashboard**
- Full pipeline view: queue depth, stale cleanup rate, embedding call counts, chunk throughput, reindex job status
- Requires adding new metrics to CogniVault service code: `cognivault_embedding_requests_total`, `cognivault_chunks_processed_total`, `cognivault_pipeline_duration_seconds`

**System dashboard**
- Full Node.js runtime view: CPU, memory (RSS/heap), GC pause times, event loop lag, active handles/requests, uptime
- Uses prom-client `collectDefaultMetrics()` output

**Alerting rules**
- Prometheus alert rules (not Alertmanager) — visible as Grafana annotations on panels
- Alert conditions: service down, high memory usage, search latency p99 > 2s over 5 min, high error rate
- No Alertmanager container

**Persistence & retention**
- Prometheus retention: 7 days (`--storage.tsdb.retention.time=7d`)
- Named Docker volumes: `prometheus_data`, `grafana_data`
- Prometheus scrape interval: 15 seconds
- Pre-configured Prometheus datasource via Grafana provisioning YAML

**Access & networking**
- Grafana on port 3001, anonymous access (no login)
- Prometheus on port 9090
- All services in the existing `docker-compose.yml`
- Prometheus scrapes CogniVault `/metrics` via docker network

### Claude's Discretion
- Exact panel dimensions and row layout within each dashboard
- Specific PromQL expressions for alert thresholds (memory, error rate)
- Grafana dashboard UIDs and folder organization
- Prometheus container image version selection
- Grafana container image version selection
- Exact histogram bucket boundaries for new pipeline metrics

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

---

## Summary

Phase 12 adds Prometheus and Grafana as docker-compose services to visualize CogniVault's existing `/metrics` endpoint. The work has two distinct parts: (1) infrastructure — Docker Compose service definitions for Prometheus and Grafana with provisioned config files under a `monitoring/` directory, and (2) code — three new pipeline metrics added to `src/plugins/metrics.ts` and instrumented in `src/plugins/pipeline.ts`.

The existing codebase already has strong foundations: `src/plugins/metrics.ts` uses a per-instance prom-client Registry with four custom metrics plus `collectDefaultMetrics()`, the `/metrics` route skips auth so Prometheus can scrape without API keys, and `docker-compose.yml` already follows the named-volume and `depends_on` patterns needed for the new services.

The monitoring infrastructure is pure configuration (no TypeScript changes for Prometheus/Grafana themselves). The key risk areas are (1) Grafana v12 anonymous access env var names, which differ slightly from older versions, and (2) heatmap panel PromQL format requirements for Prometheus histograms, which require the `sum by (le)` grouping pattern.

**Primary recommendation:** Implement in three logical tasks — (1) new pipeline metrics in `metrics.ts` + instrumentation in `pipeline.ts`, (2) Prometheus service + config + alert rules, (3) Grafana service + provisioning + three dashboard JSON files.

## Standard Stack

### Core
| Library / Image | Version | Purpose | Why Standard |
|----------------|---------|---------|--------------|
| `prom/prometheus` | v3.10.0 | Time-series metrics store + alerting rules | Official image; 3.x is current stable (released 2026-02-24) |
| `grafana/grafana` | 12.3.2 | Dashboard visualization + provisioning | Official image; 12.x is current stable (released 2026-01-27) |
| `prom-client` | existing (already installed) | Expose metrics from Node.js | Already in use — no new dependency |

### Supporting
| Tool | Version | Purpose | When to Use |
|------|---------|---------|-------------|
| Docker named volumes | N/A | Persist Prometheus + Grafana data | Always — survive container restarts |
| Grafana provisioning YAML | N/A | Zero-touch datasource + dashboard setup | Always — eliminates manual UI config |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `prom/prometheus:v3.10.0` | `prom/prometheus:latest` | Pinning avoids surprise upgrades; v3 is current stable |
| `grafana/grafana:12.3.2` | `grafana/grafana:latest` | Pinning preferred for reproducibility |
| Alertmanager for routing | No Alertmanager | User locked decision: rules only, no external notification routing |

**Installation:** No new npm packages. Docker images pulled automatically by docker-compose.

## Architecture Patterns

### Recommended Directory Structure
```
monitoring/
├── prometheus/
│   ├── prometheus.yml          # Global config + scrape jobs
│   └── rules/
│       └── cognivault.yml      # Alerting rules (no Alertmanager)
└── grafana/
    └── provisioning/
        ├── datasources/
        │   └── prometheus.yml  # Pre-configure Prometheus datasource
        └── dashboards/
            ├── dashboards.yml  # Dashboard provider (path pointer)
            ├── search.json     # Search dashboard
            ├── indexing.json   # Indexing dashboard
            └── system.json     # System/Node.js dashboard
```

All files under `monitoring/` are bind-mounted into containers at startup. No dashboards or datasources need to be created via the Grafana UI.

### Pattern 1: Grafana Datasource Provisioning
**What:** YAML file loaded at Grafana startup configures the Prometheus datasource automatically.
**When to use:** Always — eliminates "first-run" manual setup.

```yaml
# monitoring/grafana/provisioning/datasources/prometheus.yml
# Source: https://grafana.com/docs/grafana/latest/administration/provisioning/
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    uid: prometheus
    url: http://prometheus:9090
    isDefault: true
    editable: false
```

### Pattern 2: Grafana Dashboard Provider Provisioning
**What:** YAML file tells Grafana to load all JSON files from a directory.
**When to use:** Always — enables version-controlled dashboard JSON files.

```yaml
# monitoring/grafana/provisioning/dashboards/dashboards.yml
# Source: https://grafana.com/docs/grafana/latest/administration/provisioning/
apiVersion: 1
providers:
  - name: CogniVault
    orgId: 1
    type: file
    disableDeletion: true
    updateIntervalSeconds: 30
    allowUiUpdates: false
    options:
      path: /var/lib/grafana/dashboards
```

The dashboard JSON files are mounted to `/var/lib/grafana/dashboards` in the container.

### Pattern 3: Prometheus Configuration
**What:** `prometheus.yml` defines global scrape settings and the CogniVault scrape job.
**When to use:** Required configuration for all Prometheus deployments.

```yaml
# monitoring/prometheus/prometheus.yml
# Source: https://prometheus.io/docs/prometheus/latest/configuration/configuration/
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - /etc/prometheus/rules/*.yml

scrape_configs:
  - job_name: cognivault
    static_configs:
      - targets: ['cognivault:3000']
    metrics_path: /metrics
```

The `cognivault` hostname resolves via the docker network. The `/metrics` endpoint is unauthenticated (Phase 11 decision), so no bearer token config is needed.

### Pattern 4: Prometheus Alerting Rules (No Alertmanager)
**What:** Alert rules fire in Prometheus and appear as Grafana annotations; no external routing.
**When to use:** Lightweight alerting without notification infrastructure.

```yaml
# monitoring/prometheus/rules/cognivault.yml
# Source: https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/
groups:
  - name: cognivault
    rules:
      - alert: CogniVaultDown
        expr: up{job="cognivault"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "CogniVault service unreachable"

      - alert: HighSearchLatencyP99
        expr: >
          histogram_quantile(0.99,
            sum(rate(cognivault_search_duration_seconds_bucket[5m])) by (le, type)
          ) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Search p99 latency exceeds 2s for {{ $labels.type }}"

      - alert: HighMemoryUsage
        expr: process_resident_memory_bytes{job="cognivault"} > 512 * 1024 * 1024
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "CogniVault RSS memory exceeds 512 MiB"

      - alert: HighErrorRate
        expr: >
          sum(rate(cognivault_search_requests_total{type="error"}[5m])) /
          sum(rate(cognivault_search_requests_total[5m])) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Error rate exceeds 5%"
```

Note: Alert thresholds for memory and error rate are at Claude's discretion. The 512 MiB and 5% values shown are reasonable defaults.

### Pattern 5: docker-compose Service Definitions
**What:** Add prometheus and grafana services to the existing `docker-compose.yml`.
**When to use:** All services must be in the existing file (locked decision).

```yaml
  prometheus:
    image: prom/prometheus:v3.10.0
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.retention.time=7d'
      - '--storage.tsdb.path=/prometheus'
    ports:
      - "9090:9090"
    volumes:
      - ./monitoring/prometheus:/etc/prometheus:ro
      - prometheus_data:/prometheus
    depends_on:
      cognivault:
        condition: service_healthy

  grafana:
    image: grafana/grafana:12.3.2
    ports:
      - "3001:3000"
    environment:
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_NAME=Main Org.
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer
      - GF_AUTH_DISABLE_LOGIN_FORM=true
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - ./monitoring/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./monitoring/grafana/dashboards:/var/lib/grafana/dashboards:ro
      - grafana_data:/var/lib/grafana
    depends_on:
      - prometheus

volumes:
  qdrant_data:
  prometheus_data:
  grafana_data:
```

Note: The cognivault service needs a `healthcheck` added for the `depends_on condition: service_healthy` pattern to work. Use the existing `/health` endpoint.

### Pattern 6: New Pipeline Metrics in metrics.ts
**What:** Add three new prom-client metrics to the existing `MetricsCollection` interface.

```typescript
// Source: existing pattern in src/plugins/metrics.ts
const embeddingRequests = new Counter({
  name: 'cognivault_embedding_requests_total',
  help: 'Total number of embedding API calls made',
  registers: [register],
});

const chunksProcessed = new Counter({
  name: 'cognivault_chunks_processed_total',
  help: 'Total number of chunks processed through the pipeline',
  registers: [register],
});

const pipelineDuration = new Histogram({
  name: 'cognivault_pipeline_duration_seconds',
  help: 'Duration of full pipeline processing per file in seconds',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});
```

These are incremented in `src/plugins/pipeline.ts` — specifically in `embedAndUpsert()` for embedding calls and chunk counts, and wrapping `processCreatedOrUpdated()` for pipeline duration.

### Pattern 7: PromQL for Heatmap Panels
**What:** Prometheus histograms require a specific PromQL grouping pattern for Grafana heatmap panels.

```promql
# For a latency heatmap by search type (le = bucket upper bound)
sum(increase(cognivault_search_duration_seconds_bucket[$__interval])) by (le)
```

The Grafana panel type is "Heatmap". The critical setting: "Format" must be set to "Time series buckets" (not "Time series"). The legend format must be `{{le}}` for Y-axis to render bucket boundaries correctly.

### Anti-Patterns to Avoid
- **Using `grafana/grafana-oss` image**: Starting with Grafana 12.4.0, `grafana/grafana-oss` on Docker Hub will no longer be updated. Use `grafana/grafana` (the OSS image is now consolidated there).
- **Using global prom-client Registry for new metrics**: The project uses per-instance Registry (not `register` from `prom-client` default export). New metrics must pass `registers: [register]` explicitly.
- **Scraping `localhost` from Prometheus**: Prometheus containers cannot reach `localhost:3000` — use the docker service name `cognivault:3000`.
- **Bind-mounting dashboard JSON to `/etc/grafana/provisioning/dashboards/`**: Dashboard JSON files go in a separate directory (e.g., `/var/lib/grafana/dashboards`). The `/etc/grafana/provisioning/dashboards/` path is for the provider YAML only, not the JSON files themselves.
- **Setting `allowUiUpdates: true` in dashboard provider**: Dashboard changes made in UI are lost on container restart. Keep `false` to enforce config-as-code.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Time-series storage | Custom SQLite metrics log | `prom/prometheus` | Efficient TSDB, built-in retention, PromQL |
| Dashboard visualization | Custom HTML/JS charts | Grafana dashboard JSON | Full-featured, heatmaps, annotations, provisioning |
| Alerting rule evaluation | Custom Node.js alert cron | Prometheus `rule_files` | Integrated with metrics evaluation loop |
| Zero-config datasource setup | Admin API scripting | Grafana provisioning YAML | First-class supported, file-based, version-controllable |
| Metric name generation | Custom serialization format | prom-client (existing) | Already integrated, registry-aware, text/protobuf format |

**Key insight:** The monitoring stack is pure configuration. The only TypeScript code changes are the three new metric definitions in `metrics.ts` and the increment/observe calls in `pipeline.ts`.

## Common Pitfalls

### Pitfall 1: Cognivault Service Missing Healthcheck
**What goes wrong:** `depends_on: condition: service_healthy` for Prometheus fails at startup because cognivault has no Docker healthcheck defined.
**Why it happens:** The existing docker-compose.yml has no healthcheck on the cognivault service (unlike qdrant).
**How to avoid:** Add a healthcheck to the cognivault service before adding `depends_on` on it:
```yaml
healthcheck:
  test: ["CMD-SHELL", "wget -qO- http://localhost:3000/health || exit 1"]
  interval: 10s
  timeout: 5s
  retries: 5
```
Note: The cognivault image is `node:22-slim` based — check whether wget or curl is available. Alternative: use `node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode===200?0:1))"`.

### Pitfall 2: Grafana Anonymous Access Requires Org Name Match
**What goes wrong:** Grafana returns login page even with `GF_AUTH_ANONYMOUS_ENABLED=true`.
**Why it happens:** `GF_AUTH_ANONYMOUS_ORG_NAME` must exactly match an existing Grafana organization name. The default org is `Main Org.` (with a period).
**How to avoid:** Set `GF_AUTH_ANONYMOUS_ORG_NAME=Main Org.` (note the period) or leave it unset to use the default.
**Warning signs:** Browser redirects to `/login` on first visit.

### Pitfall 3: Dashboard JSON Not Loaded
**What goes wrong:** Grafana starts but dashboards show "No dashboards found."
**Why it happens:** Dashboard JSON files are mounted to the wrong path, or the provider YAML `options.path` doesn't match the mount target.
**How to avoid:** Mount JSON files to `/var/lib/grafana/dashboards`, mount provider YAML to `/etc/grafana/provisioning/dashboards/`, and set `options.path: /var/lib/grafana/dashboards` in the provider YAML.
**Warning signs:** `docker exec grafana ls /var/lib/grafana/dashboards` shows empty or files don't appear.

### Pitfall 4: Heatmap Panel Empty or Flat
**What goes wrong:** Heatmap panel shows no data or a single flat band.
**Why it happens:** Prometheus histograms are cumulative. Grafana needs `increase()` or `rate()` per bucket, grouped by `le`. Using raw `_bucket` values without rate gives ever-increasing numbers; the heatmap interprets them incorrectly.
**How to avoid:** Use `sum(increase(metric_bucket[$__interval])) by (le)`. Set panel Data format to "Time series buckets". Set legend format to `{{le}}`.

### Pitfall 5: Per-Instance Registry vs Default Registry
**What goes wrong:** New pipeline metrics appear in test output mixed with previous test runs (test pollution).
**Why it happens:** Using `import { register } from 'prom-client'` (the global default) instead of the per-instance Registry created in `metricsPlugin`.
**How to avoid:** All new metrics must be initialized inside `metricsPlugin` with `registers: [register]` where `register` is the locally created `new Registry()`. Match the existing pattern in `src/plugins/metrics.ts` exactly.

### Pitfall 6: Prometheus Healthcheck Method
**What goes wrong:** Prometheus container healthcheck fails if using wget/curl because busybox may not have them.
**Why it happens:** `prom/prometheus:v3.x` uses busybox base image. The qdrant healthcheck pattern (`bash -c 'echo > /dev/tcp/...'`) won't work because Prometheus busybox may not have bash.
**How to avoid:** Use `wget -qO- http://localhost:9090/-/healthy` (busybox wget is available) or use the distroless variant with a different healthcheck approach.

## Code Examples

### New Metrics Declaration in metrics.ts
```typescript
// Source: existing pattern in src/plugins/metrics.ts
// Add to MetricsCollection interface:
interface MetricsCollection {
  searchDuration: Histogram<'type'>;
  searchRequests: Counter<'type'>;
  indexQueueDepth: Gauge;
  staleVectorCleanups: Counter;
  embeddingRequests: Counter;       // NEW
  chunksProcessed: Counter;         // NEW
  pipelineDuration: Histogram;      // NEW
}

// Inside metricsPlugin():
const embeddingRequests = new Counter({
  name: 'cognivault_embedding_requests_total',
  help: 'Total number of embedding API calls made to OpenAI',
  registers: [register],
});

const chunksProcessed = new Counter({
  name: 'cognivault_chunks_processed_total',
  help: 'Total number of text chunks processed through the indexing pipeline',
  registers: [register],
});

const pipelineDuration = new Histogram({
  name: 'cognivault_pipeline_duration_seconds',
  help: 'End-to-end duration of file processing through the indexing pipeline',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});
```

### Instrumentation in pipeline.ts (embedAndUpsert)
```typescript
// In embedAndUpsert() after fastify.embedder.embed() call:
fastify.metrics.embeddingRequests.inc();
fastify.metrics.chunksProcessed.inc(chunks.length);

// Wrapping processCreatedOrUpdated with timer:
const end = fastify.metrics.pipelineDuration.startTimer();
try {
  await processCreatedOrUpdated(fastify, event);
} finally {
  end();
}
```

### PromQL Patterns for Dashboards

```promql
# p99 search latency by type (Search dashboard)
histogram_quantile(0.99,
  sum(rate(cognivault_search_duration_seconds_bucket[5m])) by (le, type)
)

# Request rate by type
sum(rate(cognivault_search_requests_total[5m])) by (type)

# Latency heatmap (group by le only for heatmap panel)
sum(increase(cognivault_search_duration_seconds_bucket[$__interval])) by (le)

# Index queue depth (Indexing dashboard)
cognivault_index_queue_depth

# Stale cleanup rate
rate(cognivault_stale_vector_cleanups_total[5m])

# Embedding call rate
rate(cognivault_embedding_requests_total[5m])

# Chunk throughput
rate(cognivault_chunks_processed_total[5m])

# Pipeline duration p95
histogram_quantile(0.95,
  sum(rate(cognivault_pipeline_duration_seconds_bucket[5m])) by (le)
)

# Node.js RSS memory (System dashboard)
process_resident_memory_bytes{job="cognivault"}

# Node.js heap used
nodejs_heap_size_used_bytes{job="cognivault"}

# Event loop lag
nodejs_eventloop_lag_seconds{job="cognivault"}

# GC pause time p99
histogram_quantile(0.99,
  rate(nodejs_gc_duration_seconds_bucket{job="cognivault"}[5m])
)

# Active handles
nodejs_active_handles{job="cognivault"}

# Process uptime
time() - process_start_time_seconds{job="cognivault"}
```

### Grafana Dashboard JSON Structure (minimal skeleton)
```json
{
  "uid": "cognivault-search",
  "title": "CogniVault Search",
  "tags": ["cognivault"],
  "style": "dark",
  "timezone": "browser",
  "refresh": "30s",
  "time": {
    "from": "now-6h",
    "to": "now"
  },
  "panels": [],
  "schemaVersion": 36
}
```

The `"style": "dark"` field sets the dark theme. The `"refresh": "30s"` and `"time"` fields set auto-refresh and default time range (locked decisions).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `grafana/grafana-oss` Docker Hub image | `grafana/grafana` (unified) | Grafana 12.4.0+ | Use `grafana/grafana` — oss repo stops receiving updates |
| Prometheus 2.x | Prometheus 3.x (3.10.0 current) | Feb 2026 | 3.x is the current stable train; busybox base image preserved |
| Alertmanager required for all alerts | Alerts fire in Prometheus, viewed in Grafana | Always supported | No Alertmanager needed for visibility-only alerting |
| Manual Grafana datasource setup | Provisioning YAML loaded at startup | Grafana 5.0+ | Zero manual steps on fresh container |

**Deprecated/outdated:**
- `grafana/grafana-oss` Docker Hub tag: Stop receiving updates after Grafana 12.4.0. Use `grafana/grafana` instead (MEDIUM confidence — based on January 2026 announcement).
- Prometheus 2.x: Still maintained but 3.x is current stable. No breaking changes for this use case.

## Open Questions

1. **Cognivault Docker image: wget or curl availability**
   - What we know: The production Dockerfile is multi-stage with `node:22-slim` final stage. Slim images often omit wget and curl.
   - What's unclear: Whether the built image has wget/curl for healthcheck use, or whether the Node.js `http.get` approach is needed.
   - Recommendation: Use `node -e "..."` healthcheck to avoid the dependency: `CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"`.

2. **Grafana 12.x anonymous access behavior for provisioned dashboards**
   - What we know: A GitHub issue (#80351) was filed in 2024 about provisioned dashboards not being available with anonymous access. Status of fix in 12.x is unclear.
   - What's unclear: Whether `GF_AUTH_DISABLE_LOGIN_FORM=true` combined with anonymous access fully exposes provisioned dashboards in Grafana 12.
   - Recommendation: Test with `docker-compose up` in Wave 0 or Wave 1 smoke test. If dashboards don't appear, set `GF_SECURITY_ALLOW_EMBEDDING=true` and verify org name matches exactly.

3. **Error rate alert PromQL**
   - What we know: Current metrics track `cognivault_search_requests_total{type}` but "error" is not a valid type label value (types are semantic/lexical/hybrid).
   - What's unclear: There is no current HTTP error rate counter distinct from search types.
   - Recommendation: The error rate alert should use HTTP default metrics (`http_request_duration_seconds_count` with status labels if Fastify exposes them) or be based on Prometheus's `up` metric + log-derived alerts. Since prom-client `collectDefaultMetrics()` doesn't provide per-status-code HTTP counters by default, the high error rate alert may need to be scoped to "search errors" or deferred. Simplest: alert on `rate(cognivault_search_requests_total[5m]) == 0` for zero traffic (service frozen) as a proxy.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (existing) |
| Config file | `vitest.config.ts` |
| Quick run command | `pnpm test -- --run src/plugins/__tests__/metrics.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements to Test Map

| Behavior | Test Type | Automated Command | Notes |
|----------|-----------|-------------------|-------|
| New metrics appear in `/metrics` output | unit | `pnpm test -- --run src/plugins/__tests__/metrics.test.ts` | Extend existing metrics test |
| `embeddingRequests` increments on embed call | unit | `pnpm test -- --run src/plugins/__tests__/pipeline.test.ts` | Extend existing pipeline test |
| `chunksProcessed` increments by chunk count | unit | `pnpm test -- --run src/plugins/__tests__/pipeline.test.ts` | Extend existing pipeline test |
| `pipelineDuration` observes timing | unit | `pnpm test -- --run src/plugins/__tests__/pipeline.test.ts` | Extend existing pipeline test |
| Prometheus + Grafana services start | smoke | `docker-compose up -d prometheus grafana` (manual) | Manual-only: requires Docker |
| Grafana anonymous access works | smoke | `curl http://localhost:3001/api/health` (manual) | Manual-only: requires Docker |
| Prometheus scrapes cognivault | smoke | `curl http://localhost:9090/api/v1/targets` (manual) | Manual-only: requires Docker |

### Sampling Rate
- **Per task commit:** `pnpm test -- --run src/plugins/__tests__/metrics.test.ts src/plugins/__tests__/pipeline.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green + manual Docker smoke test before `/gsd:verify-work`

### Wave 0 Gaps
- None for test files — existing `metrics.test.ts` and `pipeline.test.ts` will be extended, not created from scratch.
- Docker smoke tests are manual, not automated — document in verification checklist.

## Sources

### Primary (HIGH confidence)
- Prometheus official docs — scrape_configs, alerting rules YAML syntax, retention flags
- Grafana official provisioning docs — datasource YAML structure, dashboard provider YAML structure
- `prom/prometheus` Docker Hub — v3.10.0 is current stable (released 2026-02-24)
- `grafana/grafana` Docker Hub — 12.3.2 is current stable (released 2026-01-27)
- Existing `src/plugins/metrics.ts` — per-instance Registry pattern, current metric names
- Existing `docker-compose.yml` — named volume pattern, service healthcheck pattern
- Existing `src/plugins/pipeline.ts` — embedAndUpsert instrumentation points

### Secondary (MEDIUM confidence)
- WebSearch: Grafana anonymous access env vars (`GF_AUTH_ANONYMOUS_ENABLED=true`, `GF_AUTH_ANONYMOUS_ORG_NAME`) — cross-referenced with official docs
- WebSearch: Prometheus `--storage.tsdb.retention.time=7d` flag in docker-compose command array — standard pattern confirmed across multiple sources
- WebSearch: Heatmap PromQL pattern `sum(increase(bucket[$__interval])) by (le)` — confirmed in Grafana fundamentals docs

### Tertiary (LOW confidence)
- WebSearch: Grafana 12.x anonymous access issue with provisioned dashboards (GitHub issue #80351) — behavior in 12.3.2 not directly verified
- WebSearch: `grafana/grafana-oss` deprecation timeline after 12.4.0 — based on search result claim, not verified against official release notes

## Metadata

**Confidence breakdown:**
- Standard stack (Prometheus + Grafana versions): HIGH — verified from Docker Hub via WebSearch
- Architecture (provisioning patterns, scrape config, alert rule YAML): HIGH — verified from official docs
- New prom-client metrics (counter/histogram instrumentation): HIGH — exact same pattern as existing code
- PromQL expressions (p50/p95/p99, heatmap format): HIGH — verified from official Grafana histogram docs
- Grafana anonymous access env vars: MEDIUM — confirmed in multiple WebSearch sources; exact behavior in 12.3.2 flagged as open question
- Docker healthcheck for cognivault: LOW — depends on final image contents not directly inspected

**Research date:** 2026-03-12
**Valid until:** 2026-04-12 (Grafana/Prometheus release cadence is fast; pin versions to avoid drift)
