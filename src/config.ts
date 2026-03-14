import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  VAULT_PATH: z.string().optional(),
  QDRANT_URL: z.string().url().default('http://localhost:6333'),
  COGNIVAULT_DATA_DIR: z.string().default('./.cognivault'),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  STABILITY_DELAY_MS: z.coerce.number().int().positive().default(2000),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

export type Config = z.infer<typeof configSchema>;
export const config: Config = configSchema.parse(process.env);
