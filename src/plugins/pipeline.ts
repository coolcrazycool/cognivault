import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import matter from 'gray-matter';
import { v5 as uuidv5 } from 'uuid';
import { config } from '../config.js';
import { docSummaries, indexedFiles, type NewSection, sections } from '../db/schema.js';
import { BM25_VECTOR_NAME, buildDocumentSparseVector, DENSE_VECTOR_NAME } from '../lib/bm25.js';
import { chunkCanvas } from '../lib/canvas-chunker.js';
import { isChunkParseError } from '../lib/chunk-errors.js';
import type { MarkdownSection } from '../lib/chunker.js';
import { capDocSummary, chunkMarkdownWithSections, DOC_SUMMARY_PREFIX } from '../lib/chunker.js';
import { chunkCsv } from '../lib/csv-chunker.js';
import { chunkExcalidraw } from '../lib/excalidraw-chunker.js';
import { GigaChatChatClient } from '../lib/gigachat-chat.js';
import { extractImageBacklinks, IMAGE_EXTENSIONS } from '../lib/image-tracker.js';
import type { FileChangeEvent } from '../lib/indexer.js';
import { chunkPdf } from '../lib/pdf-chunker.js';
import type { VaultManager } from '../lib/vault.js';

/**
 * The only thing the pipeline needs from a chat model. Narrow on purpose: it keeps the
 * summarization paths testable with a two-line fake and independent of GigaChat.
 */
export interface Summarizer {
  complete(prompt: string, opts?: { system?: string }): Promise<string>;
}

declare module 'fastify' {
  interface FastifyInstance {
    processFileChanges: (userId: string, events: FileChangeEvent[]) => void;
    /** Chat model used for index-time summaries; undefined when unavailable/disabled. */
    summarizer: Summarizer | undefined;
  }
}

// UUID v5 DNS namespace constant
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

const DOC_SUMMARY_PROMPT =
  'Аннотация 1–2 предложения: о чём документ. Ответь только текстом аннотации.\n\nДокумент:\n';
/** How much of a document the annotation prompt sees — the opening is the informative part. */
const DOC_SUMMARY_MAX_CHARS = 4_000;

const TABLE_SUMMARY_PROMPT =
  'Опиши таблицу 1–2 предложениями: о чём она, перечисли колонки и по 1–2 примера значений. ' +
  'Ответь только текстом описания.\n\nТаблица (заголовок и первые строки):\n';
/** Context prefix + header + separator + ~10 rows of the table's first chunk. */
const TABLE_SUMMARY_HEAD_LINES = 14;

/** Number of chat calls made since start — logged so indexing cost stays visible. */
let summaryCallCount = 0;

interface Chunk {
  text: string;
  sectionPath: string;
  chunkIndex: number;
  /** Only markdown is section-aware; other formats have no parent document. */
  parentId?: string;
  /**
   * What the chunk holds: `'text'`, `'table_rows'` (a row group of a split table) or
   * `'table_summary'` (the generated description below). Chunkers that predate the
   * field simply leave it out, hence the tolerant `?? 'text'` at every read.
   */
  contentKind?: string;
  /**
   * The chunk's own text, without the document annotation {@link enrichChunks} prepends.
   *
   * Only the lexical (BM25) vector uses it. The annotation is identical across every
   * chunk of a document, so feeding it to the sparse encoder would give each chunk the
   * same block of annotation terms — every chunk of the document would then fire on any
   * query touching them — and would inflate the BM25 length normalizer, damping the
   * terms the chunk is actually about. The dense vector and the payload keep the
   * annotation: that is where the extra context helps.
   */
  lexicalText?: string;
}

/** Payload keys every non-markdown format shares (markdown fills them from frontmatter). */
function defaultExtraPayload(): Record<string, unknown> {
  return {
    tags: [],
    project: null,
    status: null,
    type: null,
    extra_metadata: '{}',
  };
}

/**
 * Tell the indexer the file is now durably indexed, which is what persists its
 * indexed_files row. Nothing before this point writes the row, so a failure anywhere
 * upstream leaves the previous hash on record and the next poll retries the file.
 */
function confirmIndexed(fastify: FastifyInstance, userId: string, filePath: string): void {
  fastify.indexers.get(userId)?.indexer.confirmIndexed(filePath);
}

/**
 * Generate a deterministic UUID v5 for a chunk, scoped by userId.
 */
function chunkId(userId: string, filePath: string, chunkIndex: number): string {
  return uuidv5(`${userId}:${filePath}:${chunkIndex}`, UUID_NAMESPACE);
}

/**
 * Return a shallow copy of an object with the given keys omitted.
 */
function omit(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) {
      result[key] = obj[key];
    }
  }
  return result;
}

/**
 * Replace the file's parent-section rows in a single transaction: the old rows go and
 * the current ones land together, so a reader never sees a half-written note.
 *
 * Always call this AFTER confirmIndexed — on a 'created' event the indexed_files row
 * does not exist until then, and sections must not outlive a file the index disowns.
 * Passing an empty list is the "this file has no sections any more" case.
 */
function writeSections(
  fastify: FastifyInstance,
  userId: string,
  filePath: string,
  sectionRecords: MarkdownSection[],
): void {
  const db = fastify.getUserDbById(userId);
  const updatedAt = new Date().toISOString();

  const rows: NewSection[] = sectionRecords.map((section) => ({
    path: filePath,
    parentId: section.parentId,
    sectionPath: section.sectionPath,
    text: section.text,
    contentHash: createHash('sha1').update(section.text).digest('hex'),
    updatedAt,
  }));

  db.transaction((tx) => {
    tx.delete(sections).where(eq(sections.path, filePath)).run();
    if (rows.length > 0) {
      tx.insert(sections).values(rows).run();
    }
  });
}

/**
 * Runs one summarization call. Never throws: every caller treats a summary as an
 * optional bonus, so a dead gateway degrades indexing quality instead of stopping it.
 */
async function summarize(
  fastify: FastifyInstance,
  userId: string,
  filePath: string,
  prompt: string,
  what: string,
): Promise<string | undefined> {
  const summarizer = fastify.summarizer;
  if (!summarizer) {
    return undefined;
  }
  try {
    const text = await summarizer.complete(prompt);
    summaryCallCount += 1;
    fastify.log.info({ userId, path: filePath, what, summaryCallCount }, 'Summary generated');
    return text.trim().length > 0 ? text.trim() : undefined;
  } catch (err) {
    fastify.log.warn({ userId, path: filePath, what, err }, 'Summary call failed — skipping');
    return undefined;
  }
}

/**
 * Groups of consecutive chunks that came from the SAME split table: same parent section,
 * same section path, `content_kind: 'table_rows'`. A table small enough to survive as one
 * chunk produces a run of length 1 and gets no summary — the chunk already is the table.
 */
function splitTableRuns(chunks: Chunk[]): Chunk[][] {
  const runs: Chunk[][] = [];
  let current: Chunk[] = [];
  const keyOf = (chunk: Chunk) => `${chunk.parentId ?? ''}::${chunk.sectionPath}`;

  for (const chunk of chunks) {
    if ((chunk.contentKind ?? 'text') !== 'table_rows') {
      current = [];
      continue;
    }
    const previous = current[current.length - 1];
    if (previous && keyOf(previous) === keyOf(chunk)) {
      current.push(chunk);
    } else {
      current = [chunk];
      runs.push(current);
    }
  }

  return runs.filter((run) => run.length > 1);
}

/**
 * Adds one `table_summary` point per split table: a short description of what the table
 * holds, carrying the table's own `parent_id` so a hit expands to the whole table.
 */
async function appendTableSummaries(
  fastify: FastifyInstance,
  userId: string,
  event: FileChangeEvent,
  chunks: Chunk[],
): Promise<Chunk[]> {
  const runs = splitTableRuns(chunks);
  if (runs.length === 0) {
    return chunks;
  }

  const result = [...chunks];
  for (const run of runs) {
    const head = run[0] as Chunk;
    const excerpt = head.text.split('\n').slice(0, TABLE_SUMMARY_HEAD_LINES).join('\n');
    const summary = await summarize(
      fastify,
      userId,
      event.path,
      `${TABLE_SUMMARY_PROMPT}${excerpt}`,
      'table_summary',
    );
    if (summary === undefined) {
      continue;
    }
    result.push({
      text: summary,
      sectionPath: head.sectionPath,
      chunkIndex: result.length,
      parentId: head.parentId,
      contentKind: 'table_summary',
    });
  }
  return result;
}

/**
 * The document's annotation, from cache when the file's content hash is unchanged.
 * The cache survives a reindex (SQLite lives on the persistent volume), which is what
 * keeps re-embedding a whole vault free of chat calls.
 */
async function resolveDocSummary(
  fastify: FastifyInstance,
  userId: string,
  event: FileChangeEvent,
  chunks: Chunk[],
): Promise<string | undefined> {
  const db = fastify.getUserDbById(userId);
  const cached = db.select().from(docSummaries).where(eq(docSummaries.path, event.path)).get();
  if (cached && cached.contentHash === event.contentHash) {
    // Capped on the way out, not only on the way in: rows written before the cap existed
    // are still in the cache and would otherwise keep breaking the chunk ceiling forever.
    return capDocSummary(cached.summary);
  }

  const body = chunks
    .map((chunk) => chunk.text)
    .join('\n\n')
    .slice(0, DOC_SUMMARY_MAX_CHARS);
  const summary = await summarize(
    fastify,
    userId,
    event.path,
    `${DOC_SUMMARY_PROMPT}${body}`,
    'doc_summary',
  );
  if (summary === undefined) {
    return undefined;
  }

  // Cache what will actually be prepended, so the stored annotation and the indexed one
  // are the same string and a cache hit costs no second truncation decision.
  const capped = capDocSummary(summary);

  db.insert(docSummaries)
    .values({ path: event.path, contentHash: event.contentHash, summary: capped })
    .onConflictDoUpdate({
      target: docSummaries.path,
      set: { contentHash: event.contentHash, summary: capped },
    })
    .run();

  return capped;
}

/**
 * Enriches a file's chunks before they are embedded: a description point for every
 * split table, and the document annotation prepended to every chunk's text (the same
 * text is embedded and stored in the payload, so retrieval and generation agree).
 *
 * What the annotation is worth has been measured OFFLINE, against a stand-in annotation
 * and `multilingual-e5-base` rather than GigaChat — see «Замер `INDEX_DOC_SUMMARY`» in
 * `tools/rag_audit/README.md`. Three results are worth carrying here:
 *
 * - the fear stated on `DOC_SUMMARY_MAX_TOKENS` (`src/lib/chunker.ts`) — every chunk of a
 *   file sharing an opening, so the branch stops telling them apart — did NOT show up: the
 *   section-level metric moved 0.506 → 0.488…0.529 across annotation flavours, its noise;
 * - neither did a benefit. An informative annotation does not beat a boilerplate one of
 *   the same length, so what the model writes buys nothing measurable — EXCEPT on table
 *   chunks (`table` hit@1 0.66 → 0.75), which are rows with no topic of their own;
 * - the window is untouched by construction: `chunkBody` strips the prefix before the
 *   anchor is located, `sections` rows are written pre-enrichment, and the body budget is
 *   not reduced (`MAX_STORED_CHUNK_TOKENS` was RAISED to make room). Measured: 92.4 % →
 *   92.9 % of answers still delivered inside the 4000-char window.
 *
 * Composition effects are model-specific, so none of this is a production verdict and the
 * feature is left ON. The A/B that would settle it is written out in the same README.
 */
async function enrichChunks(
  fastify: FastifyInstance,
  userId: string,
  event: FileChangeEvent,
  chunks: Chunk[],
): Promise<Chunk[]> {
  if (!fastify.summarizer) {
    return chunks;
  }

  let enriched = chunks;
  if (config.INDEX_TABLE_SUMMARY) {
    enriched = await appendTableSummaries(fastify, userId, event, chunks);
  }

  if (config.INDEX_DOC_SUMMARY) {
    const summary = await resolveDocSummary(fastify, userId, event, chunks);
    if (summary !== undefined) {
      enriched = enriched.map((chunk) => ({
        ...chunk,
        text: `${DOC_SUMMARY_PREFIX}${summary}\n\n${chunk.text}`,
        // Kept for the sparse vector — see Chunk.lexicalText.
        lexicalText: chunk.text,
      }));
    }
  }

  return enriched;
}

/**
 * Embed chunks and upsert to tenant Qdrant, then clean up stale vectors.
 */
async function embedAndUpsert(
  fastify: FastifyInstance,
  userId: string,
  event: FileChangeEvent,
  chunks: Chunk[],
  extraPayload: Record<string, unknown>,
  sectionRecords: MarkdownSection[],
): Promise<void> {
  const tenantQdrant = fastify.createTenantQdrant(userId);

  if (chunks.length === 0) {
    // Valid file with no indexable content (empty note, frontmatter-only, canvas with
    // no text nodes). Dropping its vectors IS the correct end state, so this counts as
    // a successful index and the row must be written.
    await tenantQdrant.delete({
      filter: {
        must: [
          { key: 'path', match: { value: event.path } },
          { key: 'chunk_index', range: { gte: 0 } },
        ],
      },
    });
    fastify.metrics.staleVectorCleanups.inc({ user_id: userId });
    confirmIndexed(fastify, userId, event.path);
    // No chunks means no parents either — drop whatever the previous version left.
    writeSections(fastify, userId, event.path, []);
    return;
  }

  // Table descriptions and the document annotation are added BEFORE embedding, so the
  // dense vector and the payload text are the same string. The sparse vector is the one
  // exception and is built from the un-annotated text — see Chunk.lexicalText.
  const enriched = await enrichChunks(fastify, userId, event, chunks);

  const embedder = fastify.getUserEmbedder(userId);
  const embeddings = await embedder.embed(enriched.map((c) => c.text));
  fastify.metrics.embeddingRequests.inc({ user_id: userId });
  fastify.metrics.chunksProcessed.inc({ user_id: userId }, enriched.length);

  const ext = path.extname(event.path);
  const title = path.basename(event.path, ext);

  const points = enriched.map((chunk, i) => ({
    id: chunkId(userId, event.path, i),
    // Named vectors: dense embedding for semantic recall, BM25 sparse vector for lexical.
    vector: {
      [DENSE_VECTOR_NAME]: embeddings[i] as number[],
      [BM25_VECTOR_NAME]: buildDocumentSparseVector(chunk.lexicalText ?? chunk.text),
    },
    payload: {
      path: event.path,
      title,
      chunk_index: i,
      section_path: chunk.sectionPath,
      parent_id: chunk.parentId ?? null,
      content_kind: chunk.contentKind ?? 'text',
      content_hash: event.contentHash,
      text: chunk.text,
      ...extraPayload,
    },
  }));

  await tenantQdrant.upsert({ points });

  // Delete stale vectors where chunk_index >= new chunk count
  await tenantQdrant.delete({
    filter: {
      must: [
        { key: 'path', match: { value: event.path } },
        { key: 'chunk_index', range: { gte: enriched.length } },
      ],
    },
  });
  fastify.metrics.staleVectorCleanups.inc({ user_id: userId });

  // Qdrant now holds exactly the right vectors — persist the indexed_files row before
  // touching any of its columns below (on a 'created' event the row does not exist yet).
  confirmIndexed(fastify, userId, event.path);

  // Update embedding_model_version in indexed_files
  const db = fastify.getUserDbById(userId);
  db.update(indexedFiles)
    .set({ embeddingModelVersion: config.EMBEDDING_MODEL })
    .where(eq(indexedFiles.path, event.path))
    .run();

  // Parent sections last: if anything above threw, the file is retried on the next poll
  // and sections stay consistent with the vectors that are actually in Qdrant.
  writeSections(fastify, userId, event.path, sectionRecords);
}

/**
 * Read a markdown file and turn it into chunks plus the frontmatter-derived payload.
 * Read errors propagate: the queue consumer turns them into failIndexed + 'file-failed'.
 */
async function extractMarkdown(
  fastify: FastifyInstance,
  userId: string,
  event: FileChangeEvent,
  vault: VaultManager,
): Promise<{
  chunks: Chunk[];
  extraPayload: Record<string, unknown>;
  sections: MarkdownSection[];
}> {
  const { content: rawContent } = await vault.readContent(event.path);

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(rawContent);
  } catch {
    fastify.log.warn(
      { path: event.path, userId },
      'Invalid frontmatter — indexing without metadata',
    );
    parsed = { content: rawContent, data: {} } as matter.GrayMatterFile<string>;
  }

  const title = path.basename(event.path, '.md');
  const { chunks, sections: markdownSections } = chunkMarkdownWithSections(parsed.content, {
    title,
    path: event.path,
  });
  const frontmatterData = parsed.data as Record<string, unknown>;

  return {
    chunks,
    sections: markdownSections,
    extraPayload: {
      tags: Array.isArray(frontmatterData.tags)
        ? frontmatterData.tags
        : typeof frontmatterData.tags === 'string'
          ? [frontmatterData.tags]
          : [],
      project: frontmatterData.project ?? null,
      status: frontmatterData.status ?? null,
      type: frontmatterData.type ?? null,
      extra_metadata: JSON.stringify(omit(frontmatterData, ['tags', 'project', 'status', 'type'])),
    },
  };
}

/**
 * Process an image file: scan markdown files for backlinks and store in SQLite.
 */
async function processImage(
  fastify: FastifyInstance,
  userId: string,
  event: FileChangeEvent,
): Promise<void> {
  const db = fastify.getUserDbById(userId);
  const indexerEntry = fastify.indexers.get(userId);
  if (!indexerEntry) return;

  const mdFiles = db.select().from(indexedFiles).where(eq(indexedFiles.fileType, 'md')).all();

  const imageName = path.basename(event.path);
  const markdownContents: Array<{ path: string; content: string }> = [];

  for (const mdFile of mdFiles) {
    try {
      const result = await indexerEntry.vault.readContent(mdFile.path);
      markdownContents.push({ path: mdFile.path, content: result.content });
    } catch {
      // File may have been deleted since DB query — skip
    }
  }

  const linkedNotes = extractImageBacklinks(imageName, markdownContents);

  // Backlinks resolved — persist the row first, since on a 'created' event it does not
  // exist yet and the update below would silently affect zero rows.
  confirmIndexed(fastify, userId, event.path);

  db.update(indexedFiles)
    .set({ linkedNotes: JSON.stringify(linkedNotes) })
    .where(eq(indexedFiles.path, event.path))
    .run();
}

async function processCreatedOrUpdated(
  fastify: FastifyInstance,
  userId: string,
  event: FileChangeEvent,
): Promise<void> {
  const end = fastify.metrics.pipelineDuration.startTimer({ user_id: userId });
  try {
    const ext = path.extname(event.path).toLowerCase();

    // Image files: SQLite tracking only, no Qdrant vectors
    if (IMAGE_EXTENSIONS.has(ext)) {
      await processImage(fastify, userId, event);
      return;
    }

    const indexerEntry = fastify.indexers.get(userId);
    if (!indexerEntry) return;
    const vault = indexerEntry.vault;

    // Text formats: extract chunks -> embed -> upsert
    let chunks: Chunk[];
    let extraPayload = defaultExtraPayload();
    // Only markdown produces parent sections; other formats leave this empty, which
    // still clears any stale rows for the path.
    let sectionRecords: MarkdownSection[] = [];

    switch (ext) {
      case '.md': {
        const extracted = await extractMarkdown(fastify, userId, event, vault);
        chunks = extracted.chunks;
        extraPayload = extracted.extraPayload;
        sectionRecords = extracted.sections;
        break;
      }

      case '.pdf': {
        const absPath = path.join(vault.vaultRootPath, event.path);
        const buffer = await fs.readFile(absPath);
        const filename = path.basename(event.path, ext);
        chunks = await chunkPdf(buffer, filename);
        break;
      }

      case '.csv': {
        const result = await vault.readContent(event.path);
        const filename = path.basename(event.path, ext);
        chunks = chunkCsv(result.content, filename);
        break;
      }

      case '.canvas': {
        const result = await vault.readContent(event.path);
        const canvasName = path.basename(event.path, ext);
        chunks = chunkCanvas(result.content, canvasName);
        break;
      }

      case '.excalidraw': {
        const result = await vault.readContent(event.path);
        const drawingName = path.basename(event.path, ext);
        chunks = chunkExcalidraw(result.content, drawingName);
        break;
      }

      default:
        return;
    }

    await embedAndUpsert(fastify, userId, event, chunks, extraPayload, sectionRecords);
  } finally {
    end();
  }
}

async function processDeleted(
  fastify: FastifyInstance,
  userId: string,
  event: FileChangeEvent,
): Promise<void> {
  const ext = path.extname(event.path).toLowerCase();

  if (IMAGE_EXTENSIONS.has(ext)) {
    return;
  }

  const tenantQdrant = fastify.createTenantQdrant(userId);
  await tenantQdrant.delete({
    filter: {
      must: [{ key: 'path', match: { value: event.path } }],
    },
  });

  // Vectors are gone, so the parent sections they expand into must go too — otherwise
  // the table grows forever with rows nothing can ever reference. The cached document
  // annotation is dead weight for the same reason.
  const db = fastify.getUserDbById(userId);
  db.delete(sections).where(eq(sections.path, event.path)).run();
  db.delete(docSummaries).where(eq(docSummaries.path, event.path)).run();
}

async function processMoved(
  fastify: FastifyInstance,
  userId: string,
  event: FileChangeEvent,
): Promise<void> {
  const oldPath = event.oldPath;
  if (oldPath === undefined) {
    // A move without a source is unrepairable: setPayload would match every point.
    throw new Error(`Moved event for "${event.path}" has no oldPath`);
  }

  const ext = path.extname(event.path).toLowerCase();
  const newTitle = path.basename(event.path, ext);

  if (IMAGE_EXTENSIONS.has(ext)) {
    // No vectors to repoint, but the SQLite row still has to follow the file.
    confirmIndexed(fastify, userId, event.path);
    return;
  }

  const tenantQdrant = fastify.createTenantQdrant(userId);
  // content_hash is unchanged by a move (it is what identified the move), so the
  // payload only needs the new location.
  await tenantQdrant.setPayload({
    payload: {
      path: event.path,
      title: newTitle,
    },
    filter: {
      must: [{ key: 'path', match: { value: oldPath } }],
    },
  });

  // Carries the indexed_files row from oldPath to event.path in one transaction.
  confirmIndexed(fastify, userId, event.path);

  // parent_id deliberately excludes the file path, so a move only has to repoint the
  // rows — no re-chunking, no re-embedding, and existing chunk payloads stay valid.
  const db = fastify.getUserDbById(userId);
  db.update(sections).set({ path: event.path }).where(eq(sections.path, oldPath)).run();
  // The annotation describes the content, not the location — carry the cache row over
  // so a move does not silently pay for a fresh chat call on the next update.
  db.update(docSummaries).set({ path: event.path }).where(eq(docSummaries.path, oldPath)).run();
}

/**
 * The shared chat client for index-time summaries, or undefined when summaries are off
 * or unreachable. It exists only for GigaChat: the mTLS certificate is what authorizes
 * the call, and an OpenAI deployment has no equivalent credential here.
 */
function createSummarizer(fastify: FastifyInstance): Summarizer | undefined {
  if (!config.INDEX_DOC_SUMMARY && !config.INDEX_TABLE_SUMMARY) {
    return undefined;
  }
  if (config.EMBEDDING_PROVIDER !== 'gigachat') {
    return undefined;
  }
  if (!config.GIGACHAT_CERT_PATH || !config.GIGACHAT_KEY_PATH) {
    fastify.log.warn('Index summaries enabled but GigaChat certificate is missing — disabled');
    return undefined;
  }
  return new GigaChatChatClient({
    baseUrl: config.GIGACHAT_BASE_URL,
    model: config.GIGACHAT_CHAT_MODEL,
    certPath: config.GIGACHAT_CERT_PATH,
    keyPath: config.GIGACHAT_KEY_PATH,
    keyPassphrase: config.GIGACHAT_KEY_PASSPHRASE,
    caPath: config.GIGACHAT_CA_PATH,
    verifySsl: config.GIGACHAT_VERIFY_SSL,
    maxTokens: config.GIGACHAT_CHAT_MAX_TOKENS,
    timeoutMs: config.GIGACHAT_CHAT_TIMEOUT_MS,
    maxRetries: config.GIGACHAT_MAX_RETRIES,
    retryBaseDelayMs: config.GIGACHAT_RETRY_BASE_DELAY_MS,
  });
}

async function pipelinePlugin(fastify: FastifyInstance): Promise<void> {
  // A decoration already in place wins: that is how tests (and any future plugin)
  // supply their own chat client without reaching into this module.
  if (!fastify.hasDecorator('summarizer')) {
    fastify.decorate('summarizer', createSummarizer(fastify));
  }

  function processFileChanges(userId: string, events: FileChangeEvent[]): void {
    const indexerEntry = fastify.indexers.get(userId);
    if (!indexerEntry) {
      fastify.log.warn({ userId }, 'processFileChanges called for unknown user — ignoring');
      return;
    }

    const { queue } = indexerEntry;

    // Ensure gauge resets to 0 when queue drains
    void queue.onIdle().then(() => {
      fastify.metrics.indexQueueDepth.set({ user_id: userId }, 0);
    });

    for (const event of events) {
      void queue.add(async () => {
        try {
          switch (event.type) {
            case 'created':
            case 'updated':
              await processCreatedOrUpdated(fastify, userId, event);
              break;
            case 'deleted':
              await processDeleted(fastify, userId, event);
              break;
            case 'moved':
              await processMoved(fastify, userId, event);
              break;
          }
        } catch (err: unknown) {
          if (isChunkParseError(err)) {
            fastify.log.error(
              { event, err, userId, filename: err.filename },
              'Pipeline: file could not be parsed — existing vectors and index row left untouched',
            );
          } else {
            fastify.log.error(
              { event, err, userId },
              'Pipeline processing failed — index row not advanced, retried on the next poll',
            );
          }

          // Drop the pending entry without writing the row: indexed_files keeps the
          // previous hash, so the next poll genuinely re-detects this change.
          indexerEntry.indexer.failIndexed(event.path);

          fastify.pipelineEvents.emit('file-failed', {
            userId,
            path: event.path,
            error: String(err),
          });
        } finally {
          // Update queue depth gauge per user (use setImmediate so pending count is accurate)
          setImmediate(() => {
            fastify.metrics.indexQueueDepth.set({ user_id: userId }, queue.size + queue.pending);
          });
        }
      });

      // Update queue depth gauge after adding to queue
      fastify.metrics.indexQueueDepth.set({ user_id: userId }, queue.size + queue.pending);
    }
  }

  fastify.decorate('processFileChanges', processFileChanges);
}

export default fp(pipelinePlugin, {
  name: 'pipeline',
  dependencies: ['qdrant', 'embedder', 'db', 'metrics', 'registry', 'pipeline-events'],
});
