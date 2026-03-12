# Phase 13: Search & Reindex Correctness - Research

**Researched:** 2026-03-12
**Domain:** Search filtering correctness, async pipeline coordination, content hash integrity
**Confidence:** HIGH — all findings from direct codebase inspection and PQueue official docs

## Summary

Phase 13 closes three integration correctness gaps identified in the v1.0 milestone audit. The gaps are precisely located in existing code and the fixes are surgical: no new dependencies, no schema changes, no API surface changes.

**Gap 1 (RET-05):** `SearchService.semantic()` passes only tags/project/status/type to Qdrant's filter but omits folder. The `folder` field is only post-filtered in `lexical()` via `path.startsWith()`. The `hybrid()` method calls `semantic()` and `lexical()` with the same filters object, so the semantic leg of hybrid also leaks results outside the requested folder. Fix: apply an in-memory `path.startsWith()` filter to the semantic results before returning, mirroring what lexical already does.

**Gap 2 (IDX-13):** `ReindexService.createFullJob()` listens for `scanComplete` from VaultIndexer and marks the job `'completed'` at that point. However, `scanComplete` fires when the indexer finishes scanning and emitting `changes` events — it does NOT wait for the pipeline queue (PQueue) to finish embedding and upserting to Qdrant. Agents polling `GET /api/admin/reindex/status` may see `'completed'` while Qdrant is still being populated. Fix: after `scanComplete`, await `queue.onIdle()` from the PQueue instance in `pipeline.ts` before setting `job.status = 'completed'`.

**Gap 3 (IDX-06):** `ReindexService.createPathJob()` emits a synthetic `'updated'` `FileChangeEvent` with `contentHash: ''`. This empty string propagates into the `content_hash` field in Qdrant payload, misleading anyone inspecting the stored metadata. Fix: read the actual file hash from the `indexed_files` table (or hash the file directly) before emitting the synthetic event.

**Primary recommendation:** Three targeted fixes in `src/features/admin/service.ts` and `src/features/search/service.ts`. The pipeline queue reference needs to be exposed or shared so `ReindexService` can await it.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| RET-05 | Agent can filter search by tags, project, status, folder path, note type | Folder filter missing in `semantic()` and hybrid's semantic leg; fix by post-filtering semantic results by `path.startsWith(folderPrefix)` |
| IDX-13 | Admin can trigger full or partial reindex via API endpoint | Full reindex job status must transition to `'completed'` only after pipeline PQueue drains; expose `queue.onIdle()` reference from pipeline plugin |
| IDX-06 | Service handles created/updated/moved/deleted files incrementally | Path-scoped reindex emits `contentHash: ''`; fix by reading real hash from `indexed_files` DB row before emitting synthetic event |
</phase_requirements>

## Standard Stack

No new dependencies required. All fixes use existing project stack.

### Core (already installed)
| Library | Version | Purpose | Relevant API |
|---------|---------|---------|--------------|
| p-queue | ^9.1.0 | Pipeline concurrency queue | `queue.onIdle()` — resolves when `size === 0 && pending === 0` |
| fastify-plugin | current | Plugin decoration system | `fastify.decorate()` to expose queue reference |
| drizzle-orm | current | SQLite ORM | `db.select().from(indexedFiles).where(eq(path, ...)).get()` for single row lookup |

### No New Packages
All three fixes operate within the existing code. No `npm install` step needed.

## Architecture Patterns

### Recommended Project Structure (unchanged)
```
src/
  features/
    admin/
      service.ts     # Fix Gap 2 (IDX-13) + Gap 3 (IDX-06)
      __tests__/
        service.test.ts  # Add tests for corrected behavior
        routes.test.ts   # Existing; no changes needed
    search/
      service.ts     # Fix Gap 1 (RET-05)
      __tests__/
        routes.test.ts   # Add folder-filter-in-semantic test
  plugins/
    pipeline.ts      # Expose queue reference for IDX-13 fix
```

### Pattern 1: Expose PQueue Reference via Fastify Decoration

**What:** Decorate `fastify` with the PQueue instance so `ReindexService` can call `queue.onIdle()`.

**When to use:** When a plugin owns a resource that another plugin/service needs to coordinate with.

**Current pipeline.ts plugin-local queue:**
```typescript
// src/plugins/pipeline.ts (current)
async function pipelinePlugin(fastify: FastifyInstance): Promise<void> {
  const queue = new PQueue({ concurrency: 3, timeout: 120_000 });
  // queue is plugin-local, not accessible outside
  ...
}
```

**Fix — expose via fastify.decorate:**
```typescript
// src/plugins/pipeline.ts (after fix)
declare module 'fastify' {
  interface FastifyInstance {
    pipelineQueue: PQueue;
  }
}

async function pipelinePlugin(fastify: FastifyInstance): Promise<void> {
  const queue = new PQueue({ concurrency: 3, timeout: 120_000 });
  fastify.decorate('pipelineQueue', queue);
  ...
}
```

**Then in ReindexService.createFullJob():**
```typescript
// Wait for pipeline queue to fully drain before marking job complete
const onScanComplete = async (filesScanned: number, eventsEmitted: number): Promise<void> => {
  job.totalFiles = filesScanned;
  if (job.filesProcessed > filesScanned) {
    job.filesProcessed = filesScanned;
  }
  this.fastify.indexer.removeListener('changes', onChanges);
  this.fastify.indexer.removeListener('scanComplete', onScanComplete);

  // WAIT for pipeline queue to drain before marking completed
  await this.fastify.pipelineQueue.onIdle();

  job.status = 'completed';
  job.completedAt = new Date().toISOString();
};

// NOTE: must use .on() not .once() since onScanComplete is now async — same pattern
this.fastify.indexer.on('scanComplete', onScanComplete);
```

**Important:** Because the `scanComplete` listener becomes `async`, switch from `.once()` to `.on()` and call `removeListener` manually inside — exactly as `onChanges` already does. This avoids the "async listener registered with once fires before await resolves" hazard.

### Pattern 2: In-Memory Folder Filter in semantic()

**What:** Apply `path.startsWith(folderPrefix)` post-filter to semantic results, mirroring what lexical already does.

**Current semantic() (buggy):**
```typescript
// src/features/search/service.ts (current)
async semantic(query: string, limit: number, filters: SearchFilters): Promise<SearchResult[]> {
  const result = await this.qdrant.search(COLLECTION_NAME, {
    vector: embedding as number[],
    limit,
    with_payload: true,
    filter: this.buildFilter(filters) as ...,
    // NOTE: buildFilter() omits folder — no folder filtering happens here
  });

  const points = result as unknown as ScoredPoint[];
  return points
    .filter((hit) => hit.payload?.text !== undefined && hit.payload.text !== null)
    .map((hit) => this.toSearchResult(hit.payload ?? {}, this.normalizeScore(hit.score)));
}
```

**Fix — add folder post-filter:**
```typescript
async semantic(query: string, limit: number, filters: SearchFilters): Promise<SearchResult[]> {
  const [embedding] = await this.embedder.embed([query]);
  const folderPrefix = filters.folder;

  const result = await this.qdrant.search(COLLECTION_NAME, {
    vector: embedding as number[],
    limit,
    with_payload: true,
    filter: this.buildFilter(filters) as Parameters<QdrantClient['search']>[1]['filter'],
  });

  const points = result as unknown as ScoredPoint[];
  return points
    .filter((hit) => hit.payload?.text !== undefined && hit.payload.text !== null)
    .filter(
      (hit) => folderPrefix === undefined || (hit.payload?.path ?? '').startsWith(folderPrefix),
    )
    .map((hit) => this.toSearchResult(hit.payload ?? {}, this.normalizeScore(hit.score)));
}
```

**Effect on hybrid():** Because `hybrid()` calls `this.semantic()` and `this.lexical()` with the same `filters` object, fixing `semantic()` automatically fixes the hybrid semantic leg. No changes needed in `hybrid()`.

### Pattern 3: Real contentHash in Path-Scoped Reindex

**What:** Before emitting the synthetic event, look up the real `contentHash` from `indexed_files`.

**Current createPathJob() (buggy):**
```typescript
this.fastify.indexer.emit('changes', [
  {
    path: filePath,
    type: 'updated',
    contentHash: '',   // BUG: empty string
  },
]);
```

**Fix — read from DB:**
```typescript
private async createPathJob(filePath: string): Promise<ReindexJob> {
  // ...job init...
  try {
    // Look up real contentHash from indexed_files
    const { indexedFiles } = await import('../../db/schema.js');
    const { eq } = await import('drizzle-orm');

    const row = this.fastify.db
      .select()
      .from(indexedFiles)
      .where(eq(indexedFiles.path, filePath))
      .get();  // .get() returns single row or undefined

    const contentHash = row?.contentHash ?? '';

    this.fastify.indexer.emit('changes', [
      {
        path: filePath,
        type: 'updated',
        contentHash,
      },
    ]);

    job.filesProcessed = 1;
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
  } catch (err: unknown) {
    // ...error handling...
  }
  return job;
}
```

**Note:** `.get()` is the Drizzle `BetterSQLite3Database` method for single-row query (synchronous). The existing codebase already uses `.all()` for multi-row and `.run()` for mutations. `.get()` is the correct single-row counterpart.

### Anti-Patterns to Avoid

- **Don't await `queue.onEmpty()`** — `onEmpty` only means the queue has no pending tasks to start, NOT that all running tasks have finished. Use `onIdle()` which guarantees `size === 0 && pending === 0`.
- **Don't use `.once('scanComplete', asyncFn)`** — EventEmitter's `.once()` removes the listener synchronously after the first call, before the async function resolves. Use `.on()` + manual `removeListener()` inside the handler.
- **Don't hash the file again in createPathJob** — Reading from `indexed_files` is correct and cheap. If the file was never indexed, `contentHash` will be `''` (acceptable fallback). Re-hashing would require reading the file, adding I/O and path resolution complexity.
- **Don't modify buildFilter() to handle folder** — The existing comment explains why: Qdrant `keyword` indexes are exact-match only, not prefix-capable. Post-filtering remains the correct approach at current scale. The TODO comment in the code should be preserved.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Wait for queue to drain | Custom polling loop or setTimeout | `queue.onIdle()` from p-queue | PQueue's built-in promise resolves exactly when `size === 0 && pending === 0` |
| Single-row DB lookup | Custom iteration | Drizzle `.get()` | Synchronous, correct, already used in the codebase pattern |
| File hash for path job | Direct `fs.readFile` + crypto | DB lookup from `indexed_files` | Already computed during last index; avoids redundant I/O |

**Key insight:** All three fixes are 1–5 line changes. The risk comes from coordination timing (async listener lifecycle), not algorithmic complexity.

## Common Pitfalls

### Pitfall 1: async listener with .once()
**What goes wrong:** `.once(event, asyncFn)` removes the listener after the synchronous call returns, not after the promise resolves. If `asyncFn` is `async`, the listener is removed before `await queue.onIdle()` completes. Multiple `scanComplete` events from future reindexes could then fire without a listener.
**Why it happens:** EventEmitter's `.once()` was designed for synchronous callbacks.
**How to avoid:** Use `.on()` + call `removeListener(event, handler)` explicitly inside the handler body, after awaiting.
**Warning signs:** Tests pass but job transitions to `'completed'` before Qdrant is populated.

### Pitfall 2: pipelineQueue not accessible from adminRoutes test
**What goes wrong:** The test for `createFullJob` uses a mock `fastify` object that doesn't have `pipelineQueue`. Adding `pipelineQueue` decoration means the mock must include it.
**Why it happens:** The existing `service.test.ts` mock only has `indexer` and `db`.
**How to avoid:** When adding `pipelineQueue` decoration, update the mock in `service.test.ts` to include a mock PQueue with `onIdle: vi.fn().mockResolvedValue(undefined)`.
**Warning signs:** `TypeError: this.fastify.pipelineQueue is not a function` in test.

### Pitfall 3: Folder filter changes result count in semantic
**What goes wrong:** After applying folder post-filter, `semantic()` may return fewer than `limit` results even when Qdrant returns exactly `limit` results. This is correct behavior, but tests asserting exact result counts will break.
**Why it happens:** The filter is applied after Qdrant returns `limit` results.
**How to avoid:** Tests should not assert exact counts unless the mock data is controlled to all be within the folder. Update existing test mock data or test with `>= 0` rather than exact counts.
**Warning signs:** Existing tests for semantic search fail after adding folder filter.

### Pitfall 4: TypeScript type declaration for pipelineQueue
**What goes wrong:** `fastify.pipelineQueue` requires a module augmentation declaration in the plugin file, otherwise TypeScript strict mode will reject `fastify.pipelineQueue` in `service.ts`.
**Why it happens:** Fastify uses declaration merging for plugin-added properties.
**How to avoid:** Add `declare module 'fastify' { interface FastifyInstance { pipelineQueue: PQueue } }` in `pipeline.ts`. Import `PQueue` type at top of file for the declaration.
**Warning signs:** TypeScript error `Property 'pipelineQueue' does not exist on type 'FastifyInstance'`.

### Pitfall 5: onScanComplete fires before pipeline has any items
**What goes wrong:** If the vault has no changed files, `eventsEmitted === 0` and `scanComplete` fires immediately. In that case `onIdle()` resolves instantly (queue was never populated). This is the correct and expected behavior — job transitions to `'completed'` immediately.
**Why it happens:** `queue.onIdle()` resolves immediately when already idle.
**How to avoid:** No action needed. This is correct semantics.

## Code Examples

### PQueue.onIdle() — authoritative API
```typescript
// Source: p-queue readme (node_modules/p-queue/readme.md)
// Returns a Promise that resolves when queue.size === 0 && queue.pending === 0
await queue.onIdle();

// Equivalent event-based approach (fires every time, not once):
queue.on('idle', () => {
  console.log(`Queue is idle. Size: ${queue.size}  Pending: ${queue.pending}`);
});
```

### Drizzle .get() for single-row lookup
```typescript
// Source: drizzle-orm BetterSQLite3Database (used throughout codebase)
// .get() returns single row or undefined (synchronous)
const row = this.fastify.db
  .select()
  .from(indexedFiles)
  .where(eq(indexedFiles.path, filePath))
  .get();

const contentHash = row?.contentHash ?? '';
```

### Fastify plugin decoration with type augmentation
```typescript
// Source: existing pattern in src/plugins/qdrant.ts, metrics.ts, etc.
declare module 'fastify' {
  interface FastifyInstance {
    pipelineQueue: PQueue;
  }
}

// Inside plugin function:
fastify.decorate('pipelineQueue', queue);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Post-filter folder only in lexical() | Post-filter folder in both semantic() and lexical() | Phase 13 | Semantic and hybrid searches now respect folder filter |
| Mark job complete on scanComplete | Mark job complete after scanComplete + queue.onIdle() | Phase 13 | Agents see accurate 'completed' status |
| Empty contentHash in path reindex events | Real contentHash from indexed_files | Phase 13 | Qdrant payload stores accurate hash |

**Note preserved:** The TODO comment about adding a Qdrant text index on `path` for native prefix filtering should remain. Post-filtering is still the correct approach at current scale; the TODO is a future optimization path, not a correctness issue.

## Open Questions

1. **Should `createPathJob` handle the case where the file is not in `indexed_files`?**
   - What we know: If the path doesn't exist in the DB, `.get()` returns `undefined`, and `contentHash` falls back to `''` — same as the current buggy behavior.
   - What's unclear: Is this an expected use case (indexing a file for the first time via path reindex)?
   - Recommendation: Keep the `?? ''` fallback. The pipeline will hash the file itself when processing. Tracking the hash in the event is informational metadata; the fix improves the normal case without regression.

2. **Should full reindex wait for the queue or just drain current scan's events?**
   - What we know: `queue.onIdle()` waits until the queue drains fully — including any residual tasks from earlier poll cycles that were already in the queue before the reindex started.
   - What's unclear: Whether this could cause the `'completed'` transition to be delayed by unrelated pre-existing tasks.
   - Recommendation: Accept this behavior. The alternative (tracking only new tasks from this scan) requires injecting task counters into the queue, which is significantly more complex. The current semantics are "queue is idle after scan completes" which is a reasonable definition of "reindex complete."

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (current, configured in project) |
| Config file | vitest.config.ts |
| Quick run command | `pnpm test -- --run src/features/search/__tests__/routes.test.ts src/features/admin/__tests__/service.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RET-05 | folder filter applied in semantic() | unit | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` | Yes (need new test case) |
| RET-05 | folder filter applied in hybrid semantic leg | unit | `pnpm test -- --run src/features/search/__tests__/routes.test.ts` | Yes (need new test case) |
| IDX-13 | full reindex job status only 'completed' after queue drains | unit | `pnpm test -- --run src/features/admin/__tests__/service.test.ts` | Yes (need updated test) |
| IDX-06 | path-scoped reindex uses real contentHash | unit | `pnpm test -- --run src/features/admin/__tests__/service.test.ts` | Yes (need new test case) |

### Sampling Rate
- **Per task commit:** `pnpm test -- --run src/features/search/__tests__/routes.test.ts src/features/admin/__tests__/service.test.ts src/plugins/__tests__/pipeline.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- None — existing test infrastructure covers all phase requirements. New test cases are additions to existing files, not new files.

## Sources

### Primary (HIGH confidence)
- Direct codebase inspection — `src/features/search/service.ts`, `src/features/admin/service.ts`, `src/plugins/pipeline.ts`, `src/lib/indexer.ts`
- `node_modules/p-queue/readme.md` — `onIdle()` API, event model, `size` vs `pending` semantics
- `.planning/v1.0-MILESTONE-AUDIT.md` — exact gap descriptions with affected requirements
- `src/db/schema.ts` — `indexedFiles` schema, `contentHash` field type

### Secondary (MEDIUM confidence)
- Pattern derived from existing `.once()` vs async listener issue — well-documented EventEmitter behavior

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Bug locations: HIGH — directly inspected source code against audit findings
- Fix patterns: HIGH — all patterns (PQueue.onIdle, Drizzle .get, Fastify decorate) are used elsewhere in codebase
- Test impact: HIGH — existing test files identified, specific additions documented
- Edge cases: MEDIUM — open questions documented honestly

**Research date:** 2026-03-12
**Valid until:** 2026-04-12 (stable codebase, no external API changes)
