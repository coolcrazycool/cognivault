// Canvas JSON text node extractor
// Parses Obsidian .canvas files (JSON Canvas 1.0 spec) and extracts text nodes as chunks.

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

interface CanvasFile {
  nodes: CanvasNode[];
  edges?: unknown[];
}

function isCanvasFile(value: unknown): value is CanvasFile {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj['nodes']);
}

// ── Chunk shape (same as MarkdownChunk) ──

export interface CanvasChunk {
  text: string;
  sectionPath: string;
  chunkIndex: number;
}

// ── Main export ──

/**
 * Extract text nodes from a Canvas JSON file and return one chunk per node.
 *
 * Only nodes with type='text' and non-empty text are indexed.
 * File, link, and group nodes are skipped.
 * Invalid JSON returns an empty array without throwing.
 */
export function chunkCanvas(content: string, canvasName: string): CanvasChunk[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }

  if (!isCanvasFile(parsed)) {
    return [];
  }

  const chunks: CanvasChunk[] = [];
  let nodeNumber = 0;

  for (const node of parsed.nodes) {
    if (node.type !== 'text') continue;
    if (!node.text) continue;

    const trimmed = node.text.trim();
    if (trimmed.length === 0) continue;

    nodeNumber++;
    chunks.push({
      text: trimmed,
      sectionPath: `${canvasName} > Node ${nodeNumber}`,
      chunkIndex: nodeNumber - 1,
    });
  }

  return chunks;
}
