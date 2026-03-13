# Phase 8: Context Pack Assembly - Research

**Researched:** 2026-03-11
**Domain:** Context assembly pipeline — hybrid search orchestration, token-budget enforcement, note merging, section classification
**Confidence:** HIGH

## Summary

Phase 8 adds a single POST endpoint (`/api/vault/context`) that orchestrates the existing hybrid search infrastructure into a higher-level "context pack" — a structured, token-budgeted knowledge bundle suitable for direct LLM prompt injection. All primitives are already present in the codebase: `SearchService.hybrid()` returns RRF-fused results with scores, `js-tiktoken` handles token counting, and the Qdrant payload includes the `type` field that drives section classification. No new dependencies are required.

The assembly pipeline is a pure TypeScript transformation: fetch top 50 hybrid results, apply a relevance floor (default 0.3), group chunks from the same note, sort groups by highest chunk score, fill from highest relevance until the token budget is exhausted, then organize surviving entries into five named sections. The response envelope wraps these sections with a `meta` block that provides token accounting so agents can calibrate future requests.

The work decomposes cleanly into three tasks: (1) TypeBox schemas + route registration, (2) `ContextService` with the assembly pipeline, and (3) route tests using the established `buildTestApp` + mock-qdrant pattern.

**Primary recommendation:** Build `src/features/context/` as a standard Fastify feature module. Reuse `SearchService`, `SearchFiltersSchema`, `ErrorResponseSchema`, and `js-tiktoken` exactly as they are — no modifications to upstream code needed.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Pack structure & sections**
- Context pack organized by classified section types: summary, architecture, adrs, glossary, implementation
- Fixed five-section set from CTX-03 requirements — unrecognized frontmatter types map to "implementation" as catch-all
- Classification driven by frontmatter `type` field (already in Qdrant payload); fallback by folder path heuristic (e.g., ADRs/ folder -> adrs section)
- Empty sections omitted from response — only sections with matching chunks are included
- Chunks from the same note merged into a single entry preserving original section order (by chunk_index)

**Token budget allocation**
- Relevance-first, no per-section caps — fill budget with highest-relevance chunks regardless of section type
- Default token budget: 32K tokens; agent-configurable range: 1K-128K via `token_budget` request field
- Response meta includes: total_tokens (actual used), token_budget (requested), chunks_included, chunks_excluded (below floor)
- Token counting via js-tiktoken (already in use by chunker)

**Relevance floor & filtering**
- Fixed default relevance floor at 0.3 (hybrid RRF scores); agent-adjustable via `min_score` in request body (0.0-1.0)
- Quality over quantity: if few chunks pass the floor, return a smaller pack — never lower the floor automatically
- Fetch top 50 chunks from hybrid search, then apply relevance floor, then fill token budget from remaining
- Accepts same `filters` object as search endpoints (tags, project, status, folder) — passed through to underlying hybrid search

**Request contract & citations**
- Endpoint: POST /api/vault/context (own route, not under search namespace)
- Request body: `{ query, token_budget?, min_score?, filters? }` — query required, rest optional with defaults
- Per-entry source metadata: each entry includes `source: { path, title, sections: [...], score }` and `text` (merged chunk content)
- Entries within a merged note keep original section order (chunk_index) for coherent reading

### Claude's Discretion
- Folder path heuristic rules for section type classification
- Position-aware ordering (high-relevance entries at start/end of pack)
- Internal assembly pipeline architecture (service class structure)
- Exact meta field naming and response envelope structure
- Error handling for empty results, Qdrant timeouts
- How to handle chunks with no frontmatter type and no recognizable folder path

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CTX-01 | Agent can request structured context pack for a given task/query | POST /api/vault/context endpoint with `{ query, ... }` body; `ContextService.assemble()` orchestrates the pipeline |
| CTX-02 | Context pack respects configurable token budget (default ~32K) | `js-tiktoken` `getEncoding('cl100k_base')` counts tokens per merged entry; greedy fill stops when budget exhausted; `token_budget` request param with 1K-128K range |
| CTX-03 | Context pack includes project summary, architecture notes, ADRs, glossary, implementation notes with source citations | Five fixed sections (summary/architecture/adrs/glossary/implementation); classification via `type` payload field + folder heuristic; each entry carries `source: { path, title, sections, score }` |
| CTX-04 | Context pack applies relevance floor filtering (not greedy bin-packing) | `min_score` floor (default 0.3) applied before budget fill; excluded chunks counted in `meta.chunks_excluded`; floor never auto-lowered |
</phase_requirements>

---

## Standard Stack

### Core (already installed — no new dependencies needed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| js-tiktoken | ^1.0.21 | Token counting for budget enforcement | Already used in chunker; same encoder (`cl100k_base`) guarantees consistent token counts |
| @sinclair/typebox | ^0.34.48 | Request/response schemas for the new endpoint | Project standard for all route schemas |
| fastify | ^5.8.2 | HTTP layer — register context routes as plugin | Project framework |
| SearchService (internal) | — | Hybrid search with RRF; called with limit=50 | Already validated in Phase 7 |

### No New Dependencies
The entire phase is implementable with existing installed packages. `js-tiktoken` is already in `dependencies` (not devDependencies). TypeBox, Fastify plugin patterns, and SearchService are all in place.

**Installation:**
```bash
# Nothing new to install
```

---

## Architecture Patterns

### Recommended Project Structure
```
src/
  features/
    context/
      routes.ts        # POST /api/vault/context handler; registers as Fastify plugin
      schemas.ts       # TypeBox: ContextRequestBodySchema, ContextResponseSchema, ContextEntrySchema
      service.ts       # ContextService class with assemble() method
      __tests__/
        routes.test.ts # fastify.inject() tests with mocked qdrant/embedder
```

Registration in `src/app.ts`:
```typescript
await app.register(contextRoutes, { prefix: '/api/vault' });
```
This makes the full URL `/api/vault/context`.

### Pattern 1: SearchService Reuse (established)
**What:** Instantiate `SearchService` per-request inside the route handler, call `.hybrid(query, 50, filters)`.
**When to use:** Always — matches established pattern from search routes.
```typescript
// Source: src/features/search/routes.ts (established pattern)
const searchService = new SearchService(fastify.qdrant, fastify.embedder);
const results = await searchService.hybrid(query, 50, filters ?? {});
```

### Pattern 2: Assembly Pipeline (new — ContextService)
**What:** Pure function pipeline that transforms `SearchResult[]` → `ContextPack`.
**Steps:**
1. Apply relevance floor: `results.filter(r => r.score >= minScore)`
2. Group by path: `Map<string, SearchResult[]>` — keys are note paths
3. Sort each group by `section_path` to infer chunk_index order (section_path encodes hierarchy)
4. Merge group text: join chunk texts in order, compute merged token count
5. Sort groups by max chunk score (highest-score group first)
6. Greedy budget fill: accumulate groups until `totalTokens + entry.tokens > tokenBudget`
7. Classify each surviving entry into a section type
8. Assemble response

```typescript
// Source: design derived from CONTEXT.md locked decisions
export class ContextService {
  assemble(results: SearchResult[], opts: AssembleOptions): ContextPack {
    const aboveFloor = results.filter(r => r.score >= opts.minScore);
    const excluded = results.length - aboveFloor.length;

    // Group by path, sort each group by section order
    const groups = this.groupByPath(aboveFloor);

    // Sort groups by highest score descending
    groups.sort((a, b) => b.maxScore - a.maxScore);

    // Greedy fill within token budget
    let totalTokens = 0;
    const included: ContextEntry[] = [];
    for (const group of groups) {
      const tokens = countTokens(group.mergedText);
      if (totalTokens + tokens > opts.tokenBudget) break;
      totalTokens += tokens;
      included.push(this.toEntry(group));
    }

    // Classify and organize into sections
    return this.buildPack(included, { totalTokens, tokenBudget: opts.tokenBudget,
      chunksIncluded: included.length, chunksExcluded: excluded });
  }
}
```

### Pattern 3: Section Classification
**What:** Map each entry to one of five fixed section names.
**Classification priority:** frontmatter `type` field first, folder path heuristic second, "implementation" fallback.

```typescript
// Source: design from CONTEXT.md locked decisions
type SectionName = 'summary' | 'architecture' | 'adrs' | 'glossary' | 'implementation';

const TYPE_TO_SECTION: Record<string, SectionName> = {
  'summary': 'summary',
  'overview': 'summary',
  'architecture': 'architecture',
  'arch': 'architecture',
  'adr': 'adrs',
  'decision': 'adrs',
  'glossary': 'glossary',
  'definition': 'glossary',
  // anything else → 'implementation' (catch-all)
};

function classifyEntry(result: SearchResult, path: string): SectionName {
  // 1. frontmatter type field (already in SearchResult? — see note below)
  // 2. folder heuristic
  if (path.toLowerCase().includes('/adr') || path.toLowerCase().includes('/decisions')) return 'adrs';
  if (path.toLowerCase().includes('/architecture') || path.toLowerCase().includes('/arch')) return 'architecture';
  if (path.toLowerCase().includes('/glossary') || path.toLowerCase().includes('/definitions')) return 'glossary';
  if (path.toLowerCase().includes('/summary') || path.toLowerCase().includes('/overview')) return 'summary';
  return 'implementation';
}
```

**Important: `type` field gap in SearchResult.** The current `SearchResult` type (from `search/schemas.ts`) does NOT include a `type` field — the Qdrant payload has it, but `toSearchResult()` in `service.ts` discards it. The `ContextService` needs `type` for classification. Two options:
1. Extend `SearchResult` to include `type: string | null` (preferred — upstream change is clean)
2. Make a parallel result type in the context feature

The simplest approach is to add `type: Type.Union([Type.String(), Type.Null()])` to `SearchResultSchema` and expose it in `toSearchResult()`. This is a non-breaking additive change.

### Pattern 4: TypeBox Response Schema Shape
**What:** Context pack response schema following project conventions.
**Structure:**

```typescript
// Source: TypeBox pattern from src/features/search/schemas.ts
const ContextSourceSchema = Type.Object({
  path: Type.String(),
  title: Type.String(),
  sections: Type.Array(Type.String()),  // section_path values from merged chunks
  score: Type.Number({ minimum: 0, maximum: 1 }),
});

const ContextEntrySchema = Type.Object({
  text: Type.String(),         // merged chunk content in section order
  source: ContextSourceSchema,
  section: Type.Union([
    Type.Literal('summary'),
    Type.Literal('architecture'),
    Type.Literal('adrs'),
    Type.Literal('glossary'),
    Type.Literal('implementation'),
  ]),
});

const ContextMetaSchema = Type.Object({
  total_tokens: Type.Integer(),
  token_budget: Type.Integer(),
  chunks_included: Type.Integer(),
  chunks_excluded: Type.Integer(),
  query_ms: Type.Integer(),
});

const ContextPackSchema = Type.Object({
  summary: Type.Optional(Type.Array(ContextEntrySchema)),
  architecture: Type.Optional(Type.Array(ContextEntrySchema)),
  adrs: Type.Optional(Type.Array(ContextEntrySchema)),
  glossary: Type.Optional(Type.Array(ContextEntrySchema)),
  implementation: Type.Optional(Type.Array(ContextEntrySchema)),
  meta: ContextMetaSchema,
});
```

### Anti-Patterns to Avoid
- **Per-section token caps:** User explicitly decided relevance-first, no caps. Do not add per-section limits.
- **Auto-lowering the floor:** If few results pass min_score, return a small pack. Never reduce min_score silently.
- **Greedy chunk-level packing:** Merge note chunks before budget check. Budget applies to merged note entries, not individual raw chunks. This preserves coherent note context.
- **Modifying SearchService for context:** The service is stateless and general-purpose. Instantiate it inside the context route handler just like search routes do.
- **New Fastify plugin dependencies:** Context feature uses `fastify.qdrant` and `fastify.embedder` via SearchService — no new `fastify.decorate()` needed.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Token counting | Custom word-count heuristic | `js-tiktoken` `getEncoding('cl100k_base')` | cl100k_base is the correct encoder for GPT-3.5/4 models; word count diverges by 20-40% |
| Hybrid retrieval | Direct Qdrant calls in context service | `SearchService.hybrid()` | Already validated, handles RRF fusion, filters, score normalization |
| Schema validation | Manual body parsing | TypeBox + Fastify type-provider | Automatic 400 errors, OpenAPI compatibility, compile-time types |
| Error responses | Custom error objects | `ErrorResponseSchema` from vault/schemas.ts | Consistent `{ error: { code, message } }` shape across all endpoints |

**Key insight:** The entire context pack pipeline is a transformation layer above existing infrastructure. No new infrastructure is needed.

---

## Common Pitfalls

### Pitfall 1: SearchResult Missing `type` Field
**What goes wrong:** Classification falls through to folder heuristic for every entry because `type` is always `undefined`.
**Why it happens:** `SearchResult` schema and `toSearchResult()` were defined before the context feature was planned. The `type` field exists in Qdrant payload but is currently stripped.
**How to avoid:** Add `type: Type.Union([Type.String(), Type.Null()])` to `SearchResultSchema` and update `toSearchResult()` in `service.ts`. This is a one-line schema addition and a one-line mapping addition — non-breaking since it's additive.
**Warning signs:** All entries land in "implementation" section regardless of vault content.

### Pitfall 2: Token Count Measured on Raw Chunks vs Merged Text
**What goes wrong:** Budget is enforced per-chunk before merging, causing either under-filling (budget not fully used) or silent over-fill (merged text exceeds budget after joining).
**Why it happens:** Merging adds whitespace/separator tokens; counting before merge gives incorrect totals.
**How to avoid:** Count tokens on the fully merged string for each note group, then apply budget check on that merged token count.

### Pitfall 3: Chunk Order in Merged Notes
**What goes wrong:** Chunks from the same note are merged in arrival order (hybrid search score order), producing incoherent text.
**Why it happens:** Hybrid search returns results sorted by RRF score, not document order.
**How to avoid:** After grouping by path, sort each group's chunks by `section_path` lexicographically to approximate document order. Note: `section_path` encodes hierarchy (`"Title > H2 > H3"`), so alphabetic sort approximates document order for most vaults. The `chunk_index` is NOT in `SearchResult` (it is a Qdrant payload field not currently surfaced). If exact ordering is critical, consider sorting by `section_path` depth-first.

### Pitfall 4: TypeBox Optional Sections in Response
**What goes wrong:** TypeBox `Type.Optional()` on response fields can cause Fastify's serializer to strip fields entirely when empty arrays would be fine, or include undefined fields in JSON output.
**Why it happens:** Fastify uses fast-json-stringify under the hood; `Optional` fields with `undefined` values are dropped — this is correct behavior and desired (empty sections omitted per locked decision).
**How to avoid:** Build the response object by only including section keys that have entries. Don't include a key for an empty array. TypeBox `Type.Optional()` is the right choice here.

### Pitfall 5: RRF Score Range for `min_score`
**What goes wrong:** Agent passes `min_score: 0.5` expecting to filter to "highly relevant" results, but gets an empty pack because hybrid RRF scores are inherently small (e.g., max ~0.032 for top result with K=60).
**Why it happens:** Raw RRF scores are clamped to [0,1] in `hybrid()` but the natural range before clamping is approximately 0.0 to 0.033. The `normalizeScore()` method clamps to [0,1] but does NOT normalize relative to max — per the Phase 7 decision "Raw RRF scores used (no relative normalization)".
**How to avoid:** Document in response or API spec that hybrid scores are RRF values (typically 0.008–0.033 range). Default `min_score: 0.3` will pass most results. However, re-examine: the decision says default floor is 0.3 against hybrid scores that max at ~0.033. This means the default floor of 0.3 would EXCLUDE ALL results since no RRF score reaches 0.3.

**Critical resolution needed:** Either:
1. The `min_score` floor is applied against the raw RRF score (values ~0.008–0.033), making 0.3 the wrong default, OR
2. The scores are normalized (relative to the max score in the batch) before floor filtering

The CONTEXT.md says "Fixed default relevance floor at 0.3 (hybrid RRF scores)". This is likely intended as a normalized/relative scale. The planner should clarify whether `min_score` applies to raw RRF values or normalized scores, and default to a value that makes practical sense. A safe default for raw RRF is 0.005 (roughly "appeared in at least one source"). If the intent is qualitative filtering, normalize scores before applying the floor.

**Recommended resolution (Claude's discretion):** Apply the floor against normalized scores: divide each score by the max score in the fetched batch before comparison. This makes `min_score: 0.3` mean "at least 30% of top relevance" — a sensible qualitative filter. Document this in the route schema description.

### Pitfall 6: Test App Setup (established pattern)
**What goes wrong:** Tests fail with confusing errors because the real vault/db/Qdrant plugins are registered.
**Why it happens:** `buildApp()` registers all plugins including real filesystem and DB access.
**How to avoid:** Use the isolated `buildTestApp()` pattern from `search/__tests__/routes.test.ts` — build a minimal Fastify instance, decorate with mock qdrant/embedder, register only error-handler + auth + context routes.

---

## Code Examples

Verified patterns from codebase inspection:

### Token Counting (from src/lib/chunker.ts)
```typescript
// Source: src/lib/chunker.ts (verified in codebase)
import { getEncoding } from 'js-tiktoken';
const enc = getEncoding('cl100k_base');  // initialize once at module level

function countTokens(text: string): number {
  return enc.encode(text).length;
}
```
Note: Initialize the encoder at module level (expensive). Do not create a new encoder per request.

### SearchService Instantiation Pattern (from src/features/search/routes.ts)
```typescript
// Source: src/features/search/routes.ts (verified in codebase)
const searchService = new SearchService(fastify.qdrant, fastify.embedder);
const results = await searchService.hybrid(query, 50, filters ?? {});
```

### Fastify Plugin Registration (from src/app.ts)
```typescript
// Source: src/app.ts (verified in codebase)
await app.register(contextRoutes, { prefix: '/api/vault' });
// Results in: POST /api/vault/context
```

### TypeBox Optional Fields in Response (from codebase pattern)
```typescript
// Source: TypeBox pattern — Optional fields are omitted from JSON when undefined
const ContextPackSchema = Type.Object({
  summary: Type.Optional(Type.Array(ContextEntrySchema)),
  // ... other sections
  meta: ContextMetaSchema,
});
// Build response: only include keys with non-empty arrays
const response: Record<string, unknown> = { meta };
if (summaryEntries.length > 0) response.summary = summaryEntries;
// etc.
```

### Test App Pattern with Mocked Services (from src/features/search/__tests__/routes.test.ts)
```typescript
// Source: src/features/search/__tests__/routes.test.ts (verified in codebase)
process.env.COGNIVAULT_API_KEY = 'test-key';
process.env.VAULT_PATH = '/tmp/test-vault';
process.env.OPENAI_API_KEY = 'test-openai-key';

async function buildTestApp(): Promise<FastifyInstance> {
  const { default: Fastify } = await import('fastify');
  const app = Fastify({ logger: false });
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  app.decorate('qdrant', mockQdrant as any);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  app.decorate('embedder', mockEmbedder as any);
  const { default: errorHandler } = await import('../../../plugins/error-handler.js');
  await app.register(errorHandler);
  const { default: authPlugin } = await import('../../../plugins/auth.js');
  await app.register(authPlugin);
  const { contextRoutes } = await import('../routes.js');
  await app.register(contextRoutes, { prefix: '/api/vault' });
  await app.ready();
  return app;
}
```

---

## State of the Art

| Old Approach | Current Approach | Notes |
|--------------|-----------------|-------|
| Greedy bin-packing (fill every token) | Relevance floor + budget fill | Better quality; smaller packs with higher precision |
| Per-section caps | Relevance-first, no caps | Avoids over-weighting rare section types |
| Chunk-level context | Merged note entries | Agents see coherent content as author wrote it |

---

## Open Questions

1. **RRF score range vs min_score default of 0.3**
   - What we know: Raw RRF scores max at ~0.033 for K=60; CONTEXT.md says default floor is 0.3 against "hybrid RRF scores"
   - What's unclear: Whether 0.3 is intended against raw or normalized scores
   - Recommendation: Normalize scores per batch (divide by max) before applying floor; document this; use 0.3 as default against normalized scale. Alternatively, treat the floor as post-normalization and set raw floor to something like 0.005 if normalization is undesired.

2. **`type` field in SearchResult**
   - What we know: `type` is in Qdrant payload; `SearchResult` schema currently omits it
   - What's unclear: Whether to add `type` to `SearchResult` or create a parallel type
   - Recommendation: Add `type: string | null` to `SearchResult` (additive, non-breaking). This benefits future features too.

3. **Section ordering within sections**
   - What we know: CONTEXT.md mentions "position-aware ordering (high-relevance entries at start/end of pack)" as Claude's discretion
   - What's unclear: Whether this means entries within each section are ordered by score, or if it means high-relevance entries go to top of overall pack
   - Recommendation: Within each section, order entries by descending score. Across the whole pack, use the section insertion order (summary, architecture, adrs, glossary, implementation).

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.0.18 |
| Config file | `vitest.config.ts` (root) |
| Quick run command | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CTX-01 | POST /api/vault/context returns 200 with structured pack | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | Wave 0 |
| CTX-01 | Returns 400 for missing/empty query | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | Wave 0 |
| CTX-01 | Returns 401 without auth token | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | Wave 0 |
| CTX-01 | Each entry includes `source.path`, `source.title`, `source.sections`, `source.score`, and `text` | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | Wave 0 |
| CTX-02 | Response meta.total_tokens does not exceed token_budget | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | Wave 0 |
| CTX-02 | Custom token_budget respected (e.g., 1000 tokens) | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | Wave 0 |
| CTX-03 | Chunks classified into correct sections by `type` field | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | Wave 0 |
| CTX-03 | Empty sections omitted from response | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | Wave 0 |
| CTX-03 | Chunks from same note merged preserving section order | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | Wave 0 |
| CTX-04 | Chunks below min_score excluded; chunks_excluded count correct | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | Wave 0 |
| CTX-04 | min_score=1.0 returns empty sections (all excluded) | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | Wave 0 |
| CTX-04 | Default min_score (no override) applied correctly | unit | `pnpm test -- --run src/features/context/__tests__/routes.test.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test -- --run src/features/context/__tests__/routes.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/features/context/__tests__/routes.test.ts` — covers all CTX-01 through CTX-04
- [ ] `src/features/context/routes.ts` — route handler
- [ ] `src/features/context/schemas.ts` — TypeBox schemas
- [ ] `src/features/context/service.ts` — ContextService assembly pipeline

*(No new test infrastructure needed — Vitest and existing mock patterns are sufficient)*

---

## Sources

### Primary (HIGH confidence)
- Codebase inspection: `src/features/search/service.ts` — SearchService hybrid() signature, limit parameter, SearchResult type
- Codebase inspection: `src/lib/chunker.ts` — js-tiktoken usage pattern, getEncoding('cl100k_base')
- Codebase inspection: `src/features/search/schemas.ts` — SearchFiltersSchema, SearchResultSchema, TypeBox patterns
- Codebase inspection: `src/app.ts` — plugin registration order, route prefix pattern
- Codebase inspection: `src/features/search/__tests__/routes.test.ts` — test app construction with mocked qdrant/embedder
- Codebase inspection: `vitest.config.ts` — test include pattern, passWithNoTests
- Codebase inspection: `package.json` — verified all dependencies present (js-tiktoken, typebox, fastify, vitest)
- `.planning/phases/08-context-pack-assembly/08-CONTEXT.md` — locked decisions and discretion areas

### Secondary (MEDIUM confidence)
- `.planning/STATE.md` accumulated decisions — Phase 07-01 RRF score decisions (K=60 hardcoded, raw scores, no normalization)
- `.planning/REQUIREMENTS.md` — CTX-01 through CTX-04 requirement text

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified present in package.json at exact versions
- Architecture patterns: HIGH — derived directly from existing codebase patterns (search feature as template)
- Assembly pipeline: HIGH — all inputs/outputs fully specified in CONTEXT.md locked decisions
- RRF score floor issue: MEDIUM — identified a likely discrepancy; requires planner attention
- Pitfalls: HIGH — identified from direct codebase inspection (type field gap, score range issue confirmed)

**Research date:** 2026-03-11
**Valid until:** 2026-06-11 (stable stack, no fast-moving dependencies)
