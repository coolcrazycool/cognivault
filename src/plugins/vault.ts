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
  const vaultManager = new VaultManager(config.VAULT_PATH);
  await vaultManager.initialize();
  fastify.decorate('vault', vaultManager);
}

export default fp(vaultPlugin, {
  name: 'vault',
});
