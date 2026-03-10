import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { createDatabase } from '../db/client.js';
import type * as schema from '../db/schema.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: BetterSQLite3Database<typeof schema>;
  }
}

async function dbPlugin(fastify: FastifyInstance): Promise<void> {
  const dataDir = resolve(process.cwd(), config.COGNIVAULT_DATA_DIR);

  // Auto-create data directory if it does not exist
  await mkdir(dataDir, { recursive: true });

  const dbPath = join(dataDir, 'index.db');
  const { db, sqlite } = createDatabase(dbPath);

  fastify.decorate('db', db);

  fastify.addHook('onClose', async () => {
    sqlite.close();
  });
}

export default fp(dbPlugin, { name: 'db', dependencies: ['vault'] });
