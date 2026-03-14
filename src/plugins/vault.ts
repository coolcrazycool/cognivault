import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { VaultManager } from '../lib/vault.js';

declare module 'fastify' {
  interface FastifyInstance {
    vault: VaultManager;
  }
}

async function vaultPlugin(fastify: FastifyInstance): Promise<void> {
  if (!config.VAULT_PATH) {
    fastify.log.info('VAULT_PATH not set, skipping global vault plugin (v2.0 multi-tenant mode)');
    return;
  }
  const vaultManager = new VaultManager(config.VAULT_PATH);
  await vaultManager.initialize();
  fastify.decorate('vault', vaultManager);
}

export default fp(vaultPlugin, {
  name: 'vault',
});
