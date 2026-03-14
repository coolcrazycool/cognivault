import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Counter, Gauge } from 'prom-client';
import type { UserRecord } from '../lib/user-registry.js';

// ── Constants ──

const BASE_DELAY = 1000;
const MAX_DELAY = 30_000;
const BACKOFF_FACTOR = 2;
const STABILITY_THRESHOLD = 60_000;
const KILL_TIMEOUT = 5000;

// ── Types ──

interface SyncEntry {
  process: ChildProcess | null;
  backoffDelay: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
  startTime: number;
}

// ── Plugin ──

async function syncPlugin(fastify: FastifyInstance): Promise<void> {
  const syncs = new Map<string, SyncEntry>();

  // Register metrics on shared promRegistry
  const syncRunning = new Gauge({
    name: 'cognivault_sync_running',
    help: 'Whether ob sync process is running for a user (1=running, 0=stopped)',
    labelNames: ['user_id'] as const,
    registers: [fastify.metrics.promRegistry],
  });

  const syncFailures = new Counter({
    name: 'cognivault_sync_failures_total',
    help: 'Total number of ob sync process failures per user',
    labelNames: ['user_id'] as const,
    registers: [fastify.metrics.promRegistry],
  });

  // ── Inner functions ──

  function spawnSync(user: UserRecord): void {
    const entry = syncs.get(user.userId);
    if (!entry || entry.stopping) return;

    const cp = spawn('ob', ['sync', '--continuous'], {
      cwd: user.vaultPath,
      env: { ...process.env, OBSIDIAN_AUTH_TOKEN: user.obsidian.token ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    entry.process = cp;
    entry.startTime = Date.now();
    syncRunning.labels({ user_id: user.userId }).set(1);

    // Pipe stdout/stderr to Fastify logger
    cp.stdout?.on('data', (data: Buffer) => {
      fastify.log.info({ userId: user.userId, source: 'ob-sync' }, data.toString().trim());
    });

    cp.stderr?.on('data', (data: Buffer) => {
      fastify.log.warn({ userId: user.userId, source: 'ob-sync' }, data.toString().trim());
    });

    // Handle process exit
    cp.on('exit', (code, signal) => {
      syncRunning.labels({ user_id: user.userId }).set(0);
      entry.process = null;

      if (entry.stopping) return;

      // Increment failure counter
      syncFailures.labels({ user_id: user.userId }).inc();
      fastify.log.warn(
        { userId: user.userId, exitCode: code, signal },
        'ob sync process exited unexpectedly',
      );

      // Determine current restart delay, then adjust for next failure
      const runDuration = Date.now() - entry.startTime;
      if (runDuration >= STABILITY_THRESHOLD) {
        entry.backoffDelay = BASE_DELAY;
      }
      const currentDelay = entry.backoffDelay;
      // Increase backoff for next failure
      entry.backoffDelay = Math.min(entry.backoffDelay * BACKOFF_FACTOR, MAX_DELAY);

      // Schedule restart
      entry.restartTimer = setTimeout(() => {
        cleanLockFile(user.vaultPath);
        spawnSync(user);
      }, currentDelay);
    });
  }

  function cleanLockFile(vaultPath: string): void {
    try {
      unlinkSync(join(vaultPath, '.obsidian', '.sync.lock'));
    } catch {
      // ENOENT or other errors silently ignored
    }
  }

  function startSync(user: UserRecord): void {
    cleanLockFile(user.vaultPath);
    spawnSync(user);
  }

  // ── Registry event handlers ──

  fastify.registry.on('user-added', (user) => {
    const entry: SyncEntry = {
      process: null,
      backoffDelay: BASE_DELAY,
      restartTimer: null,
      stopping: false,
      startTime: 0,
    };
    syncs.set(user.userId, entry);
    startSync(user);
  });

  fastify.registry.on('user-removed', async (user) => {
    const entry = syncs.get(user.userId);
    if (!entry) return;

    entry.stopping = true;

    // Clear any pending restart timer
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = null;
    }

    // Send SIGTERM, then SIGKILL after timeout
    if (entry.process) {
      entry.process.kill('SIGTERM');
      const cp = entry.process;
      setTimeout(() => {
        try {
          cp.kill('SIGKILL');
        } catch {
          // Process may already be dead
        }
      }, KILL_TIMEOUT);
    }

    syncRunning.remove({ user_id: user.userId });
    syncFailures.remove({ user_id: user.userId });
    syncs.delete(user.userId);
  });

  // ── onClose hook: terminate all ──

  fastify.addHook('onClose', async () => {
    for (const [userId, entry] of syncs) {
      entry.stopping = true;

      if (entry.restartTimer) {
        clearTimeout(entry.restartTimer);
        entry.restartTimer = null;
      }

      if (entry.process) {
        entry.process.kill('SIGTERM');

        // Schedule SIGKILL as fallback (fire-and-forget)
        const cp = entry.process;
        setTimeout(() => {
          try {
            cp.kill('SIGKILL');
          } catch {
            // Process may already be dead
          }
        }, KILL_TIMEOUT);
      }

      syncRunning.labels({ user_id: userId }).set(0);
    }

    syncs.clear();
  });
}

export default fp(syncPlugin, {
  name: 'sync',
  dependencies: ['registry', 'metrics'],
});
