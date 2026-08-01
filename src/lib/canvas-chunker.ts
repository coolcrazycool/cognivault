// Canvas JSON text node extractor
// Parses Obsidian .canvas files (JSON Canvas 1.0 spec) and extracts text nodes as chunks.

import { ChunkParseError } from './chunk-errors.js';
import {
  breadcrumbBodyBudget,
  type ContentKind,
  splitTextByTokenBudget,
  withBreadcrumb,
} from './chunker.js';

// ── Type guards ──

interface CanvasNode {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
}

function isCanvasObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── Chunk shape (same as MarkdownChunk) ──

export interface CanvasChunk {
  text: string;
  sectionPath: string;
  chunkIndex: number;
  /** Canvas nodes are always free text; kept so the payload shape matches markdown. */
  contentKind: ContentKind;
}

// ── Main export ──

/**
 * Extract text nodes from a Canvas JSON file and return one chunk per node.
 *
 * Only nodes with type='text' and non-empty text are indexed.
 * File, link, and group nodes are skipped.
 *
 * Valid-but-empty input yields zero chunks: a blank file, or an object without a
 * `nodes` key (a freshly created canvas). Structurally broken input — unparsable
 * JSON, a non-object document, or a `nodes` key that is not an array — throws
 * {@link ChunkParseError} so the pipeline does not mistake it for an empty file
 * and delete the file's vectors.
 */
export function chunkCanvas(content: string, canvasName: string): CanvasChunk[] {
  if (content.trim().length === 0) {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (err: unknown) {
    throw new ChunkParseError(`Invalid JSON in canvas "${canvasName}"`, canvasName, { cause: err });
  }

  if (!isCanvasObject(parsed)) {
    throw new ChunkParseError(
      `Canvas "${canvasName}" is not a JSON Canvas document`,
      canvasName,
      {},
    );
  }

  if (parsed.nodes === undefined) {
    // Canvas with no nodes yet — valid, simply nothing to index.
    return [];
  }

  if (!Array.isArray(parsed.nodes)) {
    throw new ChunkParseError(
      `Canvas "${canvasName}" has a non-array "nodes" field`,
      canvasName,
      {},
    );
  }

  const nodes = parsed.nodes as CanvasNode[];
  const chunks: CanvasChunk[] = [];
  let nodeNumber = 0;

  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue;
    if (node.type !== 'text') continue;
    if (!node.text) continue;

    const trimmed = node.text.trim();
    if (trimmed.length === 0) continue;

    nodeNumber++;
    // A canvas node holds arbitrarily much markdown; anything over the budget is cut
    // on paragraph boundaries. All parts keep the node's path — chunkIndex separates
    // them — and every part opens with the breadcrumb, so a node found by canvas name
    // stays findable no matter which part matched.
    const sectionPath = `${canvasName} > Node ${nodeNumber}`;
    for (const text of splitTextByTokenBudget(trimmed, breadcrumbBodyBudget(sectionPath))) {
      chunks.push({
        text: withBreadcrumb(sectionPath, text),
        sectionPath,
        chunkIndex: chunks.length,
        contentKind: 'text',
      });
    }
  }

  return chunks;
}
