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

// Create a real temp vault directory so vault plugin can initialize
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'metrics-test-'));
const vaultRoot = path.join(tmpDir, 'vault');
await fs.mkdir(vaultRoot, { recursive: true });

// Set env vars before any module imports that trigger config parsing
const dataDir = path.join(tmpDir, 'data-metrics');
await fs.mkdir(dataDir, { recursive: true });
await fs.writeFile(
  path.join(dataDir, 'users.json'),
  JSON.stringify([
    {
      userId: 'test-user',
      apiKey: 'cv-test-key-001',
      vaultPath: vaultRoot,
      openaiKey: 'test-openai-key-metrics',
      obsidian: { email: 'test@test.com', password: 'secret', vault: 'test-vault' },
    },
  ]),
);
process.env.VAULT_PATH = vaultRoot;
process.env.OPENAI_API_KEY = 'test-openai-key-metrics';
process.env.COGNIVAULT_DATA_DIR = dataDir;

const { buildApp } = await import('../../app.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('/metrics endpoint', () => {
  it('returns 200 without Authorization header (no auth required)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(response.statusCode).toBe(200);
  });

  it('returns Prometheus text format with correct content-type', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(response.headers['content-type']).toContain('text/plain');
  });

  it('response contains cognivault_search_duration_seconds metric', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(response.body).toContain('cognivault_search_duration_seconds');
  });

  it('response contains cognivault_search_requests_total metric', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(response.body).toContain('cognivault_search_requests_total');
  });

  it('response contains cognivault_index_queue_depth metric', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(response.body).toContain('cognivault_index_queue_depth');
  });

  it('response contains cognivault_stale_vector_cleanups_total metric', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(response.body).toContain('cognivault_stale_vector_cleanups_total');
  });

  it('response contains process default metrics (nodejs_ prefix)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    // Default metrics collected by prom-client include nodejs_ metrics
    expect(response.body).toMatch(/process_cpu|nodejs_/);
  });

  it('response contains cognivault_embedding_requests_total metric', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(response.body).toContain('cognivault_embedding_requests_total');
  });

  it('response contains cognivault_chunks_processed_total metric', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(response.body).toContain('cognivault_chunks_processed_total');
  });

  it('response contains cognivault_pipeline_duration_seconds metric', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(response.body).toContain('cognivault_pipeline_duration_seconds');
  });

  it('response contains cognivault_context_packs_total metric', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(response.body).toContain('cognivault_context_packs_total');
  });
});

describe('metrics user_id labels', () => {
  it('searchDuration records with type and user_id labels', async () => {
    const timer = app.metrics.searchDuration.startTimer({ type: 'semantic', user_id: 'alice' });
    timer();
    const metrics = await app.metrics.promRegistry.metrics();
    expect(metrics).toContain('user_id="alice"');
    expect(metrics).toContain('type="semantic"');
  });

  it('searchRequests records with type and user_id labels', async () => {
    app.metrics.searchRequests.inc({ type: 'hybrid', user_id: 'bob' });
    const metrics = await app.metrics.promRegistry.metrics();
    expect(metrics).toContain('cognivault_search_requests_total{type="hybrid",user_id="bob"}');
  });

  it('indexQueueDepth records with user_id label', async () => {
    app.metrics.indexQueueDepth.set({ user_id: 'alice' }, 5);
    const metrics = await app.metrics.promRegistry.metrics();
    expect(metrics).toContain('cognivault_index_queue_depth{user_id="alice"} 5');
  });

  it('staleVectorCleanups records with user_id label', async () => {
    app.metrics.staleVectorCleanups.inc({ user_id: 'alice' });
    const metrics = await app.metrics.promRegistry.metrics();
    expect(metrics).toContain('user_id="alice"');
  });

  it('embeddingRequests records with user_id label', async () => {
    app.metrics.embeddingRequests.inc({ user_id: 'alice' });
    const metrics = await app.metrics.promRegistry.metrics();
    expect(metrics).toContain('cognivault_embedding_requests_total{user_id="alice"}');
  });

  it('chunksProcessed records with user_id label', async () => {
    app.metrics.chunksProcessed.inc({ user_id: 'alice' }, 3);
    const metrics = await app.metrics.promRegistry.metrics();
    expect(metrics).toContain('user_id="alice"');
  });

  it('pipelineDuration records with user_id label', async () => {
    const timer = app.metrics.pipelineDuration.startTimer({ user_id: 'alice' });
    timer();
    const metrics = await app.metrics.promRegistry.metrics();
    expect(metrics).toContain('user_id="alice"');
  });

  it('contextPacks counter records with user_id label', async () => {
    app.metrics.contextPacks.inc({ user_id: 'alice' });
    const metrics = await app.metrics.promRegistry.metrics();
    expect(metrics).toContain('cognivault_context_packs_total{user_id="alice"}');
  });

  it('removeUserMetrics removes all label combinations for a userId', async () => {
    // Set some metrics for a user
    app.metrics.searchRequests.inc({ type: 'semantic', user_id: 'remove-me' });
    app.metrics.searchRequests.inc({ type: 'hybrid', user_id: 'remove-me' });
    app.metrics.indexQueueDepth.set({ user_id: 'remove-me' }, 10);
    app.metrics.embeddingRequests.inc({ user_id: 'remove-me' });
    app.metrics.contextPacks.inc({ user_id: 'remove-me' });

    // Verify metrics exist
    let metrics = await app.metrics.promRegistry.metrics();
    expect(metrics).toContain('user_id="remove-me"');

    // Remove
    app.metrics.removeUserMetrics('remove-me');

    // Verify removed
    metrics = await app.metrics.promRegistry.metrics();
    expect(metrics).not.toContain('user_id="remove-me"');
  });
});
