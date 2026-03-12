import { describe, expect, it } from 'vitest';
import { chunkCsv } from '../csv-chunker.js';

// Helper: build a CSV string with N rows and given headers
function makeCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.join(','), ...rows.map((r) => r.join(','))];
  return lines.join('\n');
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
    const lines = chunks[0]?.text.split('\n') ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Alice');
    expect(lines[1]).toContain('Bob');
  });
});
