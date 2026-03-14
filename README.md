# CogniVault

Knowledge access layer for AI agents working with Obsidian vaults. CogniVault indexes your vault, generates embeddings, and exposes a REST API for semantic search, context assembly, and file management — giving your AI tools structured access to your knowledge base.

## Features

- **Hybrid search** — semantic (vector), lexical (full-text), and fused (RRF) search across your vault
- **Context packing** — assembles token-budgeted context packs from search results, ready for LLM consumption
- **Vault management** — CRUD operations on notes with frontmatter support
- **Multi-tenant** — per-user isolated vaults, databases, and vector collections
- **Auto-indexing** — watches vault for changes, re-indexes automatically
- **Multi-format** — Markdown, PDF, CSV, Excalidraw, and Canvas files
- **Observability** — Prometheus metrics, Grafana dashboards, OpenTelemetry tracing
- **OpenAPI** — auto-generated docs via Swagger UI at `/api/documentation`

## Quick Start

### With Docker (recommended)

```bash
cp .env.example .env
# Edit .env — set VAULT_PATH and OPENAI_API_KEY

docker compose up
```

This starts CogniVault, Qdrant, Prometheus, and Grafana. The API is available at `http://localhost:3000`.

### Without Docker

**Prerequisites:** Node.js 22+, pnpm, a running [Qdrant](https://qdrant.tech/) instance.

```bash
pnpm install
pnpm build

cp .env.example .env
# Edit .env — set VAULT_PATH, OPENAI_API_KEY, QDRANT_URL

pnpm start
```

For development with auto-reload:

```bash
pnpm build && pnpm dev
```

## User Management

CogniVault uses API key authentication. Manage users with the CLI:

```bash
# Add a user with a vault path
node dist/cli/index.js add-user --id alice --key cvk_alice_secret --vault /path/to/vault

# List users
node dist/cli/index.js list-users
```

## API

All endpoints (except health checks) require an `Authorization: Bearer <api-key>` header.

### Search

```bash
# Semantic search (vector similarity)
curl -X POST http://localhost:3000/search/semantic \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "how does authentication work", "limit": 5}'

# Hybrid search (semantic + lexical with RRF fusion)
curl -X POST http://localhost:3000/search/hybrid \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "authentication flow", "limit": 10}'

# Lexical search (full-text)
curl -X POST http://localhost:3000/search/lexical \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "OAuth2", "limit": 10}'
```

**Search filters:**

```json
{
  "query": "deployment",
  "limit": 10,
  "filters": {
    "tags": ["devops"],
    "folder": "projects/",
    "type": "note"
  }
}
```

### Context Pack

Assembles a token-budgeted context pack from search results — ideal for feeding into LLMs:

```bash
curl -X POST http://localhost:3000/context \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "project architecture", "token_budget": 16000}'
```

### Vault Operations

```bash
# List files
curl http://localhost:3000/vault/files \
  -H "Authorization: Bearer $API_KEY"

# Read note content
curl "http://localhost:3000/vault/content?path=notes/readme.md" \
  -H "Authorization: Bearer $API_KEY"

# Create a note
curl -X POST http://localhost:3000/vault/content \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"path": "notes/new-note.md", "content": "# Hello", "frontmatter": {"tags": ["example"]}}'

# Update content
curl -X PUT http://localhost:3000/vault/content \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"path": "notes/new-note.md", "content": "# Updated content"}'

# Delete a note
curl -X DELETE http://localhost:3000/vault/content \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"path": "notes/new-note.md"}'
```

### Admin

```bash
# Trigger full reindex
curl -X POST http://localhost:3000/admin/reindex \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"scope": "full"}'

# Check reindex status
curl "http://localhost:3000/admin/reindex/status?jobId=<job-id>" \
  -H "Authorization: Bearer $API_KEY"
```

### Health

```bash
curl http://localhost:3000/health   # Liveness probe (no auth)
curl http://localhost:3000/ready    # Readiness probe (no auth)
```

Full API documentation is available at `/api/documentation` when the server is running (Swagger UI).

## Configuration

See [`.env.example`](.env.example) for all available environment variables.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VAULT_PATH` | Yes* | — | Path to Obsidian vault (* or configure per-user via CLI) |
| `OPENAI_API_KEY` | Yes | — | OpenAI API key for generating embeddings |
| `PORT` | No | `3000` | HTTP server port |
| `QDRANT_URL` | No | `http://localhost:6333` | Qdrant vector database URL |
| `EMBEDDING_MODEL` | No | `text-embedding-3-small` | OpenAI embedding model |
| `LOG_LEVEL` | No | `info` | Log level (fatal/error/warn/info/debug/trace) |
| `COGNIVAULT_DATA_DIR` | No | `./.cognivault` | Directory for SQLite databases and state |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | — | OpenTelemetry collector for distributed tracing |

## Monitoring

Docker Compose includes a full observability stack:

- **Prometheus** — `http://localhost:9090` — metrics collection
- **Grafana** — `http://localhost:3010` — pre-configured dashboards:
  - **System** — request rates, latencies, error rates
  - **Indexing** — files processed, indexing duration, errors
  - **Search** — query latency, result counts, search types

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────┐
│  AI Agent   │────>│  CogniVault  │────>│  Qdrant │
│  (client)   │<────│  (Fastify)   │<────│ (vectors)│
└─────────────┘     └──────┬───────┘     └─────────┘
                           │
                    ┌──────┴───────┐
                    │   SQLite     │
                    │ (index state)│
                    └──────────────┘
                           │
                    ┌──────┴───────┐
                    │  Obsidian    │
                    │   Vault      │
                    │ (filesystem) │
                    └──────────────┘
```

**Stack:** Node.js 22, Fastify, TypeScript, Qdrant, SQLite (Drizzle ORM), OpenAI embeddings

## Development

```bash
pnpm install
pnpm build

# Run tests
pnpm test

# Lint + format + typecheck
pnpm check

# Format code
pnpm format
```

### Project Structure

```
src/
  app.ts              # Fastify app factory
  server.ts           # Entry point
  config.ts           # Zod-validated env config
  plugins/            # Fastify plugins (auth, db, embedding, metrics, etc.)
  features/           # Feature modules
    health/           # Health/readiness probes
    search/           # Semantic, lexical, hybrid search
    context/          # Context pack assembly
    vault/            # File CRUD operations
    admin/            # Reindexing operations
  lib/                # Shared utilities (chunkers, indexer, vault)
  cli/                # CLI for user management
  db/                 # Database schema (Drizzle)
```

## License

[MIT](LICENSE)
