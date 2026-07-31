// Excalidraw JSON text element extractor
// Parses .excalidraw files and extracts text elements as chunks.
// Very short adjacent text elements (<5 tokens each) are merged into a single chunk.

import { getEncoding } from 'js-tiktoken';
import { ChunkParseError } from './chunk-errors.js';

// Initialize encoder once at module level (matches chunker.ts)
const enc = getEncoding('cl100k_base');

// ── Type guards ──

interface ExcalidrawElement {
  id: string;
  type: string;
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
}

function isExcalidrawObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── Chunk shape (same as MarkdownChunk) ──

export interface ExcalidrawChunk {
  text: string;
  sectionPath: string;
  chunkIndex: number;
}

// ── Token counting ──

const SHORT_ELEMENT_TOKEN_THRESHOLD = 5;

function countTokens(text: string): number {
  return enc.encode(text).length;
}

// ── Main export ──

/**
 * Extract text elements from an Excalidraw JSON file and return chunks.
 *
 * Only elements with type='text', isDeleted != true, and non-empty text are indexed.
 * Adjacent very short elements (<5 tokens each) are merged with a newline separator.
 *
 * Valid-but-empty input yields zero chunks: a blank file, or an object with no
 * `elements` key. Structurally broken input — unparsable JSON, a non-object
 * document, or an `elements` key that is not an array — throws
 * {@link ChunkParseError} so the pipeline does not mistake it for an empty file
 * and delete the file's vectors.
 */
export function chunkExcalidraw(content: string, drawingName: string): ExcalidrawChunk[] {
  if (content.trim().length === 0) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (err: unknown) {
    throw new ChunkParseError(`Invalid JSON in drawing "${drawingName}"`, drawingName, {
      cause: err,
    });
  }

  if (!isExcalidrawObject(parsed)) {
    throw new ChunkParseError(
      `Drawing "${drawingName}" is not an Excalidraw document`,
      drawingName,
      {},
    );
  }

  if (parsed.elements === undefined) {
    // Drawing with no elements yet — valid, simply nothing to index.
    return [];
  }

  if (!Array.isArray(parsed.elements)) {
    throw new ChunkParseError(
      `Drawing "${drawingName}" has a non-array "elements" field`,
      drawingName,
      {},
    );
  }

  // Filter qualifying text elements
  const textElements: string[] = [];
  for (const el of parsed.elements as ExcalidrawElement[]) {
    if (typeof el !== 'object' || el === null) continue;
    if (el.type !== 'text') continue;
    if (el.isDeleted === true) continue;
    if (!el.text) continue;

    const trimmed = el.text.trim();
    if (trimmed.length === 0) continue;

    textElements.push(trimmed);
  }

  if (textElements.length === 0) {
    return [];
  }

  // Merge short adjacent elements
  // Walk through textElements; accumulate runs of short elements into one group.
  // A "short" element has fewer than SHORT_ELEMENT_TOKEN_THRESHOLD tokens.
  const groups: string[] = [];
  let accumulator: string[] = [];

  for (const text of textElements) {
    const tokens = countTokens(text);

    if (tokens < SHORT_ELEMENT_TOKEN_THRESHOLD) {
      // Short element: add to current accumulator
      accumulator.push(text);
    } else {
      // Long element: flush accumulator first, then add this element as its own group
      if (accumulator.length > 0) {
        groups.push(accumulator.join('\n'));
        accumulator = [];
      }
      groups.push(text);
    }
  }

  // Flush any remaining accumulator
  if (accumulator.length > 0) {
    groups.push(accumulator.join('\n'));
  }

  // Build chunks from groups
  return groups.map((text, idx) => ({
    text,
    sectionPath: `${drawingName} > Text ${idx + 1}`,
    chunkIndex: idx,
  }));
}
