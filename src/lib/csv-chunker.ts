import Papa from 'papaparse';
import {
  breadcrumbBodyBudget,
  countTokens,
  MAX_CHUNK_TOKENS,
  splitTextByTokenBudget,
  withBreadcrumb,
} from './chunker.js';

export interface CsvChunkOptions {
  batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 30;

interface CsvChunk {
  text: string;
  sectionPath: string;
  chunkIndex: number;
}

/** `"filename > Rows N-M"` — the breadcrumb and the payload path of a row batch. */
function rowRangePath(filename: string, startRow: number, endRow: number): string {
  return `${filename} > Rows ${startRow}-${endRow}`;
}

/** `"Header1: val1, Header2: val2"` — one CSV row as a line of text (empties dropped). */
function formatRow(row: Record<string, string>): string {
  return Object.entries(row)
    .filter(([, val]) => val !== undefined && val !== null && val.trim() !== '')
    .map(([header, val]) => `${header}: ${val}`)
    .join(', ');
}

/**
 * Emit one row batch, re-checking the budget on the real joined text.
 *
 * Packing works off per-line token counts, which can differ by a token or two from the
 * count of the joined string, so the guarantee is verified here rather than assumed. A
 * body that still overflows (a single row wider than the budget) is cut as text: better
 * a row split across two chunks than a tail that lives in the payload and never reaches
 * the vector.
 */
function pushBatch(
  chunks: CsvChunk[],
  filename: string,
  startRow: number,
  endRow: number,
  lines: string[],
): void {
  const sectionPath = rowRangePath(filename, startRow, endRow);
  const body = lines.join('\n');
  const budget = breadcrumbBodyBudget(sectionPath, MAX_CHUNK_TOKENS);
  const parts = countTokens(body) <= budget ? [body] : splitTextByTokenBudget(body, budget);

  for (const part of parts) {
    chunks.push({
      text: withBreadcrumb(sectionPath, part),
      sectionPath,
      chunkIndex: chunks.length,
    });
  }
}

/**
 * Chunks a CSV string into row-batch chunks matching the MarkdownChunk shape.
 *
 * - Parses with PapaParse (header mode)
 * - A batch closes on whichever limit comes first: the token budget
 *   ({@link MAX_CHUNK_TOKENS}, breadcrumb included) or `batchSize` rows. Counting rows
 *   alone is what let a wide table (many columns, long values) produce a chunk the
 *   embedder silently truncates — its tail sits in the payload but never in the vector
 * - A row is never split between batches; a single row that alone exceeds the budget is
 *   the one exception and is cut as text
 * - Default batch size: 30 rows per chunk (an upper bound, not the only criterion)
 * - sectionPath format: "filename > Rows N-M" (1-based row numbers), repeated as the
 *   chunk's first line: a batch of rows says nothing about which file it came from,
 *   so without the breadcrumb in the text the file name is unsearchable
 * - Each row formatted as "Header1: val1, Header2: val2" (empty values skipped)
 * - Empty/header-only CSV returns zero chunks
 * - Malformed rows logged as warnings; valid rows still chunked
 */
export function chunkCsv(
  content: string,
  filename: string,
  batchSize = DEFAULT_BATCH_SIZE,
): CsvChunk[] {
  if (!content || !content.trim()) {
    return [];
  }

  const result = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
  });

  // Log any parse errors as warnings
  if (result.errors.length > 0) {
    for (const err of result.errors) {
      console.warn(`[csv-chunker] Parse warning in ${filename}: ${err.message} (row ${err.row})`);
    }
  }

  const rows = result.data;
  if (rows.length === 0) {
    return [];
  }

  // One line per row, so a line's position is its row number — the batch boundaries
  // below are computed on rows, not on the formatted text.
  const lines = rows.map((row) => formatRow(row));
  const maxRows = Math.max(1, batchSize);
  const newlineTokens = countTokens('\n');

  const chunks: CsvChunk[] = [];
  let start = 0;

  while (start < lines.length) {
    // The budget is taken against the longest breadcrumb this batch could end up with
    // (the widest row range it is allowed to cover), so a shorter final range only ever
    // leaves the batch with more room than it used.
    const rowCap = Math.min(start + maxRows, lines.length);
    const budget = breadcrumbBodyBudget(
      rowRangePath(filename, start + 1, rowCap),
      MAX_CHUNK_TOKENS,
    );

    let end = start;
    let tokens = 0;
    while (end < rowCap) {
      const cost = countTokens(lines[end] as string) + (end > start ? newlineTokens : 0);
      if (end > start && tokens + cost > budget) break;
      tokens += cost;
      end += 1;
    }

    // A single row over the budget still has to be emitted; `pushBatch` cuts it as text.
    if (end === start) end = start + 1;

    pushBatch(chunks, filename, start + 1, end, lines.slice(start, end));
    start = end;
  }

  return chunks;
}
