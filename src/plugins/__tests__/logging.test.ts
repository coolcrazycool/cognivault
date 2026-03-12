import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
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
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logging-test-'));
const vaultRoot = path.join(tmpDir, 'vault');
await fs.mkdir(vaultRoot, { recursive: true });

// Set env vars before any module imports that trigger config parsing
process.env.COGNIVAULT_API_KEY = 'test-api-key-logging';
process.env.VAULT_PATH = vaultRoot;
process.env.OPENAI_API_KEY = 'test-openai-key-logging';
process.env.COGNIVAULT_DATA_DIR = path.join(tmpDir, 'data-logging');

const { buildApp } = await import('../../app.js');

// Cleanup tmpDir after all describe blocks complete
afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('logging enrichment', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('echoes X-Request-ID provided by client in response header', async () => {
    const clientRequestId = 'my-agent-request-123';
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-request-id': clientRequestId,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe(clientRequestId);
  });

  it('generates UUID-formatted X-Request-ID when header is absent', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(response.statusCode).toBe(200);
    const requestId = response.headers['x-request-id'];
    expect(requestId).toBeDefined();
    expect(typeof requestId).toBe('string');
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

describe('logging redaction', () => {
  let redactApp: FastifyInstance;

  beforeAll(async () => {
    // Capture log output to verify redaction
    const logLines: string[] = [];
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(chunk.toString());
        callback();
      },
    });

    redactApp = await buildApp({
      logger: {
        level: 'info',
        stream: logStream,
      },
    });
    await redactApp.ready();

    // Store logLines on the app for the test to access
    (redactApp as FastifyInstance & { _testLogLines: string[] })._testLogLines = logLines;
  });

  afterAll(async () => {
    await redactApp.close();
  });

  it('redacts Authorization header value in log output', async () => {
    const logLines = (redactApp as FastifyInstance & { _testLogLines: string[] })._testLogLines;

    await redactApp.inject({
      method: 'GET',
      url: '/health',
      headers: {
        authorization: 'Bearer super-secret-api-key',
      },
    });

    // Give logger time to flush
    await new Promise((resolve) => setTimeout(resolve, 50));

    const allLogs = logLines.join('\n');
    expect(allLogs).not.toContain('super-secret-api-key');
    expect(allLogs).toContain('[Redacted]');
  });
});
