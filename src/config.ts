import { z } from 'zod';

const configSchema = z
  .object({
    PORT: z.coerce.number().default(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    VAULT_PATH: z.string().optional(),
    QDRANT_URL: z.string().url().default('http://localhost:6333'),
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

    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  })
  .superRefine((cfg, ctx) => {
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
