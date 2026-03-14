# Requirements: CogniVault

**Defined:** 2026-03-14
**Core Value:** AI agents can find and retrieve the right knowledge from an Obsidian vault in under one second, with high precision across mixed Russian/English content, exact technical terms, and freeform metadata.

## v2.0 Requirements

Requirements for multi-user deployment. Each maps to roadmap phases.

### Multi-Tenant Core

- [ ] **TENANT-01**: CogniVault serves multiple users from a single process, routing each request to the correct user's vault and Qdrant tenant by API key
- [ ] **TENANT-02**: User registry (users.json) is hot-reloaded via filesystem watch without restarting CogniVault
- [ ] **TENANT-03**: Registry writes are atomic (tmp + rename) to prevent corrupted state on crash

### Data Isolation

- [ ] **DATA-01**: Each user's Qdrant vectors are filtered by user_id payload; cross-tenant queries are structurally impossible
- [ ] **DATA-02**: Each user has a separate SQLite database for index state, stored at a user-scoped path

### Vault Sync

- [ ] **SYNC-01**: Each user's vault is synced via `ob sync --continuous` child process with per-user auth token injected as env var
- [ ] **SYNC-02**: Sync processes restart automatically with exponential backoff on failure
- [ ] **SYNC-03**: Stale `.obsidian/.sync.lock` files are cleaned up before each sync process start
- [ ] **SYNC-04**: Sync process failures are logged with structured context and exposed as Prometheus metrics

### CLI Management

- [ ] **CLI-01**: `cognivault-ctl add-user <name>` creates a user with `--obsidian-email`, `--obsidian-password`, `--vault`, `--openai-key` flags
- [ ] **CLI-02**: `cognivault-ctl remove-user <name>` stops sync, removes user from registry
- [ ] **CLI-03**: `cognivault-ctl list-users` shows all users with sync status and vault path
- [ ] **CLI-04**: `add-user` performs `ob login` + `ob sync-setup` inline and stores auth token in registry

### Observability

- [ ] **OBS-01**: Every metric emitted carries a user_id label matching the request's tenant
- [ ] **OBS-02**: Prometheus scrapes single CogniVault instance; Grafana filters by user_id template variable
- [ ] **OBS-03**: Per-user sync process health is exposed as a gauge metric

### Container Infrastructure

- [ ] **INFRA-01**: Single Dockerfile based on node:22-slim with tini as PID 1 and obsidian-headless installed globally
- [ ] **INFRA-02**: Docker Compose defines one CogniVault service + Qdrant + Prometheus + Grafana
- [ ] **INFRA-03**: End-to-end integration test verifies two users cannot access each other's data

## Future Requirements

Deferred to future release. Tracked but not in current roadmap.

### Search Quality

- **RET-04**: Cross-encoder reranking (Cohere/BGE) for top-K precision

### Auth Enhancements

- **AUTH-03**: Read-only vs write/admin role separation
- **AUTH-04**: Multi-key per user (for different agents)

### Operations

- **OPS-01**: `cognivault-ctl rotate-key <user>` for API key rotation without downtime
- **OPS-02**: `cognivault-ctl remove-user --backup <user>` exports vault volume before removal
- **OPS-03**: `cognivault-ctl status` shows resource usage (CPU/memory) per user

### Embedding

- **EMB-01**: Embedding model version tracking and upgrade path

## Out of Scope

| Feature | Reason |
|---------|--------|
| Per-user containers | Architectural pivot to single-container multi-tenant (simpler, lower resource usage) |
| VNC/GUI access to Obsidian | Headless sync only; no browser-based visual editing needed |
| Caddy reverse proxy | Single container, single port — no routing needed |
| Separate Qdrant per user | Qdrant recommends payload filtering; separate collections degrade performance |
| Web UI for user management | Overkill for 5-20 users; CLI sufficient |
| SSO / OAuth | Agents don't login via browser; API keys sufficient |
| Kubernetes / Helm | Not justified for single-server deployment at 5-20 users |
| Shared vault between users | Conflicts with per-user Obsidian Sync; requires CRDT |
| Cross-user search | Requires permission model; defer to v3+ |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| TENANT-01 | — | Pending |
| TENANT-02 | — | Pending |
| TENANT-03 | — | Pending |
| DATA-01 | — | Pending |
| DATA-02 | — | Pending |
| SYNC-01 | — | Pending |
| SYNC-02 | — | Pending |
| SYNC-03 | — | Pending |
| SYNC-04 | — | Pending |
| CLI-01 | — | Pending |
| CLI-02 | — | Pending |
| CLI-03 | — | Pending |
| CLI-04 | — | Pending |
| OBS-01 | — | Pending |
| OBS-02 | — | Pending |
| OBS-03 | — | Pending |
| INFRA-01 | — | Pending |
| INFRA-02 | — | Pending |
| INFRA-03 | — | Pending |

**Coverage:**
- v2.0 requirements: 19 total
- Mapped to phases: 0
- Unmapped: 19

---
*Requirements defined: 2026-03-14*
*Last updated: 2026-03-14 after initial definition*
