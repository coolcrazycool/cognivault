import Papa from 'papaparse';

export interface CsvChunkOptions {
  batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 30;

/**
 * Chunks a CSV string into row-batch chunks matching the MarkdownChunk shape.
 *
 * - Parses with PapaParse (header mode)
 * - Default batch size: 30 rows per chunk
 * - sectionPath format: "filename > Rows N-M" (1-based row numbers)
 * - Each row formatted as "Header1: val1, Header2: val2" (empty values skipped)
 * - Empty/header-only CSV returns zero chunks
 * - Malformed rows logged as warnings; valid rows still chunked
 */
export function chunkCsv(
  content: string,
  filename: string,
  batchSize = DEFAULT_BATCH_SIZE,
): Array<{ text: string; sectionPath: string; chunkIndex: number }> {
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

  const chunks: Array<{ text: string; sectionPath: string; chunkIndex: number }> = [];
  let chunkIndex = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const startRow = i + 1; // 1-based
    const endRow = i + batch.length;

    const lines = batch.map((row) => {
      const parts = Object.entries(row)
        .filter(([, val]) => val !== undefined && val !== null && val.trim() !== '')
        .map(([header, val]) => `${header}: ${val}`);
      return parts.join(', ');
    });

    const text = lines.join('\n');
    const sectionPath = `${filename} > Rows ${startRow}-${endRow}`;

    chunks.push({ text, sectionPath, chunkIndex });
    chunkIndex++;
  }

  return chunks;
}
