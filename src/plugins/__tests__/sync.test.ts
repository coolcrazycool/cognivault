import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Counter, Gauge, Registry } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──

let spawnedProcesses: Array<ChildProcess & EventEmitter> = [];
let spawnCallArgs: unknown[][] = [];

const { mockUnlink } = vi.hoisted(() => ({
  mockUnlink: vi.fn(),
}));

function createMockChildProcess(): ChildProcess & EventEmitter {
  const cp = new EventEmitter() as ChildProcess & EventEmitter;
  (cp as unknown as Record<string, unknown>).pid = Math.floor(Math.random() * 100000);
  (cp as unknown as Record<string, unknown>).kill = vi.fn().mockReturnValue(true);
  (cp as unknown as Record<string, unknown>).stdout = new PassThrough();
  (cp as unknown as Record<string, unknown>).stderr = new PassThrough();
  return cp;
}

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => {
    spawnCallArgs.push(args);
    const cp = createMockChildProcess();
    spawnedProcesses.push(cp);
    return cp;
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    unlinkSync: (...args: unknown[]) => mockUnlink(...args),
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

  for (const name of ['registry', 'metrics'] as const) {
    await app.register(fp(async () => {}, { name }));
  }

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

async function emitUserAdded(app: FastifyInstance, user: MockUser): Promise<void> {
  const listeners = getRegistryListeners(app);
  const addedHandlers = listeners.get('user-added') ?? [];
  for (const handler of addedHandlers) {
    await (handler as (user: MockUser) => Promise<void>)(user);
  }
}

async function emitUserRemoved(app: FastifyInstance, user: MockUser): Promise<void> {
  const listeners = getRegistryListeners(app);
  const removedHandlers = listeners.get('user-removed') ?? [];
  for (const handler of removedHandlers) {
    await (handler as (user: MockUser) => Promise<void>)(user);
  }
}

// ── Tests ──

describe('sync plugin', () => {
  beforeEach(() => {
    spawnedProcesses = [];
    spawnCallArgs = [];
    vi.clearAllMocks();
    mockUnlink.mockReturnValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  describe('user-added: spawns ob sync', () => {
    it('spawns ob sync --continuous with OBSIDIAN_AUTH_TOKEN env var', async () => {
      const app = await buildTestApp();
      await app.ready();

      const user = createMockUser('user-1', '/tmp/vault1', 'my-secret-token');
      await emitUserAdded(app, user);

      expect(spawnCallArgs.length).toBe(1);
      expect(spawnCallArgs[0]![0]).toBe('ob');
      expect(spawnCallArgs[0]![1]).toEqual(['sync', '--continuous']);
      const opts = spawnCallArgs[0]![2] as Record<string, unknown>;
      expect(opts.cwd).toBe('/tmp/vault1');
      expect((opts.env as Record<string, string>).OBSIDIAN_AUTH_TOKEN).toBe('my-secret-token');

      await app.close();
    });
  });

  describe('user-added: lock cleanup', () => {
    it('deletes .obsidian/.sync.lock before spawning', async () => {
      const app = await buildTestApp();
      await app.ready();

      const user = createMockUser('user-1', '/tmp/vault1');
      await emitUserAdded(app, user);

      expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('.obsidian/.sync.lock'));
      expect(spawnCallArgs.length).toBe(1);

      await app.close();
    });

    it('ignores ENOENT on lock file deletion', async () => {
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockUnlink.mockImplementation(() => {
        throw enoent;
      });

      const app = await buildTestApp();
      await app.ready();

      const user = createMockUser('user-1', '/tmp/vault1');
      // Should not throw
      await emitUserAdded(app, user);

      expect(spawnCallArgs.length).toBe(1);

      await app.close();
    });
  });

  describe('backoff on process exit', () => {
    it('restarts after backoff delay on non-zero exit', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const app = await buildTestApp();
      await app.ready();

      const user = createMockUser('user-1', '/tmp/vault1');
      await emitUserAdded(app, user);

      expect(spawnedProcesses.length).toBe(1);

      // Simulate process exit with non-zero code
      spawnedProcesses[0]!.emit('exit', 1, null);

      // Before backoff timer fires, no restart
      expect(spawnedProcesses.length).toBe(1);

      // Advance timer by BASE_DELAY (1000ms)
      await vi.advanceTimersByTimeAsync(1000);

      expect(spawnedProcesses.length).toBe(2);

      // Clean up
      vi.useRealTimers();
      await app.close();
    });

    it('doubles backoff on consecutive failures up to 30s cap', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const app = await buildTestApp();
      await app.ready();

      const user = createMockUser('user-1', '/tmp/vault1');
      await emitUserAdded(app, user);

      expect(spawnedProcesses.length).toBe(1);

      const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
      for (let i = 0; i < expectedDelays.length; i++) {
        // Simulate failure
        spawnedProcesses[i]!.emit('exit', 1, null);

        // Advance by delay - 1ms, should NOT have restarted
        await vi.advanceTimersByTimeAsync(expectedDelays[i]! - 1);
        expect(spawnedProcesses.length).toBe(i + 1);

        // Advance remaining 1ms, should restart
        await vi.advanceTimersByTimeAsync(1);
        expect(spawnedProcesses.length).toBe(i + 2);
      }

      // Clean up
      vi.useRealTimers();
      await app.close();
    });

    it('resets backoff to 1s after process runs for stability period', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const app = await buildTestApp();
      await app.ready();

      const user = createMockUser('user-1', '/tmp/vault1');
      await emitUserAdded(app, user);

      // First failure -> backoff becomes 2s
      spawnedProcesses[0]!.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(spawnedProcesses.length).toBe(2);

      // Let the process run for STABILITY_THRESHOLD (60s)
      await vi.advanceTimersByTimeAsync(60_000);

      // Now it fails again -> backoff should reset to BASE_DELAY (1s)
      spawnedProcesses[1]!.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(spawnedProcesses.length).toBe(3);

      // Clean up
      vi.useRealTimers();
      await app.close();
    });
  });

  describe('user-removed', () => {
    it('sends SIGTERM to child process', async () => {
      const app = await buildTestApp();
      await app.ready();

      const user = createMockUser('user-1', '/tmp/vault1');
      await emitUserAdded(app, user);

      const cp = spawnedProcesses[0]!;
      await emitUserRemoved(app, user);

      expect(cp.kill).toHaveBeenCalledWith('SIGTERM');

      await app.close();
    });
  });

  describe('metrics', () => {
    it('sets cognivault_sync_running gauge to 1 when process is running', async () => {
      const app = await buildTestApp();
      await app.ready();

      const user = createMockUser('user-1', '/tmp/vault1');
      await emitUserAdded(app, user);

      const runningMetric = app.metrics.promRegistry.getSingleMetric(
        'cognivault_sync_running',
      ) as Gauge;
      expect(runningMetric).toBeDefined();
      const values = await runningMetric.get();
      const val = values.values.find((v) => v.labels.user_id === 'user-1');
      expect(val?.value).toBe(1);

      await app.close();
    });

    it('sets cognivault_sync_running gauge to 0 when process stops', async () => {
      const app = await buildTestApp();
      await app.ready();

      const user = createMockUser('user-1', '/tmp/vault1');
      await emitUserAdded(app, user);

      // Remove user to stop process and set gauge to 0
      await emitUserRemoved(app, user);

      const runningMetric = app.metrics.promRegistry.getSingleMetric(
        'cognivault_sync_running',
      ) as Gauge;
      const values = await runningMetric.get();
      const val = values.values.find((v) => v.labels.user_id === 'user-1');
      expect(val?.value).toBe(0);

      await app.close();
    });

    it('increments cognivault_sync_failures_total on process failure', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const app = await buildTestApp();
      await app.ready();

      const user = createMockUser('user-1', '/tmp/vault1');
      await emitUserAdded(app, user);

      spawnedProcesses[0]!.emit('exit', 1, null);

      const failuresMetric = app.metrics.promRegistry.getSingleMetric(
        'cognivault_sync_failures_total',
      ) as Counter;
      expect(failuresMetric).toBeDefined();
      const values = await failuresMetric.get();
      const val = values.values.find((v) => v.labels.user_id === 'user-1');
      expect(val?.value).toBe(1);

      // Clean up
      vi.useRealTimers();
      await app.close();
    });
  });

  describe('onClose hook', () => {
    it('terminates all child processes on server close', async () => {
      const app = await buildTestApp();
      await app.ready();

      const user1 = createMockUser('user-1', '/tmp/vault1');
      const user2 = createMockUser('user-2', '/tmp/vault2');
      await emitUserAdded(app, user1);
      await emitUserAdded(app, user2);

      const cp1 = spawnedProcesses[0]!;
      const cp2 = spawnedProcesses[1]!;

      await app.close();

      expect(cp1.kill).toHaveBeenCalledWith('SIGTERM');
      expect(cp2.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  describe('spawn cwd', () => {
    it('sets cwd to user vaultPath', async () => {
      const app = await buildTestApp();
      await app.ready();

      const user = createMockUser('user-1', '/my/custom/vault');
      await emitUserAdded(app, user);

      expect(spawnCallArgs.length).toBe(1);
      const opts = spawnCallArgs[0]![2] as Record<string, unknown>;
      expect(opts.cwd).toBe('/my/custom/vault');

      await app.close();
    });
  });
});
