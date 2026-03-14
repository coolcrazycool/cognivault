import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Mock OpenAI to avoid real API calls during embedding plugin validation
vi.mock('openai', () => {
  const mockEmbeddingsCreate = vi.fn().mockResolvedValue({
    data: [{ index: 0, embedding: new Array(1536).fill(0.1) }],
  });
  class MockOpenAI {
    embeddings = { create: mockEmbeddingsCreate };
  }
  return { default: MockOpenAI };
});

// Mock Qdrant client to avoid connection to localhost:6333 during plugin init
vi.mock('@qdrant/js-client-rest', () => {
  class MockQdrantClient {
    getCollections = vi.fn().mockResolvedValue({ collections: [{ name: 'cognivault' }] });
    createCollection = vi.fn().mockResolvedValue({});
    createPayloadIndex = vi.fn().mockResolvedValue({});
    upsert = vi.fn().mockResolvedValue({});
    delete = vi.fn().mockResolvedValue({});
    setPayload = vi.fn().mockResolvedValue({});
    search = vi.fn().mockResolvedValue([]);
    query = vi.fn().mockResolvedValue({ points: [] });
    scroll = vi.fn().mockResolvedValue({ points: [] });
  }
  return { QdrantClient: MockQdrantClient };
});

let tmpDir: string;
let vaultRoot: string;

// Create test vault fixture before anything else
tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-routes-test-'));
vaultRoot = path.join(tmpDir, 'vault');
await fs.mkdir(vaultRoot, { recursive: true });
await fs.mkdir(path.join(vaultRoot, 'notes'), { recursive: true });
await fs.mkdir(path.join(vaultRoot, 'notes', 'daily'), { recursive: true });
await fs.mkdir(path.join(vaultRoot, '.obsidian'), { recursive: true });

// Metadata test fixtures
await fs.writeFile(
  path.join(vaultRoot, 'note-with-tags-array.md'),
  '---\ntitle: Test\ntags:\n  - a\n  - b\n---\n# Content',
);
await fs.writeFile(
  path.join(vaultRoot, 'note-with-tags-string.md'),
  '---\ntitle: Test\ntags: productivity\n---\n# Content',
);
await fs.writeFile(
  path.join(vaultRoot, 'note-with-nested.md'),
  '---\ntitle: Test\nauthor:\n  name: Alice\n  email: alice@example.com\n---\n# Content',
);
await fs.writeFile(
  path.join(vaultRoot, 'no-frontmatter.md'),
  '# Just a heading\n\nSome content without frontmatter.',
);
await fs.writeFile(
  path.join(vaultRoot, 'malformed-yaml.md'),
  '---\n: invalid\n  broken:\n    - [unclosed\n---\n# Content',
);

// List/content test fixtures
await fs.writeFile(
  path.join(vaultRoot, 'notes', 'hello.md'),
  '---\ntitle: Hello\n---\n\n# Hello World\n\nBody here.',
);
await fs.writeFile(path.join(vaultRoot, 'notes', 'plain.md'), '# Plain note');
await fs.writeFile(path.join(vaultRoot, 'notes', 'daily', 'monday.md'), '# Monday');
await fs.writeFile(path.join(vaultRoot, '.obsidian', 'workspace.json'), '{}');
const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
await fs.writeFile(path.join(vaultRoot, 'image.png'), pngHeader);

// Set env vars before importing app
const dataDir = path.join(tmpDir, 'data');
await fs.mkdir(dataDir, { recursive: true });
await fs.writeFile(
  path.join(dataDir, 'users.json'),
  JSON.stringify([
    {
      userId: 'test-user',
      apiKey: 'cv-test-key-001',
      vaultPath: vaultRoot,
      openaiKey: 'test-openai-key',
      obsidian: { email: 'test@test.com', password: 'secret', vault: 'test-vault' },
    },
  ]),
);
process.env.VAULT_PATH = vaultRoot;
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.COGNIVAULT_DATA_DIR = dataDir;

const { buildApp } = await import('../../../app.js');

describe('vault routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    // Indexer and pipeline are disabled in Phase 17 (per-user refactoring).
    // No need to wait for scan completion.
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/vault/files', () => {
    it('returns 200 with entries at vault root', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/files',
        headers: { authorization: 'Bearer cv-test-key-001' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.entries).toBeDefined();
      expect(Array.isArray(body.entries)).toBe(true);
      const names = body.entries.map((e: { name: string }) => e.name);
      expect(names).toContain('notes');
    });

    it('returns entries in a subfolder', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/files?path=notes',
        headers: { authorization: 'Bearer cv-test-key-001' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const names = body.entries.map((e: { name: string }) => e.name);
      expect(names).toContain('hello.md');
      expect(names).toContain('daily');
    });

    it('returns nested entries with recursive=true', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/files?recursive=true',
        headers: { authorization: 'Bearer cv-test-key-001' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const paths = body.entries.map((e: { path: string }) => e.path);
      expect(paths).toContain('notes/daily/monday.md');
    });

    it('filters by extension', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/files?ext=md&recursive=true',
        headers: { authorization: 'Bearer cv-test-key-001' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      for (const entry of body.entries) {
        if (entry.type === 'file') {
          expect(entry.name).toMatch(/\.md$/);
        }
      }
    });

    it('returns 403 for path traversal', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/files?path=../../etc',
        headers: { authorization: 'Bearer cv-test-key-001' },
      });
      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.error.code).toBe('PATH_TRAVERSAL');
    });

    it('returns 401 without auth header', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/files',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /api/vault/content', () => {
    it('returns 200 with content for markdown file', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/content?path=notes/hello.md',
        headers: { authorization: 'Bearer cv-test-key-001' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.path).toBe('notes/hello.md');
      expect(body.content).toBe('# Hello World\n\nBody here.');
      expect(body.content).not.toContain('---');
    });

    it('returns 404 for nonexistent file', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/content?path=nonexistent.md',
        headers: { authorization: 'Bearer cv-test-key-001' },
      });
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns 415 for binary file', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/content?path=image.png',
        headers: { authorization: 'Bearer cv-test-key-001' },
      });
      expect(response.statusCode).toBe(415);
      const body = response.json();
      expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('returns 403 for path traversal', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/content?path=../../etc/passwd',
        headers: { authorization: 'Bearer cv-test-key-001' },
      });
      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.error.code).toBe('PATH_TRAVERSAL');
    });

    it('returns 400 when path query param is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/content',
        headers: { authorization: 'Bearer cv-test-key-001' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 401 without auth header', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/content?path=notes/hello.md',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /api/vault/metadata', () => {
    it('returns 200 with parsed frontmatter for note with tags array', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/metadata?path=note-with-tags-array.md',
        headers: { authorization: 'Bearer cv-test-key-001' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.path).toBe('note-with-tags-array.md');
      expect(body.metadata.title).toBe('Test');
      expect(body.metadata.tags).toEqual(['a', 'b']);
    });

    it('normalizes tags string to array', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/metadata?path=note-with-tags-string.md',
        headers: { authorization: 'Bearer cv-test-key-001' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.metadata.tags).toEqual(['productivity']);
    });

    it('preserves nested YAML as nested JSON', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/metadata?path=note-with-nested.md',
        headers: { authorization: 'Bearer cv-test-key-001' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.metadata.author).toEqual({ name: 'Alice', email: 'alice@example.com' });
    });

    it('returns 200 with empty metadata for note without frontmatter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/metadata?path=no-frontmatter.md',
        headers: { authorization: 'Bearer cv-test-key-001' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.path).toBe('no-frontmatter.md');
      expect(body.metadata).toEqual({});
    });

    it('returns 200 with empty metadata and warning for malformed YAML', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/metadata?path=malformed-yaml.md',
        headers: { authorization: 'Bearer cv-test-key-001' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.metadata).toEqual({});
      expect(body.warning).toBeDefined();
      expect(body.warning).toContain('Failed to parse frontmatter');
    });

    it('returns 404 for nonexistent file', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/metadata?path=nonexistent.md',
        headers: { authorization: 'Bearer cv-test-key-001' },
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 403 for path traversal attempt', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/metadata?path=../../etc/passwd',
        headers: { authorization: 'Bearer cv-test-key-001' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('returns 400 when path query param is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/metadata',
        headers: { authorization: 'Bearer cv-test-key-001' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('returns 401 without auth header', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/metadata?path=note-with-tags-array.md',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /api/vault/content', () => {
    it('creates a new note and returns 201', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/content',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: 'notes/new-post.md', content: 'Created via POST' },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.path).toBe('notes/new-post.md');
      expect(body.created).toBe(true);
      // Verify file exists on disk
      const diskContent = await fs.readFile(path.join(vaultRoot, 'notes', 'new-post.md'), 'utf-8');
      expect(diskContent).toContain('Created via POST');
    });

    it('returns 409 when file already exists', async () => {
      await fs.writeFile(path.join(vaultRoot, 'notes', 'conflict.md'), 'existing');
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/content',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: 'notes/conflict.md', content: 'new content' },
      });
      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.error.code).toBe('FILE_EXISTS');
    });

    it('creates note with frontmatter YAML block', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/content',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: {
          path: 'notes/with-frontmatter-post.md',
          content: 'Body text',
          frontmatter: { title: 'My Note', tags: ['test'] },
        },
      });
      expect(response.statusCode).toBe(201);
      const diskContent = await fs.readFile(
        path.join(vaultRoot, 'notes', 'with-frontmatter-post.md'),
        'utf-8',
      );
      expect(diskContent).toContain('title: My Note');
      expect(diskContent).toContain('Body text');
      expect(diskContent).toContain('---');
    });

    it('auto-creates intermediate directories', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/content',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: 'deep/nested/route/note.md', content: 'Deep note content' },
      });
      expect(response.statusCode).toBe(201);
      const exists = await fs
        .access(path.join(vaultRoot, 'deep', 'nested', 'route', 'note.md'))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it('returns 403 for path traversal', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/content',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: '../escape.md', content: 'bad content' },
      });
      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.error.code).toBe('PATH_TRAVERSAL');
    });

    it('returns 401 without auth header', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/content',
        headers: { 'content-type': 'application/json' },
        payload: { path: 'notes/unauth.md', content: 'content' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('PUT /api/vault/content', () => {
    it('replaces note content and returns 200', async () => {
      await fs.writeFile(path.join(vaultRoot, 'notes', 'update-route.md'), 'Old content\n');
      const response = await app.inject({
        method: 'PUT',
        url: '/api/vault/content',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: 'notes/update-route.md', content: 'New content' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.path).toBe('notes/update-route.md');
      expect(body.updated).toBe(true);
      const diskContent = await fs.readFile(
        path.join(vaultRoot, 'notes', 'update-route.md'),
        'utf-8',
      );
      expect(diskContent).toBe('New content\n');
    });

    it('returns 404 for nonexistent file', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/vault/content',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: 'notes/nonexistent-put.md', content: 'content' },
      });
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns 403 for path traversal', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/vault/content',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: '../escape.md', content: 'bad' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('returns 401 without auth header', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/vault/content',
        headers: { 'content-type': 'application/json' },
        payload: { path: 'notes/hello.md', content: 'content' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('PATCH /api/vault/content', () => {
    it('appends text after content and returns 200', async () => {
      await fs.writeFile(path.join(vaultRoot, 'notes', 'patch-append.md'), 'Original\n');
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/vault/content',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: 'notes/patch-append.md', content: 'Appended', mode: 'append' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.updated).toBe(true);
      const diskContent = await fs.readFile(
        path.join(vaultRoot, 'notes', 'patch-append.md'),
        'utf-8',
      );
      expect(diskContent).toContain('Original');
      expect(diskContent).toContain('Appended');
      expect(diskContent.indexOf('Appended')).toBeGreaterThan(diskContent.indexOf('Original'));
    });

    it('prepends text before content and returns 200', async () => {
      await fs.writeFile(path.join(vaultRoot, 'notes', 'patch-prepend.md'), 'Original\n');
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/vault/content',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: 'notes/patch-prepend.md', content: 'Prepended', mode: 'prepend' },
      });
      expect(response.statusCode).toBe(200);
      const diskContent = await fs.readFile(
        path.join(vaultRoot, 'notes', 'patch-prepend.md'),
        'utf-8',
      );
      expect(diskContent).toContain('Original');
      expect(diskContent).toContain('Prepended');
      expect(diskContent.indexOf('Prepended')).toBeLessThan(diskContent.indexOf('Original'));
    });

    it('preserves frontmatter during append', async () => {
      await fs.writeFile(
        path.join(vaultRoot, 'notes', 'patch-fm-append.md'),
        '---\ntitle: Keep Me\n---\n\nBody\n',
      );
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/vault/content',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: 'notes/patch-fm-append.md', content: 'Extra text', mode: 'append' },
      });
      expect(response.statusCode).toBe(200);
      const diskContent = await fs.readFile(
        path.join(vaultRoot, 'notes', 'patch-fm-append.md'),
        'utf-8',
      );
      expect(diskContent).toContain('title: Keep Me');
      expect(diskContent).toContain('---');
      expect(diskContent).toContain('Body');
      expect(diskContent).toContain('Extra text');
    });

    it('returns 404 for nonexistent file', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/vault/content',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: 'notes/nonexistent-patch.md', content: 'text', mode: 'append' },
      });
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns 403 for path traversal', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/vault/content',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: '../escape.md', content: 'bad', mode: 'append' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('returns 401 without auth header', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/vault/content',
        headers: { 'content-type': 'application/json' },
        payload: { path: 'notes/hello.md', content: 'text', mode: 'append' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('DELETE /api/vault/content', () => {
    it('deletes a file and returns 200 with { path, deleted: true }', async () => {
      await fs.writeFile(path.join(vaultRoot, 'notes', 'delete-route.md'), 'to delete');
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/vault/content',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: 'notes/delete-route.md' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.path).toBe('notes/delete-route.md');
      expect(body.deleted).toBe(true);
      const exists = await fs
        .access(path.join(vaultRoot, 'notes', 'delete-route.md'))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    it('returns 404 when file does not exist', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/vault/content',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: 'notes/nonexistent-delete.md' },
      });
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns 403 for path traversal', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/vault/content',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: '../escape.md' },
      });
      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.error.code).toBe('PATH_TRAVERSAL');
    });

    it('returns 401 without auth header', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/vault/content',
        headers: { 'content-type': 'application/json' },
        payload: { path: 'notes/hello.md' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('PATCH /api/vault/metadata', () => {
    it('returns 200 with merged metadata after updating a field', async () => {
      await fs.writeFile(
        path.join(vaultRoot, 'notes', 'meta-patch.md'),
        '---\ntitle: Original\ntags:\n  - a\n  - b\n---\n\nBody content.',
      );
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/vault/metadata',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: 'notes/meta-patch.md', metadata: { status: 'done' } },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.path).toBe('notes/meta-patch.md');
      expect(body.metadata.title).toBe('Original');
      expect(body.metadata.tags).toEqual(['a', 'b']);
      expect(body.metadata.status).toBe('done');
    });

    it('removes a field when value is null', async () => {
      await fs.writeFile(
        path.join(vaultRoot, 'notes', 'meta-patch-null.md'),
        '---\ntitle: Test\ntags:\n  - x\n---\n\nBody.',
      );
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/vault/metadata',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: 'notes/meta-patch-null.md', metadata: { tags: null } },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.metadata.title).toBe('Test');
      expect(body.metadata.tags).toBeUndefined();
    });

    it('returns 404 when file does not exist', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/vault/metadata',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: 'notes/nonexistent-meta-patch.md', metadata: { status: 'done' } },
      });
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns 403 for path traversal', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/vault/metadata',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { path: '../../etc/passwd', metadata: { status: 'done' } },
      });
      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.error.code).toBe('PATH_TRAVERSAL');
    });

    it('returns 401 without auth header', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/vault/metadata',
        headers: { 'content-type': 'application/json' },
        payload: { path: 'notes/hello.md', metadata: { status: 'done' } },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /api/vault/move', () => {
    it('moves a note and returns 200 with { from, to }', async () => {
      await fs.writeFile(path.join(vaultRoot, 'notes', 'move-from-route.md'), 'content to move');
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/move',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { from: 'notes/move-from-route.md', to: 'notes/move-to-route.md' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.from).toBe('notes/move-from-route.md');
      expect(body.to).toBe('notes/move-to-route.md');
      const dstContent = await fs.readFile(
        path.join(vaultRoot, 'notes', 'move-to-route.md'),
        'utf-8',
      );
      expect(dstContent).toBe('content to move');
    });

    it('returns 409 when destination already exists', async () => {
      await fs.writeFile(path.join(vaultRoot, 'notes', 'move-conflict-from.md'), 'src');
      await fs.writeFile(path.join(vaultRoot, 'notes', 'move-conflict-to.md'), 'dst');
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/move',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { from: 'notes/move-conflict-from.md', to: 'notes/move-conflict-to.md' },
      });
      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.error.code).toBe('FILE_EXISTS');
    });

    it('returns 404 when source does not exist', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/move',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { from: 'notes/nonexistent-move.md', to: 'notes/any-dest.md' },
      });
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('auto-creates intermediate directories at destination', async () => {
      await fs.writeFile(path.join(vaultRoot, 'notes', 'move-auto-dir-src.md'), 'auto dir');
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/move',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { from: 'notes/move-auto-dir-src.md', to: 'deep/move/auto/dest.md' },
      });
      expect(response.statusCode).toBe(200);
      const exists = await fs
        .access(path.join(vaultRoot, 'deep', 'move', 'auto', 'dest.md'))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it('returns 403 for path traversal in from', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/move',
        headers: { authorization: 'Bearer cv-test-key-001', 'content-type': 'application/json' },
        payload: { from: '../escape.md', to: 'notes/dest.md' },
      });
      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.error.code).toBe('PATH_TRAVERSAL');
    });

    it('returns 401 without auth header', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault/move',
        headers: { 'content-type': 'application/json' },
        payload: { from: 'notes/hello.md', to: 'notes/world.md' },
      });
      expect(response.statusCode).toBe(401);
    });
  });
});
