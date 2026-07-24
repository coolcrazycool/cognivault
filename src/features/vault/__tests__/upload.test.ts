import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Avoid real OpenAI / Qdrant during plugin init.
vi.mock('openai', () => {
  class MockOpenAI {
    embeddings = {
      create: vi
        .fn()
        .mockResolvedValue({ data: [{ index: 0, embedding: new Array(1536).fill(0.1) }] }),
    };
  }
  return { default: MockOpenAI };
});
vi.mock('@qdrant/js-client-rest', () => {
  class MockQdrantClient {
    getCollections = vi.fn().mockResolvedValue({ collections: [{ name: 'cognivault' }] });
    getCollection = vi.fn().mockResolvedValue({
      config: { params: { vectors: { size: 1536, distance: 'Cosine' } } },
    });
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

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-upload-test-'));
const vaultRoot = path.join(tmpDir, 'vault');
await fs.mkdir(vaultRoot, { recursive: true });

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

const AUTH = 'Bearer cv-test-key-001';

function multipart(zip: AdmZip, boundary: string): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.zip"\r\n` +
        'Content-Type: application/zip\r\n\r\n',
    ),
    zip.toBuffer(),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

describe('POST /api/vault/upload', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('extracts files from a zip into the vault (incl. subdirs)', async () => {
    const zip = new AdmZip();
    zip.addFile('notes/alpha.md', Buffer.from('# Alpha'));
    zip.addFile('notes/sub/beta.md', Buffer.from('# Beta'));
    const boundary = '----cvtest1';

    const res = await app.inject({
      method: 'POST',
      url: '/api/vault/upload',
      headers: { authorization: AUTH, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart(zip, boundary),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.uploaded).toBe(2);
    expect(body.files).toContain('notes/alpha.md');
    expect(await fs.readFile(path.join(vaultRoot, 'notes/alpha.md'), 'utf-8')).toBe('# Alpha');
    expect(await fs.readFile(path.join(vaultRoot, 'notes/sub/beta.md'), 'utf-8')).toBe('# Beta');
  });

  it('does not let a zip-slip entry escape the vault', async () => {
    const zip = new AdmZip();
    zip.addFile('../escape.md', Buffer.from('nope'));
    const boundary = '----cvtest2';

    const res = await app.inject({
      method: 'POST',
      url: '/api/vault/upload',
      headers: { authorization: AUTH, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart(zip, boundary),
    });

    // adm-zip strips the leading `../` and `resolveWritePath` is a second guard,
    // so nothing is written above the vault root regardless of the response code.
    expect(res.statusCode).toBeLessThan(500);
    await expect(fs.access(path.join(tmpDir, 'escape.md'))).rejects.toThrow();
  });

  it('silently skips dotfiles/dotfolders', async () => {
    const zip = new AdmZip();
    zip.addFile('.obsidian/workspace.json', Buffer.from('{}'));
    zip.addFile('keep.md', Buffer.from('# Keep'));
    const boundary = '----cvtest3';

    const res = await app.inject({
      method: 'POST',
      url: '/api/vault/upload',
      headers: { authorization: AUTH, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart(zip, boundary),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.uploaded).toBe(1);
    expect(body.skipped).toBeGreaterThanOrEqual(1);
    expect(await fs.readFile(path.join(vaultRoot, 'keep.md'), 'utf-8')).toBe('# Keep');
  });

  it('requires authentication (401)', async () => {
    const zip = new AdmZip();
    zip.addFile('x.md', Buffer.from('x'));
    const boundary = '----cvtest4';

    const res = await app.inject({
      method: 'POST',
      url: '/api/vault/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart(zip, boundary),
    });

    expect(res.statusCode).toBe(401);
  });
});
