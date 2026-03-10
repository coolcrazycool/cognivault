import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let vaultRoot: string;

// Create test vault fixture before anything else
tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-routes-test-'));
vaultRoot = path.join(tmpDir, 'vault');
await fs.mkdir(vaultRoot, { recursive: true });
await fs.mkdir(path.join(vaultRoot, 'notes'), { recursive: true });

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

// Set env vars before importing app
process.env.COGNIVAULT_API_KEY = 'test-api-key';
process.env.VAULT_PATH = vaultRoot;

const { buildApp } = await import('../../../app.js');

describe('vault metadata routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/vault/metadata', () => {
    it('returns 200 with parsed frontmatter for note with tags array', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/metadata?path=note-with-tags-array.md',
        headers: { authorization: 'Bearer test-api-key' },
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
        headers: { authorization: 'Bearer test-api-key' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.metadata.tags).toEqual(['productivity']);
    });

    it('preserves nested YAML as nested JSON', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/metadata?path=note-with-nested.md',
        headers: { authorization: 'Bearer test-api-key' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.metadata.author).toEqual({ name: 'Alice', email: 'alice@example.com' });
    });

    it('returns 200 with empty metadata for note without frontmatter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/metadata?path=no-frontmatter.md',
        headers: { authorization: 'Bearer test-api-key' },
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
        headers: { authorization: 'Bearer test-api-key' },
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
        headers: { authorization: 'Bearer test-api-key' },
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns 403 for path traversal attempt', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/metadata?path=../../etc/passwd',
        headers: { authorization: 'Bearer test-api-key' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('returns 400 when path query param is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/vault/metadata',
        headers: { authorization: 'Bearer test-api-key' },
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
});
