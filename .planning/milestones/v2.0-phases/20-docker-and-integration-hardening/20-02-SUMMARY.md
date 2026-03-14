---
phase: 20-docker-and-integration-hardening
plan: "02"
subsystem: infra
tags: [grafana, prometheus, metrics, dashboard, monitoring]

requires:
  - phase: 20-01
    provides: Prometheus metrics infrastructure with promRegistry and per-user labels

provides:
  - Grafana dashboards with user_id template variable filtering across all panels
  - Sync health visibility in system dashboard (sync_running, sync_failures panels)
  - Prometheus metric label cleanup on user removal (no stale metrics)

affects:
  - observability, monitoring, Grafana dashboards

tech-stack:
  added: []
  patterns:
    - "Grafana allValue='.*' for regex match-all on user_id variable (not empty string)"
    - "prom-client .remove() instead of .set(0) for label cleanup on entity deletion"

key-files:
  created: []
  modified:
    - monitoring/grafana/dashboards/indexing.json
    - monitoring/grafana/dashboards/search.json
    - monitoring/grafana/dashboards/system.json
    - src/plugins/sync.ts
    - src/plugins/__tests__/sync.test.ts

key-decisions:
  - "Use allValue='.*' in Grafana user_id variable (not empty string) so All selection uses {user_id=~'.*'} which matches all users"
  - "Use syncRunning.remove() and syncFailures.remove() on user-removed event to fully purge stale label combinations from Prometheus registry"

patterns-established:
  - "Grafana template variable pattern: query=label_values(METRIC, user_id), allValue='.*', includeAll=true"
  - "Prometheus metric cleanup: call .remove({labels}) on entity removal, not .set(0) which leaves stale series"

requirements-completed:
  - OBS-02
  - OBS-03

duration: 12min
completed: 2026-03-14
---

# Phase 20 Plan 02: Grafana User Filtering and Sync Health Summary

**Per-user dashboard filtering via Grafana template variable across all 3 dashboards, plus sync health panels and Prometheus label cleanup on user removal**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-03-14T16:15:00Z
- **Completed:** 2026-03-14T16:27:00Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Added `user_id` Grafana template variable to indexing, search, and system dashboards with `allValue=".*"` (correct regex match-all)
- Updated all panel Prometheus expressions to filter by `user_id=~"$user_id"` so operators can drill down per user
- Added two new stat panels to system dashboard: "Sync Running (per user)" and "Sync Failures (per user)"
- Changed `user-removed` handler in sync.ts to call `.remove()` on both `syncRunning` and `syncFailures` metrics instead of `.set(0)`, preventing stale label accumulation in Prometheus

## Task Commits

1. **Task 1: Add user_id template variable and filtering to all Grafana dashboards** - `8d53201` (feat)
2. **Task 2: Add sync metric cleanup on user removal in sync.ts** - `a39c6f9` (fix)

## Files Created/Modified

- `monitoring/grafana/dashboards/indexing.json` - Added `templating.list` user_id variable; all 8 panel exprs include `user_id=~"$user_id"`
- `monitoring/grafana/dashboards/search.json` - Added `templating.list` user_id variable; all panel exprs include `user_id=~"$user_id"`
- `monitoring/grafana/dashboards/system.json` - Added `templating.list` user_id variable; all panel exprs updated; added Sync Running and Sync Failures stat panels (ids 8, 9)
- `src/plugins/sync.ts` - `user-removed` handler now calls `syncRunning.remove()` and `syncFailures.remove()` instead of `syncRunning.set(0)`
- `src/plugins/__tests__/sync.test.ts` - Updated test to verify label is removed (undefined) not set to 0

## Decisions Made

- `allValue=".*"` for Grafana regex match-all. Using empty string (`""`) would generate `{user_id=~""}` which matches nothing when "All" is selected; `".*"` generates `{user_id=~".*"}` which matches everything correctly.
- `.remove()` over `.set(0)` for metric cleanup. Calling `.remove({labels})` purges the label combination from the Prometheus registry entirely, preventing stale time series accumulation as users come and go. Leaving a `0` value still creates cardinality and can confuse alerting rules.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated test assertion to match new .remove() behavior**
- **Found during:** Task 2 (sync metric cleanup)
- **Issue:** Existing test `sets cognivault_sync_running gauge to 0 when process stops` expected `val?.value` to be `0` after user removal, but `.remove()` leaves `val` as `undefined`
- **Fix:** Renamed test to `removes cognivault_sync_running gauge labels when user is removed` and changed assertion to `expect(val).toBeUndefined()`
- **Files modified:** `src/plugins/__tests__/sync.test.ts`
- **Verification:** All 12 sync tests pass
- **Committed in:** `a39c6f9` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug in test expectation)
**Impact on plan:** Test update necessary to correctly verify the new behavior. No scope creep.

## Issues Encountered

- Pre-existing Biome lint warnings (40) in codebase — all `noNonNullAssertion` style warnings in test files unrelated to this plan's changes. Not fixed (out of scope).

## Next Phase Readiness

- All 3 Grafana dashboards support per-user filtering with correct regex match-all behavior
- Sync health metrics (running/failure state per user) are visible in system dashboard
- Prometheus cardinality is clean — no stale labels accumulate as users are added/removed

---
*Phase: 20-docker-and-integration-hardening*
*Completed: 2026-03-14*
