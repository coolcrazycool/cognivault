// Excalidraw JSON text element extractor
// Parses .excalidraw files and extracts text elements as chunks.
// Very short adjacent text elements (<5 tokens each) are merged into a single chunk.

import { getEncoding } from 'js-tiktoken';

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

interface ExcalidrawFile {
  type: string;
  version: number;
  elements: ExcalidrawElement[];
}

function isExcalidrawFile(value: unknown): value is ExcalidrawFile {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.elements);
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
 * Invalid JSON returns an empty array without throwing.
 */
export function chunkExcalidraw(content: string, drawingName: string): ExcalidrawChunk[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }

  if (!isExcalidrawFile(parsed)) {
    return [];
  }

  // Filter qualifying text elements
  const textElements: string[] = [];
  for (const el of parsed.elements) {
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
