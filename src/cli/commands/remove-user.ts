import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import type { Command } from 'commander';
import { UserRegistry } from '../../lib/user-registry.js';

interface RemoveUserOptions {
  force: boolean;
  dataDir: string;
}

export async function handleRemoveUser(name: string, options: RemoveUserOptions): Promise<void> {
  const { force, dataDir } = options;
  const usersFilePath = path.join(dataDir, 'users.json');

  const registry = new UserRegistry({ filePath: usersFilePath });
  await registry.load();

  const user = registry.getUserById(name);
  if (!user) {
    throw new Error(`User '${name}' not found in registry`);
  }

  if (!force) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await rl.question(`Are you sure you want to remove user '${name}'? [y/N] `);
      if (answer.toLowerCase() !== 'y') {
        console.log('Aborted.');
        return;
      }
    } finally {
      rl.close();
    }
  }

  await registry.removeUser(name);
  console.log(`User '${name}' removed successfully.`);
}

export function registerRemoveUser(program: Command): void {
  program
    .command('remove-user')
    .description('Remove a user from the registry')
    .argument('<name>', 'User identifier to remove')
    .option('--force', 'Skip confirmation prompt', false)
    .option('--data-dir <path>', 'Data directory', process.env.COGNIVAULT_DATA_DIR || './data')
    .action(async (name: string, opts: RemoveUserOptions) => {
      try {
        await handleRemoveUser(name, opts);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
