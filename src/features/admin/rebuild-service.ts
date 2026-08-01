import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { FileChangeEvent } from '../../lib/indexer.js';
import type { FileFailedEvent } from '../../plugins/pipeline-events.js';
import type { AdminInterlock } from './interlock.js';

// ── Types ──

/**
 * Where the job is. Deliberately coarse — these are the four states with different
 * consequences for the operator, not a progress bar:
 *  - `dropping` — the collection still exists; nothing has been destroyed yet.
 *  - `creating` — the collection is GONE. Search answers nothing for every tenant.
 *  - `indexing` — the collection exists and is filling up. Search answers partially,
 *    from whatever has been indexed so far.
 *  - `done`     — reached on success only.
 */
export type RebuildPhase = 'dropping' | 'creating' | 'indexing' | 'done';

export type RebuildStatus = 'running' | 'completed' | 'failed';

export interface RebuildJob {
  id: string;
  status: RebuildStatus;
  phase: RebuildPhase;
  /** Collection being rebuilt — the string the operator had to confirm. */
  collection: string;
  /**
   * True when this rebuild is clearing a blocked start: `collection` is then the LEGACY
   * collection occupying the alias name, and finishing replaces it with the physical
   * collection plus the alias. Changes what the operator is told, not what runs.
   */
  resolvesBlock: boolean;
  /** BM25 scheme version the rebuilt collection is stamped with. */
  schemeVersion: number;
  usersTotal: number;
  usersDone: number;
  filesProcessed: number;
  errors: string[];
  /** Total failures observed, including those beyond {@link MAX_JOB_ERRORS}. */
  errorCount: number;
  startedAt: string;
  finishedAt?: string;
}

/** Cap on retained error strings per job — beyond this only errorCount grows. */
const MAX_JOB_ERRORS = 100;

/**
 * How often the wait for a user's scan re-checks `isIndexing`.
 *
 * `scanComplete` is the primary signal; this poll is the fallback for the one case that
 * never emits it — `runInitialScan()` throwing, which sets `isIndexing` back to false
 * and logs. Without the fallback a single unreadable vault would hang the rebuild in
 * `indexing` forever.
 */
const SCAN_POLL_INTERVAL_MS = 250;

type IndexerEntry = NonNullable<ReturnType<FastifyInstance['indexers']['get']>>;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function recordJobError(job: RebuildJob, message: string): void {
  job.errorCount += 1;
  if (job.errors.length < MAX_JOB_ERRORS) {
    job.errors.push(message);
  }
}

/** An error the route turns into a `{ error: { code, message } }` body. */
function httpError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

/**
 * Wait until the indexer's forced initial scan is over.
 *
 * `scanComplete` fires synchronously at the end of a successful scan, AFTER the change
 * events have been emitted — so by the time it resolves, the pipeline queue is already
 * loaded and `queue.onIdle()` means what the caller wants it to mean. A scan that throws
 * emits nothing, which is what the `isIndexing` poll is there to catch. The poll can
 * never win the race on a successful scan: `isIndexing` is set false and the events are
 * emitted in one synchronous block, so a timer callback cannot land between them.
 */
function waitForScan(indexer: IndexerEntry['indexer']): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(timer);
      indexer.removeListener('scanComplete', onScanComplete);
      resolve();
    };

    const onScanComplete = (): void => finish();

    const timer = setInterval(() => {
      if (!indexer.isIndexing) {
        finish();
      }
    }, SCAN_POLL_INTERVAL_MS);
    timer.unref();

    indexer.on('scanComplete', onScanComplete);
  });
}

// ── Service ──

/**
 * Rebuilds the shared physical collection: drop it, re-create it through the plugin's
 * own creation path (schema, payload indexes, tenant index, BM25 scheme marker), then
 * re-index every registered user into it.
 *
 * Why a rebuild exists at all: the per-user `POST /api/admin/reindex` with `scope: full`
 * re-writes ONE tenant's vectors but cannot touch the collection-level facts — most of
 * all the BM25 scheme marker, which `src/plugins/qdrant.ts` refuses to re-stamp on a
 * populated collection of unknown provenance. Only a collection that this build created
 * carries an honest marker, so making the marker true means creating the collection.
 *
 * The whole corpus is unavailable from the drop until the last user is indexed. That is
 * the accepted cost of a single-collection rebuild (the alternative is building a second
 * collection and repointing the alias, which needs the storage for two corpora); the
 * status is explicit about which phase is which so the operator is never guessing.
 *
 * It is also the ONLY way out of a blocked start (`qdrantAdmin.blocked`), where a legacy
 * collection holds the alias name. Nothing special happens here for that case — the
 * plugin already reports the legacy collection as `admin.collection`, so it is what the
 * operator confirms and what `dropCollection()` deletes, and `createCollection()` puts
 * the physical collection plus the alias in its place. The wording changes, the
 * procedure does not.
 */
export class CollectionRebuildService {
  private readonly fastify: FastifyInstance;
  private readonly interlock: AdminInterlock;
  private readonly jobs = new Map<string, RebuildJob>();

  constructor(fastify: FastifyInstance, interlock: AdminInterlock) {
    this.fastify = fastify;
    this.interlock = interlock;
  }

  getJob(id: string): RebuildJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * Validate, take the interlock and start the rebuild in the background.
   *
   * Returns as soon as the job is registered — the caller answers 202 and the operator
   * follows the job through the status endpoint. Throws before registering anything when
   * the confirmation does not match or another job holds the interlock.
   */
  start(confirm: string): RebuildJob {
    const admin = this.fastify.qdrantAdmin;

    // Checked first, and independent of any state: the same wrong string gets the same
    // answer whether or not a rebuild happens to be running.
    if (confirm !== admin.collection) {
      throw httpError(
        400,
        'CONFIRM_MISMATCH',
        `Confirmation string does not match. To rebuild, send the exact collection name ` +
          `"${admin.collection}" in "confirm". This DELETES that collection and with it ` +
          `the vectors of ALL registered users (not just yours), then re-indexes every ` +
          `user's vault; search returns nothing until that finishes.` +
          (admin.blocked
            ? ` "${admin.collection}" is the LEGACY collection blocking search: deleting ` +
              'it is irreversible and its index cannot be recovered — what survives is ' +
              'the vault files, which everything is re-indexed from.'
            : ''),
      );
    }

    if (this.interlock.rebuildRunning) {
      throw httpError(
        409,
        'REBUILD_IN_PROGRESS',
        `A rebuild of "${admin.collection}" is already running. Follow it at ` +
          'GET /api/admin/collection/rebuild/status?jobId=… and start another only after ' +
          'it reports completed or failed.',
      );
    }

    const busy = this.busyUsers();
    if (busy.length > 0) {
      throw httpError(
        409,
        'REBUILD_IN_PROGRESS',
        `A reindex is already running for: ${busy.join(', ')}. A rebuild drops the ` +
          'collection those vectors are being written into, so it has to wait for them ' +
          'to finish.',
      );
    }

    // No await between the checks above and this assignment — the interlock is taken in
    // the same synchronous block that found it free.
    this.interlock.rebuildRunning = true;

    // Snapshot the user list once: `usersDone` counting past `usersTotal` because someone
    // edited users.json mid-rebuild would be a nonsense status. A user added during the
    // rebuild is indexed by its own fresh indexer anyway.
    const users = this.fastify.registry.getAllUsers().map((u) => u.userId);

    const job: RebuildJob = {
      id: randomUUID(),
      status: 'running',
      phase: 'dropping',
      collection: admin.collection,
      resolvesBlock: admin.blocked,
      schemeVersion: admin.expectedSchemeVersion,
      usersTotal: users.length,
      usersDone: 0,
      filesProcessed: 0,
      errors: [],
      errorCount: 0,
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);

    void this.run(job, users);

    return job;
  }

  /**
   * Users the rebuild must not interrupt: a full reindex job that has not reported
   * completion, or an indexer in the middle of a (re)scan. `isIndexing` covers the
   * indexers started at boot as well, which are doing exactly the work a rebuild would
   * throw away.
   */
  private busyUsers(): string[] {
    const busy = new Set(this.interlock.fullReindexUsers);
    for (const [userId, entry] of this.fastify.indexers) {
      if (entry.indexer.isIndexing) {
        busy.add(userId);
      }
    }
    return [...busy];
  }

  /** Drop → create → index every user. Never throws: the job carries the outcome. */
  private async run(job: RebuildJob, users: string[]): Promise<void> {
    try {
      const admin = this.fastify.qdrantAdmin;

      job.phase = 'dropping';
      try {
        await admin.dropCollection();
      } catch (err: unknown) {
        // Nothing was destroyed — the collection is still there, and still doing exactly
        // what it was doing before this call.
        this.fail(
          job,
          `Failed to drop collection "${job.collection}": ${errorMessage(err)}. Nothing ` +
            'was destroyed — the collection is intact. Fix the Qdrant error and retry' +
            (job.resolvesBlock ? '; search stays blocked until this succeeds.' : '.'),
        );
        return;
      }

      job.phase = 'creating';
      try {
        await admin.createCollection();
      } catch (err: unknown) {
        // The one genuinely dangerous outcome: the collection is gone and could not be
        // rebuilt. Say so in the loudest terms the status object allows.
        this.fail(
          job,
          `FATAL: collection "${job.collection}" was DROPPED but could not be re-created: ` +
            `${errorMessage(err)}. Every tenant's vectors are gone and search returns ` +
            'nothing. Recover by retrying this endpoint (a drop of an absent collection ' +
            'is a no-op) or by restarting the service, which re-creates the collection on ' +
            'start; either way a full re-index is still owed.',
        );
        return;
      }

      job.phase = 'indexing';
      for (const userId of users) {
        await this.reindexUser(job, userId);
        job.usersDone += 1;
      }

      job.phase = 'done';
      job.status = 'completed';
      job.finishedAt = new Date().toISOString();
      this.fastify.log.info(
        {
          collection: job.collection,
          usersDone: job.usersDone,
          filesProcessed: job.filesProcessed,
          errorCount: job.errorCount,
        },
        'Collection rebuild finished',
      );
    } catch (err: unknown) {
      // Belt and braces: an unexpected throw must not leave the job stuck in 'running'.
      this.fail(job, `Unexpected rebuild failure: ${errorMessage(err)}`);
    } finally {
      this.interlock.rebuildRunning = false;
    }
  }

  private fail(job: RebuildJob, message: string): void {
    recordJobError(job, message);
    job.status = 'failed';
    job.finishedAt = new Date().toISOString();
    this.fastify.log.error({ collection: job.collection, jobId: job.id }, message);
  }

  /**
   * Re-index one user into the fresh collection.
   *
   * No vector purge here, unlike the per-user full reindex: the collection was just
   * created, so there is nothing stale to delete. `restart(true)` clears `indexed_files`,
   * which is what makes the poller see every file as new and hand it to the pipeline.
   *
   * A failure is recorded against the job and the loop moves on — one broken vault must
   * not leave every other tenant unindexed.
   */
  private async reindexUser(job: RebuildJob, userId: string): Promise<void> {
    const entry = this.fastify.indexers.get(userId);
    if (entry === undefined) {
      recordJobError(
        job,
        `${userId}: no indexer registered (vault path missing at startup) — user NOT ` +
          'indexed; fix the vault path and restart the service',
      );
      return;
    }

    const onChanges = (events: FileChangeEvent[]): void => {
      job.filesProcessed += events.filter((e) => e.type !== 'deleted').length;
    };
    const onFileFailed = (event: FileFailedEvent): void => {
      if (event.userId !== userId) {
        return;
      }
      recordJobError(job, `${userId}/${event.path}: ${event.error}`);
    };

    const pipelineEvents = this.fastify.pipelineEvents;
    entry.indexer.on('changes', onChanges);
    pipelineEvents.on('file-failed', onFileFailed);

    try {
      // start() flips isIndexing synchronously, so the wait below cannot observe the
      // pre-restart idle state and return immediately.
      entry.indexer.restart(true);
      await waitForScan(entry.indexer);
      await entry.queue.onIdle();
    } catch (err: unknown) {
      recordJobError(job, `${userId}: ${errorMessage(err)}`);
    } finally {
      entry.indexer.removeListener('changes', onChanges);
      pipelineEvents.removeListener('file-failed', onFileFailed);
    }
  }
}
