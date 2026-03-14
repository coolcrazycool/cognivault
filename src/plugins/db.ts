import { mkdir, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { createDatabase } from '../db/client.js';
import type * as schema from '../db/schema.js';
import type { TenantQdrantClient } from '../lib/tenant-qdrant-client.js';

declare module 'fastify' {
  interface FastifyRequest {
    getUserDb: () => BetterSQLite3Database<typeof schema>;
    getUserQdrant: () => TenantQdrantClient;
  }
}

interface UserDb {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: InstanceType<typeof import('better-sqlite3').default>;
}

const userDbs = new Map<string, UserDb>();

function createUserDb(dataDir: string, userId: string): UserDb {
  const userDir = join(dataDir, userId);
  // mkdir is sync-safe since we call this from async contexts
  // but we need the dir to exist before creating DB
  const dbPath = join(userDir, 'index.db');
  const { db, sqlite } = createDatabase(dbPath);
  const entry: UserDb = { db, sqlite };
  userDbs.set(userId, entry);
  return entry;
}

async function dbPlugin(fastify: FastifyInstance): Promise<void> {
  const dataDir = resolve(process.cwd(), config.COGNIVAULT_DATA_DIR);

  // Auto-create data directory if it does not exist
  await mkdir(dataDir, { recursive: true });

  // Delete legacy root-level index.db on startup
  for (const legacyFile of ['index.db', 'index.db-wal', 'index.db-shm']) {
    const legacyPath = join(dataDir, legacyFile);
    try {
      await unlink(legacyPath);
      fastify.log.info(`Deleted legacy ${legacyFile}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }

  // Create DBs for all existing users from registry
  for (const user of fastify.registry.getAllUsers()) {
    const userDir = join(dataDir, user.userId);
    await mkdir(userDir, { recursive: true });
    createUserDb(dataDir, user.userId);
  }

  // Listen for registry events
  fastify.registry.on('user-added', async (user) => {
    const userDir = join(dataDir, user.userId);
    await mkdir(userDir, { recursive: true });
    createUserDb(dataDir, user.userId);
    fastify.log.info({ userId: user.userId }, 'Created per-user database');
  });

  fastify.registry.on('user-removed', async (user) => {
    const entry = userDbs.get(user.userId);
    if (entry) {
      entry.sqlite.close();
      userDbs.delete(user.userId);
    }

    // Delete user data directory
    const userDir = join(dataDir, user.userId);
    try {
      await rm(userDir, { recursive: true, force: true });
    } catch (e) {
      fastify.log.warn({ userId: user.userId, err: e }, 'Failed to delete user data directory');
    }

    // Purge user vectors from Qdrant
    await fastify.purgeUserVectors(user.userId);
    fastify.log.info({ userId: user.userId }, 'Removed per-user database and vectors');
  });

  // Decorate request with getUserDb and getUserQdrant
  fastify.decorateRequest('getUserDb', null);
  fastify.decorateRequest('getUserQdrant', null);

  fastify.addHook('onRequest', async (request) => {
    if (!request.user) return; // unauthenticated routes (health, etc.)
    const userId = request.user.userId;

    request.getUserDb = () => {
      const entry = userDbs.get(userId);
      if (!entry) throw new Error(`No database for user: ${userId}`);
      return entry.db;
    };

    request.getUserQdrant = () => {
      return fastify.createTenantQdrant(userId);
    };
  });

  // Close all user DBs on shutdown
  fastify.addHook('onClose', async () => {
    for (const [, entry] of userDbs) {
      entry.sqlite.close();
    }
    userDbs.clear();
  });
}

export default fp(dbPlugin, { name: 'db', dependencies: ['vault', 'registry', 'qdrant'] });

// Export for testing
export { userDbs as _userDbs };
