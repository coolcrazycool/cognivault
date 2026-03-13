# Phase 2: Vault Read Operations - Research

**Researched:** 2026-03-10
**Domain:** Filesystem access, path security, frontmatter parsing, Fastify plugin/decorator patterns
**Confidence:** HIGH

## Summary

Phase 2 implements three REST endpoints (`/api/vault/files`, `/api/vault/content`, `/api/vault/metadata`) backed by a vault manager service exposed as a Fastify decorator. The core technical challenges are: (1) secure path resolution that prevents traversal and symlink escapes, (2) frontmatter parsing with gray-matter, and (3) structuring the vault manager as a reusable Fastify plugin with TypeScript declaration merging.

The existing codebase from Phase 1 provides clear patterns: plugins use `fastify-plugin` with `fp()`, features follow the `routes.ts` + `schemas.ts` + `__tests__/` structure, auth skipping uses `config: { skipAuth: true }`, and error responses use `{ error: { code, message } }`. The vault plugin fits naturally between auth and feature routes in the registration order.

**Primary recommendation:** Build a `VaultManager` class in `src/lib/vault.ts` with methods for path resolution, listing, content reading, and metadata reading. Wrap it in a Fastify plugin (`src/plugins/vault.ts`) that decorates the instance as `fastify.vault`. Use `path.resolve()` + `fs.realpath()` for defense-in-depth path security. Use `gray-matter` for frontmatter parsing.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Paths passed as query parameters: `GET /api/vault/files?path=Projects/CogniVault`
- Route prefix: `/api/vault` for all vault endpoints
- Flat listing by default; `?recursive=true` for deep listing
- Minimal metadata per entry: name, relative path, type (file/directory)
- Extension filter: `?ext=md` to filter by file extension
- No pagination -- return all results at once
- Infer directory vs file from filesystem (no trailing slash requirement)
- Root listing: omit `?path=` or pass empty string -- both return vault root
- Separate endpoints for content and metadata: `GET /api/vault/content?path=...` and `GET /api/vault/metadata?path=...`
- Content endpoint strips frontmatter YAML block, returns markdown body only
- Content response: `{"path": "Notes/foo.md", "content": "markdown body..."}`
- Metadata response: `{"path": "Notes/foo.md", "metadata": {"tags": [...], "status": "draft"}}` -- parsed JSON object, not raw YAML
- Reject symlinks -- any path resolving through a symlink returns 403
- Exclude all dotfiles/dotfolders (`.obsidian`, `.trash`, `.git`) from listings and reject reads
- Path traversal attempts (`../../etc/passwd`) return 403 with specific error code `PATH_TRAVERSAL` and descriptive message
- Path normalization happens before traversal check (collapse `//`, strip leading/trailing slashes)
- Exposed as Fastify decorator: `fastify.vault.listFiles(...)`, `fastify.vault.readContent(...)`, etc.
- Core logic in `src/lib/vault.ts`, Fastify plugin wrapper in `src/plugins/vault.ts`
- Startup validation: fail fast if VAULT_PATH doesn't exist or isn't a directory
- Extend readiness endpoint to check vault accessibility
- Library: gray-matter (Obsidian-ecosystem standard)
- Malformed YAML: return 200 with empty metadata `{}` and a `warning` field noting parse failure
- Normalize `tags` field to always be an array (Obsidian allows string or array); other fields as-is
- Preserve nested YAML objects as nested JSON (no flattening)
- UTF-8 Cyrillic paths accepted as-is in query params
- Literal spaces accepted -- Fastify handles URL decoding
- Internal path normalization: collapse double slashes, strip leading/trailing slashes
- Case-sensitive path matching (matches filesystem behavior)
- Nonexistent paths: 404 with path in message
- Notes without frontmatter: metadata endpoint returns 200 with `{"metadata": {}}`
- Binary files: appear in listings but content read returns 415 Unsupported Media Type
- No file size limit for reads

### Claude's Discretion
- Exact TypeBox schema definitions for request/response validation
- Internal path resolution implementation (path.resolve vs path.join)
- Vault manager method signatures and error class design
- Test fixtures and mock vault structure
- How binary file detection works (extension-based vs content sniffing)

### Deferred Ideas (OUT OF SCOPE)
- Full binary file read support (images, PDFs via content endpoint) -- future enhancement
- Pagination for very large vaults -- not needed now
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| FILE-01 | Agent can list files and folders in vault with path filtering | Vault manager `listFiles()` with `fs.readdir`/recursive walk, path prefix + extension filtering |
| FILE-02 | Agent can read note content by path | Vault manager `readContent()` with gray-matter to strip frontmatter, return markdown body |
| FILE-08 | Agent can read frontmatter metadata from any note | Vault manager `readMetadata()` with gray-matter parsing, tag normalization, malformed YAML handling |
| FILE-10 | Service rejects paths that traverse outside vault boundary | Path resolution with `path.resolve()` + `fs.realpath()` + `startsWith()` check, symlink rejection, dotfile exclusion |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| gray-matter | 4.0.3 | YAML frontmatter parsing | Battle-tested, used by Astro/Gatsby/VitePress/Obsidian ecosystem. Parses YAML, returns `{ data, content }` cleanly |
| node:fs/promises | built-in | Async filesystem operations | Standard Node.js API for readdir, readFile, stat, realpath, lstat |
| node:path | built-in | Path resolution and normalization | Standard Node.js API for resolve, join, normalize, relative |
| fastify-plugin | 5.1.0 | Already installed | Encapsulates vault decorator so it's accessible across the Fastify instance |
| @sinclair/typebox | 0.34.48 | Already installed | TypeBox schemas for route request/response validation |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @types/gray-matter | N/A | Not needed | gray-matter ships its own `gray-matter.d.ts` type definitions |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| gray-matter | front-matter (npm) | front-matter is simpler but less battle-tested; gray-matter is the ecosystem standard |
| Extension-based binary detection | file-type (npm, content sniffing) | Content sniffing is more accurate but requires reading file bytes; extension-based is fast and sufficient for this phase |

**Installation:**
```bash
pnpm add gray-matter
```

No `@types/gray-matter` needed -- types are bundled. gray-matter is CJS with bundled `.d.ts`, imported in ESM via `import matter from 'gray-matter'` (it has a default export, and `esModuleInterop: true` is set in tsconfig).

## Architecture Patterns

### Recommended Project Structure
```
src/
  lib/
    vault.ts             # VaultManager class (pure logic, no Fastify dependency)
  plugins/
    vault.ts             # Fastify plugin: creates VaultManager, decorates instance
  features/
    vault/
      routes.ts          # Three route handlers using fastify.vault
      schemas.ts         # TypeBox schemas for all three endpoints
      service.ts         # Optional thin layer (may inline into routes if simple)
      __tests__/
        routes.test.ts   # Route-level integration tests
  lib/
    __tests__/
      vault.test.ts      # Unit tests for VaultManager (pure path logic)
```

### Pattern 1: VaultManager Class
**What:** A standalone class encapsulating all vault filesystem operations with no Fastify dependency.
**When to use:** Core vault logic that is testable in isolation.
**Example:**
```typescript
// src/lib/vault.ts
import { readdir, readFile, stat, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';

interface VaultEntry {
  name: string;
  path: string;       // relative to vault root
  type: 'file' | 'directory';
}

interface ListOptions {
  path?: string;
  recursive?: boolean;
  ext?: string;
}

interface ContentResult {
  path: string;
  content: string;
}

interface MetadataResult {
  path: string;
  metadata: Record<string, unknown>;
  warning?: string;
}

export class VaultManager {
  private readonly rootPath: string;  // resolved absolute path

  constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  async resolvePath(relativePath: string): Promise<string> {
    // Normalize: collapse //, strip leading/trailing slashes
    const normalized = relativePath
      .replace(/\/+/g, '/')
      .replace(/^\/|\/$/g, '');

    // Resolve against vault root
    const resolved = path.resolve(this.rootPath, normalized);

    // Check prefix BEFORE realpath (catches .. traversal)
    if (!resolved.startsWith(this.rootPath)) {
      throw new PathTraversalError(relativePath);
    }

    // Check for symlinks via lstat vs realpath comparison
    const real = await realpath(resolved);
    if (!real.startsWith(this.rootPath)) {
      throw new PathTraversalError(relativePath);
    }

    return resolved;
  }

  // ... listFiles, readContent, readMetadata methods
}
```

### Pattern 2: Fastify Plugin Decorator with Type Augmentation
**What:** Wrapping VaultManager as a Fastify decorator with proper TypeScript types.
**When to use:** Exposing vault operations to route handlers.
**Example:**
```typescript
// src/plugins/vault.ts
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { VaultManager } from '../lib/vault.js';
import { config } from '../config.js';

// Type augmentation for fastify.vault
declare module 'fastify' {
  interface FastifyInstance {
    vault: VaultManager;
  }
}

async function vaultPlugin(fastify: FastifyInstance): Promise<void> {
  const vaultManager = new VaultManager(config.VAULT_PATH);
  await vaultManager.initialize(); // validates VAULT_PATH exists and is directory

  fastify.decorate('vault', vaultManager);
}

export default fp(vaultPlugin, {
  name: 'vault',
});
```

### Pattern 3: Route Prefix Registration
**What:** Register vault routes under `/api/vault` prefix using Fastify's `prefix` option.
**When to use:** All vault endpoints share the `/api/vault` prefix.
**Example:**
```typescript
// src/features/vault/routes.ts
import type { FastifyInstance } from 'fastify';
import { listSchema, contentSchema, metadataSchema } from './schemas.js';

export async function vaultRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/files', { schema: listSchema }, async (request, reply) => {
    const { path: dirPath, recursive, ext } = request.query as { path?: string; recursive?: boolean; ext?: string };
    const entries = await fastify.vault.listFiles({ path: dirPath, recursive, ext });
    return { entries };
  });

  // ... /content and /metadata routes
}

// Registration in app.ts:
// await app.register(vaultRoutes, { prefix: '/api/vault' });
```

### Pattern 4: Custom Error Classes
**What:** Typed error classes for vault-specific failures that map to HTTP status codes.
**When to use:** Path traversal, not found, unsupported media type errors.
**Example:**
```typescript
// src/lib/vault.ts (or a dedicated errors file)
export class VaultError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

export class PathTraversalError extends VaultError {
  constructor(attemptedPath: string) {
    super(
      `Path traversal detected: ${attemptedPath}`,
      'PATH_TRAVERSAL',
      403,
    );
  }
}

export class FileNotFoundError extends VaultError {
  constructor(filePath: string) {
    super(`File not found: ${filePath}`, 'NOT_FOUND', 404);
  }
}

export class UnsupportedMediaTypeError extends VaultError {
  constructor(filePath: string) {
    super(`Binary file not supported: ${filePath}`, 'UNSUPPORTED_MEDIA_TYPE', 415);
  }
}
```

### Anti-Patterns to Avoid
- **Using `path.join()` alone for security:** `path.join('/vault', '../../etc/passwd')` resolves to `/etc/passwd`. Always use `path.resolve()` and then verify the result starts with the vault root.
- **Checking traversal after `fs.realpath()`only:** `realpath` throws ENOENT if the file does not exist, which leaks information. Check the `path.resolve()` result first (catches `..` without touching the filesystem), then use `realpath` for symlink detection on existing files.
- **Putting path security logic in route handlers:** Path validation must be centralized in the VaultManager, not duplicated across routes. Every filesystem access goes through `resolvePath()`.
- **Using `path.normalize()` as a security measure:** `path.normalize()` collapses `..` but does not resolve against a root. It is not sufficient for traversal prevention.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| YAML frontmatter parsing | Custom regex/split on `---` delimiters | gray-matter | Edge cases with YAML special chars, multi-document YAML, empty frontmatter, non-YAML frontmatter |
| Path security | Simple string `includes('..')` check | `path.resolve()` + `fs.realpath()` + `startsWith()` | URL encoding, unicode normalization, null bytes, symlink chains, double encoding attacks |
| Recursive directory walk | Manual recursive function | `fs.readdir(dir, { recursive: true })` | Node 20+ supports `recursive` option natively -- handles errors and edge cases |

**Key insight:** Path traversal prevention is deceptively complex. String-level checks (blocking `..`) miss URL-encoded variants, unicode tricks, and symlink escapes. The only safe approach is to resolve to an absolute canonical path and verify it starts with the vault root.

## Common Pitfalls

### Pitfall 1: TOCTOU Race in Path Resolution
**What goes wrong:** Checking path safety then reading the file allows a race condition where a symlink is created between check and read.
**Why it happens:** Two-step check-then-use pattern.
**How to avoid:** For this project (single-user local vault), this is acceptable risk. The symlink check via `lstat` + `realpath` is defense-in-depth, not a security boundary against malicious local users. Document the limitation.
**Warning signs:** N/A for single-user context.

### Pitfall 2: gray-matter Import in ESM
**What goes wrong:** `import matter from 'gray-matter'` may fail or return `{ default: [Function] }` wrapper.
**Why it happens:** gray-matter is CJS. ESM interop varies by Node.js version and bundler.
**How to avoid:** The project has `esModuleInterop: true` in tsconfig. Use `import matter from 'gray-matter'`. If issues arise at runtime, fall back to `import pkg from 'gray-matter'; const matter = pkg.default ?? pkg;`.
**Warning signs:** `matter is not a function` at runtime.

### Pitfall 3: `fs.readdir` with `recursive: true` Not Returning Relative Paths
**What goes wrong:** `fs.readdir(dir, { recursive: true })` returns paths relative to the directory being read, but the separator and format can surprise.
**Why it happens:** Node.js returns entries like `subdir/file.md` (forward slash on all platforms in recent Node).
**How to avoid:** Always join results with the base directory and re-derive the vault-relative path.
**Warning signs:** Paths with wrong separators or missing directory prefixes.

### Pitfall 4: Dotfile Check Must Happen on Each Path Segment
**What goes wrong:** Checking only the final filename misses dotfolders like `.obsidian/workspace.json`.
**Why it happens:** Only checking `path.basename()` instead of each segment.
**How to avoid:** Split the relative path on `/` and check each segment for leading dot.
**Warning signs:** Files inside `.obsidian` appearing in listings.

### Pitfall 5: Empty Path Handling
**What goes wrong:** `path.resolve(root, '')` returns `root`, but `path.resolve(root, undefined)` throws.
**Why it happens:** Query parameter `path` may be `undefined` when omitted.
**How to avoid:** Default to `''` when `path` query param is not provided. Handle in TypeBox schema with `Type.Optional(Type.String({ default: '' }))`.
**Warning signs:** Unhandled TypeError on root listing.

### Pitfall 6: frontmatter tags Field Normalization
**What goes wrong:** Obsidian allows `tags: productivity` (string) or `tags: [productivity, dev]` (array). Consumers expect a consistent array.
**Why it happens:** YAML spec allows both scalar and sequence values.
**How to avoid:** After gray-matter parse, check if `data.tags` is a string; if so, wrap in array. If array, keep as-is. If absent, leave absent (do not inject empty array).
**Warning signs:** Downstream consumers crash on `tags.map()` when tags is a string.

## Code Examples

### Path Resolution with Defense-in-Depth
```typescript
// Source: Node.js docs + security best practices
import { realpath, lstat } from 'node:fs/promises';
import path from 'node:path';

function normalizePath(inputPath: string): string {
  return inputPath
    .replace(/\/+/g, '/')       // collapse double slashes
    .replace(/^\/|\/$/g, '');   // strip leading/trailing slashes
}

function hasDotSegment(relativePath: string): boolean {
  return relativePath.split('/').some(segment => segment.startsWith('.'));
}

async function resolveVaultPath(vaultRoot: string, userPath: string): Promise<string> {
  const normalized = normalizePath(userPath);

  // Reject dotfiles/dotfolders
  if (normalized !== '' && hasDotSegment(normalized)) {
    throw new Error('Access to hidden files/folders is forbidden');
  }

  // Resolve against vault root
  const resolved = path.resolve(vaultRoot, normalized);

  // Verify resolved path is within vault (catches .. traversal)
  if (!resolved.startsWith(vaultRoot + path.sep) && resolved !== vaultRoot) {
    throw new Error('Path traversal detected');
  }

  // For existing paths, verify no symlink escape
  try {
    const stats = await lstat(resolved);
    if (stats.isSymbolicLink()) {
      throw new Error('Symlinks are not allowed');
    }
    const real = await realpath(resolved);
    if (!real.startsWith(vaultRoot)) {
      throw new Error('Path resolves outside vault via symlink');
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('File not found');
    }
    throw err;
  }

  return resolved;
}
```

### gray-matter Usage
```typescript
// Source: gray-matter README + bundled types
import matter from 'gray-matter';

function parseNote(fileContent: string, filePath: string): { content: string; metadata: Record<string, unknown>; warning?: string } {
  try {
    const parsed = matter(fileContent);

    // Normalize tags to always be an array
    const metadata = { ...parsed.data };
    if (typeof metadata.tags === 'string') {
      metadata.tags = [metadata.tags];
    }

    return {
      content: parsed.content.trim(),
      metadata,
    };
  } catch {
    // Malformed YAML: return empty metadata with warning
    return {
      content: fileContent,
      metadata: {},
      warning: `Failed to parse frontmatter in ${filePath}`,
    };
  }
}
```

### TypeBox Schemas for Vault Endpoints
```typescript
// Source: TypeBox docs + existing project schemas pattern
import { type Static, Type } from '@sinclair/typebox';

// Shared query param for path
const PathQuery = Type.Object({
  path: Type.Optional(Type.String({ default: '' })),
});

// GET /api/vault/files
const VaultEntrySchema = Type.Object({
  name: Type.String(),
  path: Type.String(),
  type: Type.Union([Type.Literal('file'), Type.Literal('directory')]),
});

export const ListFilesQuerySchema = Type.Object({
  path: Type.Optional(Type.String({ default: '' })),
  recursive: Type.Optional(Type.Boolean({ default: false })),
  ext: Type.Optional(Type.String()),
});

export const ListFilesResponseSchema = Type.Object({
  entries: Type.Array(VaultEntrySchema),
});

// GET /api/vault/content
export const ContentQuerySchema = Type.Object({
  path: Type.String(),  // required for content
});

export const ContentResponseSchema = Type.Object({
  path: Type.String(),
  content: Type.String(),
});

// GET /api/vault/metadata
export const MetadataQuerySchema = Type.Object({
  path: Type.String(),  // required for metadata
});

export const MetadataResponseSchema = Type.Object({
  path: Type.String(),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  warning: Type.Optional(Type.String()),
});

// Error response (reusable)
export const ErrorResponseSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
  }),
});
```

### Binary File Detection (Extension-Based)
```typescript
// Source: Common extension lists from IANA media types
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml',
  '.css', '.js', '.ts', '.html', '.xml', '.csv', '.svg',
  '.canvas', '.excalidraw',  // Obsidian-specific
]);

function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}
```

### Recursive Directory Listing
```typescript
// Source: Node.js v22 fs.readdir with recursive option
import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';

async function listEntries(
  vaultRoot: string,
  dirPath: string,
  options: { recursive?: boolean; ext?: string },
): Promise<VaultEntry[]> {
  const entries = await readdir(dirPath, {
    withFileTypes: true,
    recursive: options.recursive ?? false,
  });

  const results: VaultEntry[] = [];

  for (const entry of entries) {
    // Derive relative path from vault root
    const entryAbsolute = path.join(entry.parentPath ?? dirPath, entry.name);
    const relativePath = path.relative(vaultRoot, entryAbsolute);

    // Skip dotfiles/dotfolders
    if (relativePath.split(path.sep).some(s => s.startsWith('.'))) {
      continue;
    }

    // Skip symlinks
    if (entry.isSymbolicLink()) {
      continue;
    }

    // Apply extension filter
    if (options.ext && entry.isFile()) {
      const ext = options.ext.startsWith('.') ? options.ext : `.${options.ext}`;
      if (!entry.name.endsWith(ext)) continue;
    }

    results.push({
      name: entry.name,
      path: relativePath,
      type: entry.isDirectory() ? 'directory' : 'file',
    });
  }

  return results;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual recursive walk | `fs.readdir(dir, { recursive: true })` | Node 20 (2023) | No need for custom recursion; built-in is faster and handles edge cases |
| `fs.promises` import | `import { readdir } from 'node:fs/promises'` | Node 16+ | `node:` prefix is the modern standard for built-in modules |
| Sync `realpathSync` for security | Async `realpath` in async context | Always preferred | Non-blocking vault operations |

**Deprecated/outdated:**
- `fs.readdir` callback-based API: Use `node:fs/promises` consistently
- `path.join()` for untrusted paths: Use `path.resolve()` for security-critical path construction

## Open Questions

1. **gray-matter CJS/ESM interop at runtime**
   - What we know: gray-matter 4.0.3 is CJS, project uses `esModuleInterop: true`, Node 22 handles CJS default imports well
   - What's unclear: Whether the specific Node 24 version on this machine handles the interop without issues
   - Recommendation: Test the import early in implementation. If `matter` is not callable, use `const matter = (await import('gray-matter')).default`

2. **`entry.parentPath` availability in recursive readdir**
   - What we know: `Dirent.parentPath` was added in Node 20.12 / 21.4. This project targets Node 22+
   - What's unclear: Whether the available Node.js type definitions include `parentPath`
   - Recommendation: Use `entry.parentPath` with a fallback. The `@types/node` v25 in the project should include it.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.0.18 |
| Config file | `vitest.config.ts` (exists, includes `src/**/__tests__/**/*.test.ts`) |
| Quick run command | `pnpm test -- --run src/features/vault/__tests__/routes.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FILE-01 | List files/folders with path filtering | integration | `pnpm test -- --run src/features/vault/__tests__/routes.test.ts` | No - Wave 0 |
| FILE-02 | Read note content by path | integration | `pnpm test -- --run src/features/vault/__tests__/routes.test.ts` | No - Wave 0 |
| FILE-08 | Read frontmatter metadata | integration | `pnpm test -- --run src/features/vault/__tests__/routes.test.ts` | No - Wave 0 |
| FILE-10 | Reject path traversal | unit + integration | `pnpm test -- --run src/lib/__tests__/vault.test.ts` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test -- --run src/features/vault/__tests__/routes.test.ts src/lib/__tests__/vault.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/lib/__tests__/vault.test.ts` -- VaultManager unit tests (path resolution, dotfile filtering, symlink rejection)
- [ ] `src/features/vault/__tests__/routes.test.ts` -- route integration tests (all three endpoints, auth, error codes)
- [ ] Test fixture: temporary vault directory structure with markdown files, subdirectories, dotfolders, symlinks, binary files
- [ ] Framework install: `pnpm add gray-matter` -- new dependency needed

## Sources

### Primary (HIGH confidence)
- Existing codebase (`src/app.ts`, `src/plugins/auth.ts`, `src/plugins/error-handler.ts`, `src/features/health/`) -- established patterns
- [Node.js fs/promises docs](https://nodejs.org/api/fs.html) -- readdir recursive, realpath, lstat APIs
- [Node.js path docs](https://nodejs.org/api/path.html) -- resolve, relative, normalize
- [Fastify TypeScript decorators](https://fastify.dev/docs/latest/Reference/TypeScript/) -- declaration merging pattern for `FastifyInstance`

### Secondary (MEDIUM confidence)
- [gray-matter GitHub](https://github.com/jonschlinkert/gray-matter) -- API shape, return type `{ data, content }`, bundled TypeScript definitions
- [Node.js Path Traversal Security Guide](https://nodejsdesignpatterns.com/blog/nodejs-path-traversal-security/) -- defense-in-depth approach with resolve + realpath + startsWith
- [Node.js Secure Coding Practices](https://www.nodejs-security.com/blog/secure-coding-practices-nodejs-path-traversal-vulnerabilities) -- input validation and path normalization

### Tertiary (LOW confidence)
- gray-matter ESM interop behavior -- based on general CJS/ESM interop knowledge, needs runtime verification

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- gray-matter is well-established (4.0.3), all other deps are Node.js built-ins or already installed
- Architecture: HIGH -- patterns directly follow existing Phase 1 code (plugin, decorator, routes, schemas, tests)
- Pitfalls: HIGH -- path traversal security is well-documented; gray-matter edge cases are known
- ESM interop: MEDIUM -- gray-matter CJS import in ESM project needs runtime verification

**Research date:** 2026-03-10
**Valid until:** 2026-04-10 (stable domain, no fast-moving dependencies)
