import { describe, expect, it } from 'vitest';
import { countTokens, MAX_CHUNK_TOKENS } from '../chunker.js';
import { chunkCsv } from '../csv-chunker.js';

// Helper: build a CSV string with N rows and given headers
function makeCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.join(','), ...rows.map((r) => r.join(','))];
  return lines.join('\n');
}

/** A table wide enough that a 30-row batch would blow past the token budget. */
function makeWideCsv(rowCount: number, columns: number, repeats: number): string {
  const headers = Array.from({ length: columns }, (_, i) => `Колонка${i + 1}`);
  const rows = Array.from({ length: rowCount }, (_, r) =>
    headers.map((_, c) => `значение ${r}-${c} `.repeat(repeats).trim()),
  );
  return makeCsv(headers, rows);
}

/** `"Rows 4-9"` → `[4, 9]` — the row range a chunk claims in its breadcrumb. */
function rowRange(sectionPath: string): [number, number] {
  const match = /Rows (\d+)-(\d+)$/.exec(sectionPath);
  if (match === null) throw new Error(`no row range in "${sectionPath}"`);
  return [Number(match[1]), Number(match[2])];
}

describe('chunkCsv - basic chunking', () => {
  it('produces chunks with correct row-batch sectionPath', () => {
    const csv = makeCsv(
      ['Name', 'Age', 'City'],
      Array.from({ length: 60 }, (_, i) => [`Person${i + 1}`, `${20 + i}`, `City${i + 1}`]),
    );
    const chunks = chunkCsv(csv, 'data.csv');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.sectionPath).toBe('data.csv > Rows 1-30');
    expect(chunks[1]?.sectionPath).toBe('data.csv > Rows 31-60');
  });

  it('assigns sequential chunkIndex', () => {
    const csv = makeCsv(
      ['Name', 'Age'],
      Array.from({ length: 60 }, (_, i) => [`Person${i + 1}`, `${i}`]),
    );
    const chunks = chunkCsv(csv, 'data.csv');
    expect(chunks[0]?.chunkIndex).toBe(0);
    expect(chunks[1]?.chunkIndex).toBe(1);
  });

  it('formats each row as "Header: value" joined by comma-space', () => {
    const csv = makeCsv(['Name', 'Age', 'City'], [['Alice', '30', 'Paris']]);
    const chunks = chunkCsv(csv, 'test.csv');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('Name: Alice');
    expect(chunks[0]?.text).toContain('Age: 30');
    expect(chunks[0]?.text).toContain('City: Paris');
  });

  it('uses default batch size of 30 rows per chunk', () => {
    const csv = makeCsv(
      ['Col'],
      Array.from({ length: 31 }, (_, i) => [`val${i}`]),
    );
    const chunks = chunkCsv(csv, 'data.csv');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.sectionPath).toBe('data.csv > Rows 1-30');
    expect(chunks[1]?.sectionPath).toBe('data.csv > Rows 31-31');
  });

  it('respects custom batchSize', () => {
    const csv = makeCsv(
      ['Col'],
      Array.from({ length: 10 }, (_, i) => [`val${i}`]),
    );
    const chunks = chunkCsv(csv, 'data.csv', 5);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.sectionPath).toBe('data.csv > Rows 1-5');
    expect(chunks[1]?.sectionPath).toBe('data.csv > Rows 6-10');
  });
});

describe('chunkCsv - edge cases', () => {
  it('returns zero chunks for empty string input', () => {
    const chunks = chunkCsv('', 'empty.csv');
    expect(chunks).toHaveLength(0);
  });

  it('returns zero chunks for header-only CSV (no data rows)', () => {
    const csv = 'Name,Age,City';
    const chunks = chunkCsv(csv, 'headers-only.csv');
    expect(chunks).toHaveLength(0);
  });

  it('returns zero chunks for whitespace-only input', () => {
    const chunks = chunkCsv('   \n\n  ', 'whitespace.csv');
    expect(chunks).toHaveLength(0);
  });

  it('skips empty values in row formatting', () => {
    const csv = makeCsv(['Name', 'Age', 'Notes'], [['Bob', '25', '']]);
    const chunks = chunkCsv(csv, 'test.csv');
    expect(chunks).toHaveLength(1);
    const text = chunks[0]?.text ?? '';
    expect(text).toContain('Name: Bob');
    expect(text).toContain('Age: 25');
    // Empty "Notes" value should not appear
    expect(text).not.toContain('Notes:');
  });

  it('handles CSV with malformed rows gracefully - valid rows still chunked', () => {
    // PapaParse handles most malformed rows by best-effort parsing
    // A row with fewer columns than headers still parses; missing values become empty
    const csv = ['Name,Age,City', 'Alice,30,Paris', 'Bob', 'Charlie,25,London'].join('\n');
    const chunks = chunkCsv(csv, 'partial.csv');
    // Should have at least 1 chunk (Alice and Charlie are valid)
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const allText = chunks.map((c) => c.text).join('\n');
    expect(allText).toContain('Alice');
    expect(allText).toContain('Charlie');
  });

  it('each row in a batch appears on its own line', () => {
    const csv = makeCsv(
      ['Name', 'Age'],
      [
        ['Alice', '30'],
        ['Bob', '25'],
      ],
    );
    const chunks = chunkCsv(csv, 'test.csv');
    expect(chunks).toHaveLength(1);
    // Line 0 is the breadcrumb, line 1 the blank line that closes it.
    const lines = chunks[0]?.text.split('\n') ?? [];
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain('Alice');
    expect(lines[3]).toContain('Bob');
  });
});

describe('chunkCsv - token budget', () => {
  it('keeps every chunk of a wide table within MAX_CHUNK_TOKENS', () => {
    // 30 rows of this table are ~5000 tokens: the old row-count-only batching handed
    // the embedder a chunk it silently truncated — the tail stayed in the payload but
    // never reached the vector.
    const csv = makeWideCsv(60, 8, 3);
    const chunks = chunkCsv(csv, 'wide.csv');

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(countTokens(chunk.text)).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
    }
  });

  it('counts the breadcrumb against the budget, not just the rows', () => {
    // A long file name eats into the same budget, so the body must shrink to match.
    const filename = `${'очень-длинное-имя-файла-'.repeat(8)}.csv`;
    const chunks = chunkCsv(makeWideCsv(30, 6, 2), filename);

    for (const chunk of chunks) {
      expect(chunk.text.startsWith(`${chunk.sectionPath}\n\n`)).toBe(true);
      expect(countTokens(chunk.text)).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
    }
  });

  it('never splits a row between two batches and covers every row exactly once', () => {
    const rowCount = 40;
    const chunks = chunkCsv(makeWideCsv(rowCount, 6, 2), 'wide.csv');

    // Ranges are contiguous: 1-k, k+1-m, … up to the last row.
    let expectedStart = 1;
    for (const chunk of chunks) {
      const [start, end] = rowRange(chunk.sectionPath);
      expect(start).toBe(expectedStart);
      expect(end).toBeGreaterThanOrEqual(start);
      expectedStart = end + 1;
    }
    expect(expectedStart - 1).toBe(rowCount);

    // …and each row's values live in exactly one chunk, whole.
    for (let r = 0; r < rowCount; r++) {
      const marker = `значение ${r}-0`;
      const hits = chunks.filter((c) => c.text.includes(marker));
      expect(hits).toHaveLength(1);
    }
  });

  it('keeps batchSize as an upper bound when the budget is not the binding limit', () => {
    const csv = makeCsv(
      ['Col'],
      Array.from({ length: 12 }, (_, i) => [`val${i}`]),
    );
    const chunks = chunkCsv(csv, 'data.csv', 5);
    expect(chunks.map((c) => c.sectionPath)).toEqual([
      'data.csv > Rows 1-5',
      'data.csv > Rows 6-10',
      'data.csv > Rows 11-12',
    ]);
  });

  it('cuts a single row that alone exceeds the budget, keeping its row number', () => {
    const csv = makeCsv(['Текст'], [['слово '.repeat(1200).trim()], ['короткая строка']]);
    const chunks = chunkCsv(csv, 'huge.csv');

    const first = chunks.filter((c) => c.sectionPath === 'huge.csv > Rows 1-1');
    expect(first.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(countTokens(chunk.text)).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
    }
    // The next row still gets its own batch, numbered from where the split row ended.
    expect(chunks.at(-1)?.sectionPath).toBe('huge.csv > Rows 2-2');
    expect(chunks.at(-1)?.text).toContain('короткая строка');
  });

  it('assigns a sequential chunkIndex across split rows too', () => {
    const csv = makeCsv(['Текст'], [['слово '.repeat(1200).trim()], ['короткая строка']]);
    const chunks = chunkCsv(csv, 'huge.csv');
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });
});

describe('chunkCsv - breadcrumb', () => {
  it('opens every chunk with its sectionPath so the file name is searchable', () => {
    const csv = makeCsv(
      ['Name', 'Age'],
      Array.from({ length: 45 }, (_, i) => [`Person${i + 1}`, `${20 + i}`]),
    );
    const chunks = chunkCsv(csv, 'tariffs');

    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      // Without this a row batch says "Name: Person7, Age: 26" and nothing else — the
      // file name and the row range live only in the payload, so neither is findable.
      expect(chunk.text.startsWith(`${chunk.sectionPath}\n\n`)).toBe(true);
      expect(chunk.text).toContain('tariffs');
    }
  });
});
