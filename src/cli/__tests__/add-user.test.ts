import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process before importing the module under test
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Mock fs/promises for token reading
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Mock the UserRegistry class
const mockAddUser = vi.fn().mockResolvedValue(undefined);
const mockLoad = vi.fn().mockResolvedValue(undefined);

vi.mock('../../lib/user-registry.js', () => {
  const MockUserRegistry = vi.fn(function (this: Record<string, unknown>) {
    this.load = mockLoad;
    this.addUser = mockAddUser;
  }) as unknown as { generateApiKey: () => string };
  MockUserRegistry.generateApiKey = vi.fn().mockReturnValue('cv-test-api-key-123');
  return { UserRegistry: MockUserRegistry };
});

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { handleAddUser } from '../commands/add-user.js';

describe('add-user command', () => {
  const mockExecFile = vi.mocked(execFile);
  const mockReadFile = vi.mocked(readFile);

  const baseOptions = {
    obsidianEmail: 'user@example.com',
    obsidianPassword: 'secret123',
    vault: 'my-vault',
    openaiKey: 'sk-test-key',
    dataDir: '/tmp/test-data',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAddUser.mockResolvedValue(undefined);
    mockLoad.mockResolvedValue(undefined);

    // Default: execFile succeeds (promisified returns { stdout, stderr })
    mockExecFile.mockImplementation((_cmd: unknown, _args: unknown, cb: unknown) => {
      if (typeof cb === 'function') {
        (cb as (err: Error | null, stdout: string, stderr: string) => void)(null, '', '');
      }
      return undefined as never;
    });

    // Default: token file exists
    mockReadFile.mockResolvedValue('test-auth-token-xyz');
  });

  it('calls execFile with ob login then ob sync-setup', async () => {
    await handleAddUser('testuser', baseOptions);

    // First call: ob login
    expect(mockExecFile).toHaveBeenCalledWith(
      'ob',
      expect.arrayContaining(['login']),
      expect.any(Function),
    );

    // Second call: ob sync-setup
    expect(mockExecFile).toHaveBeenCalledWith(
      'ob',
      expect.arrayContaining(['sync-setup']),
      expect.any(Function),
    );

    // Login must come before sync-setup
    const calls = mockExecFile.mock.calls;
    const loginIdx = calls.findIndex(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('login'),
    );
    const syncIdx = calls.findIndex(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('sync-setup'),
    );
    expect(loginIdx).toBeLessThan(syncIdx);
  });

  it('reads auth token after successful ob login and stores in registry', async () => {
    mockReadFile.mockResolvedValue('my-auth-token');

    await handleAddUser('testuser', baseOptions);

    // Token file should be read
    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringContaining('obsidian-headless/auth_token'),
      'utf-8',
    );

    // UserRegistry.addUser should have been called with token
    expect(mockAddUser).toHaveBeenCalledWith(
      expect.objectContaining({
        obsidian: expect.objectContaining({
          token: 'my-auth-token',
        }),
      }),
    );
  });

  it('calls UserRegistry.addUser with correct UserRecord shape including generated apiKey', async () => {
    await handleAddUser('testuser', baseOptions);

    expect(mockAddUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'testuser',
        apiKey: 'cv-test-api-key-123',
        vaultPath: '/tmp/test-data/vaults/testuser',
        openaiKey: 'sk-test-key',
        obsidian: expect.objectContaining({
          email: 'user@example.com',
          password: 'secret123',
          vault: 'my-vault',
        }),
      }),
    );
  });

  it('does not call addUser and throws if ob login fails', async () => {
    mockExecFile.mockImplementation((_cmd: unknown, _args: unknown, cb: unknown) => {
      if (typeof cb === 'function') {
        (cb as (err: Error | null) => void)(new Error('ob login failed'));
      }
      return undefined as never;
    });

    await expect(handleAddUser('testuser', baseOptions)).rejects.toThrow('ob login failed');

    // Ensure addUser was not called
    expect(mockAddUser).not.toHaveBeenCalled();
  });

  it('passes --obsidian-email and --obsidian-password to ob login command', async () => {
    await handleAddUser('testuser', baseOptions);

    expect(mockExecFile).toHaveBeenCalledWith(
      'ob',
      ['login', '--email', 'user@example.com', '--password', 'secret123'],
      expect.any(Function),
    );
  });

  it('runs ob sync-setup with --vault and --path flags after successful login', async () => {
    await handleAddUser('testuser', baseOptions);

    expect(mockExecFile).toHaveBeenCalledWith(
      'ob',
      ['sync-setup', '--vault', 'my-vault', '--path', '/tmp/test-data/vaults/testuser'],
      expect.any(Function),
    );
  });
});
