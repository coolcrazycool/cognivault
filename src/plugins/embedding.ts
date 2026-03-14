import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import type { EmbeddingProvider } from '../lib/embedding.js';
import { OpenAIEmbeddingProvider } from '../lib/embedding.js';

declare module 'fastify' {
  interface FastifyInstance {
    embedder: EmbeddingProvider;
  }
}

async function embeddingPlugin(fastify: FastifyInstance): Promise<void> {
  const provider = new OpenAIEmbeddingProvider({
    apiKey: config.OPENAI_API_KEY,
    baseUrl: config.OPENAI_BASE_URL,
    model: config.EMBEDDING_MODEL,
  });

  await provider.validate();

  fastify.decorate('embedder', provider);
}

export default fp(embeddingPlugin, { name: 'embedder' });
