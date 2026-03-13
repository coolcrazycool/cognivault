---
phase: 12-prometheus-metrics-dashboard-in-separate-container
plan: "02"
subsystem: infra
tags: [prometheus, grafana, docker-compose, monitoring, alerting, metrics]

# Dependency graph
requires:
  - phase: 11-observability-admin
    provides: /metrics endpoint (prom-client Registry) and metric names for scrape config
provides:
  - Prometheus service (v3.10.0) scraping CogniVault /metrics every 15s with 7-day retention
  - Four Prometheus alerting rules (CogniVaultDown, HighSearchLatencyP99, HighMemoryUsage, HighErrorRate)
  - Grafana service (12.3.2) pre-provisioned with Prometheus datasource, anonymous viewer access on port 3001
  - Named volumes prometheus_data and grafana_data for persistent storage
  - CogniVault healthcheck in docker-compose for service orchestration
affects:
  - 12-03-grafana-dashboard (depends on provisioned datasource uid "prometheus" and dashboard file path /var/lib/grafana/dashboards)

# Tech tracking
tech-stack:
  added: [prom/prometheus:v3.10.0, grafana/grafana:12.3.2]
  patterns:
    - Bind-mount config-as-code for both Prometheus and Grafana (read-only :ro)
    - Grafana provisioning via YAML files (no UI configuration needed)
    - Node-based healthcheck for CogniVault (node:22-slim has no wget/curl)
    - Prometheus depends on cognivault healthcheck; grafana depends on prometheus

key-files:
  created:
    - monitoring/prometheus/prometheus.yml
    - monitoring/prometheus/rules/cognivault.yml
    - monitoring/grafana/provisioning/datasources/prometheus.yml
    - monitoring/grafana/provisioning/dashboards/dashboards.yml
  modified:
    - docker-compose.yml

key-decisions:
  - "HighErrorRate alert uses stalled search requests (rate==0 while up==1) as proxy for error condition — no HTTP status_code labels available from prom-client collectDefaultMetrics"
  - "CogniVault healthcheck uses node -e require('http').get() — node:22-slim has no wget/curl"
  - "Grafana datasource uid set to 'prometheus' for stable reference from dashboard JSON in Plan 03"
  - "monitoring/grafana/dashboards/ mounted read-only at /var/lib/grafana/dashboards for Plan 03 dashboard files"
  - "Prometheus depends on cognivault service_healthy so scraping doesn't start before app is ready"

patterns-established:
  - "Monitoring config as bind-mounted read-only files (not baked into image)"
  - "Grafana provisioning via YAML for datasource and dashboard providers (zero manual setup)"

requirements-completed:
  - MON-03
  - MON-04
  - MON-05

# Metrics
duration: 2min
completed: "2026-03-12"
---

# Phase 12 Plan 02: Prometheus + Grafana Monitoring Infrastructure Summary

**Prometheus (v3.10.0) and Grafana (12.3.2) added to docker-compose with 4 alert rules, pre-provisioned datasource, and anonymous viewer access on port 3001**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-12T14:37:50Z
- **Completed:** 2026-03-12T14:39:17Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Prometheus service scrapes CogniVault /metrics every 15s with 7-day TSDB retention
- Four alerting rules cover: service down (critical), P99 search latency >2s, memory >512 MiB, stalled search requests
- Grafana pre-provisioned with Prometheus datasource (uid: prometheus) and dashboard file provider pointing at /var/lib/grafana/dashboards
- CogniVault healthcheck added using node-based HTTP probe (no wget/curl in slim image)
- prometheus_data and grafana_data named volumes declared for persistent storage

## Task Commits

Each task was committed atomically:

1. **Task 1: Create Prometheus config and alert rules** - `835fef1` (feat)
2. **Task 2: Add Prometheus, Grafana to docker-compose and create Grafana provisioning** - `dfe50e6` (feat)

## Files Created/Modified

- `monitoring/prometheus/prometheus.yml` - Global scrape config (15s interval, 7d retention, cognivault:3000 target)
- `monitoring/prometheus/rules/cognivault.yml` - Four alerting rules with thresholds and for durations
- `monitoring/grafana/provisioning/datasources/prometheus.yml` - Prometheus datasource with uid "prometheus", isDefault:true
- `monitoring/grafana/provisioning/dashboards/dashboards.yml` - File provider for /var/lib/grafana/dashboards
- `docker-compose.yml` - Added prometheus/grafana services, cognivault healthcheck, named volumes

## Decisions Made

- HighErrorRate alert uses a proxy metric (search requests stalled while service is up) because prom-client's `collectDefaultMetrics` does not produce HTTP request counters with status_code labels. This provides a reasonable signal for error conditions with the available metrics.
- Grafana datasource uid explicitly set to "prometheus" so Plan 03 dashboard JSON can reference it by stable UID without depending on auto-generated IDs.
- Node-based healthcheck for CogniVault: `node:22-slim` image has no `wget` or `curl`, so a one-liner using Node's built-in `http` module is used.

## Deviations from Plan

None - plan executed exactly as written. The HighErrorRate PromQL used the discretionary approach described in the plan's task notes, using available metrics from the metrics plugin.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. All services start via `docker compose up`.

## Next Phase Readiness

- Prometheus datasource uid "prometheus" is provisioned and ready for Plan 03 dashboard JSON references
- `/var/lib/grafana/dashboards` bind mount is ready to receive dashboard JSON files from Plan 03
- `docker compose up` will start the full monitoring stack (cognivault + qdrant + prometheus + grafana)

---
*Phase: 12-prometheus-metrics-dashboard-in-separate-container*
*Completed: 2026-03-12*
