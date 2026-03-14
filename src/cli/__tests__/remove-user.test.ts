import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Mock readline/promises
const mockQuestion = vi.fn();
const mockClose = vi.fn();
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: mockQuestion,
    close: mockClose,
  })),
}));

// Mock UserRegistry
const mockRemoveUser = vi.fn().mockResolvedValue(undefined);
const mockLoad = vi.fn().mockResolvedValue(undefined);
const mockGetUserById = vi.fn();

vi.mock('../../lib/user-registry.js', () => {
  const MockUserRegistry = vi.fn(function (this: Record<string, unknown>) {
    this.load = mockLoad;
    this.removeUser = mockRemoveUser;
    this.getUserById = mockGetUserById;
  });
  return { UserRegistry: MockUserRegistry };
});

import { handleRemoveUser } from '../commands/remove-user.js';

describe('remove-user command', () => {
  const baseOptions = {
    force: false,
    dataDir: '/tmp/test-data',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoad.mockResolvedValue(undefined);
    mockRemoveUser.mockResolvedValue(undefined);
    mockGetUserById.mockReturnValue({
      userId: 'testuser',
      apiKey: 'cv-key',
      vaultPath: '/tmp/test-data/vaults/testuser',
      openaiKey: 'sk-test',
      obsidian: { email: 'a@b.com', password: 'pass', vault: 'v' },
    });
  });

  it('prompts for confirmation and removes user on y answer', async () => {
    mockQuestion.mockResolvedValue('y');

    await handleRemoveUser('testuser', baseOptions);

    expect(mockQuestion).toHaveBeenCalledWith(expect.stringContaining("remove user 'testuser'"));
    expect(mockRemoveUser).toHaveBeenCalledWith('testuser');
    expect(mockClose).toHaveBeenCalled();
  });

  it('with --force skips confirmation and removes immediately', async () => {
    await handleRemoveUser('testuser', { ...baseOptions, force: true });

    expect(mockQuestion).not.toHaveBeenCalled();
    expect(mockRemoveUser).toHaveBeenCalledWith('testuser');
  });

  it('throws if user not found in registry', async () => {
    mockGetUserById.mockReturnValue(undefined);

    await expect(handleRemoveUser('nonexistent', baseOptions)).rejects.toThrow(/not found/i);
    expect(mockRemoveUser).not.toHaveBeenCalled();
  });

  it('aborts (no removal) if user answers N to confirmation', async () => {
    mockQuestion.mockResolvedValue('N');

    await handleRemoveUser('testuser', baseOptions);

    expect(mockRemoveUser).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalled();
  });
});
