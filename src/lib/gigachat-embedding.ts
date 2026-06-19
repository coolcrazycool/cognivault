import { readFileSync } from 'node:fs';
import { Agent, request } from 'node:https';
import { getEncoding } from 'js-tiktoken';
import type { EmbeddingProvider } from './embedding.js';

// GigaChat embeddings cap the input at 4096 tokens PER text, counted by GigaChat's
// own tokenizer. We truncate with cl100k (OpenAI's), which UNDERcounts Russian text
// vs GigaChat by ~20% — observed 4096 cl100k tokens ≈ 4982 GigaChat tokens — so
// truncating at 4096 still 413s. Cap well below 4096 cl100k tokens to leave headroom
// for that mismatch; any oversized chunk otherwise 413s on its own. Tune per deployment.
const DEFAULT_MAX_EMBEDDING_TOKENS = 3_000;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 30_000;
// GigaChat rejects oversized request bodies with HTTP 413 ("Request size exceeded").
// Callers (the indexer) embed all chunks of a file in one call, so we split that into
// sub-requests bounded by both a body-byte budget and an item count. Defaults are
// conservative — internal gateways cap smaller than the public API — and overridable
// per deployment via GIGACHAT_MAX_REQUEST_BYTES / GIGACHAT_MAX_BATCH_ITEMS.
const DEFAULT_MAX_REQUEST_BYTES = 120_000;
const DEFAULT_MAX_BATCH_ITEMS = 64;
// GigaChat also caps the total tokens across all inputs in one request (not just
// body bytes), so a batch of many small chunks can still 413. Bound the summed
// token count per request as well. Conservative default; tune per deployment.
const DEFAULT_MAX_REQUEST_TOKENS = 2_048;

interface GigaChatEmbeddingItem {
  embedding: number[];
  index: number;
}

interface GigaChatEmbeddingResponse {
  data: GigaChatEmbeddingItem[];
}

/** Performs the POST /embeddings call. Injectable so tests avoid real mTLS. */
export type GigaChatTransport = (url: string, body: string) => Promise<GigaChatEmbeddingResponse>;

export interface GigaChatEmbeddingProviderOptions {
  baseUrl: string;
  model: string;
  dimensions: number;
  certPath: string;
  keyPath: string;
  keyPassphrase?: string;
  caPath?: string;
  verifySsl: boolean;
  /** Max UTF-8 body bytes per embeddings request (default 120_000). */
  maxRequestBytes?: number;
  /** Max input items per embeddings request (default 64). */
  maxBatchItems?: number;
  /** Max summed tokens across all inputs per embeddings request (default 2048). */
  maxRequestTokens?: number;
  /** Max cl100k tokens per single text before truncation (default 3000). */
  maxEmbeddingTokens?: number;
  /** Override the HTTP transport (used in tests). */
  transport?: GigaChatTransport;
}

/**
 * Embedding provider for Sber GigaChat behind an mTLS-protected, OpenAI-compatible
 * `/v1/embeddings` endpoint. Authentication is the client certificate itself — no
 * bearer token. The certificate is a system-wide credential read from the filesystem.
 */
export class GigaChatEmbeddingProvider implements EmbeddingProvider {
  private readonly model: string;
  private readonly _dimensions: number;
  private readonly endpoint: string;
  private readonly transport: GigaChatTransport;
  private readonly maxRequestBytes: number;
  private readonly maxBatchItems: number;
  private readonly maxRequestTokens: number;
  private readonly maxEmbeddingTokens: number;

  constructor(opts: GigaChatEmbeddingProviderOptions) {
    this.model = opts.model;
    this._dimensions = opts.dimensions;
    this.endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/embeddings`;
    this.transport = opts.transport ?? createHttpsTransport(opts);
    this.maxRequestBytes = opts.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.maxBatchItems = opts.maxBatchItems ?? DEFAULT_MAX_BATCH_ITEMS;
    this.maxRequestTokens = opts.maxRequestTokens ?? DEFAULT_MAX_REQUEST_TOKENS;
    this.maxEmbeddingTokens = opts.maxEmbeddingTokens ?? DEFAULT_MAX_EMBEDDING_TOKENS;
  }

  get dimensions(): number {
    return this._dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const enc = getEncoding('cl100k_base');
    const sized = texts.map((text) => {
      const tokens = enc.encode(text);
      const capped =
        tokens.length <= this.maxEmbeddingTokens ? tokens : tokens.slice(0, this.maxEmbeddingTokens);
      const finalText = tokens.length <= this.maxEmbeddingTokens ? text : enc.decode(capped);
      return {
        text: finalText,
        bytes: Buffer.byteLength(finalText, 'utf8'),
        tokens: capped.length,
      };
    });

    const embeddings: number[][] = [];
    for (const batch of this.batchByRequestSize(sized)) {
      const body = JSON.stringify({ model: this.model, input: batch.map((item) => item.text) });
      const response = await this.post(body);
      const ordered = response.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding);
      embeddings.push(...ordered);
    }

    return embeddings;
  }

  /**
   * Splits sized texts into sub-batches that stay under GigaChat's request limits:
   * body bytes (maxRequestBytes), summed input tokens (maxRequestTokens), and item
   * count (maxBatchItems). A single text larger than a budget is sent on its own —
   * per-text token truncation already caps its size.
   */
  private *batchByRequestSize(
    items: Array<{ text: string; bytes: number; tokens: number }>,
  ): Generator<Array<{ text: string; bytes: number; tokens: number }>> {
    let batch: Array<{ text: string; bytes: number; tokens: number }> = [];
    let bytes = 0;
    let tokens = 0;
    for (const item of items) {
      const exceeds =
        bytes + item.bytes > this.maxRequestBytes ||
        tokens + item.tokens > this.maxRequestTokens ||
        batch.length >= this.maxBatchItems;
      if (batch.length > 0 && exceeds) {
        yield batch;
        batch = [];
        bytes = 0;
        tokens = 0;
      }
      batch.push(item);
      bytes += item.bytes;
      tokens += item.tokens;
    }
    if (batch.length > 0) {
      yield batch;
    }
  }

  async validate(): Promise<void> {
    await this.embed(['test']);
  }

  private async post(body: string): Promise<GigaChatEmbeddingResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.transport(this.endpoint, body);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`GigaChat embeddings request failed: ${String(lastError)}`);
  }
}

/** Builds the default mTLS transport over node:https. Reads the cert/key eagerly. */
function createHttpsTransport(opts: GigaChatEmbeddingProviderOptions): GigaChatTransport {
  const agent = new Agent({
    cert: readFileSync(opts.certPath),
    key: readFileSync(opts.keyPath),
    passphrase: opts.keyPassphrase,
    ca: opts.caPath ? readFileSync(opts.caPath) : undefined,
    rejectUnauthorized: opts.verifySsl,
    keepAlive: true,
  });

  return (url, body) =>
    new Promise<GigaChatEmbeddingResponse>((resolve, reject) => {
      const target = new URL(url);
      const req = request(
        {
          hostname: target.hostname,
          port: target.port || 443,
          path: target.pathname + target.search,
          method: 'POST',
          agent,
          timeout: REQUEST_TIMEOUT_MS,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new Error(`GigaChat embeddings ${status}: ${text.slice(0, 500)}`));
              return;
            }
            try {
              resolve(JSON.parse(text) as GigaChatEmbeddingResponse);
            } catch (err) {
              reject(new Error(`GigaChat embeddings returned invalid JSON: ${String(err)}`));
            }
          });
        },
      );

      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('GigaChat embeddings request timed out')));
      req.write(body);
      req.end();
    });
}
