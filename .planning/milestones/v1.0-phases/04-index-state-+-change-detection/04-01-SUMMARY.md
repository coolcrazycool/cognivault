---
phase: 04-index-state-+-change-detection
plan: "01"
subsystem: database
tags: [sqlite, drizzle-orm, better-sqlite3, wal, drizzle-kit, migrations, fastify-plugin]

# Dependency graph
requires:
  - phase: 01-project-skeleton
    provides: Fastify app factory with plugin registration pattern, config.ts Zod schema

provides:
  - SQLite database at COGNIVAULT_DATA_DIR/index.db with WAL mode enabled
  - Drizzle ORM indexed_files table (path PK, content_hash, mtime, size, indexed_at)
  - content_hash_idx secondary index for move detection queries
  - createDatabase() DB client function with WAL pragma and Drizzle migrations
  - fastify.db decorator (BetterSQLite3Database) accessible in all plugins/routes
  - Config extensions: COGNIVAULT_DATA_DIR, POLL_INTERVAL_MS, STABILITY_DELAY_MS

affects:
  - 04-02-filesystem-poller (uses indexed_files table for change tracking)
  - 04-03-indexer (reads/writes indexed_files via fastify.db)
  - all future phases that need persistent index state

# Tech tracking
tech-stack:
  added:
    - drizzle-orm 0.45.1
    - better-sqlite3 12.6.2
    - drizzle-kit 0.31.9
    - "@types/better-sqlite3 7.6.13"
    - p-limit 7.3.0
  patterns:
    - Drizzle ORM with better-sqlite3 adapter
    - WAL mode set via sqlite.pragma() BEFORE drizzle init
    - Drizzle migrate() called at DB creation time (not manually)
    - Fastify plugin decorator pattern for shared DB access
    - Auto-create data directory with fs.mkdir({ recursive: true })
    - File-based DB WAL mode vs. memory mode tested separately

key-files:
  created:
    - src/db/schema.ts
    - src/db/client.ts
    - src/plugins/db.ts
    - drizzle.config.ts
    - drizzle/0000_familiar_photon.sql
    - drizzle/meta/0000_snapshot.json
    - drizzle/meta/_journal.json
    - src/db/__tests__/schema.test.ts
    - src/plugins/__tests__/db.test.ts
  modified:
    - src/config.ts
    - src/app.ts
    - package.json
    - pnpm-lock.yaml

key-decisions:
  - "WAL pragma set on sqlite instance BEFORE drizzle() initialization - critical for WAL to apply"
  - "getMigrationsFolder() resolves drizzle/ relative to project root via import.meta.url chain (ESM-safe)"
  - "WAL journal mode not applicable to :memory: SQLite - test uses real temp file for WAL verification"
  - "dbPlugin depends on vault plugin (dependencies: ['vault']) matching existing registration order"
  - "p-limit installed now (used in Plan 02 filesystem poller) to avoid mid-phase dep installs"
  - "db.run() API not available in this drizzle version - use db.get(sql`...`) for raw queries"

patterns-established:
  - "Pattern: createDatabase(path) returns { db, sqlite } - sqlite needed for sqlite.close() on shutdown"
  - "Pattern: Fastify plugin onClose hook closes sqlite connection for clean shutdown"
  - "Pattern: Auto-create data dir before DB creation to avoid ENOENT on first startup"

requirements-completed:
  - IDX-01

# Metrics
duration: 7min
completed: "2026-03-10"
---

# Phase 4 Plan 1: SQLite + Drizzle ORM Infrastructure Summary

**SQLite database with Drizzle ORM, WAL mode, indexed_files schema, and fastify.db decorator for persistent index state storage**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-03-10T16:39:23Z
- **Completed:** 2026-03-10T16:46:44Z
- **Tasks:** 2
- **Files modified:** 9 created, 4 modified

## Accomplishments

- Drizzle ORM schema for indexed_files table with path (PK), content_hash, mtime, size, indexed_at columns plus content_hash_idx index for O(1) move detection
- createDatabase() client with WAL mode enabled before drizzle init, automatic migration on startup
- Fastify db plugin that auto-creates COGNIVAULT_DATA_DIR, creates index.db, decorates fastify.db, and closes connection on shutdown
- Config extended with COGNIVAULT_DATA_DIR, POLL_INTERVAL_MS, STABILITY_DELAY_MS env vars with defaults
- 19 new tests: 13 schema/client tests + 6 plugin tests, all passing (150 total in suite)

## Task Commits

Each task was committed atomically:

1. **Task 1 RED (schema tests)** - `74f0b6a` (test)
2. **Task 1 GREEN (schema + client + config + migrations)** - `d36bac8` (feat)
3. **Task 2 RED (db plugin tests)** - `46b5c07` (test)
4. **Task 2 GREEN (db plugin + app.ts registration)** - `7abf792` (feat)

_Note: TDD tasks have RED (test) and GREEN (feat) commits_

## Files Created/Modified

- `src/db/schema.ts` - Drizzle indexed_files table definition with exports IndexedFile, NewIndexedFile
- `src/db/client.ts` - createDatabase() with WAL pragma, drizzle init, and migrate()
- `src/plugins/db.ts` - Fastify plugin: auto-creates dir, creates DB, decorates fastify.db, closes on shutdown
- `drizzle.config.ts` - Drizzle-kit config pointing to src/db/schema.ts and drizzle/ output
- `drizzle/0000_familiar_photon.sql` - Generated SQL migration (CREATE TABLE + CREATE INDEX)
- `src/db/__tests__/schema.test.ts` - 13 tests covering schema, WAL mode, CRUD, upsert, config
- `src/plugins/__tests__/db.test.ts` - 6 tests covering decorator, queries, dir creation, db file, shutdown
- `src/config.ts` - Added COGNIVAULT_DATA_DIR, POLL_INTERVAL_MS, STABILITY_DELAY_MS
- `src/app.ts` - Registered dbPlugin after vaultPlugin

## Decisions Made

- WAL pragma must be set on the raw sqlite instance BEFORE calling drizzle() — otherwise drizzle may create internal state before WAL is active. Applied as `sqlite.pragma('journal_mode = WAL')`.
- getMigrationsFolder() uses `import.meta.url` and `fileURLToPath` to resolve the `drizzle/` folder from project root — necessary for ESM compatibility since `__dirname` is unavailable.
- In-memory SQLite `:memory:` always reports `memory` journal mode (WAL doesn't apply). WAL test uses a real temp file database.
- `db.get(sql\`SELECT 1 as one\`)` used for query test — `db.run({ sql, params })` API doesn't exist in this drizzle version.
- p-limit installed now alongside drizzle deps to avoid a mid-phase install in Plan 02.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] WAL mode test fixed for in-memory SQLite limitation**
- **Found during:** Task 1 (schema tests GREEN phase)
- **Issue:** Test expected WAL mode on `:memory:` DB — but SQLite in-memory always reports `memory` journal mode; WAL mode only applies to file-based DBs
- **Fix:** Separated WAL test to create a real temp file DB, verify WAL there, then clean up
- **Files modified:** src/db/__tests__/schema.test.ts
- **Verification:** All 13 tests pass
- **Committed in:** d36bac8 (Task 1 feat commit)

**2. [Rule 1 - Bug] Fixed Drizzle raw query API mismatch in db plugin test**
- **Found during:** Task 2 (db plugin tests GREEN phase)
- **Issue:** Test called `app.db.run({ sql: 'SELECT 1', params: [] })` but drizzle's BetterSQLite3Database.run() expects a QueryBuilder object, not a raw SQL object
- **Fix:** Changed test to use `app.db.get<{ one: number }>(sql\`SELECT 1 as one\`)` with drizzle's sql template tag
- **Files modified:** src/plugins/__tests__/db.test.ts
- **Verification:** All 6 db plugin tests pass
- **Committed in:** 7abf792 (Task 2 feat commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 - Bug)
**Impact on plan:** Both fixes corrected test implementation to match actual SQLite/Drizzle API behavior. No scope changes, no architectural impact.

## Issues Encountered

- Biome import ordering linted against both new test files and db.ts — fixed by running `biome check --write` and `biome format --write` on affected files before committing.

## User Setup Required

None - no external service configuration required. COGNIVAULT_DATA_DIR defaults to `./.cognivault` and is auto-created on startup.

## Next Phase Readiness

- fastify.db decorator is live and available to all plugins registered after the db plugin
- indexed_files table with content_hash_idx ready for the filesystem poller (Plan 02) to write change records
- WAL mode confirmed working — safe for concurrent reads during indexing
- POLL_INTERVAL_MS and STABILITY_DELAY_MS config vars ready for Plan 02 poller configuration

---
*Phase: 04-index-state-+-change-detection*
*Completed: 2026-03-10*

## Self-Check: PASSED

All created files confirmed to exist on disk. All 4 task commits verified in git log.
