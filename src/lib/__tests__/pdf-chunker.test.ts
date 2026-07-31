import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock pdfjs-dist before importing the module under test
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  return {
    getDocument: vi.fn(),
    GlobalWorkerOptions: { workerSrc: '' },
  };
});

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ChunkParseError } from '../chunk-errors.js';
import { chunkPdf, extractPdfPages } from '../pdf-chunker.js';

// Helper to create a mock page with given text content
function makeMockPage(text: string) {
  return {
    getTextContent: vi.fn().mockResolvedValue({
      items: text ? [{ str: text }] : [],
    }),
  };
}

// Helper to create a mock PDF document
function makeMockDoc(pages: string[], metadata: Record<string, string | undefined> = {}) {
  const numPages = pages.length;
  const getPage = vi.fn().mockImplementation((n: number) => {
    return Promise.resolve(makeMockPage(pages[n - 1] ?? ''));
  });
  const getMetadata = vi.fn().mockResolvedValue({
    info: metadata,
  });
  return {
    numPages,
    getPage,
    getMetadata,
  };
}

// Helper to make getDocument return a mock promise-like object
function setupMockDoc(pages: string[], metadata: Record<string, string | undefined> = {}) {
  const mockDoc = makeMockDoc(pages, metadata);
  const mockGetDocument = vi.mocked(pdfjs.getDocument);
  mockGetDocument.mockReturnValue({
    promise: Promise.resolve(mockDoc),
  } as unknown as ReturnType<typeof pdfjs.getDocument>);
  return mockDoc;
}

// Generate text with exactly N words (each ~5 chars) to control token count
// Each "word" is roughly 1 token in cl100k_base
function generateText(approxTokens: number): string {
  const word = 'hello ';
  return word.repeat(approxTokens).trim();
}

describe('extractPdfPages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts pages from a multi-page PDF', async () => {
    setupMockDoc(['Page one text content', 'Page two text content', 'Page three text content']);
    const buffer = Buffer.from('fake pdf');
    const result = await extractPdfPages(buffer);
    expect(result.pages).toHaveLength(3);
    expect(result.pages[0]?.pageNum).toBe(1);
    expect(result.pages[0]?.text).toBe('Page one text content');
    expect(result.pages[1]?.pageNum).toBe(2);
    expect(result.pages[2]?.pageNum).toBe(3);
  });

  it('extracts PDF metadata (title, author, subject)', async () => {
    setupMockDoc(['Some text'], {
      Title: 'My Document',
      Author: 'John Doe',
      Subject: 'Testing',
    });
    const buffer = Buffer.from('fake pdf');
    const result = await extractPdfPages(buffer);
    expect(result.metadata.title).toBe('My Document');
    expect(result.metadata.author).toBe('John Doe');
    expect(result.metadata.subject).toBe('Testing');
  });

  it('handles missing metadata gracefully', async () => {
    setupMockDoc(['Some text'], {});
    const buffer = Buffer.from('fake pdf');
    const result = await extractPdfPages(buffer);
    expect(result.metadata.title).toBeUndefined();
    expect(result.metadata.author).toBeUndefined();
    expect(result.metadata.subject).toBeUndefined();
  });

  it('includes tokenCount in each page', async () => {
    setupMockDoc(['hello world']);
    const buffer = Buffer.from('fake pdf');
    const result = await extractPdfPages(buffer);
    expect(result.pages[0]?.tokenCount).toBeGreaterThan(0);
  });
});

describe('chunkPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('produces one chunk per page with correct sectionPath', async () => {
    setupMockDoc([generateText(50), generateText(50), generateText(50)]);
    const buffer = Buffer.from('fake pdf');
    const chunks = await chunkPdf(buffer, 'document.pdf');
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.sectionPath).toBe('document.pdf > Page 1');
    expect(chunks[1]?.sectionPath).toBe('document.pdf > Page 2');
    expect(chunks[2]?.sectionPath).toBe('document.pdf > Page 3');
  });

  it('assigns sequential chunkIndex across all pages', async () => {
    setupMockDoc([generateText(50), generateText(50), generateText(50)]);
    const buffer = Buffer.from('fake pdf');
    const chunks = await chunkPdf(buffer, 'document.pdf');
    expect(chunks[0]?.chunkIndex).toBe(0);
    expect(chunks[1]?.chunkIndex).toBe(1);
    expect(chunks[2]?.chunkIndex).toBe(2);
  });

  it('skips pages with fewer than 10 tokens (scanned headers/footers)', async () => {
    setupMockDoc([
      'tiny', // < 10 tokens - should be skipped
      generateText(50), // normal page
      'skip', // < 10 tokens - skipped
    ]);
    const buffer = Buffer.from('fake pdf');
    const chunks = await chunkPdf(buffer, 'document.pdf');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.sectionPath).toBe('document.pdf > Page 2');
    // chunkIndex must still be sequential (reset from 0 for included chunks)
    expect(chunks[0]?.chunkIndex).toBe(0);
  });

  it('returns zero chunks for scanned PDF (all pages empty)', async () => {
    setupMockDoc(['', '', '']);
    const buffer = Buffer.from('fake pdf');
    const chunks = await chunkPdf(buffer, 'document.pdf');
    expect(chunks).toHaveLength(0);
  });

  it('splits a page over 500 tokens at paragraph boundaries', async () => {
    // Create a page with ~600 tokens split by double-newline paragraphs
    const para1 = generateText(300);
    const para2 = generateText(350);
    const longPageText = `${para1}\n\n${para2}`;
    setupMockDoc([longPageText]);
    const buffer = Buffer.from('fake pdf');
    const chunks = await chunkPdf(buffer, 'document.pdf');
    // Should produce 2 sub-chunks from the single page
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Both sub-chunks get the same sectionPath (same page)
    for (const chunk of chunks) {
      expect(chunk.sectionPath).toBe('document.pdf > Page 1');
    }
  });

  it('throws ChunkParseError for an empty buffer or corrupt PDF', async () => {
    const mockGetDocument = vi.mocked(pdfjs.getDocument);
    mockGetDocument.mockReturnValue({
      promise: Promise.reject(new Error('Invalid PDF structure')),
    } as unknown as ReturnType<typeof pdfjs.getDocument>);
    const buffer = Buffer.from('');

    // Returning [] here would make the pipeline delete every vector of the file.
    await expect(chunkPdf(buffer, 'corrupt.pdf')).rejects.toThrow(ChunkParseError);
    await expect(chunkPdf(buffer, 'corrupt.pdf')).rejects.toMatchObject({
      filename: 'corrupt.pdf',
      cause: expect.objectContaining({ message: 'Invalid PDF structure' }),
    });
  });

  it('returns correct text content in each chunk', async () => {
    const pageText = generateText(50);
    setupMockDoc([pageText]);
    const buffer = Buffer.from('fake pdf');
    const chunks = await chunkPdf(buffer, 'test.pdf');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe(pageText);
  });
});
