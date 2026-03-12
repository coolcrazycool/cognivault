# Phase 14: Infrastructure Hardening & Cleanup - Research

**Researched:** 2026-03-12
**Domain:** Docker volumes, TypeScript encapsulation, Biome lint, test quality, Prometheus alerting, documentation traceability
**Confidence:** HIGH

## Summary

Phase 14 is a tech-debt closure phase identified by the v1.0 milestone audit. All six success criteria map to discrete, well-understood changes: one Docker volume configuration, one TypeScript refactor (add a public getter), two lint fixes (auto-fixable), one test cleanup, one Prometheus alert rule adjustment, and one documentation update. No new libraries are needed. No new APIs are introduced.

The changes are isolated to specific files already identified. The planner's job is to sequence them into 1–2 plans that can be verified independently. All changes are verifiable with `pnpm check` (biome + typecheck), `pnpm test`, and a file-content audit of `docker-compose.yml` and `REQUIREMENTS.md`.

The failing tests in `admin/__tests__/routes.test.ts` (2 failures) and 5 other test files failing with `ZodError` are pre-existing issues from modified files in the working tree — they must be diagnosed as part of this phase's cleanup scope.

**Primary recommendation:** Fix all issues in a single wave: TypeScript/lint/test fixes first (independently verifiable), then Docker volume + docs.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| MON-01 | Pipeline metric: cognivault_embedding_requests_total Counter | Already implemented in Phase 12; needs traceability entry in REQUIREMENTS.md |
| MON-02 | Pipeline metrics: chunks_processed_total, pipeline_duration_seconds | Already implemented in Phase 12; needs traceability entry in REQUIREMENTS.md |
| MON-03 | Prometheus container in docker-compose | Already implemented in Phase 12; needs traceability entry in REQUIREMENTS.md |
| MON-04 | Alert rules (4 conditions) — HighErrorRate needs idle-safe fix | Implemented but HighErrorRate has false-positive risk; needs rule adjustment |
| MON-05 | Grafana container with provisioning | Already implemented in Phase 12; needs traceability entry in REQUIREMENTS.md |
| MON-06 | Search performance Grafana dashboard | Already implemented in Phase 12; needs traceability entry in REQUIREMENTS.md |
| MON-07 | Indexing pipeline Grafana dashboard | Already implemented in Phase 12; needs traceability entry in REQUIREMENTS.md |
| MON-08 | Node.js system Grafana dashboard | Already implemented in Phase 12; needs traceability entry in REQUIREMENTS.md |
</phase_requirements>

## User Constraints

No CONTEXT.md exists for this phase. All decisions are at Claude's discretion within the success criteria bounds defined in the phase description.

## Standard Stack

### Core (No new dependencies needed)

| Tool | Version | Purpose | Why |
|------|---------|---------|-----|
| Docker Compose | v2 named volumes | Persistent SQLite data dir | Already used for qdrant_data/prometheus_data/grafana_data |
| TypeScript | strict mode | Public getter pattern | Project-wide strict mode — private field + public getter is idiomatic |
| Biome | v2.x (project-installed) | Lint/format | `pnpm check` runs all; `pnpm format` auto-fixes organizeImports |
| Vitest | project-installed | Test runner | `pnpm test` |

**Installation:** No new packages needed.

## Architecture Patterns

### Pattern 1: Docker Named Volume for SQLite

**What:** Replace ephemeral `/tmp` path with a named Docker volume mounted at a stable path inside the container.

**Current state:** `docker-compose.yml` sets `COGNIVAULT_DATA_DIR=/tmp/cognivault-data` for the cognivault service. This is ephemeral — lost on every container restart. Meanwhile Qdrant, Prometheus, and Grafana all use named volumes (`qdrant_data`, `prometheus_data`, `grafana_data`).

**Fix:** Add `cognivault_data` to the top-level `volumes:` block and mount it into the service. Change `COGNIVAULT_DATA_DIR` to `/data` (or `/cognivault-data`). The `db.ts` plugin already calls `mkdir(dataDir, { recursive: true })` — no plugin changes needed.

```yaml
# Source: docker-compose.yml pattern (same as qdrant_data)
services:
  cognivault:
    environment:
      - COGNIVAULT_DATA_DIR=/data
    volumes:
      - ${VAULT_PATH:-./__vault}:/vault:ro
      - cognivault_data:/data

volumes:
  qdrant_data:
  prometheus_data:
  grafana_data:
  cognivault_data:   # new
```

**Confidence:** HIGH — Docker named volumes are stable, no-code behavior change.

### Pattern 2: TypeScript Public Getter for Private Field

**What:** `VaultManager.rootPath` is `private readonly`. Two files access it via unsafe cast: `indexer.ts` line 108 and `pipeline.ts` line 257.

**Fix:** Add a public getter to `VaultManager`. TypeScript getters are the idiomatic way to expose computed or stored values without breaking encapsulation.

```typescript
// Source: src/lib/vault.ts — VaultManager class
export class VaultManager {
  private readonly rootPath: string;
  private realRootPath: string;

  // Add this getter:
  get vaultRootPath(): string {
    return this.rootPath;
  }
  // ...
}
```

**Callers to update:**

In `src/lib/indexer.ts` constructor (line 108):
```typescript
// Before:
this.vaultRoot = (opts.vault as unknown as { rootPath: string }).rootPath;

// After:
this.vaultRoot = opts.vault.vaultRootPath;
```

In `src/plugins/pipeline.ts` (line 257):
```typescript
// Before:
const vaultRoot = (fastify.vault as unknown as { rootPath: string }).rootPath;

// After:
const vaultRoot = fastify.vault.vaultRootPath;
```

**Confidence:** HIGH — TypeScript getter pattern is standard, no runtime behavior change.

### Pattern 3: Biome organizeImports Fix

**What:** `pnpm check` reports two organizeImports errors (confirmed by running `pnpm check`):
- `src/lib/__tests__/image-tracker.test.ts:1:1` — import order wrong
- `src/lib/__tests__/pdf-chunker.test.ts:1:1` — import order wrong

Note: The v1.0 audit identified `toon.test.ts` as the source, but current `pnpm check` output shows these two files. `toon.test.ts` already passes `biome ci`.

**Fix:** Run `pnpm format` to auto-fix both files. This is safe — Biome's organizeImports only reorders import statements, no semantic changes.

**Additional fixable lint items also present** (warnings, not errors, but worth cleaning):
- `src/lib/vault.ts` — 4x `useTemplate` (string concatenation → template literal)
- `src/plugins/__tests__/pipeline.test.ts` — `useLiteralKeys`
- `src/features/admin/__tests__/service.test.ts` — multiple `noNonNullAssertion`
- `src/features/context/__tests__/service.test.ts` — multiple `noNonNullAssertion`

Success criterion #3 says "Biome lint passes cleanly" — this means the `pnpm check` exit code must be 0. The 2 errors block that. Warnings are acceptable unless the project treats them as errors.

**Confidence:** HIGH — `pnpm format` is auto-fix; verified by re-running `pnpm check`.

### Pattern 4: Replace No-Op Test in db.test.ts

**What:** `src/plugins/__tests__/db.test.ts` line 71 — test titled "closes database connection on app.close() without error" contains `expect(true).toBe(true)` and no actual assertion about the close behavior.

**Fix options (in order of preference):**
1. Replace with a meaningful assertion that `app.close()` does not throw (create a second app instance and call `close()`, assert no error thrown)
2. Remove the test entirely if the behavior is adequately covered by `afterAll` cleanup

**Recommended approach:** Create a fresh app instance, call `close()`, and verify it resolves without throwing. The test already has a comment "The close test is validated by afterAll completing without error" — upgrading this to an explicit assertion is the right move.

```typescript
// Meaningful close test pattern
it('closes database connection on app.close() without error', async () => {
  const tmpClose = await fs.mkdtemp(path.join(os.tmpdir(), 'db-close-'));
  process.env.COGNIVAULT_DATA_DIR = path.join(tmpClose, 'data');
  const { buildApp } = await import('../../app.js');
  const closeApp = await buildApp({ logger: false });
  await closeApp.ready();
  await expect(closeApp.close()).resolves.toBeUndefined();
  await fs.rm(tmpClose, { recursive: true, force: true });
});
```

Note: Module caching means `buildApp` imports the same module. The test may need to use a vitest `isolate` or work around caching. Simplest safe approach: assert `app.close()` resolves without error using the existing test app instance in a second call, OR document why the test is removed (duplicate coverage from afterAll).

**Confidence:** HIGH — the existing pattern of using temp dirs and `buildApp` is already established in the file.

### Pattern 5: HighErrorRate Alert Rule Fix for Idle Periods

**What:** Current rule fires when `rate(cognivault_search_requests_total[5m]) == 0` while `up == 1`. This is a proxy for errors but also fires during legitimate idle periods (no search traffic for 5 minutes).

**Current rule:**
```yaml
- alert: HighErrorRate
  expr: >
    (
      sum(rate(cognivault_search_requests_total[5m])) == 0
    ) and on() (
      up{job="cognivault"} == 1
    )
  for: 5m
```

**Fix options:**
1. Add a longer `for:` duration (e.g., `30m`) so short idle gaps don't trigger
2. Change condition to only fire during business hours (complex, overkill)
3. Rename alert to "SearchTrafficStalled" and update description to clarify it's informational, not an error indicator
4. Add a guard: only fire if previous window had traffic — e.g., use `increase()` over a longer window

**Recommended fix:** Increase `for:` to `30m` AND update annotations to clarify "no search activity" vs "error rate". This handles normal idle periods (development, off-hours) without removing the alert entirely.

```yaml
- alert: HighErrorRate
  expr: >
    (
      sum(rate(cognivault_search_requests_total[5m])) == 0
    ) and on() (
      up{job="cognivault"} == 1
    )
  for: 30m    # was 5m — extended to avoid false-positives during idle periods
  labels:
    severity: warning
  annotations:
    summary: "CogniVault search traffic stalled"
    description: "CogniVault is up but no search requests have been processed in the last 30 minutes. Check if the service is receiving traffic."
```

**Confidence:** HIGH — Prometheus `for:` duration is well-documented; extending reduces false-positive rate.

### Pattern 6: MON-01 through MON-08 Traceability in REQUIREMENTS.md

**What:** The REQUIREMENTS.md Traceability section does not list MON-01 through MON-08. These IDs are used in Phase 12 plans and ROADMAP.md but were never added to the canonical requirements file.

**What to add:** A new `### Monitoring` section in the v1 requirements, plus 8 rows in the Traceability table.

**MON requirement definitions** (from Phase 12 plans and VERIFICATION.md):
- MON-01: Service exposes pipeline metric: total embedding API calls (cognivault_embedding_requests_total)
- MON-02: Service exposes pipeline metrics: total chunks processed (cognivault_chunks_processed_total) and per-file pipeline duration (cognivault_pipeline_duration_seconds)
- MON-03: Prometheus container scrapes CogniVault /metrics at 15s interval with 7-day retention
- MON-04: Four Prometheus alerting rules defined (CogniVaultDown, HighSearchLatencyP99, HighMemoryUsage, HighErrorRate)
- MON-05: Grafana container with auto-provisioned datasource and dashboards on startup
- MON-06: Search performance dashboard (latency percentiles, heatmap, request rate, error rate panel)
- MON-07: Indexing pipeline dashboard (embedding calls, chunk throughput, pipeline duration, queue depth)
- MON-08: Node.js system dashboard (CPU, memory, heap, GC, event loop, uptime)

All 8 are marked `[x]` Complete since they were satisfied in Phase 12.

**Confidence:** HIGH — pure documentation, no code change.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Import order fix | Manual reordering | `pnpm format` (Biome auto-fix) | Biome knows the canonical order; manual edits risk re-introducing the issue |
| SQLite volume persistence | Custom backup scripts | Docker named volume | Named volumes are the Docker-native solution, zero-config, handled by container runtime |
| TypeScript private field exposure | Type assertion casts | Public getter | Getter is type-safe, works with TypeScript strict mode, documented in TypeScript handbook |

## Common Pitfalls

### Pitfall 1: Biome format vs lint — different commands
**What goes wrong:** Running `pnpm lint` (biome lint) won't fix organizeImports — that requires `pnpm format` (biome format --write) or `pnpm check --write`.
**Why it happens:** Biome separates lint rules from formatter/assist rules. `organizeImports` is an assist rule, not a lint rule.
**How to avoid:** Run `pnpm format` to apply the fix, then `pnpm check` to verify all pass.
**Warning signs:** `assist/source/organizeImports FIXABLE` in output — note the `assist/` prefix vs `lint/` prefix.

### Pitfall 2: db.test.ts module caching prevents fresh buildApp
**What goes wrong:** vitest caches dynamic imports; calling `await import('../../app.js')` twice in the same test file returns the same module. A second `buildApp()` call will work but share module-level state.
**Why it happens:** Node.js ESM module caching. Vitest does not re-execute module code on repeated dynamic imports within a test run.
**How to avoid:** Use the existing `app` instance from `beforeAll` for the close test, or use `vi.resetModules()` before a fresh import — but this is complex. Simplest: test that `app.close()` resolves without throwing using the already-initialized `app` from the describe scope.

### Pitfall 3: Docker volume mount path conflicts
**What goes wrong:** If `COGNIVAULT_DATA_DIR` is changed to `/data` but existing containers have state at `/tmp/cognivault-data`, the data won't be in the new volume.
**Why it happens:** Docker volume mounts shadow the container filesystem path.
**How to avoid:** Document that first run after this change requires a fresh index (which is fine — the whole point is future persistence). The `.env.example` should reflect the new default.

### Pitfall 4: VaultManager getter name collision
**What goes wrong:** If getter is named `rootPath`, it shadows the private `rootPath` field — TypeScript will error.
**Why it happens:** Private field and getter cannot share the same name in a class.
**How to avoid:** Name the getter `vaultRootPath` (or `root` or `vaultRoot`) — distinct from the private `rootPath` field name.

### Pitfall 5: Failing tests from currently modified files
**What goes wrong:** `pnpm test` currently shows 6 failed test files (ZodError in 5 files + 2 assertion failures in admin routes). These pre-exist Phase 14.
**Why it happens:** The git status shows modified files: `admin/__tests__/routes.test.ts`, `admin/__tests__/service.test.ts`, `admin/service.ts`, `context/schemas.ts`, `lib/__tests__/embedding.test.ts`, `lib/indexer.ts`, `plugins/__tests__/logging.test.ts`, `plugins/error-handler.ts`, `plugins/indexer.ts`, `plugins/pipeline.ts`, `plugins/toon.ts`. These are partially-applied changes that broke tests.
**How to avoid:** Phase 14 plans must address the failing tests as part of the cleanup or verify they are pre-existing expected failures that Phase 13 changes introduced.

## Code Examples

### Docker named volume pattern (same as existing qdrant_data)
```yaml
# Source: docker-compose.yml existing volumes block
services:
  cognivault:
    environment:
      - COGNIVAULT_DATA_DIR=/data
    volumes:
      - ${VAULT_PATH:-./__vault}:/vault:ro
      - cognivault_data:/data           # named volume mount

volumes:
  qdrant_data:
  prometheus_data:
  grafana_data:
  cognivault_data:                      # declare named volume
```

### TypeScript public getter for private field
```typescript
// Source: VaultManager class in src/lib/vault.ts
export class VaultManager {
  private readonly rootPath: string;   // unchanged
  private realRootPath: string;        // unchanged

  get vaultRootPath(): string {
    return this.rootPath;
  }
}
```

### Consuming the getter (replaces unsafe cast)
```typescript
// Source: src/lib/indexer.ts constructor
// Before (unsafe):
this.vaultRoot = (opts.vault as unknown as { rootPath: string }).rootPath;

// After (type-safe):
this.vaultRoot = opts.vault.vaultRootPath;
```

```typescript
// Source: src/plugins/pipeline.ts processCreatedOrUpdated
// Before (unsafe):
const vaultRoot = (fastify.vault as unknown as { rootPath: string }).rootPath;

// After (type-safe):
const vaultRoot = fastify.vault.vaultRootPath;
```

### REQUIREMENTS.md addition for MON requirements
```markdown
### Monitoring

- [x] **MON-01**: Service exposes total embedding API calls metric (cognivault_embedding_requests_total)
- [x] **MON-02**: Service exposes total chunks processed and per-file pipeline duration metrics
- [x] **MON-03**: Prometheus container scrapes /metrics at 15s interval with 7-day retention
- [x] **MON-04**: Four Prometheus alerting rules defined (CogniVaultDown, HighSearchLatencyP99, HighMemoryUsage, HighErrorRate)
- [x] **MON-05**: Grafana container auto-provisions datasource and dashboards on startup
- [x] **MON-06**: Search performance dashboard shows latency percentiles, request rate, error rate
- [x] **MON-07**: Indexing pipeline dashboard shows embedding calls, chunk throughput, queue depth
- [x] **MON-08**: System dashboard shows CPU, memory, heap, GC, event loop lag, uptime
```

And in the Traceability table:
```markdown
| MON-01 | Phase 12 | Complete |
| MON-02 | Phase 12 | Complete |
| MON-03 | Phase 12 | Complete |
| MON-04 | Phase 14 | Complete |
| MON-05 | Phase 12 | Complete |
| MON-06 | Phase 12 | Complete |
| MON-07 | Phase 12 | Complete |
| MON-08 | Phase 12 | Complete |
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `/tmp` for ephemeral data | Named Docker volumes | Docker Compose v2 default | Zero data loss across container restarts |
| Private field + `as unknown as` cast | Public getter | TypeScript 2.0+ | Type-safe, no runtime overhead |
| Biome v1 `organize_imports` config key | Biome v2 `assist` section | Biome v2.0 | Project already on v2.x — check biome.json for current config |

**Deprecated/outdated:**
- `(obj as unknown as { privateProp: T }).privateProp` cast pattern: replaced by public getter or `protected` in TypeScript idiomatic code

## Open Questions

1. **Pre-existing failing tests — scope question**
   - What we know: 6 test files fail currently (ZodError x5 + admin routes x2). These appear to be from uncommitted partial changes in the working tree (modified files listed in git status).
   - What's unclear: Are these Phase 13 changes that were left uncommitted, or are they intentional WIP? The admin service.ts, indexer.ts, pipeline.ts, error-handler.ts, toon.ts are all modified.
   - Recommendation: Phase 14 plan should include a task to restore passing tests before applying Phase 14 changes. If the modifications are intentional (Phase 13 continuation), they must be resolved first.

2. **Biome check exit code vs warnings**
   - What we know: `pnpm check` exits 1 due to 2 organizeImports errors. There are also 13 warnings and 27 infos that do NOT cause exit failure.
   - What's unclear: Success criterion says "Biome lint passes cleanly" — does this mean exit 0 (errors only) or zero warnings too?
   - Recommendation: Target exit code 0 (fix the 2 errors). Warnings in test files (noNonNullAssertion, useLiteralKeys) are style suggestions — fixing them is optional but makes the output cleaner.

3. **db.test.ts no-op test replacement strategy**
   - What we know: The test has `expect(true).toBe(true)`. Module caching makes creating a truly isolated `buildApp` instance in the same test file complex.
   - What's unclear: Whether vitest module isolation (via `vi.resetModules()`) is needed or if testing `app.close()` on the existing instance (which hasn't been closed yet) is sufficient.
   - Recommendation: The simplest meaningful test is `await expect(app.close()).resolves.not.toThrow()` — but `afterAll` already calls `app.close()`, so the test would be closing it twice. Better: Remove the no-op test and add a comment explaining close behavior is verified by the afterAll block, OR restructure to create a separate minimal db-only app for the close test. Given the existing pattern in the file (it already creates tmpDirs), a dedicated close test with its own app instance is feasible.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (project-installed) |
| Config file | `vitest.config.ts` (project root) |
| Quick run command | `pnpm test -- --run src/plugins/__tests__/db.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SC-1 (Docker volume) | cognivault_data volume present in docker-compose.yml | manual/static | `grep -c 'cognivault_data' docker-compose.yml` should return >= 2 | ✅ (file exists, content change) |
| SC-2 (getter) | vault.vaultRootPath accessible without cast | unit | `pnpm typecheck` (cast removal causes compile error if getter absent) | ✅ |
| SC-3 (Biome) | `pnpm check` exits 0 | static analysis | `pnpm check` | ✅ |
| SC-4 (db.test no-op) | db.test.ts onClose test has meaningful assertion | unit | `pnpm test -- --run src/plugins/__tests__/db.test.ts` | ✅ |
| SC-5 (HighErrorRate) | Alert uses 30m for: duration | static | `grep 'for: 30m' monitoring/prometheus/rules/cognivault.yml` | ✅ |
| SC-6 (REQUIREMENTS.md) | MON-01 through MON-08 in traceability table | static | `grep -c 'MON-0' .planning/REQUIREMENTS.md` should return >= 8 | ✅ |

### Sampling Rate
- **Per task commit:** `pnpm test -- --run <changed test file>` + `pnpm typecheck`
- **Per wave merge:** `pnpm check && pnpm test`
- **Phase gate:** Full suite green (`pnpm check && pnpm test`) before `/gsd:verify-work`

### Wave 0 Gaps
None — existing test infrastructure covers all phase requirements. No new test files needed (changes are to existing files). The db.test.ts close test is a modification of an existing test, not a new file.

## Sources

### Primary (HIGH confidence)
- Direct file inspection of `src/lib/vault.ts`, `src/lib/indexer.ts`, `src/plugins/pipeline.ts` — confirmed private field access patterns
- Direct file inspection of `docker-compose.yml` — confirmed `/tmp/cognivault-data` ephemeral path and missing volume declaration
- Direct file inspection of `monitoring/prometheus/rules/cognivault.yml` — confirmed HighErrorRate `for: 5m` duration
- Direct `pnpm check` execution — confirmed 2 organizeImports errors in image-tracker.test.ts and pdf-chunker.test.ts
- Direct `pnpm test` execution — confirmed 6 failing test files
- `.planning/v1.0-MILESTONE-AUDIT.md` — comprehensive audit identifying all 10 tech debt items

### Secondary (MEDIUM confidence)
- Docker named volumes documentation (established Docker Compose v2 pattern — same pattern used for qdrant_data in this project)
- TypeScript getter pattern (language feature, documented in TypeScript handbook)

### Tertiary (LOW confidence)
- None — all findings verified by direct inspection

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies, all changes use existing project tools
- Architecture: HIGH — all patterns verified against actual file contents
- Pitfalls: HIGH — all pitfalls discovered through direct test execution and file inspection

**Research date:** 2026-03-12
**Valid until:** 2026-04-12 (stable domain — Docker Compose, TypeScript, Biome; no fast-moving APIs)
