import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DotfileAccessError,
  FileNotFoundError,
  PathTraversalError,
  VaultError,
  VaultManager,
} from '../vault.js';

describe('VaultManager', () => {
  let tmpDir: string;
  let vaultRoot: string;
  let outsideDir: string;
  let manager: VaultManager;

  beforeAll(async () => {
    // Create a temporary directory structure for testing
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-test-'));
    vaultRoot = path.join(tmpDir, 'vault');
    outsideDir = path.join(tmpDir, 'outside');

    // Create vault structure
    await fs.mkdir(vaultRoot, { recursive: true });
    await fs.mkdir(path.join(vaultRoot, 'notes'), { recursive: true });
    await fs.mkdir(path.join(vaultRoot, 'Projects', 'CogniVault'), { recursive: true });
    await fs.mkdir(path.join(vaultRoot, 'My Notes'), { recursive: true });
    await fs.mkdir(path.join(vaultRoot, 'Заметки'), { recursive: true });
    await fs.mkdir(path.join(vaultRoot, '.obsidian'), { recursive: true });
    await fs.mkdir(path.join(vaultRoot, 'folder', '.hidden'), { recursive: true });

    // Create files
    await fs.writeFile(path.join(vaultRoot, 'notes', 'test.md'), '# Test');
    await fs.writeFile(path.join(vaultRoot, 'My Notes', 'todo.md'), '# Todo');
    await fs.writeFile(path.join(vaultRoot, 'Заметки', 'проект.md'), '# Проект');
    await fs.writeFile(path.join(vaultRoot, '.obsidian', 'workspace.json'), '{}');
    await fs.writeFile(path.join(vaultRoot, 'folder', '.hidden', 'file.md'), '# Hidden');

    // Create outside directory and symlink
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'secret');
    await fs.symlink(outsideDir, path.join(vaultRoot, 'escape-link'));

    manager = new VaultManager(vaultRoot);
    await manager.initialize();
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('initialize()', () => {
    it('succeeds when VAULT_PATH is a valid directory', async () => {
      const m = new VaultManager(vaultRoot);
      await expect(m.initialize()).resolves.toBeUndefined();
    });

    it('throws when VAULT_PATH does not exist', async () => {
      const m = new VaultManager(path.join(tmpDir, 'nonexistent'));
      await expect(m.initialize()).rejects.toThrow(VaultError);
    });

    it('throws when VAULT_PATH is a file, not a directory', async () => {
      const filePath = path.join(tmpDir, 'a-file.txt');
      await fs.writeFile(filePath, 'content');
      const m = new VaultManager(filePath);
      await expect(m.initialize()).rejects.toThrow(VaultError);
    });
  });

  describe('resolvePath()', () => {
    it('resolves normal relative path within vault', async () => {
      const resolved = await manager.resolvePath('notes/test.md');
      expect(resolved).toBe(path.join(vaultRoot, 'notes', 'test.md'));
    });

    it('resolves empty string to vault root', async () => {
      const resolved = await manager.resolvePath('');
      expect(resolved).toBe(vaultRoot);
    });

    it('rejects path traversal with ../../etc/passwd', async () => {
      await expect(manager.resolvePath('../../etc/passwd')).rejects.toThrow(PathTraversalError);
    });

    it('rejects path traversal with ../outside', async () => {
      await expect(manager.resolvePath('../outside')).rejects.toThrow(PathTraversalError);
    });

    it('rejects dotfile access .obsidian/workspace.json', async () => {
      await expect(manager.resolvePath('.obsidian/workspace.json')).rejects.toThrow(
        DotfileAccessError,
      );
    });

    it('rejects dotfolder in middle of path', async () => {
      await expect(manager.resolvePath('folder/.hidden/file.md')).rejects.toThrow(
        DotfileAccessError,
      );
    });

    it('normalizes double slashes', async () => {
      const resolved = await manager.resolvePath('notes//test.md');
      expect(resolved).toBe(path.join(vaultRoot, 'notes', 'test.md'));
    });

    it('strips leading slash and resolves correctly', async () => {
      const resolved = await manager.resolvePath('/notes/test.md');
      expect(resolved).toBe(path.join(vaultRoot, 'notes', 'test.md'));
    });

    it('rejects symlink pointing outside vault', async () => {
      await expect(manager.resolvePath('escape-link')).rejects.toThrow(PathTraversalError);
    });

    it('resolves Cyrillic paths correctly', async () => {
      const resolved = await manager.resolvePath('Заметки/проект.md');
      expect(resolved).toBe(path.join(vaultRoot, 'Заметки', 'проект.md'));
    });

    it('resolves paths with spaces correctly', async () => {
      const resolved = await manager.resolvePath('My Notes/todo.md');
      expect(resolved).toBe(path.join(vaultRoot, 'My Notes', 'todo.md'));
    });

    it('throws FileNotFoundError for nonexistent paths', async () => {
      await expect(manager.resolvePath('nonexistent/file.md')).rejects.toThrow(FileNotFoundError);
    });
  });

  describe('error classes', () => {
    it('PathTraversalError has correct code and status', () => {
      const err = new PathTraversalError('test');
      expect(err.code).toBe('PATH_TRAVERSAL');
      expect(err.statusCode).toBe(403);
      expect(err).toBeInstanceOf(VaultError);
    });

    it('FileNotFoundError has correct code and status', () => {
      const err = new FileNotFoundError('test');
      expect(err.code).toBe('NOT_FOUND');
      expect(err.statusCode).toBe(404);
      expect(err).toBeInstanceOf(VaultError);
    });

    it('DotfileAccessError has correct code and status', () => {
      const err = new DotfileAccessError('test');
      expect(err.code).toBe('FORBIDDEN');
      expect(err.statusCode).toBe(403);
      expect(err).toBeInstanceOf(VaultError);
    });
  });
});
