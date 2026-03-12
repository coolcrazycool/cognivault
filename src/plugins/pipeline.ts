import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import matter from 'gray-matter';
import PQueue from 'p-queue';
import { v5 as uuidv5 } from 'uuid';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    pipelineQueue: PQueue;
  }
}
import { indexedFiles } from '../db/schema.js';
import { chunkCanvas } from '../lib/canvas-chunker.js';
import { chunkMarkdown } from '../lib/chunker.js';
import { chunkCsv } from '../lib/csv-chunker.js';
import { chunkExcalidraw } from '../lib/excalidraw-chunker.js';
import { extractImageBacklinks, IMAGE_EXTENSIONS } from '../lib/image-tracker.js';
import type { FileChangeEvent } from '../lib/indexer.js';
import { chunkPdf } from '../lib/pdf-chunker.js';

// UUID v5 DNS namespace constant
const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * Generate a deterministic UUID v5 for a chunk, based on file path and chunk index.
 */
function chunkId(filePath: string, chunkIndex: number): string {
  return uuidv5(`${filePath}:${chunkIndex}`, UUID_NAMESPACE);
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
 * Embed chunks and upsert to Qdrant, then clean up stale vectors.
 * Used by all text-format handlers (markdown, PDF, CSV, canvas, excalidraw).
 */
async function embedAndUpsert(
  fastify: FastifyInstance,
  event: FileChangeEvent,
  chunks: Array<{ text: string; sectionPath: string; chunkIndex: number }>,
  extraPayload: Record<string, unknown>,
): Promise<void> {
  if (chunks.length === 0) {
    // No chunks: clean stale vectors
    await fastify.qdrant.delete('cognivault', {
      filter: {
        must: [
          { key: 'path', match: { value: event.path } },
          { key: 'chunk_index', range: { gte: 0 } },
        ],
      },
    });
    fastify.metrics.staleVectorCleanups.inc();
    return;
  }

  const embeddings = await fastify.embedder.embed(chunks.map((c) => c.text));
  fastify.metrics.embeddingRequests.inc();
  fastify.metrics.chunksProcessed.inc(chunks.length);
  const ext = path.extname(event.path);
  const title = path.basename(event.path, ext);

  const points = chunks.map((chunk, i) => ({
    id: chunkId(event.path, i),
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

  await fastify.qdrant.upsert('cognivault', { points });

  // Delete stale vectors where chunk_index >= new chunk count
  await fastify.qdrant.delete('cognivault', {
    filter: {
      must: [
        { key: 'path', match: { value: event.path } },
        { key: 'chunk_index', range: { gte: chunks.length } },
      ],
    },
  });
  fastify.metrics.staleVectorCleanups.inc();

  // Update embedding_model_version in indexed_files
  fastify.db
    .update(indexedFiles)
    .set({ embeddingModelVersion: config.EMBEDDING_MODEL })
    .where(eq(indexedFiles.path, event.path))
    .run();
}

/**
 * Process a markdown file: parse frontmatter, chunk, embed, upsert.
 */
async function processMarkdown(fastify: FastifyInstance, event: FileChangeEvent): Promise<void> {
  let rawContent: string;
  try {
    const result = await fastify.vault.readContent(event.path);
    rawContent = result.content;
  } catch (err: unknown) {
    fastify.log.error({ event, err }, 'Pipeline: failed to read file content — skipping');
    return;
  }

  const parsed = matter(rawContent);
  const title = path.basename(event.path, '.md');
  const chunks = chunkMarkdown(parsed.content, { title });

  if (chunks.length === 0) {
    // Frontmatter-only note: skip embedding but clean stale vectors
    await fastify.qdrant.delete('cognivault', {
      filter: {
        must: [
          { key: 'path', match: { value: event.path } },
          { key: 'chunk_index', range: { gte: 0 } },
        ],
      },
    });
    fastify.metrics.staleVectorCleanups.inc();
    return;
  }

  const embeddings = await fastify.embedder.embed(chunks.map((c) => c.text));
  fastify.metrics.embeddingRequests.inc();
  fastify.metrics.chunksProcessed.inc(chunks.length);

  const frontmatterData = parsed.data as Record<string, unknown>;

  const points = chunks.map((chunk, i) => ({
    id: chunkId(event.path, i),
    vector: embeddings[i] as number[],
    payload: {
      path: event.path,
      title,
      chunk_index: i,
      section_path: chunk.sectionPath,
      tags: Array.isArray(frontmatterData.tags)
        ? frontmatterData.tags
        : typeof frontmatterData.tags === 'string'
          ? [frontmatterData.tags]
          : [],
      project: frontmatterData.project ?? null,
      status: frontmatterData.status ?? null,
      type: frontmatterData.type ?? null,
      content_hash: event.contentHash,
      extra_metadata: JSON.stringify(omit(frontmatterData, ['tags', 'project', 'status', 'type'])),
      text: chunk.text,
    },
  }));

  await fastify.qdrant.upsert('cognivault', { points });

  // Delete stale vectors where chunk_index >= new chunk count (handles shrinking notes)
  await fastify.qdrant.delete('cognivault', {
    filter: {
      must: [
        { key: 'path', match: { value: event.path } },
        { key: 'chunk_index', range: { gte: chunks.length } },
      ],
    },
  });
  fastify.metrics.staleVectorCleanups.inc();

  // Update embedding_model_version in indexed_files
  fastify.db
    .update(indexedFiles)
    .set({ embeddingModelVersion: config.EMBEDDING_MODEL })
    .where(eq(indexedFiles.path, event.path))
    .run();
}

/**
 * Process an image file: scan markdown files for backlinks and store in SQLite.
 * Images are NOT embedded into Qdrant.
 */
async function processImage(fastify: FastifyInstance, event: FileChangeEvent): Promise<void> {
  // Read all markdown file rows from DB
  const mdFiles = fastify.db
    .select()
    .from(indexedFiles)
    .where(eq(indexedFiles.fileType, 'md'))
    .all();

  const imageName = path.basename(event.path);
  const markdownContents: Array<{ path: string; content: string }> = [];

  for (const mdFile of mdFiles) {
    try {
      const result = await fastify.vault.readContent(mdFile.path);
      markdownContents.push({ path: mdFile.path, content: result.content });
    } catch {
      // File may have been deleted since DB query — skip
    }
  }

  const linkedNotes = extractImageBacklinks(imageName, markdownContents);

  fastify.db
    .update(indexedFiles)
    .set({ linkedNotes: JSON.stringify(linkedNotes) })
    .where(eq(indexedFiles.path, event.path))
    .run();
}

async function processCreatedOrUpdated(
  fastify: FastifyInstance,
  event: FileChangeEvent,
): Promise<void> {
  const end = fastify.metrics.pipelineDuration.startTimer();
  try {
    const ext = path.extname(event.path).toLowerCase();

    // Image files: SQLite tracking only, no Qdrant vectors
    if (IMAGE_EXTENSIONS.has(ext)) {
      await processImage(fastify, event);
      return;
    }

    // Text formats: extract chunks -> embed -> upsert to Qdrant
    let chunks: Array<{ text: string; sectionPath: string; chunkIndex: number }>;
    const extraPayload: Record<string, unknown> = {
      tags: [],
      project: null,
      status: null,
      type: null,
      extra_metadata: '{}',
    };

    switch (ext) {
      case '.md':
        // Delegate to full markdown handler (preserves frontmatter logic)
        await processMarkdown(fastify, event);
        return;

      case '.pdf': {
        const vaultRoot = (fastify.vault as unknown as { rootPath: string }).rootPath;
        const absPath = path.join(vaultRoot, event.path);
        const buffer = await fs.readFile(absPath);
        const filename = path.basename(event.path, ext);
        chunks = await chunkPdf(buffer, filename);
        break;
      }

      case '.csv': {
        const result = await fastify.vault.readContent(event.path);
        const filename = path.basename(event.path, ext);
        chunks = chunkCsv(result.content, filename);
        break;
      }

      case '.canvas': {
        const result = await fastify.vault.readContent(event.path);
        const canvasName = path.basename(event.path, ext);
        chunks = chunkCanvas(result.content, canvasName);
        break;
      }

      case '.excalidraw': {
        const result = await fastify.vault.readContent(event.path);
        const drawingName = path.basename(event.path, ext);
        chunks = chunkExcalidraw(result.content, drawingName);
        break;
      }

      default:
        // Unknown extension — skip
        return;
    }

    await embedAndUpsert(fastify, event, chunks, extraPayload);
  } finally {
    end();
  }
}

async function processDeleted(fastify: FastifyInstance, event: FileChangeEvent): Promise<void> {
  const ext = path.extname(event.path).toLowerCase();

  // Image files have no Qdrant vectors — nothing to delete from Qdrant
  if (IMAGE_EXTENSIONS.has(ext)) {
    return;
  }

  await fastify.qdrant.delete('cognivault', {
    filter: {
      must: [{ key: 'path', match: { value: event.path } }],
    },
  });
}

async function processMoved(fastify: FastifyInstance, event: FileChangeEvent): Promise<void> {
  const ext = path.extname(event.path).toLowerCase();
  const newTitle = path.basename(event.path, ext);

  // Image files have no Qdrant vectors — skip setPayload
  if (IMAGE_EXTENSIONS.has(ext)) {
    return;
  }

  await fastify.qdrant.setPayload('cognivault', {
    payload: {
      path: event.path,
      title: newTitle,
    },
    filter: {
      must: [{ key: 'path', match: { value: event.oldPath } }],
    },
  });
}

async function pipelinePlugin(fastify: FastifyInstance): Promise<void> {
  const queue = new PQueue({ concurrency: 3, timeout: 120_000 });
  fastify.decorate('pipelineQueue', queue);

  const onChanges = (events: FileChangeEvent[]): void => {
    for (const event of events) {
      void queue.add(async () => {
        try {
          switch (event.type) {
            case 'created':
            case 'updated':
              await processCreatedOrUpdated(fastify, event);
              break;
            case 'deleted':
              await processDeleted(fastify, event);
              break;
            case 'moved':
              await processMoved(fastify, event);
              break;
          }
        } catch (err: unknown) {
          fastify.log.error({ event, err }, 'Pipeline processing failed — will retry on next poll');
        } finally {
          // no-op: gauge updated via queue events below
        }
      });
      // Update queue depth gauge after adding to queue
      fastify.metrics.indexQueueDepth.set(queue.size + queue.pending);
    }
  };

  // Update gauge when PQueue completes a task (pending is already decremented)
  queue.on('next', () => {
    fastify.metrics.indexQueueDepth.set(queue.size + queue.pending);
  });
  queue.on('idle', () => {
    fastify.metrics.indexQueueDepth.set(0);
  });

  fastify.indexer.on('changes', onChanges);

  fastify.addHook('onClose', async () => {
    fastify.indexer.removeListener('changes', onChanges);
    queue.clear();
    await queue.onIdle();
  });
}

export default fp(pipelinePlugin, {
  name: 'pipeline',
  dependencies: ['indexer', 'qdrant', 'embedder', 'vault', 'db', 'metrics'],
});
