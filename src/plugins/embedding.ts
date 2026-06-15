import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import type { EmbeddingProvider } from '../lib/embedding.js';
import { OpenAIEmbeddingProvider, resolveDimensions } from '../lib/embedding.js';
import { GigaChatEmbeddingProvider } from '../lib/gigachat-embedding.js';

declare module 'fastify' {
  interface FastifyInstance {
    getUserEmbedder: (userId: string) => EmbeddingProvider;
  }
}

async function embeddingPlugin(fastify: FastifyInstance): Promise<void> {
  const embedders = new Map<string, EmbeddingProvider>();
  const provider = config.EMBEDDING_PROVIDER;

  // GigaChat authenticates via a system-wide mTLS certificate, so a single shared
  // instance serves every user (per-user OpenAI keys do not apply).
  let sharedGigaChat: EmbeddingProvider | undefined;
  if (provider === 'gigachat') {
    if (!config.GIGACHAT_CERT_PATH || !config.GIGACHAT_KEY_PATH) {
      throw new Error(
        'GIGACHAT_CERT_PATH and GIGACHAT_KEY_PATH are required when EMBEDDING_PROVIDER=gigachat',
      );
    }
    sharedGigaChat = new GigaChatEmbeddingProvider({
      baseUrl: config.GIGACHAT_BASE_URL,
      model: config.GIGACHAT_MODEL,
      dimensions: resolveDimensions(config),
      certPath: config.GIGACHAT_CERT_PATH,
      keyPath: config.GIGACHAT_KEY_PATH,
      keyPassphrase: config.GIGACHAT_KEY_PASSPHRASE,
      caPath: config.GIGACHAT_CA_PATH,
      verifySsl: config.GIGACHAT_VERIFY_SSL,
    });
  }

  function createEmbedder(apiKey: string | undefined): EmbeddingProvider {
    if (provider === 'gigachat') {
      // biome-ignore lint/style/noNonNullAssertion: set above when provider is gigachat
      return sharedGigaChat!;
    }
    if (!apiKey) {
      throw new Error('User has no openaiKey but EMBEDDING_PROVIDER=openai');
    }
    return new OpenAIEmbeddingProvider({
      apiKey,
      baseUrl: config.OPENAI_BASE_URL,
      model: config.EMBEDDING_MODEL,
    });
  }

  // Initialize embedders for all existing users from registry
  for (const user of fastify.registry.getAllUsers()) {
    embedders.set(user.userId, createEmbedder(user.openaiKey));
  }

  // Listen for registry events
  fastify.registry.on('user-added', (user) => {
    embedders.set(user.userId, createEmbedder(user.openaiKey));
    fastify.log.info({ userId: user.userId }, 'Created per-user embedder');
  });

  fastify.registry.on('user-removed', (user) => {
    embedders.delete(user.userId);
    fastify.log.info({ userId: user.userId }, 'Removed per-user embedder');
  });

  fastify.registry.on('user-updated', (user, previous) => {
    // GigaChat uses a shared instance — no per-user key to react to.
    if (provider === 'gigachat') {
      return;
    }
    if (user.openaiKey !== previous.openaiKey) {
      embedders.set(user.userId, createEmbedder(user.openaiKey));
      fastify.log.info({ userId: user.userId }, 'Recreated per-user embedder (key changed)');
    }
  });

  // Decorate fastify with getUserEmbedder lookup
  fastify.decorate('getUserEmbedder', (userId: string): EmbeddingProvider => {
    const embedder = embedders.get(userId);
    if (!embedder) {
      throw new Error(`No embedder for user: ${userId}`);
    }
    return embedder;
  });

  // Clean up on close
  fastify.addHook('onClose', async () => {
    embedders.clear();
  });
}

export default fp(embeddingPlugin, { name: 'embedder', dependencies: ['registry'] });
