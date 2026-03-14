import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Mock UserRegistry
const mockGetAllUsers = vi.fn();
const mockLoad = vi.fn().mockResolvedValue(undefined);

vi.mock('../../lib/user-registry.js', () => {
  const MockUserRegistry = vi.fn(function (this: Record<string, unknown>) {
    this.load = mockLoad;
    this.getAllUsers = mockGetAllUsers;
  });
  return { UserRegistry: MockUserRegistry };
});

import { handleListUsers } from '../commands/list-users.js';

describe('list-users command', () => {
  const baseOptions = {
    json: false,
    dataDir: '/tmp/test-data',
  };

  const sampleUsers = [
    {
      userId: 'alice',
      apiKey: 'cv-alice-key',
      vaultPath: '/data/vaults/alice',
      openaiKey: 'sk-alice',
      obsidian: { email: 'alice@example.com', password: 'pass', vault: 'v1' },
    },
    {
      userId: 'bob',
      apiKey: 'cv-bob-key',
      vaultPath: '/data/vaults/bob',
      openaiKey: 'sk-bob',
      obsidian: { email: 'bob@example.com', password: 'pass', vault: 'v2' },
    },
  ];

  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoad.mockResolvedValue(undefined);
    mockGetAllUsers.mockReturnValue(sampleUsers);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('outputs table with USER, VAULT_PATH, SYNC_STATUS columns', async () => {
    await handleListUsers(baseOptions);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('USER');
    expect(output).toContain('VAULT_PATH');
    expect(output).toContain('SYNC_STATUS');
    expect(output).toContain('alice');
    expect(output).toContain('bob');
    expect(output).toContain('/data/vaults/alice');
  });

  it('--json outputs JSON array of user records', async () => {
    await handleListUsers({ ...baseOptions, json: true });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as unknown[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(
      expect.objectContaining({
        userId: 'alice',
        vaultPath: '/data/vaults/alice',
        syncStatus: 'unknown',
      }),
    );
  });

  it('with no users shows empty table (header only)', async () => {
    mockGetAllUsers.mockReturnValue([]);

    await handleListUsers(baseOptions);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('USER');
    expect(output).not.toContain('alice');
  });

  it('SYNC_STATUS shows unknown (CLI has no server access)', async () => {
    await handleListUsers({ ...baseOptions, json: true });

    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Array<{
      syncStatus: string;
    }>;
    for (const user of parsed) {
      expect(user.syncStatus).toBe('unknown');
    }
  });
});
