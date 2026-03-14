# Roadmap: CogniVault

## Milestones

- ✅ **v1.0 MVP** — Phases 1-14 (shipped 2026-03-13)
- 🚧 **v2.0 Multi-User** — Phases 15-20 (in progress)

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

<details>
<summary>✅ v1.0 MVP (Phases 1-14) — SHIPPED 2026-03-13</summary>

- [x] Phase 1: Project Skeleton (3/3 plans) — completed 2026-03-10
- [x] Phase 2: Vault Read Operations (3/3 plans) — completed 2026-03-10
- [x] Phase 3: Vault Write Operations (3/3 plans) — completed 2026-03-10
- [x] Phase 4: Index State + Change Detection (3/3 plans) — completed 2026-03-10
- [x] Phase 5: Markdown Indexing Pipeline (3/3 plans) — completed 2026-03-10
- [x] Phase 6: Semantic + Lexical Search (2/2 plans) — completed 2026-03-11
- [x] Phase 7: Hybrid Retrieval + Reranking (2/2 plans) — completed 2026-03-11
- [x] Phase 8: Context Pack Assembly (2/2 plans) — completed 2026-03-11
- [x] Phase 9: TOON + API Polish (2/2 plans) — completed 2026-03-12
- [x] Phase 10: Multi-Format Indexing (3/3 plans) — completed 2026-03-12
- [x] Phase 11: Observability + Admin (3/3 plans) — completed 2026-03-12
- [x] Phase 12: Prometheus Metrics Dashboard (3/3 plans) — completed 2026-03-12
- [x] Phase 13: Search & Reindex Correctness (2/2 plans) — completed 2026-03-12
- [x] Phase 14: Infrastructure Hardening & Cleanup (3/3 plans) — completed 2026-03-12

Full details: `.planning/milestones/v1.0-ROADMAP.md`

</details>

### 🚧 v2.0 Multi-User (Phases 15-20)

**Milestone Goal:** Transform CogniVault from a single-user service into a single-container multi-tenant platform where each user's vault is synced via obsidian-headless, all users share one CogniVault process with tenant-isolated Qdrant, and operators manage users via CLI.

- [ ] **Phase 15: Registry Foundation** - User registry data store with hot-reload and atomic writes
- [ ] **Phase 16: Multi-Tenant Auth** - API key resolves to user context on every request
- [ ] **Phase 17: Data Isolation** - Per-user Qdrant filtering and separate SQLite databases
- [ ] **Phase 18: Per-User Indexing and Routes** - Multi-tenant indexing pipeline and API route migration
- [ ] **Phase 19: CLI and Vault Sync** - Operator CLI for user lifecycle and obsidian-headless sync management
- [ ] **Phase 20: Docker and Integration Hardening** - Container rewrite with tini, end-to-end isolation tests, multi-tenant observability dashboards

## Phase Details

### Phase 15: Registry Foundation
**Goal**: A UserRegistry class manages multi-user configuration with zero-downtime updates
**Depends on**: Phase 14 (v1.0 complete)
**Requirements**: TENANT-02, TENANT-03
**Success Criteria** (what must be TRUE):
  1. Server loads a users.json file at startup and exposes user records via in-memory lookup by API key
  2. Editing users.json on disk causes the server to pick up the new configuration within seconds without restart
  3. A crash or kill during users.json write never leaves a corrupted registry file (atomic tmp+rename)
  4. A malformed users.json edit is rejected and the server continues operating with the last valid registry
**Plans:** 1/2 plans executed

Plans:
- [ ] 15-01-PLAN.md — Standalone UserRegistry class with TDD (load, lookup, hot-reload, atomic writes, events)
- [ ] 15-02-PLAN.md — Fastify plugin wrapper, Prometheus metrics, Pino redaction, app.ts integration

### Phase 16: Multi-Tenant Auth
**Goal**: Every API request is authenticated against the registry and carries a resolved user context
**Depends on**: Phase 15
**Requirements**: TENANT-01
**Success Criteria** (what must be TRUE):
  1. A request with a valid API key from users.json receives a 200 response with data scoped to that user
  2. A request with an unknown API key receives 401 Unauthorized
  3. After a user is removed from users.json and the registry reloads, that user's API key returns 401
  4. Route handlers can access request.user.userId to determine the calling tenant
**Plans**: TBD

Plans:
- [ ] 16-01: TBD

### Phase 17: Data Isolation
**Goal**: Each user's vectors and index state are stored in isolated data structures that prevent cross-tenant access
**Depends on**: Phase 16
**Requirements**: DATA-01, DATA-02
**Success Criteria** (what must be TRUE):
  1. Qdrant queries always include a mandatory user_id filter; a search by User A returns zero results from User B's vectors
  2. Each user has a separate SQLite database file at a user-scoped path (e.g., data/{userId}/index.db)
  3. Adding a new user via registry creates their SQLite database with correct schema on first access
**Plans**: TBD

Plans:
- [ ] 17-01: TBD
- [ ] 17-02: TBD

### Phase 18: Per-User Indexing and Routes
**Goal**: The indexing pipeline and all API routes operate in multi-tenant mode with per-user OpenAI keys and metrics
**Depends on**: Phase 17
**Requirements**: OBS-01
**Success Criteria** (what must be TRUE):
  1. Each user's vault is indexed independently using their own OpenAI API key for embeddings
  2. Search, context pack, and admin routes return only data belonging to the authenticated user
  3. Prometheus metrics carry a user_id label on every counter/histogram increment
  4. Adding or removing a user in the registry starts or stops that user's indexer without affecting other users
**Plans**: TBD

Plans:
- [ ] 18-01: TBD
- [ ] 18-02: TBD

### Phase 19: CLI and Vault Sync
**Goal**: Operators manage users via CLI commands and each user's vault stays continuously synced via obsidian-headless
**Depends on**: Phase 18
**Requirements**: CLI-01, CLI-02, CLI-03, CLI-04, SYNC-01, SYNC-02, SYNC-03, SYNC-04
**Success Criteria** (what must be TRUE):
  1. `cognivault-ctl add-user <name>` with Obsidian credentials and OpenAI key provisions a user, runs ob login + ob sync-setup, and writes to users.json atomically
  2. `cognivault-ctl remove-user <name>` stops the user's sync process and removes them from the registry
  3. `cognivault-ctl list-users` displays all users with their sync status and vault path
  4. Each user's vault sync runs as a supervised child process that auto-restarts with exponential backoff on failure
  5. Stale .obsidian/.sync.lock files are cleaned up before every sync process start
**Plans**: TBD

Plans:
- [ ] 19-01: TBD
- [ ] 19-02: TBD
- [ ] 19-03: TBD

### Phase 20: Docker and Integration Hardening
**Goal**: CogniVault runs as a production-ready multi-tenant container with verified tenant isolation and per-user observability dashboards
**Depends on**: Phase 19
**Requirements**: INFRA-01, INFRA-02, INFRA-03, OBS-02, OBS-03
**Success Criteria** (what must be TRUE):
  1. A single Dockerfile produces an image with node:22-slim, tini as PID 1, and obsidian-headless installed globally
  2. docker-compose up starts CogniVault + Qdrant + Prometheus + Grafana with all services healthy
  3. An end-to-end integration test proves two users cannot access each other's data through any API endpoint
  4. Grafana dashboards support filtering all panels by a user_id template variable
  5. Per-user sync process health is visible as a gauge metric in Prometheus
**Plans**: TBD

Plans:
- [ ] 20-01: TBD
- [ ] 20-02: TBD
- [ ] 20-03: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 15 -> 16 -> 17 -> 18 -> 19 -> 20

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Project Skeleton | v1.0 | 3/3 | Complete | 2026-03-10 |
| 2. Vault Read Operations | v1.0 | 3/3 | Complete | 2026-03-10 |
| 3. Vault Write Operations | v1.0 | 3/3 | Complete | 2026-03-10 |
| 4. Index State + Change Detection | v1.0 | 3/3 | Complete | 2026-03-10 |
| 5. Markdown Indexing Pipeline | v1.0 | 3/3 | Complete | 2026-03-10 |
| 6. Semantic + Lexical Search | v1.0 | 2/2 | Complete | 2026-03-11 |
| 7. Hybrid Retrieval + Reranking | v1.0 | 2/2 | Complete | 2026-03-11 |
| 8. Context Pack Assembly | v1.0 | 2/2 | Complete | 2026-03-11 |
| 9. TOON + API Polish | v1.0 | 2/2 | Complete | 2026-03-12 |
| 10. Multi-Format Indexing | v1.0 | 3/3 | Complete | 2026-03-12 |
| 11. Observability + Admin | v1.0 | 3/3 | Complete | 2026-03-12 |
| 12. Prometheus Metrics Dashboard | v1.0 | 3/3 | Complete | 2026-03-12 |
| 13. Search & Reindex Correctness | v1.0 | 2/2 | Complete | 2026-03-12 |
| 14. Infrastructure Hardening & Cleanup | v1.0 | 3/3 | Complete | 2026-03-12 |
| 15. Registry Foundation | 1/2 | In Progress|  | - |
| 16. Multi-Tenant Auth | v2.0 | 0/TBD | Not started | - |
| 17. Data Isolation | v2.0 | 0/TBD | Not started | - |
| 18. Per-User Indexing and Routes | v2.0 | 0/TBD | Not started | - |
| 19. CLI and Vault Sync | v2.0 | 0/TBD | Not started | - |
| 20. Docker and Integration Hardening | v2.0 | 0/TBD | Not started | - |
