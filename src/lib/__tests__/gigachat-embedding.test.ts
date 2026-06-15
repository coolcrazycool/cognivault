import { describe, expect, it, vi } from 'vitest';
import { GigaChatEmbeddingProvider } from '../gigachat-embedding.js';

const baseOpts = {
  baseUrl: 'https://gigachat-ift.sberdevices.delta.sbrf.ru/v1',
  model: 'EmbeddingsGigaR',
  dimensions: 2560,
  certPath: '/dev/null/cert.pem',
  keyPath: '/dev/null/key.pem',
  verifySsl: true,
};

describe('GigaChatEmbeddingProvider', () => {
  it('exposes the configured dimension without touching the network', () => {
    const transport = vi.fn();
    const provider = new GigaChatEmbeddingProvider({ ...baseOpts, transport });
    expect(provider.dimensions).toBe(2560);
    expect(transport).not.toHaveBeenCalled();
  });

  it('returns empty array for empty input without calling transport', async () => {
    const transport = vi.fn();
    const provider = new GigaChatEmbeddingProvider({ ...baseOpts, transport });
    expect(await provider.embed([])).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it('posts to the OpenAI-compatible /embeddings endpoint with model and input', async () => {
    const transport = vi.fn().mockResolvedValue({
      data: [{ index: 0, embedding: [0.1, 0.2] }],
    });
    const provider = new GigaChatEmbeddingProvider({ ...baseOpts, transport });

    await provider.embed(['hello']);

    expect(transport).toHaveBeenCalledTimes(1);
    const call = transport.mock.calls[0];
    expect(call).toBeDefined();
    const [url, body] = call as [string, string];
    expect(url).toBe(`${baseOpts.baseUrl}/embeddings`);
    expect(JSON.parse(body)).toEqual({ model: 'EmbeddingsGigaR', input: ['hello'] });
  });

  it('normalizes a trailing slash in baseUrl', async () => {
    const transport = vi.fn().mockResolvedValue({ data: [{ index: 0, embedding: [1] }] });
    const provider = new GigaChatEmbeddingProvider({
      ...baseOpts,
      baseUrl: 'https://host/v1/',
      transport,
    });

    await provider.embed(['x']);

    expect(transport.mock.calls[0]?.[0]).toBe('https://host/v1/embeddings');
  });

  it('returns embeddings sorted by index', async () => {
    const transport = vi.fn().mockResolvedValue({
      data: [
        { index: 1, embedding: [2, 2] },
        { index: 0, embedding: [1, 1] },
      ],
    });
    const provider = new GigaChatEmbeddingProvider({ ...baseOpts, transport });

    const result = await provider.embed(['first', 'second']);

    expect(result).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it('retries transient failures up to 3 attempts then succeeds', async () => {
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce({ data: [{ index: 0, embedding: [0.5] }] });
    const provider = new GigaChatEmbeddingProvider({ ...baseOpts, transport });

    const result = await provider.embed(['retry me']);

    expect(transport).toHaveBeenCalledTimes(3);
    expect(result).toEqual([[0.5]]);
  });

  it('throws the last error after exhausting retries', async () => {
    const transport = vi.fn().mockRejectedValue(new Error('GigaChat embeddings 503: down'));
    const provider = new GigaChatEmbeddingProvider({ ...baseOpts, transport });

    await expect(provider.embed(['boom'])).rejects.toThrow(/503/);
    expect(transport).toHaveBeenCalledTimes(3);
  });
});
