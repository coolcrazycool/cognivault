/**
 * Raised by a format chunker when its input cannot be parsed at all —
 * a corrupt PDF, malformed JSON, a structurally invalid document.
 *
 * This is deliberately distinct from *valid but empty* input, which still yields
 * zero chunks. The pipeline treats "zero chunks" as "this file has no indexable
 * content" and deletes every vector belonging to the file; silently returning `[]`
 * for a broken parse therefore wipes the file out of the index. Throwing instead
 * lets the pipeline leave the existing vectors (and the indexed_files row) alone.
 */
export class ChunkParseError extends Error {
  readonly filename: string;

  constructor(message: string, filename: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ChunkParseError';
    this.filename = filename;
    // Explicit assignment keeps `cause` populated even when the runtime does not
    // honour ErrorOptions (older Node builds / transpiled targets).
    this.cause = options?.cause;
  }
}

export function isChunkParseError(err: unknown): err is ChunkParseError {
  return err instanceof ChunkParseError;
}
