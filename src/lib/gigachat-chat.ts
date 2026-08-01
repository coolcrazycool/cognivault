import { readFileSync } from 'node:fs';
import { Agent, request } from 'node:https';
import { GigaChatHttpError } from './gigachat-embedding.js';

const DEFAULT_MODEL = 'GigaChat';
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 300;
// Summaries are descriptive, not creative: keep the model deterministic so the same
// document produces the same annotation between reindexes.
const DEFAULT_TEMPERATURE = 0;

/** 429 (rate limit) and 5xx are worth retrying; other 4xx (400/413) are not. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function statusOf(err: unknown): number | undefined {
  return err instanceof GigaChatHttpError ? err.status : undefined;
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

export interface GigaChatChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GigaChatChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/** Performs the POST /chat/completions call. Injectable so tests avoid real mTLS. */
export type GigaChatChatTransport = (url: string, body: string) => Promise<GigaChatChatResponse>;

export interface GigaChatChatClientOptions {
  baseUrl: string;
  /** Chat model name; the embedding model name does NOT apply here. */
  model?: string;
  certPath: string;
  keyPath: string;
  keyPassphrase?: string;
  caPath?: string;
  verifySsl: boolean;
  /** Sampling temperature (default 0 — summaries must be reproducible). */
  temperature?: number;
  /** Upper bound on the generated answer (default 300 tokens). */
  maxTokens?: number;
  /** Wall-clock budget per attempt (default 30_000ms). */
  timeoutMs?: number;
  /** Attempts per request before giving up (default 3). */
  maxRetries?: number;
  /** Base backoff between retries; doubles each attempt (default 1000ms). 0 in tests. */
  retryBaseDelayMs?: number;
  /** Override the HTTP transport (used in tests). */
  transport?: GigaChatChatTransport;
}

/**
 * Minimal, non-streaming `chat/completions` client for Sber GigaChat behind the same
 * mTLS-protected, OpenAI-compatible gateway the embedder talks to — the client
 * certificate IS the credential, there is no bearer token.
 *
 * Deliberately one-shot (prompt in, text out): the indexing pipeline only ever needs a
 * short summary, and streaming would buy nothing for a call nobody is watching.
 */
export class GigaChatChatClient {
  private readonly model: string;
  private readonly endpoint: string;
  private readonly transport: GigaChatChatTransport;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(opts: GigaChatChatClientOptions) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.transport = opts.transport ?? createHttpsTransport(opts, this.timeoutMs);
    this.temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  }

  /** Sends one prompt and returns the assistant's text, trimmed. */
  async complete(prompt: string, opts?: { system?: string }): Promise<string> {
    const messages: GigaChatChatMessage[] = [];
    if (opts?.system) {
      messages.push({ role: 'system', content: opts.system });
    }
    messages.push({ role: 'user', content: prompt });

    const body = JSON.stringify({
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      stream: false,
    });

    const response = await this.post(body);
    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('GigaChat chat returned no content');
    }
    return content.trim();
  }

  private async post(body: string): Promise<GigaChatChatResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await this.withTimeout(this.transport(this.endpoint, body));
      } catch (err) {
        lastError = err;
        const status = statusOf(err);
        // A definitive client error (400, 413, …) won't change on retry — fail fast.
        if (status !== undefined && !isRetryableStatus(status)) {
          throw err;
        }
        if (attempt < this.maxRetries - 1) {
          const retryAfter = err instanceof GigaChatHttpError ? err.retryAfterMs : undefined;
          const backoff = this.retryBaseDelayMs * 2 ** attempt;
          const jitter = backoff * 0.25 * Math.random();
          await sleep(retryAfter ?? backoff + jitter);
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`GigaChat chat request failed: ${String(lastError)}`);
  }

  /**
   * Caps every attempt in wall-clock time. The default transport already sets a socket
   * timeout, but an injected one (or a gateway that holds the connection open without
   * sending bytes) would otherwise stall indexing indefinitely.
   */
  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('GigaChat chat request timed out')),
        this.timeoutMs,
      );
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
  }
}

/** Builds the default mTLS transport over node:https. Reads the cert/key eagerly. */
function createHttpsTransport(
  opts: GigaChatChatClientOptions,
  timeoutMs: number,
): GigaChatChatTransport {
  const agent = new Agent({
    cert: readFileSync(opts.certPath),
    key: readFileSync(opts.keyPath),
    passphrase: opts.keyPassphrase,
    ca: opts.caPath ? readFileSync(opts.caPath) : undefined,
    rejectUnauthorized: opts.verifySsl,
    keepAlive: true,
  });

  return (url, body) =>
    new Promise<GigaChatChatResponse>((resolve, reject) => {
      const target = new URL(url);
      const req = request(
        {
          hostname: target.hostname,
          port: target.port || 443,
          path: target.pathname + target.search,
          method: 'POST',
          agent,
          timeout: timeoutMs,
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
              reject(
                new GigaChatHttpError(
                  status,
                  `GigaChat chat ${status}: ${text.slice(0, 500)}`,
                  parseRetryAfter(res.headers['retry-after']),
                ),
              );
              return;
            }
            try {
              resolve(JSON.parse(text) as GigaChatChatResponse);
            } catch (err) {
              reject(new Error(`GigaChat chat returned invalid JSON: ${String(err)}`));
            }
          });
        },
      );

      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('GigaChat chat request timed out')));
      req.write(body);
      req.end();
    });
}
