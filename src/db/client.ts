import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

function getMigrationsFolder(): string {
  // Resolve drizzle/ folder relative to the project root
  // __filename approach for ESM compatibility
  const __filename = fileURLToPath(import.meta.url);
  // src/db/client.ts -> go up 3 levels to project root
  const projectRoot = resolve(__filename, '..', '..', '..');
  return resolve(projectRoot, 'drizzle');
}

export function createDatabase(dbPath: string): {
  db: ReturnType<typeof drizzle<typeof schema>>;
  sqlite: InstanceType<typeof Database>;
} {
  const sqlite = new Database(dbPath);

  // Enable WAL mode BEFORE drizzle init (critical for performance and safety)
  sqlite.pragma('journal_mode = WAL');

  const db = drizzle({ client: sqlite, schema });

  const migrationsFolder = getMigrationsFolder();
  migrate(db, { migrationsFolder });

  return { db, sqlite };
}
