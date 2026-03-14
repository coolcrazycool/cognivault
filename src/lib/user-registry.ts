import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { watch as fsWatch } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

// ── Zod Schemas ──

const obsidianSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  vault: z.string().min(1),
  token: z.string().optional(),
});

export const userRecordSchema = z.object({
  userId: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'userId must be lowercase alphanumeric with hyphens'),
  apiKey: z.string().regex(/^cv-/, 'apiKey must start with cv-'),
  vaultPath: z.string().min(1),
  openaiKey: z.string().min(1),
  obsidian: obsidianSchema,
});

const usersFileSchema = z.array(userRecordSchema);

export type UserRecord = z.infer<typeof userRecordSchema>;

// ── Event types ──

interface RegistryEvents {
  'user-added': [user: UserRecord];
  'user-removed': [user: UserRecord];
  'user-updated': [user: UserRecord, previous: UserRecord];
}

// ── Options ──

interface UserRegistryOptions {
  filePath: string;
  logger?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  onReload?: (status: 'success' | 'rejected') => void;
  onUserCountChange?: (count: number) => void;
}

// ── Helpers ──

function deepFreeze(record: UserRecord): UserRecord {
  Object.freeze(record.obsidian);
  return Object.freeze(record);
}

function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ── UserRegistry ──

export class UserRegistry extends EventEmitter<RegistryEvents> {
  private readonly byApiKey = new Map<string, UserRecord>();
  private readonly byUserId = new Map<string, UserRecord>();
  private readonly filePath: string;
  private readonly logger?: UserRegistryOptions['logger'];
  private readonly onReloadCb?: (status: 'success' | 'rejected') => void;
  private readonly onUserCountChangeCb?: (count: number) => void;

  private lastContentHash = '';
  private watcher: ReturnType<typeof import('node:fs').watch> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: UserRegistryOptions) {
    super();
    this.filePath = opts.filePath;
    this.logger = opts.logger;
    this.onReloadCb = opts.onReload;
    this.onUserCountChangeCb = opts.onUserCountChange;
  }

  // ── Load ──

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Create empty file
        await this.atomicWrite([]);
        raw = '[]';
      } else {
        throw err;
      }
    }

    const parsed = JSON.parse(raw) as unknown;
    const users = usersFileSchema.parse(parsed);
    this.validateUniqueness(users);
    this.populateMaps(users);
    this.lastContentHash = computeHash(raw);
  }

  // ── Lookup ──

  getUserByApiKey(key: string): UserRecord | undefined {
    const user = this.byApiKey.get(key);
    return user ? deepFreeze({ ...user, obsidian: { ...user.obsidian } }) : undefined;
  }

  getUserById(userId: string): UserRecord | undefined {
    const user = this.byUserId.get(userId);
    return user ? deepFreeze({ ...user, obsidian: { ...user.obsidian } }) : undefined;
  }

  getAllUsers(): UserRecord[] {
    return Array.from(this.byUserId.values()).map((u) =>
      deepFreeze({ ...u, obsidian: { ...u.obsidian } }),
    );
  }

  getUserCount(): number {
    return this.byUserId.size;
  }

  // ── Write Methods ──

  async addUser(record: UserRecord): Promise<void> {
    const validated = userRecordSchema.parse(record);

    if (this.byUserId.has(validated.userId)) {
      throw new Error(`Duplicate userId: ${validated.userId}`);
    }
    if (this.byApiKey.has(validated.apiKey)) {
      throw new Error(`Duplicate apiKey: ${validated.apiKey}`);
    }

    this.byUserId.set(validated.userId, validated);
    this.byApiKey.set(validated.apiKey, validated);

    await this.atomicWrite(Array.from(this.byUserId.values()));
    this.onUserCountChangeCb?.(this.getUserCount());
  }

  async removeUser(userId: string): Promise<void> {
    const user = this.byUserId.get(userId);
    if (!user) return;

    this.byUserId.delete(userId);
    this.byApiKey.delete(user.apiKey);

    await this.atomicWrite(Array.from(this.byUserId.values()));
    this.onUserCountChangeCb?.(this.getUserCount());
  }

  // ── Hot-Reload ──

  startWatching(): void {
    const dir = path.dirname(this.filePath);
    const base = path.basename(this.filePath);

    this.watcher = fsWatch(dir, (_eventType, filename) => {
      if (filename !== base) return;

      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        void this.handleFileChange();
      }, 500);
    });
  }

  stopWatching(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  // ── Static ──

  static generateApiKey(): string {
    return `cv-${crypto.randomBytes(24).toString('base64url')}`;
  }

  // ── Private ──

  private validateUniqueness(users: UserRecord[]): void {
    const userIds = new Set<string>();
    const apiKeys = new Set<string>();

    for (const user of users) {
      if (userIds.has(user.userId)) {
        throw new Error(`Duplicate userId: ${user.userId}`);
      }
      if (apiKeys.has(user.apiKey)) {
        throw new Error(`Duplicate apiKey: ${user.apiKey}`);
      }
      userIds.add(user.userId);
      apiKeys.add(user.apiKey);
    }
  }

  private populateMaps(users: UserRecord[]): void {
    this.byApiKey.clear();
    this.byUserId.clear();
    for (const user of users) {
      this.byUserId.set(user.userId, user);
      this.byApiKey.set(user.apiKey, user);
    }
  }

  private async atomicWrite(users: UserRecord[]): Promise<void> {
    const content = JSON.stringify(users, null, 2);
    const tmpPath = `${this.filePath}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, this.filePath);
    this.lastContentHash = computeHash(content);
  }

  private async handleFileChange(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File deleted — keep current data
        this.logger?.warn('users.json deleted, keeping last valid data');
        return;
      }
      throw err;
    }

    const hash = computeHash(raw);
    if (hash === this.lastContentHash) {
      // Content unchanged — skip
      return;
    }

    let users: UserRecord[];
    try {
      const parsed = JSON.parse(raw) as unknown;
      users = usersFileSchema.parse(parsed);
      this.validateUniqueness(users);
    } catch {
      this.logger?.warn('Invalid users.json on reload, keeping last valid data');
      this.onReloadCb?.('rejected');
      return;
    }

    // Build old maps for diffing
    const oldByUserId = new Map(this.byUserId);

    // Update maps
    this.populateMaps(users);
    this.lastContentHash = hash;

    // Diff and emit events
    this.diffUsers(oldByUserId, this.byUserId);

    this.onReloadCb?.('success');
    this.onUserCountChangeCb?.(this.getUserCount());
  }

  private diffUsers(oldMap: Map<string, UserRecord>, newMap: Map<string, UserRecord>): void {
    // Find added and updated
    for (const [userId, newUser] of newMap) {
      const oldUser = oldMap.get(userId);
      if (!oldUser) {
        this.emit('user-added', deepFreeze({ ...newUser, obsidian: { ...newUser.obsidian } }));
      } else if (JSON.stringify(oldUser) !== JSON.stringify(newUser)) {
        this.emit(
          'user-updated',
          deepFreeze({ ...newUser, obsidian: { ...newUser.obsidian } }),
          deepFreeze({ ...oldUser, obsidian: { ...oldUser.obsidian } }),
        );
      }
    }

    // Find removed
    for (const [userId, oldUser] of oldMap) {
      if (!newMap.has(userId)) {
        this.emit('user-removed', deepFreeze({ ...oldUser, obsidian: { ...oldUser.obsidian } }));
      }
    }
  }
}
