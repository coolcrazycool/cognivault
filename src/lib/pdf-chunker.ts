import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';
import { ChunkParseError } from './chunk-errors.js';
import {
  breadcrumbBodyBudget,
  countTokens,
  MAX_CHUNK_TOKENS,
  splitTextByTokenBudget,
  withBreadcrumb,
} from './chunker.js';

// Disable worker for server-side usage
pdfjsLib.GlobalWorkerOptions.workerSrc = '';

export { MAX_CHUNK_TOKENS };
export const MIN_PAGE_TOKENS = 10;

export interface PdfPage {
  pageNum: number;
  text: string;
  tokenCount: number;
}

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
}

/**
 * Extracts text from each page of a PDF buffer, along with document metadata.
 */
export async function extractPdfPages(
  buffer: Buffer,
): Promise<{ pages: PdfPage[]; metadata: PdfMetadata }> {
  const data = new Uint8Array(buffer);
  const task = pdfjsLib.getDocument({ data });
  const doc = await task.promise;

  // Extract metadata
  const metaResult = await doc.getMetadata();
  const info = metaResult.info as Record<string, string | undefined>;
  const metadata: PdfMetadata = {
    title: info.Title,
    author: info.Author,
    subject: info.Subject,
  };

  // Extract pages
  const pages: PdfPage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .filter((item): item is TextItem => 'str' in item)
      .map((item) => item.str)
      .join(' ');
    const trimmed = text.trim();
    pages.push({
      pageNum: i,
      text: trimmed,
      tokenCount: countTokens(trimmed),
    });
  }

  return { pages, metadata };
}

/**
 * Chunks a PDF buffer into page-based chunks matching the MarkdownChunk shape.
 *
 * - Pages with fewer than MIN_PAGE_TOKENS tokens are skipped (scanned headers/footers)
 * - Pages exceeding the budget are cut on the largest natural boundary that fits —
 *   paragraph, then line, then word. Extracted PDF text often has no paragraph breaks
 *   at all, and a page left whole would be truncated by the embedder: its tail would
 *   sit in the payload while missing from the vector
 * - Every chunk opens with its `sectionPath`, so the file name and page number are part
 *   of the embedded and tokenized text rather than payload-only metadata
 * - sectionPath format: "filename > Page N"
 * - A PDF that parses but has no extractable text yields zero chunks
 * - A PDF that cannot be parsed at all throws {@link ChunkParseError}
 */
export async function chunkPdf(
  buffer: Buffer,
  filename: string,
): Promise<Array<{ text: string; sectionPath: string; chunkIndex: number }>> {
  let pages: PdfPage[];

  try {
    const result = await extractPdfPages(buffer);
    pages = result.pages;
  } catch (err: unknown) {
    // Corrupt/unreadable PDF — must not be confused with "no text in this PDF",
    // which would make the pipeline delete every vector of the file.
    throw new ChunkParseError(`Failed to parse PDF "${filename}"`, filename, { cause: err });
  }

  const chunks: Array<{ text: string; sectionPath: string; chunkIndex: number }> = [];
  let chunkIndex = 0;

  for (const page of pages) {
    // Skip pages below the minimum token threshold
    if (page.tokenCount < MIN_PAGE_TOKENS) {
      continue;
    }

    const sectionPath = `${filename} > Page ${page.pageNum}`;

    for (const text of splitTextByTokenBudget(page.text, breadcrumbBodyBudget(sectionPath))) {
      chunks.push({ text: withBreadcrumb(sectionPath, text), sectionPath, chunkIndex });
      chunkIndex++;
    }
  }

  return chunks;
}
