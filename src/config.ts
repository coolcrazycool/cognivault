import { z } from 'zod';

const configSchema = z
  .object({
    PORT: z.coerce.number().default(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    VAULT_PATH: z.string().optional(),
    QDRANT_URL: z.string().url().default('http://localhost:6333'),
    // External Qdrant sits behind a reverse proxy with Basic auth (native Qdrant only
    // speaks the `api-key` header). Both must be set together, or neither.
    QDRANT_USERNAME: z.string().optional(),
    QDRANT_PASSWORD: z.string().optional(),
    // Per-request timeout for the Qdrant REST client (client default is 300_000 ms —
    // far too long for a hop over the corporate network).
    QDRANT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    // TLS to an EXTERNAL Qdrant. The REST client goes through the global `fetch`
    // (undici) and exposes no TLS options, so these drive an origin-scoped undici
    // dispatcher instead (src/lib/qdrant-tls.ts). Nothing set → stock `fetch`
    // behaviour, system root store, no client certificate.
    // CA bundle of the internal certificate authority (PEM). Setting it REPLACES the
    // system root store — for the Qdrant origin only.
    QDRANT_CA_PATH: z.string().optional(),
    // Client certificate for proxies that demand mTLS. Both paths or neither.
    QDRANT_CERT_PATH: z.string().optional(),
    QDRANT_KEY_PATH: z.string().optional(),
    QDRANT_KEY_PASSPHRASE: z.string().optional(),
    // Verify the Qdrant server certificate. Disable only as a temporary escape hatch
    // while the internal CA bundle is unavailable — unlike NODE_TLS_REJECT_UNAUTHORIZED
    // this affects the Qdrant origin ONLY.
    QDRANT_VERIFY_SSL: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    COGNIVAULT_DATA_DIR: z.string().default('./.cognivault'),
    POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
    STABILITY_DELAY_MS: z.coerce.number().int().positive().default(2000),

    // Embedding provider selection
    EMBEDDING_PROVIDER: z.enum(['openai', 'gigachat']).default('openai'),
    // Explicit vector size; required for gigachat (EmbeddingsGigaR dimension is
    // not known a priori). For openai it is derived from DIMENSION_MAP instead.
    EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().optional(),

    // OpenAI provider
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_BASE_URL: z.string().url().optional(),
    EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),

    // GigaChat provider (mTLS, system-wide certificate)
    GIGACHAT_BASE_URL: z
      .string()
      .url()
      .default('https://gigachat-ift.sberdevices.delta.sbrf.ru/v1'),
    GIGACHAT_MODEL: z.string().default('EmbeddingsGigaR'),
    // EmbeddingsGigaR is asymmetric: search QUERIES carry a task instruction that
    // documents never get. `{query}` is substituted with the query text; a template
    // without the placeholder is prepended; an empty string disables the instruction.
    GIGACHAT_QUERY_INSTRUCTION: z
      .string()
      .default('Дан вопрос, необходимо найти абзац текста с ответом \nвопрос: {query}'),
    GIGACHAT_CERT_PATH: z.string().optional(),
    GIGACHAT_KEY_PATH: z.string().optional(),
    GIGACHAT_KEY_PASSPHRASE: z.string().optional(),
    GIGACHAT_CA_PATH: z.string().optional(),
    // Verify the server certificate. Disable only as a temporary escape hatch
    // when the internal CA bundle is not yet available.
    GIGACHAT_VERIFY_SSL: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    // GigaChat rejects oversized request bodies with HTTP 413. The embedder splits
    // a file's chunks into sub-requests bounded by these. Tune down if 413 persists
    // (the internal gateway may cap smaller than the public API).
    GIGACHAT_MAX_REQUEST_BYTES: z.coerce.number().int().positive().default(120_000),
    GIGACHAT_MAX_BATCH_ITEMS: z.coerce.number().int().positive().default(64),
    // GigaChat also caps total tokens summed across all inputs in one request.
    GIGACHAT_MAX_REQUEST_TOKENS: z.coerce.number().int().positive().default(2_048),
    // Per-text truncation (cl100k tokens). Kept below GigaChat's 4096-token-per-input
    // limit because cl100k undercounts Russian vs GigaChat's tokenizer by ~20%.
    GIGACHAT_MAX_EMBEDDING_TOKENS: z.coerce.number().int().positive().default(3_000),
    // Retry/backoff for rate limiting (429) and 5xx. Honors Retry-After when present.
    GIGACHAT_MAX_RETRIES: z.coerce.number().int().positive().default(5),
    GIGACHAT_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(1_000),

    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  })
  .superRefine((cfg, ctx) => {
    // Half-configured Basic auth silently produces unauthenticated requests — fail fast.
    if (cfg.QDRANT_USERNAME && !cfg.QDRANT_PASSWORD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['QDRANT_PASSWORD'],
        message: 'QDRANT_PASSWORD is required when QDRANT_USERNAME is set',
      });
    }
    if (cfg.QDRANT_PASSWORD && !cfg.QDRANT_USERNAME) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['QDRANT_USERNAME'],
        message: 'QDRANT_USERNAME is required when QDRANT_PASSWORD is set',
      });
    }

    // A lone cert (or a lone key) is silently ignored by TLS — fail fast instead.
    if (cfg.QDRANT_CERT_PATH && !cfg.QDRANT_KEY_PATH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['QDRANT_KEY_PATH'],
        message: 'QDRANT_KEY_PATH is required when QDRANT_CERT_PATH is set',
      });
    }
    if (cfg.QDRANT_KEY_PATH && !cfg.QDRANT_CERT_PATH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['QDRANT_CERT_PATH'],
        message: 'QDRANT_CERT_PATH is required when QDRANT_KEY_PATH is set',
      });
    }

    if (cfg.EMBEDDING_PROVIDER === 'gigachat') {
      if (!cfg.GIGACHAT_CERT_PATH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['GIGACHAT_CERT_PATH'],
          message: 'GIGACHAT_CERT_PATH is required when EMBEDDING_PROVIDER=gigachat',
        });
      }
      if (!cfg.GIGACHAT_KEY_PATH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['GIGACHAT_KEY_PATH'],
          message: 'GIGACHAT_KEY_PATH is required when EMBEDDING_PROVIDER=gigachat',
        });
      }
      if (cfg.EMBEDDING_DIMENSIONS === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EMBEDDING_DIMENSIONS'],
          message: 'EMBEDDING_DIMENSIONS is required when EMBEDDING_PROVIDER=gigachat',
        });
      }
    }
  });

export { configSchema };
export type Config = z.infer<typeof configSchema>;
export const config: Config = configSchema.parse(process.env);
