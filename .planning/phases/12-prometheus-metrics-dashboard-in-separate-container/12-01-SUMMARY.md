---
phase: 12-prometheus-metrics-dashboard-in-separate-container
plan: 01
subsystem: infra
tags: [prom-client, prometheus, metrics, pipeline, indexing]

requires:
  - phase: 11-observability-admin
    provides: Per-instance prom-client Registry and existing MetricsCollection interface

provides:
  - Extended MetricsCollection with embeddingRequests, chunksProcessed, pipelineDuration metrics
  - Instrumented pipeline.ts recording embedding calls, chunk counts, and per-file duration

affects:
  - 12-02-PLAN (Prometheus + Grafana docker-compose setup)
  - 12-03-PLAN (Indexing dashboard that visualizes these new metrics)

tech-stack:
  added: []
  patterns:
    - "Per-instance prom-client Counter/Histogram follow existing pattern: pass registers:[register] to avoid global registry pollution"
    - "Pipeline duration wraps processCreatedOrUpdated in startTimer/finally-end pattern"

key-files:
  created: []
  modified:
    - src/plugins/metrics.ts
    - src/plugins/__tests__/metrics.test.ts
    - src/plugins/pipeline.ts
    - src/plugins/__tests__/pipeline.test.ts

key-decisions:
  - "embeddingRequests and chunksProcessed incremented in both embedAndUpsert and processMarkdown independently — markdown has its own embed call path separate from embedAndUpsert"
  - "pipelineDuration wraps entire processCreatedOrUpdated (including image and early-return paths) for consistent duration tracking"
  - "No label dimensions on new counters/histograms — simpler scrape, sufficient for dashboard needs"

patterns-established:
  - "Pipeline metric instrumentation: inc() after embed() calls, startTimer/finally for per-file timing"

requirements-completed:
  - MON-01
  - MON-02

duration: 2min
completed: 2026-03-12
---

# Phase 12 Plan 01: Pipeline Metrics Instrumentation Summary

**Extended MetricsCollection with 3 prom-client metrics (embedding_requests_total, chunks_processed_total, pipeline_duration_seconds) and instrumented pipeline.ts to record them per file processed.**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-12T14:37:52Z
- **Completed:** 2026-03-12T14:40:04Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Added `embeddingRequests` Counter, `chunksProcessed` Counter, and `pipelineDuration` Histogram to MetricsCollection interface and metricsPlugin() factory
- All three metrics appear in /metrics Prometheus text output
- Instrumented `embedAndUpsert` and `processMarkdown` to increment embedding and chunk counters after each `embed()` call
- Wrapped `processCreatedOrUpdated` with `pipelineDuration.startTimer()` / `finally { end() }` for per-file timing

## Task Commits

Each task was committed atomically:

1. **Task 1: Add pipeline metrics to MetricsCollection** - `ff35630` (feat)
2. **Task 2: Instrument pipeline with new metrics** - `dc79b44` (feat)

**Plan metadata:** (created below)

## Files Created/Modified

- `src/plugins/metrics.ts` - Added 3 new prom-client instances and MetricsCollection interface fields
- `src/plugins/__tests__/metrics.test.ts` - Added 3 new test cases asserting new metric names in /metrics output
- `src/plugins/pipeline.ts` - Added embeddingRequests.inc(), chunksProcessed.inc(count), pipelineDuration startTimer/end
- `src/plugins/__tests__/pipeline.test.ts` - Added new metrics to mock, added 4 test assertions for metric instrumentation

## Decisions Made

- Both `embedAndUpsert` and `processMarkdown` have independent `embed()` calls, so both are instrumented separately — no shared counter path exists between them
- `pipelineDuration` wraps the entire `processCreatedOrUpdated` function including early-return paths (images, unknown extensions) to capture all per-file durations consistently

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- All three metrics (`cognivault_embedding_requests_total`, `cognivault_chunks_processed_total`, `cognivault_pipeline_duration_seconds`) now appear in /metrics output
- Ready for Plan 02 (docker-compose Prometheus + Grafana container setup)
- Ready for Plan 03 (Indexing dashboard panels querying these metrics)

---
*Phase: 12-prometheus-metrics-dashboard-in-separate-container*
*Completed: 2026-03-12*
