import { beforeAll, describe, expect, it, vi } from 'vitest';

// Set required env vars before any imports that trigger config parsing
beforeAll(() => {
  process.env.COGNIVAULT_API_KEY = 'test-api-key';
  process.env.VAULT_PATH = '/tmp/test-vault';
  process.env.OPENAI_API_KEY = 'test-openai-key';
});

// Mock the OpenAI module to avoid real API calls
const mockEmbeddingsCreate = vi.fn();
vi.mock('openai', () => {
  class MockOpenAI {
    embeddings = { create: mockEmbeddingsCreate };
  }
  return {
    default: MockOpenAI,
  };
});

const { DIMENSION_MAP, OpenAIEmbeddingProvider } = await import('../embedding.js');

describe('DIMENSION_MAP', () => {
  it('has text-embedding-3-small with dimension 1536', () => {
    expect(DIMENSION_MAP['text-embedding-3-small']).toBe(1536);
  });

  it('has text-embedding-3-large with dimension 3072', () => {
    expect(DIMENSION_MAP['text-embedding-3-large']).toBe(3072);
  });
});

describe('OpenAIEmbeddingProvider', () => {
  describe('constructor', () => {
    it('creates provider with known model', () => {
      const provider = new OpenAIEmbeddingProvider({
        apiKey: 'test-key',
        model: 'text-embedding-3-small',
      });
      expect(provider.dimensions).toBe(1536);
    });

    it('throws on unknown model name', () => {
      expect(
        () =>
          new OpenAIEmbeddingProvider({
            apiKey: 'test-key',
            model: 'unknown-model',
          }),
      ).toThrow(/unknown.*model|model.*unknown/i);
    });

    it('sets dimensions correctly for large model', () => {
      const provider = new OpenAIEmbeddingProvider({
        apiKey: 'test-key',
        model: 'text-embedding-3-large',
      });
      expect(provider.dimensions).toBe(3072);
    });
  });

  describe('embed()', () => {
    it('returns empty array for empty input', async () => {
      const provider = new OpenAIEmbeddingProvider({
        apiKey: 'test-key',
        model: 'text-embedding-3-small',
      });
      const result = await provider.embed([]);
      expect(result).toEqual([]);
      expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
    });

    it('returns embeddings array of correct shape', async () => {
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [
          { index: 0, embedding: new Array(1536).fill(0.1) },
        ],
      });

      const provider = new OpenAIEmbeddingProvider({
        apiKey: 'test-key',
        model: 'text-embedding-3-small',
      });
      const result = await provider.embed(['hello']);

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveLength(1536);
    });

    it('returns embeddings sorted by index', async () => {
      // API returns data out of order; embed() must sort by index
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [
          { index: 1, embedding: [2, 2, 2] },
          { index: 0, embedding: [1, 1, 1] },
        ],
      });

      const provider = new OpenAIEmbeddingProvider({
        apiKey: 'test-key',
        model: 'text-embedding-3-small',
      });
      const result = await provider.embed(['first', 'second']);

      expect(result[0]).toEqual([1, 1, 1]);
      expect(result[1]).toEqual([2, 2, 2]);
    });

    it('calls embeddings.create with correct model and input', async () => {
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ index: 0, embedding: [0.5] }],
      });

      const provider = new OpenAIEmbeddingProvider({
        apiKey: 'test-key',
        model: 'text-embedding-3-small',
      });
      await provider.embed(['test input']);

      expect(mockEmbeddingsCreate).toHaveBeenCalledWith({
        model: 'text-embedding-3-small',
        input: ['test input'],
      });
    });
  });
});
