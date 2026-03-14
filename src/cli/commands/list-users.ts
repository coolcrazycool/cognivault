import * as path from 'node:path';
import type { Command } from 'commander';
import { UserRegistry } from '../../lib/user-registry.js';

interface ListUsersOptions {
  json: boolean;
  dataDir: string;
}

export async function handleListUsers(options: ListUsersOptions): Promise<void> {
  const { json, dataDir } = options;
  const usersFilePath = path.join(dataDir, 'users.json');

  const registry = new UserRegistry({ filePath: usersFilePath });
  await registry.load();

  const users = registry.getAllUsers();

  if (json) {
    const output = users.map((u) => ({
      userId: u.userId,
      vaultPath: u.vaultPath,
      syncStatus: 'unknown' as const,
    }));
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Table output
  const headers = { user: 'USER', vaultPath: 'VAULT_PATH', syncStatus: 'SYNC_STATUS' };

  // Calculate column widths
  const userWidth = Math.max(headers.user.length, ...users.map((u) => u.userId.length));
  const pathWidth = Math.max(headers.vaultPath.length, ...users.map((u) => u.vaultPath.length));
  const statusWidth = headers.syncStatus.length;

  const formatRow = (user: string, vaultPath: string, status: string): string =>
    `${user.padEnd(userWidth)}  ${vaultPath.padEnd(pathWidth)}  ${status.padEnd(statusWidth)}`;

  console.log(formatRow(headers.user, headers.vaultPath, headers.syncStatus));
  console.log(formatRow('-'.repeat(userWidth), '-'.repeat(pathWidth), '-'.repeat(statusWidth)));

  for (const u of users) {
    console.log(formatRow(u.userId, u.vaultPath, 'unknown'));
  }
}

export function registerListUsers(program: Command): void {
  program
    .command('list-users')
    .description('List all registered users')
    .option('--json', 'Output as JSON', false)
    .option('--data-dir <path>', 'Data directory', process.env.COGNIVAULT_DATA_DIR || './data')
    .action(async (opts: ListUsersOptions) => {
      try {
        await handleListUsers(opts);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
