import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DotfileAccessError,
  FileNotFoundError,
  PathTraversalError,
  UnsupportedMediaTypeError,
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
    await fs.mkdir(path.join(vaultRoot, 'notes', 'daily'), { recursive: true });
    await fs.mkdir(path.join(vaultRoot, 'Projects', 'CogniVault'), { recursive: true });
    await fs.mkdir(path.join(vaultRoot, 'My Notes'), { recursive: true });
    await fs.mkdir(path.join(vaultRoot, 'Заметки'), { recursive: true });
    await fs.mkdir(path.join(vaultRoot, '.obsidian'), { recursive: true });
    await fs.mkdir(path.join(vaultRoot, 'folder', '.hidden'), { recursive: true });
    await fs.mkdir(path.join(vaultRoot, 'empty-dir'), { recursive: true });

    // Create root-level files
    await fs.writeFile(path.join(vaultRoot, 'README.md'), '# Vault Readme');
    await fs.writeFile(path.join(vaultRoot, 'config.json'), '{"key": "value"}');

    // Create files in subdirectories
    await fs.writeFile(path.join(vaultRoot, 'notes', 'test.md'), '# Test');
    await fs.writeFile(
      path.join(vaultRoot, 'notes', 'with-frontmatter.md'),
      '---\ntitle: Hello\ntags: [a, b]\n---\n\n# Hello World\n\nBody content here.',
    );
    await fs.writeFile(
      path.join(vaultRoot, 'notes', 'no-frontmatter.md'),
      '# Just Markdown\n\nNo frontmatter here.',
    );
    await fs.writeFile(path.join(vaultRoot, 'notes', 'daily', 'monday.md'), '# Monday');
    await fs.writeFile(path.join(vaultRoot, 'notes', 'daily', 'tuesday.txt'), 'Tuesday notes');
    await fs.writeFile(path.join(vaultRoot, 'My Notes', 'todo.md'), '# Todo');
    await fs.writeFile(
      path.join(vaultRoot, 'Заметки', 'проект.md'),
      '---\ntitle: Проект\n---\n\nСодержимое на русском языке.',
    );
    await fs.writeFile(path.join(vaultRoot, '.obsidian', 'workspace.json'), '{}');
    await fs.writeFile(path.join(vaultRoot, 'folder', '.hidden', 'file.md'), '# Hidden');

    // Create a binary file (fake PNG header)
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fs.writeFile(path.join(vaultRoot, 'notes', 'image.png'), pngHeader);

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

  describe('listFiles()', () => {
    it('returns entries at vault root', async () => {
      const result = await manager.listFiles({});
      expect(result.entries.length).toBeGreaterThan(0);
      // Should contain both files and directories at root
      const names = result.entries.map((e) => e.name);
      expect(names).toContain('README.md');
      expect(names).toContain('notes');
      expect(names).toContain('Projects');
    });

    it('returns entries in a subfolder', async () => {
      const result = await manager.listFiles({ path: 'notes' });
      const names = result.entries.map((e) => e.name);
      expect(names).toContain('test.md');
      expect(names).toContain('with-frontmatter.md');
      expect(names).toContain('daily');
    });

    it('returns entries from all nested subdirectories with recursive=true', async () => {
      const result = await manager.listFiles({ recursive: true });
      const paths = result.entries.map((e) => e.path);
      expect(paths).toContain('notes/test.md');
      expect(paths).toContain('notes/daily/monday.md');
      expect(paths).toContain('Projects/CogniVault');
    });

    it('filters by extension', async () => {
      const result = await manager.listFiles({ ext: 'md', recursive: true });
      for (const entry of result.entries) {
        if (entry.type === 'file') {
          expect(entry.name).toMatch(/\.md$/);
        }
      }
      const paths = result.entries.map((e) => e.path);
      expect(paths).toContain('notes/test.md');
      expect(paths).not.toContain('notes/daily/tuesday.txt');
    });

    it('combines recursive and ext filters', async () => {
      const result = await manager.listFiles({ ext: 'txt', recursive: true });
      const filePaths = result.entries.filter((e) => e.type === 'file').map((e) => e.path);
      expect(filePaths).toContain('notes/daily/tuesday.txt');
      // Should not include .md files
      for (const p of filePaths) {
        expect(p).toMatch(/\.txt$/);
      }
    });

    it('excludes dotfiles and dotfolders from results', async () => {
      const result = await manager.listFiles({ recursive: true });
      for (const entry of result.entries) {
        const segments = entry.path.split('/');
        for (const segment of segments) {
          expect(segment.startsWith('.')).toBe(false);
        }
      }
    });

    it('excludes symlinks from results', async () => {
      const result = await manager.listFiles({});
      const names = result.entries.map((e) => e.name);
      expect(names).not.toContain('escape-link');
    });

    it('throws FileNotFoundError for nonexistent directory', async () => {
      await expect(manager.listFiles({ path: 'nonexistent-dir' })).rejects.toThrow(
        FileNotFoundError,
      );
    });

    it('returns sorted entries by path', async () => {
      const result = await manager.listFiles({ recursive: true });
      const paths = result.entries.map((e) => e.path);
      const sorted = [...paths].sort();
      expect(paths).toEqual(sorted);
    });

    it('returns empty entries for an empty directory', async () => {
      const result = await manager.listFiles({ path: 'empty-dir' });
      expect(result.entries).toEqual([]);
    });
  });

  describe('readContent()', () => {
    it('returns markdown body with frontmatter stripped', async () => {
      const result = await manager.readContent('notes/with-frontmatter.md');
      expect(result.path).toBe('notes/with-frontmatter.md');
      expect(result.content).toBe('# Hello World\n\nBody content here.');
      expect(result.content).not.toContain('---');
      expect(result.content).not.toContain('title:');
    });

    it('returns full content for file without frontmatter', async () => {
      const result = await manager.readContent('notes/no-frontmatter.md');
      expect(result.path).toBe('notes/no-frontmatter.md');
      expect(result.content).toBe('# Just Markdown\n\nNo frontmatter here.');
    });

    it('throws UnsupportedMediaTypeError for binary files', async () => {
      await expect(manager.readContent('notes/image.png')).rejects.toThrow(
        UnsupportedMediaTypeError,
      );
    });

    it('throws FileNotFoundError for nonexistent files', async () => {
      await expect(manager.readContent('nonexistent.md')).rejects.toThrow(FileNotFoundError);
    });

    it('returns UTF-8 Cyrillic content correctly', async () => {
      const result = await manager.readContent('Заметки/проект.md');
      expect(result.path).toBe('Заметки/проект.md');
      expect(result.content).toBe('Содержимое на русском языке.');
    });

    it('returns raw content for JSON files without stripping', async () => {
      const result = await manager.readContent('config.json');
      expect(result.path).toBe('config.json');
      expect(result.content).toBe('{"key": "value"}');
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
