# CogniVault

Knowledge access layer for AI agents working with Obsidian vaults. Two services in one repo:

- `src/` — REST backend: Fastify + TypeScript. Indexing, retrieval, vault CRUD, admin.
- `cognivault-ui/` — Python/FastAPI chat UI over that API (own docs, own tests).

## Stack

- **Runtime:** Node.js v22 LTS, ESM modules
- **Framework:** Fastify 5
- **Language:** TypeScript (strict mode)
- **Package manager:** pnpm
- **Test runner:** Vitest (`pnpm test` loads `.env`)
- **Linting/formatting:** Biome (single tool for both)
- **Route schemas:** TypeBox (Fastify-native, drives OpenAPI at `/docs`)
- **Config validation:** Zod (`src/config.ts`, fails fast on startup)
- **Database:** SQLite via Drizzle ORM, per-user `index.db`
- **Vector store:** Qdrant 1.16.x — named `dense` + sparse `bm25` vectors.
  In production this is Platform V Vector DB (mTLS + IAM JWT), not raw Qdrant.
- **Embeddings:** OpenAI, or GigaChat over mTLS (`EMBEDDING_PROVIDER`)
- **Deployment:** Docker + docker-compose (service, Qdrant, Prometheus, Grafana)

## Project Structure

```
src/
  app.ts              # Fastify app factory — plugin/route registration ORDER matters
  server.ts           # Entry point
  config.ts           # Zod-validated env config — the ONLY place ENV keys are declared
  plugins/            # auth, db, embedding, qdrant, pipeline, indexer, metrics, swagger…
  features/{name}/    # routes.ts, schemas.ts, service.ts, __tests__/
    health/           #   /health, /ready            (skipAuth)
    search/           #   /api/vault/search/{semantic,hybrid,lexical}
    context/          #   /api/vault/context
    vault/            #   /api/vault/* CRUD + /upload
    admin/            #   /api/admin/reindex[/status]
  lib/
    bm25.ts           # sparse vectors: tokenizer + vendored ru Snowball stemmer, FNV-1a, BM25 tf
    chunker.ts        # heading/table chunking, parent sections
    indexer.ts        # poller; confirmIndexed / failIndexed
    pipeline* (plugins/pipeline.ts)  # chunk → enrich → embed → upsert → persist row
    embedding.ts, gigachat-embedding.ts, gigachat-chat.ts
    qdrant-auth.ts    # Platform V IAM token exchange
    qdrant-tls.ts     # tls.connect interception, scoped to the Qdrant host:port
    tenant-qdrant-client.ts  # injects user_id into filters AND prefetch branches
  db/schema.ts        # indexed_files, sections, doc_summaries
  cli/                # cognivault-ctl
drizzle/              # SQL migrations + snapshots
tools/eval/           # RAG eval harness (golden set, gigaragas-style metrics, runner)
```

## Retrieval (what the code actually does)

- **`hybrid`** = ONE `client.query`: `prefetch` [dense, bm25] + `query: {fusion: 'rrf'}`.
  Candidate depth per branch is `max(2 × limit, 40)`. `lexical` = sparse only,
  `semantic` = dense only.
- **Scores from `hybrid`/`lexical` are rescaled against the top hit** (rank 1 → 1.0).
  Raw RRF sums have no fixed scale (the API exposes `"rrf" | "dbsf"` and no constant) and
  raw BM25 sums are unbounded — neither survives a fixed threshold like `/context`'s
  `min_score`, and the response schema caps `score` at 1.
  `semantic` alone returns an absolute (clamped cosine) score.
  **Therefore rank 1 always leaves as 1.0 and no downstream threshold can reject a result
  set — refusal is the grader's job, not a score cutoff.** Measured: top-hit score
  distributions for answerable and unanswerable questions overlap, AUC 0.63–0.68.
- Index-time and query-time sparse vectors MUST come from the same `bm25.ts` functions,
  or terms stop lining up and the lexical branch silently returns nothing.
- Never dedupe results by `path`: multiple chunks of one file are intended (the UI uses
  the hit count to decide whether to expand the whole file).

## Coding Conventions

### TypeScript
- ESM imports only (`import/export`, no `require`)
- `import type { Foo } from './bar.js'` for type-only imports
- File extensions in imports: `'./config.js'` (ESM requirement, even for .ts files)
- Prefer `interface` over `type` for object shapes
- No `any` — use `unknown` and narrow

### Fastify Patterns
- Register features as Fastify plugins via `fastify.register()`
- Define route schemas with TypeBox in `schemas.ts`, reference in route options
- Use `fastify.decorate()` for shared services, access via `fastify.serviceName`
- Auth: `onRequest` hook via Fastify plugin, not per-route middleware; public routes opt out
  with `config: { skipAuth: true }`
- Error responses: `{ error: { code: "ERROR_CODE", message: "Human-readable" } }`

### Testing
- Colocated: `src/**/__tests__/*.test.ts`; integration in `test/`
- Use `fastify.inject()` for route testing (no real HTTP server needed)
- Run: `pnpm test`, single file: `pnpm test -- --run src/features/health/__tests__/routes.test.ts`
- `src/lib/__tests__/indexer.test.ts` and `user-registry.test.ts` are **time-dependent and
  flake under load** — re-run before calling a failure there a regression.

### Code Quality
- `pnpm format` / `pnpm lint` / `pnpm typecheck`; all of it: `pnpm check`

### Docker
- Multi-stage Dockerfile: build stage (tsc), production stage (node:22-slim)
- `docker compose up` starts service + Qdrant (pinned `v1.16.3`) + Prometheus + Grafana
- Dev workflow: run outside Docker (`pnpm dev`), Docker for integration/deployment

### Git
- Conventional commits, scope by feature: `feat(search): fuse dense and sparse server-side`
- One logical change per commit

## Environment Variables

`src/config.ts` is the single source of truth; `.env.example` mirrors it key for key and
carries the explanations. **Keep the two in sync** — and add new keys to `cognivault.yaml`
too. The UI has its own set in `cognivault-ui/app/settings.py` (`RAG_*`, `GIGACHAT_*`,
`CONFLUENCE_*`, `UI_*`); most `rag.*` and `prompts.*` values are also per-user editable from
the UI and stored in a JSON config file, so env only supplies the defaults.

Non-obvious ones:
- `EMBEDDING_DIMENSIONS` — required for gigachat, must match the collection. A mismatch is a
  hard startup failure.
- `GIGACHAT_QUERY_INSTRUCTION` — query-side prefix for the asymmetric EmbeddingsGigaR.
  Changing it needs no re-index (documents are embedded bare).
- `QDRANT_API_KEY` vs `QDRANT_USERNAME`/`PASSWORD` — mutually exclusive, validated.
- `INDEX_DOC_SUMMARY` / `INDEX_TABLE_SUMMARY` — index-time GigaChat chat calls; best-effort.
- `QDRANT_QUANTIZATION` — read at COLLECTION CREATION only.

## Vault Sources

A user's `vaultPath` is watched by the filesystem poller (`src/lib/indexer.ts`),
**independently of Obsidian sync** — anything in the folder gets indexed regardless of
how it got there.

- **Obsidian-synced:** `cognivault-ctl add-user <name> …` runs `ob login`/`ob sync-setup`
  and stores an `obsidian` config; the sync plugin spawns `ob sync --continuous`.
- **Plain local folder:** `cognivault-ctl add-local-user <name> --vault-path <dir>
  [--openai-key <key>]` registers a user with **no** `obsidian` config. No `ob` process is
  started. `obsidian` and `openaiKey` are optional on the user record (`openaiKey` is only
  needed for the OpenAI provider); folder-only mode needs no `obsidian-headless`.
- The CLI's `--data-dir` defaults to `./data`, the server's `COGNIVAULT_DATA_DIR` to
  `./.cognivault`. Set the env var explicitly when running both by hand, or the CLI writes
  users the server never sees.

## Embedding Providers

- **Selection:** `EMBEDDING_PROVIDER` chooses `openai` (default) or `gigachat`.
- **GigaChat:** OpenAI-compatible `/v1/embeddings` over **mTLS** — the PEM client
  certificate *is* the auth (no bearer token), `node:https`, no extra deps
  (`src/lib/gigachat-embedding.ts`). System-wide credential, so ONE shared embedder serves
  all users (per-user OpenAI keys do not apply). `gigachat-chat.ts` reuses the transport for
  index-time chat/completions.
- **Asymmetric model:** `embedQuery()` prefixes the instruction, `embed()` (documents) never
  does. Search paths must call `embedQuery`.
- **Vector size:** `resolveDimensions()` (`src/lib/embedding.ts`) is the single source for
  both the embedder and the collection schema. A different dimension = fresh collection +
  re-index; startup fails fast on a size mismatch.

## Key Decisions

- **No `default` exports** — named exports only
- **Feature-based structure** — each feature is a self-contained Fastify plugin
- **Auth on public endpoints only** — `/health`, `/ready`, `/metrics` skip auth for probes
  and scraping. Probes must target `/health`: `/ready` checks the global vault and answers
  503 when `VAULT_PATH` is unset (normal in multi-tenant deployments).
- **Zod for config, TypeBox for routes** — Zod validates env at startup; TypeBox gives
  Fastify-native JSON Schema and OpenAPI
- **Pino for logging** — structured JSON; never log credentials, tokens, cert paths or key
  passphrases (the Qdrant client params object carries all of them)
- **Alias, not collection** — runtime traffic goes through the alias `cognivault`; the
  physical collection is `cognivault_v2`. A re-index can build a new collection and repoint
  the alias atomically. Maintenance calls target the physical name. `user_id` is a keyword
  index with `is_tenant: true`.
- **Indexing is transactional** — the `indexed_files` row is persisted only AFTER a
  successful upsert plus stale-vector cleanup (`confirmIndexed` / `failIndexed` on
  `VaultIndexer`). A parse failure raises a typed `ChunkParseError` and touches neither the
  vectors nor the row, so the next poll honestly retries. Zero chunks from a *valid* file is
  the opposite case: vectors are dropped and the row IS written.
- **`parent_id` carries no path** — it is derived from the section's ordinal + heading path
  only. Rationale: H1 headings are transparent, and renaming a file must not invalidate
  chunk identity (a rename is then a cheap `UPDATE sections SET path`). Consequence: it is
  unique only *within* a file — always select and group by the pair `(path, parent_id)`.
  `sections` uses that composite primary key for the same reason.
- **The doc annotation must not reach the sparse vector** — it is prepended to the chunk text
  used for the dense vector and the payload, while `Chunk.lexicalText` keeps the bare text
  for `buildSparseVector`. Repeating one annotation across every chunk of a file would flood
  the lexical index with the same terms.
- **`QdrantClient` freezes its headers at construction**, so a renewed IAM JWT cannot be
  pushed into a live instance. The client is REPLACED via a holder object and everything
  reads `holder.current` at call time — never capture the client in a long-lived closure.
- **Drizzle migrations are generated, not hand-written.** The snapshot chain in
  `drizzle/meta/` was broken once and hand-written SQL was the workaround; it is repaired now
  and `drizzle-kit generate` works normally. Verify the journal/snapshots are consistent
  before editing `src/db/schema.ts`, and fall back to hand-written SQL only if generation
  breaks again.
- **Parent sections live in SQLite, not in the Qdrant payload** — `/search/hybrid` with
  `group_by_section: true` collapses a section to its best chunk and joins `section_text`
  from the `sections` table (capped by `section_max_chars`).

## Chat pipeline (UI, for context)

Per turn the UI makes exactly two hidden GigaChat calls around retrieval: (1) intent
classification + question rewriting, (2) a batch relevance grader that doubles as the
reranker. Retrieval is `POST /api/vault/search/hybrid` with `group_by_section: true`.
Prompts and model parameters are user-editable and stored per user — do not hardcode them.
