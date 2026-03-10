import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import matter from 'gray-matter';
import PQueue from 'p-queue';
import { v5 as uuidv5 } from 'uuid';
import { config } from '../config.js';
import { indexedFiles } from '../db/schema.js';
import { chunkMarkdown } from '../lib/chunker.js';
import type { FileChangeEvent } from '../lib/indexer.js';

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

async function processCreatedOrUpdated(
  fastify: FastifyInstance,
  event: FileChangeEvent,
): Promise<void> {
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
    return;
  }

  const embeddings = await fastify.embedder.embed(chunks.map((c) => c.text));

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

  // Update embedding_model_version in indexed_files
  fastify.db
    .update(indexedFiles)
    .set({ embeddingModelVersion: config.EMBEDDING_MODEL })
    .where(eq(indexedFiles.path, event.path))
    .run();
}

async function processDeleted(fastify: FastifyInstance, event: FileChangeEvent): Promise<void> {
  await fastify.qdrant.delete('cognivault', {
    filter: {
      must: [{ key: 'path', match: { value: event.path } }],
    },
  });
}

async function processMoved(fastify: FastifyInstance, event: FileChangeEvent): Promise<void> {
  const newTitle = path.basename(event.path, '.md');

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
  const queue = new PQueue({ concurrency: 3 });

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
        }
      });
    }
  };

  fastify.indexer.on('changes', onChanges);

  fastify.addHook('onClose', async () => {
    fastify.indexer.removeListener('changes', onChanges);
    queue.clear();
    await queue.onIdle();
  });
}

export default fp(pipelinePlugin, {
  name: 'pipeline',
  dependencies: ['indexer', 'qdrant', 'embedder', 'vault', 'db'],
});
