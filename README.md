# CogniVault

Knowledge access layer for AI agents working with Obsidian vaults. CogniVault indexes your
vault, embeds it, and exposes a REST API for hybrid retrieval, context assembly and file
management — giving AI tools structured access to your knowledge base.

The repository holds two services:

- **`src/`** — the CogniVault backend: Node.js 22 / Fastify / TypeScript. Indexing,
  retrieval, vault CRUD, admin. This is what the README below documents.
- **`cognivault-ui/`** — a Python/FastAPI chat UI that talks to that REST API and to
  GigaChat. It has its own docs; only its interaction with the backend appears here.

## Features

- **Hybrid retrieval** — a single Qdrant Query API call runs a dense (embedding) branch
  and a sparse BM25 branch in parallel and fuses them server-side with RRF
- **Small-to-big** — a matched chunk can be expanded to the full text of its section
  (`group_by_section`), which is kept in SQLite rather than in the vector payload
- **Context packing** — token-budgeted context packs assembled from search results
- **Vault management** — CRUD on notes with frontmatter support, plus zip upload
- **Multi-tenant** — per-user vaults, SQLite databases and Qdrant payload isolation
- **Auto-indexing** — the vault directory is polled and re-indexed on change
- **Multi-format** — Markdown, PDF, CSV, Excalidraw, Canvas
- **Two embedding providers** — OpenAI, or GigaChat over mTLS for closed networks
- **Observability** — Prometheus metrics, Grafana dashboards, OpenTelemetry tracing
- **OpenAPI** — auto-generated Swagger UI at `/docs`

## How retrieval works

The collection carries **named vectors**: a dense `dense` vector (the embedding) and a
sparse `bm25` vector. Both are written for every point at index time.

- **`/api/vault/search/semantic`** — dense only. Scores are cosine similarity, clamped to
  `[0, 1]`, so they are comparable across requests.
- **`/api/vault/search/lexical`** — sparse only. `src/lib/bm25.ts` tokenizes the query,
  stems Russian words with a vendored Snowball stemmer (Latin words, digits and acronyms
  are left alone — that is the whole point of the lexical branch) and hashes each term
  with FNV-1a into a `u32` index. A compound identifier also yields its **joined** form on
  top of its fragments (`afpc_sss_src.cards_event` → the five fragments *and*
  `afpcssssrccardsevent`): the fragments are shared by every sibling page of a registry,
  the joined term is not. Only the term-frequency part of BM25 is computed here;
  the IDF factor is applied by Qdrant via `sparse_vectors: { bm25: { modifier: 'idf' } }`.
- **`/api/vault/search/hybrid`** — one `client.query` call with two `prefetch` branches
  (dense + bm25, each oversampled to `max(2 × limit, 40)` candidates) and
  `query: { fusion: 'rrf' }`. The tenant wrapper injects the `user_id` condition into the
  outer filter *and* into every prefetch branch.

**Scores from `hybrid` and `lexical` are rescaled against the top hit of the result set**
(rank 1 becomes `1.0`). Raw RRF sums land in a ~0.016–0.033 band and raw BM25 sums are
unbounded, so neither is meaningful on its own or against a fixed threshold. Order is never
changed by the rescaling. Only `semantic` returns an absolute score.

The index-time and query-time sparse vectors **must** come from the same functions in
`src/lib/bm25.ts`, or terms stop lining up and the lexical branch silently returns nothing.
The index side calls `buildDocumentSparseVector`, which counts the chunk's breadcrumb
(its first line) `BM25_BREADCRUMB_BOOST` times over — sibling pages of a registry often
differ in nothing but their title. That is a *weighting* difference only: the terms still
come from the same `tokenize`, so the two sides agree term for term. Both facts are pinned
by `BM25_SCHEME_VERSION`; bumping it means old vectors are no longer comparable to new
ones and the collection has to be rebuilt.

That version is **enforced, not documented**. The service stamps it onto every collection
it creates (payload `bm25_scheme_version` on a vector-less, tenant-less marker point) and
compares it on every start. A collection built at an older version keeps serving — dense
retrieval is untouched — but startup logs an error naming both versions and the metric
`cognivault_bm25_scheme_mismatch` goes to `1`, so shipping a bump without the re-index is
no longer silent. Startup is deliberately *not* failed: the re-index runs through this
same service, so a process that refused to start would lock the operator out of the fix.

The same reasoning covers a harsher case. Runtime traffic goes through the alias
`cognivault`, and Qdrant keeps aliases and collections in one namespace — so a legacy
`cognivault` COLLECTION (built before the alias design) makes the alias impossible to
create, and its vectors predate the named `dense`/`bm25` schema. The service starts
anyway, in a **blocked** state: `/health` stays 200, the admin API stays reachable,
`cognivault_collection_blocked` goes to `1`, and search, `/context` and reindexing answer
`503 COLLECTION_BLOCKED` rather than an empty result set that would read as "nothing
found". Nothing is renamed or deleted automatically — the legacy collection is still the
rollback path. `POST /api/admin/collection/rebuild` (confirm: `cognivault`) drops it,
creates `cognivault_v2` with the alias and re-indexes every vault; that is the whole
recovery, and it needs no shell and no database access.

## Quick Start

### With Docker (recommended)

```bash
cp .env.example .env
# Edit .env — at minimum VAULT_PATH and OPENAI_API_KEY (or the GigaChat block)

docker compose up
```

Starts CogniVault, Qdrant (`v1.16.3`), Prometheus and Grafana. The API is published on
`http://localhost:3030` by default (`COGNIVAULT_PORT` overrides the host port; the
container always listens on 3000).

### Without Docker

**Prerequisites:** Node.js 22+, pnpm, a reachable [Qdrant](https://qdrant.tech/) 1.16.x.

```bash
pnpm install
pnpm build

cp .env.example .env
# Edit .env — VAULT_PATH, QDRANT_URL, and the embedding provider block

pnpm start
```

Development with auto-reload (`pnpm dev` watches `dist/`, so keep `tsc` running or rebuild):

```bash
pnpm build && pnpm dev
```

## User Management

Authentication is by API key. Users are managed with the `cognivault-ctl` CLI
(`dist/cli/index.js`).

```bash
# Folder-only user: no Obsidian sync, the poller just indexes the directory
node dist/cli/index.js add-local-user alice \
  --vault-path /abs/path/to/folder \
  --openai-key sk-...            # only needed for EMBEDDING_PROVIDER=openai

# Obsidian-synced user (runs `ob login` / `ob sync-setup`)
node dist/cli/index.js add-user bob \
  --obsidian-email bob@example.com \
  --obsidian-password '...' \
  --vault MyVault \
  --openai-key sk-...

node dist/cli/index.js list-users [--json]
node dist/cli/index.js remove-user alice [--force]
```

The generated API key is printed on creation. Every command accepts `--data-dir`; it
defaults to `$COGNIVAULT_DATA_DIR` or `./data` — note that the **server** defaults to
`./.cognivault`, so set `COGNIVAULT_DATA_DIR` explicitly whenever you run both by hand.

## API

Everything except `/health`, `/ready` and `/metrics` requires
`Authorization: Bearer <api-key>`. Swagger UI: `/docs`.

### Search

All three endpoints share one request body.

```bash
# Hybrid — dense + BM25, fused with RRF server-side. The recommended default.
curl -X POST http://localhost:3030/api/vault/search/hybrid \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "query": "как настроить mTLS для Qdrant",
        "limit": 10,
        "group_by_section": true,
        "section_max_chars": 4000
      }'

# Semantic — dense only, absolute cosine scores
curl -X POST http://localhost:3030/api/vault/search/semantic \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "how does authentication work", "limit": 5}'

# Lexical — BM25 only. Best for exact terms an embedding blurs away
curl -X POST http://localhost:3030/api/vault/search/lexical \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "SberOSC 403", "limit": 10}'
```

**Request body**

| Field | Type | Default | Notes |
|---|---|---|---|
| `query` | string | — | Required, non-empty |
| `limit` | int 1–50 | `10` | |
| `filters` | object | `{}` | `tags[]` (OR), `project`, `status`, `type`, `folder` (path prefix, post-filtered in the service) |
| `group_by_section` | bool | `false` | **`/hybrid` only.** Keeps the best-ranked chunk per section and drops its siblings, then fills `section_text` |
| `section_max_chars` | int 1–100000 | `4000` | Truncation limit for `section_text` |

**Response**

```json
{
  "results": [
    {
      "text": "…chunk text as embedded…",
      "path": "notes/qdrant.md",
      "title": "qdrant",
      "section_path": "Настройка > TLS",
      "score": 1.0,
      "tags": ["infra"],
      "project": null,
      "status": null,
      "type": null,
      "chunk_index": 3,
      "parent_id": "a1b2c3…",
      "section_text": "…full section text, only when group_by_section…",
      "rank": 1
    }
  ],
  "total": 1,
  "limit": 10,
  "query_ms": 42
}
```

`parent_id` is `""` for formats without sections (pdf/csv/canvas/excalidraw). It is derived
from the section's position inside its note and **not** from the file path, so it is unique
only within one file — pair it with `path` when you use it as a key.

Several chunks of the same file in one result set are intended behaviour (the UI relies on
it to decide whether to expand a whole file), so results are never deduplicated by `path`.

### Context Pack

Assembles a token-budgeted pack from search results, grouped into named sections:

```bash
curl -X POST http://localhost:3030/api/vault/context \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "project architecture", "token_budget": 16000, "min_score": 0.3}'
```

`min_score` is compared against the semantic (cosine) score this endpoint produces.

### Catalogue

One row per indexed document — path, title, and the annotation the indexer cached for it:

```bash
curl "http://localhost:3030/api/catalog?limit=500&offset=0" \
  -H "Authorization: Bearer $API_KEY"
```

An empty `documents` array has four distinct causes; read `status` (`ok`, `empty_vault`,
`summaries_disabled`, `summaries_pending`) before concluding anything about the corpus.
Only `empty_vault` means the corpus itself is empty.

**"Document" means retrievable, and it is defined in exactly one place.** The response
carries `document_extensions`, served from `DOCUMENT_EXTENSIONS` in `src/lib/indexer.ts` —
the list the poller scans by, minus images. It is the answer to "what counts as a
document", and it is authoritative because it is *derived from* the scanning list rather
than restated next to it.

Any client that counts, sizes or summarises the corpus MUST use one of these two, and no
third rule of its own:

1. count `total` from `GET /api/catalog` (rows the index actually has), **or**
2. walk `GET /api/vault/files` and keep only files whose extension is in
   `document_extensions` from the same response.

A hard-coded extension allowlist in a client is a defect even while it happens to agree.
A file whose extension is outside `document_extensions` — `.txt` and `.markdown` are the
near misses — is never scanned, never chunked and never embedded, so counting it promises
a document that search can never return. That is the same lie as a wrong answer, moved
into the part of the UI a reader trusts to describe scale.

### Vault Operations

```bash
# List files
curl "http://localhost:3030/api/vault/files?path=notes&recursive=true&ext=.md" \
  -H "Authorization: Bearer $API_KEY"

# Read note content / frontmatter
curl "http://localhost:3030/api/vault/content?path=notes/readme.md" \
  -H "Authorization: Bearer $API_KEY"
curl "http://localhost:3030/api/vault/metadata?path=notes/readme.md" \
  -H "Authorization: Bearer $API_KEY"

# Create a note
curl -X POST http://localhost:3030/api/vault/content \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"path": "notes/new-note.md", "content": "# Hello", "frontmatter": {"tags": ["example"]}}'

# Replace / append content
curl -X PUT http://localhost:3030/api/vault/content \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"path": "notes/new-note.md", "content": "# Updated content"}'

curl -X PATCH http://localhost:3030/api/vault/content \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"path": "notes/new-note.md", "content": "\n## Appended"}'

# Move, patch frontmatter, delete
curl -X POST http://localhost:3030/api/vault/move \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"from": "notes/new-note.md", "to": "archive/new-note.md"}'

curl -X PATCH http://localhost:3030/api/vault/metadata \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"path": "archive/new-note.md", "metadata": {"status": "done", "draft": null}}'

curl -X DELETE http://localhost:3030/api/vault/content \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"path": "archive/new-note.md"}'

# Bulk import: a zip archive lands in the watched vault directory (50 MB cap, one file)
curl -X POST http://localhost:3030/api/vault/upload \
  -H "Authorization: Bearer $API_KEY" \
  -F "file=@notes.zip"
```

### Admin

```bash
# Reindex — scope is "full" | "path" (needs "path") | "folder" (needs "folder")
curl -X POST http://localhost:3030/api/admin/reindex \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"scope": "full"}'

curl "http://localhost:3030/api/admin/reindex/status?jobId=<job-id>" \
  -H "Authorization: Bearer $API_KEY"
```

Returns `202` with a `jobId`, or `409` while a full reindex is already running. A job that
saw failures ends as `completed_with_errors` and lists the offending files.

#### Collection rebuild

`POST /api/admin/reindex` re-embeds **one** user's vault into the existing collection. It
cannot change anything the collection itself records — above all the BM25 scheme marker,
which the service refuses to re-stamp on a populated collection whose provenance it cannot
prove. Making that marker true requires re-creating the collection, which is what this is.

```bash
# What you are about to destroy — read this first; nothing is pre-filled anywhere
curl http://localhost:3030/api/admin/collection \
  -H "Authorization: Bearer $API_KEY"
# → {"collection":"cognivault_v2","alias":"cognivault","schemeVersion":2,
#    "expectedSchemeVersion":3,"pointsCount":41230}

# DESTRUCTIVE: drops that collection — EVERY user's vectors, not just yours — recreates it
# with the current schema and scheme marker, then re-indexes every registered vault.
curl -X POST http://localhost:3030/api/admin/collection/rebuild \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"confirm": "cognivault_v2"}'

curl "http://localhost:3030/api/admin/collection/rebuild/status?jobId=<job-id>" \
  -H "Authorization: Bearer $API_KEY"
```

`confirm` must equal the physical collection name exactly (`400 CONFIRM_MISMATCH`
otherwise — the alias `cognivault` is not accepted). `409 REBUILD_IN_PROGRESS` while
another rebuild or any per-user reindex is running; a per-user reindex started during a
rebuild gets `409 REINDEX_IN_PROGRESS`.

**Search returns nothing from the moment the collection is dropped until indexing
finishes.** The status `phase` says where the job is: `dropping` (collection intact,
nothing lost yet) → `creating` (collection GONE) → `indexing` (collection back, filling
up, search partial) → `done`. A user whose reindex fails is recorded in `errors` and the
job continues with the next one; a failure to re-create the collection ends the job as
`failed` with a `FATAL:` error string, and retrying the endpoint or restarting the service
re-creates it.

### Health & metrics

```bash
curl http://localhost:3030/health    # liveness, no auth
curl http://localhost:3030/ready     # readiness, no auth — 503 while no vault is attached
curl http://localhost:3030/metrics   # Prometheus, no auth
```

Use `/health` for Kubernetes and Docker probes. `/ready` also checks the vault, so it
answers 503 on a backend with no `VAULT_PATH` and multi-tenant users only.

## Indexing

The poller (`src/lib/indexer.ts`) watches each user's vault directory, independently of how
files got there. An mtime+size pretest short-circuits unchanged files before any hashing.

Chunking (`src/lib/chunker.ts`) splits Markdown along headings into 100–500 cl100k-token
chunks with no overlap and a breadcrumb prefix. Tables are handled separately: a GFM table
that fits ~1200 tokens stays whole, a larger one is cut into row groups that each repeat the
header row and the context prefix — rows are never split.

With `EMBEDDING_PROVIDER=gigachat`, two optional enrichments run at index time
(`INDEX_TABLE_SUMMARY`, `INDEX_DOC_SUMMARY`): an extra retrievable point describing a split
table, and a one-paragraph document annotation cached in SQLite by content hash. The
annotation is prepended to the chunk text used for the **dense vector and the payload**, but
deliberately **not** to the text used for the sparse vector — an annotation repeated across
every chunk of a file would flatten the lexical signal.

**Indexing is transactional against SQLite.** The `indexed_files` row is written only after
Qdrant confirms the upsert and stale vectors are deleted (`confirmIndexed` / `failIndexed`
on `VaultIndexer`). A parse failure raises a typed `ChunkParseError`, which leaves the
existing vectors and the old row untouched, so the next poll honestly sees the file as
changed and retries. Zero chunks from a *valid* file is a different case: the vectors are
dropped and the row is written, because that is the correct end state.

SQLite (Drizzle, per-user `index.db`) holds three tables: `indexed_files`, `sections` (full
parent-section text for small-to-big retrieval, keyed by `(path, parent_id)`) and
`doc_summaries` (the annotation cache).

## Qdrant

The service talks to the alias **`cognivault`**, which points at the physical collection
**`cognivault_v2`**. Point traffic goes through the alias so a future re-index can build a
new collection and repoint atomically; admin work targets the physical name. On first start
the collection and the alias are created; a legacy *collection* named `cognivault` is fatal
(Qdrant shares one namespace for aliases and collections) and must be renamed by hand.

Startup validates the existing collection: the legacy unnamed-vector schema, a missing
`dense` vector or a dense vector sized for a different embedding model all fail fast. A
missing `bm25` sparse vector is only a warning — dense search still answers.

Payload indexes: `path`, `tags`, `project`, `status`, `type` (keyword), `chunk_index`
(integer), full-text on `text`/`title`/`section_path`, and `user_id` as a **keyword index
with `is_tenant: true`** so a tenant's points are co-located on disk.

**External Qdrant = Platform V Vector DB** (the Sber wrapper). It is not raw Qdrant: no UI,
mTLS-only transport, and requests authorised by a JWT rather than an `api-key`. The
username/password pair is exchanged at an IAM endpoint (`${origin(QDRANT_URL)}/auth` by
default) for a token that lives an hour and is renewed in the background
(`src/lib/qdrant-auth.ts`). TLS material is applied by intercepting `tls.connect`, scoped to
the Qdrant host:port only, because the REST client ships its own undici agent and exposes no
TLS options (`src/lib/qdrant-tls.ts`). `QDRANT_API_KEY` and the IAM pair are mutually
exclusive and config validation rejects both being set.

## Embedding Providers

`EMBEDDING_PROVIDER` selects `openai` (default) or `gigachat`.

GigaChat speaks an OpenAI-compatible `/v1/embeddings` over **mTLS** — the PEM client
certificate *is* the credential, there is no bearer token — implemented with `node:https` in
`src/lib/gigachat-embedding.ts`. Because the certificate is a system-wide credential, one
shared embedder serves every user. `src/lib/gigachat-chat.ts` reuses the same transport for
the index-time chat/completions calls.

`EmbeddingsGigaR` is asymmetric: queries are prefixed with `GIGACHAT_QUERY_INSTRUCTION`
(`embedQuery`), documents never are (`embed`). Changing the instruction needs no re-index.

Vector size comes from `resolveDimensions()` (`src/lib/embedding.ts`), the single source used
by both the embedder and the collection schema: OpenAI models derive it from a model→size
map, GigaChat requires an explicit `EMBEDDING_DIMENSIONS`. Switching to a provider with a
different dimension requires a fresh collection and a full re-index.

## Chat pipeline (`cognivault-ui/`)

For context, since it shapes the API contract above. Per turn the UI makes two hidden
GigaChat calls around retrieval:

1. **Intent + condense** — classifies the turn (`smalltalk` / `clarify` / `kb_question`) and
   rewrites it into a self-contained search query. Non-KB intents skip retrieval entirely.
2. **Batch relevance grader** — scores every candidate 1–5; it doubles as the reranker.
   Candidates below the threshold are dropped, the top few by search rank are always kept,
   and the survivors are capped before expansion.

Retrieval is `POST /api/vault/search/hybrid` with `group_by_section: true` and
`section_max_chars`, falling back to `/semantic` on error. Prompts and model parameters are
editable from the UI and stored per user.

## Configuration

See [`.env.example`](.env.example) — it lists every key `src/config.ts` parses, with
defaults. The ones you almost always touch:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VAULT_PATH` | No* | — | Single-tenant vault; unset in multi-tenant deployments |
| `QDRANT_URL` | No | `http://localhost:6333` | Qdrant / Platform V Vector DB base URL |
| `EMBEDDING_PROVIDER` | No | `openai` | `openai` \| `gigachat` |
| `OPENAI_API_KEY` | For openai | — | Embedding credentials |
| `EMBEDDING_DIMENSIONS` | For gigachat | — | Dense vector size; must match the collection |
| `GIGACHAT_CERT_PATH` / `GIGACHAT_KEY_PATH` | For gigachat | — | mTLS client certificate and key |
| `COGNIVAULT_DATA_DIR` | No | `./.cognivault` | SQLite databases, registry, state |
| `PORT` | No | `3000` | HTTP port |
| `LOG_LEVEL` | No | `info` | `fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | — | OpenTelemetry collector |

`*` at least one vault must exist — either `VAULT_PATH` or a registered user.

## Monitoring

Docker Compose brings up the observability stack:

- **Prometheus** — `http://localhost:9090`
- **Grafana** — `http://localhost:3010` — dashboards for **System** (request rates,
  latencies, errors), **Indexing** (files processed, duration, failures) and **Search**
  (query latency, result counts, search type)

## Architecture

```
 ┌─────────────┐        ┌──────────────────┐
 │  AI agent   │        │  cognivault-ui   │
 │  (client)   │        │  (FastAPI chat)  │──── mTLS ───> GigaChat
 └──────┬──────┘        └────────┬─────────┘              (chat + embeddings)
        │  REST + Bearer          │  REST + Bearer
        └────────────┬────────────┘
                     v
            ┌──────────────────┐        ┌─────────────────────────┐
            │    CogniVault    │───────>│  Qdrant / Platform V    │
            │    (Fastify)     │<───────│  alias cognivault       │
            └───┬──────────┬───┘        │  → cognivault_v2        │
                │          │            │  dense + bm25 vectors   │
                v          v            └─────────────────────────┘
    ┌────────────────┐  ┌──────────────┐
    │  SQLite        │  │  Vault dir   │
    │  indexed_files │  │ (filesystem, │
    │  sections      │  │  polled)     │
    │  doc_summaries │  └──────────────┘
    └────────────────┘
```

**Stack:** Node.js 22 (ESM), Fastify 5, TypeScript strict, Qdrant 1.16.x, SQLite via Drizzle
ORM, TypeBox route schemas, Zod config validation, Biome, Vitest.

## Development

```bash
pnpm install
pnpm build

pnpm test                 # Vitest (loads .env)
pnpm test -- --run src/features/search/__tests__/routes.test.ts
pnpm check                # biome check + tsc --noEmit
pnpm format               # biome format --write
```

Some `src/lib/__tests__/indexer.test.ts` and `user-registry.test.ts` cases are time-dependent
and can flake on a loaded machine. Re-run before treating a failure there as a regression.

### Project Structure

```
src/
  app.ts                    # Fastify app factory, plugin + route registration order
  server.ts                 # Entry point
  config.ts                 # Zod-validated env config (single source for every ENV key)
  plugins/                  # auth, db, embedding, qdrant, pipeline, indexer, metrics, …
  features/                 # Feature modules: routes.ts / schemas.ts / service.ts
    health/                 #   /health, /ready
    search/                 #   /api/vault/search/{semantic,hybrid,lexical}
    context/                #   /api/vault/context
    vault/                  #   /api/vault/* file CRUD + upload
    admin/                  #   /api/admin/reindex[/status], /api/admin/collection[/rebuild]
  lib/
    bm25.ts                 # sparse vectors: tokenizer, Russian stemmer, FNV-1a, BM25 tf
    chunker.ts              # markdown/heading/table chunking, parent sections
    indexer.ts              # filesystem poller, confirmIndexed/failIndexed
    embedding.ts            # provider selection, resolveDimensions
    gigachat-embedding.ts   # mTLS embeddings client
    gigachat-chat.ts        # mTLS chat/completions (index-time summaries)
    qdrant-auth.ts          # Platform V IAM token exchange
    qdrant-tls.ts           # tls.connect interception, scoped to the Qdrant host:port
    tenant-qdrant-client.ts # injects user_id into every filter and prefetch branch
    {pdf,csv,canvas,excalidraw}-chunker.ts
  db/schema.ts              # Drizzle: indexed_files, sections, doc_summaries
  cli/                      # cognivault-ctl user management
drizzle/                    # SQL migrations + snapshots
test/                       # integration + smoke tests
tools/eval/                 # RAG evaluation harness (golden set, metrics, runner)
cognivault-ui/              # Python/FastAPI chat UI (separate service)
```

## License

[MIT](LICENSE)
