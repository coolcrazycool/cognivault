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

  // Start the scan — does NOT block (scan runs in background per design)
  indexer.start();

  fastify.addHook('onClose', async () => {
    indexer.stop();
  });
}

export default fp(indexerPlugin, { name: 'indexer', dependencies: ['db', 'vault'] });
