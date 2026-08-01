import type { FastifyInstance } from 'fastify';
import { httpError } from '../lib/http-error.js';
import {
  COLLECTION_BLOCKED_CODE,
  COLLECTION_BLOCKED_STATUS,
  collectionBlockedMessage,
} from './qdrant.js';

/**
 * Refuse anything that reads or writes vectors while the collection is blocked.
 *
 * The alternatives were both worse:
 *  - letting the call through returns whatever Qdrant makes of a query against a
 *    collection with the wrong vector schema. On the customer's database that is either
 *    an opaque 400 about an unknown vector name or, for the sparse-only branch, a
 *    perfectly successful EMPTY result — and an empty result is a lie an agent cannot
 *    detect: it reads as "the vault has nothing on that", and the answer built on top
 *    of it is confidently wrong.
 *  - failing the process at startup, which is what this replaces: it took the fix
 *    (`POST /api/admin/collection/rebuild`) down with the service that hosts it.
 *
 * So the honest answer is an explicit refusal that names the state and the way out.
 */
export function collectionBlockedError(): Error {
  return httpError(COLLECTION_BLOCKED_STATUS, COLLECTION_BLOCKED_CODE, collectionBlockedMessage());
}

/** Throw the 503 when the collection cannot serve. A no-op in the normal state. */
export function assertCollectionUsable(fastify: FastifyInstance): void {
  if (fastify.hasDecorator('qdrantAdmin') && fastify.qdrantAdmin.blocked) {
    throw collectionBlockedError();
  }
}

/**
 * Guard every route of the enclosing plugin. Registered INSIDE a feature plugin, so it
 * covers that feature and nothing else — the admin routes must stay reachable, since the
 * rebuild that lifts the block is one of them.
 *
 * A hook that throws, rather than one that replies: the error handler is what renders
 * `{ error: { code, message } }` and what honours a TOON `Accept` header, and search is
 * a TOON-negotiated surface. Route-level hooks run after the app-level auth hook, so an
 * unauthenticated caller still gets 401 first — a 503 naming the collection is not
 * something to hand out before the token is checked.
 */
export function registerCollectionGuard(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', async () => {
    assertCollectionUsable(fastify);
  });
}
