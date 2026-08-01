import { getEncoding } from 'js-tiktoken';
import { describe, expect, it } from 'vitest';
import { ChunkParseError, isChunkParseError } from '../chunk-errors.js';
import { MAX_CHUNK_TOKENS } from '../chunker.js';
import { chunkExcalidraw } from '../excalidraw-chunker.js';

const enc = getEncoding('cl100k_base');

function countTokens(text: string): number {
  return enc.encode(text).length;
}

/** ~130 cl100k tokens — well under the chunk budget on its own. */
function paragraph(marker: string): string {
  return `${marker} ${Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ')}`;
}

/** Chunk text with its breadcrumb line stripped off. */
function bodyOf(chunk: { text: string; sectionPath: string }): string {
  return chunk.text.slice(`${chunk.sectionPath}\n\n`.length);
}

// Helper: build a minimal Excalidraw JSON string
function makeExcalidraw(elements: object[]): string {
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    elements,
  });
}

function textElement(id: string, text: string, overrides: object = {}): object {
  return {
    id,
    type: 'text',
    text,
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    ...overrides,
  };
}

function shapeElement(id: string, type: string = 'rectangle'): object {
  return { id, type, x: 0, y: 0, width: 100, height: 100 };
}

// Long enough to avoid short-element merging (>=5 tokens each)
const LONG_TEXT_1 = 'This element contains enough tokens to stand alone';
const LONG_TEXT_2 = 'Another element with sufficient token count to avoid merging';
const LONG_TEXT_3 = 'Third element also long enough to remain separate from others';

describe('chunkExcalidraw - text element extraction', () => {
  it('produces one chunk per text element (with long-enough texts)', () => {
    const file = makeExcalidraw([
      textElement('1', LONG_TEXT_1),
      textElement('2', LONG_TEXT_2),
      textElement('3', LONG_TEXT_3),
    ]);

    const chunks = chunkExcalidraw(file, 'MyDrawing');
    expect(chunks.length).toBe(3);
  });

  it('assigns sectionPath "DrawingName > Text N" (1-based)', () => {
    const file = makeExcalidraw([
      textElement('1', LONG_TEXT_1),
      textElement('2', LONG_TEXT_2),
      textElement('3', LONG_TEXT_3),
    ]);

    const chunks = chunkExcalidraw(file, 'MyDrawing');
    expect(chunks[0]?.sectionPath).toBe('MyDrawing > Text 1');
    expect(chunks[1]?.sectionPath).toBe('MyDrawing > Text 2');
    expect(chunks[2]?.sectionPath).toBe('MyDrawing > Text 3');
  });

  it('assigns sequential chunkIndex starting at 0', () => {
    const file = makeExcalidraw([textElement('1', LONG_TEXT_1), textElement('2', LONG_TEXT_2)]);

    const chunks = chunkExcalidraw(file, 'MyDrawing');
    expect(chunks[0]?.chunkIndex).toBe(0);
    expect(chunks[1]?.chunkIndex).toBe(1);
  });

  it('includes trimmed element text in chunk text', () => {
    const file = makeExcalidraw([textElement('1', '  Hello excalidraw  ')]);
    const chunks = chunkExcalidraw(file, 'MyDrawing');
    expect(chunks[0]?.text).toBe('MyDrawing > Text 1\n\nHello excalidraw');
  });
});

describe('chunkExcalidraw - element type filtering', () => {
  it('skips rectangle elements', () => {
    const file = makeExcalidraw([shapeElement('1', 'rectangle'), textElement('2', 'Only text')]);

    const chunks = chunkExcalidraw(file, 'MyDrawing');
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.text).toBe('MyDrawing > Text 1\n\nOnly text');
  });

  it('skips arrow elements', () => {
    const file = makeExcalidraw([shapeElement('1', 'arrow'), textElement('2', 'Only text')]);

    const chunks = chunkExcalidraw(file, 'MyDrawing');
    expect(chunks.length).toBe(1);
  });

  it('skips ellipse elements', () => {
    const file = makeExcalidraw([shapeElement('1', 'ellipse'), textElement('2', 'Only text')]);

    const chunks = chunkExcalidraw(file, 'MyDrawing');
    expect(chunks.length).toBe(1);
  });

  it('skips deleted elements (isDeleted: true)', () => {
    const file = makeExcalidraw([
      textElement('1', 'Deleted text', { isDeleted: true }),
      textElement('2', 'Live text'),
    ]);

    const chunks = chunkExcalidraw(file, 'MyDrawing');
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.text).toBe('MyDrawing > Text 1\n\nLive text');
  });

  it('skips empty text elements', () => {
    const file = makeExcalidraw([textElement('1', ''), textElement('2', 'Valid text')]);

    const chunks = chunkExcalidraw(file, 'MyDrawing');
    expect(chunks.length).toBe(1);
  });

  it('skips whitespace-only text elements', () => {
    const file = makeExcalidraw([textElement('1', '   \n   '), textElement('2', 'Valid text')]);

    const chunks = chunkExcalidraw(file, 'MyDrawing');
    expect(chunks.length).toBe(1);
  });
});

describe('chunkExcalidraw - short element merging', () => {
  // Very short text = fewer than 5 tokens
  // Single short words like "OK", "Yes" are under 5 tokens each

  it('merges two adjacent very short text elements into one chunk', () => {
    const file = makeExcalidraw([
      textElement('1', 'OK'), // 1 token
      textElement('2', 'Yes'), // 1 token
    ]);

    const chunks = chunkExcalidraw(file, 'MyDrawing');
    // Both are short; they should be merged into a single chunk
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.text).toContain('OK');
    expect(chunks[0]?.text).toContain('Yes');
  });

  it('merged short elements are joined with newline', () => {
    const file = makeExcalidraw([textElement('1', 'OK'), textElement('2', 'Yes')]);

    const chunks = chunkExcalidraw(file, 'MyDrawing');
    expect(chunks[0]?.text).toBe('MyDrawing > Text 1\n\nOK\nYes');
  });

  it('does not merge elements that exceed 5 tokens', () => {
    // A text with well over 5 tokens
    const longText =
      'This is a longer sentence with many tokens that definitely exceeds five tokens total.';
    const file = makeExcalidraw([textElement('1', longText), textElement('2', longText)]);

    const chunks = chunkExcalidraw(file, 'MyDrawing');
    // Each is standalone (>5 tokens)
    expect(chunks.length).toBe(2);
  });

  it('returns zero chunks for file with no text elements', () => {
    const file = makeExcalidraw([shapeElement('1', 'rectangle'), shapeElement('2', 'arrow')]);

    const chunks = chunkExcalidraw(file, 'MyDrawing');
    expect(chunks).toEqual([]);
  });
});

describe('chunkExcalidraw - chunk size budget', () => {
  const paragraphs = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map(paragraph);
  const longText = paragraphs.join('\n\n');

  function drawingWithLongElement(): string {
    return makeExcalidraw([textElement('1', longText), textElement('2', LONG_TEXT_2)]);
  }

  it('splits an element that exceeds MAX_CHUNK_TOKENS', () => {
    const chunks = chunkExcalidraw(drawingWithLongElement(), 'MyDrawing');
    expect(countTokens(longText)).toBeGreaterThan(MAX_CHUNK_TOKENS);
    expect(chunks.length).toBeGreaterThan(2);
  });

  it('keeps every chunk within MAX_CHUNK_TOKENS', () => {
    for (const chunk of chunkExcalidraw(drawingWithLongElement(), 'MyDrawing')) {
      expect(countTokens(chunk.text)).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
    }
  });

  it('cuts on paragraph boundaries, never inside a paragraph', () => {
    const chunks = chunkExcalidraw(drawingWithLongElement(), 'MyDrawing');
    const parts = chunks.filter((chunk) => chunk.sectionPath === 'MyDrawing > Text 1');

    expect(parts.map(bodyOf).join('\n\n')).toBe(longText);
    for (const part of parts) {
      for (const line of bodyOf(part).split('\n\n')) {
        expect(paragraphs).toContain(line);
      }
    }
  });

  it('opens every part with the breadcrumb, not only the first', () => {
    for (const chunk of chunkExcalidraw(drawingWithLongElement(), 'MyDrawing')) {
      expect(chunk.text.startsWith(`${chunk.sectionPath}\n\n`)).toBe(true);
    }
  });

  it('keeps the element path on every part and renumbers chunkIndex sequentially', () => {
    const chunks = chunkExcalidraw(drawingWithLongElement(), 'MyDrawing');

    expect(chunks.filter((c) => c.sectionPath === 'MyDrawing > Text 1').length).toBeGreaterThan(1);
    expect(chunks[chunks.length - 1]?.sectionPath).toBe('MyDrawing > Text 2');
    chunks.forEach((chunk, idx) => {
      expect(chunk.chunkIndex).toBe(idx);
    });
  });

  it('marks drawing chunks as text content', () => {
    const chunks = chunkExcalidraw(drawingWithLongElement(), 'MyDrawing');
    expect(chunks.every((chunk) => chunk.contentKind === 'text')).toBe(true);
  });
});

describe('chunkExcalidraw - error handling', () => {
  // A broken parse must be distinguishable from "this drawing has no text": the pipeline
  // deletes every vector of a file that yields zero chunks.
  it('throws ChunkParseError for invalid JSON', () => {
    expect(() => chunkExcalidraw('not valid json {{{', 'MyDrawing')).toThrow(ChunkParseError);
    try {
      chunkExcalidraw('not valid json {{{', 'MyDrawing');
    } catch (err) {
      expect(isChunkParseError(err)).toBe(true);
      expect((err as ChunkParseError).filename).toBe('MyDrawing');
      expect((err as ChunkParseError).cause).toBeInstanceOf(Error);
    }
  });

  it('throws ChunkParseError when the document is not an object', () => {
    expect(() => chunkExcalidraw('"just a string"', 'MyDrawing')).toThrow(ChunkParseError);
  });

  it('throws ChunkParseError when elements is not an array', () => {
    const file = JSON.stringify({ type: 'excalidraw', version: 2, elements: 'not-an-array' });
    expect(() => chunkExcalidraw(file, 'MyDrawing')).toThrow(ChunkParseError);
  });

  it('returns zero chunks for empty string without throwing (valid-empty file)', () => {
    expect(() => chunkExcalidraw('', 'MyDrawing')).not.toThrow();
    expect(chunkExcalidraw('', 'MyDrawing')).toEqual([]);
  });

  it('returns zero chunks when elements field is missing', () => {
    const file = JSON.stringify({ type: 'excalidraw', version: 2 });
    expect(chunkExcalidraw(file, 'MyDrawing')).toEqual([]);
  });
});
