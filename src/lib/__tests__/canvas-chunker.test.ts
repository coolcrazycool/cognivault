import { getEncoding } from 'js-tiktoken';
import { describe, expect, it } from 'vitest';
import { chunkCanvas } from '../canvas-chunker.js';
import { ChunkParseError, isChunkParseError } from '../chunk-errors.js';
import { MAX_CHUNK_TOKENS } from '../chunker.js';

const enc = getEncoding('cl100k_base');

function countTokens(text: string): number {
  return enc.encode(text).length;
}

/** ~130 cl100k tokens — well under the chunk budget on its own. */
function paragraph(marker: string): string {
  return `${marker} ${Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ')}`;
}

describe('chunkCanvas - text node extraction', () => {
  it('produces one chunk per text node', () => {
    const canvas = JSON.stringify({
      nodes: [
        { id: '1', type: 'text', x: 0, y: 0, width: 100, height: 100, text: 'First node' },
        { id: '2', type: 'text', x: 200, y: 0, width: 100, height: 100, text: 'Second node' },
        { id: '3', type: 'text', x: 400, y: 0, width: 100, height: 100, text: 'Third node' },
      ],
    });

    const chunks = chunkCanvas(canvas, 'MyCanvas');
    expect(chunks.length).toBe(3);
  });

  it('assigns correct sectionPath with 1-based node number', () => {
    const canvas = JSON.stringify({
      nodes: [
        { id: '1', type: 'text', x: 0, y: 0, width: 100, height: 100, text: 'Alpha' },
        { id: '2', type: 'text', x: 200, y: 0, width: 100, height: 100, text: 'Beta' },
        { id: '3', type: 'text', x: 400, y: 0, width: 100, height: 100, text: 'Gamma' },
      ],
    });

    const chunks = chunkCanvas(canvas, 'MyCanvas');
    expect(chunks[0]?.sectionPath).toBe('MyCanvas > Node 1');
    expect(chunks[1]?.sectionPath).toBe('MyCanvas > Node 2');
    expect(chunks[2]?.sectionPath).toBe('MyCanvas > Node 3');
  });

  it('assigns sequential chunkIndex starting at 0', () => {
    const canvas = JSON.stringify({
      nodes: [
        { id: '1', type: 'text', x: 0, y: 0, width: 100, height: 100, text: 'Alpha' },
        { id: '2', type: 'text', x: 200, y: 0, width: 100, height: 100, text: 'Beta' },
      ],
    });

    const chunks = chunkCanvas(canvas, 'MyCanvas');
    expect(chunks[0]?.chunkIndex).toBe(0);
    expect(chunks[1]?.chunkIndex).toBe(1);
  });

  it('includes trimmed node text in chunk text', () => {
    const canvas = JSON.stringify({
      nodes: [
        {
          id: '1',
          type: 'text',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          text: '  Hello canvas world  ',
        },
      ],
    });

    const chunks = chunkCanvas(canvas, 'MyCanvas');
    expect(chunks[0]?.text).toBe('Hello canvas world');
  });
});

describe('chunkCanvas - chunk size budget', () => {
  const paragraphs = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map(paragraph);
  const longText = paragraphs.join('\n\n');

  function canvasWithLongNode(): string {
    return JSON.stringify({
      nodes: [
        { id: '1', type: 'text', x: 0, y: 0, width: 100, height: 100, text: longText },
        { id: '2', type: 'text', x: 200, y: 0, width: 100, height: 100, text: 'Short tail node' },
      ],
    });
  }

  it('splits a node that exceeds MAX_CHUNK_TOKENS', () => {
    const chunks = chunkCanvas(canvasWithLongNode(), 'MyCanvas');
    expect(countTokens(longText)).toBeGreaterThan(MAX_CHUNK_TOKENS);
    expect(chunks.length).toBeGreaterThan(2);
  });

  it('keeps every chunk within MAX_CHUNK_TOKENS', () => {
    for (const chunk of chunkCanvas(canvasWithLongNode(), 'MyCanvas')) {
      expect(countTokens(chunk.text)).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
    }
  });

  it('cuts on paragraph boundaries, never inside a paragraph', () => {
    const chunks = chunkCanvas(canvasWithLongNode(), 'MyCanvas');
    const parts = chunks.filter((chunk) => chunk.sectionPath === 'MyCanvas > Node 1');

    expect(parts.map((part) => part.text).join('\n\n')).toBe(longText);
    for (const part of parts) {
      for (const line of part.text.split('\n\n')) {
        expect(paragraphs).toContain(line);
      }
    }
  });

  it('keeps the node path on every part and renumbers chunkIndex sequentially', () => {
    const chunks = chunkCanvas(canvasWithLongNode(), 'MyCanvas');

    expect(chunks.filter((c) => c.sectionPath === 'MyCanvas > Node 1').length).toBeGreaterThan(1);
    expect(chunks[chunks.length - 1]?.sectionPath).toBe('MyCanvas > Node 2');
    chunks.forEach((chunk, idx) => {
      expect(chunk.chunkIndex).toBe(idx);
    });
  });

  it('marks canvas chunks as text content', () => {
    const chunks = chunkCanvas(canvasWithLongNode(), 'MyCanvas');
    expect(chunks.every((chunk) => chunk.contentKind === 'text')).toBe(true);
  });
});

describe('chunkCanvas - node type filtering', () => {
  it('skips file nodes (type="file")', () => {
    const canvas = JSON.stringify({
      nodes: [
        { id: '1', type: 'file', x: 0, y: 0, width: 100, height: 100, file: 'notes/page.md' },
        { id: '2', type: 'text', x: 200, y: 0, width: 100, height: 100, text: 'Text only' },
      ],
    });

    const chunks = chunkCanvas(canvas, 'MyCanvas');
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.text).toBe('Text only');
  });

  it('skips link nodes (type="link")', () => {
    const canvas = JSON.stringify({
      nodes: [
        {
          id: '1',
          type: 'link',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          url: 'https://example.com',
        },
        { id: '2', type: 'text', x: 200, y: 0, width: 100, height: 100, text: 'Text only' },
      ],
    });

    const chunks = chunkCanvas(canvas, 'MyCanvas');
    expect(chunks.length).toBe(1);
  });

  it('skips group nodes (type="group")', () => {
    const canvas = JSON.stringify({
      nodes: [
        { id: '1', type: 'group', x: 0, y: 0, width: 300, height: 300, label: 'My Group' },
        { id: '2', type: 'text', x: 200, y: 0, width: 100, height: 100, text: 'Text only' },
      ],
    });

    const chunks = chunkCanvas(canvas, 'MyCanvas');
    expect(chunks.length).toBe(1);
  });
});

describe('chunkCanvas - empty and whitespace handling', () => {
  it('skips text nodes with empty text', () => {
    const canvas = JSON.stringify({
      nodes: [
        { id: '1', type: 'text', x: 0, y: 0, width: 100, height: 100, text: '' },
        { id: '2', type: 'text', x: 200, y: 0, width: 100, height: 100, text: 'Valid text' },
      ],
    });

    const chunks = chunkCanvas(canvas, 'MyCanvas');
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.text).toBe('Valid text');
  });

  it('skips text nodes with whitespace-only text', () => {
    const canvas = JSON.stringify({
      nodes: [
        { id: '1', type: 'text', x: 0, y: 0, width: 100, height: 100, text: '   \n\t  ' },
        { id: '2', type: 'text', x: 200, y: 0, width: 100, height: 100, text: 'Valid text' },
      ],
    });

    const chunks = chunkCanvas(canvas, 'MyCanvas');
    expect(chunks.length).toBe(1);
  });

  it('returns empty array for canvas with no text nodes', () => {
    const canvas = JSON.stringify({
      nodes: [
        { id: '1', type: 'file', x: 0, y: 0, width: 100, height: 100, file: 'notes/page.md' },
      ],
    });

    const chunks = chunkCanvas(canvas, 'MyCanvas');
    expect(chunks).toEqual([]);
  });

  it('returns empty array for empty nodes array', () => {
    const canvas = JSON.stringify({ nodes: [] });
    const chunks = chunkCanvas(canvas, 'MyCanvas');
    expect(chunks).toEqual([]);
  });
});

describe('chunkCanvas - error handling', () => {
  // A broken parse must be distinguishable from "this canvas has no text": the pipeline
  // deletes every vector of a file that yields zero chunks.
  it('throws ChunkParseError for invalid JSON', () => {
    expect(() => chunkCanvas('not valid json {{{', 'MyCanvas')).toThrow(ChunkParseError);
    try {
      chunkCanvas('not valid json {{{', 'MyCanvas');
    } catch (err) {
      expect(isChunkParseError(err)).toBe(true);
      expect((err as ChunkParseError).filename).toBe('MyCanvas');
      expect((err as ChunkParseError).cause).toBeInstanceOf(Error);
    }
  });

  it('throws ChunkParseError when the document is not an object', () => {
    expect(() => chunkCanvas('[1, 2, 3]', 'MyCanvas')).toThrow(ChunkParseError);
  });

  it('throws ChunkParseError when nodes is not an array', () => {
    const canvas = JSON.stringify({ nodes: 'not-an-array' });
    expect(() => chunkCanvas(canvas, 'MyCanvas')).toThrow(ChunkParseError);
  });

  it('returns zero chunks for empty string without throwing (valid-empty file)', () => {
    expect(() => chunkCanvas('', 'MyCanvas')).not.toThrow();
    expect(chunkCanvas('', 'MyCanvas')).toEqual([]);
  });

  it('returns zero chunks when nodes field is missing (freshly created canvas)', () => {
    const canvas = JSON.stringify({ edges: [] });
    expect(chunkCanvas(canvas, 'MyCanvas')).toEqual([]);
  });
});
