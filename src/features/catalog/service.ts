import * as path from 'node:path';
import { count, eq, isNull, ne, or, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../../db/schema.js';
import { docSummaries, indexedFiles } from '../../db/schema.js';
import { DOCUMENT_EXTENSIONS } from '../../lib/indexer.js';
import type { CatalogEntry, CatalogResponse, CatalogStatus } from './schemas.js';

type UserDb = BetterSQLite3Database<typeof schema>;

/**
 * Whether this deployment can write document annotations at index time, and if not, which
 * setting to change.
 *
 * MIRRORS `createSummarizer` in `src/plugins/pipeline.ts` — that function is the authority
 * on when a summarizer exists, this one only explains its verdict to a caller. The two
 * must be changed together; the order of the checks here is the order of the causes an
 * operator would fix, most specific last.
 */
export interface SummarySupport {
  indexDocSummary: boolean;
  embeddingProvider: string;
  certPath?: string;
  keyPath?: string;
}

export interface SummaryAvailability {
  enabled: boolean;
  reason: string | null;
}

export function summaryAvailability(support: SummarySupport): SummaryAvailability {
  if (!support.indexDocSummary) {
    return {
      enabled: false,
      reason:
        'INDEX_DOC_SUMMARY is off, so documents are indexed without annotations. ' +
        'Existing rows are still served.',
    };
  }
  if (support.embeddingProvider !== 'gigachat') {
    return {
      enabled: false,
      reason:
        'Annotations are written by the GigaChat chat model, which exists only for ' +
        `EMBEDDING_PROVIDER=gigachat (currently "${support.embeddingProvider}").`,
    };
  }
  if (!support.certPath || !support.keyPath) {
    return {
      enabled: false,
      reason:
        'The GigaChat client certificate is the credential for the annotation call and ' +
        'is not configured (GIGACHAT_CERT_PATH / GIGACHAT_KEY_PATH).',
    };
  }
  return { enabled: true, reason: null };
}

/**
 * Rows the catalogue is about: every indexed file except images.
 *
 * `file_type` is stamped by `fileTypeFromPath` in `src/lib/indexer.ts`; it is nullable
 * because rows written before the column existed have no value, and those are documents.
 *
 * The row-level filter and the extension list served as `document_extensions` are two
 * views of ONE rule — a row exists only for a scanned extension, and `file_type` is
 * `'image'` for exactly the image ones — which is why `DOCUMENT_EXTENSIONS` is derived
 * there rather than restated here.
 */
function documentsOnly(): SQL | undefined {
  return or(isNull(indexedFiles.fileType), ne(indexedFiles.fileType, 'image'));
}

/**
 * The title the indexer puts in the Qdrant payload, recomputed from the path.
 *
 * Deliberately the same expression as `embedAndUpsert`'s, not an approximation of it:
 * a catalogue whose titles disagree with the titles on search hits is worse than no
 * catalogue, because the disagreement is invisible to the caller.
 */
function titleOf(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

export interface CatalogOptions {
  limit: number;
  offset: number;
  availability: SummaryAvailability;
}

/**
 * Reads the catalogue out of the caller's own SQLite: `indexed_files` LEFT JOIN
 * `doc_summaries`.
 *
 * The document list comes from `indexed_files` rather than from the filesystem
 * (`GET /api/vault/files`) on purpose. The two genuinely disagree — the poller indexes on
 * its own cycle, so a file can exist on disk minutes before it has a row — and of the two
 * sets, `indexed_files` is the one retrieval can actually return. A catalogue used to
 * answer "what does this base cover" must not promise a document no search will ever cite.
 * The LEFT JOIN keeps the other disagreement visible instead of hiding it: a document with
 * no annotation row is listed with `summary: null`, so its path and title — both facts —
 * stay usable while nothing is invented to describe it.
 */
export function readCatalog(db: UserDb, options: CatalogOptions): CatalogResponse {
  const filter = documentsOnly();

  const rows = db
    .select({
      path: indexedFiles.path,
      size: indexedFiles.size,
      summary: docSummaries.summary,
    })
    .from(indexedFiles)
    .leftJoin(docSummaries, eq(docSummaries.path, indexedFiles.path))
    .where(filter)
    // Path order makes the flat list a depth-first walk of the folder tree, which is what
    // a caller building a section tree out of it needs, and it makes paging stable.
    .orderBy(indexedFiles.path)
    .limit(options.limit)
    .offset(options.offset)
    .all();

  const documents: CatalogEntry[] = rows.map((row) => ({
    path: row.path,
    title: titleOf(row.path),
    summary: row.summary ?? null,
    size: row.size,
  }));

  // Counted over the whole index, not over the page: `status` must not change when a
  // caller pages past the annotated documents.
  const total = db.select({ value: count() }).from(indexedFiles).where(filter).get()?.value ?? 0;
  const documentsWithSummary =
    db
      .select({ value: count() })
      .from(indexedFiles)
      .innerJoin(docSummaries, eq(docSummaries.path, indexedFiles.path))
      .where(filter)
      .get()?.value ?? 0;

  return {
    status: catalogStatus(total, documentsWithSummary, options.availability),
    summaries_enabled: options.availability.enabled,
    reason: options.availability.reason,
    documents,
    total,
    offset: options.offset,
    documents_with_summary: documentsWithSummary,
    // Served, not restated: `DOCUMENT_EXTENSIONS` is derived from the very list the
    // poller scans by, so a caller that counts documents from the filesystem gets the
    // same definition of "document" this catalogue counted `total` with. Two consumers,
    // one constant — the divergence is closed by construction, not by two lists that
    // happen to agree today.
    document_extensions: [...DOCUMENT_EXTENSIONS],
  };
}

/**
 * Names the reason an empty (or partial) catalogue is empty.
 *
 * The whole point of the field: `documents: []` alone reads as "the corpus is empty", and
 * for a vault indexed under EMBEDDING_PROVIDER=openai that statement is false — the corpus
 * is fully indexed and merely has no annotations. Only `empty_vault` licenses a caller to
 * say anything about the size of the corpus.
 */
export function catalogStatus(
  total: number,
  documentsWithSummary: number,
  availability: SummaryAvailability,
): CatalogStatus {
  if (total === 0) return 'empty_vault';
  if (documentsWithSummary > 0) return 'ok';
  return availability.enabled ? 'summaries_pending' : 'summaries_disabled';
}
