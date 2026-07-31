import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import matter from 'gray-matter';
import { v5 as uuidv5 } from 'uuid';
import { config } from '../config.js';
import { indexedFiles } from '../db/schema.js';
import { chunkCanvas } from '../lib/canvas-chunker.js';
import { isChunkParseError } from '../lib/chunk-errors.js';
import { chunkMarkdown } from '../lib/chunker.js';
import { chunkCsv } from '../lib/csv-chunker.js';
import { chunkExcalidraw } from '../lib/excalidraw-chunker.js';
import { extractImageBacklinks, IMAGE_EXTENSIONS } from '../lib/image-tracker.js';
import type { FileChangeEvent } from '../lib/indexer.js';
import { chunkPdf } from '../lib/pdf-chunker.js';
import type { VaultManager } from '../lib/vault.js';

declare module 'fastify' {
  interface FastifyInstance {
    processFileChanges: (userId: string, events: FileChangeEvent[]) => void;
  }
}

// UUID v5 DNS namespace constant
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

interface Chunk {
  text: string;
  sectionPath: string;
  chunkIndex: number;
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
 * Embed chunks and upsert to tenant Qdrant, then clean up stale vectors.
 */
async function embedAndUpsert(
  fastify: FastifyInstance,
  userId: string,
  event: FileChangeEvent,
  chunks: Chunk[],
  extraPayload: Record<string, unknown>,
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
    return;
  }

  const embedder = fastify.getUserEmbedder(userId);
  const embeddings = await embedder.embed(chunks.map((c) => c.text));
  fastify.metrics.embeddingRequests.inc({ user_id: userId });
  fastify.metrics.chunksProcessed.inc({ user_id: userId }, chunks.length);

  const ext = path.extname(event.path);
  const title = path.basename(event.path, ext);

  const points = chunks.map((chunk, i) => ({
    id: chunkId(userId, event.path, i),
    vector: embeddings[i] as number[],
    payload: {
      path: event.path,
      title,
      chunk_index: i,
      section_path: chunk.sectionPath,
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
        { key: 'chunk_index', range: { gte: chunks.length } },
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
): Promise<{ chunks: Chunk[]; extraPayload: Record<string, unknown> }> {
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
  const chunks = chunkMarkdown(parsed.content, { title });
  const frontmatterData = parsed.data as Record<string, unknown>;

  return {
    chunks,
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

    switch (ext) {
      case '.md': {
        const extracted = await extractMarkdown(fastify, userId, event, vault);
        chunks = extracted.chunks;
        extraPayload = extracted.extraPayload;
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

    await embedAndUpsert(fastify, userId, event, chunks, extraPayload);
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
}

async function pipelinePlugin(fastify: FastifyInstance): Promise<void> {
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
