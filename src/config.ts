import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  COGNIVAULT_API_KEY: z.string().min(1, 'COGNIVAULT_API_KEY is required'),
  VAULT_PATH: z.string().min(1, 'VAULT_PATH is required'),
  QDRANT_URL: z.string().url().default('http://localhost:6333'),
  COGNIVAULT_DATA_DIR: z.string().default('./.cognivault'),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  STABILITY_DELAY_MS: z.coerce.number().int().positive().default(2000),
});

export type Config = z.infer<typeof configSchema>;
export const config: Config = configSchema.parse(process.env);
