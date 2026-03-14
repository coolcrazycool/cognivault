import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRecord } from '../user-registry.js';
import { UserRegistry } from '../user-registry.js';

function makeTmpDir(): string {
  return path.join(
    process.env.TMPDIR ?? '/tmp',
    `user-registry-test-${crypto.randomBytes(6).toString('hex')}`,
  );
}

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    userId: 'alice',
    apiKey: 'cv-testkey123',
    vaultPath: '/vaults/alice',
    openaiKey: 'sk-test-alice',
    obsidian: {
      email: 'alice@example.com',
      password: 'pass123',
      vault: 'AliceVault',
    },
    ...overrides,
  };
}

describe('UserRegistry', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    await fs.mkdir(tmpDir, { recursive: true });
    filePath = path.join(tmpDir, 'users.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Load & Lookup ──

  describe('load and lookup', () => {
    it('loads valid users.json and getUserByApiKey returns correct user', async () => {
      const users = [makeUser()];
      await fs.writeFile(filePath, JSON.stringify(users));

      const registry = new UserRegistry({ filePath });
      await registry.load();

      const found = registry.getUserByApiKey('cv-testkey123');
      expect(found).toBeDefined();
      expect(found!.userId).toBe('alice');
      expect(found!.vaultPath).toBe('/vaults/alice');
    });

    it('loads valid users.json and getUserById returns correct user', async () => {
      const users = [makeUser()];
      await fs.writeFile(filePath, JSON.stringify(users));

      const registry = new UserRegistry({ filePath });
      await registry.load();

      const found = registry.getUserById('alice');
      expect(found).toBeDefined();
      expect(found!.apiKey).toBe('cv-testkey123');
    });

    it('creates empty file and starts with zero users when file missing', async () => {
      const missingPath = path.join(tmpDir, 'nonexistent.json');
      const registry = new UserRegistry({ filePath: missingPath });
      await registry.load();

      expect(registry.getUserCount()).toBe(0);
      expect(registry.getAllUsers()).toEqual([]);

      // File should now exist
      const content = await fs.readFile(missingPath, 'utf-8');
      expect(JSON.parse(content)).toEqual([]);
    });

    it('throws on malformed JSON at startup', async () => {
      await fs.writeFile(filePath, '{not valid json!!}');

      const registry = new UserRegistry({ filePath });
      await expect(registry.load()).rejects.toThrow();
    });

    it('throws on duplicate userId', async () => {
      const users = [
        makeUser({ userId: 'alice', apiKey: 'cv-key1' }),
        makeUser({ userId: 'alice', apiKey: 'cv-key2' }),
      ];
      await fs.writeFile(filePath, JSON.stringify(users));

      const registry = new UserRegistry({ filePath });
      await expect(registry.load()).rejects.toThrow(/duplicate/i);
    });

    it('throws on duplicate apiKey', async () => {
      const users = [
        makeUser({ userId: 'alice', apiKey: 'cv-samekey' }),
        makeUser({ userId: 'bob', apiKey: 'cv-samekey', vaultPath: '/vaults/bob' }),
      ];
      await fs.writeFile(filePath, JSON.stringify(users));

      const registry = new UserRegistry({ filePath });
      await expect(registry.load()).rejects.toThrow(/duplicate/i);
    });
  });

  // ── Immutability ──

  describe('immutability', () => {
    it('getUserByApiKey returns frozen copy that cannot be mutated', async () => {
      const users = [makeUser()];
      await fs.writeFile(filePath, JSON.stringify(users));

      const registry = new UserRegistry({ filePath });
      await registry.load();

      const user = registry.getUserByApiKey('cv-testkey123')!;
      expect(Object.isFrozen(user)).toBe(true);
      expect(Object.isFrozen(user.obsidian)).toBe(true);

      // Mutation should throw in strict mode or silently fail
      expect(() => {
        (user as Record<string, unknown>).userId = 'hacked';
      }).toThrow();

      // Verify internal state unchanged
      const again = registry.getUserByApiKey('cv-testkey123')!;
      expect(again.userId).toBe('alice');
    });
  });

  // ── Write Methods ──

  describe('addUser and removeUser', () => {
    it('addUser writes atomically (tmp file then rename)', async () => {
      await fs.writeFile(filePath, '[]');
      const registry = new UserRegistry({ filePath });
      await registry.load();

      await registry.addUser(makeUser());

      // Verify user is in registry
      expect(registry.getUserById('alice')).toBeDefined();
      expect(registry.getUserCount()).toBe(1);

      // Verify file on disk contains the user (atomic write completed)
      const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(onDisk).toHaveLength(1);
      expect(onDisk[0].userId).toBe('alice');

      // Verify no leftover .tmp files (rename succeeded)
      const dirEntries = await fs.readdir(tmpDir);
      const tmpFiles = dirEntries.filter((e) => e.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('addUser with duplicate userId throws', async () => {
      await fs.writeFile(filePath, JSON.stringify([makeUser()]));
      const registry = new UserRegistry({ filePath });
      await registry.load();

      await expect(registry.addUser(makeUser({ apiKey: 'cv-different' }))).rejects.toThrow(
        /duplicate/i,
      );
    });

    it('removeUser removes from lookups and writes to disk', async () => {
      await fs.writeFile(filePath, JSON.stringify([makeUser()]));
      const registry = new UserRegistry({ filePath });
      await registry.load();

      await registry.removeUser('alice');

      expect(registry.getUserById('alice')).toBeUndefined();
      expect(registry.getUserByApiKey('cv-testkey123')).toBeUndefined();
      expect(registry.getUserCount()).toBe(0);

      // Verify file on disk
      const onDisk = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(onDisk).toHaveLength(0);
    });
  });

  // ── Hot-Reload ──

  describe('hot-reload', () => {
    it('reloads when file changes with new valid data', async () => {
      const users = [makeUser()];
      await fs.writeFile(filePath, JSON.stringify(users));

      const registry = new UserRegistry({ filePath });
      await registry.load();

      const reloadPromise = new Promise<string>((resolve) => {
        registry.startWatching();
        // Listen for user-added event as signal reload happened
        registry.on('user-added', (user) => {
          resolve(user.userId);
        });
      });

      // Simulate external edit: add a user atomically
      const newUsers = [
        makeUser(),
        makeUser({ userId: 'bob', apiKey: 'cv-bobkey', vaultPath: '/vaults/bob' }),
      ];
      const tmpFile = filePath + '.ext.tmp';
      await fs.writeFile(tmpFile, JSON.stringify(newUsers));
      await fs.rename(tmpFile, filePath);

      const addedUserId = await Promise.race([
        reloadPromise,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Reload timed out')), 5000),
        ),
      ]);

      expect(addedUserId).toBe('bob');
      expect(registry.getUserCount()).toBe(2);

      registry.stopWatching();
    });

    it('keeps last valid data on invalid reload', async () => {
      await fs.writeFile(filePath, JSON.stringify([makeUser()]));
      const onReload = vi.fn();
      const registry = new UserRegistry({ filePath, onReload });
      await registry.load();

      const rejectPromise = new Promise<void>((resolve) => {
        registry.startWatching();
        onReload.mockImplementation((status: string) => {
          if (status === 'rejected') resolve();
        });
      });

      // Write invalid data
      const tmpFile = filePath + '.ext.tmp';
      await fs.writeFile(tmpFile, '{broken json!!!}');
      await fs.rename(tmpFile, filePath);

      await Promise.race([
        rejectPromise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Reload timed out')), 5000),
        ),
      ]);

      // Data unchanged
      expect(registry.getUserCount()).toBe(1);
      expect(registry.getUserById('alice')).toBeDefined();

      registry.stopWatching();
    });

    it('skips reload when content hash unchanged', async () => {
      await fs.writeFile(filePath, JSON.stringify([makeUser()]));
      const onReload = vi.fn();
      const registry = new UserRegistry({ filePath, onReload });
      await registry.load();
      registry.startWatching();

      // Touch the file with same content
      const content = await fs.readFile(filePath, 'utf-8');
      const tmpFile = filePath + '.ext.tmp';
      await fs.writeFile(tmpFile, content);
      await fs.rename(tmpFile, filePath);

      // Wait for debounce to fire
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));

      // onReload should not have been called (content unchanged)
      expect(onReload).not.toHaveBeenCalled();

      registry.stopWatching();
    });
  });

  // ── Events ──

  describe('diff events', () => {
    it('emits user-added when new user appears on reload', async () => {
      await fs.writeFile(filePath, '[]');
      const registry = new UserRegistry({ filePath });
      await registry.load();

      const addedPromise = new Promise<UserRecord>((resolve) => {
        registry.on('user-added', (user) => resolve(user));
        registry.startWatching();
      });

      // Add user via external file write
      const tmpFile = filePath + '.ext.tmp';
      await fs.writeFile(tmpFile, JSON.stringify([makeUser()]));
      await fs.rename(tmpFile, filePath);

      const added = await Promise.race([
        addedPromise,
        new Promise<UserRecord>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 5000),
        ),
      ]);

      expect(added.userId).toBe('alice');
      registry.stopWatching();
    });

    it('emits user-removed when user disappears on reload', async () => {
      await fs.writeFile(filePath, JSON.stringify([makeUser()]));
      const registry = new UserRegistry({ filePath });
      await registry.load();

      const removedPromise = new Promise<UserRecord>((resolve) => {
        registry.on('user-removed', (user) => resolve(user));
        registry.startWatching();
      });

      // Remove all users
      const tmpFile = filePath + '.ext.tmp';
      await fs.writeFile(tmpFile, '[]');
      await fs.rename(tmpFile, filePath);

      const removed = await Promise.race([
        removedPromise,
        new Promise<UserRecord>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 5000),
        ),
      ]);

      expect(removed.userId).toBe('alice');
      registry.stopWatching();
    });

    it('emits user-updated when user field changes on reload', async () => {
      await fs.writeFile(filePath, JSON.stringify([makeUser()]));
      const registry = new UserRegistry({ filePath });
      await registry.load();

      const updatedPromise = new Promise<{ user: UserRecord; previous: UserRecord }>((resolve) => {
        registry.on('user-updated', (user, previous) => resolve({ user, previous }));
        registry.startWatching();
      });

      // Update vault path
      const updated = [makeUser({ vaultPath: '/vaults/alice-new' })];
      const tmpFile = filePath + '.ext.tmp';
      await fs.writeFile(tmpFile, JSON.stringify(updated));
      await fs.rename(tmpFile, filePath);

      const result = await Promise.race([
        updatedPromise,
        new Promise<{ user: UserRecord; previous: UserRecord }>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 5000),
        ),
      ]);

      expect(result.user.vaultPath).toBe('/vaults/alice-new');
      expect(result.previous.vaultPath).toBe('/vaults/alice');
      registry.stopWatching();
    });
  });

  // ── Event Emission ──

  describe('event emission', () => {
    it('addUser() emits user-added with frozen record', async () => {
      await fs.writeFile(filePath, '[]');
      const registry = new UserRegistry({ filePath });
      await registry.load();

      const spy = vi.fn();
      registry.on('user-added', spy);

      await registry.addUser(makeUser());

      expect(spy).toHaveBeenCalledOnce();
      const firstCall = spy.mock.calls[0];
      expect(firstCall).toBeDefined();
      const emittedUser = firstCall![0] as UserRecord;
      expect(emittedUser.userId).toBe('alice');
      expect(emittedUser.vaultPath).toBe('/vaults/alice');
      expect(Object.isFrozen(emittedUser)).toBe(true);
    });

    it('removeUser() emits user-removed with frozen record', async () => {
      await fs.writeFile(filePath, JSON.stringify([makeUser()]));
      const registry = new UserRegistry({ filePath });
      await registry.load();

      const spy = vi.fn();
      registry.on('user-removed', spy);

      await registry.removeUser('alice');

      expect(spy).toHaveBeenCalledOnce();
      const firstCall = spy.mock.calls[0];
      expect(firstCall).toBeDefined();
      const emittedUser = firstCall![0] as UserRecord;
      expect(emittedUser.userId).toBe('alice');
      expect(Object.isFrozen(emittedUser)).toBe(true);
    });

    it('addUser() does not emit on duplicate userId', async () => {
      await fs.writeFile(filePath, JSON.stringify([makeUser()]));
      const registry = new UserRegistry({ filePath });
      await registry.load();

      const spy = vi.fn();
      registry.on('user-added', spy);

      await expect(registry.addUser(makeUser({ apiKey: 'cv-differentkey' }))).rejects.toThrow(
        /duplicate/i,
      );

      expect(spy).not.toHaveBeenCalled();
    });

    it('removeUser() does not emit for unknown userId', async () => {
      await fs.writeFile(filePath, '[]');
      const registry = new UserRegistry({ filePath });
      await registry.load();

      const spy = vi.fn();
      registry.on('user-removed', spy);

      await registry.removeUser('nonexistent');

      expect(spy).not.toHaveBeenCalled();
    });

    it('emitted records are frozen (user and obsidian)', async () => {
      await fs.writeFile(filePath, '[]');
      const registry = new UserRegistry({ filePath });
      await registry.load();

      let capturedUser: UserRecord | null = null;
      registry.on('user-added', (user) => {
        capturedUser = user;
      });

      await registry.addUser(makeUser());

      expect(capturedUser).not.toBeNull();
      expect(Object.isFrozen(capturedUser!)).toBe(true);
      expect(Object.isFrozen(capturedUser!.obsidian)).toBe(true);
    });
  });

  // ── Static Utility ──

  describe('generateApiKey', () => {
    it('returns string starting with cv-', () => {
      const key = UserRegistry.generateApiKey();
      expect(key).toMatch(/^cv-/);
    });

    it('returns unique values on successive calls', () => {
      const key1 = UserRegistry.generateApiKey();
      const key2 = UserRegistry.generateApiKey();
      expect(key1).not.toBe(key2);
    });
  });
});
