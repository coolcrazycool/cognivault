---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Multi-User
status: in-progress
stopped_at: Completed 22-01-PLAN.md
last_updated: "2026-03-14T17:19:12.813Z"
last_activity: 2026-03-14 — Phase 19 Plan 02 (Sync Plugin) complete
progress:
  total_phases: 8
  completed_phases: 6
  total_plans: 19
  completed_plans: 17
  percent: 67
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-14)

**Core value:** AI agents can find and retrieve the right knowledge from an Obsidian vault in under one second, with high precision across mixed Russian/English content, exact technical terms, and freeform metadata.
**Current focus:** v2.0 Multi-User — Phase 19: CLI and Vault Sync

## Current Position

Phase: 19 of 20 (CLI and Vault Sync) — fifth of 6 v2.0 phases
Plan: 02 of 03 complete (Sync Plugin)
Status: in-progress
Last activity: 2026-03-14 — Phase 19 Plan 02 (Sync Plugin) complete

Progress: [██████░░░░] 67%

## Performance Metrics

**Velocity:**
- Total plans completed: 37 (v1.0)
- Average duration: carried from v1.0
- Total execution time: carried from v1.0

*Updated after each plan completion*

## Accumulated Context

### Decisions

All decisions logged in PROJECT.md Key Decisions table.

- Architectural pivot from per-user containers to single-container multi-tenant (2026-03-14)
- obsidian-headless for vault sync instead of VNC/GUI Obsidian (2026-03-14)
- fs.watch on parent directory for atomic rename-over detection (2026-03-14)
- SHA-256 content hash for reload skip optimization (2026-03-14)
- Deep-freeze returned records for immutability (2026-03-14)
- Expose prom-client Registry on fastify.metrics.promRegistry for shared metric registration (2026-03-14)
- Registry plugin depends on metrics plugin; registration order: metrics -> registry -> auth (2026-03-14)
- mkdir(recursive) for data directory in registry plugin before loading users.json (2026-03-14)
- Auth plugin depends on registry and metrics via fp() dependencies array (2026-03-14)
- Single generic 401 response for all auth failure modes — no information leakage (2026-03-14)
- Auth failure counter on shared promRegistry for Prometheus scraping (2026-03-14)
- request.log enriched with userId via child logger after successful auth (2026-03-14)
- Filter merging via unknown[] types with Record cast at Qdrant client boundary (2026-03-14)
- Raw QdrantClient kept local in plugin closure, exposed only via createTenantQdrant factory (2026-03-14)
- [Phase 17]: Filter merging via unknown[] types with Record cast at Qdrant client boundary
- [Phase 17]: Disabled pipeline and indexer entirely for Phase 17 (clean break for Phase 18 multi-tenant refactoring)
- [Phase 17]: Per-user SQLite via Map<userId, db> with request decorators getUserDb/getUserQdrant
- [Phase 18]: Qdrant uses DIMENSION_MAP[config.EMBEDDING_MODEL] instead of fastify.embedder.dimensions (2026-03-14)
- [Phase 18]: Per-user EmbeddingProvider Map with registry event lifecycle (2026-03-14)
- [Phase 18]: No validate() on per-user embedder creation — fail on first use (2026-03-14)
- [Phase 18]: Pipeline does NOT depend on indexer; reversed dep via processFileChanges (2026-03-14)
- [Phase 18]: Queue depth gauge update in finally block (PQueue events lack userId) (2026-03-14)
- [Phase 18]: Admin reindex uses processFileChanges instead of indexer.emit for path/folder (2026-03-14)
- [Phase 18]: Pipeline registered before indexer in app.ts (indexer fp() deps include 'pipeline') (2026-03-14)
- [Phase 18]: Health readiness endpoint iterates per-user indexers Map for indexing status (2026-03-14)
- [Phase 19]: Extract CLI handler functions from Commander actions for direct testability (2026-03-14)
- [Phase 19]: SYNC_STATUS always 'unknown' in CLI -- no server access from offline CLI (2026-03-14)
- [Phase 19]: Use promisify(execFile) for subprocess calls to ob CLI (2026-03-14)
- [Phase 19]: unlinkSync for lock file cleanup instead of async unlink -- avoids async chains in setTimeout restart callbacks (2026-03-14)
- [Phase 19]: Backoff use-then-increase pattern: use current delay for timer, multiply for next failure (2026-03-14)
- [Phase 19]: onClose SIGKILL fire-and-forget -- not awaited to prevent blocking server shutdown (2026-03-14)
- [Phase 20]: Use allValue='.*' in Grafana user_id variable (not empty string) so All selection uses regex match-all
- [Phase 20]: prom-client .remove() on user-removed event to purge stale label combinations instead of .set(0)
- [Phase 20-docker-and-integration-hardening]: tini installed via apt-get as ENTRYPOINT for PID 1 signal forwarding to ob sync processes
- [Phase 20-docker-and-integration-hardening]: VAULT_PATH made optional in config.ts; vault.ts guard skips plugin when unset for v2.0 multi-tenant mode
- [Phase 20-docker-and-integration-hardening]: describe.skipIf guard for isolation test — skips cleanly without QDRANT_URL or OPENAI_API_KEY
- [Phase 20-docker-and-integration-hardening]: Dockerfile HEALTHCHECK uses Node.js fetch API — avoids adding curl to production image; interval=5s start-period=10s
- [Phase 20-docker-and-integration-hardening]: Process-level Node.js metrics intentionally exempt from user_id filtering — plan truth was overspecified
- [Phase 20-docker-and-integration-hardening]: v2.0 isolation proven via search-based empty results (200+empty), not 404 vault path reads — INFRA-03 satisfied
- [Phase 21-cli-server-event-wiring]: Emit 'user-added'/'user-removed' directly in addUser()/removeUser() after atomicWrite — any registry instance fires events reliably without fs.watch
- [Phase 21-cli-server-event-wiring]: Retry loop wraps createUserIndexer calls — createUserIndexer itself unchanged, still returns null on ENOENT
- [Phase 21-cli-server-event-wiring]: try/catch wraps entire user-added handler body to prevent unhandled rejections from async EventEmitter handler
- [Phase 22]: VaultManager.initialize() required in createUserIndexer to set realRootPath via fs.realpath — without it macOS symlink /tmp->private/tmp causes 403 PATH_TRAVERSAL on all non-root vault paths

### Roadmap Evolution

- v1.0: 14 phases, 37 plans — shipped 2026-03-13
- v2.0: 6 phases (15-20), 19 requirements — roadmap created 2026-03-14

### Pending Todos

None.

### Blockers/Concerns

- obsidian-headless is beta (v0.0.6) — `ob login` non-interactive behavior unconfirmed; must verify before Phase 19 planning
- obsidian-headless Linux x86_64 binary availability on node:22-slim unconfirmed; must verify before Phase 20 planning

## Session Continuity

Last session: 2026-03-14T17:19:12.811Z
Stopped at: Completed 22-01-PLAN.md
Resume file: None
