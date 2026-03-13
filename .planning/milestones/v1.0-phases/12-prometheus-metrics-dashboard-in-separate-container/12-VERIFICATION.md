---
phase: 12-prometheus-metrics-dashboard-in-separate-container
verified: 2026-03-12T14:52:07Z
status: human_needed
score: 10/10 must-haves verified
human_verification:
  - test: "docker compose up -d and visit http://localhost:9090/targets"
    expected: "cognivault target shows as UP with last scrape time updating every 15 seconds"
    why_human: "Requires running Docker stack; cannot verify network connectivity programmatically"
  - test: "Visit http://localhost:3001 after docker compose up"
    expected: "Grafana loads without login prompt; three dashboards (Search, Indexing, System) visible in Dashboards menu"
    why_human: "Requires running Grafana container; browser UI cannot be verified programmatically"
  - test: "Open each Grafana dashboard and confirm panels render"
    expected: "All panels show 'No data' or live data — none show error states (datasource not found, invalid PromQL)"
    why_human: "Panel rendering requires live Grafana + Prometheus; PromQL syntax errors only surface at runtime"
  - test: "Visit http://localhost:9090/alerts"
    expected: "Four alert rules are listed: CogniVaultDown, HighSearchLatencyP99, HighMemoryUsage, HighErrorRate — all in inactive state"
    why_human: "Alert rule loading requires running Prometheus with bound config files"
  - test: "Trigger a search and wait 30s, refresh Search dashboard"
    expected: "Latency percentile panel and request rate panel show data points"
    why_human: "Requires live traffic through the full stack to verify metric collection end-to-end"
---

# Phase 12: Prometheus Metrics Dashboard in Separate Container — Verification Report

**Phase Goal:** Prometheus and Grafana run alongside CogniVault in docker-compose, scraping metrics and providing auto-provisioned dashboards for search performance, indexing pipeline health, and Node.js runtime monitoring.
**Verified:** 2026-03-12T14:52:07Z
**Status:** human_needed (all automated checks passed; 5 items require running Docker stack)
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Prometheus scrapes CogniVault /metrics every 15s with 7-day retention | VERIFIED | `prometheus.yml` sets `scrape_interval: 15s`; `docker-compose.yml` passes `--storage.tsdb.retention.time=7d` and mounts `./monitoring/prometheus:/etc/prometheus:ro` |
| 2 | Grafana loads three auto-provisioned dashboards on startup without manual configuration | VERIFIED | `dashboards.yml` provisions from `/var/lib/grafana/dashboards`; `docker-compose.yml` bind-mounts `./monitoring/grafana/dashboards:/var/lib/grafana/dashboards:ro`; all three JSON files present |
| 3 | Search dashboard shows latency percentiles, heatmaps, request rate, and error rate | VERIFIED | `search.json` has 11 panels: histogram_quantile (p50/p95/p99), heatmap panel, request rate by type, error rate annotation; all reference `cognivault_search_duration_seconds` and `cognivault_search_requests_total` |
| 4 | Indexing dashboard shows embedding call rate, chunk throughput, pipeline duration, queue depth | VERIFIED | `indexing.json` has 8 panels with queries for `cognivault_embedding_requests_total`, `cognivault_chunks_processed_total`, `cognivault_pipeline_duration_seconds`, `cognivault_index_queue_depth` |
| 5 | System dashboard shows CPU, memory, heap, GC, event loop lag, and uptime | VERIFIED | `system.json` has 7 panels referencing `process_cpu_user_seconds_total`, `process_resident_memory_bytes`, `nodejs_heap_size_used_bytes`, `nodejs_gc_duration_seconds`, `nodejs_eventloop_lag_seconds`, `process_start_time_seconds` |
| 6 | Four Prometheus alerting rules defined | VERIFIED | `cognivault.yml` defines: CogniVaultDown (critical, 1m), HighSearchLatencyP99 (warning, 5m), HighMemoryUsage (warning, 5m, 512 MiB), HighErrorRate (warning, 5m, proxy metric) |
| 7 | Three new pipeline metrics instrumented in CogniVault | VERIFIED | `metrics.ts` declares `embeddingRequests`, `chunksProcessed`, `pipelineDuration` in `MetricsCollection`; `pipeline.ts` calls `.inc()` after each embed call and wraps `processCreatedOrUpdated` in `startTimer/finally` |
| 8 | Named volumes prometheus_data and grafana_data declared | VERIFIED | `docker-compose.yml` top-level `volumes:` block contains both `prometheus_data` and `grafana_data` |
| 9 | Grafana exposes port 3001 with anonymous access | VERIFIED | `docker-compose.yml` grafana service: `ports: "3001:3000"`, `GF_AUTH_ANONYMOUS_ENABLED=true`, `GF_AUTH_DISABLE_LOGIN_FORM=true` |
| 10 | All dashboards use dark theme, 6h default range, 30s auto-refresh | VERIFIED | All three JSON files: `style=dark`, `time.from=now-6h`, `time.to=now`, `refresh=30s` confirmed via node parsing |

**Score:** 10/10 truths verified

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/plugins/metrics.ts` | Extended MetricsCollection with 3 new pipeline metrics | VERIFIED | Contains `cognivault_embedding_requests_total`, `cognivault_chunks_processed_total`, `cognivault_pipeline_duration_seconds`; all three decorated on fastify via `metricsPlugin` |
| `src/plugins/pipeline.ts` | Instrumentation calls for new metrics | VERIFIED | `embedAndUpsert` and `processMarkdown` both call `embeddingRequests.inc()` and `chunksProcessed.inc(chunks.length)`; `processCreatedOrUpdated` wraps in `pipelineDuration.startTimer()/finally{end()}` |
| `docker-compose.yml` | Prometheus + Grafana service definitions with healthchecks and named volumes | VERIFIED | prom/prometheus:v3.10.0, grafana/grafana:12.3.2, cognivault healthcheck, prometheus_data and grafana_data volumes |
| `monitoring/prometheus/prometheus.yml` | Prometheus scrape config targeting cognivault | VERIFIED | `targets: ['cognivault:3000']`, `metrics_path: /metrics`, `scrape_interval: 15s` |
| `monitoring/prometheus/rules/cognivault.yml` | 4 alerting rules | VERIFIED | CogniVaultDown, HighSearchLatencyP99, HighMemoryUsage, HighErrorRate all present with thresholds and for-durations |
| `monitoring/grafana/provisioning/datasources/prometheus.yml` | Pre-configured Prometheus datasource | VERIFIED | uid=prometheus, url=http://prometheus:9090, isDefault=true, editable=false |
| `monitoring/grafana/provisioning/dashboards/dashboards.yml` | Dashboard file provider | VERIFIED | path=/var/lib/grafana/dashboards, disableDeletion=true, updateIntervalSeconds=30 |
| `monitoring/grafana/dashboards/search.json` | Search performance dashboard, 6-8+ panels | VERIFIED | 11 panels (including 3 row headers), uid=cognivault-search; histogram_quantile queries, heatmap panel, request rate panels |
| `monitoring/grafana/dashboards/indexing.json` | Indexing pipeline dashboard, 7-8 panels | VERIFIED | 8 panels, uid=cognivault-indexing; all 5 CogniVault pipeline metrics referenced |
| `monitoring/grafana/dashboards/system.json` | Node.js runtime dashboard, 7 panels | VERIFIED | 7 panels, uid=cognivault-system; CPU, memory, heap, GC, event loop, uptime panels confirmed |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/plugins/pipeline.ts` | `src/plugins/metrics.ts` | `fastify.metrics` decoration | WIRED | `pipeline.ts` declares `'metrics'` in plugin dependencies array; calls `fastify.metrics.embeddingRequests.inc()`, `chunksProcessed.inc()`, `pipelineDuration.startTimer()` |
| `docker-compose.yml (prometheus)` | `monitoring/prometheus/prometheus.yml` | bind mount `./monitoring/prometheus:/etc/prometheus:ro` | WIRED | Mount present in docker-compose.yml prometheus service volumes |
| `docker-compose.yml (grafana)` | `monitoring/grafana/provisioning/` | bind mount `./monitoring/grafana/provisioning:/etc/grafana/provisioning:ro` | WIRED | Mount present in docker-compose.yml grafana service volumes |
| `docker-compose.yml (grafana)` | `monitoring/grafana/dashboards/` | bind mount `./monitoring/grafana/dashboards:/var/lib/grafana/dashboards:ro` | WIRED | Mount present; path matches `dashboards.yml` provider path |
| `monitoring/prometheus/prometheus.yml` | `cognivault /metrics endpoint` | scrape_configs target | WIRED | `targets: ['cognivault:3000']` with `metrics_path: /metrics` |
| `monitoring/grafana/dashboards/*.json` | Prometheus datasource | datasource uid reference | WIRED | All three dashboard JSON files use `{"type":"prometheus","uid":"prometheus"}` datasource references, matching provisioned datasource uid |

---

## Requirements Coverage

**Note:** Requirement IDs MON-01 through MON-08 are referenced in the ROADMAP.md Phase 12 entry and all three plan frontmatters, but these IDs do not exist in `.planning/REQUIREMENTS.md`. The REQUIREMENTS.md Traceability section maps Phase 12 monitoring work to INF-04 ("Service exposes Prometheus metrics") under Phase 11, not Phase 12.

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| MON-01 | 12-01-PLAN | Pipeline metric: embedding_requests_total | SATISFIED | Counter created in metrics.ts, instrumented in pipeline.ts, tested in metrics.test.ts |
| MON-02 | 12-01-PLAN | Pipeline metrics: chunks_processed_total, pipeline_duration_seconds | SATISFIED | Both present in metrics.ts and pipeline.ts instrumentation |
| MON-03 | 12-02-PLAN | Prometheus container in docker-compose | SATISFIED | prom/prometheus:v3.10.0 service with scrape config wired |
| MON-04 | 12-02-PLAN | Alert rules (4 conditions) | SATISFIED | 4 rules in cognivault.yml |
| MON-05 | 12-02-PLAN | Grafana container with provisioning | SATISFIED | grafana/grafana:12.3.2 with datasource + dashboard provider provisioning |
| MON-06 | 12-03-PLAN | Search dashboard | SATISFIED | search.json, 11 panels, all required metric queries present |
| MON-07 | 12-03-PLAN | Indexing dashboard | SATISFIED | indexing.json, 8 panels, all 5 pipeline/indexing metrics present |
| MON-08 | 12-03-PLAN | System dashboard | SATISFIED | system.json, 7 panels, all required Node.js runtime metrics present |

**Orphaned requirements:** MON-01 through MON-08 are defined only in ROADMAP.md Phase 12 and plan frontmatters — they have no corresponding entries in REQUIREMENTS.md. This is a documentation gap: the monitoring requirements were added to the roadmap phase but not back-ported to the canonical REQUIREMENTS.md. This does not block the phase goal but should be addressed for traceability.

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `monitoring/prometheus/rules/cognivault.yml` | 31-43 | HighErrorRate uses stalled-search proxy (rate==0 while up==1) rather than HTTP error status codes | Info | Alert fires when no search activity occurs for 5m while service is up — may produce false positives during idle periods. Documented in SUMMARY as intentional: prom-client collectDefaultMetrics lacks HTTP status_code labels. |

No blockers or warnings found. The HighErrorRate proxy approach is a known limitation documented in the decision log.

---

## Human Verification Required

### 1. Prometheus Target Scraping

**Test:** `docker compose up -d` (with COGNIVAULT_API_KEY and VAULT_PATH set), wait 30s, visit http://localhost:9090/targets
**Expected:** cognivault job shows target `cognivault:3000` with state UP and last scrape time updating
**Why human:** Requires running Docker network where `cognivault` hostname resolves to the CogniVault container

### 2. Grafana Dashboard Provisioning

**Test:** Visit http://localhost:3001 after stack is running
**Expected:** Grafana loads without login prompt; Dashboards menu shows three dashboards: "CogniVault Search", "CogniVault Indexing", "CogniVault System"
**Why human:** Requires running Grafana container with provisioning files bind-mounted

### 3. Dashboard Panel Validity

**Test:** Open each of the three dashboards in Grafana
**Expected:** All panels render without "datasource not found" or "query error" states; panels show "No data" if no traffic, not error states
**Why human:** PromQL syntax errors and datasource mismatches only surface at runtime in the Grafana UI

### 4. Alert Rules Loaded

**Test:** Visit http://localhost:9090/alerts
**Expected:** Four alert rules listed (CogniVaultDown, HighSearchLatencyP99, HighMemoryUsage, HighErrorRate) in inactive state
**Why human:** Requires running Prometheus with rules file loaded via bind mount

### 5. End-to-End Metric Flow

**Test:** After stack is running, send a search request (`curl -H "Authorization: Bearer $COGNIVAULT_API_KEY" -X POST http://localhost:3000/api/vault/search -H "Content-Type: application/json" -d '{"query":"test","type":"semantic"}'`), wait 30s, refresh Search dashboard
**Expected:** Latency percentile panels and request rate panel show at least one data point
**Why human:** Requires live traffic through full stack to confirm the complete metrics pipeline (instrument -> scrape -> query -> visualize)

---

## Gaps Summary

No automated gaps found. All 10 observable truths pass. All 10 artifacts are substantive and wired. All 6 key links are confirmed. The single documentation gap (MON-01 through MON-08 not in REQUIREMENTS.md) is a traceability issue, not a functional blocker.

Five human verification items remain to confirm the monitoring stack works end-to-end under Docker. These cannot be verified statically.

---

_Verified: 2026-03-12T14:52:07Z_
_Verifier: Claude (gsd-verifier)_
