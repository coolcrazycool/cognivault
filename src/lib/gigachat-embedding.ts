import { readFileSync } from 'node:fs';
import { Agent, request } from 'node:https';
import { getEncoding } from 'js-tiktoken';
import type { EmbeddingProvider } from './embedding.js';

// cl100k is an OpenAI tokenizer and only an approximation for GigaChat. It tends
// to overestimate token counts for Cyrillic text, so truncating against it is
// conservative (we cut earlier rather than later). The cap stays well under the
// EmbeddingsGigaR input limit.
const MAX_EMBEDDING_TOKENS = 4096;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 30_000;
// GigaChat rejects oversized request bodies with HTTP 413 ("Request size exceeded").
// Callers (the indexer) embed all chunks of a file in one call, so we split that into
// sub-requests bounded by both a body-byte budget and an item count. Conservative on
// purpose — internal gateways cap smaller than the public API.
const MAX_REQUEST_BYTES = 120_000;
const MAX_BATCH_ITEMS = 64;

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

  constructor(opts: GigaChatEmbeddingProviderOptions) {
    this.model = opts.model;
    this._dimensions = opts.dimensions;
    this.endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/embeddings`;
    this.transport = opts.transport ?? createHttpsTransport(opts);
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

    const embeddings: number[][] = [];
    for (const batch of this.batchByRequestSize(truncated)) {
      const body = JSON.stringify({ model: this.model, input: batch });
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
   * Splits texts into sub-batches that stay under GigaChat's request-size limit.
   * Bounded by MAX_REQUEST_BYTES (UTF-8 body bytes) and MAX_BATCH_ITEMS. A single
   * text larger than the budget is sent on its own — per-text token truncation
   * already caps its size.
   */
  private *batchByRequestSize(texts: string[]): Generator<string[]> {
    let batch: string[] = [];
    let bytes = 0;
    for (const text of texts) {
      const size = Buffer.byteLength(text, 'utf8');
      if (batch.length > 0 && (bytes + size > MAX_REQUEST_BYTES || batch.length >= MAX_BATCH_ITEMS)) {
        yield batch;
        batch = [];
        bytes = 0;
      }
      batch.push(text);
      bytes += size;
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
