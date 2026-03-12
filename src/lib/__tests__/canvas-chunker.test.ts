import { describe, expect, it } from 'vitest';
import { chunkCanvas } from '../canvas-chunker.js';

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
  it('returns zero chunks for invalid JSON without throwing', () => {
    expect(() => chunkCanvas('not valid json {{{', 'MyCanvas')).not.toThrow();
    expect(chunkCanvas('not valid json {{{', 'MyCanvas')).toEqual([]);
  });

  it('returns zero chunks for empty string without throwing', () => {
    expect(() => chunkCanvas('', 'MyCanvas')).not.toThrow();
    expect(chunkCanvas('', 'MyCanvas')).toEqual([]);
  });

  it('returns zero chunks when nodes field is missing', () => {
    const canvas = JSON.stringify({ edges: [] });
    expect(chunkCanvas(canvas, 'MyCanvas')).toEqual([]);
  });

  it('returns zero chunks when nodes is not an array', () => {
    const canvas = JSON.stringify({ nodes: 'not-an-array' });
    expect(chunkCanvas(canvas, 'MyCanvas')).toEqual([]);
  });
});
