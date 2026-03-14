---
status: testing
phase: 15-registry-foundation
source: 15-01-SUMMARY.md, 15-02-SUMMARY.md
started: 2026-03-14T16:05:00Z
updated: 2026-03-14T16:05:00Z
---

## Current Test

number: 1
name: Hot-Reload User Registry
expected: |
  Edit users.json on disk (e.g., change a field or add a second user). Within a few seconds, the server picks up the change without restart. Verify by checking logs or by testing auth with the changed data.
awaiting: user response

## Tests

### 1. Hot-Reload User Registry
expected: Edit users.json on disk and the server picks up the change within seconds without restart. A new user's API key works immediately after adding them to users.json.
result: [pending]

### 2. Malformed Registry Rejection
expected: Save malformed JSON to users.json (e.g., missing required field). Server logs a warning/error but continues operating with the last valid registry. API calls with the previous valid key still work.
result: [pending]

### 3. Registry Metrics in Prometheus
expected: GET /metrics includes cognivault_registry_reloads_total and cognivault_registry_users gauges showing reload counts and current user count.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0

## Gaps

[none yet]
