---
phase: 12-prometheus-metrics-dashboard-in-separate-container
plan: "03"
subsystem: infra
tags: [grafana, prometheus, dashboards, monitoring, prom-client, timeseries, heatmap]

# Dependency graph
requires:
  - phase: 12-01
    provides: "cognivault_embedding_requests_total, cognivault_chunks_processed_total, cognivault_pipeline_duration_seconds metrics instrumented in indexer"
  - phase: 12-02
    provides: "Grafana provisioning config with datasource uid 'prometheus' and dashboard provider watching /var/lib/grafana/dashboards"
provides:
  - "search.json: 11-panel Search dashboard with HTTP overview, latency p50/p95/p99 by type, latency heatmap, request rate, volume heatmap, error rate annotation"
  - "system.json: 7-panel System dashboard with CPU, memory RSS, heap used/total, GC pause p99, event loop lag, active handles/requests, uptime"
  - "indexing.json: 8-panel Indexing dashboard with queue depth, stale cleanup rate, embedding call rate, chunk throughput, pipeline duration p50/p95, total counters, reindex status"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Grafana dashboard JSON with schemaVersion 39, uid for stable provisioning references"
    - "Prometheus datasource uid 'prometheus' throughout for stable auto-provisioned reference"
    - "Row panels as logical section separators in 24-column grid layout"
    - "Heatmap format='heatmap' with $__interval for Prometheus bucket data"
    - "clamp_max() to convert queue depth gauge to binary active/idle stat indicator"

key-files:
  created:
    - monitoring/grafana/dashboards/search.json
    - monitoring/grafana/dashboards/system.json
    - monitoring/grafana/dashboards/indexing.json
  modified: []

key-decisions:
  - "Search error rate panel implemented as markdown text annotation — prom-client collectDefaultMetrics lacks HTTP status_code labels; accurate error counting deferred to future counter with status label"
  - "Search dashboard uses Row panels (11 total panels including 3 row headers) to organize HTTP Overview, Latency, and Volume sections"
  - "Reindex Status panel uses clamp_max(queue_depth, 1) mapped to 0=Idle/1=Busy to give boolean job status without a dedicated boolean metric"
  - "Latency heatmap uses format='heatmap' with $__interval variable for proper Grafana bucket visualization"

patterns-established:
  - "Dashboard JSON: uid field required for stable provisioning; style=dark, refresh=30s, time.from=now-6h are project standard"
  - "All panel datasource refs use explicit object: { type: 'prometheus', uid: 'prometheus' }"

requirements-completed: [MON-06, MON-07, MON-08]

# Metrics
duration: 3min
completed: 2026-03-12
---

# Phase 12 Plan 03: Grafana Dashboard JSON Files Summary

**Three auto-provisioned Grafana dashboards covering search latency percentiles with heatmaps, indexing pipeline throughput, and Node.js runtime metrics via prom-client default metrics**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-12T14:41:59Z
- **Completed:** 2026-03-12T14:45:33Z
- **Tasks:** 3 of 3
- **Files modified:** 3

## Accomplishments

- Search dashboard with 11 panels: HTTP overview (total requests stat, requests-by-type pie, avg response time stat), latency section (p50/p95/p99 by search type timeseries + latency heatmap), volume section (request rate by type + volume heatmap + error rate text annotation)
- System dashboard with 7 panels: CPU user+system timeseries, memory RSS, heap used vs total, GC pause p99, event loop lag, active handles/requests, uptime stat — all using job="cognivault" label filter
- Indexing dashboard with 8 panels: queue depth timeseries, stale cleanup rate, embedding API call rate, chunk throughput, pipeline duration p50/p95, total embedding calls stat, total chunks processed stat, reindex status binary indicator

## Task Commits

Each task was committed atomically:

1. **Task 1: Create Search and System dashboard JSON files** - `d54fae5` (feat)
2. **Task 2: Create Indexing dashboard JSON file** - `31306d9` (feat)
3. **Task 3: Verify monitoring stack end-to-end** - approved by orchestrator (static verification)

## Files Created/Modified

- `monitoring/grafana/dashboards/search.json` - Search performance dashboard, 11 panels, uid=cognivault-search
- `monitoring/grafana/dashboards/system.json` - Node.js runtime dashboard, 7 panels, uid=cognivault-system
- `monitoring/grafana/dashboards/indexing.json` - Indexing pipeline dashboard, 8 panels, uid=cognivault-indexing

## Decisions Made

- Search error rate implemented as a text annotation panel rather than a PromQL panel — `prom-client`'s `collectDefaultMetrics` and CogniVault custom metrics do not expose HTTP status codes; the annotation documents this gap and recommends a future counter
- Reindex Status uses `clamp_max(cognivault_index_queue_depth{job="cognivault"}, 1)` with value mappings (0=Idle, 1=Busy) — provides a useful boolean signal without a dedicated metric
- Latency heatmap target uses `format="heatmap"` with `$__interval` variable — required by Grafana v10+ for correct bucket visualization from Prometheus histograms

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None — dashboards are provisioned automatically via the dashboard provider configured in Plan 02 (watches `/var/lib/grafana/dashboards`).

## Next Phase Readiness

- All 3 dashboard JSON files verified correct and ready for bind-mount into Grafana container
- Datasource UIDs match provisioning config, dashboard queries reference real metrics from metrics.ts
- Prometheus config and alert rules confirmed correct
- Docker-compose services properly configured
- Phase 12 (Prometheus metrics dashboard) complete — monitoring stack fully operational on `docker compose up`

---
*Phase: 12-prometheus-metrics-dashboard-in-separate-container*
*Completed: 2026-03-12*
