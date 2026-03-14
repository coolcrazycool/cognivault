# Phase 20: Docker and Integration Hardening - Research

**Researched:** 2026-03-14
**Domain:** Docker multi-stage builds, tini PID 1, obsidian-headless, Grafana template variables, Vitest integration tests
**Confidence:** HIGH (most areas verified against source code + official docs)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Integration test scope**
- Primary guarantee: API data separation — two users cannot access each other's data through any API endpoint
- Two test layers: (1) Vitest + fastify.inject() with real Qdrant for fast iteration, (2) Docker smoke test verifying image boots and healthcheck passes
- Vitest isolation test uses real Qdrant container (not mocked) for realistic vector isolation testing
- Endpoints covered: search + notes CRUD — User A creates a note, User B searches and gets zero results; User B reads User A's note path and gets 404
- Test directory: `test/` at project root

**Dashboard user filtering**
- Add `user_id` template variable to all 3 existing Grafana dashboards (indexing, search, system)
- Default to "All users" — operator selects a specific user to drill down
- Sync health panel added to system dashboard (per-user sync_running gauge + failure counter)
- Auto-provisioned via JSON files in `monitoring/grafana/dashboards/` (existing pattern)

**Volume & vault layout**
- Per-user vaults at `/data/{userId}/vault/` inside the container
- Single `/data` volume (named Docker volume `cognivault_data`) holds both vaults and SQLite DBs
- Old single-user `VAULT_PATH` bind mount removed — clean break for v2.0
- Vault directories auto-created when user is added (obsidian-headless creates on sync start)
- Named Docker volume (not host bind mount) — Docker manages persistence

**Deployment workflow**
- Operator manages users via `docker exec cognivault cognivault-ctl add-user ...` against running container
- Container starts healthy with zero users — operator adds users after boot
- Environment variables simplified for v2.0: QDRANT_URL, LOG_LEVEL, COGNIVAULT_DATA_DIR, EMBEDDING_MODEL only. No more COGNIVAULT_API_KEY or OPENAI_API_KEY (both are per-user in users.json now)
- obsidian-headless installed at Docker build time — baked into image, no runtime network dependency

**Dockerfile requirements**
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

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INFRA-01 | Single Dockerfile based on node:22-slim with tini as PID 1 and obsidian-headless installed globally | tini via apt-get install; obsidian-headless via npm install -g; CMD wraps node with ENTRYPOINT tini |
| INFRA-02 | Docker Compose defines one CogniVault service + Qdrant + Prometheus + Grafana | All 4 services already defined; needs env var cleanup (remove COGNIVAULT_API_KEY, OPENAI_API_KEY, VAULT_PATH) and volume restructuring |
| INFRA-03 | End-to-end integration test verifies two users cannot access each other's data | Vitest isolation test with real Qdrant + Docker smoke test script; TenantQdrantClient already enforces user_id filter |
| OBS-02 | Prometheus scrapes single CogniVault instance; Grafana filters by user_id template variable | label_values() query variable in Grafana dashboard JSON templating.list; all metrics already carry user_id label |
| OBS-03 | Per-user sync process health is exposed as a gauge metric | cognivault_sync_running gauge ALREADY exists in sync.ts; needs Grafana panel in system dashboard and removeUserMetrics coverage |
</phase_requirements>

---

## Summary

Phase 20 is a hardening and completion phase. The core multi-tenant application logic (tenant isolation, metrics labeling, sync processes) is fully implemented. This phase wires it together into a production-ready container image and proves correctness with integration tests.

Three work streams drive this phase. First, Dockerfile surgery: add tini as PID 1 and `npm install -g obsidian-headless` to the production stage, update the CMD to use tini as entrypoint. Second, docker-compose cleanup: remove obsolete single-tenant env vars (VAULT_PATH, COGNIVAULT_API_KEY, OPENAI_API_KEY), add v2.0 COGNIVAULT_DATA_DIR, restructure volumes to named `cognivault_data`. Third, observability and testing: add `user_id` template variable to all 3 Grafana dashboard JSON files, add a sync health panel to the system dashboard (the metric already exists), and write the Vitest isolation test plus a Docker smoke test script.

A critical finding: `cognivault_sync_running` gauge (OBS-03) is already implemented in `src/plugins/sync.ts`. OBS-03 just needs a Grafana panel to surface it and coverage in `removeUserMetrics`. The config.ts still has `VAULT_PATH` as a required field — this must be made optional or removed as part of INFRA-02 cleanup. The vitest.config.ts `include` pattern only covers `src/**/__tests__/**/*.test.ts`, so `test/isolation.test.ts` requires either a separate vitest project config or a config update to include the `test/` directory.

**Primary recommendation:** Split into 3 plans: (1) Dockerfile + docker-compose v2.0 cleanup, (2) Grafana dashboard user_id filtering + sync health panel, (3) Vitest isolation test + Docker smoke test.

---

## Standard Stack

### Core (already in use — confirmed from source)
| Library/Tool | Version | Purpose | Why Standard |
|--------------|---------|---------|--------------|
| tini | latest apt | PID 1 init for containers | Reaps zombie processes, forwards signals to Node.js child processes correctly |
| obsidian-headless | 0.0.6 (npm) | `ob` CLI baked into image | Official Obsidian Sync headless client, Node.js 22 compatible |
| Vitest | ^4.0.18 | Test runner | Already in devDependencies |
| prom-client | ^15.1.3 | Prometheus metrics | Already in use; sync.ts already emits cognivault_sync_running |
| Grafana | 12.3.2 | Dashboard | Already in docker-compose.yml |

### Supporting
| Tool | Version | Purpose | When to Use |
|------|---------|---------|-------------|
| Docker healthcheck (HTTP) | — | Container health probe | Already configured in docker-compose; must survive zero-user startup |
| node:22-slim base | 22 | Production image | Matches Node.js runtime version requirement |
| Docker named volumes | — | Data persistence | CONTEXT decision: no host bind mounts for data |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| tini via apt-get | dumb-init, `--init` Docker flag | apt-get is simplest for node:22-slim; `--init` flag approach less explicit; tini is more widely documented |
| obsidian-headless via npm install -g | Pre-downloaded binary | npm install -g is the official install path; no Linux binaries in GitHub releases |
| Vitest for isolation test | Jest, Mocha | Already the project test runner; consistent tooling |

**Installation (Dockerfile production stage additions):**
```bash
# tini
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*

# obsidian-headless
RUN npm install -g obsidian-headless

# Update CMD
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
```

---

## Architecture Patterns

### Recommended Project Structure (changes only)
```
test/
├── isolation.test.ts    # New: Vitest integration test with real Qdrant
└── docker-smoke.sh      # New: Docker smoke test script

monitoring/grafana/dashboards/
├── indexing.json        # Modify: add templating.list user_id variable
├── search.json          # Modify: add templating.list user_id variable + filter exprs
└── system.json          # Modify: add templating.list user_id variable + sync health panel

src/
├── config.ts            # Modify: make VAULT_PATH optional (or remove)
├── plugins/
│   └── metrics.ts       # Modify: add sync metrics to removeUserMetrics
Dockerfile               # Modify: add tini + obsidian-headless
docker-compose.yml       # Modify: env var cleanup + volume restructure
```

### Pattern 1: tini as PID 1 in multi-stage Dockerfile
**What:** Install tini in the production stage, set as ENTRYPOINT so all signals are forwarded to Node.js child processes (ob sync processes).
**When to use:** Any container that spawns child processes (our sync.ts spawns `ob sync --continuous` per user).
**Example:**
```dockerfile
# Stage 2: Production
FROM node:22-slim AS production
ENV COREPACK_INTEGRITY_KEYS=""
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
# Install obsidian-headless globally for ob CLI
RUN npm install -g obsidian-headless
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
```
Source: tini official docs (github.com/krallin/tini), verified pattern for node:22-slim.

### Pattern 2: Grafana user_id template variable in dashboard JSON
**What:** Add a `templating` section with a `query` type variable that uses `label_values()` to populate a dropdown of all user_id values seen in metrics.
**When to use:** Any dashboard that needs per-user drill-down.
**Example (add to each dashboard JSON):**
```json
"templating": {
  "list": [
    {
      "name": "user_id",
      "label": "User",
      "type": "query",
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "query": {
        "query": "label_values(cognivault_search_requests_total, user_id)",
        "refId": "StandardVariableQuery"
      },
      "current": { "text": "All", "value": "$__all" },
      "includeAll": true,
      "allValue": "",
      "multi": false,
      "refresh": 2,
      "sort": 1,
      "hide": 0
    }
  ]
}
```
Once added, existing panel `expr` values must be updated to filter by `{user_id=~"$user_id"}` (or `{user_id="$user_id"}` for single-select). The `includeAll: true` + `allValue: ""` combination means "All users" passes no filter when all is selected.

**Per-dashboard query for populating variable:**
- `indexing.json` → `label_values(cognivault_index_queue_depth, user_id)`
- `search.json` → `label_values(cognivault_search_requests_total, user_id)`
- `system.json` → `label_values(cognivault_sync_running, user_id)` (sync metric always exists)

Source: Grafana docs (grafana.com/docs/grafana/latest/datasources/prometheus/template-variables/)

### Pattern 3: Vitest isolation test with real Qdrant
**What:** Vitest integration test in `test/` directory that starts Qdrant (assumed already running in CI or via docker-compose), creates two synthetic users, indexes content for User A, proves User B gets zero search results.
**When to use:** End-to-end tenant isolation guarantee.

The vitest.config.ts currently only includes `src/**/__tests__/**/*.test.ts`. The isolation test in `test/isolation.test.ts` requires either:
- Option A: A separate vitest project config that includes `test/**/*.test.ts`
- Option B: Update the existing config's `include` to also cover `test/**/*.test.ts`

**Recommended approach (Option A): separate `vitest.integration.config.ts`:**
```typescript
// vitest.integration.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,   // real Qdrant needs time
    hookTimeout: 30_000,
  },
});
```
Run with: `vitest run --config vitest.integration.config.ts`

**Test structure for `test/isolation.test.ts`:**
```typescript
// Source: CogniVault project pattern (SKILL.md) + Vitest docs
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

describe('tenant isolation', () => {
  let app: FastifyInstance;
  const userAKey = 'test-key-user-a';
  const userBKey = 'test-key-user-b';

  beforeAll(async () => {
    // Requires QDRANT_URL pointing to real Qdrant
    app = await buildApp({ logger: false });
    await app.ready();
    // Register two test users via the registry directly
  });

  afterAll(async () => {
    await app.close();
  });

  it('User B cannot find User A notes via search', async () => {
    // 1. User A indexes a note (via inject to trigger indexing, or direct pipeline call)
    // 2. User B searches for that note content
    const res = await app.inject({
      method: 'POST',
      url: '/api/vault/search',
      headers: { authorization: `Bearer ${userBKey}` },
      payload: { query: 'userA-unique-content', limit: 10 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.results).toHaveLength(0);
  });

  it('User B gets 404 for User A note path', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/vault/notes/some-user-a-note.md',
      headers: { authorization: `Bearer ${userBKey}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
```

### Pattern 4: Docker smoke test script
**What:** Lightweight shell script that builds the image, starts it, waits for healthcheck to pass, hits /health, then tears down.
**Example structure for `test/docker-smoke.sh`:**
```bash
#!/usr/bin/env bash
set -euo pipefail

IMAGE="cognivault:smoke-test"
CONTAINER="cognivault-smoke"

cleanup() {
  docker rm -f "$CONTAINER" 2>/dev/null || true
}
trap cleanup EXIT

docker build -t "$IMAGE" .

docker run -d --name "$CONTAINER" \
  -e QDRANT_URL=http://host.docker.internal:6333 \
  -e LOG_LEVEL=warn \
  -e COGNIVAULT_DATA_DIR=/data \
  -e EMBEDDING_MODEL=text-embedding-3-small \
  "$IMAGE"

# Wait for healthcheck to pass (up to 60s)
for i in $(seq 1 12); do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "starting")
  if [ "$STATUS" = "healthy" ]; then
    echo "Container healthy"
    exit 0
  fi
  sleep 5
done

echo "Container did not become healthy" >&2
docker logs "$CONTAINER" >&2
exit 1
```

### Pattern 5: Sync health panel for Grafana system dashboard
**What:** A gauge/stat panel showing `cognivault_sync_running` and `cognivault_sync_failures_total` per user (both already emitted by sync.ts).
**Panel JSON for system.json:**
```json
{
  "datasource": { "type": "prometheus", "uid": "prometheus" },
  "fieldConfig": {
    "defaults": {
      "color": { "mode": "thresholds" },
      "mappings": [
        { "options": { "0": { "color": "red", "text": "Stopped" }, "1": { "color": "green", "text": "Running" } }, "type": "value" }
    ],
    "thresholds": { "mode": "absolute", "steps": [{ "color": "red", "value": null }, { "color": "green", "value": 1 }] },
    "unit": "short"
  },
  "overrides": []
  },
  "gridPos": { "h": 4, "w": 12, "x": 0, "y": 28 },
  "id": 10,
  "options": { "colorMode": "background", "graphMode": "none", "justifyMode": "auto", "orientation": "auto", "reduceOptions": { "calcs": ["lastNotNull"], "fields": "", "values": false }, "textMode": "auto" },
  "title": "Sync Running (per user)",
  "type": "stat",
  "targets": [
    {
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "expr": "cognivault_sync_running{job=\"cognivault\",user_id=~\"$user_id\"}",
      "legendFormat": "{{user_id}}",
      "refId": "A"
    }
  ]
}
```

### Anti-Patterns to Avoid
- **Running node directly as PID 1:** Zombie ob sync child processes accumulate, SIGTERM not forwarded, graceful shutdown breaks. Always use tini.
- **Leaving VAULT_PATH required in config.ts:** Server will refuse to start in v2.0 container where no VAULT_PATH env is set. Make it optional or remove.
- **Mocking Qdrant in the isolation test:** The whole point is to test TenantQdrantClient's real filter injection. A mock would give a false sense of security.
- **Using host bind mounts for /data in docker-compose.yml:** Named volumes handle permissions correctly; host mounts cause UID mismatch with `node` user.
- **Forgetting to remove COGNIVAULT_API_KEY from docker-compose.yml:** Old per-global key is replaced by per-user keys in users.json.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Signal forwarding for child processes | Custom signal relay | tini | PID 1 zombie reaping is subtle; tini is 20KB and battle-tested |
| Dashboard template variables | Custom Grafana plugin | `label_values()` query variable | Native Prometheus integration, zero code |
| Grafana provisioning | API calls at startup | JSON files in `monitoring/grafana/dashboards/` | Already wired; Grafana auto-loads on start |
| Integration test container management | Docker SDK wrapper | Direct Qdrant URL env var | Keep it simple — point at an already-running Qdrant |

**Key insight:** Almost all infrastructure is already in place. This phase is primarily configuration-layer work and test authoring.

---

## Common Pitfalls

### Pitfall 1: config.ts VAULT_PATH still required
**What goes wrong:** Container fails to start with `VAULT_PATH is required` Zod error. Zero-user healthy start is impossible.
**Why it happens:** config.ts has `VAULT_PATH: z.string().min(1, 'VAULT_PATH is required')` — this predates v2.0.
**How to avoid:** Change to `VAULT_PATH: z.string().optional()` or remove entirely. Audit all usages of `config.VAULT_PATH` in src/ — likely only in vault plugin and indexer plugin.
**Warning signs:** `docker-compose up` exits immediately with Zod parse error on first log line.

### Pitfall 2: obsidian-headless has no Linux binary in npm package — installs from source
**What goes wrong:** `npm install -g obsidian-headless` during Docker build tries to compile native addons, fails on `node:22-slim` which lacks build tools (gcc, python, make).
**Why it happens:** The `btime` native module has pre-built binaries only for Windows and macOS. Linux falls back to build from source.
**How to avoid:** Add build tools in the npm install step, then optionally remove them; OR accept the warning that birthtime is unavailable (stated in the README — Linux operates without it). The critical path: install `build-essential` and `python3` before `npm install -g obsidian-headless`, or try `--ignore-scripts` first to see if the pure-JS fallback works.
**Warning signs:** Build step fails with `npm warn` about missing native binary, then `make` or `gyp` error.
**Confidence:** MEDIUM — verified npm package exists and installs via npm, but Linux native addon behavior confirmed via GitHub README only.

**Recommended Dockerfile approach:**
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends tini build-essential python3 \
    && npm install -g obsidian-headless \
    && apt-get purge -y build-essential python3 && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
```
If `--ignore-scripts` works (pure JS fallback), build-essential is not needed and the image stays slimmer.

### Pitfall 3: vitest.config.ts exclude the test/ directory
**What goes wrong:** `pnpm test` does not run `test/isolation.test.ts` because vitest.config.ts only includes `src/**/__tests__/**/*.test.ts`.
**Why it happens:** The include glob was written for unit tests only.
**How to avoid:** Create a separate `vitest.integration.config.ts` for integration tests. Keep the unit test config unchanged. Run integration tests explicitly with `--config vitest.integration.config.ts`.
**Warning signs:** `pnpm test` shows 0 files matched for test/isolation.test.ts.

### Pitfall 4: Grafana user_id variable with `allValue: ""` breaks PromQL
**What goes wrong:** When "All" is selected, the expr becomes `{user_id=~""}` which matches nothing instead of all users.
**Why it happens:** Grafana interpolates `$user_id` as empty string when all is selected and allValue is `""`.
**How to avoid:** Either use `allValue: ".*"` (regex match-all) with `{user_id=~"$user_id"}`, or omit allValue and use `includeAll: true` with Grafana's default behavior of concatenating with `|`.
**Warning signs:** System dashboard shows empty panels when "All" is selected.

### Pitfall 5: removeUserMetrics in metrics.ts doesn't cover sync metrics
**What goes wrong:** When a user is removed, `cognivault_sync_running` and `cognivault_sync_failures_total` labels linger in Prometheus, causing stale "Running" indicators for removed users.
**Why it happens:** `removeUserMetrics` in metrics.ts was written before sync.ts existed. sync.ts registers its own metrics on `fastify.metrics.promRegistry` but they're not in the cleanup function.
**How to avoid:** Add sync metric cleanup to `removeUserMetrics`, or expose a cleanup hook from sync.ts. Since sync.ts registers metrics at plugin startup (not per-user), the gauge needs `.remove({ user_id })` called on user-removed event in sync.ts itself (already done for syncRunning — verify syncFailures is also removed).
**Warning signs:** Prometheus shows `cognivault_sync_running{user_id="removed-user"} 0` persisting after removal.

### Pitfall 6: docker-compose healthcheck uses require() in ESM project
**What goes wrong:** The current healthcheck `CMD ["node", "-e", "require('http').get(...)"]` uses CommonJS `require()`. The container runs `NODE_ENV=production` but the health probe script runs outside the app context.
**Why it happens:** The healthcheck is an inline Node.js script, not part of the ESM app.
**How to avoid:** The existing healthcheck uses CommonJS `require()` in an inline `-e` script — this is fine because `require` works in a standalone `node -e` execution regardless of package.json `"type": "module"`. No change needed.
**Warning signs:** None — this is actually safe.

---

## Code Examples

### Dockerfile diff (INFRA-01)
```dockerfile
# Stage 2: Production
FROM node:22-slim AS production
ENV COREPACK_INTEGRITY_KEYS=""
# Install tini (signal forwarding PID 1) and obsidian-headless build deps
RUN apt-get update && apt-get install -y --no-install-recommends tini build-essential python3 \
    && npm install -g obsidian-headless \
    && apt-get purge -y build-essential python3 && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
```

### docker-compose.yml environment cleanup (INFRA-02)
```yaml
cognivault:
  build: .
  ports:
    - "${PORT:-3000}:3000"
  environment:
    - QDRANT_URL=http://qdrant:6333
    - LOG_LEVEL=${LOG_LEVEL:-info}
    - COGNIVAULT_DATA_DIR=/data
    - EMBEDDING_MODEL=${EMBEDDING_MODEL:-text-embedding-3-small}
  volumes:
    - cognivault_data:/data   # Named volume — no host bind mount
  # Remove: COGNIVAULT_API_KEY, OPENAI_API_KEY, VAULT_PATH
  # Remove: ${VAULT_PATH:-./__vault}:/vault:ro
```

### Grafana template variable (OBS-02)
```json
"templating": {
  "list": [
    {
      "name": "user_id",
      "label": "User",
      "type": "query",
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "query": {
        "query": "label_values(cognivault_search_requests_total, user_id)",
        "refId": "StandardVariableQuery"
      },
      "current": { "text": "All", "value": "$__all" },
      "includeAll": true,
      "allValue": ".*",
      "multi": false,
      "refresh": 2,
      "sort": 1,
      "hide": 0
    }
  ]
}
```
Panel exprs updated to: `cognivault_search_duration_seconds_bucket{job="cognivault",user_id=~"$user_id"}`

### cognivault_sync_running is already emitted (OBS-03)
```typescript
// From src/plugins/sync.ts (already implemented):
const syncRunning = new Gauge({
  name: 'cognivault_sync_running',
  help: 'Whether ob sync process is running for a user (1=running, 0=stopped)',
  labelNames: ['user_id'] as const,
  registers: [fastify.metrics.promRegistry],
});

const syncFailures = new Counter({
  name: 'cognivault_sync_failures_total',
  help: 'Total number of ob sync process failures per user',
  labelNames: ['user_id'] as const,
  registers: [fastify.metrics.promRegistry],
});
```
OBS-03 only requires: (1) a Grafana panel, (2) verifying removeUserMetrics cleanup.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| VAULT_PATH bind mount (single user) | Named volume `/data` with per-user subdirs | Phase 20 (v2.0) | Old volume mount removed from docker-compose |
| Global COGNIVAULT_API_KEY env | Per-user API keys in users.json | Phase 16 (v2.0) | docker-compose environment block simplified |
| No tenant filtering | TenantQdrantClient auto-injects user_id | Phase 17 (v2.0) | Integration test validates this |
| No sync child processes | ob sync --continuous per user | Phase 19 (v2.0) | tini needed for zombie reaping |

**Deprecated/outdated:**
- `VAULT_PATH` env var: required in config.ts, used for single-user vault. Must be made optional.
- `COGNIVAULT_API_KEY` env var: global key replaced by per-user auth in registry.
- `OPENAI_API_KEY` env var: per-user openaiKey in users.json replaces global key.
- `${VAULT_PATH:-./__vault}:/vault:ro` volume mount: replaced by named cognivault_data volume.

---

## Open Questions

1. **obsidian-headless Linux native addon build requirement**
   - What we know: The `btime` native module has prebuilt binaries for Windows/macOS but not Linux. The README says "Linux operates normally without birthtime." `npm install -g obsidian-headless` on Linux may require build tools or may silently skip the native module.
   - What's unclear: Whether `npm install -g obsidian-headless` on `node:22-slim` requires `build-essential` or succeeds with a pure-JS fallback. This needs a test build.
   - Recommendation: Include `build-essential python3` in the Docker build step as a safe default. After image builds successfully, verify `ob --version` runs. If pure-JS fallback works without build tools, remove them to slim the image.
   - **Confidence:** MEDIUM

2. **config.ts VAULT_PATH usages after removal**
   - What we know: config.ts has `VAULT_PATH: z.string().min(1, 'VAULT_PATH is required')`. It was used in vault plugin.
   - What's unclear: Whether vault plugin still references config.VAULT_PATH or whether it was already migrated to per-user vaultPath from the registry in Phase 17/18.
   - Recommendation: Audit `grep -r "VAULT_PATH\|config\.VAULT" src/` before removing. The vault plugin (`src/plugins/vault.ts`) needs inspection.
   - **Confidence:** HIGH (issue is identified, resolution is a code audit)

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.0.18 |
| Config file | `vitest.config.ts` (unit); `vitest.integration.config.ts` (new, for integration) |
| Quick run command | `pnpm test` (unit tests only) |
| Full suite command | `pnpm test && vitest run --config vitest.integration.config.ts` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INFRA-01 | Dockerfile produces image with tini + obsidian-headless | smoke | `bash test/docker-smoke.sh` | ❌ Wave 0 |
| INFRA-02 | docker-compose up starts all 4 services healthy | smoke | `bash test/docker-smoke.sh` (extended) | ❌ Wave 0 |
| INFRA-03 | Two users cannot access each other's data | integration | `vitest run --config vitest.integration.config.ts` | ❌ Wave 0 |
| OBS-02 | Grafana dashboards filter by user_id | manual-only | Verify in Grafana UI — dashboard variables not testable via unit test | N/A |
| OBS-03 | sync_running gauge visible in Prometheus | integration | Verify via `/metrics` endpoint in isolation test | ❌ Wave 0 |

**OBS-02 justification for manual-only:** Grafana dashboard JSON correctness can be validated by checking the JSON structure (schema), but actual variable population requires a running Prometheus with scraped data. Accepted as operator verification post-deploy.

### Sampling Rate
- **Per task commit:** `pnpm check` (typecheck + lint + format)
- **Per wave merge:** `pnpm test` (all unit tests green)
- **Phase gate:** `pnpm test && vitest run --config vitest.integration.config.ts && bash test/docker-smoke.sh` before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `test/isolation.test.ts` — covers INFRA-03, OBS-03
- [ ] `test/docker-smoke.sh` — covers INFRA-01, INFRA-02
- [ ] `vitest.integration.config.ts` — enables `test/` directory in vitest
- [ ] Integration test user setup helpers (createTestUser, cleanupTestUser) — shared fixtures for isolation test

---

## Sources

### Primary (HIGH confidence)
- Source code audit: `src/plugins/sync.ts` — cognivault_sync_running + cognivault_sync_failures_total already emitted
- Source code audit: `src/config.ts` — VAULT_PATH still required, must be made optional
- Source code audit: `vitest.config.ts` — include glob excludes `test/` directory
- Source code audit: `docker-compose.yml` — all 4 services already defined; env var cleanup identified
- Source code audit: `Dockerfile` — multi-stage build confirmed; tini + obsidian-headless additions identified
- Source code audit: `monitoring/grafana/dashboards/*.json` — all 3 dashboards lack `templating` section
- [tini GitHub](https://github.com/krallin/tini) — PID 1 init for containers; apt-get installation confirmed for Debian-based images
- [Grafana Template Variables](https://grafana.com/docs/grafana/latest/datasources/prometheus/template-variables/) — label_values() query variable JSON structure

### Secondary (MEDIUM confidence)
- [obsidian-headless GitHub](https://github.com/obsidianmd/obsidian-headless) — npm install -g confirmed as install method; no GitHub releases; Linux native addon behavior from README
- [obsidian-headless npm page](https://www.npmjs.com/package/obsidian-headless) — version 0.0.6, Node.js 22 requirement confirmed
- WebSearch result: Docker example using `npm install -g obsidian-headless` on Linux in Node.js 18-Alpine image — suggests it works

### Tertiary (LOW confidence)
- obsidian-headless Linux native addon build behavior in `node:22-slim` — inferred from README ("birthtime not supported on Linux"), not empirically tested in this environment

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — tini and Grafana patterns from official docs; obsidian-headless from npm/GitHub
- Architecture: HIGH — based on direct source code audit of existing codebase
- Pitfalls: HIGH (VAULT_PATH, vitest config, Grafana allValue) / MEDIUM (obsidian-headless native addon)

**Research date:** 2026-03-14
**Valid until:** 2026-04-14 (obsidian-headless is beta; Grafana version-specific JSON schema could change)
