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

async function indexerPlugin(fastify: FastifyInstance): Promise<void> {
  const indexer = new VaultIndexer({
    db: fastify.db,
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
