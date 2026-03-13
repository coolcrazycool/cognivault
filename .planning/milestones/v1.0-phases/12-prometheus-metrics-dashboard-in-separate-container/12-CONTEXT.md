# Phase 12: Prometheus Metrics Dashboard in Separate Container - Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Add Prometheus and Grafana as docker-compose services to scrape, store, and visualize CogniVault's existing `/metrics` endpoint. Includes provisioned dashboards, alerting rules, and new pipeline metrics in the service code. Does not change the CogniVault API surface or add new endpoints beyond extending the existing metrics collection.

</domain>

<decisions>
## Implementation Decisions

### Dashboard organization
- Three separate Grafana dashboards: Search, Indexing, System
- Auto-provisioned via JSON files + YAML datasource config loaded on Grafana startup (version-controlled, reproducible)
- Dark theme
- Default time range: last 6 hours
- Auto-refresh: every 30 seconds

### Search dashboard
- Detailed breakdown: 6-8 panels
- Latency p50/p95/p99 by search type (semantic, lexical, hybrid)
- Latency heatmap (Y-axis = latency buckets, color = request count per bucket over time)
- Request volume heatmap by search type
- Request rate and error rate panels
- HTTP overview row at top: total requests, status code breakdown, response time

### Indexing dashboard
- Full pipeline view: queue depth, stale cleanup rate, embedding call counts, chunk throughput, reindex job status
- Requires adding new metrics to CogniVault service code: `cognivault_embedding_requests_total`, `cognivault_chunks_processed_total`, `cognivault_pipeline_duration_seconds`

### System dashboard
- Full Node.js runtime view: CPU, memory (RSS/heap), GC pause times, event loop lag, active handles/requests, uptime
- Uses prom-client `collectDefaultMetrics()` output

### Alerting rules
- Prometheus alert rules (not Alertmanager) — visible as Grafana annotations on panels
- Alert conditions:
  - Service down (target unreachable)
  - High memory usage
  - Search latency p99 > 2 seconds sustained over 5 minutes
  - High error rate
- No Alertmanager container — no external notification routing

### Persistence & retention
- Prometheus retention: 7 days
- Named Docker volumes for both Prometheus (`prometheus_data`) and Grafana (`grafana_data`) — survive container restarts
- Prometheus scrape interval: 15 seconds (standard default)
- Pre-configured Prometheus datasource via Grafana provisioning YAML — zero manual setup

### Access & networking
- Grafana exposed on port 3001 — anonymous access, no login required
- Prometheus exposed on port 9090 — direct PromQL queries and target status
- All services in the existing docker-compose.yml (not a separate file)
- Prometheus scrapes CogniVault's `/metrics` endpoint via docker network

### Claude's Discretion
- Exact panel dimensions and row layout within each dashboard
- Specific PromQL expressions for alert thresholds (memory, error rate)
- Grafana dashboard UIDs and folder organization
- Prometheus container image version selection
- Grafana container image version selection
- Exact histogram bucket boundaries for new pipeline metrics

</decisions>

<specifics>
## Specific Ideas

- REQUIREMENTS.md explicitly states: "UI/admin dashboard — API-first; use Grafana for visualization" — this phase delivers on that
- Phase 11 established the `/metrics` endpoint as unauthenticated (infrastructure access pattern) — Prometheus scrapes without auth headers
- Existing metrics use `cognivault_` prefix consistently — new metrics follow same convention
- Dashboards should be check-in-able config files under a `monitoring/` directory (Prometheus config, Grafana provisioning, dashboard JSON)

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/plugins/metrics.ts`: Per-instance prom-client Registry with 4 custom metrics + collectDefaultMetrics
- `/metrics` route with `skipAuth: true` config — Prometheus can scrape without API key
- `docker-compose.yml`: Existing service definitions for cognivault + qdrant with named volumes pattern

### Established Patterns
- prom-client per-instance Registry (not global default) — avoids test pollution
- Docker healthcheck pattern: `CMD-SHELL` with bash test (see qdrant service)
- Named volumes declared in top-level `volumes:` block
- Service dependency via `depends_on` with `condition: service_healthy`

### Integration Points
- `docker-compose.yml`: Add prometheus + grafana services, named volumes, network connectivity
- `src/plugins/metrics.ts`: Add new pipeline metrics (embedding_requests_total, chunks_processed_total, pipeline_duration_seconds)
- `src/plugins/indexer.ts` or pipeline plugin: Instrument embedding and chunk processing with new metrics
- New `monitoring/` directory: Prometheus config, alert rules, Grafana provisioning YAML, dashboard JSON files

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 12-prometheus-metrics-dashboard-in-separate-container*
*Context gathered: 2026-03-12*
