---
status: testing
phase: v2.0-milestone
source: 15-01-SUMMARY.md, 15-02-SUMMARY.md, 16-01-SUMMARY.md, 17-01-SUMMARY.md, 17-02-SUMMARY.md, 18-01-SUMMARY.md, 18-02-SUMMARY.md, 18-03-SUMMARY.md, 19-01-SUMMARY.md, 19-02-SUMMARY.md, 20-01-SUMMARY.md, 20-02-SUMMARY.md, 20-03-SUMMARY.md, 20-04-SUMMARY.md
started: 2026-03-14T16:10:00Z
updated: 2026-03-14T16:10:00Z
---

## Current Test

number: 1
name: Multi-Tenant Auth — Valid Key
expected: |
  A request with your API key to /api/vault/files returns a JSON list of your vault's files/directories. You should see your Obsidian vault structure (folders like "01 - Hobby", "02 - Notes", etc.)
awaiting: user response

## Tests

### 1. Multi-Tenant Auth — Valid Key
expected: A request with your API key to /api/vault/files returns your vault's file listing. You should see folders like "01 - Hobby", "02 - Notes", etc.
result: [pending]

### 2. Multi-Tenant Auth — Invalid Key Rejected
expected: A request with an invalid API key (e.g., "cv-invalid") to any /api/ endpoint returns 401 Unauthorized with error code UNAUTHORIZED.
result: [pending]

### 3. Semantic Search Returns Relevant Results
expected: A semantic search for a topic you know is in your vault returns relevant documents with similarity scores. Results should be from YOUR vault only.
result: [pending]

### 4. Lexical Search Works
expected: A lexical (keyword) search for a specific word in your vault returns matching documents.
result: [pending]

### 5. Hybrid Search Combines Both
expected: A hybrid search returns results combining semantic and lexical scoring, with relevance scores.
result: [pending]

### 6. Context Pack Assembly
expected: POST /api/vault/context with a query returns a structured context pack with source sections, scores, and token counts.
result: [pending]

### 7. Per-User Metrics in Prometheus
expected: GET /metrics shows counters/histograms with user_id="cytryx" labels (search_duration, search_requests, etc.)
result: [pending]

### 8. CLI list-users Shows Your User
expected: Running `cognivault-ctl list-users` inside the container shows your user "cytryx" with vault path and sync status.
result: [pending]

### 9. Grafana Dashboard Accessible
expected: Grafana is accessible at http://localhost:3010 with dashboards that have a user_id filter dropdown.
result: [pending]

### 10. Per-User SQLite Database
expected: Each user gets their own SQLite database at /data/{userId}/index.db inside the container.
result: [pending]

### 11. Docker Stack Health
expected: All 4 services (cognivault, qdrant, prometheus, grafana) are running and healthy via docker-compose.
result: [pending]

## Summary

total: 11
passed: 0
issues: 0
pending: 11
skipped: 0

## Gaps

[none yet]
