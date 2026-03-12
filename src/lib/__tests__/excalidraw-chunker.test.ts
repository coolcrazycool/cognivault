import { describe, expect, it } from 'vitest';
import { chunkExcalidraw } from '../excalidraw-chunker.js';

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
    expect(chunks[0]?.text).toBe('Hello excalidraw');
  });
});

describe('chunkExcalidraw - element type filtering', () => {
  it('skips rectangle elements', () => {
    const file = makeExcalidraw([shapeElement('1', 'rectangle'), textElement('2', 'Only text')]);

    const chunks = chunkExcalidraw(file, 'MyDrawing');
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.text).toBe('Only text');
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
    expect(chunks[0]?.text).toBe('Live text');
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
    expect(chunks[0]?.text).toBe('OK\nYes');
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

describe('chunkExcalidraw - error handling', () => {
  it('returns zero chunks for invalid JSON without throwing', () => {
    expect(() => chunkExcalidraw('not valid json {{{', 'MyDrawing')).not.toThrow();
    expect(chunkExcalidraw('not valid json {{{', 'MyDrawing')).toEqual([]);
  });

  it('returns zero chunks for empty string without throwing', () => {
    expect(() => chunkExcalidraw('', 'MyDrawing')).not.toThrow();
    expect(chunkExcalidraw('', 'MyDrawing')).toEqual([]);
  });

  it('returns zero chunks when elements field is missing', () => {
    const file = JSON.stringify({ type: 'excalidraw', version: 2 });
    expect(chunkExcalidraw(file, 'MyDrawing')).toEqual([]);
  });

  it('returns zero chunks when elements is not an array', () => {
    const file = JSON.stringify({ type: 'excalidraw', version: 2, elements: 'not-an-array' });
    expect(chunkExcalidraw(file, 'MyDrawing')).toEqual([]);
  });
});
