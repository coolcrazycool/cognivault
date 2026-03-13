---
phase: 05-markdown-indexing-pipeline
plan: "03"
subsystem: pipeline
tags: [pipeline, qdrant, embeddings, fastify-plugin, tdd]
dependency_graph:
  requires: [05-01, 05-02]
  provides: [indexing-pipeline]
  affects: [app.ts, qdrant-collection]
tech_stack:
  added: [gray-matter, p-queue, uuid-v5]
  patterns: [fastify-plugin, event-driven, tdd-red-green, pqueue-concurrency]
key_files:
  created:
    - src/plugins/pipeline.ts
    - src/plugins/__tests__/pipeline.test.ts
  modified:
    - src/app.ts
decisions:
  - "Pipeline is a Fastify plugin (fp-wrapped) with dependencies on indexer, qdrant, embedder, vault, db — enforces correct registration order"
  - "Frontmatter parsed by gray-matter; tags normalised to array (string->array, absent->[]); remaining fields go to extra_metadata as JSON string"
  - "Stale vector cleanup applied on both created and updated events using qdrant.delete with chunk_index range filter"
  - "Frontmatter-only notes (empty chunks after chunkMarkdown) skip embed+upsert but still trigger stale cleanup"
  - "UUID v5 with DNS namespace gives deterministic chunk IDs from '{path}:{chunk_index}'"
  - "PQueue concurrency=3 keeps note processing parallel but bounded; onClose drains queue gracefully"
  - "Test strategy: minimal Fastify app with fp-decorated mocks avoids needing real OpenAI/Qdrant; emitChanges helper invokes listener directly"
metrics:
  duration: 7min
  completed_date: "2026-03-10"
  tasks_completed: 1
  files_changed: 3
---

# Phase 05 Plan 03: Indexing Pipeline Summary

Event-driven indexing pipeline wiring VaultIndexer change events through chunkMarkdown -> embedder -> Qdrant with frontmatter metadata payload and stale vector cleanup.

## What Was Built

`src/plugins/pipeline.ts` is a Fastify plugin (wrapped with `fastify-plugin`) that:

1. Listens to `fastify.indexer`'s `'changes'` EventEmitter event
2. Processes events through a PQueue with concurrency=3:
   - **created/updated**: read content via `fastify.vault.readContent` -> parse frontmatter with gray-matter -> `chunkMarkdown` -> `fastify.embedder.embed` -> `fastify.qdrant.upsert` with metadata payload -> stale cleanup via `qdrant.delete` with `chunk_index >= newCount` range filter -> update `embedding_model_version` in SQLite
   - **deleted**: `fastify.qdrant.delete` with path-only filter
   - **moved**: `fastify.qdrant.setPayload` with new `path` and `title`, no re-embedding
3. Handles partial failures: each event is wrapped in try/catch inside the queue so one file error does not block others
4. Registers an `onClose` hook to remove the listener and drain the queue

### Qdrant Payload Schema Per Chunk

```
{
  id: UUIDv5("{path}:{chunk_index}"),
  vector: number[],
  payload: {
    path, title, chunk_index, section_path,
    tags,           // array (normalised from frontmatter)
    project,        // null if absent
    status,         // null if absent
    type,           // null if absent
    content_hash,
    extra_metadata, // JSON string of remaining frontmatter keys
  }
}
```

## Tests Written (TDD)

15 tests in `src/plugins/__tests__/pipeline.test.ts`:
- created event: payload correctness, UUID v5 format, tags normalization, extra_metadata, stale cleanup
- updated event: re-embed + stale cleanup with chunk_index range filter
- deleted event: path-only filter, no embed/upsert
- moved event: setPayload with path+title, no embed
- frontmatter-only note: no embed, stale cleanup still fires
- partial failure: one event error does not block the next
- deterministic chunk IDs: second call produces same UUID
- plugin lifecycle: listener registered on app.ready, removed on app.close

## Deviations from Plan

None - plan executed exactly as written.

## Self-Check

Files created/modified:
- [x] src/plugins/pipeline.ts — exists
- [x] src/plugins/__tests__/pipeline.test.ts — exists
- [x] src/app.ts — pipelinePlugin imported and registered

Commits:
- [x] acdaaa6 — test(05-03): add failing tests for pipeline plugin
- [x] fc3eaea — feat(05-03): implement indexing pipeline plugin

Test results: 15/15 passing
Typecheck: clean
Lint: exit 0 (only pre-existing info-level fixable suggestions)
