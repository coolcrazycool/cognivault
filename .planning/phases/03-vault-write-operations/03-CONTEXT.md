# Phase 3: Vault Write Operations - Context

**Gathered:** 2026-03-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Agents can create, modify, and organize notes through the REST API. Delivers: create note, replace content, append/prepend content, delete note, rename/move note, and update frontmatter fields — all with path traversal protection and consistent error handling. Read operations (Phase 2) and indexing/search (Phases 4+) are separate.

</domain>

<decisions>
## Implementation Decisions

### Conflict & overwrite rules
- Create fails with 409 Conflict if file already exists — strict separation from update
- Update/append/prepend fail with 404 Not Found if file doesn't exist — no auto-create
- Delete fails with 404 Not Found if file doesn't exist — not idempotent
- Write operations (create, move) auto-create intermediate directories (mkdir -p behavior)

### Write endpoint design
- Path passed in request body (not query params) for all write operations
- Separate endpoints with standard HTTP semantics:
  - POST /api/vault/content — create new note
  - PUT /api/vault/content — replace existing note content
  - PATCH /api/vault/content — append/prepend to existing note (mode field: "append" | "prepend")
  - DELETE /api/vault/content — delete note by path
  - POST /api/vault/move — rename or move note
- Create endpoint accepts optional `frontmatter` field as JSON object — service assembles the YAML block
- Success responses: 201 for create, 200 for update/append with `{"path": "...", "created": true}` or `{"path": "...", "updated": true}`
- Delete response: 200 with `{"path": "...", "deleted": true}`

### Frontmatter update semantics
- Separate endpoint: PATCH /api/vault/metadata with `{"path": "...", "metadata": {...}}`
- Shallow merge — only provided fields updated, others preserved
- Set field to `null` to delete it from frontmatter
- Response returns full merged metadata: `{"path": "...", "metadata": {...}}` so agent can verify result
- Must not corrupt note body content when updating frontmatter

### Rename/move behavior
- Single endpoint: POST /api/vault/move with `{"from": "...", "to": "..."}`
- Fails with 409 Conflict if destination path already exists
- Auto-creates intermediate directories at destination (consistent with create)
- Response: `{"from": "old/path.md", "to": "new/path.md"}`

### Claude's Discretion
- Atomic write implementation details (temp file + rename vs direct write)
- VaultManager method signatures for write operations
- TypeBox schema definitions for request/response validation
- Test fixture structure for write operation tests
- How append/prepend handles frontmatter (preserve existing vs strip)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `VaultManager` (src/lib/vault.ts): Has `resolvePath()` with full traversal protection, symlink rejection, dotfile blocking — all write operations reuse this
- `VaultError` hierarchy: `PathTraversalError`, `FileNotFoundError`, `DotfileAccessError` — extend with `FileExistsError` (409)
- `handleVaultError` (src/features/vault/routes.ts): Maps VaultError to HTTP responses — extend for new error types
- `ErrorResponseSchema` (src/features/vault/schemas.ts): Shared TypeBox schema for error responses
- `gray-matter`: Already used for frontmatter parsing in `readMetadata()` — reuse for frontmatter assembly and update

### Established Patterns
- Feature routes as Fastify plugin with TypeBox schemas in separate schemas.ts
- All vault routes under `/api/vault` prefix
- Query params for reads, body for writes (decided in this phase)
- Structured error responses: `{"error": {"code": "ERROR_CODE", "message": "Human-readable"}}`

### Integration Points
- `src/lib/vault.ts`: Add write methods to VaultManager class (createNote, updateContent, appendContent, deleteNote, moveNote, updateMetadata)
- `src/features/vault/routes.ts`: Register new POST/PUT/PATCH/DELETE routes alongside existing GET routes
- `src/features/vault/schemas.ts`: Add request body schemas and response schemas for write operations

</code_context>

<specifics>
## Specific Ideas

- User consistently chose strict/explicit behavior over convenience (409 on exists, 404 on not found, no silent overwrites)
- User prefers standard/recommended approaches (established in Phase 1 and 2 context)
- Agent-friendly error messages — include the path in all error responses (established in Phase 2)

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 03-vault-write-operations*
*Context gathered: 2026-03-10*
