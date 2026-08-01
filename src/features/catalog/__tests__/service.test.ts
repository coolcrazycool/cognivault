import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../../../db/client.js';
import type * as schema from '../../../db/schema.js';
import { docSummaries, indexedFiles } from '../../../db/schema.js';
import { DOCUMENT_EXTENSIONS, IMAGE_EXTENSIONS, INDEXED_EXTENSIONS } from '../../../lib/indexer.js';
import type { SummaryAvailability } from '../service.js';
import { catalogStatus, readCatalog, summaryAvailability } from '../service.js';

type UserDb = BetterSQLite3Database<typeof schema>;

const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-service-')));
const closers: Array<() => void> = [];

let dbCounter = 0;
function freshDb(): UserDb {
  dbCounter += 1;
  const { db, sqlite } = createDatabase(path.join(tmpDir, `index-${dbCounter}.db`));
  closers.push(() => sqlite.close());
  return db;
}

afterAll(async () => {
  for (const close of closers) close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const ENABLED: SummaryAvailability = { enabled: true, reason: null };
const DISABLED: SummaryAvailability = { enabled: false, reason: 'provider is not gigachat' };

function indexDoc(db: UserDb, filePath: string, opts?: { fileType?: string; size?: number }): void {
  db.insert(indexedFiles)
    .values({
      path: filePath,
      contentHash: `hash-${filePath}`,
      mtime: 1,
      size: opts?.size ?? 1000,
      indexedAt: '2026-08-01T00:00:00.000Z',
      fileType: opts?.fileType ?? 'md',
    })
    .run();
}

function annotate(db: UserDb, filePath: string, summary: string): void {
  db.insert(docSummaries)
    .values({ path: filePath, contentHash: `hash-${filePath}`, summary })
    .run();
}

const OPTIONS = { limit: 500, offset: 0, availability: ENABLED };

describe('summaryAvailability', () => {
  it('reports enabled only for a gigachat install with both certificate paths', () => {
    expect(
      summaryAvailability({
        indexDocSummary: true,
        embeddingProvider: 'gigachat',
        certPath: '/certs/client.pem',
        keyPath: '/certs/client.key',
      }),
    ).toEqual({ enabled: true, reason: null });
  });

  it('names INDEX_DOC_SUMMARY when the feature itself is off', () => {
    const result = summaryAvailability({
      indexDocSummary: false,
      embeddingProvider: 'gigachat',
      certPath: '/certs/client.pem',
      keyPath: '/certs/client.key',
    });
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain('INDEX_DOC_SUMMARY');
  });

  it('names the provider — the OpenAI install that has zero rows by construction', () => {
    const result = summaryAvailability({ indexDocSummary: true, embeddingProvider: 'openai' });
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain('EMBEDDING_PROVIDER=gigachat');
    expect(result.reason).toContain('openai');
  });

  it('names the certificate when it is the missing piece', () => {
    const result = summaryAvailability({
      indexDocSummary: true,
      embeddingProvider: 'gigachat',
      certPath: '/certs/client.pem',
    });
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain('GIGACHAT_KEY_PATH');
  });
});

describe('catalogStatus', () => {
  it('distinguishes an empty corpus from a corpus with no annotations', () => {
    expect(catalogStatus(0, 0, ENABLED)).toBe('empty_vault');
    expect(catalogStatus(127, 0, DISABLED)).toBe('summaries_disabled');
    expect(catalogStatus(127, 0, ENABLED)).toBe('summaries_pending');
    expect(catalogStatus(127, 110, DISABLED)).toBe('ok');
  });
});

describe('readCatalog', () => {
  let db: UserDb;

  beforeEach(() => {
    db = freshDb();
  });

  it('returns path, title and annotation per document, ordered by path', () => {
    indexDoc(db, 'Продукты/Fincert.md');
    indexDoc(db, 'Архив/Проекты Ислама.md');
    annotate(db, 'Продукты/Fincert.md', 'Документ описывает продукт Fincert.');
    annotate(db, 'Архив/Проекты Ислама.md', 'Список личных проектов инженера.');

    const result = readCatalog(db, OPTIONS);

    expect(result.status).toBe('ok');
    expect(result.total).toBe(2);
    expect(result.documents_with_summary).toBe(2);
    expect(result.documents).toEqual([
      {
        path: 'Архив/Проекты Ислама.md',
        title: 'Проекты Ислама',
        summary: 'Список личных проектов инженера.',
        size: 1000,
      },
      {
        path: 'Продукты/Fincert.md',
        title: 'Fincert',
        summary: 'Документ описывает продукт Fincert.',
        size: 1000,
      },
    ]);
  });

  it('lists a document that is indexed but has no annotation, with summary: null', () => {
    // The real state this models: `Продукты.md` is a container page holding only
    // frontmatter, so it produces zero chunks and never reaches the annotator. 17 of the
    // 127 documents in the reference corpus are exactly this. Dropping them would make the
    // catalogue claim the base has no `Продукты` page at all.
    indexDoc(db, 'Продукты.md', { size: 492 });
    indexDoc(db, 'Продукты/Fincert.md');
    annotate(db, 'Продукты/Fincert.md', 'Документ описывает продукт Fincert.');

    const result = readCatalog(db, OPTIONS);

    expect(result.status).toBe('ok');
    expect(result.total).toBe(2);
    expect(result.documents_with_summary).toBe(1);
    expect(result.documents.map((d) => [d.path, d.summary, d.size])).toEqual([
      ['Продукты.md', null, 492],
      ['Продукты/Fincert.md', 'Документ описывает продукт Fincert.', 1000],
    ]);
  });

  it('an indexed corpus with an empty doc_summaries table is NOT reported as an empty corpus', () => {
    // The OpenAI-provider install. Every counter says the corpus is there; only the
    // annotations are missing, and `status` says which.
    for (const p of ['a.md', 'b.md', 'c.md']) indexDoc(db, p);

    const result = readCatalog(db, { ...OPTIONS, availability: DISABLED });

    expect(result.status).toBe('summaries_disabled');
    expect(result.summaries_enabled).toBe(false);
    expect(result.reason).toBe('provider is not gigachat');
    expect(result.total).toBe(3);
    expect(result.documents_with_summary).toBe(0);
    expect(result.documents).toHaveLength(3);
    expect(result.documents.every((d) => d.summary === null)).toBe(true);
  });

  it('separates "cannot annotate here" from "has not annotated yet"', () => {
    for (const p of ['a.md', 'b.md']) indexDoc(db, p);

    expect(readCatalog(db, { ...OPTIONS, availability: ENABLED }).status).toBe('summaries_pending');
    expect(readCatalog(db, { ...OPTIONS, availability: DISABLED }).status).toBe(
      'summaries_disabled',
    );
  });

  it('reports empty_vault — the only status that means the corpus itself is empty', () => {
    const result = readCatalog(db, OPTIONS);

    expect(result.status).toBe('empty_vault');
    expect(result.total).toBe(0);
    expect(result.documents).toEqual([]);
    expect(result.documents_with_summary).toBe(0);
  });

  it('excludes images and keeps rows written before file_type existed', () => {
    indexDoc(db, 'notes/note.md');
    indexDoc(db, 'attachments/diagram.png', { fileType: 'image' });
    db.insert(indexedFiles)
      .values({
        path: 'legacy.md',
        contentHash: 'legacy',
        mtime: 1,
        size: 10,
        indexedAt: '2026-08-01T00:00:00.000Z',
      })
      .run();

    const result = readCatalog(db, OPTIONS);

    expect(result.documents.map((d) => d.path)).toEqual(['legacy.md', 'notes/note.md']);
    expect(result.total).toBe(2);
  });

  it('pages without changing the counters the status is derived from', () => {
    for (const p of ['a.md', 'b.md', 'c.md', 'd.md']) indexDoc(db, p);
    annotate(db, 'a.md', 'первая');

    const page = readCatalog(db, { ...OPTIONS, limit: 2, offset: 2 });

    expect(page.documents.map((d) => d.path)).toEqual(['c.md', 'd.md']);
    expect(page.offset).toBe(2);
    // Counted over the index, not the page — paging past the annotated document must not
    // turn the catalogue into "summaries_pending".
    expect(page.total).toBe(4);
    expect(page.documents_with_summary).toBe(1);
    expect(page.status).toBe('ok');

    // Truncation is detectable without a second call: the first page does not reach total.
    const first = readCatalog(db, { ...OPTIONS, limit: 2, offset: 0 });
    expect(first.offset + first.documents.length).toBeLessThan(first.total);
    expect(page.offset + page.documents.length).toBe(page.total);
  });

  it('derives the title exactly as the indexer does, extension stripped', () => {
    indexDoc(db, 'Confluence/OASIS External Home/Описание витрин.md');
    indexDoc(db, 'reports/2025.q1.md');
    indexDoc(db, 'data/table.csv', { fileType: 'csv' });

    expect(readCatalog(db, OPTIONS).documents.map((d) => d.title)).toEqual([
      'Описание витрин',
      'table',
      '2025.q1',
    ]);
  });

  // ── One definition of "document" ──
  //
  // The corpus footprint in the UI used to count files on disk by its own extension
  // allowlist, which included `txt` and `markdown` — two extensions the poller never
  // scans. On an all-`.md` corpus the two totals happened to agree; a single `.txt` file
  // would have made the footprint promise a document search can never return. These tests
  // pin the shared definition so the divergence cannot come back silently.

  it('serves the indexer’s own document extensions, images excluded', () => {
    indexDoc(db, 'a.md');
    const response = readCatalog(db, OPTIONS);

    expect(response.document_extensions).toEqual([...DOCUMENT_EXTENSIONS]);
    expect(response.document_extensions).toEqual(['md', 'pdf', 'canvas', 'excalidraw', 'csv']);
    for (const image of IMAGE_EXTENSIONS) {
      expect(response.document_extensions).not.toContain(image);
    }
  });

  it('never advertises an extension the poller does not scan', () => {
    indexDoc(db, 'a.md');
    const advertised = readCatalog(db, OPTIONS).document_extensions;

    // The exact failure this closes: a footprint counting `.txt`/`.markdown` as documents.
    expect(advertised).not.toContain('txt');
    expect(advertised).not.toContain('markdown');
    for (const ext of advertised) {
      expect(INDEXED_EXTENSIONS as readonly string[]).toContain(ext);
    }
  });

  it('counts exactly the extensions it advertises — images are the only exclusion', () => {
    // `documentsOnly()` filters rows by file_type; `document_extensions` filters paths by
    // extension. Same rule, two shapes: they must agree on every scanned extension.
    for (const ext of INDEXED_EXTENSIONS) {
      indexDoc(db, `file.${ext}`, {
        fileType: (IMAGE_EXTENSIONS as readonly string[]).includes(ext) ? 'image' : ext,
      });
    }
    const response = readCatalog(db, OPTIONS);

    expect(response.total).toBe(DOCUMENT_EXTENSIONS.length);
    expect(response.documents.map((d) => d.path).sort()).toEqual(
      [...DOCUMENT_EXTENSIONS].map((ext) => `file.${ext}`).sort(),
    );
  });

  it('reads only the database it is handed — one tenant never sees another', () => {
    const other = freshDb();
    indexDoc(db, 'tenant-a.md');
    annotate(db, 'tenant-a.md', 'аннотация A');
    indexDoc(other, 'tenant-b.md');
    annotate(other, 'tenant-b.md', 'аннотация B');

    expect(readCatalog(db, OPTIONS).documents.map((d) => d.path)).toEqual(['tenant-a.md']);
    expect(readCatalog(other, OPTIONS).documents.map((d) => d.path)).toEqual(['tenant-b.md']);
  });
});
