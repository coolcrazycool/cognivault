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
const DEFAULT_MAX_RETRIES = 5;
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
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
// EmbeddingsGigaR is an ASYMMETRIC model: the query side expects a task instruction
// that the document side must never see. Sber's reference instruction for retrieval,
// with a literal newline before "вопрос:".
const QUERY_PLACEHOLDER = '{query}';
const DEFAULT_QUERY_INSTRUCTION =
  'Дан вопрос, необходимо найти абзац текста с ответом \nвопрос: {query}';

/** HTTP error from GigaChat, carrying the status and any Retry-After hint. */
export class GigaChatHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GigaChatHttpError';
  }
}

/** 429 (rate limit) and 5xx are worth retrying; other 4xx (400/413) are not. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Pulls a status code from a typed error, or parses it from a legacy message. */
function statusOf(err: unknown): number | undefined {
  if (err instanceof GigaChatHttpError) {
    return err.status;
  }
  const match = err instanceof Error ? err.message.match(/embeddings (\d{3})\b/) : null;
  return match ? Number(match[1]) : undefined;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Parses a Retry-After header (delta-seconds or HTTP date) into milliseconds. */
function parseRetryAfter(header: string | string[] | undefined): number | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

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
  /**
   * Instruction applied to SEARCH QUERIES only (never to documents). `{query}` is
   * replaced by the query text; without the placeholder the template is prepended.
   * An empty string disables the instruction. Defaults to Sber's retrieval prompt.
   */
  queryInstruction?: string;
  /** Attempts per request before giving up (default 5). */
  maxRetries?: number;
  /** Base backoff between retries; doubles each attempt (default 1000ms). 0 in tests. */
  retryBaseDelayMs?: number;
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
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly queryInstruction: string;

  constructor(opts: GigaChatEmbeddingProviderOptions) {
    this.model = opts.model;
    this._dimensions = opts.dimensions;
    this.endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/embeddings`;
    this.transport = opts.transport ?? createHttpsTransport(opts);
    this.maxRequestBytes = opts.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.maxBatchItems = opts.maxBatchItems ?? DEFAULT_MAX_BATCH_ITEMS;
    this.maxRequestTokens = opts.maxRequestTokens ?? DEFAULT_MAX_REQUEST_TOKENS;
    this.maxEmbeddingTokens = opts.maxEmbeddingTokens ?? DEFAULT_MAX_EMBEDDING_TOKENS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.queryInstruction = opts.queryInstruction ?? DEFAULT_QUERY_INSTRUCTION;
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
        tokens.length <= this.maxEmbeddingTokens
          ? tokens
          : tokens.slice(0, this.maxEmbeddingTokens);
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
   * Embeds a search query. EmbeddingsGigaR is asymmetric, so the query gets the
   * configured instruction applied first; everything after that (token truncation,
   * batching, transport, response parsing) is the same path documents take.
   */
  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.embed([this.applyQueryInstruction(text)]);
    if (embedding === undefined) {
      throw new Error('GigaChat embeddings returned no vector for the query');
    }
    return embedding;
  }

  /**
   * `{query}` in the template is replaced by the query text. A template without the
   * placeholder is prepended verbatim. An empty template leaves the query untouched.
   */
  private applyQueryInstruction(query: string): string {
    if (this.queryInstruction.length === 0) {
      return query;
    }
    if (this.queryInstruction.includes(QUERY_PLACEHOLDER)) {
      return this.queryInstruction.split(QUERY_PLACEHOLDER).join(query);
    }
    return `${this.queryInstruction}${query}`;
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
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await this.transport(this.endpoint, body);
      } catch (err) {
        lastError = err;
        const status = statusOf(err);
        // A definitive client error (400, 413, …) won't change on retry — fail fast.
        if (status !== undefined && !isRetryableStatus(status)) {
          throw err;
        }
        if (attempt < this.maxRetries - 1) {
          const retryAfter = err instanceof GigaChatHttpError ? err.retryAfterMs : undefined;
          // Honor Retry-After (429); otherwise exponential backoff with jitter.
          const backoff = this.retryBaseDelayMs * 2 ** attempt;
          const jitter = backoff * 0.25 * Math.random();
          await sleep(retryAfter ?? backoff + jitter);
        }
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
              const retryAfterMs = parseRetryAfter(res.headers['retry-after']);
              reject(
                new GigaChatHttpError(
                  status,
                  `GigaChat embeddings ${status}: ${text.slice(0, 500)}`,
                  retryAfterMs,
                ),
              );
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
