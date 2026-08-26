import type { QdrantClientParams } from '@qdrant/js-client-rest';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { BM25_SCHEME_VERSION, BM25_VECTOR_NAME, DENSE_VECTOR_NAME } from '../lib/bm25.js';
import { resolveDimensions } from '../lib/embedding.js';
import { QdrantTokenProvider, resolveQdrantAuthUrl } from '../lib/qdrant-auth.js';
import { buildQdrantTlsMaterial, describeQdrantTls, installQdrantTls } from '../lib/qdrant-tls.js';
import { TenantQdrantClient } from '../lib/tenant-qdrant-client.js';

declare module 'fastify' {
  interface FastifyInstance {
    createTenantQdrant: (userId: string) => TenantQdrantClient;
    purgeUserVectors: (userId: string) => Promise<void>;
    qdrantAdmin: QdrantAdmin;
  }
}

/**
 * What the operator is about to destroy, and whether the corpus in it is comparable to
 * this build. `null` means "could not be read" — a dropped collection reports
 * `pointsCount: null`, which is exactly the honest answer while a rebuild is running.
 */
export interface QdrantCollectionInfo {
  /** Physical collection holding the vectors — the name a rebuild must confirm. */
  collection: string;
  /** Alias all runtime point traffic goes through. */
  alias: string;
  /** BM25 scheme version recorded on the collection, or null when unknown/unreadable. */
  schemeVersion: number | null;
  /** BM25 scheme version this build produces. */
  expectedSchemeVersion: number;
  /** Points currently in the collection, or null when it cannot be read. */
  pointsCount: number | null;
  /**
   * True when nothing can be searched or indexed until an operator rebuilds — a legacy
   * collection occupies the alias name. `collection` then names THAT collection, which
   * is what a rebuild confirms and destroys.
   */
  blocked: boolean;
}

/**
 * Collection-level maintenance, exposed to the admin feature so a rebuild can go
 * through the SAME creation path startup uses ({@link createCollectionWithSchema}).
 * Every method reads `holder.current`, so a renewed IAM token is picked up.
 */
export interface QdrantAdmin {
  /** Alias runtime traffic goes through ({@link COLLECTION_NAME}). */
  readonly alias: string;
  /**
   * The collection a rebuild targets: normally the physical collection the alias
   * resolved to at startup, and in the blocked state the legacy collection squatting
   * the alias name. Either way it is the string `confirm` must carry, and it is what
   * {@link dropCollection} deletes.
   *
   * NOT a constant — {@link createCollection} moves it to {@link PHYSICAL_COLLECTION}
   * once a rebuild has resolved a blocked start. Read it at call time.
   */
  readonly collection: string;
  /** {@link BM25_SCHEME_VERSION} of this build. */
  readonly expectedSchemeVersion: number;
  /**
   * True while the collection cannot serve and only an operator can resolve it. Search,
   * `/context` and indexing refuse with 503; the admin API stays open, because the fix
   * runs through it.
   */
  readonly blocked: boolean;
  describe(): Promise<QdrantCollectionInfo>;
  /** Delete the physical collection. A collection that is already gone is a success. */
  dropCollection(): Promise<void>;
  /** Re-create it with the current schema and point the alias back at it. */
  createCollection(): Promise<void>;
}

/**
 * The name everything at runtime talks to. Since the hybrid rework this is an ALIAS,
 * not a collection: point traffic (search/query/upsert/delete) goes through it, so a
 * future re-index can build a new physical collection and repoint the alias atomically.
 */
export const COLLECTION_NAME = 'cognivault';

/**
 * The physical collection the alias points at. Bump this (and re-index) whenever the
 * schema changes incompatibly — the previous collection stays untouched as the
 * rollback path.
 */
export const PHYSICAL_COLLECTION = 'cognivault_v2';

// Vector names come from the module that also builds the sparse vectors — the schema
// declared here and the vectors written at index time must never drift apart.
export { BM25_VECTOR_NAME, DENSE_VECTOR_NAME };

/**
 * Id of the point that records which BM25 scheme the collection's sparse vectors were
 * built with. See {@link enforceSchemeVersion} for why the record lives in a point.
 *
 * The nil UUID, chosen because it cannot collide with a chunk: chunk ids are
 * `uuidv5(...)` (`src/plugins/pipeline.ts`), and a v5 UUID always carries the version
 * nibble `5` and the RFC 4122 variant bits, neither of which the nil UUID has.
 */
export const SCHEME_POINT_ID = '00000000-0000-0000-0000-000000000000';

/** Payload key on {@link SCHEME_POINT_ID} carrying the recorded scheme version. */
export const SCHEME_VERSION_FIELD = 'bm25_scheme_version';

/**
 * Version of the `@qdrant/js-client-rest` dependency. Hardcoded on purpose:
 * importing package.json would require JSON import assertions in ESM.
 * Keep in sync with the version range in package.json.
 */
const QDRANT_CLIENT_VERSION = '1.17.0';

/** Largest tolerated minor-version gap between client and server before warning. */
const MAX_MINOR_SKEW = 1;

type PayloadFieldSchema = Parameters<QdrantClient['createPayloadIndex']>[1]['field_schema'];

const TEXT_INDEXES = ['text', 'title', 'section_path'] as const;

const TEXT_INDEX_SCHEMA: PayloadFieldSchema = {
  type: 'text',
  tokenizer: 'multilingual',
  lowercase: true,
};

/**
 * `is_tenant` tells Qdrant to co-locate points of one user on disk, which is exactly
 * how every request filters. Only valid on a keyword index.
 */
const USER_ID_INDEX_SCHEMA: PayloadFieldSchema = {
  type: 'keyword',
  is_tenant: true,
};

const PAYLOAD_INDEXES: Array<{ field: string; type: 'keyword' | 'integer' | 'bool' }> = [
  { field: 'path', type: 'keyword' },
  { field: 'tags', type: 'keyword' },
  { field: 'project', type: 'keyword' },
  { field: 'status', type: 'keyword' },
  { field: 'type', type: 'keyword' },
  { field: 'chunk_index', type: 'integer' },
  // Archived pages are excluded from search by default. Points written before
  // this field existed simply lack it, which is why the exclusion is expressed
  // as `must_not archived == true` and never as `must archived == false`:
  // a `match` does not match a missing key, so the latter would hide the entire
  // pre-existing collection until a re-index.
  { field: 'archived', type: 'bool' },
];

/**
 * Qdrant answers "index already exists" differently across versions (409 status or a
 * plain message), so probe both shapes before deciding an error is benign.
 */
function isAlreadyExistsError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const candidate = err as { message?: unknown; status?: unknown; statusCode?: unknown };
  if (candidate.status === 409 || candidate.statusCode === 409) {
    return true;
  }
  return typeof candidate.message === 'string' && /already exists/i.test(candidate.message);
}

/**
 * Whether an error means "the collection is not there". Deleting an absent collection is
 * the outcome a drop wanted, so this has to be recognised: a rebuild retried after a
 * failed re-creation starts from a collection that is already gone.
 */
function isNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const candidate = err as { message?: unknown; status?: unknown; statusCode?: unknown };
  if (candidate.status === 404 || candidate.statusCode === 404) {
    return true;
  }
  return (
    typeof candidate.message === 'string' &&
    /(not found|doesn'?t exist|does not exist)/i.test(candidate.message)
  );
}

/**
 * Create a payload index if it is missing. Idempotent: "already exists" is silently
 * ignored. Any other failure is logged but never thrown — a missing index degrades
 * search quality, it must not prevent the service from starting.
 */
async function ensurePayloadIndex(
  client: QdrantClient,
  collection: string,
  field: string,
  fieldSchema: PayloadFieldSchema,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    await client.createPayloadIndex(collection, {
      field_name: field,
      field_schema: fieldSchema,
    });
  } catch (err: unknown) {
    if (isAlreadyExistsError(err)) {
      return;
    }
    log.error({ err, field }, 'Failed to create Qdrant payload index');
  }
}

type CreateCollectionBody = Parameters<QdrantClient['createCollection']>[1];
type CollectionInfo = Awaited<ReturnType<QdrantClient['getCollection']>>;

/**
 * The hybrid schema: one NAMED dense vector plus a sparse BM25 vector with the `idf`
 * modifier (Qdrant computes the IDF part of the BM25 score server-side, so the indexer
 * only has to ship term frequencies).
 *
 * `on_disk` on the dense vector and `on_disk_payload` keep RAM proportional to the
 * index structures rather than to the corpus.
 *
 * Quantization is opt-in (`QDRANT_QUANTIZATION`). The database is external and
 * centrally managed: shrinking vectors to int8 is the operator's decision and can be
 * applied later with `update_collection`, without a re-index.
 */
function buildCollectionSchema(dimensions: number): CreateCollectionBody {
  const body: CreateCollectionBody = {
    vectors: {
      [DENSE_VECTOR_NAME]: {
        size: dimensions,
        distance: 'Cosine',
        on_disk: true,
      },
    },
    sparse_vectors: {
      [BM25_VECTOR_NAME]: {
        modifier: 'idf',
      },
    },
    on_disk_payload: true,
  };

  if (config.QDRANT_QUANTIZATION) {
    body.quantization_config = {
      scalar: {
        type: 'int8',
        quantile: 0.99,
        // The quantized copy stays in RAM while the originals live on disk — that is
        // the whole point of turning quantization on.
        always_ram: true,
      },
    };
  }

  return body;
}

/**
 * Create the collection and everything that must exist alongside it: the payload
 * indexes, the full-text indexes, the `user_id` tenant index and the BM25 scheme
 * marker.
 *
 * THE ONLY place a collection is created. Startup calls it through
 * {@link resolveCollection}; `POST /api/admin/collection/rebuild` calls it through
 * {@link QdrantAdmin.createCollection}. A second copy of these parameters would drift
 * from this one and produce a collection that looks right and ranks wrong.
 */
async function createCollectionWithSchema(
  client: QdrantClient,
  collection: string,
  dimensions: number,
  log: FastifyBaseLogger,
): Promise<void> {
  await client.createCollection(collection, buildCollectionSchema(dimensions));
  log.info({ collection, dimensions }, 'Created Qdrant collection');

  for (const { field, type } of PAYLOAD_INDEXES) {
    await ensurePayloadIndex(client, collection, field, type, log);
  }
  for (const field of TEXT_INDEXES) {
    await ensurePayloadIndex(client, collection, field, TEXT_INDEX_SCHEMA, log);
  }
  await ensurePayloadIndex(client, collection, 'user_id', USER_ID_INDEX_SCHEMA, log);

  // A collection this build creates is comparable to this build by construction, so the
  // marker is written unconditionally here — see enforceSchemeVersion for when it is not.
  await recordSchemeVersion(client, collection, log);
}

type AliasActions = Parameters<QdrantClient['updateCollectionAliases']>[0]['actions'];

/**
 * Make {@link COLLECTION_NAME} point at `collection`, whatever it pointed at before.
 *
 * Idempotent, and atomic when it has to move: Qdrant applies the whole action list or
 * none of it, so the alias is never absent between the two steps. Dropping a collection
 * takes its aliases with it, which is why a rebuild has to re-attach rather than assume.
 */
async function ensureAlias(
  client: QdrantClient,
  collection: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const { aliases } = await client.getAliases();
  const existing = aliases.find((a) => a.alias_name === COLLECTION_NAME);

  if (existing?.collection_name === collection) {
    return;
  }

  const actions: AliasActions = [];
  if (existing !== undefined) {
    actions.push({ delete_alias: { alias_name: COLLECTION_NAME } });
  }
  actions.push({ create_alias: { collection_name: collection, alias_name: COLLECTION_NAME } });

  await client.updateCollectionAliases({ actions });
  log.info({ alias: COLLECTION_NAME, collection }, 'Attached Qdrant collection alias');
}

/**
 * Classify the `vectors` block of an existing collection. The legacy schema stored a
 * single UNNAMED vector (`{ size, distance }`); the hybrid schema stores a map keyed
 * by vector name. Telling them apart matters: reading `.size` off a named config
 * yields `undefined`, which would silently disable the dimension guard.
 */
function describeVectorSchema(
  vectors: unknown,
): { kind: 'unnamed' } | { kind: 'named'; denseSize: number | undefined } | { kind: 'absent' } {
  if (typeof vectors !== 'object' || vectors === null) {
    return { kind: 'absent' };
  }
  const record = vectors as Record<string, unknown>;
  if (typeof record.size === 'number') {
    return { kind: 'unnamed' };
  }
  const dense = record[DENSE_VECTOR_NAME];
  if (typeof dense !== 'object' || dense === null) {
    return { kind: 'named', denseSize: undefined };
  }
  const size = (dense as { size?: unknown }).size;
  return { kind: 'named', denseSize: typeof size === 'number' ? size : undefined };
}

/** Advice appended to every "this collection cannot be used" error. */
function recreateHint(collection: string): string {
  return (
    `Drop and re-create "${collection}" with the current schema and re-index ` +
    '(the service creates it on start once the name is free).'
  );
}

/**
 * Fail startup when the existing collection cannot serve the current build, and warn
 * about degradations that are survivable.
 *
 * Fatal: legacy unnamed vectors, a missing `dense` vector, a dense vector sized for a
 * different embedding model. Survivable: a missing `bm25` sparse vector — dense search
 * still answers, lexical retrieval simply has nothing to read.
 */
function assertUsableCollection(
  info: CollectionInfo,
  collection: string,
  dimensions: number,
  log: FastifyBaseLogger,
): void {
  const schema = describeVectorSchema(info.config?.params?.vectors);

  if (schema.kind === 'unnamed') {
    throw new Error(
      `Qdrant collection "${collection}" uses the legacy UNNAMED vector schema, but this ` +
        `build requires a named "${DENSE_VECTOR_NAME}" vector plus a sparse ` +
        `"${BM25_VECTOR_NAME}" vector. ${recreateHint(collection)}`,
    );
  }

  if (schema.kind === 'absent') {
    log.warn(
      { collection },
      'Qdrant did not report a vector configuration — skipping the dimension check',
    );
    return;
  }

  if (schema.denseSize === undefined) {
    throw new Error(
      `Qdrant collection "${collection}" has no "${DENSE_VECTOR_NAME}" vector. ` +
        recreateHint(collection),
    );
  }

  // Vector size is fixed at creation; switching embedding providers/models with a
  // different dimension requires a fresh collection and re-index.
  if (schema.denseSize !== dimensions) {
    throw new Error(
      `Qdrant collection "${collection}" has vector size ${schema.denseSize}, but the ` +
        `active embedding provider produces ${dimensions}. Recreate the collection and ` +
        're-index after changing EMBEDDING_PROVIDER/model.',
    );
  }

  const sparse = info.config?.params?.sparse_vectors;
  if (typeof sparse !== 'object' || sparse === null || !(BM25_VECTOR_NAME in sparse)) {
    log.warn(
      { collection },
      `Qdrant collection has no "${BM25_VECTOR_NAME}" sparse vector — lexical/hybrid ` +
        'retrieval is unavailable until the collection is re-created and re-indexed',
    );
  }
}

/**
 * Read the BM25 scheme version recorded on {@link SCHEME_POINT_ID}, or `undefined` when
 * the collection carries no marker (or the read failed — treated the same, because an
 * unreadable marker is exactly as unknown as an absent one).
 */
async function readSchemeVersion(
  client: QdrantClient,
  collection: string,
  log: FastifyBaseLogger,
): Promise<number | undefined> {
  try {
    const points = await client.retrieve(collection, {
      ids: [SCHEME_POINT_ID],
      with_payload: true,
      with_vector: false,
    });
    const recorded = points[0]?.payload?.[SCHEME_VERSION_FIELD];
    return typeof recorded === 'number' ? recorded : undefined;
  } catch (err: unknown) {
    log.warn({ err, collection }, 'Could not read the BM25 scheme marker');
    return undefined;
  }
}

/**
 * Stamp the running {@link BM25_SCHEME_VERSION} onto the collection.
 *
 * `vector: {}` — the marker carries NO vectors at all (Qdrant allows a point to hold a
 * subset of the collection's named vectors), so it is not a candidate in any dense or
 * sparse branch even before filtering. It also carries no `user_id`, which is what
 * actually keeps it out of results: every request goes through `TenantQdrantClient`,
 * which appends `{ key: 'user_id', match: { value } }` to the outer filter and to every
 * prefetch branch, and a `match` on a missing payload key never matches.
 *
 * Best-effort on purpose, like {@link ensurePayloadIndex}: a failed stamp costs the next
 * start a "version unknown" warning, and that is a far better outcome than refusing to
 * serve because a metadata write did not land.
 */
async function recordSchemeVersion(
  client: QdrantClient,
  collection: string,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    await client.upsert(collection, {
      wait: true,
      points: [
        {
          id: SCHEME_POINT_ID,
          vector: {},
          payload: { [SCHEME_VERSION_FIELD]: BM25_SCHEME_VERSION },
        },
      ],
    });
    log.info(
      { collection, bm25SchemeVersion: BM25_SCHEME_VERSION },
      'Recorded the BM25 scheme version on the collection',
    );
  } catch (err: unknown) {
    log.warn(
      { err, collection },
      'Could not record the BM25 scheme version — the next start will report it as unknown',
    );
  }
}

/**
 * Make {@link BM25_SCHEME_VERSION} mean something.
 *
 * The sparse vectors are only comparable to a query vector built by the SAME tokenizer
 * and the same weights. Nothing in Qdrant notices when they are not: index-time and
 * query-time terms simply stop lining up and the lexical branch quietly ranks worse.
 * So the version the corpus was built with is recorded next to the corpus and compared
 * on every start.
 *
 * WHERE the record lives. The vectors belong to the collection, which is shared by all
 * tenants (`user_id` payload, `is_tenant: true`), so a per-user row in SQLite would be
 * the wrong scope — n copies of one fact, and a fresh user would "agree" with any
 * collection. Qdrant has no collection-level metadata, which leaves:
 *  - a marker POINT (chosen) — travels with the collection through snapshots and
 *    copies, readable with one `retrieve`, and provably invisible (see
 *    {@link recordSchemeVersion});
 *  - a marker ALIAS, e.g. `cognivault_bm25_v3` — cheap and unable to pollute anything,
 *    but it is not part of the collection: a snapshot restore or a collection copy
 *    silently arrives without it, and it squats a name in the shared alias/collection
 *    namespace;
 *  - a side collection — an extra object to create, migrate and keep pointing at the
 *    right physical collection, for one integer;
 *  - the version stamped into EVERY point's payload — the most precise option (it can
 *    count exactly how many points are stale and it heals itself as points are
 *    re-indexed), but it changes the point schema, needs its own payload index to be
 *    countable, and answers a question nobody asks: a partially re-indexed corpus is
 *    not a supported state, whereas "this collection was built at vN" is the fact the
 *    deploy procedure actually turns on.
 *
 * WHEN it is written: when this build creates the collection (in
 * {@link createCollectionWithSchema}, which is also the path
 * `POST /api/admin/collection/rebuild` takes), and here when it adopts an EMPTY
 * unversioned one. Never on a non-empty collection whose version is unknown — stamping
 * that would replace an honest "unknown" with a confident lie, which is the failure this
 * whole check exists to remove.
 *
 * WHY it does not fail startup, unlike the dimension check above:
 *  - a dimension mismatch makes every upsert and every dense query fail at the Qdrant
 *    level, so refusing to start loses nothing. A scheme mismatch is a partial,
 *    one-sided degradation: dense retrieval is untouched, hybrid still fuses two
 *    branches, only lexical ranking suffers. Serving degraded beats serving nothing.
 *  - the only cure is a re-index, and re-indexing runs THROUGH this service
 *    (`POST /api/admin/reindex`, plus the in-process vault poller). A process that
 *    refuses to start cannot be told to repair itself — the operator would be locked
 *    out of the fix by the check meant to prompt it.
 *  - the intended deploy order is: ship the new build, index into a fresh collection,
 *    then repoint the alias. There is a legitimate window in which the alias still
 *    points at the old collection; failing startup would turn that window into a
 *    CrashLoopBackOff and, on OpenShift, a rollback before anyone could act.
 *
 * Returns true when the collection's lexical vectors are NOT known to match this build.
 */
async function enforceSchemeVersion(
  client: QdrantClient,
  collection: string,
  pointsCount: number | null | undefined,
  log: FastifyBaseLogger,
): Promise<boolean> {
  const recorded = await readSchemeVersion(client, collection, log);

  if (recorded === BM25_SCHEME_VERSION) {
    log.info({ collection, bm25SchemeVersion: recorded }, 'BM25 scheme version matches');
    return false;
  }

  if (recorded !== undefined) {
    log.error(
      { collection, recorded, expected: BM25_SCHEME_VERSION },
      `Qdrant collection "${collection}" was indexed with BM25 scheme v${recorded}, but this ` +
        `build produces v${BM25_SCHEME_VERSION}. Index-time and query-time terms no longer ` +
        'line up, so /search/lexical and the lexical branch of /search/hybrid return ' +
        'degraded results until the corpus is re-indexed (dense search is unaffected). ' +
        `Fix: index into a fresh collection with this build and repoint the ` +
        `"${COLLECTION_NAME}" alias at it.`,
    );
    return true;
  }

  // No marker. An EMPTY collection has nothing that could be stale, so adopting it is
  // safe and silent-ish; a populated one predates this check and its provenance is
  // genuinely unknown, so it keeps warning until a fresh collection replaces it.
  if (pointsCount === 0) {
    await recordSchemeVersion(client, collection, log);
    return false;
  }

  log.warn(
    { collection, expected: BM25_SCHEME_VERSION, pointsCount },
    `Qdrant collection "${collection}" records no BM25 scheme version, so it cannot be ` +
      `proven comparable to this build's v${BM25_SCHEME_VERSION}. If it was indexed before ` +
      'this check existed, its lexical vectors may be stale and /search/lexical and the ' +
      'lexical branch of /search/hybrid are degraded. Index into a fresh collection with ' +
      `this build and repoint the "${COLLECTION_NAME}" alias at it; the marker is written ` +
      'automatically for a collection this build creates.',
  );
  return true;
}

/**
 * Error code and status the blocked state answers requests with. 503 rather than 500:
 * the request was fine and the service is healthy — one named resource is unavailable
 * pending a named human action. Rather than 4xx for the same reason: no client can fix
 * this by asking differently. Deliberately not 200-with-empty-results, which is the one
 * answer that lies (an agent reads it as "the vault has nothing on that").
 */
export const COLLECTION_BLOCKED_CODE = 'COLLECTION_BLOCKED';
export const COLLECTION_BLOCKED_STATUS = 503;

/**
 * What is wrong and what to do about it, in one string. Used verbatim by the startup
 * log, by the 503 body of every blocked endpoint, and by the indexing refusal — there
 * is exactly one description of this state and it names the way out.
 */
export function collectionBlockedMessage(): string {
  return (
    `"${COLLECTION_NAME}" exists as a COLLECTION, not as an alias, so the search alias ` +
    'cannot be created (Qdrant keeps aliases and collections in one namespace). That ' +
    'legacy collection predates the named ' +
    `"${DENSE_VECTOR_NAME}"/"${BM25_VECTOR_NAME}" vector schema, so this build can ` +
    'neither search it nor index into it. Search and indexing are therefore refused ' +
    'until an operator resolves it; nothing is renamed or deleted automatically. Fix, ' +
    'from the running service: settings → «Индекс и поиск» → «Пересоздать коллекцию», ' +
    `or POST /api/admin/collection/rebuild {"confirm":"${COLLECTION_NAME}"}. That DROPS ` +
    `the legacy "${COLLECTION_NAME}" collection — irreversible, its vectors are gone — ` +
    `then creates "${PHYSICAL_COLLECTION}" with the current schema, attaches the ` +
    `"${COLLECTION_NAME}" alias to it and re-indexes every user from the vault files.`
  );
}

/**
 * Resolve the physical collection behind {@link COLLECTION_NAME}, creating it and the
 * alias on first start.
 *
 * Cases:
 *  - alias exists → use whatever it points at. Pointing at something other than
 *    {@link PHYSICAL_COLLECTION} is a warning, never fatal: that is exactly the state
 *    of a rolled-back deployment, and it must keep serving.
 *  - alias missing, a COLLECTION already owns the name → BLOCKED. The alias cannot be
 *    created and the legacy vectors cannot be queried, but the process starts anyway:
 *    the only cure (`POST /api/admin/collection/rebuild`) runs through this service, and
 *    an operator with no shell and no database access — the deployment this was written
 *    for — has no other way to reach it. Exiting here turned a resolvable state into a
 *    CrashLoopBackOff with the fix locked inside the process that refused to start.
 *  - alias missing, name free → create {@link PHYSICAL_COLLECTION} unless it is
 *    already there (a previous half-finished start), then attach the alias.
 *
 * The legacy `cognivault` collection is never dropped, renamed or modified here — it is
 * still the rollback path, and destroying it stays an explicit, confirmed decision.
 */
async function resolveCollection(
  client: QdrantClient,
  dimensions: number,
  log: FastifyBaseLogger,
): Promise<{ collection: string; created: boolean; blocked: boolean }> {
  const { aliases } = await client.getAliases();
  const alias = aliases.find((a) => a.alias_name === COLLECTION_NAME);

  if (alias !== undefined) {
    if (alias.collection_name !== PHYSICAL_COLLECTION) {
      log.warn(
        {
          alias: COLLECTION_NAME,
          collection: alias.collection_name,
          expected: PHYSICAL_COLLECTION,
        },
        `Alias "${COLLECTION_NAME}" points at an older collection — re-index into ` +
          `"${PHYSICAL_COLLECTION}" and repoint the alias to pick up the hybrid schema`,
      );
    }
    return { collection: alias.collection_name, created: false, blocked: false };
  }

  const { collections } = await client.getCollections();
  const names = new Set(collections.map((c) => c.name));

  if (names.has(COLLECTION_NAME)) {
    // Once, at ERROR, with the collection named: this is the only line in the log that
    // explains why every search is answering 503.
    log.error(
      {
        collection: COLLECTION_NAME,
        expected: PHYSICAL_COLLECTION,
        blocked: true,
        rebuildConfirm: COLLECTION_NAME,
      },
      collectionBlockedMessage(),
    );
    return { collection: COLLECTION_NAME, created: false, blocked: true };
  }

  const created = !names.has(PHYSICAL_COLLECTION);
  if (created) {
    await createCollectionWithSchema(client, PHYSICAL_COLLECTION, dimensions, log);
  }

  await ensureAlias(client, PHYSICAL_COLLECTION, log);

  return { collection: PHYSICAL_COLLECTION, created, blocked: false };
}

/** Parse "1.16.3" into { major: 1, minor: 16 }; undefined when unparseable. */
function parseVersion(version: string): { major: number; minor: number } | undefined {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return undefined;
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Log the Qdrant server version at startup and warn on client/server skew.
 * Never fatal — an unreachable version endpoint must not block startup.
 */
async function logServerVersion(client: QdrantClient, log: FastifyBaseLogger): Promise<void> {
  try {
    const info = await client.versionInfo();
    const qdrantVersion = info.version;
    log.info({ qdrantVersion, clientVersion: QDRANT_CLIENT_VERSION }, 'Connected to Qdrant');

    const server = parseVersion(qdrantVersion);
    const clientVer = parseVersion(QDRANT_CLIENT_VERSION);
    if (!server || !clientVer) {
      return;
    }
    if (
      server.major !== clientVer.major ||
      Math.abs(server.minor - clientVer.minor) > MAX_MINOR_SKEW
    ) {
      log.warn(
        { qdrantVersion, clientVersion: QDRANT_CLIENT_VERSION },
        'Qdrant server/client version skew — API incompatibilities are possible',
      );
    }
  } catch (err: unknown) {
    log.warn({ err }, 'Could not determine Qdrant server version');
  }
}

/**
 * Which authentication scheme the client uses. Safe to log — it names the mode, never
 * the credential.
 *
 *  - `api-key` → a raw Qdrant with a static key;
 *  - `iam`     → Platform V Vector DB: username/password are exchanged at the IAM
 *                endpoint for a JWT sent as `Authorization: Bearer …`;
 *  - `none`    → no credentials (local development, in-cluster Qdrant).
 */
export type QdrantAuthMode = 'api-key' | 'iam' | 'none';

/**
 * Pick the authentication scheme. The two credentialed modes are mutually exclusive
 * (config validation rejects having both).
 *
 * HTTP Basic used to live here and is gone on purpose: Platform V Vector DB ignores it
 * outright — the server answered 401 "Must provide an API key or an Authorization
 * bearer token" to `Authorization: Basic`, exactly as it does to no header at all.
 */
function resolveAuthMode(): QdrantAuthMode {
  if (config.QDRANT_API_KEY) {
    return 'api-key';
  }
  if (config.QDRANT_USERNAME && config.QDRANT_PASSWORD) {
    return 'iam';
  }
  return 'none';
}

/**
 * Build the Qdrant client options for the chosen scheme:
 *  - `api-key` → the client's own `apiKey` param; it sets the `api-key` header itself
 *    and NO `Authorization` header is added;
 *  - `iam`     → `Authorization: Bearer <jwt>` minted by the IAM service;
 *  - `none`    → no credentials at all.
 *
 * On `apiKey` the client derives `this._https = https ?? typeof apiKey === 'string'`,
 * but a `url` immediately overrides the scheme from the URL itself, so an `https://`
 * QDRANT_URL is unaffected and the `https` param stays untouched (we never pass it).
 * The only leftover is a `console.warn` about an insecure connection when QDRANT_URL
 * is plain `http://` — accurate, and harmless for local development.
 *
 * NEVER log the returned object — it carries the api key in `apiKey` and the JWT in
 * `headers.Authorization`.
 */
function buildClientParams(mode: QdrantAuthMode, token?: string): QdrantClientParams {
  const params: QdrantClientParams = {
    url: config.QDRANT_URL,
    timeout: config.QDRANT_TIMEOUT_MS,
    // Client 1.17 vs server 1.16 makes the client print an incompatibility warning on
    // every start. We probe and log the server version ourselves (`logServerVersion`),
    // so the built-in check is pure noise.
    checkCompatibility: false,
  };

  if (mode === 'api-key') {
    params.apiKey = config.QDRANT_API_KEY;
    return params;
  }

  if (mode === 'iam' && token !== undefined) {
    params.headers = { Authorization: `Bearer ${token}` };
  }

  return params;
}

/**
 * The live client. `QdrantClient` freezes its headers at construction time, so a
 * renewed token cannot be pushed into an existing instance — the client is REPLACED
 * instead, and everything that talks to Qdrant reads `holder.current` at call time.
 */
interface QdrantClientHolder {
  current: QdrantClient;
}

/** Retry interval after a failed renewal — short, because the old token is expiring. */
const TOKEN_REFRESH_RETRY_MS = 30_000;

/** Never schedule a renewal tighter than this, so a bad clock cannot spin the loop. */
const MIN_TOKEN_REFRESH_DELAY_MS = 1_000;

/**
 * When to renew: `refreshSkewMs` before the token expires, clamped to a floor. An
 * unknown expiry (no cached token yet) also collapses to the floor.
 */
export function nextRefreshDelayMs(
  expiresAtMs: number | undefined,
  nowMs: number,
  skewMs: number,
): number {
  if (expiresAtMs === undefined) {
    return MIN_TOKEN_REFRESH_DELAY_MS;
  }
  return Math.max(MIN_TOKEN_REFRESH_DELAY_MS, expiresAtMs - nowMs - skewMs);
}

/** Log-safe token description: length and expiry only, never the token itself. */
function describeToken(
  token: string,
  provider: QdrantTokenProvider,
): { tokenLength: number; expiresAt: string | undefined; expirySource: string | undefined } {
  const expiresAtMs = provider.expiresAt;
  return {
    tokenLength: token.length,
    expiresAt: expiresAtMs === undefined ? undefined : new Date(expiresAtMs).toISOString(),
    expirySource: provider.expirySource,
  };
}

async function qdrantPlugin(fastify: FastifyInstance): Promise<void> {
  const dimensions = resolveDimensions(config);

  // Must precede the client and its first connection: the REST client ships its own
  // undici Agent, so the only reachable seam is `tls.connect` (see qdrant-tls.ts).
  installQdrantTls(config, fastify.log);

  const authMode = resolveAuthMode();

  // IAM mode mints the first token BEFORE the client exists — an unreachable IAM must
  // fail startup loudly, exactly as an unreachable Qdrant already does.
  let tokenProvider: QdrantTokenProvider | undefined;
  let token: string | undefined;
  if (authMode === 'iam') {
    const authUrl = resolveQdrantAuthUrl(config);
    tokenProvider = new QdrantTokenProvider({
      authUrl,
      username: config.QDRANT_USERNAME ?? '',
      password: config.QDRANT_PASSWORD ?? '',
      timeoutMs: config.QDRANT_TIMEOUT_MS,
      refreshSkewMs: config.QDRANT_TOKEN_REFRESH_SKEW_MS,
      tlsMaterial: buildQdrantTlsMaterial(config),
    });
    token = await tokenProvider.getToken();
    fastify.log.info(
      { qdrantAuthUrl: authUrl, ...describeToken(token, tokenProvider) },
      'Obtained Qdrant IAM token',
    );
  }

  const holder: QdrantClientHolder = {
    current: new QdrantClient(buildClientParams(authMode, token)),
  };
  // Startup work runs on this snapshot: the token was just minted, so it cannot expire
  // before the collection setup below finishes. Everything long-lived reads
  // `holder.current` instead.
  const client = holder.current;

  // Log MODES only — never the api key, the token, the params object, cert paths or
  // the key passphrase.
  fastify.log.info(
    {
      qdrantUrl: config.QDRANT_URL,
      qdrantAuth: authMode,
      qdrantTimeoutMs: config.QDRANT_TIMEOUT_MS,
      ...describeQdrantTls(config),
    },
    'Qdrant client configured',
  );

  if (tokenProvider !== undefined) {
    startTokenRefresh(fastify, tokenProvider, holder, authMode);
  }

  await logServerVersion(client, fastify.log);

  // Resolve (and on first start create) the collection behind the alias. Every
  // maintenance call below targets a PHYSICAL collection, never the alias: aliases are
  // for point traffic, and pinning admin work to a real name keeps it unambiguous while
  // an alias is being repointed — or, in the blocked state, while there is no alias at all.
  const {
    collection: resolvedCollection,
    created,
    blocked: initiallyBlocked,
  } = await resolveCollection(client, dimensions, fastify.log);

  // Both move when a rebuild resolves a blocked start: the target becomes
  // PHYSICAL_COLLECTION and the block lifts. Everything below reads them at call time.
  let collection = resolvedCollection;
  let blocked = initiallyBlocked;

  // A collection this build just created needs none of what follows: its schema is the
  // one this build asks for, its indexes and marker were written by
  // createCollectionWithSchema, and it holds no legacy points to purge. A BLOCKED one
  // must be left alone for the opposite reason — it is a foreign corpus this build has
  // no business reading, stamping, indexing or purging points out of. It is the
  // operator's to keep or destroy, and until they choose, untouched.
  let schemeMismatch = false;
  if (!created && !blocked) {
    const info = await client.getCollection(collection);
    assertUsableCollection(info, collection, dimensions, fastify.log);
    // Distinguishes "created before this check and never indexed" from "populated by an
    // unknown build" — see enforceSchemeVersion.
    const pointsCount = info.points_count;

    // Full-text and tenant indexes are re-asserted on every start — idempotent, and they
    // are the ones added after collections in the field had already been created.
    for (const field of TEXT_INDEXES) {
      await ensurePayloadIndex(client, collection, field, TEXT_INDEX_SCHEMA, fastify.log);
    }
    await ensurePayloadIndex(client, collection, 'user_id', USER_ID_INDEX_SCHEMA, fastify.log);

    // Purge legacy vectors without user_id payload. The scheme marker is deliberately
    // user-less for exactly the reason this purge exists, so it has to be excluded by id —
    // otherwise every start would wipe the record it is about to read.
    await client.delete(collection, {
      wait: true,
      filter: {
        must: [{ is_empty: { key: 'user_id' } }],
        must_not: [{ has_id: [SCHEME_POINT_ID] }],
      },
    });
    fastify.log.info('Purged legacy vectors without user_id');

    // Beside the dimension check in spirit, after the purge in order: the marker must not
    // be written into a delete that is still in flight.
    schemeMismatch = await enforceSchemeVersion(client, collection, pointsCount, fastify.log);
  }

  // A startup log scrolls away; the gauge is what an alert can hang off. Guarded because
  // this plugin is registered standalone in its own tests, without the metrics plugin.
  const setSchemeMismatchGauge = (mismatch: boolean): void => {
    if (fastify.hasDecorator('metrics')) {
      fastify.metrics.bm25SchemeMismatch.set(mismatch ? 1 : 0);
    }
  };
  const setBlockedGauge = (isBlocked: boolean): void => {
    if (fastify.hasDecorator('metrics')) {
      fastify.metrics.collectionBlocked.set(isBlocked ? 1 : 0);
    }
  };
  setSchemeMismatchGauge(schemeMismatch);
  // Two gauges, two meanings. A blocked collection leaves the scheme gauge at 0 on
  // purpose: "lexical ranking is degraded" and "nothing is searchable at all" call for
  // different alerts and different runbook steps, and one gauge cannot say both.
  setBlockedGauge(blocked);

  // Expose factory for tenant-scoped Qdrant clients — raw client stays internal.
  // Reads `holder.current` on every call, so a renewed token is picked up without
  // any coordination: the factory runs per request, never once at startup.
  fastify.decorate('createTenantQdrant', (userId: string) => {
    return new TenantQdrantClient(holder.current, userId);
  });

  // Collection-level maintenance for the admin feature. `collection` is whatever
  // startup resolved: the collection the alias points at, or — on a blocked start — the
  // legacy collection squatting the alias name. Either way it is the collection actually
  // occupying the namespace, and the name the operator has to type to confirm a rebuild.
  const qdrantAdmin: QdrantAdmin = {
    alias: COLLECTION_NAME,
    expectedSchemeVersion: BM25_SCHEME_VERSION,

    // Getters, not values: a rebuild that resolves a blocked start moves the target from
    // the legacy collection to PHYSICAL_COLLECTION, and every later reader must see that.
    get collection(): string {
      return collection;
    },
    get blocked(): boolean {
      return blocked;
    },

    async describe(): Promise<QdrantCollectionInfo> {
      const live = holder.current;
      let rawCount: number | null = null;
      try {
        const info = await live.getCollection(collection);
        rawCount = info.points_count ?? null;
      } catch (err: unknown) {
        // A dropped collection (mid-rebuild) is the expected reason. Reporting null beats
        // failing the status call the operator is watching the rebuild through.
        fastify.log.warn(
          { err, collection },
          'Could not read the collection for /api/admin/collection',
        );
      }
      const recorded = await readSchemeVersion(live, collection, fastify.log);
      // The scheme marker is a point, so a freshly created collection holds exactly one and
      // would report "1 fragment" — indistinguishable at a glance from a small healthy vault,
      // and precisely the state a pod restart mid-rebuild leaves behind: scheme current, no
      // warning, nothing indexed. Count what was indexed, not what is stored.
      //
      // Only subtract when a marker was actually read: a collection without one (the
      // legacy collection of a blocked start, above all) has no marker point to exclude,
      // and shaving a point off its count would misreport what is about to be destroyed.
      const pointsCount =
        rawCount === null ? null : recorded === undefined ? rawCount : Math.max(0, rawCount - 1);
      return {
        collection,
        alias: COLLECTION_NAME,
        schemeVersion: recorded ?? null,
        expectedSchemeVersion: BM25_SCHEME_VERSION,
        pointsCount,
        blocked,
      };
    },

    async dropCollection(): Promise<void> {
      try {
        await holder.current.deleteCollection(collection);
        fastify.log.warn(
          { collection, alias: COLLECTION_NAME },
          'Dropped the Qdrant collection — every tenant lost its vectors and search ' +
            'returns nothing until the rebuild finishes indexing',
        );
      } catch (err: unknown) {
        if (!isNotFoundError(err)) {
          throw err;
        }
        // Already gone: a retry of a rebuild that died between dropping and creating.
        fastify.log.warn({ collection }, 'Collection was already absent — nothing to drop');
      }
      // The alias goes with the collection (Qdrant deletes aliases of a deleted
      // collection). createCollection() re-attaches it explicitly rather than trusting
      // that, so either behaviour lands in the same place.
    },

    async createCollection(): Promise<void> {
      // Blocked start: dropCollection() has just deleted the legacy collection, so the
      // shared namespace is finally free. Build the structure this build expects —
      // cognivault_v2 with the alias on top — instead of re-creating the legacy name,
      // which would only reproduce the collision on the next boot.
      if (blocked) {
        await dropOrphanPhysicalCollection(holder.current, fastify.log);
        await createCollectionWithSchema(
          holder.current,
          PHYSICAL_COLLECTION,
          dimensions,
          fastify.log,
        );
        await ensureAlias(holder.current, PHYSICAL_COLLECTION, fastify.log);
        // Only now: the target moves and the block lifts together, after the collection
        // and the alias both exist. A throw above leaves both untouched, so a retry of
        // the rebuild still drops-and-creates the same way.
        collection = PHYSICAL_COLLECTION;
        blocked = false;
        setBlockedGauge(false);
        setSchemeMismatchGauge(false);
        fastify.log.warn(
          { collection: PHYSICAL_COLLECTION, alias: COLLECTION_NAME },
          `Legacy "${COLLECTION_NAME}" collection replaced by "${PHYSICAL_COLLECTION}" ` +
            'plus the alias — search and indexing are unblocked and every user is being ' +
            're-indexed from the vault files',
        );
        return;
      }

      await createCollectionWithSchema(holder.current, collection, dimensions, fastify.log);
      await ensureAlias(holder.current, collection, fastify.log);
      // Freshly stamped with this build's version — whatever the gauge said before, the
      // corpus about to be written is comparable to this build.
      setSchemeMismatchGauge(false);
    },
  };
  fastify.decorate('qdrantAdmin', qdrantAdmin);

  // Expose purge function for user removal cleanup
  fastify.decorate('purgeUserVectors', async (userId: string) => {
    // While blocked, COLLECTION_NAME resolves to the LEGACY COLLECTION, not to an alias
    // over ours — a delete-by-filter would reach into a corpus that is not this build's
    // to modify, for vectors it cannot contain (nothing was ever indexed into it here).
    if (blocked) {
      fastify.log.warn(
        { userId, collection: COLLECTION_NAME },
        'Skipped the vector purge for a removed user — the collection is blocked and ' +
          'holds no vectors written by this build; the pending rebuild destroys it whole',
      );
      return;
    }
    await holder.current.delete(COLLECTION_NAME, {
      wait: true,
      filter: { must: [{ key: 'user_id', match: { value: userId } }] },
    });
  });
}

/**
 * Remove a stray {@link PHYSICAL_COLLECTION} before a blocked start is rebuilt into it.
 *
 * It exists exactly when someone got part-way through the old manual migration — index
 * into `cognivault_v2`, then delete the legacy collection — and stopped after the first
 * half. Nothing reads it (the alias never reached it; runtime traffic went to the legacy
 * collection), and the rebuild that is running re-indexes every user from the vault
 * files, so keeping half a corpus around only guarantees the create below fails with
 * "already exists" and leaves the operator with neither collection.
 */
async function dropOrphanPhysicalCollection(
  client: QdrantClient,
  log: FastifyBaseLogger,
): Promise<void> {
  const { collections } = await client.getCollections();
  if (!collections.some((c) => c.name === PHYSICAL_COLLECTION)) {
    return;
  }
  log.warn(
    { collection: PHYSICAL_COLLECTION },
    `Dropping an orphaned "${PHYSICAL_COLLECTION}" left by an unfinished manual ` +
      'migration — no alias ever pointed at it, and the rebuild re-indexes everything',
  );
  try {
    await client.deleteCollection(PHYSICAL_COLLECTION);
  } catch (err: unknown) {
    if (!isNotFoundError(err)) {
      throw err;
    }
  }
}

/**
 * Keeps the Bearer token fresh. The timer fires `QDRANT_TOKEN_REFRESH_SKEW_MS` before
 * expiry, asks the provider for a token (which renews, since the cached one is inside
 * the skew window) and swaps in a client built with the new header.
 *
 * `unref()` keeps the timer from holding the event loop open; `onClose` clears it so a
 * closed app leaves nothing behind. A failed renewal is logged and retried shortly —
 * it must never take the process down, the current token is usually still valid.
 */
function startTokenRefresh(
  fastify: FastifyInstance,
  provider: QdrantTokenProvider,
  holder: QdrantClientHolder,
  authMode: QdrantAuthMode,
): void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const schedule = (delayMs: number): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void renew();
    }, delayMs);
    timer.unref();
  };

  const renew = async (): Promise<void> => {
    try {
      const fresh = await provider.getToken();
      holder.current = new QdrantClient(buildClientParams(authMode, fresh));
      fastify.log.info(describeToken(fresh, provider), 'Refreshed Qdrant IAM token');
      schedule(
        nextRefreshDelayMs(provider.expiresAt, Date.now(), config.QDRANT_TOKEN_REFRESH_SKEW_MS),
      );
    } catch (err: unknown) {
      fastify.log.error({ err }, 'Failed to refresh Qdrant IAM token — retrying shortly');
      schedule(TOKEN_REFRESH_RETRY_MS);
    }
  };

  fastify.addHook('onClose', async () => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  });

  schedule(nextRefreshDelayMs(provider.expiresAt, Date.now(), config.QDRANT_TOKEN_REFRESH_SKEW_MS));
}

export default fp(qdrantPlugin, { name: 'qdrant', dependencies: [] });
