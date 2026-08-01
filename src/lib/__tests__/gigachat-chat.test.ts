import { describe, expect, it, vi } from 'vitest';
import { GigaChatChatClient } from '../gigachat-chat.js';
import { GigaChatHttpError } from '../gigachat-embedding.js';

const baseOpts = {
  baseUrl: 'https://gigachat-ift.sberdevices.delta.sbrf.ru/v1',
  model: 'GigaChat',
  certPath: '/dev/null/cert.pem',
  keyPath: '/dev/null/key.pem',
  verifySsl: true,
  // Keep retries instant in tests.
  retryBaseDelayMs: 0,
};

function reply(content: string) {
  return { choices: [{ message: { content } }] };
}

describe('GigaChatChatClient', () => {
  it('constructs without touching the filesystem when a transport is injected', () => {
    const transport = vi.fn();
    const client = new GigaChatChatClient({ ...baseOpts, transport });
    expect(client).toBeInstanceOf(GigaChatChatClient);
    expect(transport).not.toHaveBeenCalled();
  });

  it('posts to the OpenAI-compatible /chat/completions endpoint', async () => {
    const transport = vi.fn().mockResolvedValue(reply('Описание таблицы.'));
    const client = new GigaChatChatClient({ ...baseOpts, transport });

    const text = await client.complete('Опиши таблицу');

    expect(text).toBe('Описание таблицы.');
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, body] = transport.mock.calls[0] as [string, string];
    expect(url).toBe('https://gigachat-ift.sberdevices.delta.sbrf.ru/v1/chat/completions');
    const parsed = JSON.parse(body) as {
      model: string;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    expect(parsed.model).toBe('GigaChat');
    expect(parsed.stream).toBe(false);
    expect(parsed.messages).toEqual([{ role: 'user', content: 'Опиши таблицу' }]);
  });

  it('prepends a system message when one is given', async () => {
    const transport = vi.fn().mockResolvedValue(reply('ok'));
    const client = new GigaChatChatClient({ ...baseOpts, transport });

    await client.complete('вопрос', { system: 'ты ассистент' });

    const [, body] = transport.mock.calls[0] as [string, string];
    const parsed = JSON.parse(body) as { messages: Array<{ role: string }> };
    expect(parsed.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('trims the answer and rejects an empty one', async () => {
    const trimmed = new GigaChatChatClient({
      ...baseOpts,
      transport: vi.fn().mockResolvedValue(reply('  текст  ')),
    });
    expect(await trimmed.complete('p')).toBe('текст');

    const empty = new GigaChatChatClient({
      ...baseOpts,
      maxRetries: 1,
      transport: vi.fn().mockResolvedValue(reply('   ')),
    });
    await expect(empty.complete('p')).rejects.toThrow(/no content/i);
  });

  it('retries a 429 and honors Retry-After', async () => {
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new GigaChatHttpError(429, 'GigaChat chat 429: slow down', 0))
      .mockResolvedValue(reply('после ретрая'));
    const client = new GigaChatChatClient({ ...baseOpts, transport });

    expect(await client.complete('p')).toBe('после ретрая');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx up to maxRetries and then gives up', async () => {
    const transport = vi
      .fn()
      .mockRejectedValue(new GigaChatHttpError(503, 'GigaChat chat 503: unavailable'));
    const client = new GigaChatChatClient({ ...baseOpts, maxRetries: 3, transport });

    await expect(client.complete('p')).rejects.toThrow(/503/);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('does not retry a definitive 4xx', async () => {
    const transport = vi
      .fn()
      .mockRejectedValue(new GigaChatHttpError(400, 'GigaChat chat 400: bad request'));
    const client = new GigaChatChatClient({ ...baseOpts, maxRetries: 5, transport });

    await expect(client.complete('p')).rejects.toThrow(/400/);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('retries a transport error that carries no status', async () => {
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue(reply('recovered'));
    const client = new GigaChatChatClient({ ...baseOpts, transport });

    expect(await client.complete('p')).toBe('recovered');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('times out an attempt that never settles', async () => {
    const transport = vi.fn().mockReturnValue(new Promise(() => {}));
    const client = new GigaChatChatClient({
      ...baseOpts,
      maxRetries: 1,
      timeoutMs: 20,
      transport,
    });

    await expect(client.complete('p')).rejects.toThrow(/timed out/i);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('retries after a timeout and succeeds on the next attempt', async () => {
    const transport = vi
      .fn()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue(reply('второй заход'));
    const client = new GigaChatChatClient({
      ...baseOpts,
      maxRetries: 2,
      timeoutMs: 20,
      transport,
    });

    expect(await client.complete('p')).toBe('второй заход');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('passes temperature and max_tokens through to the request body', async () => {
    const transport = vi.fn().mockResolvedValue(reply('ok'));
    const client = new GigaChatChatClient({
      ...baseOpts,
      temperature: 0.3,
      maxTokens: 42,
      transport,
    });

    await client.complete('p');

    const [, body] = transport.mock.calls[0] as [string, string];
    const parsed = JSON.parse(body) as { temperature: number; max_tokens: number };
    expect(parsed.temperature).toBe(0.3);
    expect(parsed.max_tokens).toBe(42);
  });

  it('strips trailing slashes from the base URL', async () => {
    const transport = vi.fn().mockResolvedValue(reply('ok'));
    const client = new GigaChatChatClient({
      ...baseOpts,
      baseUrl: 'https://gigachat.example/v1///',
      transport,
    });

    await client.complete('p');

    const [url] = transport.mock.calls[0] as [string, string];
    expect(url).toBe('https://gigachat.example/v1/chat/completions');
  });
});
