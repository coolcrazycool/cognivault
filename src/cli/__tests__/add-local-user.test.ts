import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

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

import { stat } from 'node:fs/promises';
import { handleAddLocalUser } from '../commands/add-local-user.js';

describe('add-local-user command', () => {
  const mockStat = vi.mocked(stat);

  const baseOptions = {
    vaultPath: '/data/my-folder',
    openaiKey: 'sk-test-key',
    dataDir: '/tmp/test-data',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAddUser.mockResolvedValue(undefined);
    mockLoad.mockResolvedValue(undefined);
    // Default: vault path is an existing directory
    mockStat.mockResolvedValue({ isDirectory: () => true } as Awaited<ReturnType<typeof stat>>);
  });

  it('registers a user with no obsidian field and a resolved vaultPath', async () => {
    await handleAddLocalUser('alice', baseOptions);

    expect(mockAddUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'alice',
        apiKey: 'cv-test-api-key-123',
        vaultPath: '/data/my-folder',
        openaiKey: 'sk-test-key',
      }),
    );
    const record = mockAddUser.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(record).not.toHaveProperty('obsidian');
  });

  it('omits openaiKey when not provided (e.g. gigachat provider)', async () => {
    await handleAddLocalUser('bob', { vaultPath: '/data/f', dataDir: '/tmp/d' });

    const record = mockAddUser.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(record).not.toHaveProperty('openaiKey');
    expect(record).not.toHaveProperty('obsidian');
  });

  it('throws and does not register when the folder does not exist', async () => {
    mockStat.mockRejectedValue(new Error('ENOENT'));

    await expect(handleAddLocalUser('alice', baseOptions)).rejects.toThrow(
      /not an existing directory/,
    );
    expect(mockAddUser).not.toHaveBeenCalled();
  });

  it('throws when the vault path is a file, not a directory', async () => {
    mockStat.mockResolvedValue({ isDirectory: () => false } as Awaited<ReturnType<typeof stat>>);

    await expect(handleAddLocalUser('alice', baseOptions)).rejects.toThrow(
      /not an existing directory/,
    );
    expect(mockAddUser).not.toHaveBeenCalled();
  });
});
