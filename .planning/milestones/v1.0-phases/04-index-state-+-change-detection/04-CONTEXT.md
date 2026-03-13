# Phase 4: Index State + Change Detection - Context

**Gathered:** 2026-03-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Service automatically detects vault changes and tracks index state in SQLite. Delivers: SQLite schema with Drizzle ORM, filesystem poller with content hashing and two-pass stability, change event emission for created/updated/moved/deleted files. Chunking, embedding, and search are separate phases (5-7).

</domain>

<decisions>
## Implementation Decisions

### Polling & detection strategy
- Content hash comparison using SHA-256 (Node.js crypto built-in) — hash entire raw file bytes (including frontmatter)
- Poll interval configurable via `POLL_INTERVAL_MS` env var, default 5000ms
- Two-pass stability check: on detecting change, wait configurable delay (`STABILITY_DELAY_MS`, default 2000ms), re-hash — if hash matches both times, file is stable
- Per-file debounce: reset stability timer on each detected change during active editing
- Move detection via content hash match — if file disappears and new file appears with same hash, treat as move event with both old and new path
- Scan only `.md` files (Phase 10 adds PDF/Canvas/CSV support)
- Reuse VaultManager's dotfile/dotdir exclusion rules (skip `.obsidian/`, `.trash/`, `.git/`)
- Skip overlapping poll cycles — if previous poll still running, skip and log warning
- Only emit events on actual changes — no no-op/heartbeat events
- Stability check first, then store hash — never persist hash of partially-written file
- Info-level summary per cycle ("3 changes detected"), debug-level for individual file changes

### Database schema & lifecycle
- SQLite via better-sqlite3 driver + Drizzle ORM
- WAL mode always enabled
- Schema files in `src/db/` directory: `src/db/schema.ts`, `src/db/client.ts`
- Drizzle push on startup (auto-apply schema changes, no migration files)
- Database exposed as Fastify decorator: `fastify.db`
- Data directory: `COGNIVAULT_DATA_DIR` env var, default `./.cognivault/`. DB file: `.cognivault/index.db`
- Auto-create data directory on startup (mkdir -p behavior)
- Database initialized eagerly during Fastify plugin registration — fail fast if filesystem issues
- Single `indexed_files` table with columns: `path` (TEXT, primary key), `content_hash` (TEXT), `mtime` (INTEGER), `size` (INTEGER), `indexed_at` (TEXT/ISO timestamp)
- Index on `content_hash` column for move detection queries
- Paths stored as relative from vault root with forward slashes (POSIX format, consistent with REST API)
- No change log table — only current state tracked. Change events are ephemeral (emitted, not persisted)
- Database is fully rebuildable — delete .db file and restart triggers full rescan
- Readiness endpoint extended to include DB health check (SELECT 1) and `indexing: true/false` status
- `embedding_model_version` column deferred to Phase 5

### Change event propagation
- Node.js EventEmitter pattern on `fastify.indexer` service
- Batch events per poll cycle — one 'changes' event with array of `FileChangeEvent` objects
- Typed interface: `FileChangeEvent { path: string, type: 'created' | 'updated' | 'deleted' | 'moved', contentHash: string, oldPath?: string }`
- Move events include both `oldPath` and `path` for full context
- Fire-and-forget delivery — listener errors logged but don't block poller
- Initial startup scan emits 'created' events too — uniform code path for consumers
- Large startup batches chunked into ~100 events per emission to avoid memory pressure

### Startup scan behavior
- Non-blocking — HTTP server starts immediately, scan runs in background
- Readiness returns 200 with `{ status: 'ok', indexing: true/false }` — Docker probe passes, clients know if index is building
- Full reconciliation on every startup: compare DB rows to filesystem, emit delete events for files in DB but not on disk, create events for new files
- Batched parallel file processing with concurrency limit during initial scan
- Poller starts after initial scan completes (clean sequencing from baseline)
- Periodic info-level progress logs every 500 files during scan
- Info-level summary when scan completes ("Initial scan complete: 847 files indexed in 2.3s")
- Empty vault is valid — log warning, start poller anyway (vault may be populated later)
- Graceful shutdown: register Fastify onClose hook to stop poller, close DB connection (Docker SIGTERM)
- All config in `config.ts` Zod schema: `COGNIVAULT_DATA_DIR`, `POLL_INTERVAL_MS`, `STABILITY_DELAY_MS`

### Claude's Discretion
- Exact concurrency limit for batched parallel scan
- Internal poller implementation (setInterval vs setTimeout chain)
- Drizzle schema details (column types, constraints beyond what's specified)
- How binary file detection works during scan (extension-based)
- Test fixture structure for indexer tests

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `VaultManager` (src/lib/vault.ts): Has `resolvePath()` with traversal protection, symlink rejection, dotfile blocking — reuse for scan path validation
- `VaultManager.listFiles()`: Recursive directory walking — pattern reusable for full vault scan
- `config.ts`: Zod-validated env config — extend with `COGNIVAULT_DATA_DIR`, `POLL_INTERVAL_MS`, `STABILITY_DELAY_MS`
- Error handler pattern (src/plugins/error-handler.ts): Consistent error response format for any new endpoints

### Established Patterns
- Fastify plugin registration in `app.ts`: error-handler → auth → vault → feature routes — DB plugin registers early, indexer after vault
- `fastify.vault` decorator pattern — follow same for `fastify.db` and `fastify.indexer`
- Feature routes as Fastify plugins with TypeBox schemas
- Tests use `fastify.inject()` with top-level env vars and dynamic import

### Integration Points
- `src/app.ts`: Register database plugin and indexer plugin
- `src/config.ts`: Add COGNIVAULT_DATA_DIR, POLL_INTERVAL_MS, STABILITY_DELAY_MS
- `src/features/health/routes.ts`: Extend readiness to include DB health check and indexing status
- `src/db/`: New directory for schema.ts, client.ts
- `src/plugins/`: New db.ts plugin (Fastify decorator) and indexer.ts plugin (poller + event emitter)

</code_context>

<specifics>
## Specific Ideas

- User consistently chose recommended/standard approaches across all four areas
- User prefers strict/explicit behavior (established in prior phases)
- Database should be disposable/rebuildable — no irreplaceable state
- Move detection preserves index continuity (avoids vector churn in Qdrant downstream)
- Startup scan emits same events as ongoing polling — uniform consumer code path

</specifics>

<deferred>
## Deferred Ideas

- Poller pause/resume API — add when Phase 11 (admin reindex) needs it
- embedding_model_version column — Phase 5
- PDF/Canvas/CSV/image file scanning — Phase 10
- Change log table for audit — not needed, events are ephemeral

</deferred>

---

*Phase: 04-index-state-change-detection*
*Context gathered: 2026-03-10*
