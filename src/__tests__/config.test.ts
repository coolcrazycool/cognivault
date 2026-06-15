import { describe, expect, it } from 'vitest';
import { configSchema } from '../config.js';

describe('config schema — embedding provider', () => {
  it('defaults to the openai provider', () => {
    const cfg = configSchema.parse({});
    expect(cfg.EMBEDDING_PROVIDER).toBe('openai');
  });

  it('accepts gigachat when cert, key, and dimensions are provided', () => {
    const cfg = configSchema.parse({
      EMBEDDING_PROVIDER: 'gigachat',
      GIGACHAT_CERT_PATH: '/certs/client.pem',
      GIGACHAT_KEY_PATH: '/certs/client.key',
      EMBEDDING_DIMENSIONS: '2560',
    });
    expect(cfg.EMBEDDING_PROVIDER).toBe('gigachat');
    expect(cfg.EMBEDDING_DIMENSIONS).toBe(2560);
    expect(cfg.GIGACHAT_MODEL).toBe('EmbeddingsGigaR');
    expect(cfg.GIGACHAT_BASE_URL).toContain('sberdevices');
  });

  it('rejects gigachat without certificate paths', () => {
    expect(() =>
      configSchema.parse({
        EMBEDDING_PROVIDER: 'gigachat',
        EMBEDDING_DIMENSIONS: '2560',
      }),
    ).toThrow(/GIGACHAT_CERT_PATH/);
  });

  it('rejects gigachat without explicit dimensions', () => {
    expect(() =>
      configSchema.parse({
        EMBEDDING_PROVIDER: 'gigachat',
        GIGACHAT_CERT_PATH: '/certs/client.pem',
        GIGACHAT_KEY_PATH: '/certs/client.key',
      }),
    ).toThrow(/EMBEDDING_DIMENSIONS/);
  });

  it('parses GIGACHAT_VERIFY_SSL=false as a boolean false', () => {
    const cfg = configSchema.parse({
      EMBEDDING_PROVIDER: 'gigachat',
      GIGACHAT_CERT_PATH: '/certs/client.pem',
      GIGACHAT_KEY_PATH: '/certs/client.key',
      EMBEDDING_DIMENSIONS: '2560',
      GIGACHAT_VERIFY_SSL: 'false',
    });
    expect(cfg.GIGACHAT_VERIFY_SSL).toBe(false);
  });
});
