# Phase 3: Vault Write Operations - Research

**Researched:** 2026-03-10
**Domain:** Node.js filesystem write operations, gray-matter frontmatter manipulation, Fastify body schemas
**Confidence:** HIGH

## Summary

Phase 3 extends the existing VaultManager and vault routes with write capabilities. The codebase is already well-structured: existing patterns for error handling, TypeBox schemas, and Fastify plugin registration are stable and directly reusable. The primary technical challenges are (1) adapting path validation for write targets that don't exist yet, (2) implementing atomic writes to prevent partial writes corrupting vault files, and (3) using gray-matter's `stringify` to safely assemble and reassemble markdown files with frontmatter.

All decisions in CONTEXT.md are locked. The implementation follows a strict pattern: new VaultManager methods for each write operation, new TypeBox body schemas, and new route handlers registering alongside existing GET routes. The `gray-matter` library already in use handles all frontmatter parsing and serialization correctly. No new dependencies are needed.

**Primary recommendation:** Add a `resolveWritePath()` method to VaultManager that validates path segments (traversal, dotfile) without requiring the target to exist — use this for create and move-destination validation. Use existing `resolvePath()` for update, append, delete, and move-source (must exist). Use `fs.writeFile` with a temp-file-plus-rename pattern for atomic writes.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Conflict & overwrite rules:**
- Create fails with 409 Conflict if file already exists — strict separation from update
- Update/append/prepend fail with 404 Not Found if file doesn't exist — no auto-create
- Delete fails with 404 Not Found if file doesn't exist — not idempotent
- Write operations (create, move) auto-create intermediate directories (mkdir -p behavior)

**Write endpoint design:**
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

**Frontmatter update semantics:**
- Separate endpoint: PATCH /api/vault/metadata with `{"path": "...", "metadata": {...}}`
- Shallow merge — only provided fields updated, others preserved
- Set field to `null` to delete it from frontmatter
- Response returns full merged metadata: `{"path": "...", "metadata": {...}}` so agent can verify result
- Must not corrupt note body content when updating frontmatter

**Rename/move behavior:**
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

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| FILE-03 | Agent can create new note with content and optional frontmatter | resolveWritePath + mkdir -p + gray-matter.stringify + atomic write + 409 on exist |
| FILE-04 | Agent can update note content (full replace) | resolvePath (validates existence) + atomic write + 404 on not-found |
| FILE-05 | Agent can append or prepend content to existing note | resolvePath + gray-matter parse/stringify to preserve frontmatter + atomic write |
| FILE-06 | Agent can delete note by path | resolvePath (validates existence) + fs.unlink + 404 on not-found |
| FILE-07 | Agent can rename or move note to new path | resolvePath (source) + resolveWritePath (dest) + mkdir -p + fs.rename + 409 on dest-exist |
| FILE-09 | Agent can update frontmatter fields without corrupting note content | gray-matter parse + shallow merge with null-delete + gray-matter.stringify + atomic write |
</phase_requirements>

---

## Standard Stack

### Core (already installed, no new dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:fs/promises` | Node.js built-in | Atomic writes, mkdir, rename, unlink, stat | Native async fs API |
| `node:path` | Node.js built-in | Path resolution, dirname extraction | Native path manipulation |
| `node:crypto` | Node.js built-in | UUID generation for temp file names | Built-in, no dep needed |
| `gray-matter` | ^4.0.3 (installed) | Parse frontmatter, reassemble markdown files | Already used for read ops |
| `@sinclair/typebox` | ^0.34.48 (installed) | Body schema validation for write endpoints | Already used for all routes |
| `fastify` | ^5.8.2 (installed) | Route registration for POST/PUT/PATCH/DELETE | Already the framework |

### No New Dependencies Required

All write operation needs are met by existing packages and Node.js built-ins. Do not add new packages.

## Architecture Patterns

### Key Insight: Two Path Resolution Modes

The existing `resolvePath()` method performs `fs.lstat()` and throws `FileNotFoundError` for non-existent paths. This is correct for read operations and for write operations that require the file to exist (update, append, delete, move-source).

Write targets that must NOT exist (create destination, move destination) need a new `resolveWritePath()` method that validates path segments without checking file existence.

```
resolvePath(path)       → used for: readContent, readMetadata, PUT/PATCH/DELETE targets, move SOURCE
resolveWritePath(path)  → used for: POST (create) target, POST /move destination
```

### Recommended VaultManager Method Signatures

```typescript
// New method: validates path segments without existence requirement
// Throws PathTraversalError, DotfileAccessError — but NOT FileNotFoundError
async resolveWritePath(relativePath: string): Promise<string>

// Write methods (add to VaultManager)
async createNote(filePath: string, content: string, frontmatter?: Record<string, unknown>): Promise<{ path: string; created: true }>
async updateContent(filePath: string, content: string): Promise<{ path: string; updated: true }>
async appendContent(filePath: string, text: string, mode: 'append' | 'prepend'): Promise<{ path: string; updated: true }>
async deleteNote(filePath: string): Promise<{ path: string; deleted: true }>
async moveNote(from: string, to: string): Promise<{ from: string; to: string }>
async updateMetadata(filePath: string, updates: Record<string, unknown>): Promise<{ path: string; metadata: Record<string, unknown> }>
```

### New Error Class Required

```typescript
export class FileExistsError extends VaultError {
  constructor(filePath: string) {
    super(`File already exists: ${filePath}`, 'FILE_EXISTS', 409);
    this.name = 'FileExistsError';
  }
}
```

Add to `handleVaultError` in routes.ts: map `FileExistsError` to 409.

### Atomic Write Pattern (Claude's Discretion: use temp file + rename)

`fs.rename()` on the same filesystem is atomic on POSIX. This is the standard approach for safe file writes in Node.js. Write to a temp file in the same directory (same filesystem), then rename over the target.

```typescript
// Source: Node.js fs/promises docs — rename is atomic on POSIX same-filesystem
import * as crypto from 'node:crypto';

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpFile = path.join(dir, '.' + crypto.randomUUID() + '.tmp');
  try {
    await fs.writeFile(tmpFile, content, 'utf-8');
    await fs.rename(tmpFile, filePath);
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => {});
    throw err;
  }
}
```

This is a private helper method on VaultManager, not exposed publicly. All write methods call it.

### Pattern: resolveWritePath Implementation

```typescript
async resolveWritePath(relativePath: string): Promise<string> {
  const normalized = relativePath.replace(/\/+/g, '/').replace(/^\//, '').replace(/\/$/, '');

  if (normalized === '') {
    throw new PathTraversalError('Empty path is not a valid write target');
  }

  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new PathTraversalError(`Path traversal detected: ${relativePath}`);
    }
    if (segment.startsWith('.')) {
      throw new DotfileAccessError(relativePath);
    }
  }

  const resolved = path.resolve(this.rootPath, normalized);

  if (resolved !== this.rootPath && !resolved.startsWith(this.rootPath + path.sep)) {
    throw new PathTraversalError(`Path traversal detected: ${relativePath}`);
  }

  return resolved;
}
```

Note: No `fs.realpath()` call here because the file doesn't exist. The path segment validation is sufficient protection since we control the vault root resolution via `path.resolve`.

### Pattern: gray-matter for Frontmatter Operations

**Verified by direct testing (2026-03-10):**

```typescript
import matter from 'gray-matter';

// CREATE: assemble new file with optional frontmatter
// If frontmatter is empty/undefined, gray-matter.stringify omits the --- block entirely
const fileContent = frontmatter && Object.keys(frontmatter).length > 0
  ? matter.stringify(content, frontmatter)
  : content + '\n';

// UPDATE (replace): write new content; if existing file has frontmatter, it's replaced entirely
// For full content replace, just write the content as-is (no frontmatter preservation needed)

// APPEND/PREPEND: parse existing file, modify content, reassemble
const parsed = matter(existingRaw);
const updatedContent = mode === 'append'
  ? parsed.content.trimEnd() + '\n\n' + text
  : text + '\n\n' + parsed.content.trimStart();
// If no frontmatter (empty parsed.data), gray-matter.stringify with {} omits --- block
const output = matter.stringify(updatedContent, parsed.data);

// UPDATE METADATA: shallow merge with null-delete semantics
const parsed = matter(existingRaw);
const merged = { ...parsed.data };
for (const [key, value] of Object.entries(updates)) {
  if (value === null) {
    delete merged[key];
  } else {
    merged[key] = value;
  }
}
const output = matter.stringify(parsed.content, merged);
```

**Verified behavior:**
- `matter.stringify(content, {})` — produces content without `---` block (no empty frontmatter)
- `matter.stringify(content, undefined)` — same, no `---` block
- `matter.stringify(content, {title: 'X', tags: ['a']})` — correct YAML frontmatter block
- `matter.stringify(content, data)` always appends trailing newline
- Append/prepend through parse + stringify correctly round-trips frontmatter

### Pattern: File Existence Check

Use `fs.stat()` (follows symlinks) rather than `fs.lstat()` for existence checks on write targets. Catch `ENOENT` to detect non-existence.

```typescript
async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(absolutePath);
    return stat.isFile();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
```

### Anti-Patterns to Avoid

- **Direct `fs.writeFile()` without temp+rename:** Creates a window where file is empty or partially written. Use atomic write pattern instead.
- **Using `resolvePath()` for create/move-destination:** It will throw `FileNotFoundError` because the file doesn't exist. Use `resolveWritePath()`.
- **Calling `fs.realpath()` on non-existent paths:** Will throw `ENOENT`. Only call realpath on paths that are confirmed to exist.
- **Stripping frontmatter on append/prepend:** The user asked for frontmatter to be preserved. Always parse with gray-matter and reassemble with `matter.stringify`.
- **Using `require()` or CommonJS:** Project is ESM-only. Use `import * as fs from 'node:fs/promises'`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Frontmatter parsing/assembly | Custom YAML parser | `gray-matter` (installed) | Handles edge cases, already in use |
| YAML serialization | Manual string building | `gray-matter.stringify()` | Correct quoting, indentation, multi-value arrays |
| Atomic writes | Direct writeFile | temp file + `fs.rename()` | POSIX rename is atomic on same filesystem |
| Intermediate directory creation | Manual mkdir loop | `fs.mkdir(dir, { recursive: true })` | Built-in, handles race conditions |
| Path traversal protection | Custom validation from scratch | Extend existing `resolvePath()`/new `resolveWritePath()` | Already battle-tested in Phase 2 |

**Key insight:** The Node.js `fs.promises` API provides all the primitives needed. `fs.rename()` atomicity and `fs.mkdir({ recursive: true })` idempotency are well-documented, tested behaviors — not implementation-specific surprises.

## Common Pitfalls

### Pitfall 1: resolvePath Throws on Non-Existent Write Targets
**What goes wrong:** Calling `this.resolvePath(path)` for a create destination throws `FileNotFoundError` because the file doesn't exist yet.
**Why it happens:** `resolvePath()` calls `fs.lstat()` to reject symlinks — this also fails on ENOENT.
**How to avoid:** Implement `resolveWritePath()` that validates segments without `fs.lstat()`. Use it only for create and move-destination.
**Warning signs:** `FileNotFoundError` thrown during create operation before any write happens.

### Pitfall 2: gray-matter.stringify Adds Trailing Newline
**What goes wrong:** Content passed to `matter.stringify` gets an extra trailing newline, causing double newlines.
**Why it happens:** `gray-matter` always adds `\n` at end of output.
**How to avoid:** Don't manually add `\n` after calling `matter.stringify()`. Trim content before appending/prepending to avoid double blank lines: use `content.trimEnd() + '\n\n' + appendText`.
**Warning signs:** Double blank lines at end of file, or prepended text with excessive spacing.

### Pitfall 3: Forgetting to mkdir Before Atomic Write
**What goes wrong:** `fs.writeFile(tmpFile, ...)` fails with `ENOENT` because the directory doesn't exist.
**Why it happens:** Atomic write creates the temp file in `path.dirname(targetFile)` — that directory must exist.
**How to avoid:** Always call `fs.mkdir(path.dirname(targetFile), { recursive: true })` before the atomic write sequence for create and move operations.
**Warning signs:** `ENOENT` error during write even though path validation passed.

### Pitfall 4: Race Condition in "Check Then Create"
**What goes wrong:** Two concurrent create requests both pass the "file doesn't exist" check, then both write, second silently overwrites first.
**Why it happens:** Non-atomic check-then-act. Node.js is single-threaded but async operations interleave.
**How to avoid:** Use `fs.open(path, 'wx')` (exclusive create flag) for the initial create — `wx` fails with `EEXIST` if file already exists. This makes the existence check and creation atomic at the OS level.
**Warning signs:** Intermittent 200 instead of 409 under concurrent load tests.

### Pitfall 5: Corrupting Note Body When Updating Frontmatter
**What goes wrong:** Frontmatter update wipes the note body, or body content ends up in frontmatter.
**Why it happens:** Manual string manipulation instead of using gray-matter's parse/stringify cycle.
**How to avoid:** Always use `matter(raw)` to separate `data` and `content`, apply updates to `data`, then `matter.stringify(parsed.content, mergedData)`.
**Warning signs:** Note body empty after metadata update, or body content appearing as a YAML field.

### Pitfall 6: TypeBox Null in Metadata Update Schema
**What goes wrong:** TypeBox rejects `null` values in the metadata update body because the schema doesn't include `Type.Null()`.
**Why it happens:** Default `Type.Unknown()` doesn't allow `null` in strict validation.
**How to avoid:** Use `Type.Union([Type.Unknown(), Type.Null()])` for each value in the metadata update record schema.
**Warning signs:** 400 Bad Request when sending `{"status": null}` to the metadata update endpoint.

## Code Examples

### resolveWritePath (new VaultManager method)

```typescript
// Source: verified against Node.js path module behavior (2026-03-10)
async resolveWritePath(relativePath: string): Promise<string> {
  const normalized = relativePath.replace(/\/+/g, '/').replace(/^\//, '').replace(/\/$/, '');

  if (normalized === '') {
    throw new PathTraversalError('Empty path is not a valid write target');
  }

  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new PathTraversalError(`Path traversal detected: ${relativePath}`);
    }
    if (segment.startsWith('.')) {
      throw new DotfileAccessError(relativePath);
    }
  }

  const resolved = path.resolve(this.rootPath, normalized);

  if (resolved !== this.rootPath && !resolved.startsWith(this.rootPath + path.sep)) {
    throw new PathTraversalError(`Path traversal detected: ${relativePath}`);
  }

  return resolved;
}
```

### Atomic Write Helper (private VaultManager method)

```typescript
// Source: Node.js fs/promises + POSIX rename atomicity guarantee
import * as crypto from 'node:crypto';

private async atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpFile = path.join(dir, '.' + crypto.randomUUID() + '.tmp');
  try {
    await fs.writeFile(tmpFile, content, 'utf-8');
    await fs.rename(tmpFile, filePath);
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => {});
    throw err;
  }
}
```

### createNote Method

```typescript
// Source: verified gray-matter.stringify behavior (2026-03-10)
async createNote(
  filePath: string,
  content: string,
  frontmatter?: Record<string, unknown>,
): Promise<{ path: string; created: true }> {
  const resolved = await this.resolveWritePath(filePath);

  // Atomic exclusive create — EEXIST means file already exists → 409
  try {
    const fh = await fs.open(resolved, 'wx');
    await fh.close();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new FileExistsError(filePath);
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Directory doesn't exist yet — create it and retry
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      const fh = await fs.open(resolved, 'wx');
      await fh.close();
    } else {
      throw err;
    }
  }

  // Assemble file content
  const fileContent =
    frontmatter && Object.keys(frontmatter).length > 0
      ? matter.stringify(content, frontmatter)
      : content + '\n';

  await this.atomicWrite(resolved, fileContent);
  return { path: filePath, created: true };
}
```

### appendContent Method

```typescript
// Source: verified gray-matter parse+stringify round-trip (2026-03-10)
async appendContent(
  filePath: string,
  text: string,
  mode: 'append' | 'prepend',
): Promise<{ path: string; updated: true }> {
  const resolved = await this.resolvePath(filePath);  // Must exist
  const raw = await fs.readFile(resolved, 'utf-8');
  const parsed = matter(raw);

  const updatedContent =
    mode === 'append'
      ? parsed.content.trimEnd() + '\n\n' + text
      : text + '\n\n' + parsed.content.trimStart();

  // gray-matter.stringify with empty data omits --- block (verified)
  const output = matter.stringify(updatedContent, parsed.data);
  await this.atomicWrite(resolved, output);
  return { path: filePath, updated: true };
}
```

### updateMetadata Method

```typescript
// Source: verified gray-matter merge + null-delete pattern (2026-03-10)
async updateMetadata(
  filePath: string,
  updates: Record<string, unknown>,
): Promise<{ path: string; metadata: Record<string, unknown> }> {
  const resolved = await this.resolvePath(filePath);  // Must exist
  const raw = await fs.readFile(resolved, 'utf-8');
  const parsed = matter(raw);

  const merged = { ...parsed.data };
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }

  const output = matter.stringify(parsed.content, merged);
  await this.atomicWrite(resolved, output);
  return { path: filePath, metadata: merged };
}
```

### TypeBox Body Schema Examples

```typescript
import { type Static, Type } from '@sinclair/typebox';

// POST /api/vault/content — create
export const CreateNoteBodySchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  content: Type.String(),
  frontmatter: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type CreateNoteBody = Static<typeof CreateNoteBodySchema>;

// PUT /api/vault/content — replace
export const UpdateContentBodySchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  content: Type.String(),
});

// PATCH /api/vault/content — append/prepend
export const AppendContentBodySchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  content: Type.String(),
  mode: Type.Union([Type.Literal('append'), Type.Literal('prepend')]),
});

// DELETE /api/vault/content — delete
export const DeleteNoteBodySchema = Type.Object({
  path: Type.String({ minLength: 1 }),
});

// POST /api/vault/move — rename/move
export const MoveNoteBodySchema = Type.Object({
  from: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
});

// PATCH /api/vault/metadata — update frontmatter fields
export const UpdateMetadataBodySchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  metadata: Type.Record(Type.String(), Type.Union([Type.Unknown(), Type.Null()])),
});
```

### Route Registration Pattern (extending existing vaultRoutes plugin)

```typescript
// Source: established pattern from src/features/vault/routes.ts
import type { CreateNoteBody, ... } from './schemas.js';

fastify.post<{ Body: CreateNoteBody }>(
  '/content',
  { schema: createNoteSchema },
  async (request, reply) => {
    try {
      const { path, content, frontmatter } = request.body;
      const result = await fastify.vault.createNote(path, content, frontmatter);
      return reply.status(201).send(result);
    } catch (err: unknown) {
      handleVaultError(err, reply);
    }
  },
);
```

### Extending handleVaultError for 409

```typescript
// Add FileExistsError to handleVaultError in routes.ts
function handleVaultError(err: unknown, reply: FastifyReply): void {
  if (err instanceof VaultError) {
    reply.status(err.statusCode).send({
      error: { code: err.code, message: err.message },
    });
    return;
  }
  throw err;
}
// FileExistsError already has statusCode: 409 and code: 'FILE_EXISTS'
// Since it extends VaultError, no additional handling needed
```

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| Write directly to target file | Temp file + `fs.rename()` (atomic) | Prevents partial-write corruption |
| Manual YAML string manipulation | `gray-matter.stringify()` | Correct YAML quoting and escaping |
| `fs.access()` for existence check | `fs.open(path, 'wx')` for atomic create | Eliminates check-then-act race condition |
| Middleware-level path checking | VaultManager method encapsulation | Consistent security across all routes |

## Open Questions

1. **Append/prepend: what if file is not markdown?**
   - What we know: `appendContent` will call `resolvePath()` which currently allows non-.md files (it only rejects binary extensions via `readContent`). `resolvePath` itself does not filter by extension.
   - What's unclear: Should append/prepend be restricted to .md files? Or allowed for any text file?
   - Recommendation: Restrict to .md files — the frontmatter preservation logic is markdown-specific. Return 415 for non-.md files. The planner should make this a task-level decision and document it.

2. **moveNote: is the source required to be a file (not directory)?**
   - What we know: The CONTEXT.md says "rename or move note" — notes are files.
   - What's unclear: Should the API reject move requests on directories?
   - Recommendation: Yes — validate that `from` resolves to a file (`stat.isFile()`) and return 404 with a clear message if it's a directory. Directories are not notes.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest ^4.0.18 |
| Config file | vitest.config.ts (inferred from package.json scripts) |
| Quick run command | `pnpm test -- --run src/features/vault/__tests__/routes.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FILE-03 | POST /api/vault/content creates new note | unit (inject) | `pnpm test -- --run src/features/vault/__tests__/routes.test.ts` | ❌ Wave 0 (extend existing file) |
| FILE-03 | POST returns 409 if file exists | unit (inject) | same | ❌ Wave 0 |
| FILE-03 | POST auto-creates intermediate directories | unit (inject) | same | ❌ Wave 0 |
| FILE-03 | POST with frontmatter assembles YAML block | unit (inject) | same | ❌ Wave 0 |
| FILE-04 | PUT /api/vault/content replaces content | unit (inject) | same | ❌ Wave 0 |
| FILE-04 | PUT returns 404 if file doesn't exist | unit (inject) | same | ❌ Wave 0 |
| FILE-05 | PATCH appends text after existing content | unit (inject) | same | ❌ Wave 0 |
| FILE-05 | PATCH prepends text before existing content | unit (inject) | same | ❌ Wave 0 |
| FILE-05 | PATCH preserves frontmatter during append | unit (inject) | same | ❌ Wave 0 |
| FILE-06 | DELETE /api/vault/content removes file | unit (inject) | same | ❌ Wave 0 |
| FILE-06 | DELETE returns 404 if file doesn't exist | unit (inject) | same | ❌ Wave 0 |
| FILE-07 | POST /api/vault/move renames file | unit (inject) | same | ❌ Wave 0 |
| FILE-07 | POST /api/vault/move returns 409 if dest exists | unit (inject) | same | ❌ Wave 0 |
| FILE-07 | POST /api/vault/move auto-creates dest dirs | unit (inject) | same | ❌ Wave 0 |
| FILE-09 | PATCH /api/vault/metadata merges fields | unit (inject) | same | ❌ Wave 0 |
| FILE-09 | PATCH /api/vault/metadata deletes null fields | unit (inject) | same | ❌ Wave 0 |
| FILE-09 | PATCH preserves note body content | unit (inject) | same | ❌ Wave 0 |

VaultManager unit tests also belong in `src/lib/__tests__/vault.test.ts` (existing file — extend with write operation tests).

### Sampling Rate
- **Per task commit:** `pnpm test -- --run src/features/vault/__tests__/routes.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

No new test files needed — extend existing files:
- [ ] `src/lib/__tests__/vault.test.ts` — add describe blocks for `createNote`, `updateContent`, `appendContent`, `deleteNote`, `moveNote`, `updateMetadata`, `resolveWritePath`
- [ ] `src/features/vault/__tests__/routes.test.ts` — add describe blocks for POST/PUT/PATCH/DELETE `/api/vault/content`, POST `/api/vault/move`, PATCH `/api/vault/metadata`

## Sources

### Primary (HIGH confidence)
- Direct code inspection: `src/lib/vault.ts` — VaultManager implementation, error classes, resolvePath pattern
- Direct code inspection: `src/features/vault/routes.ts` — handleVaultError, plugin structure
- Direct code inspection: `src/features/vault/schemas.ts` — TypeBox schema patterns
- Direct code inspection: `src/lib/__tests__/vault.test.ts` — test fixture patterns
- Direct code inspection: `src/features/vault/__tests__/routes.test.ts` — inject-based test patterns
- Live verification: gray-matter parse/stringify behavior confirmed by running against installed package (node_modules/gray-matter v4.0.3)
- Live verification: atomic write pattern (temp+rename) verified by Node.js execution
- Live verification: resolveWritePath segment-only validation verified by execution
- Live verification: fs.open 'wx' flag for atomic exclusive create — confirmed by Node.js docs behavior

### Secondary (MEDIUM confidence)
- Node.js fs/promises documentation: `fs.rename()` is atomic on POSIX when source and destination are on the same filesystem
- Node.js fs/promises documentation: `fs.mkdir({ recursive: true })` is idempotent

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages installed, versions confirmed, no new dependencies
- Architecture patterns: HIGH — resolvePath limitation discovered by reading source, gray-matter behavior verified by execution
- Pitfalls: HIGH — each pitfall verified by reading existing code or live testing
- TypeBox schemas: HIGH — patterns confirmed from existing schemas.ts

**Research date:** 2026-03-10
**Valid until:** 2026-04-10 (stable stack, gray-matter v4 is long-lived)
