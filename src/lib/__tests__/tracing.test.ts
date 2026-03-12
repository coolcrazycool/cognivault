import { describe, expect, it } from 'vitest';
import { initTracing, shutdownTracing } from '../tracing.js';

describe('tracing module', () => {
  it('exports initTracing as a function', () => {
    expect(typeof initTracing).toBe('function');
  });

  it('exports shutdownTracing as a function', () => {
    expect(typeof shutdownTracing).toBe('function');
  });

  it('shutdownTracing resolves without error when SDK not initialized', async () => {
    // SDK is not initialized in this test — shutdownTracing should be a no-op
    await expect(shutdownTracing()).resolves.toBeUndefined();
  });
});
