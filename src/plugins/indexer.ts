import * as fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import PQueue from 'p-queue';
import { config } from '../config.js';
import type { FileChangeEvent } from '../lib/indexer.js';
import { VaultIndexer } from '../lib/indexer.js';
import { VaultManager } from '../lib/vault.js';

// Re-export for consumers that import from the plugin
export type { FileChangeEvent };

interface IndexerEntry {
  indexer: VaultIndexer;
  queue: PQueue;
  vault: VaultManager;
}

declare module 'fastify' {
  interface FastifyInstance {
    indexers: Map<string, IndexerEntry>;
    processFileChanges: (userId: string, events: FileChangeEvent[]) => void;
  }
}

async function createUserIndexer(
  fastify: FastifyInstance,
  userId: string,
  vaultPath: string,
): Promise<IndexerEntry | null> {
  // Validate vault path exists
  try {
    await fs.access(vaultPath);
  } catch {
    fastify.log.warn(
      { userId, vaultPath },
      'Vault path does not exist — skipping indexer creation',
    );
    return null;
  }

  const vault = new VaultManager(vaultPath);
  await vault.initialize();
  const db = fastify.getUserDbById(userId);
  const logger = fastify.log.child({ userId });

  const indexer = new VaultIndexer({
    db,
    vault,
    config: {
      POLL_INTERVAL_MS: config.POLL_INTERVAL_MS,
      STABILITY_DELAY_MS: config.STABILITY_DELAY_MS,
    },
    logger,
  });

  const queue = new PQueue({ concurrency: 3, timeout: 120_000 });

  // Forward indexer 'changes' events to pipeline with userId context
  indexer.on('changes', (events: FileChangeEvent[]) => {
    fastify.processFileChanges(userId, events);
  });

  const entry: IndexerEntry = { indexer, queue, vault };
  fastify.indexers.set(userId, entry);
  return entry;
}

async function indexerPlugin(fastify: FastifyInstance): Promise<void> {
  const indexers = new Map<string, IndexerEntry>();
  fastify.decorate('indexers', indexers);

  // Create indexers for all existing users and start them in onReady
  fastify.addHook('onReady', async () => {
    const users = fastify.registry.getAllUsers();
    for (const user of users) {
      const entry = await createUserIndexer(fastify, user.userId, user.vaultPath);
      if (entry) {
        entry.indexer.start();
      }
    }
  });

  // Registry event: user-added
  // Wait briefly for db plugin's user-added handler to create the database
  // (both handlers fire concurrently on the same EventEmitter)
  fastify.registry.on('user-added', async (user) => {
    try {
      for (let i = 0; i < 10; i++) {
        try {
          fastify.getUserDbById(user.userId);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }

      // Retry vault path access — ob sync creates directory lazily
      const MAX_VAULT_WAIT_MS = 30_000;
      const VAULT_POLL_INTERVAL_MS = 2_000;
      const deadline = Date.now() + MAX_VAULT_WAIT_MS;

      let entry: IndexerEntry | null = null;
      while (Date.now() < deadline) {
        entry = await createUserIndexer(fastify, user.userId, user.vaultPath);
        if (entry) break;
        await new Promise((r) => setTimeout(r, VAULT_POLL_INTERVAL_MS));
      }

      if (entry) {
        entry.indexer.start();
        fastify.log.info({ userId: user.userId }, 'Started per-user indexer');
      } else {
        fastify.log.warn(
          { userId: user.userId, vaultPath: user.vaultPath },
          'Vault path not available after 30s — indexer not started',
        );
      }
    } catch (err) {
      fastify.log.error({ userId: user.userId, err }, 'Failed to create indexer for user');
    }
  });

  // Registry event: user-removed
  fastify.registry.on('user-removed', async (user) => {
    const entry = indexers.get(user.userId);
    if (entry) {
      entry.indexer.stop();
      entry.queue.clear();
      await entry.queue.onIdle();
      fastify.metrics.removeUserMetrics(user.userId);
      indexers.delete(user.userId);
      fastify.log.info({ userId: user.userId }, 'Stopped and removed per-user indexer');
    }
  });

  // Stop all indexers on server close
  fastify.addHook('onClose', async () => {
    for (const [, entry] of indexers) {
      entry.indexer.stop();
      entry.queue.clear();
    }
    indexers.clear();
  });
}

export default fp(indexerPlugin, {
  name: 'indexer',
  dependencies: ['db', 'registry', 'qdrant', 'embedder', 'metrics', 'pipeline'],
});
