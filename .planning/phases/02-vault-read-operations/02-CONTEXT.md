# Phase 2: Vault Read Operations - Context

**Gathered:** 2026-03-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Agents can browse and read vault contents safely through the REST API. Delivers: vault manager with path resolution and traversal protection, list files endpoint with filtering, read content endpoint, read frontmatter/metadata endpoint. Write operations (create, update, delete, rename) belong to Phase 3.

</domain>

<decisions>
## Implementation Decisions

### Path & listing behavior
- Paths passed as query parameters: `GET /api/vault/files?path=Projects/CogniVault`
- Route prefix: `/api/vault` for all vault endpoints
- Flat listing by default; `?recursive=true` for deep listing
- Minimal metadata per entry: name, relative path, type (file/directory)
- Extension filter: `?ext=md` to filter by file extension
- No pagination — return all results at once
- Infer directory vs file from filesystem (no trailing slash requirement)
- Root listing: omit `?path=` or pass empty string — both return vault root

### Response shape
- Separate endpoints for content and metadata: `GET /api/vault/content?path=...` and `GET /api/vault/metadata?path=...`
- Content endpoint strips frontmatter YAML block, returns markdown body only
- Content response: `{"path": "Notes/foo.md", "content": "markdown body..."}`
- Metadata response: `{"path": "Notes/foo.md", "metadata": {"tags": [...], "status": "draft"}}` — parsed JSON object, not raw YAML

### Traversal protection
- Reject symlinks — any path resolving through a symlink returns 403
- Exclude all dotfiles/dotfolders (`.obsidian`, `.trash`, `.git`) from listings and reject reads
- Path traversal attempts (`../../etc/passwd`) return 403 with specific error code `PATH_TRAVERSAL` and descriptive message
- Path normalization happens before traversal check (collapse `//`, strip leading/trailing slashes)

### Vault manager architecture
- Exposed as Fastify decorator: `fastify.vault.listFiles(...)`, `fastify.vault.readContent(...)`, etc.
- Core logic in `src/lib/vault.ts`, Fastify plugin wrapper in `src/plugins/vault.ts`
- Startup validation: fail fast if VAULT_PATH doesn't exist or isn't a directory
- Extend readiness endpoint to check vault accessibility

### Frontmatter parsing
- Library: gray-matter (Obsidian-ecosystem standard)
- Malformed YAML: return 200 with empty metadata `{}` and a `warning` field noting parse failure
- Normalize `tags` field to always be an array (Obsidian allows string or array); other fields as-is
- Preserve nested YAML objects as nested JSON (no flattening)

### Encoding & special characters
- UTF-8 Cyrillic paths accepted as-is in query params: `?path=Заметки/проект.md`
- Literal spaces accepted: `?path=My Notes/todo.md` — Fastify handles URL decoding
- Internal path normalization: collapse double slashes, strip leading/trailing slashes
- Case-sensitive path matching (matches filesystem behavior)

### Edge cases
- Nonexistent paths: 404 with path in message: `{"error": {"code": "NOT_FOUND", "message": "File not found: path/to/file.md"}}`
- Notes without frontmatter: metadata endpoint returns 200 with `{"metadata": {}}` (empty object)
- Binary files: appear in listings but content read returns 415 Unsupported Media Type
- No file size limit for reads

### Claude's Discretion
- Exact TypeBox schema definitions for request/response validation
- Internal path resolution implementation (path.resolve vs path.join)
- Vault manager method signatures and error class design
- Test fixtures and mock vault structure
- How binary file detection works (extension-based vs content sniffing)

</decisions>

<specifics>
## Specific Ideas

- Binary file handling (read returning 415) is temporary — add proper binary read support as a future todo
- User prefers standard/recommended approaches (established in Phase 1 context)
- Agent-friendly error messages — include the path in NOT_FOUND so agents can self-correct

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/config.ts`: Already has `VAULT_PATH` env var validated by Zod — vault manager reads from here
- `src/plugins/auth.ts`: Pattern for Fastify plugin with `onRequest` hook — vault plugin follows same pattern
- `src/plugins/error-handler.ts`: Established error response format `{"error": {"code": "...", "message": "..."}}` — vault errors use same shape

### Established Patterns
- Plugin registration order in `app.ts`: error-handler → auth → feature routes — vault plugin registers between auth and routes
- Feature routes in `src/features/{name}/routes.ts` with TypeBox schemas in `schemas.ts`
- Tests use `fastify.inject()` with top-level env vars and dynamic import

### Integration Points
- `src/app.ts`: Register vault plugin and vault feature routes
- `src/features/health/routes.ts`: Extend readiness check to include vault accessibility
- `src/config.ts`: VAULT_PATH already defined, no config changes needed

</code_context>

<deferred>
## Deferred Ideas

- Full binary file read support (images, PDFs via content endpoint) — future enhancement
- Pagination for very large vaults — not needed now, vaults are typically hundreds/low-thousands of files

</deferred>

---

*Phase: 02-vault-read-operations*
*Context gathered: 2026-03-10*
