import OpenAI from 'openai';

export const DIMENSION_MAP: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
};

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
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

    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
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
