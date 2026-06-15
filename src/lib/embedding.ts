import { getEncoding } from 'js-tiktoken';
import OpenAI from 'openai';
import type { Config } from '../config.js';

export const DIMENSION_MAP: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
};

const MAX_EMBEDDING_TOKENS = 8191;

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

/**
 * Resolve the vector dimension for the active provider. OpenAI models map to a
 * known size; GigaChat (custom model) requires an explicit EMBEDDING_DIMENSIONS.
 * Used by both the embedding plugin and the Qdrant collection setup so the
 * collection size and provider always agree.
 */
export function resolveDimensions(
  cfg: Pick<Config, 'EMBEDDING_PROVIDER' | 'EMBEDDING_MODEL' | 'EMBEDDING_DIMENSIONS'>,
): number {
  if (cfg.EMBEDDING_PROVIDER === 'gigachat') {
    if (cfg.EMBEDDING_DIMENSIONS === undefined) {
      throw new Error('EMBEDDING_DIMENSIONS is required when EMBEDDING_PROVIDER=gigachat');
    }
    return cfg.EMBEDDING_DIMENSIONS;
  }

  const dimensions = DIMENSION_MAP[cfg.EMBEDDING_MODEL];
  if (dimensions === undefined) {
    throw new Error(
      `Unknown embedding model: "${cfg.EMBEDDING_MODEL}". Known models: ${Object.keys(DIMENSION_MAP).join(', ')}`,
    );
  }
  return dimensions;
}

interface OpenAIEmbeddingProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly _dimensions: number;

  constructor(opts: OpenAIEmbeddingProviderOptions) {
    const dimensions = DIMENSION_MAP[opts.model];
    if (dimensions === undefined) {
      throw new Error(
        `Unknown embedding model: "${opts.model}". Known models: ${Object.keys(DIMENSION_MAP).join(', ')}`,
      );
    }
    this._dimensions = dimensions;
    this.model = opts.model;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
      maxRetries: 3,
    });
  }

  get dimensions(): number {
    return this._dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const enc = getEncoding('cl100k_base');
    const truncated = texts.map((text) => {
      const tokens = enc.encode(text);
      if (tokens.length <= MAX_EMBEDDING_TOKENS) {
        return text;
      }
      return enc.decode(tokens.slice(0, MAX_EMBEDDING_TOKENS));
    });

    const response = await this.client.embeddings.create({
      model: this.model,
      input: truncated,
    });

    return response.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
  }

  async validate(): Promise<void> {
    await this.embed(['test']);
  }
}
