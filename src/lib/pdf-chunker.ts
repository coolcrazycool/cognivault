import { getEncoding } from 'js-tiktoken';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';

// Disable worker for server-side usage
pdfjsLib.GlobalWorkerOptions.workerSrc = '';

// Initialize encoder once at module level (expensive initialization)
const enc = getEncoding('cl100k_base');

export const MAX_CHUNK_TOKENS = 500;
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

function countTokens(text: string): number {
  return enc.encode(text).length;
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
 * Splits text at paragraph boundaries (double newline) to stay within MAX_CHUNK_TOKENS.
 * Each sub-chunk gets the same sectionPath.
 */
function splitPageAtParagraphs(text: string): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';
  let currentTokens = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    const paraTokens = countTokens(trimmed);

    if (currentTokens > 0 && currentTokens + paraTokens > MAX_CHUNK_TOKENS) {
      // Flush current chunk
      chunks.push(current.trim());
      current = trimmed;
      currentTokens = paraTokens;
    } else {
      current = current ? `${current}\n\n${trimmed}` : trimmed;
      currentTokens += paraTokens;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Chunks a PDF buffer into page-based chunks matching the MarkdownChunk shape.
 *
 * - Pages with fewer than MIN_PAGE_TOKENS tokens are skipped (scanned headers/footers)
 * - Pages exceeding MAX_CHUNK_TOKENS are split at paragraph boundaries
 * - sectionPath format: "filename > Page N"
 * - Returns empty array for corrupt/empty PDFs without throwing
 */
export async function chunkPdf(
  buffer: Buffer,
  filename: string,
): Promise<Array<{ text: string; sectionPath: string; chunkIndex: number }>> {
  let pages: PdfPage[];

  try {
    const result = await extractPdfPages(buffer);
    pages = result.pages;
  } catch {
    // Corrupt or empty PDF — return zero chunks
    return [];
  }

  const chunks: Array<{ text: string; sectionPath: string; chunkIndex: number }> = [];
  let chunkIndex = 0;

  for (const page of pages) {
    // Skip pages below the minimum token threshold
    if (page.tokenCount < MIN_PAGE_TOKENS) {
      continue;
    }

    const sectionPath = `${filename} > Page ${page.pageNum}`;

    if (page.tokenCount > MAX_CHUNK_TOKENS) {
      // Split large pages at paragraph boundaries
      const subChunks = splitPageAtParagraphs(page.text);
      for (const subText of subChunks) {
        chunks.push({ text: subText, sectionPath, chunkIndex });
        chunkIndex++;
      }
    } else {
      chunks.push({ text: page.text, sectionPath, chunkIndex });
      chunkIndex++;
    }
  }

  return chunks;
}
