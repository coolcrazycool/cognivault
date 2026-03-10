import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import matter from 'gray-matter';

// ── Error classes ──

export class VaultError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class PathTraversalError extends VaultError {
  constructor(message: string) {
    super(message, 'PATH_TRAVERSAL', 403);
    this.name = 'PathTraversalError';
  }
}

export class FileNotFoundError extends VaultError {
  constructor(filePath: string) {
    super(`File not found: ${filePath}`, 'NOT_FOUND', 404);
    this.name = 'FileNotFoundError';
  }
}

export class DotfileAccessError extends VaultError {
  constructor(filePath: string) {
    super(`Access denied: dotfile or dotfolder path: ${filePath}`, 'FORBIDDEN', 403);
    this.name = 'DotfileAccessError';
  }
}

export class UnsupportedMediaTypeError extends VaultError {
  constructor(filePath: string) {
    super(`Unsupported media type: ${filePath}`, 'UNSUPPORTED_MEDIA_TYPE', 415);
    this.name = 'UnsupportedMediaTypeError';
  }
}

// ── Interfaces ──

export interface VaultEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

export interface ListOptions {
  path?: string;
  recursive?: boolean;
  ext?: string;
}

export interface ContentResult {
  path: string;
  content: string;
}

export interface MetadataResult {
  path: string;
  metadata: Record<string, unknown>;
  warning?: string;
}

// ── VaultManager ──

export class VaultManager {
  private readonly rootPath: string;
  private realRootPath: string;

  constructor(rootPath: string) {
    this.rootPath = path.resolve(rootPath);
    this.realRootPath = this.rootPath;
  }

  async initialize(): Promise<void> {
    let stat: Awaited<ReturnType<typeof fs.stat>> | undefined;
    try {
      stat = await fs.stat(this.rootPath);
    } catch {
      throw new VaultError(`Vault path does not exist: ${this.rootPath}`, 'VAULT_INIT_ERROR', 500);
    }

    if (!stat.isDirectory()) {
      throw new VaultError(
        `Vault path is not a directory: ${this.rootPath}`,
        'VAULT_INIT_ERROR',
        500,
      );
    }

    // Resolve the real path for symlink-safe comparisons (e.g., macOS /var -> /private/var)
    this.realRootPath = await fs.realpath(this.rootPath);
  }

  async resolvePath(relativePath: string): Promise<string> {
    // Normalize: collapse double slashes, strip leading/trailing slashes
    const normalized = relativePath.replace(/\/+/g, '/').replace(/^\//, '').replace(/\/$/, '');

    // Empty path resolves to vault root
    if (normalized === '') {
      return this.rootPath;
    }

    // Check each segment for traversal and dotfiles/dotfolders
    const segments = normalized.split('/');
    for (const segment of segments) {
      // Traversal check first: '..' segments
      if (segment === '.' || segment === '..') {
        throw new PathTraversalError(`Path traversal detected: ${relativePath}`);
      }
      // Then dotfile/dotfolder check
      if (segment.startsWith('.')) {
        throw new DotfileAccessError(relativePath);
      }
    }

    // Resolve absolute path
    const resolved = path.resolve(this.rootPath, normalized);

    // Check traversal: resolved must start with rootPath + sep, or equal rootPath
    if (resolved !== this.rootPath && !resolved.startsWith(this.rootPath + path.sep)) {
      throw new PathTraversalError(`Path traversal detected: ${relativePath}`);
    }

    // Check if path exists
    let lstatResult: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
      lstatResult = await fs.lstat(resolved);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileNotFoundError(relativePath);
      }
      throw err;
    }

    // Reject symlinks
    if (lstatResult.isSymbolicLink()) {
      throw new PathTraversalError(`Symlink detected: ${relativePath}`);
    }

    // For existing paths, verify realpath stays within vault
    const realResolved = await fs.realpath(resolved);
    if (
      realResolved !== this.realRootPath &&
      !realResolved.startsWith(this.realRootPath + path.sep)
    ) {
      throw new PathTraversalError(`Path resolves outside vault: ${relativePath}`);
    }

    return resolved;
  }

  private static readonly TEXT_EXTENSIONS = new Set([
    '.md',
    '.markdown',
    '.txt',
    '.json',
    '.yaml',
    '.yml',
    '.css',
    '.js',
    '.ts',
    '.html',
    '.xml',
    '.csv',
    '.svg',
    '.canvas',
    '.excalidraw',
  ]);

  private static hasDotSegment(relativePath: string): boolean {
    return relativePath.split('/').some((segment) => segment.startsWith('.'));
  }

  async listFiles(options?: ListOptions): Promise<{ entries: VaultEntry[] }> {
    const targetPath = await this.resolvePath(options?.path ?? '');

    // Verify it's a directory
    const stat = await fs.stat(targetPath);
    if (!stat.isDirectory()) {
      throw new FileNotFoundError(options?.path ?? '');
    }

    const dirEntries = await fs.readdir(targetPath, {
      withFileTypes: true,
      recursive: options?.recursive ?? false,
    });

    // Normalize extension filter
    let extFilter: string | undefined;
    if (options?.ext) {
      extFilter = options.ext.startsWith('.') ? options.ext : `.${options.ext}`;
    }

    const entries: VaultEntry[] = [];

    for (const entry of dirEntries) {
      // Skip symlinks
      if (entry.isSymbolicLink()) {
        continue;
      }

      // Derive vault-relative path
      const parentDir = entry.parentPath ?? targetPath;
      const absolutePath = path.join(parentDir, entry.name);
      const relativePath = path.relative(this.rootPath, absolutePath);

      // Skip dotfiles/dotfolders
      if (VaultManager.hasDotSegment(relativePath)) {
        continue;
      }

      // Apply extension filter (only to files)
      if (extFilter && entry.isFile()) {
        if (path.extname(entry.name) !== extFilter) {
          continue;
        }
      }

      // Skip directories when ext filter is active
      if (extFilter && entry.isDirectory()) {
        continue;
      }

      entries.push({
        name: entry.name,
        path: relativePath,
        type: entry.isDirectory() ? 'directory' : 'file',
      });
    }

    // Sort alphabetically by path (lexicographic for consistency)
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    return { entries };
  }

  async readContent(filePath: string): Promise<ContentResult> {
    const resolved = await this.resolvePath(filePath);

    // Check if text file by extension allowlist
    const ext = path.extname(resolved).toLowerCase();
    if (!VaultManager.TEXT_EXTENSIONS.has(ext)) {
      throw new UnsupportedMediaTypeError(filePath);
    }

    const raw = await fs.readFile(resolved, 'utf-8');

    // For non-markdown files, return raw content
    if (ext !== '.md' && ext !== '.markdown') {
      return { path: filePath, content: raw.trim() };
    }

    // Parse frontmatter for markdown files
    try {
      const parsed = matter(raw);
      return { path: filePath, content: parsed.content.trim() };
    } catch {
      // If gray-matter fails, return raw content
      return { path: filePath, content: raw.trim() };
    }
  }

  // Stub -- implementation in Plan 03
  async readMetadata(_filePath: string): Promise<MetadataResult> {
    throw new Error('Not implemented');
  }
}
