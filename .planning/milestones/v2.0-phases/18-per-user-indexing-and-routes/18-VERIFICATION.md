---
phase: 18-per-user-indexing-and-routes
verified: 2026-03-14T13:30:00Z
status: passed
score: 4/4 success criteria verified
re_verification: false
---

# Phase 18: Per-User Indexing and Routes Verification Report

**Phase Goal:** The indexing pipeline and all API routes operate in multi-tenant mode with per-user OpenAI keys and metrics
**Verified:** 2026-03-14T13:30:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths (Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Each user's vault is indexed independently using their own OpenAI API key for embeddings | VERIFIED | `src/plugins/embedding.ts`: Map<userId, EmbeddingProvider> initialized from registry.getAllUsers(); registry events (user-added/removed/updated) manage lifecycle; createEmbedder uses user.openaiKey |
| 2 | Search, context pack, and admin routes return only data belonging to the authenticated user | VERIFIED | Search routes use `request.getUserQdrant()` (tenant-scoped) + `fastify.getUserEmbedder(userId)`; admin service uses `this.fastify.indexers.get(userId)`; pipeline uses `fastify.createTenantQdrant(userId)` |
| 3 | Prometheus metrics carry a user_id label on every counter/histogram increment | VERIFIED | MetricsCollection interface has user_id on all 8 per-user metrics; every metric call in pipeline.ts, search/routes.ts, context/routes.ts passes `{ user_id: userId }`; removeUserMetrics cleans up on user removal |
| 4 | Adding or removing a user in the registry starts or stops that user's indexer without affecting other users | VERIFIED | `src/plugins/indexer.ts`: registry.on('user-added') calls createUserIndexer + start(); registry.on('user-removed') calls stop() + queue.clear() + await onIdle() + removeUserMetrics() + delete from Map |

**Score:** 4/4 success criteria verified

---

## Required Artifacts

### Plan 01 Artifacts

| Artifact | Provides | Status | Details |
|----------|----------|--------|---------|
| `src/plugins/metrics.ts` | MetricsCollection with user_id labels, contextPacks counter, removeUserMetrics helper | VERIFIED | Interface has `Histogram<'type' \| 'user_id'>`, `Counter<'user_id'>` etc. on all 8 per-user metrics; removeUserMetrics function iterates all types and calls .remove(); decorated on fastify |
| `src/plugins/embedding.ts` | Per-user EmbeddingProvider Map with getUserEmbedder(userId) decorator | VERIFIED | Map<string, EmbeddingProvider>; all 3 registry events handled; getUserEmbedder throws on unknown userId; onClose clears map |
| `src/plugins/qdrant.ts` | Collection creation using DIMENSION_MAP[config.EMBEDDING_MODEL] | VERIFIED | Line 29: `const dimensions = DIMENSION_MAP[config.EMBEDDING_MODEL]`; guard throws on unknown model; fp() dependencies: [] (decoupled from embedder) |
| `src/plugins/db.ts` | getUserDbById(userId) fastify-level accessor for pipeline | VERIFIED | Lines 95-99: `fastify.decorate('getUserDbById', ...)` throws if not found; module augmentation on FastifyInstance |
| `src/config.ts` | OPENAI_API_KEY as optional | VERIFIED | Line 12: `OPENAI_API_KEY: z.string().optional()` |

### Plan 02 Artifacts

| Artifact | Provides | Status | Details |
|----------|----------|--------|---------|
| `src/plugins/indexer.ts` | Per-user VaultIndexer manager with Map<userId, IndexerEntry>, per-user PQueue, registry events | VERIFIED | IndexerEntry = { indexer, queue, vault }; onReady creates indexers for existing users; user-added/removed handlers; onClose stops all; vault path validated via fs.access |
| `src/plugins/pipeline.ts` | Pipeline processing with userId context, per-user resource lookups | VERIFIED | @ts-nocheck removed; processFileChanges(userId, events) decorated; all processing functions accept userId; per-user DB/embedder/Qdrant used throughout |

### Plan 03 Artifacts

| Artifact | Provides | Status | Details |
|----------|----------|--------|---------|
| `src/features/search/routes.ts` | Search routes with per-user embedder and user_id metrics | VERIFIED | All 3 routes (semantic/hybrid/lexical): getUserEmbedder(userId), searchDuration.startTimer with user_id, searchRequests.inc with user_id |
| `src/features/context/routes.ts` | Context routes with per-user embedder and contextPacks metric | VERIFIED | getUserEmbedder(userId); searchRequests.inc with user_id; contextPacks.inc with user_id after assembly |
| `src/features/admin/service.ts` | ReindexService using per-user indexer instances | VERIFIED | createJob accepts userId; createFullJob/createPathJob/createFolderJob all use fastify.indexers.get(userId) or this.fastify.processFileChanges(userId, ...) |
| `src/app.ts` | Full plugin registration with indexer and pipeline re-enabled | VERIFIED | Both imported (lines 14, 16); registered in correct order: pipelinePlugin (line 109) before indexerPlugin (line 110) |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/plugins/embedding.ts` | `src/lib/user-registry.ts` | registry events (user-added/removed/updated) | WIRED | Lines 30, 35, 40: all 3 events handled |
| `src/plugins/qdrant.ts` | `src/lib/embedding.ts` | DIMENSION_MAP import for collection size | WIRED | Line 5: `import { DIMENSION_MAP }`; line 29: `DIMENSION_MAP[config.EMBEDDING_MODEL]` |
| `src/plugins/db.ts` | pipeline (downstream) | getUserDbById fastify decoration | WIRED | fastify.decorate at line 95; used in pipeline.ts at lines 108, 197, 212 |
| `src/plugins/indexer.ts` | `src/plugins/db.ts` | fastify.getUserDbById(userId) for VaultIndexer DB access | WIRED | Line 43: `const db = fastify.getUserDbById(userId)` |
| `src/plugins/indexer.ts` | `src/lib/user-registry.ts` | registry events for lifecycle management | WIRED | Lines 84, 93: user-added and user-removed events |
| `src/plugins/pipeline.ts` | `src/plugins/embedding.ts` | fastify.getUserEmbedder(userId) for per-user embedding | WIRED | Lines 72, 154: `fastify.getUserEmbedder(userId)` |
| `src/plugins/pipeline.ts` | `src/plugins/qdrant.ts` | fastify.createTenantQdrant(userId) for tenant-scoped Qdrant | WIRED | Lines 57, 139, 327, 347: `fastify.createTenantQdrant(userId)` |
| `src/features/search/routes.ts` | `src/plugins/embedding.ts` | fastify.getUserEmbedder(request.user.userId) | WIRED | Lines 28, 73, 118: `fastify.getUserEmbedder(userId)` in all 3 search handlers |
| `src/features/context/routes.ts` | `src/plugins/embedding.ts` | fastify.getUserEmbedder(request.user.userId) | WIRED | Line 32: `fastify.getUserEmbedder(userId)` |
| `src/features/admin/service.ts` | `src/plugins/indexer.ts` | fastify.indexers.get(userId) for per-user reindex | WIRED | Lines 47, 80: `this.fastify.indexers.get(userId)` |
| `src/app.ts` | `src/plugins/pipeline.ts, src/plugins/indexer.ts` | plugin registration (re-enabled) | WIRED | Lines 109-110: `app.register(pipelinePlugin)` then `app.register(indexerPlugin)`; indexer fp() dependencies include 'pipeline' |

---

## Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|-------------|-------------|--------|---------|
| OBS-01 | 18-01, 18-02, 18-03 | Every metric emitted carries a user_id label matching the request's tenant | SATISFIED | MetricsCollection interface has user_id on all 8 per-user metrics; pipeline, search, and context routes all pass user_id on every metric call; REQUIREMENTS.md marks it Complete at Phase 18 |

No orphaned requirements found — REQUIREMENTS.md maps OBS-01 to Phase 18 and all three plans claim it.

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/plugins/indexer.ts` | 39 | `return null` | Info | Expected — sentinel value for "vault path not found, skip indexer creation"; documented behavior, not a stub |

No blocker or warning anti-patterns found. No `@ts-nocheck`, no `describe.skip`, no TODO Phase 18 comments, no placeholder returns in production logic.

---

## Test Suite Results

- **Test files:** 31 passed (31)
- **Tests:** 485 passed (485)
- **TypeScript compilation:** Clean (tsc --noEmit exits 0)
- **Notable coverage:** indexer plugin tests (9 tests), pipeline plugin tests (14 tests), embedding plugin tests (per-user lifecycle), metrics tests (user_id labels, removeUserMetrics, contextPacks)

---

## Human Verification Required

None — all critical behaviors are verified programmatically through the test suite (485 tests) and static code analysis. The per-user embedder lifecycle, metric label propagation, registry event wiring, and plugin registration order are all confirmed in the codebase.

---

## Summary

Phase 18 achieves its goal. The indexing pipeline and all API routes operate in multi-tenant mode:

1. **Per-user embedder isolation:** Each user gets their own `OpenAIEmbeddingProvider` initialized from their `openaiKey` in the user registry. The embedding plugin manages the full lifecycle via registry events.

2. **Data isolation in routes:** All search, context, and admin routes scope data access to the authenticated user via `request.getUserQdrant()` (tenant-filtered Qdrant), `fastify.getUserEmbedder(userId)`, and `fastify.getUserDbById(userId)`.

3. **Metrics with user_id labels:** All 8 per-user metrics carry the `user_id` label on every increment. `removeUserMetrics(userId)` cleans up stale label combinations when a user is removed.

4. **Dynamic indexer lifecycle:** Adding a user triggers `createUserIndexer` + `start()`; removing a user triggers `stop()` + queue drain + metric cleanup, isolated to that user's entry in the Map.

---

_Verified: 2026-03-14T13:30:00Z_
_Verifier: Claude (gsd-verifier)_
