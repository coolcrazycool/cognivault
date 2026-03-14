import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import type { FileChangeEvent } from '../lib/indexer.js';
import { VaultIndexer } from '../lib/indexer.js';

// Re-export for consumers that import from the plugin
export type { FileChangeEvent };

declare module 'fastify' {
  interface FastifyInstance {
    indexer: VaultIndexer;
  }
}

// TODO Phase 18: Indexer needs per-user DB context. Currently disabled in app.ts.
async function indexerPlugin(fastify: FastifyInstance): Promise<void> {
  // Phase 18 will pass per-user DB here. For now, indexer is disabled in app.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const indexer = new VaultIndexer({
    db: undefined as any, // TODO Phase 18: per-user DB
    vault: fastify.vault,
    config,
    logger: fastify.log,
  });

  fastify.decorate('indexer', indexer);

  // Start the scan AFTER all plugins are registered (onReady), so pipeline
  // listener is in place before events are emitted.
  fastify.addHook('onReady', async () => {
    indexer.start();
  });

  fastify.addHook('onClose', async () => {
    indexer.stop();
  });
}

export default fp(indexerPlugin, { name: 'indexer', dependencies: ['db', 'vault'] });
