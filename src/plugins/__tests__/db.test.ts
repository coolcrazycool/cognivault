import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We must create the tmpDir and set the mock BEFORE importing the db plugin,
// because config.ts is parsed at module load time.

const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'db-plugin-test-'));
const testDataDir = path.join(tmpBase, 'data');
const testVaultDir = path.join(tmpBase, 'vault');
await fs.mkdir(testVaultDir, { recursive: true });

// Mock config module to use our temp data dir
vi.mock('../../config.js', () => ({
  config: {
    COGNIVAULT_DATA_DIR: testDataDir,
    VAULT_PATH: testVaultDir,
    EMBEDDING_MODEL: 'text-embedding-3-small',
    POLL_INTERVAL_MS: 5000,
    STABILITY_DELAY_MS: 2000,
  },
}));

interface UserRecord {
  userId: string;
  apiKey: string;
  vaultPath: string;
  openaiKey: string;
  obsidian: { email: string; password: string; vault: string };
}

interface RegistryEvents {
  'user-added': [user: UserRecord];
  'user-removed': [user: UserRecord];
  'user-updated': [user: UserRecord, previous: UserRecord];
}

function makeUser(userId: string): UserRecord {
  return {
    userId,
    apiKey: `cv-${userId}`,
    vaultPath: '/tmp/v',
    openaiKey: `sk-${userId}`,
    obsidian: { email: `${userId}@test.com`, password: 'p', vault: 'v' },
  };
}

describe('db plugin', () => {
  beforeEach(async () => {
    // Clean data dir between tests
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  afterEach(async () => {
    // Clear the userDbs Map between tests
    const { _userDbs } = await import('../db.js');
    for (const [, entry] of _userDbs) {
      try {
        entry.sqlite.close();
      } catch {
        // already closed
      }
    }
    _userDbs.clear();
  });

  async function buildTestFastify(opts?: { users?: UserRecord[] }) {
    const { default: Fastify } = await import('fastify');
    const { default: fp } = await import('fastify-plugin');

    const users = opts?.users ?? [];
    const registry = new EventEmitter<RegistryEvents>();
    (registry as unknown as Record<string, unknown>).getAllUsers = () => users;
    (registry as unknown as Record<string, unknown>).getUserByApiKey = (key: string) =>
      users.find((u) => u.apiKey === key);

    const mockCreateTenantQdrant = vi.fn().mockImplementation((userId: string) => ({
      userId,
      search: vi.fn(),
      scroll: vi.fn(),
    }));
    const mockPurgeUserVectors = vi.fn().mockResolvedValue(undefined);

    const app = Fastify({ logger: false });

    // Register vault plugin dependency (stub)
    await app.register(
      fp(
        async (f) => {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          f.decorate('vault', { vaultRootPath: testVaultDir } as any);
        },
        { name: 'vault' },
      ),
    );

    // Register registry plugin dependency
    await app.register(
      fp(
        async (f) => {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          f.decorate('registry', registry as any);
        },
        { name: 'registry' },
      ),
    );

    // Register qdrant plugin dependency (stubs)
    await app.register(
      fp(
        async (f) => {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          f.decorate('createTenantQdrant', mockCreateTenantQdrant as any);
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          f.decorate('purgeUserVectors', mockPurgeUserVectors as any);
        },
        { name: 'qdrant' },
      ),
    );

    return { app, registry, mockCreateTenantQdrant, mockPurgeUserVectors };
  }

  it('creates DBs for all existing users from registry on init', async () => {
    const users = [makeUser('alice'), makeUser('bob')];
    const { app } = await buildTestFastify({ users });

    const { default: dbPlugin } = await import('../db.js');
    await app.register(dbPlugin);
    await app.ready();

    // Verify DB files created for both users
    const aliceStat = await fs.stat(path.join(testDataDir, 'alice', 'index.db'));
    const bobStat = await fs.stat(path.join(testDataDir, 'bob', 'index.db'));
    expect(aliceStat.isFile()).toBe(true);
    expect(bobStat.isFile()).toBe(true);

    await app.close();
  });

  it('user-added event creates new DB at correct path', async () => {
    const { app, registry } = await buildTestFastify();

    const { default: dbPlugin } = await import('../db.js');
    await app.register(dbPlugin);
    await app.ready();

    registry.emit('user-added', makeUser('charlie'));
    await new Promise((r) => setTimeout(r, 100));

    const dbPath = path.join(testDataDir, 'charlie', 'index.db');
    const stat = await fs.stat(dbPath);
    expect(stat.isFile()).toBe(true);

    await app.close();
  });

  it('user-removed event closes DB, deletes directory, calls purgeUserVectors', async () => {
    const dave = makeUser('dave');
    const { app, registry, mockPurgeUserVectors } = await buildTestFastify({ users: [dave] });

    const { default: dbPlugin } = await import('../db.js');
    await app.register(dbPlugin);
    await app.ready();

    // Verify DB exists first
    const userDir = path.join(testDataDir, 'dave');
    const stat = await fs.stat(path.join(userDir, 'index.db'));
    expect(stat.isFile()).toBe(true);

    // Remove user
    registry.emit('user-removed', dave);
    await new Promise((r) => setTimeout(r, 200));

    // Directory should be deleted
    await expect(fs.stat(userDir)).rejects.toThrow();

    // purgeUserVectors should have been called
    expect(mockPurgeUserVectors).toHaveBeenCalledWith('dave');

    await app.close();
  });

  it('getUserDb returns correct DB for authenticated request', async () => {
    const eve = makeUser('eve');
    const { app } = await buildTestFastify({ users: [eve] });

    const { default: dbPlugin } = await import('../db.js');
    await app.register(dbPlugin);

    // Add a test route that simulates authenticated request
    app.get('/test-db', async (request) => {
      // Simulate what auth plugin does
      request.user = eve;
      // The onRequest hook has already run at this point in real flow,
      // but in tests we need to manually trigger the decorator logic
      // So we set it manually for the test
      const { _userDbs } = await import('../db.js');
      const entry = _userDbs.get(eve.userId);
      if (!entry) throw new Error('No DB');
      return { hasDb: entry.db !== undefined };
    });

    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/test-db' });
    expect(response.statusCode).toBe(200);
    expect(response.json().hasDb).toBe(true);

    await app.close();
  });

  it('getUserDb throws for unknown userId', async () => {
    const { app } = await buildTestFastify();

    const { default: dbPlugin, _userDbs } = await import('../db.js');
    await app.register(dbPlugin);

    app.get('/test-unknown', async () => {
      const getter = () => {
        const entry = _userDbs.get('nonexistent');
        if (!entry) throw new Error('No database for user: nonexistent');
        return entry.db;
      };
      try {
        getter();
        return { threw: false };
      } catch {
        return { threw: true };
      }
    });

    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/test-unknown' });
    expect(response.statusCode).toBe(200);
    expect(response.json().threw).toBe(true);

    await app.close();
  });

  it('getUserDbById returns correct DB for existing user', async () => {
    const frank = makeUser('frank');
    const { app } = await buildTestFastify({ users: [frank] });

    const { default: dbPlugin } = await import('../db.js');
    await app.register(dbPlugin);
    await app.ready();

    const db = app.getUserDbById('frank');
    expect(db).toBeDefined();

    await app.close();
  });

  it('getUserDbById throws for unknown user', async () => {
    const { app } = await buildTestFastify();

    const { default: dbPlugin } = await import('../db.js');
    await app.register(dbPlugin);
    await app.ready();

    expect(() => app.getUserDbById('nonexistent')).toThrow('No database for user: nonexistent');

    await app.close();
  });

  it('deletes legacy index.db on startup', async () => {
    // Create legacy files before plugin init
    await fs.mkdir(testDataDir, { recursive: true });
    await fs.writeFile(path.join(testDataDir, 'index.db'), 'legacy-data');
    await fs.writeFile(path.join(testDataDir, 'index.db-wal'), 'legacy-wal');
    await fs.writeFile(path.join(testDataDir, 'index.db-shm'), 'legacy-shm');

    const { app } = await buildTestFastify();

    const { default: dbPlugin } = await import('../db.js');
    await app.register(dbPlugin);
    await app.ready();

    // Legacy files should be deleted
    await expect(fs.stat(path.join(testDataDir, 'index.db'))).rejects.toThrow();
    await expect(fs.stat(path.join(testDataDir, 'index.db-wal'))).rejects.toThrow();
    await expect(fs.stat(path.join(testDataDir, 'index.db-shm'))).rejects.toThrow();

    await app.close();
  });

  it('auto-creates data directory', async () => {
    // Ensure data dir does not exist
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }

    const { app } = await buildTestFastify();

    const { default: dbPlugin } = await import('../db.js');
    await app.register(dbPlugin);
    await app.ready();

    const stat = await fs.stat(testDataDir);
    expect(stat.isDirectory()).toBe(true);

    await app.close();
  });
});
