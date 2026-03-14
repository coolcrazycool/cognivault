# Phase 20: Docker and Integration Hardening - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

<domain>
## Phase Boundary

CogniVault runs as a production-ready multi-tenant container with verified tenant isolation and per-user observability dashboards. This phase rewrites the Dockerfile for multi-tenant (tini, obsidian-headless), updates docker-compose for v2.0 env vars, proves tenant isolation with end-to-end tests, and adds user_id filtering to all Grafana dashboards.

</domain>

<decisions>
## Implementation Decisions

### Integration test scope
- Primary guarantee: API data separation — two users cannot access each other's data through any API endpoint
- Two test layers: (1) Vitest + fastify.inject() with real Qdrant for fast iteration, (2) Docker smoke test verifying image boots and healthcheck passes
- Vitest isolation test uses real Qdrant container (not mocked) for realistic vector isolation testing
- Endpoints covered: search + notes CRUD — User A creates a note, User B searches and gets zero results; User B reads User A's note path and gets 404
- Test directory: `test/` at project root

### Dashboard user filtering
- Add `user_id` template variable to all 3 existing Grafana dashboards (indexing, search, system)
- Default to "All users" — operator selects a specific user to drill down
- Sync health panel added to system dashboard (per-user sync_running gauge + failure counter)
- Auto-provisioned via JSON files in `monitoring/grafana/dashboards/` (existing pattern)

### Volume & vault layout
- Per-user vaults at `/data/{userId}/vault/` inside the container
- Single `/data` volume (named Docker volume `cognivault_data`) holds both vaults and SQLite DBs
- Old single-user `VAULT_PATH` bind mount removed — clean break for v2.0
- Vault directories auto-created when user is added (obsidian-headless creates on sync start)
- Named Docker volume (not host bind mount) — Docker manages persistence

### Deployment workflow
- Operator manages users via `docker exec cognivault cognivault-ctl add-user ...` against running container
- Container starts healthy with zero users — operator adds users after boot
- Environment variables simplified for v2.0: QDRANT_URL, LOG_LEVEL, COGNIVAULT_DATA_DIR, EMBEDDING_MODEL only. No more COGNIVAULT_API_KEY or OPENAI_API_KEY (both are per-user in users.json now)
- obsidian-headless installed at Docker build time — baked into image, no runtime network dependency

### Dockerfile requirements
- Base: node:22-slim
- tini as PID 1 (proper signal handling for child processes)
- obsidian-headless binary installed globally at build time
- Multi-stage build preserved (build stage for tsc, production stage for runtime)

### Claude's Discretion
- tini installation method in Dockerfile
- obsidian-headless download URL and installation approach
- Vitest test helpers and setup structure
- Docker smoke test scripting details
- Exact Grafana JSON panel configurations
- Prometheus alerting rules (if any)

</decisions>

<specifics>
## Specific Ideas

- Vitest isolation test with real Qdrant gives high confidence in the user_id payload filtering that TenantQdrantClient enforces
- Docker smoke test is lightweight — just verify the image boots, healthcheck passes, and /health returns 200
- Dashboard filtering via template variable is standard Grafana pattern — operator experience should feel familiar
- Zero-user healthy start means docker-compose up always succeeds; users are provisioned as a separate step

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `Dockerfile`: Multi-stage build already in place — needs tini + obsidian-headless additions
- `docker-compose.yml`: All 4 services defined — needs env var cleanup and volume updates
- `monitoring/grafana/dashboards/*.json`: 3 dashboards (indexing, search, system) — add user_id template variable
- `monitoring/grafana/provisioning/`: Grafana auto-provisioning already configured
- `monitoring/prometheus/prometheus.yml`: Prometheus scrape config exists
- `src/lib/tenant-qdrant-client.ts`: TenantQdrantClient auto-injects user_id filter — integration test validates this

### Established Patterns
- `Map<userId, Resource>` with registry events for per-user lifecycle (db, embedder, indexer, sync plugins)
- All metrics carry user_id label (Phase 18) — dashboards just need to filter by it
- Grafana dashboards provisioned from JSON files in repo
- Named Docker volumes for persistent data

### Integration Points
- `Dockerfile`: Add tini, obsidian-headless, update CMD to use tini
- `docker-compose.yml`: Remove COGNIVAULT_API_KEY, OPENAI_API_KEY, VAULT_PATH; keep service config env vars only
- `monitoring/grafana/dashboards/*.json`: Add templating.list entry for user_id variable to each dashboard
- `test/isolation.test.ts` (new): Vitest integration test with real Qdrant
- `test/docker-smoke.sh` (new): Docker smoke test script

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 20-docker-and-integration-hardening*
*Context gathered: 2026-03-14*
