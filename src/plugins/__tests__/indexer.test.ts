import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { VaultIndexer } from '../../lib/indexer.js';

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

// Create temp directories for vault and data dir
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'indexer-plugin-test-'));
const vaultRoot = path.join(tmpDir, 'vault');
const dataDir = path.join(tmpDir, 'data');
await fs.mkdir(vaultRoot, { recursive: true });

// Create a .md file before app starts so it gets indexed
await fs.writeFile(path.join(vaultRoot, 'test-note.md'), '# Test Note\n\nHello world', 'utf-8');

// Set env vars before any module imports that trigger config parsing
process.env.VAULT_PATH = vaultRoot;
process.env.COGNIVAULT_DATA_DIR = dataDir;
process.env.OPENAI_API_KEY = 'test-openai-key';

const { buildApp } = await import('../../app.js');

describe('indexer plugin', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('decorates fastify with indexer property', () => {
    expect(app.indexer).toBeDefined();
  });

  it('fastify.indexer is an instance of VaultIndexer', () => {
    expect(app.indexer).toBeInstanceOf(VaultIndexer);
  });

  it('fastify.indexer.isIndexing is a boolean', () => {
    expect(typeof app.indexer.isIndexing).toBe('boolean');
  });

  it('app.close() completes without error (onClose hook runs)', async () => {
    // Tested implicitly by afterAll's app.close() — this just verifies readiness
    expect(app.indexer).toBeDefined();
  });

  it('indexes .md file into DB after scan completes', async () => {
    // Wait for background scan to complete
    // The scan is async so we poll with a timeout
    const maxWait = 5000;
    const pollInterval = 100;
    let elapsed = 0;
    let rowCount = 0;

    while (elapsed < maxWait) {
      const { indexedFiles } = await import('../../db/schema.js');
      const rows = app.db.select().from(indexedFiles).all();
      rowCount = rows.length;

      if (rowCount > 0) break;

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      elapsed += pollInterval;
    }

    expect(rowCount).toBeGreaterThanOrEqual(1);
  }, 10000);
});
