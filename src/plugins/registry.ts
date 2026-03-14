import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Counter, Gauge } from 'prom-client';
import { config } from '../config.js';
import { UserRegistry } from '../lib/user-registry.js';

declare module 'fastify' {
  interface FastifyInstance {
    registry: UserRegistry;
  }
}

async function registryPlugin(fastify: FastifyInstance): Promise<void> {
  const reloadsCounter = new Counter({
    name: 'cognivault_registry_reloads_total',
    help: 'Total number of user registry reload attempts',
    labelNames: ['status'] as const,
    registers: [fastify.metrics.promRegistry],
  });

  const usersGauge = new Gauge({
    name: 'cognivault_registry_users',
    help: 'Current number of registered users',
    registers: [fastify.metrics.promRegistry],
  });

  const filePath = join(config.COGNIVAULT_DATA_DIR, 'users.json');

  const registry = new UserRegistry({
    filePath,
    logger: fastify.log,
    onReload: (status) => reloadsCounter.inc({ status }),
    onUserCountChange: (count) => usersGauge.set(count),
  });

  await registry.load();
  registry.startWatching();

  usersGauge.set(registry.getUserCount());

  fastify.decorate('registry', registry);

  fastify.addHook('onClose', async () => {
    registry.stopWatching();
  });
}

export default fp(registryPlugin, { name: 'registry', dependencies: ['metrics'] });
