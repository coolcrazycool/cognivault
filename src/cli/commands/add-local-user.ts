import { mkdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { Command } from 'commander';
import { UserRegistry } from '../../lib/user-registry.js';

interface AddLocalUserOptions {
  vaultPath: string;
  openaiKey?: string;
  dataDir: string;
}

export async function handleAddLocalUser(
  name: string,
  options: AddLocalUserOptions,
): Promise<void> {
  const { vaultPath, openaiKey, dataDir } = options;
  const resolvedVaultPath = path.resolve(vaultPath);

  // The folder must exist — the user edits files in it directly (no Obsidian sync).
  const stats = await stat(resolvedVaultPath).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error(`Vault path is not an existing directory: ${resolvedVaultPath}`);
  }

  const apiKey = UserRegistry.generateApiKey();
  const record = {
    userId: name,
    apiKey,
    vaultPath: resolvedVaultPath,
    ...(openaiKey ? { openaiKey } : {}),
    // No `obsidian` field → no sync process; the indexer watches the folder directly.
  };

  const usersFilePath = path.join(dataDir, 'users.json');
  await mkdir(dataDir, { recursive: true });

  const registry = new UserRegistry({ filePath: usersFilePath });
  await registry.load();
  await registry.addUser(record);

  console.log(`Local-folder user '${name}' added successfully.`);
  console.log(`  API Key: ${apiKey}`);
  console.log(`  Vault Path: ${resolvedVaultPath}`);
}

export function registerAddLocalUser(program: Command): void {
  program
    .command('add-local-user')
    .description('Add a user that indexes a local folder directly (no Obsidian sync)')
    .argument('<name>', 'User identifier (lowercase alphanumeric with hyphens)')
    .requiredOption('--vault-path <path>', 'Absolute path to the folder to index')
    .option('--openai-key <key>', 'OpenAI API key (only needed for the OpenAI embedding provider)')
    .option('--data-dir <path>', 'Data directory', process.env.COGNIVAULT_DATA_DIR || './data')
    .action(async (name: string, opts: AddLocalUserOptions) => {
      try {
        await handleAddLocalUser(name, opts);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
