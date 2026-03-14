import * as fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──

const mockVaultIndexerStart = vi.fn();
const mockVaultIndexerStop = vi.fn();
const mockVaultIndexerOn = vi.fn();
const mockVaultIndexerRemoveListener = vi.fn();

vi.mock('../../lib/indexer.js', () => {
  class MockVaultIndexer {
    start = mockVaultIndexerStart;
    stop = mockVaultIndexerStop;
    on = mockVaultIndexerOn;
    removeListener = mockVaultIndexerRemoveListener;
    isIndexing = false;
  }
  return {
    VaultIndexer: MockVaultIndexer,
  };
});

vi.mock('../../lib/vault.js', () => {
  class MockVaultManager {
    vaultRootPath: string;
    constructor(rootPath: string) {
      this.vaultRootPath = rootPath;
    }
    listFiles = vi.fn().mockResolvedValue({ entries: [] });
    readContent = vi.fn().mockResolvedValue({ content: '' });
  }
  return {
    VaultManager: MockVaultManager,
  };
});

// Mock PQueue
const mockQueueClear = vi.fn();
const mockQueueOnIdle = vi.fn().mockResolvedValue(undefined);
const mockQueueAdd = vi.fn();
const mockQueueOn = vi.fn();
let mockQueueSize = 0;
let mockQueuePending = 0;

vi.mock('p-queue', () => {
  class MockPQueue {
    add = mockQueueAdd;
    clear = mockQueueClear;
    onIdle = mockQueueOnIdle;
    on = mockQueueOn;
    get size() {
      return mockQueueSize;
    }
    get pending() {
      return mockQueuePending;
    }
  }
  return { default: MockPQueue };
});

// Mock fs.access for vault path validation
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    access: vi.fn().mockResolvedValue(undefined),
  };
});

// Set required env vars
process.env.VAULT_PATH = '/tmp/test-vault';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.QDRANT_URL = 'http://localhost:6333';
process.env.EMBEDDING_MODEL = 'text-embedding-3-small';

// ── Test helpers ──

interface MockUser {
  userId: string;
  apiKey: string;
  vaultPath: string;
  openaiKey: string;
  obsidian: { email: string; password: string; vault: string };
}

function createMockUser(userId: string, vaultPath = '/tmp/vault'): MockUser {
  return {
    userId,
    apiKey: `cv-${userId}`,
    vaultPath,
    openaiKey: 'test-key',
    obsidian: { email: 'test@test.com', password: 'pass', vault: 'vault' },
  };
}

async function buildTestApp(opts?: {
  users?: MockUser[];
  accessFails?: boolean;
}): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const app = Fastify({ logger: false });

  const users = opts?.users ?? [];
  const registryListeners = new Map<string, Array<(...args: unknown[]) => void>>();

  if (opts?.accessFails) {
    const fsAccess = fs.access as ReturnType<typeof vi.fn>;
    fsAccess.mockRejectedValue(new Error('ENOENT'));
  } else {
    const fsAccess = fs.access as ReturnType<typeof vi.fn>;
    fsAccess.mockResolvedValue(undefined);
  }

  // Register mock dependencies
  await app.register(
    fp(
      async (f) => {
        f.decorate('registry', {
          getAllUsers: vi.fn().mockReturnValue(users),
          on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
            const handlers = registryListeners.get(event) ?? [];
            handlers.push(handler);
            registryListeners.set(event, handlers);
          }),
          removeListener: vi.fn(),
        } as unknown as FastifyInstance['registry']);

        f.decorate(
          'getUserDbById',
          vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              from: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
            }),
            update: vi.fn().mockReturnValue({
              set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ run: vi.fn() }) }),
            }),
            insert: vi.fn().mockReturnValue({
              values: vi.fn().mockReturnValue({
                onConflictDoUpdate: vi.fn().mockReturnValue({ run: vi.fn() }),
              }),
            }),
            delete: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ run: vi.fn() }) }),
          }) as unknown as FastifyInstance['getUserDbById'],
        );

        f.decorate(
          'createTenantQdrant',
          vi.fn().mockReturnValue({
            upsert: vi.fn().mockResolvedValue({}),
            delete: vi.fn().mockResolvedValue({}),
            search: vi.fn().mockResolvedValue([]),
            setPayload: vi.fn().mockResolvedValue({}),
          }) as unknown as FastifyInstance['createTenantQdrant'],
        );

        f.decorate(
          'getUserEmbedder',
          vi.fn().mockReturnValue({
            embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
            dimensions: 1536,
          }) as unknown as FastifyInstance['getUserEmbedder'],
        );

        f.decorate('metrics', {
          indexQueueDepth: { set: vi.fn() },
          staleVectorCleanups: { inc: vi.fn() },
          embeddingRequests: { inc: vi.fn() },
          chunksProcessed: { inc: vi.fn() },
          pipelineDuration: { startTimer: vi.fn().mockReturnValue(vi.fn()) },
          removeUserMetrics: vi.fn(),
          promRegistry: {},
        } as unknown as FastifyInstance['metrics']);

        // processFileChanges is decorated by pipeline plugin
        f.decorate(
          'processFileChanges',
          vi.fn() as unknown as FastifyInstance['processFileChanges'],
        );
      },
      { name: 'test-deps' },
    ),
  );

  // Register fp dependency name stubs
  for (const name of ['db', 'registry', 'qdrant', 'embedder', 'metrics', 'pipeline'] as const) {
    await app.register(fp(async () => {}, { name }));
  }

  // Store registryListeners on the app for test access
  (app as unknown as Record<string, unknown>)._registryListeners = registryListeners;

  const { default: indexerPlugin } = await import('../indexer.js');
  await app.register(indexerPlugin);

  return app;
}

function getRegistryListeners(
  app: FastifyInstance,
): Map<string, Array<(...args: unknown[]) => void>> {
  return (app as unknown as Record<string, unknown>)._registryListeners as Map<
    string,
    Array<(...args: unknown[]) => void>
  >;
}

// ── Tests ──

describe('indexer plugin (per-user)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueSize = 0;
    mockQueuePending = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  describe('initialization', () => {
    it('decorates fastify with indexers Map', async () => {
      const app = await buildTestApp();
      await app.ready();

      expect(app.indexers).toBeDefined();
      expect(app.indexers).toBeInstanceOf(Map);

      await app.close();
    });

    it('creates indexers for existing registry users on ready', async () => {
      const users = [
        createMockUser('user-1', '/tmp/vault1'),
        createMockUser('user-2', '/tmp/vault2'),
      ];
      const app = await buildTestApp({ users });
      await app.ready();

      expect(app.indexers.size).toBe(2);
      expect(app.indexers.has('user-1')).toBe(true);
      expect(app.indexers.has('user-2')).toBe(true);

      // Each indexer should have been started
      expect(mockVaultIndexerStart).toHaveBeenCalledTimes(2);

      await app.close();
    });

    it('skips indexer creation if vault path does not exist', async () => {
      const users = [createMockUser('user-1', '/nonexistent/vault')];
      const app = await buildTestApp({ users, accessFails: true });
      await app.ready();

      expect(app.indexers.size).toBe(0);
      expect(mockVaultIndexerStart).not.toHaveBeenCalled();

      await app.close();
    });
  });

  describe('user-added event', () => {
    it('creates and starts a new indexer for added user', async () => {
      const app = await buildTestApp();
      await app.ready();

      const listeners = getRegistryListeners(app);
      const addedHandlers = listeners.get('user-added') ?? [];
      expect(addedHandlers.length).toBeGreaterThan(0);

      // Reset mocks after init
      mockVaultIndexerStart.mockClear();

      // Simulate user-added event
      const newUser = createMockUser('new-user', '/tmp/new-vault');
      for (const handler of addedHandlers) {
        await (handler as (user: MockUser) => Promise<void>)(newUser);
      }

      expect(app.indexers.has('new-user')).toBe(true);
      expect(mockVaultIndexerStart).toHaveBeenCalledTimes(1);

      await app.close();
    });

    it('skips indexer creation if new user vault path does not exist', async () => {
      const app = await buildTestApp();
      await app.ready();

      // Override fs.access to fail
      const fsAccess = fs.access as ReturnType<typeof vi.fn>;
      fsAccess.mockRejectedValueOnce(new Error('ENOENT'));

      const listeners = getRegistryListeners(app);
      const addedHandlers = listeners.get('user-added') ?? [];

      const newUser = createMockUser('bad-path-user', '/nonexistent');
      for (const handler of addedHandlers) {
        await (handler as (user: MockUser) => Promise<void>)(newUser);
      }

      expect(app.indexers.has('bad-path-user')).toBe(false);

      await app.close();
    });
  });

  describe('user-removed event', () => {
    it('stops indexer, clears queue, removes metrics, and deletes from Map', async () => {
      const users = [createMockUser('user-1', '/tmp/vault1')];
      const app = await buildTestApp({ users });
      await app.ready();

      expect(app.indexers.has('user-1')).toBe(true);

      const listeners = getRegistryListeners(app);
      const removedHandlers = listeners.get('user-removed') ?? [];
      expect(removedHandlers.length).toBeGreaterThan(0);

      // Simulate user-removed event
      const removedUser = createMockUser('user-1', '/tmp/vault1');
      for (const handler of removedHandlers) {
        await (handler as (user: MockUser) => Promise<void>)(removedUser);
      }

      expect(app.indexers.has('user-1')).toBe(false);
      expect(mockVaultIndexerStop).toHaveBeenCalled();
      expect(mockQueueClear).toHaveBeenCalled();
      expect(mockQueueOnIdle).toHaveBeenCalled();
      expect(app.metrics.removeUserMetrics as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'user-1',
      );

      await app.close();
    });
  });

  describe('onClose', () => {
    it('stops all indexers on server close', async () => {
      const users = [createMockUser('user-1', '/tmp/v1'), createMockUser('user-2', '/tmp/v2')];
      const app = await buildTestApp({ users });
      await app.ready();

      expect(app.indexers.size).toBe(2);

      mockVaultIndexerStop.mockClear();
      await app.close();

      expect(mockVaultIndexerStop).toHaveBeenCalledTimes(2);
    });
  });

  describe('indexers Map entries', () => {
    it('each entry has indexer, queue, and vault properties', async () => {
      const users = [createMockUser('user-1', '/tmp/vault1')];
      const app = await buildTestApp({ users });
      await app.ready();

      const entry = app.indexers.get('user-1');
      expect(entry).toBeDefined();
      expect(entry!.indexer).toBeDefined();
      expect(entry!.queue).toBeDefined();
      expect(entry!.vault).toBeDefined();

      await app.close();
    });
  });

  describe('changes forwarding', () => {
    it('wires indexer changes event to processFileChanges with userId', async () => {
      const users = [createMockUser('user-1', '/tmp/vault1')];
      const app = await buildTestApp({ users });
      await app.ready();

      // VaultIndexer.on should have been called with 'changes'
      const onCall = mockVaultIndexerOn.mock.calls.find((c: unknown[]) => c[0] === 'changes');
      expect(onCall).toBeDefined();

      await app.close();
    });
  });
});
