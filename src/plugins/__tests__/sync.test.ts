import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Registry, Gauge, Counter } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──

const mockSpawn = vi.fn();
const mockUnlink = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    unlink: (...args: unknown[]) => mockUnlink(...args),
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
  obsidian: { email: string; password: string; vault: string; token?: string };
}

function createMockUser(userId: string, vaultPath = '/tmp/vault', token = 'test-token'): MockUser {
  return {
    userId,
    apiKey: `cv-${userId}`,
    vaultPath,
    openaiKey: 'test-key',
    obsidian: { email: 'test@test.com', password: 'pass', vault: 'vault', token },
  };
}

function createMockChildProcess(): ChildProcess & EventEmitter {
  const cp = new EventEmitter() as ChildProcess & EventEmitter;
  (cp as unknown as Record<string, unknown>).pid = 12345;
  (cp as unknown as Record<string, unknown>).kill = vi.fn().mockReturnValue(true);
  (cp as unknown as Record<string, unknown>).stdout = new PassThrough();
  (cp as unknown as Record<string, unknown>).stderr = new PassThrough();
  return cp;
}

async function buildTestApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const app = Fastify({ logger: false });

  const registryListeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const promRegistry = new Registry();

  await app.register(
    fp(
      async (f) => {
        f.decorate('registry', {
          getAllUsers: vi.fn().mockReturnValue([]),
          on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
            const handlers = registryListeners.get(event) ?? [];
            handlers.push(handler);
            registryListeners.set(event, handlers);
          }),
          removeListener: vi.fn(),
        } as unknown as FastifyInstance['registry']);

        f.decorate('metrics', {
          promRegistry,
          removeUserMetrics: vi.fn(),
        } as unknown as FastifyInstance['metrics']);
      },
      { name: 'test-deps' },
    ),
  );

  // Register fp dependency name stubs
  for (const name of ['registry', 'metrics'] as const) {
    await app.register(fp(async () => {}, { name }));
  }

  // Store registryListeners on the app for test access
  (app as unknown as Record<string, unknown>)._registryListeners = registryListeners;

  const { default: syncPlugin } = await import('../sync.js');
  await app.register(syncPlugin);

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

describe('sync plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockUnlink.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('user-added: spawns ob sync', () => {
    it('spawns ob sync --continuous with OBSIDIAN_AUTH_TOKEN env var', async () => {
      const mockCp = createMockChildProcess();
      mockSpawn.mockReturnValue(mockCp);

      const app = await buildTestApp();
      await app.ready();

      const listeners = getRegistryListeners(app);
      const addedHandlers = listeners.get('user-added') ?? [];
      expect(addedHandlers.length).toBeGreaterThan(0);

      const user = createMockUser('user-1', '/tmp/vault1', 'my-secret-token');
      for (const handler of addedHandlers) {
        await (handler as (user: MockUser) => Promise<void>)(user);
      }

      expect(mockSpawn).toHaveBeenCalledWith(
        'ob',
        ['sync', '--continuous'],
        expect.objectContaining({
          cwd: '/tmp/vault1',
          env: expect.objectContaining({
            OBSIDIAN_AUTH_TOKEN: 'my-secret-token',
          }),
        }),
      );

      await app.close();
    });
  });

  describe('user-added: lock cleanup', () => {
    it('deletes .obsidian/.sync.lock before spawning', async () => {
      const mockCp = createMockChildProcess();
      mockSpawn.mockReturnValue(mockCp);

      const app = await buildTestApp();
      await app.ready();

      const listeners = getRegistryListeners(app);
      const addedHandlers = listeners.get('user-added') ?? [];

      const user = createMockUser('user-1', '/tmp/vault1');
      for (const handler of addedHandlers) {
        await (handler as (user: MockUser) => Promise<void>)(user);
      }

      expect(mockUnlink).toHaveBeenCalledWith(
        expect.stringContaining('.obsidian/.sync.lock'),
      );
      // unlink must be called before spawn
      const unlinkOrder = mockUnlink.mock.invocationCallOrder[0];
      const spawnOrder = mockSpawn.mock.invocationCallOrder[0];
      expect(unlinkOrder).toBeLessThan(spawnOrder);

      await app.close();
    });

    it('ignores ENOENT on lock file deletion', async () => {
      const mockCp = createMockChildProcess();
      mockSpawn.mockReturnValue(mockCp);
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockUnlink.mockRejectedValue(enoent);

      const app = await buildTestApp();
      await app.ready();

      const listeners = getRegistryListeners(app);
      const addedHandlers = listeners.get('user-added') ?? [];

      const user = createMockUser('user-1', '/tmp/vault1');
      // Should not throw
      for (const handler of addedHandlers) {
        await (handler as (user: MockUser) => Promise<void>)(user);
      }

      expect(mockSpawn).toHaveBeenCalled();

      await app.close();
    });
  });

  describe('backoff on process exit', () => {
    it('restarts after backoff delay on non-zero exit', async () => {
      const mockCp1 = createMockChildProcess();
      const mockCp2 = createMockChildProcess();
      mockSpawn.mockReturnValueOnce(mockCp1).mockReturnValueOnce(mockCp2);

      const app = await buildTestApp();
      await app.ready();

      const listeners = getRegistryListeners(app);
      const addedHandlers = listeners.get('user-added') ?? [];

      const user = createMockUser('user-1', '/tmp/vault1');
      for (const handler of addedHandlers) {
        await (handler as (user: MockUser) => Promise<void>)(user);
      }

      expect(mockSpawn).toHaveBeenCalledTimes(1);

      // Simulate process exit with non-zero code
      mockCp1.emit('exit', 1, null);

      // Before backoff timer fires, no restart
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      // Advance timer by BASE_DELAY (1000ms)
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockSpawn).toHaveBeenCalledTimes(2);

      await app.close();
    });

    it('doubles backoff on consecutive failures up to 30s cap', async () => {
      // Create enough mock processes for the chain: 1s, 2s, 4s, 8s, 16s, 30s, 30s
      const processes: Array<ChildProcess & EventEmitter> = [];
      for (let i = 0; i < 8; i++) {
        processes.push(createMockChildProcess());
      }
      let spawnIdx = 0;
      mockSpawn.mockImplementation(() => processes[spawnIdx++]);

      const app = await buildTestApp();
      await app.ready();

      const listeners = getRegistryListeners(app);
      const addedHandlers = listeners.get('user-added') ?? [];

      const user = createMockUser('user-1', '/tmp/vault1');
      for (const handler of addedHandlers) {
        await (handler as (user: MockUser) => Promise<void>)(user);
      }

      // Initial spawn
      expect(spawnIdx).toBe(1);

      const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
      for (let i = 0; i < expectedDelays.length; i++) {
        // Simulate failure
        processes[i].emit('exit', 1, null);

        // Advance by delay - 1ms, should NOT have restarted
        await vi.advanceTimersByTimeAsync(expectedDelays[i] - 1);
        expect(spawnIdx).toBe(i + 1);

        // Advance remaining 1ms, should restart
        await vi.advanceTimersByTimeAsync(1);
        expect(spawnIdx).toBe(i + 2);
      }

      await app.close();
    });

    it('resets backoff to 1s after process runs for stability period', async () => {
      const mockCp1 = createMockChildProcess();
      const mockCp2 = createMockChildProcess();
      const mockCp3 = createMockChildProcess();
      mockSpawn.mockReturnValueOnce(mockCp1).mockReturnValueOnce(mockCp2).mockReturnValueOnce(mockCp3);

      const app = await buildTestApp();
      await app.ready();

      const listeners = getRegistryListeners(app);
      const addedHandlers = listeners.get('user-added') ?? [];

      const user = createMockUser('user-1', '/tmp/vault1');
      for (const handler of addedHandlers) {
        await (handler as (user: MockUser) => Promise<void>)(user);
      }

      // First failure -> backoff becomes 2s
      mockCp1.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockSpawn).toHaveBeenCalledTimes(2);

      // Let the process run for STABILITY_THRESHOLD (60s)
      await vi.advanceTimersByTimeAsync(60_000);

      // Now it fails again -> backoff should reset to BASE_DELAY (1s)
      mockCp2.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockSpawn).toHaveBeenCalledTimes(3);

      await app.close();
    });
  });

  describe('user-removed', () => {
    it('sends SIGTERM to child process', async () => {
      const mockCp = createMockChildProcess();
      mockSpawn.mockReturnValue(mockCp);

      const app = await buildTestApp();
      await app.ready();

      const listeners = getRegistryListeners(app);
      const addedHandlers = listeners.get('user-added') ?? [];
      const removedHandlers = listeners.get('user-removed') ?? [];

      const user = createMockUser('user-1', '/tmp/vault1');
      for (const handler of addedHandlers) {
        await (handler as (user: MockUser) => Promise<void>)(user);
      }

      for (const handler of removedHandlers) {
        await (handler as (user: MockUser) => Promise<void>)(user);
      }

      expect(mockCp.kill).toHaveBeenCalledWith('SIGTERM');

      await app.close();
    });
  });

  describe('metrics', () => {
    it('sets cognivault_sync_running gauge to 1 when process is running', async () => {
      const mockCp = createMockChildProcess();
      mockSpawn.mockReturnValue(mockCp);

      const app = await buildTestApp();
      await app.ready();

      const listeners = getRegistryListeners(app);
      const addedHandlers = listeners.get('user-added') ?? [];

      const user = createMockUser('user-1', '/tmp/vault1');
      for (const handler of addedHandlers) {
        await (handler as (user: MockUser) => Promise<void>)(user);
      }

      const runningMetric = app.metrics.promRegistry.getSingleMetric('cognivault_sync_running') as Gauge;
      expect(runningMetric).toBeDefined();
      const values = await runningMetric.get();
      const val = values.values.find((v) => v.labels.user_id === 'user-1');
      expect(val?.value).toBe(1);

      await app.close();
    });

    it('sets cognivault_sync_running gauge to 0 when process stops', async () => {
      const mockCp = createMockChildProcess();
      const mockCp2 = createMockChildProcess();
      mockSpawn.mockReturnValueOnce(mockCp).mockReturnValueOnce(mockCp2);

      const app = await buildTestApp();
      await app.ready();

      const listeners = getRegistryListeners(app);
      const addedHandlers = listeners.get('user-added') ?? [];

      const user = createMockUser('user-1', '/tmp/vault1');
      for (const handler of addedHandlers) {
        await (handler as (user: MockUser) => Promise<void>)(user);
      }

      // Simulate process exit
      mockCp.emit('exit', 1, null);

      const runningMetric = app.metrics.promRegistry.getSingleMetric('cognivault_sync_running') as Gauge;
      const values = await runningMetric.get();
      const val = values.values.find((v) => v.labels.user_id === 'user-1');
      expect(val?.value).toBe(0);

      await app.close();
    });

    it('increments cognivault_sync_failures_total on process failure', async () => {
      const mockCp = createMockChildProcess();
      const mockCp2 = createMockChildProcess();
      mockSpawn.mockReturnValueOnce(mockCp).mockReturnValueOnce(mockCp2);

      const app = await buildTestApp();
      await app.ready();

      const listeners = getRegistryListeners(app);
      const addedHandlers = listeners.get('user-added') ?? [];

      const user = createMockUser('user-1', '/tmp/vault1');
      for (const handler of addedHandlers) {
        await (handler as (user: MockUser) => Promise<void>)(user);
      }

      mockCp.emit('exit', 1, null);

      const failuresMetric = app.metrics.promRegistry.getSingleMetric('cognivault_sync_failures_total') as Counter;
      expect(failuresMetric).toBeDefined();
      const values = await failuresMetric.get();
      const val = values.values.find((v) => v.labels.user_id === 'user-1');
      expect(val?.value).toBe(1);

      await app.close();
    });
  });

  describe('onClose hook', () => {
    it('terminates all child processes on server close', async () => {
      const mockCp1 = createMockChildProcess();
      const mockCp2 = createMockChildProcess();
      mockSpawn.mockReturnValueOnce(mockCp1).mockReturnValueOnce(mockCp2);

      const app = await buildTestApp();
      await app.ready();

      const listeners = getRegistryListeners(app);
      const addedHandlers = listeners.get('user-added') ?? [];

      const user1 = createMockUser('user-1', '/tmp/vault1');
      const user2 = createMockUser('user-2', '/tmp/vault2');
      for (const handler of addedHandlers) {
        await (handler as (user: MockUser) => Promise<void>)(user1);
      }
      for (const handler of addedHandlers) {
        await (handler as (user: MockUser) => Promise<void>)(user2);
      }

      await app.close();

      expect(mockCp1.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockCp2.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  describe('spawn cwd', () => {
    it('sets cwd to user vaultPath', async () => {
      const mockCp = createMockChildProcess();
      mockSpawn.mockReturnValue(mockCp);

      const app = await buildTestApp();
      await app.ready();

      const listeners = getRegistryListeners(app);
      const addedHandlers = listeners.get('user-added') ?? [];

      const user = createMockUser('user-1', '/my/custom/vault');
      for (const handler of addedHandlers) {
        await (handler as (user: MockUser) => Promise<void>)(user);
      }

      expect(mockSpawn).toHaveBeenCalledWith(
        'ob',
        ['sync', '--continuous'],
        expect.objectContaining({ cwd: '/my/custom/vault' }),
      );

      await app.close();
    });
  });
});
