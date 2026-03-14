import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import type { EmbeddingProvider } from '../lib/embedding.js';
import { OpenAIEmbeddingProvider } from '../lib/embedding.js';

declare module 'fastify' {
  interface FastifyInstance {
    getUserEmbedder: (userId: string) => EmbeddingProvider;
  }
}

async function embeddingPlugin(fastify: FastifyInstance): Promise<void> {
  const embedders = new Map<string, EmbeddingProvider>();

  function createEmbedder(apiKey: string): EmbeddingProvider {
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
    if (user.openaiKey !== previous.openaiKey) {
      embedders.set(user.userId, createEmbedder(user.openaiKey));
      fastify.log.info({ userId: user.userId }, 'Recreated per-user embedder (key changed)');
    }
  });

  // Decorate fastify with getUserEmbedder lookup
  fastify.decorate('getUserEmbedder', (userId: string): EmbeddingProvider => {
    const provider = embedders.get(userId);
    if (!provider) {
      throw new Error(`No embedder for user: ${userId}`);
    }
    return provider;
  });

  // Clean up on close
  fastify.addHook('onClose', async () => {
    embedders.clear();
  });
}

export default fp(embeddingPlugin, { name: 'embedder', dependencies: ['registry'] });
