import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Emitted by the indexing pipeline when a single file could not be indexed.
 * Consumers (e.g. the admin reindex job tracker) use it to surface per-file failures
 * instead of silently reporting a job as fully completed.
 */
export interface FileFailedEvent {
  userId: string;
  path: string;
  error: string;
}

/** Event name → argument tuple map for the pipeline event bus. */
export interface PipelineEventMap {
  'file-failed': [FileFailedEvent];
}

export type PipelineEventEmitter = EventEmitter<PipelineEventMap>;

declare module 'fastify' {
  interface FastifyInstance {
    pipelineEvents: PipelineEventEmitter;
  }
}

/**
 * Every in-flight reindex job subscribes for its own lifetime; the default limit of 10
 * would emit spurious MaxListenersExceededWarning under normal concurrent usage.
 */
const MAX_LISTENERS = 100;

async function pipelineEventsPlugin(fastify: FastifyInstance): Promise<void> {
  const emitter: PipelineEventEmitter = new EventEmitter<PipelineEventMap>();
  emitter.setMaxListeners(MAX_LISTENERS);

  fastify.decorate('pipelineEvents', emitter);

  fastify.addHook('onClose', async () => {
    emitter.removeAllListeners();
  });
}

export default fp(pipelineEventsPlugin, { name: 'pipeline-events' });
