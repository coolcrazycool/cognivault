# Pitfalls Research

**Domain:** Knowledge-access RAG service for Obsidian vaults (vector indexing, hybrid retrieval, multilingual, context assembly)
**Researched:** 2026-03-10
**Confidence:** HIGH (core RAG/indexing pitfalls well-documented across multiple sources; CogniVault-specific combinations at MEDIUM)

## Critical Pitfalls

### Pitfall 1: Naive Markdown Chunking Destroys Retrieval Quality

**What goes wrong:**
Fixed-size text splitting (e.g., 512 tokens with overlap) breaks markdown at arbitrary points -- splitting code blocks, cutting tables in half, separating a heading from its body, or merging unrelated sections into one chunk. Studies show naive chunking achieves faithfulness scores of 0.47-0.51 vs. 0.79-0.82 for structure-aware chunking. For Obsidian vaults with freeform structure, this is especially destructive because notes vary wildly in length and organization.

**Why it happens:**
Developers reach for `RecursiveCharacterTextSplitter` or equivalent as a quick start and never revisit it. Markdown looks like plain text, so the structural signals (headers, lists, code fences, frontmatter) get treated as noise rather than semantic boundaries.

**How to avoid:**
- Split on markdown headers first (H1 > H2 > H3), keeping each section as a chunk candidate.
- Preserve header hierarchy as metadata on each chunk: `section_path: ["Note Title", "## Architecture", "### Data Flow"]`. This is already in PROJECT.md requirements -- enforce it from day one.
- Keep code blocks, tables, and YAML frontmatter intact (never split mid-block).
- For sections exceeding the max chunk size (~512 tokens), split on paragraph boundaries within that section, carrying the section_path metadata forward.
- Strip frontmatter from chunk content but index it as payload metadata (tags, project, status).
- Preserve markdown formatting in chunk text -- the `##` prefix tells an LLM "this was a heading" which aids comprehension.

**Warning signs:**
- Retrieved chunks that start mid-sentence or mid-code-block.
- Search results that match the query but the chunk content is too fragmentary to be useful.
- Chunks where the first line is a continuation of a previous thought.

**Phase to address:**
Phase 1 (Indexing foundation). Chunking quality is the single highest-impact decision in the entire pipeline. Get this right before building retrieval.

---

### Pitfall 2: Stale Vectors After File Edits, Renames, and Deletes

**What goes wrong:**
A note is edited, but old chunks remain in Qdrant alongside new ones. A note is renamed/moved, but vectors still reference the old path. A note is deleted, but its vectors persist. Over weeks, the vector store accumulates ghost data that pollutes search results. This is particularly insidious because retrieval "mostly works" -- stale results mix with fresh ones and nobody notices until an agent acts on outdated information.

**Why it happens:**
The write-then-index path has a gap: the file changes on disk immediately, but re-embedding is async. During that gap, stale vectors are live. Rename/move operations are the worst case -- they look like a delete + create, and if only the "create" side is handled, the old path's vectors remain forever. Obsidian Sync compounds this because synced changes arrive without clear "rename" events -- you see a new file appear and an old file disappear.

**How to avoid:**
- Content hashing in SQLite: store `content_hash` per file. On each poll cycle, compare hashes. Changed hash = delete all old chunks for that path, then re-chunk and re-embed.
- For renames: detect via content hash. If a file disappears at path A and a file with the same hash appears at path B, treat it as a rename (update path in Qdrant payloads, update SQLite) rather than delete+reindex.
- For deletes: if a path exists in SQLite but not on disk, delete all its vectors from Qdrant and remove the SQLite record.
- Use Qdrant's scroll/filter API to verify cleanup: after reindex, count vectors per path and assert it matches expected chunk count.
- Add a Prometheus metric: `cognivault_stale_vectors_cleaned_total` to track how often cleanup runs and catches stale data.

**Warning signs:**
- Vector count in Qdrant grows monotonically even as vault size is stable.
- Search results return content from notes you know were edited/deleted.
- Multiple chunks from the same note with slightly different content (old vs. new versions).

**Phase to address:**
Phase 1-2 (Indexing + Filesystem watching). The cleanup logic must be built into the core indexing loop, not bolted on later.

---

### Pitfall 3: Multilingual Embedding Bias Silently Degrades Russian Retrieval

**What goes wrong:**
Multilingual embedding models (including OpenAI's text-embedding-3) have measurably different retrieval quality across languages. English queries against English content work well. Russian queries against Russian content work acceptably. But the critical failure mode is cross-language: an English technical term query ("ingestion pipeline") failing to retrieve a Russian note that discusses the same concept in Russian, or a Russian query failing to match English code comments within a note. The system appears to work in demos (same-language queries) but fails in production where code-switching is constant.

**Why it happens:**
Embedding models are trained predominantly on English data. Russian performance is lower but not zero, creating a "good enough to ship, bad enough to hurt" situation. The vault's 80%+ Russian content with mixed English technical terms means every query is implicitly cross-lingual. OpenAI's embedding models handle this better than many alternatives but still show retrieval bias toward the query language.

**How to avoid:**
- Use OpenAI text-embedding-3-large (not small) -- larger models show less cross-lingual degradation.
- Build an evaluation set early: 30-50 queries with known-relevant notes, covering pure Russian, pure English, and mixed-language queries. Measure recall@10 for each category separately. If Russian recall is more than 15% below English recall, investigate.
- Lexical search is your safety net for this: exact term matching catches "Compass catalog" or "SLA" regardless of embedding quality. The hybrid fusion (semantic + lexical) design in PROJECT.md is critical -- do not defer lexical search to a later phase.
- Cross-encoder reranking (Cohere multilingual or BGE-reranker-v2-m3) significantly improves multilingual precision on the top-K results. This narrows the language gap.
- Normalize Unicode before embedding: NFC normalization, consistent handling of Cyrillic `e` vs `ё`, Latin look-alikes vs Cyrillic characters (e.g., Latin `c` vs Cyrillic `с`).

**Warning signs:**
- Agents report "can't find X" for notes you know exist -- especially for Russian-language notes retrieved with English queries.
- Retrieval evaluation shows recall divergence between language categories.
- Reranker consistently reorders results significantly (indicating initial retrieval ranking was wrong).

**Phase to address:**
Phase 2-3 (Retrieval implementation). Build the evaluation harness in the same phase as retrieval, not after. Lexical search must ship alongside semantic search, not after.

---

### Pitfall 4: Filesystem Polling Misses Changes or Creates Race Conditions

**What goes wrong:**
Three failure modes: (1) Poll interval too long -- changes sit unindexed for minutes, agents retrieve stale content. (2) Poll catches a file mid-write -- Obsidian Sync writes files in chunks, and reading during sync yields partial/corrupt content. (3) Poll interval too short -- constant disk I/O and hashing burns CPU on large vaults, especially on macOS where stat() on thousands of files is slower than Linux.

**Why it happens:**
Obsidian Sync does not trigger reliable filesystem events (inotify/FSEvents). The PROJECT.md correctly identifies polling as the robust approach. But polling has its own failure modes that are less obvious. The fundamental tension: you want freshness (short interval) but safety (don't read mid-write) and efficiency (don't burn CPU).

**How to avoid:**
- Two-pass stability check: on each poll, record `(path, mtime, size)`. On the *next* poll, if mtime/size changed between polls, the file is still settling -- skip it. Only process files whose mtime/size was stable across two consecutive polls. This handles Obsidian Sync's multi-step writes.
- Content hash before embedding: even after stability check, hash the file content and compare to SQLite. Skip if unchanged. This makes frequent polling cheap (hash comparison) while catching all changes.
- Poll interval: 5-10 seconds is the sweet spot for 500-5000 files. Below 5s, CPU cost on macOS is noticeable. Above 15s, freshness degrades.
- Debounce rapid changes: if a file changes multiple times within a poll window (common during Obsidian editing sessions), only index the final version.
- Log skipped files with reason ("settling", "unchanged", "error reading") for debugging.

**Warning signs:**
- Indexing errors with partial/corrupt file content.
- Files that are "never indexed" because they're always in a settling state.
- High CPU usage from the polling loop on larger vaults.
- Agent complaints about notes not being findable shortly after creation/edit.

**Phase to address:**
Phase 1 (Filesystem layer). This is foundational -- the indexing pipeline cannot be tested without reliable change detection.

---

### Pitfall 5: Embedding Model Version Migration Without Downtime Strategy

**What goes wrong:**
You switch from `text-embedding-3-small` to `text-embedding-3-large` (or from OpenAI to a local model like BGE). Queries now use the new model's embedding space, but existing vectors in Qdrant were embedded with the old model. Cosine similarity between embeddings from different models is meaningless -- retrieval returns garbage. You must re-embed the entire corpus, but during re-embedding (which takes hours for 5000 notes), the system is either down or returning mixed results.

**Why it happens:**
Embedding models produce vectors in incompatible spaces. There is no mathematical relationship between `text-embedding-3-small` and `text-embedding-3-large` vector spaces. This is a known problem, but teams defer the migration strategy until they actually need to migrate, at which point they discover there is no clean path.

**How to avoid:**
- Store `embedding_model_version` in SQLite per-file (already in PROJECT.md requirements). On query, verify that the query embedding model matches the stored model. If mismatch, refuse to search and report the mismatch rather than returning garbage.
- Use Qdrant collection aliases for zero-downtime migration: create new collection `vault_v2`, re-embed into it in background, atomically swap alias from `vault_v1` to `vault_v2`, delete old collection.
- Build the reindex endpoint from the start -- full reindex is not a rare operation, it is a regular maintenance task. Make it resumable (track progress in SQLite so interrupted reindexing can continue).
- For the 500-5000 note scale, full reindex takes 10-30 minutes with OpenAI API (rate limits are the bottleneck). This is fast enough that collection-swap is the right strategy over gradual migration.
- Record the embedding model name and version in the Qdrant collection metadata and in SQLite, not just in config.

**Warning signs:**
- Config references one embedding model but SQLite records show a different model was used.
- Retrieval quality suddenly drops after a deployment change.
- Query latency changes dramatically (different dimension sizes = different performance characteristics).

**Phase to address:**
Phase 1 (Data model design). The version tracking schema must be designed into SQLite and Qdrant from day one, even if migration tooling is built later.

---

### Pitfall 6: Context Pack Assembly That Maximizes Tokens Instead of Relevance

**What goes wrong:**
The context pack endpoint fills the ~32K token budget greedily: stuff in as many retrieved chunks as will fit. The result is a context window full of tangentially related content that dilutes the actually relevant chunks. Research shows accuracy drops 10-20+ percentage points when relevant information is buried in the middle of irrelevant context. Agents make worse decisions with 20 mediocre chunks than with 5 excellent ones.

**Why it happens:**
Token budget feels like a resource to "use efficiently" -- leaving 20K of a 32K budget unused feels wasteful. But context assembly is not bin-packing; it is curation. The retrieval pipeline returns ranked results, but the assembly step often ignores ranking and just fills space.

**How to avoid:**
- Set a relevance floor: after reranking, drop any chunk below a minimum similarity/reranker score. Do not include low-relevance chunks just because budget allows.
- Implement diminishing returns logic: if the 6th chunk's reranker score is less than 70% of the 1st chunk's score, stop adding chunks.
- Deduplicate aggressively: overlapping chunks from the same note or adjacent sections add tokens without adding information. Merge or pick the best.
- Position high-relevance chunks at the start and end of the context pack (avoiding the "lost in the middle" effect).
- Include metadata headers per chunk in the context pack (source note title, section path) so the agent can attribute information. This costs tokens but massively improves agent decision quality.
- Make the relevance floor and max-chunks configurable per request so agents can tune behavior.

**Warning signs:**
- Context packs where most chunks come from different unrelated notes (indicates low-relevance padding).
- Agent responses that reference information from the context pack but misattribute or confuse sources.
- Consistently hitting the full token budget on every request (suggests no quality filtering).

**Phase to address:**
Phase 3 (Context assembly). Build after retrieval and reranking are solid. The assembly layer depends on reranker scores for quality filtering.

---

### Pitfall 7: SQLite and Qdrant Index State Divergence

**What goes wrong:**
SQLite says file X has 5 chunks indexed. Qdrant actually has 3 (two deletes failed silently) or 7 (two old chunks were not cleaned up). The index state tracker and the actual vector store disagree. This divergence compounds over time and is extremely hard to diagnose because everything "looks right" from the application's perspective -- SQLite reports the file as indexed, queries return results, but the results are subtly wrong.

**Why it happens:**
SQLite writes and Qdrant writes are not atomic. A crash or error between "delete old vectors from Qdrant" and "update SQLite record" leaves them inconsistent. Network errors to Qdrant (even on localhost Docker networking) can cause silent failures. Qdrant operations are eventually consistent -- a delete may not be immediately visible.

**How to avoid:**
- Order of operations matters: (1) upsert new vectors to Qdrant, (2) verify upsert with a count/scroll query, (3) delete old vectors from Qdrant, (4) update SQLite. If step 1 or 2 fails, SQLite still reflects the old state (safe to retry). If step 3 fails, you have duplicates (caught by next reconciliation).
- Build a reconciliation job: periodically (e.g., every hour or on-demand via API), compare SQLite chunk counts per file against actual Qdrant vector counts per path. Log discrepancies and auto-repair.
- Use WAL mode for SQLite (`PRAGMA journal_mode=WAL`) for better concurrent read/write performance and crash safety. Set `busy_timeout` to 5000ms to handle lock contention from concurrent agent requests.
- Keep Qdrant point IDs deterministic (e.g., hash of `vault_name + file_path + chunk_index`). This makes upserts idempotent -- re-indexing the same content produces the same IDs and naturally deduplicates.
- Wrap SQLite updates in transactions per-file, not per-chunk.

**Warning signs:**
- Reconciliation job reports count mismatches.
- `cognivault_index_reconciliation_errors` metric trends upward.
- Duplicate chunks in search results (same content, different point IDs).
- "Database is locked" errors in logs (indicates transaction contention).

**Phase to address:**
Phase 1-2 (Core indexing pipeline). Deterministic point IDs and WAL mode should be in the initial schema. Reconciliation job can come in Phase 2.

---

### Pitfall 8: Multi-Format Indexing (PDF/Canvas/Excalidraw) as Afterthought

**What goes wrong:**
The system is designed and tested entirely on markdown files. When PDF, Canvas, Excalidraw, and CSV support is added later, the chunking pipeline, metadata schema, and retrieval logic all assume markdown structure. PDF text extraction produces flat text without headers. Canvas JSON contains node-based content that does not chunk like documents. Excalidraw text is fragmented across drawing elements. Each format requires different chunking logic, but the system has a single rigid pipeline.

**Why it happens:**
Markdown is 80%+ of the vault content, so it is natural to optimize for it. Multi-format support is scoped as "just extract text and run it through the same pipeline." But text extraction quality varies enormously, and structure-aware chunking that works for markdown does not work for other formats.

**How to avoid:**
- Design the chunking pipeline with a `ChunkingStrategy` interface from day one: `chunk(file_content, file_type, metadata) -> Chunk[]`. Each format gets its own strategy implementation.
- For PDFs: extract text with a library that preserves paragraph boundaries (not just raw text dump). Store `source_format: "pdf"` in chunk metadata so retrieval can filter or weight by format.
- For Canvas: each node is a natural chunk. Preserve node relationships in metadata.
- For CSV: each row or logical group of rows is a chunk. Column headers become metadata.
- Defer Excalidraw and image metadata to a later phase -- they add complexity with low ROI at 500-5000 notes scale. But ensure the interface supports them.
- Do NOT attempt to force non-markdown formats through the markdown header splitter.

**Warning signs:**
- PDF chunks that are walls of text with no structure.
- Canvas content that is unchunkable or produces nonsensical chunks.
- Format-specific bugs that require changes to the core chunking pipeline (indicates coupling).

**Phase to address:**
Phase 1 (Design the interface), Phase 2+ (Implement non-markdown strategies). The abstraction boundary must exist from day one even if only markdown is implemented initially.

---

### Pitfall 9: Hybrid Search Fusion Weighting Without Empirical Tuning

**What goes wrong:**
RRF (Reciprocal Rank Fusion) combines semantic and lexical results with a constant `k` parameter (typically 60). Teams pick a value from a blog post, ship it, and never tune it. For CogniVault's mixed Russian/English technical content, the optimal balance between semantic and lexical differs significantly from English-only corpora. Lexical search is disproportionately important for short technical identifiers ("SLA", "Compass", "ingestion") that embedding models handle poorly. With default RRF weights, semantic search dominates and exact-match terms get buried.

**Why it happens:**
RRF "just works" as a reasonable default, so there is no obvious failure -- results are acceptable but not good. Without an evaluation framework, teams cannot measure the impact of different fusion parameters. The degradation is gradual: slightly worse results that agents compensate for by making more queries.

**How to avoid:**
- Build the evaluation harness (30-50 queries with ground truth) before tuning. Measure retrieval precision and recall separately for: pure semantic queries, exact-term queries, mixed queries.
- Make the RRF `k` parameter and the semantic/lexical weight ratio configurable at query time, not just in config.
- Consider a query classifier: if the query contains short exact terms (< 3 words, all ASCII/Latin), boost lexical weight. If the query is a natural language question, boost semantic weight.
- Test with real vault queries from agent logs, not synthetic benchmarks.

**Warning signs:**
- Agents find notes by exact path browsing that search failed to retrieve.
- Short technical term queries return poor results while natural language queries work well (or vice versa).
- Reranker consistently promotes lexical-matched results that semantic search ranked low.

**Phase to address:**
Phase 2-3 (Retrieval implementation and tuning). Build the evaluation harness in the same phase as retrieval. Do not defer tuning to "later."

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Hardcoded embedding model name instead of config/DB tracking | Faster initial development | Cannot detect model mismatch, migration requires code changes | Never -- version tracking is cheap and critical |
| Single chunking pipeline for all formats | Less code initially | Painful refactor when adding PDF/Canvas support, format-specific bugs leak into core pipeline | MVP if markdown-only, but interface must exist |
| No evaluation harness | Ship retrieval faster | Cannot measure regression, cannot tune fusion weights, cannot compare embedding models | Never -- even 20 queries with ground truth is sufficient |
| Synchronous embedding in request path | Simpler architecture | API blocks for 200-500ms per note on write, user-visible latency | Never for write operations; acceptable for manual single-note reindex endpoint |
| Skipping content hash, relying on mtime only | Simpler polling logic | Obsidian Sync can update mtime without changing content (metadata sync), causing unnecessary re-embeds; also misses changes if clock skew occurs | Early prototype only, replace before production |
| Global SQLite lock for all operations | Simple concurrency model | Read operations blocked during reindexing, agent search queries stall | Acceptable if using WAL mode (reads and writes do not block each other) |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Qdrant | Using auto-generated point IDs, making upserts non-idempotent | Use deterministic IDs (hash of path + chunk index) so re-indexing is naturally idempotent |
| Qdrant | Not setting `on_disk: true` for payload indexes on larger collections | Enable on-disk payload indexing for path, tags, project fields to keep memory usage bounded |
| OpenAI Embeddings API | Not handling rate limits (429 errors) during bulk reindex | Implement exponential backoff with jitter; batch embeddings (up to 2048 per request); track rate limit headers |
| OpenAI Embeddings API | Sending empty or whitespace-only text for embedding | Validate chunk content is non-empty and has meaningful tokens before embedding call |
| Cohere Reranker | Sending too many documents per rerank call (latency spike) | Rerank only top-20 from initial retrieval, not all results. Cohere recommends max 100 documents per call |
| SQLite | Not enabling WAL mode, getting "database is locked" under concurrent agent requests | Set `PRAGMA journal_mode=WAL` and `PRAGMA busy_timeout=5000` on connection initialization |
| Docker networking | Assuming Qdrant is always available at startup (container startup order) | Implement health check loop on startup: retry Qdrant connection for 30s before failing. Use `depends_on` with `condition: service_healthy` in docker-compose |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Embedding all chunks sequentially via API | Full reindex takes hours, API costs spike from retries | Batch embeddings (send multiple texts per API call), parallelize with 3-5 concurrent requests | > 1000 notes (single-threaded reindex exceeds 30 min) |
| Loading all file content into memory during poll | Memory spike during full scan of vault | Stream files, process and release one at a time | > 2000 notes with large PDFs |
| Qdrant scroll without limit for cleanup queries | Timeout or OOM on large collections | Always set `limit` on scroll operations, paginate if needed | > 50K vectors (achievable with 5K notes at 10 chunks/note) |
| Cross-encoder reranking on every search | 200-500ms added latency per query | Only rerank when top results have close scores (score spread < threshold), or make reranking optional per request | Noticeable at > 50ms latency budget, but worth the tradeoff for quality |
| Full vault hash scan on every poll cycle | CPU-bound polling loop, I/O contention with Obsidian | Incremental: check mtime first (cheap), only hash files with changed mtime | > 3000 files on macOS (stat() is slower than Linux) |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Path traversal in file operations API | Agent reads/writes files outside vault root (`../../etc/passwd`) | Resolve absolute path after join, verify it starts with vault root. Reject paths with `..` components. Already noted in PROJECT.md -- implement in the filesystem layer, not the API layer |
| API key in query parameters instead of headers | Keys logged in access logs, browser history, proxy logs | Accept API keys only via `Authorization` header, never in URL |
| Embedding API key exposed in health/debug endpoints | OpenAI API key leaked to anyone with service access | Never include secrets in any API response. Use environment variables, never config files in the image |
| No rate limiting on write endpoints | Compromised agent floods vault with files, triggers massive reindex | Per-key rate limits on write operations (e.g., 60 writes/minute) |

## "Looks Done But Isn't" Checklist

- [ ] **Markdown chunking:** Often missing code fence preservation -- verify chunks never split mid-code-block
- [ ] **Frontmatter parsing:** Often missing multiline YAML values and nested objects -- verify with real vault frontmatter, not synthetic examples
- [ ] **File rename handling:** Often missing rename detection (treated as delete + create, causing unnecessary re-embedding) -- verify by renaming a file and checking vector count does not double
- [ ] **Stale vector cleanup:** Often missing orphan detection after partial indexing failures -- verify by killing the service mid-reindex and checking for orphan vectors
- [ ] **Hybrid search:** Often missing lexical search for short queries -- verify that searching for "SLA" returns notes containing exactly "SLA" even if embedding similarity is low
- [ ] **Context pack:** Often missing deduplication of overlapping chunks from the same note -- verify that adjacent sections from one note are merged or deduplicated
- [ ] **Multi-vault isolation:** Often missing cross-vault leakage in search -- verify that searching vault A never returns results from vault B
- [ ] **Unicode normalization:** Often missing Cyrillic/Latin look-alike normalization -- verify that searching for "с" (Cyrillic) matches content with "c" (Latin) in technical terms
- [ ] **Reindex resumability:** Often missing progress tracking -- verify that a killed full reindex can resume from where it stopped, not restart from scratch

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Stale vectors accumulated | LOW | Run full reindex (10-30 min for 5K notes). Deterministic IDs make this safe and idempotent |
| SQLite-Qdrant divergence | LOW | Run reconciliation endpoint. For severe cases, delete SQLite index and run full reindex |
| Wrong embedding model in production | MEDIUM | Create new Qdrant collection, full re-embed with correct model, swap alias. ~30 min + API cost |
| Corrupt chunks from mid-write reads | LOW | Re-poll detects content hash change on next cycle, triggers re-chunk and re-embed automatically |
| Context packs too noisy | LOW | Adjust relevance floor and max-chunks parameters. No reindex needed -- this is query-time configuration |
| Multilingual retrieval bias | MEDIUM | Requires evaluation harness to diagnose, then tuning RRF weights or switching to better multilingual model. May need full reindex |
| Chunking strategy regression | HIGH | Changing chunking logic requires full reindex of all vaults. Design chunking versioning from the start to avoid surprise full reindexes |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Naive markdown chunking | Phase 1: Indexing foundation | Inspect 20 random chunks from real vault, verify none are split mid-block |
| Stale vectors | Phase 1-2: Indexing + filesystem watching | Delete/rename 5 notes, verify vector count decreases correctly after next poll |
| Multilingual embedding bias | Phase 2-3: Retrieval + evaluation | Evaluation harness shows < 15% recall gap between Russian and English query sets |
| Filesystem polling race conditions | Phase 1: Filesystem layer | Edit a note during sync simulation, verify no corrupt chunks are indexed |
| Embedding version migration | Phase 1: Data model design | Version field exists in SQLite, mismatch detection works before first reindex |
| Context pack relevance | Phase 3: Context assembly | Context packs with low-relevance queries return fewer chunks (not padding to budget) |
| SQLite-Qdrant divergence | Phase 2: Reconciliation | Run reconciliation after 100-file reindex, zero discrepancies |
| Multi-format afterthought | Phase 1: Interface design | ChunkingStrategy interface exists with markdown implementation; adding PDF does not modify core |
| Hybrid fusion weighting | Phase 2-3: Retrieval + tuning | Evaluation harness with exact-term queries shows acceptable precision |

## Sources

- [Top 10 RAG Mistakes Developers Make](https://ergobite.com/us/top-rag-mistakes-developers-make-and-how-to-fix-them/)
- [Document Chunking for RAG: 9 Strategies Tested](https://langcopilot.com/posts/2025-10-11-document-chunking-for-rag-practical-guide)
- [Best Chunking Strategies for RAG in 2026](https://www.firecrawl.dev/blog/best-chunking-strategies-rag)
- [Building and Evaluating Multilingual RAG Systems (Microsoft)](https://medium.com/data-science-at-microsoft/building-and-evaluating-multilingual-rag-systems-943c290ab711)
- [Beyond English: Implementing a Multilingual RAG Solution](https://towardsdatascience.com/beyond-english-implementing-a-multilingual-rag-solution-12ccba0428b6/)
- [Structured RAG for Unknown and Mixed Languages](https://www.jocheojeda.com/2026/01/05/structured-rag-for-unknown-and-mixed-languages/)
- [The Cross-Lingual Cost: Retrieval Biases in RAG](https://arxiv.org/html/2507.07543)
- [Different Embedding Models, Different Spaces: The Hidden Cost of Model Upgrades](https://medium.com/data-science-collective/different-embedding-models-different-spaces-the-hidden-cost-of-model-upgrades-899db24ad233)
- [Qdrant Collection Aliases for Zero-Downtime Migration](https://qdrant.tech/documentation/concepts/collections/)
- [SQLite Concurrent Writes and "Database is Locked" Errors](https://tenthousandmeters.com/blog/sqlite-concurrent-writes-and-database-is-locked-errors/)
- [How to Corrupt an SQLite Database File](https://sqlite.org/howtocorrupt.html)
- [RAG vs Large Context Window Trade-offs](https://redis.io/blog/rag-vs-large-context-window-ai-apps/)
- [Enterprise RAG: Common Pitfalls and Solutions](https://wearefram.com/blog/enterprise-rag/)
- [Migrating Vector Embeddings to Qdrant: Challenges and Learnings](https://0xhagen.medium.com/migrating-vector-embeddings-from-postgresql-to-qdrant-challenges-learnings-and-insights-f101f42f78f5)
- [Syncthing: Polling vs. File System Watch](https://forum.syncthing.net/t/polling-vs-file-system-watch/953)

---
*Pitfalls research for: CogniVault -- Obsidian knowledge service with vector indexing and hybrid retrieval*
*Researched: 2026-03-10*
