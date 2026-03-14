import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock OpenAI to avoid real API calls
vi.mock('openai', () => {
  const mockEmbeddingsCreate = vi.fn().mockResolvedValue({
    data: [{ index: 0, embedding: new Array(1536).fill(0.1) }],
  });
  class MockOpenAI {
    embeddings = { create: mockEmbeddingsCreate };
  }
  return { default: MockOpenAI };
});

// Mock config
vi.mock('../../config.js', () => ({
  config: {
    OPENAI_BASE_URL: undefined,
    EMBEDDING_MODEL: 'text-embedding-3-small',
  },
}));

interface UserRecord {
  userId: string;
  apiKey: string;
  vaultPath: string;
  openaiKey: string;
  obsidian: { email: string; password: string; vault: string };
}

interface RegistryEvents {
  'user-added': [user: UserRecord];
  'user-removed': [user: UserRecord];
  'user-updated': [user: UserRecord, previous: UserRecord];
}

function makeUser(userId: string, openaiKey?: string): UserRecord {
  return {
    userId,
    apiKey: `cv-${userId}`,
    vaultPath: '/tmp/v',
    openaiKey: openaiKey ?? `sk-${userId}`,
    obsidian: { email: `${userId}@test.com`, password: 'p', vault: 'v' },
  };
}

describe('embedding plugin (per-user)', () => {
  let registry: EventEmitter<RegistryEvents> & { getAllUsers: () => UserRecord[] };

  beforeEach(() => {
    registry = Object.assign(new EventEmitter<RegistryEvents>(), {
      getAllUsers: () => [] as UserRecord[],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function buildTestFastify(users?: UserRecord[]) {
    if (users) {
      registry.getAllUsers = () => users;
    }

    const { default: Fastify } = await import('fastify');
    const { default: fp } = await import('fastify-plugin');

    const app = Fastify({ logger: false });

    // Register registry dependency
    await app.register(
      fp(
        async (f) => {
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          f.decorate('registry', registry as any);
        },
        { name: 'registry' },
      ),
    );

    const { default: embeddingPlugin } = await import('../embedding.js');
    await app.register(embeddingPlugin);
    await app.ready();

    return app;
  }

  it('getUserEmbedder returns EmbeddingProvider for existing user', async () => {
    const app = await buildTestFastify([makeUser('alice')]);

    const embedder = app.getUserEmbedder('alice');
    expect(embedder).toBeDefined();
    expect(typeof embedder.embed).toBe('function');
    expect(embedder.dimensions).toBe(1536);

    await app.close();
  });

  it('getUserEmbedder throws for unknown user', async () => {
    const app = await buildTestFastify([makeUser('alice')]);

    expect(() => app.getUserEmbedder('unknown')).toThrow();

    await app.close();
  });

  it('user-added event creates new embedder', async () => {
    const app = await buildTestFastify();

    // Should throw before adding
    expect(() => app.getUserEmbedder('bob')).toThrow();

    registry.emit('user-added', makeUser('bob'));

    // Should work after event
    const embedder = app.getUserEmbedder('bob');
    expect(embedder).toBeDefined();
    expect(embedder.dimensions).toBe(1536);

    await app.close();
  });

  it('user-removed event deletes embedder', async () => {
    const alice = makeUser('alice');
    const app = await buildTestFastify([alice]);

    // Should work before removal
    expect(app.getUserEmbedder('alice')).toBeDefined();

    registry.emit('user-removed', alice);

    // Should throw after removal
    expect(() => app.getUserEmbedder('alice')).toThrow();

    await app.close();
  });

  it('user-updated with changed openaiKey recreates embedder', async () => {
    const alice = makeUser('alice', 'sk-old-key');
    const app = await buildTestFastify([alice]);

    const oldEmbedder = app.getUserEmbedder('alice');

    const updatedAlice = makeUser('alice', 'sk-new-key');
    registry.emit('user-updated', updatedAlice, alice);

    const newEmbedder = app.getUserEmbedder('alice');
    expect(newEmbedder).toBeDefined();
    // Should be a different instance
    expect(newEmbedder).not.toBe(oldEmbedder);

    await app.close();
  });

  it('user-updated with same openaiKey does NOT recreate embedder', async () => {
    const alice = makeUser('alice', 'sk-same-key');
    const app = await buildTestFastify([alice]);

    const oldEmbedder = app.getUserEmbedder('alice');

    const updatedAlice = { ...makeUser('alice', 'sk-same-key'), vaultPath: '/new/path' };
    registry.emit('user-updated', updatedAlice, alice);

    const sameEmbedder = app.getUserEmbedder('alice');
    // Should be the same instance (not recreated)
    expect(sameEmbedder).toBe(oldEmbedder);

    await app.close();
  });

  it('onClose cleans up all embedders', async () => {
    const app = await buildTestFastify([makeUser('alice'), makeUser('bob')]);

    // Both should exist
    expect(app.getUserEmbedder('alice')).toBeDefined();
    expect(app.getUserEmbedder('bob')).toBeDefined();

    await app.close();

    // After close, getUserEmbedder should throw (embedders cleared)
    expect(() => app.getUserEmbedder('alice')).toThrow();
    expect(() => app.getUserEmbedder('bob')).toThrow();
  });
});
