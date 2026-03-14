import { execFile as execFileCb } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { Command } from 'commander';
import { UserRegistry } from '../../lib/user-registry.js';

const execFileAsync = promisify(execFileCb);

interface AddUserOptions {
  obsidianEmail: string;
  obsidianPassword: string;
  vault: string;
  openaiKey: string;
  dataDir: string;
}

export async function handleAddUser(name: string, options: AddUserOptions): Promise<void> {
  const { obsidianEmail, obsidianPassword, vault, openaiKey, dataDir } = options;
  const vaultPath = path.join(dataDir, 'vaults', name);

  // Step 1: Run ob login
  await execFileAsync('ob', ['login', '--email', obsidianEmail, '--password', obsidianPassword]);

  // Step 2: Read auth token
  const configHome = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
  const tokenPath = path.join(configHome, 'obsidian-headless', 'auth_token');
  const token = await readFile(tokenPath, 'utf-8');

  // Step 3: Run ob sync-setup
  await execFileAsync('ob', ['sync-setup', '--vault', vault, '--path', vaultPath]);

  // Step 4: Build UserRecord and persist
  const apiKey = UserRegistry.generateApiKey();
  const record = {
    userId: name,
    apiKey,
    vaultPath,
    openaiKey,
    obsidian: {
      email: obsidianEmail,
      password: obsidianPassword,
      vault,
      token,
    },
  };

  const usersFilePath = path.join(dataDir, 'users.json');
  await mkdir(dataDir, { recursive: true });

  const registry = new UserRegistry({ filePath: usersFilePath });
  await registry.load();
  await registry.addUser(record);

  console.log(`User '${name}' added successfully.`);
  console.log(`  API Key: ${apiKey}`);
  console.log(`  Vault Path: ${vaultPath}`);
}

export function registerAddUser(program: Command): void {
  program
    .command('add-user')
    .description('Add a new user with Obsidian sync setup')
    .argument('<name>', 'User identifier (lowercase alphanumeric with hyphens)')
    .requiredOption('--obsidian-email <email>', 'Obsidian account email')
    .requiredOption('--obsidian-password <password>', 'Obsidian account password')
    .requiredOption('--vault <vault>', 'Obsidian vault name')
    .requiredOption('--openai-key <key>', 'OpenAI API key')
    .option('--data-dir <path>', 'Data directory', process.env.COGNIVAULT_DATA_DIR || './data')
    .action(async (name: string, opts: AddUserOptions) => {
      try {
        await handleAddUser(name, opts);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
