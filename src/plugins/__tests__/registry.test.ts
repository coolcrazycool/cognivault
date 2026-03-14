import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UserRecord } from '../../lib/user-registry.js';

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

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-test-'));
const vaultRoot = path.join(tmpDir, 'vault');
const dataDir = path.join(tmpDir, 'data');

await fs.mkdir(vaultRoot, { recursive: true });
await fs.mkdir(dataDir, { recursive: true });

const testUsers: UserRecord[] = [
  {
    userId: 'alice',
    apiKey: 'cv-alice-key-001',
    vaultPath: '/vaults/alice',
    openaiKey: 'sk-alice-openai',
    obsidian: { email: 'alice@test.com', password: 'secret-alice', vault: 'alice-vault' },
  },
  {
    userId: 'bob',
    apiKey: 'cv-bob-key-002',
    vaultPath: '/vaults/bob',
    openaiKey: 'sk-bob-openai',
    obsidian: { email: 'bob@test.com', password: 'secret-bob', vault: 'bob-vault' },
  },
];

// Write users.json before importing app (config parsed at import time)
await fs.writeFile(path.join(dataDir, 'users.json'), JSON.stringify(testUsers, null, 2));

process.env.COGNIVAULT_API_KEY = 'test-api-key-registry';
process.env.VAULT_PATH = vaultRoot;
process.env.OPENAI_API_KEY = 'test-openai-key-registry';
process.env.COGNIVAULT_DATA_DIR = dataDir;

const { buildApp } = await import('../../app.js');

describe('registry plugin', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('decorates fastify.registry', () => {
    expect(app.registry).toBeDefined();
    expect(app.registry.getUserCount).toBeTypeOf('function');
    expect(app.registry.getUserByApiKey).toBeTypeOf('function');
  });

  it('loads users at startup', () => {
    expect(app.registry.getUserCount()).toBe(2);
  });

  it('lookup by API key works through plugin', () => {
    const user = app.registry.getUserByApiKey('cv-alice-key-001');
    expect(user).toBeDefined();
    expect(user?.userId).toBe('alice');
    expect(user?.vaultPath).toBe('/vaults/alice');
  });

  it('graceful shutdown closes watcher without errors', async () => {
    // Build a separate app instance to test shutdown independently
    const shutdownApp = await buildApp({ logger: false });
    await shutdownApp.ready();
    expect(shutdownApp.registry.getUserCount()).toBe(2);

    // Close should not throw
    await shutdownApp.close();
  });

  it('metrics endpoint includes registry metrics', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('cognivault_registry_reloads_total');
    expect(response.body).toContain('cognivault_registry_users');
  });
});

describe('registry plugin - empty users.json', () => {
  it('starts with zero users when users.json does not exist', async () => {
    // Remove users.json so load() creates empty file
    const usersPath = path.join(dataDir, 'users.json');
    await fs.rm(usersPath, { force: true });

    const emptyApp = await buildApp({ logger: false });
    await emptyApp.ready();

    expect(emptyApp.registry.getUserCount()).toBe(0);

    await emptyApp.close();

    // Restore users.json for any subsequent tests
    await fs.writeFile(usersPath, JSON.stringify(testUsers, null, 2));
  });
});

describe('registry plugin - malformed users.json', () => {
  afterAll(async () => {
    // Final cleanup of shared temp directory
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('throws on malformed users.json at startup', async () => {
    const usersPath = path.join(dataDir, 'users.json');
    const backup = await fs.readFile(usersPath, 'utf-8');

    await fs.writeFile(usersPath, '{ not valid json!!!');

    await expect(buildApp({ logger: false })).rejects.toThrow();

    // Restore valid users.json
    await fs.writeFile(usersPath, backup);
  });
});
