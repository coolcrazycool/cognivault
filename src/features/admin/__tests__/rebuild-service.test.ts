import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { FileChangeEvent } from '../../../lib/indexer.js';
import type { PipelineEventEmitter, PipelineEventMap } from '../../../plugins/pipeline-events.js';
import type { QdrantAdmin } from '../../../plugins/qdrant.js';
import { type AdminInterlock, createAdminInterlock } from '../interlock.js';
import { CollectionRebuildService } from '../rebuild-service.js';
import { ReindexService } from '../service.js';

// Set env vars before any module imports that trigger config parsing
process.env.VAULT_PATH = '/tmp/test-vault';

const COLLECTION = 'cognivault_v2';
/** The pre-alias collection that squats the alias name and blocks a start. */
const LEGACY_COLLECTION = 'cognivault';
const SCHEME_VERSION = 3;

/**
 * Stand-in for VaultIndexer with the two behaviours the rebuild depends on:
 * `restart()` flips `isIndexing` synchronously, and a finished scan emits `scanComplete`
 * after the change events.
 */
class FakeIndexer extends EventEmitter {
  isIndexing = false;
  restarts: boolean[] = [];
  /** Files the next scan reports as changed; `null` makes the scan throw instead. */
  scanFiles: number | null = 1;
  /** When false the scan only ends once the test calls {@link finishScan}. */
  autoFinish = true;

  restart(force = false): void {
    this.restarts.push(force);
    this.isIndexing = true;
    if (this.autoFinish) {
      // The real indexer scans asynchronously — so does this.
      setTimeout(() => this.finishScan(), 0);
    }
  }

  finishScan(): void {
    if (this.scanFiles === null) {
      // runInitialScan() threw: isIndexing goes false and NOTHING is emitted.
      this.isIndexing = false;
      return;
    }
    const events = Array.from({ length: this.scanFiles }, (_, i) => ({
      path: `note-${i}.md`,
      type: 'created' as const,
      contentHash: `h${i}`,
    }));
    this.isIndexing = false;
    this.emit('changes', events);
    this.emit('scanComplete', this.scanFiles, this.scanFiles);
  }
}

interface Harness {
  fastify: FastifyInstance;
  interlock: AdminInterlock;
  service: CollectionRebuildService;
  indexers: Map<string, { indexer: FakeIndexer; queue: { onIdle: () => Promise<void> } }>;
  pipelineEvents: PipelineEventEmitter;
  admin: {
    drop: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
}

interface HarnessOptions {
  /**
   * Blocked start: the LEGACY collection holds the alias name, so that is what
   * `qdrantAdmin` reports as the rebuild target — exactly as the plugin does.
   */
  blocked?: boolean;
}

function buildHarness(
  userIds: string[] = ['user-a', 'user-b'],
  options: HarnessOptions = {},
): Harness {
  const blocked = options.blocked ?? false;
  const target = blocked ? LEGACY_COLLECTION : COLLECTION;
  const drop = vi.fn().mockResolvedValue(undefined);
  const create = vi.fn().mockResolvedValue(undefined);

  const qdrantAdmin: QdrantAdmin = {
    alias: 'cognivault',
    collection: target,
    blocked,
    expectedSchemeVersion: SCHEME_VERSION,
    describe: vi.fn().mockResolvedValue({
      collection: target,
      alias: 'cognivault',
      schemeVersion: blocked ? null : 2,
      expectedSchemeVersion: SCHEME_VERSION,
      pointsCount: 10,
      blocked,
    }),
    dropCollection: drop,
    createCollection: create,
  };

  const indexers = new Map<
    string,
    { indexer: FakeIndexer; queue: { onIdle: () => Promise<void> } }
  >();
  for (const userId of userIds) {
    indexers.set(userId, {
      indexer: new FakeIndexer(),
      queue: { onIdle: vi.fn().mockResolvedValue(undefined) },
    });
  }

  const pipelineEvents: PipelineEventEmitter = new EventEmitter<PipelineEventMap>();

  const fastify = {
    qdrantAdmin,
    indexers,
    pipelineEvents,
    registry: {
      getAllUsers: () => userIds.map((userId) => ({ userId })),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as FastifyInstance;

  const interlock = createAdminInterlock();
  return {
    fastify,
    interlock,
    service: new CollectionRebuildService(fastify, interlock),
    indexers,
    pipelineEvents,
    admin: { drop, create },
  };
}

/** Let the job's async chain advance without giving timers a chance to fire. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

/** Poll until the job leaves 'running' (or give up, so a hang fails loudly). */
async function settle(
  service: CollectionRebuildService,
  jobId: string,
  timeoutMs = 2_000,
): Promise<NonNullable<ReturnType<CollectionRebuildService['getJob']>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = service.getJob(jobId)!;
    if (job.status !== 'running') {
      return job;
    }
    if (Date.now() > deadline) {
      throw new Error(`Rebuild job stayed 'running' (phase: ${job.phase})`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('CollectionRebuildService', () => {
  describe('confirmation', () => {
    it('rejects a confirmation that is not the physical collection name', () => {
      const h = buildHarness();

      expect(() => h.service.start('cognivault')).toThrow(/does not match/);
      // The alias is the name people say out loud — accepting it would be the easiest
      // way to destroy the corpus by accident.
      try {
        h.service.start('cognivault');
      } catch (err) {
        expect((err as { statusCode?: number; code?: string }).statusCode).toBe(400);
        expect((err as { code?: string }).code).toBe('CONFIRM_MISMATCH');
      }

      // Nothing was touched and no job was registered.
      expect(h.admin.drop).not.toHaveBeenCalled();
      expect(h.interlock.rebuildRunning).toBe(false);
    });

    it('says plainly that ALL users lose their vectors', () => {
      const h = buildHarness();

      expect(() => h.service.start('wrong')).toThrow(/ALL registered users/);
    });

    it('accepts the exact physical collection name', async () => {
      const h = buildHarness();

      const job = h.service.start(COLLECTION);

      expect(job.status).toBe('running');
      expect(job.collection).toBe(COLLECTION);
      expect(job.schemeVersion).toBe(SCHEME_VERSION);
      expect(job.usersTotal).toBe(2);
      expect(job.resolvesBlock).toBe(false);
      await settle(h.service, job.id);
    });
  });

  // The recovery path for a start blocked by a legacy `cognivault` COLLECTION: the same
  // procedure, aimed at a different collection, because that is the one occupying the
  // namespace.
  describe('blocked start', () => {
    it('confirms the LEGACY collection, not the physical one', () => {
      const h = buildHarness(['user-a'], { blocked: true });

      // cognivault_v2 does not exist yet in this state — confirming it would be
      // confirming the destruction of nothing.
      expect(() => h.service.start(COLLECTION)).toThrow(/does not match/);
      expect(() => h.service.start(COLLECTION)).toThrow(new RegExp(LEGACY_COLLECTION));
      expect(h.admin.drop).not.toHaveBeenCalled();
    });

    it('warns that the legacy index is unrecoverable and the files are what survive', () => {
      const h = buildHarness(['user-a'], { blocked: true });

      expect(() => h.service.start('wrong')).toThrow(/irreversible/);
      expect(() => h.service.start('wrong')).toThrow(/vault files/);
    });

    it('drops the legacy collection, re-creates and re-indexes every user', async () => {
      const h = buildHarness(['user-a', 'user-b'], { blocked: true });

      const job = h.service.start(LEGACY_COLLECTION);
      expect(job.collection).toBe(LEGACY_COLLECTION);
      expect(job.resolvesBlock).toBe(true);

      const settled = await settle(h.service, job.id);

      expect(settled.status).toBe('completed');
      expect(settled.phase).toBe('done');
      expect(h.admin.drop).toHaveBeenCalledTimes(1);
      // createCollection() is where the plugin swaps in cognivault_v2 + the alias and
      // lifts the block; from here the rebuild is the ordinary one.
      expect(h.admin.create).toHaveBeenCalledTimes(1);
      expect(settled.usersDone).toBe(2);
      for (const [, entry] of h.indexers) {
        expect(entry.indexer.restarts).toEqual([true]);
      }
    });

    it('a failed drop leaves the block in place and says so', async () => {
      const h = buildHarness(['user-a'], { blocked: true });
      h.admin.drop.mockRejectedValue(new Error('permission denied'));

      const job = h.service.start(LEGACY_COLLECTION);
      const settled = await settle(h.service, job.id);

      expect(settled.status).toBe('failed');
      expect(settled.errors[0]).toContain('Nothing was destroyed');
      expect(settled.errors[0]).toContain('search stays blocked');
      expect(h.admin.create).not.toHaveBeenCalled();
    });
  });

  describe('serialisation', () => {
    it('rejects a second rebuild while one is running', async () => {
      const h = buildHarness();
      let releaseDrop!: () => void;
      h.admin.drop.mockReturnValue(
        new Promise<void>((resolve) => {
          releaseDrop = resolve;
        }),
      );

      const first = h.service.start(COLLECTION);

      expect(() => h.service.start(COLLECTION)).toThrow(/already running/);
      try {
        h.service.start(COLLECTION);
      } catch (err) {
        expect((err as { statusCode?: number; code?: string }).statusCode).toBe(409);
        expect((err as { code?: string }).code).toBe('REBUILD_IN_PROGRESS');
      }
      // Only the first job ever dropped anything.
      expect(h.admin.drop).toHaveBeenCalledTimes(1);

      releaseDrop();
      await settle(h.service, first.id);
    });

    it('releases the interlock when the job finishes, so a later rebuild is accepted', async () => {
      const h = buildHarness();

      const first = h.service.start(COLLECTION);
      await settle(h.service, first.id);

      expect(h.interlock.rebuildRunning).toBe(false);
      const second = h.service.start(COLLECTION);
      await settle(h.service, second.id);
      expect(second.id).not.toBe(first.id);
    });

    it('releases the interlock even when the rebuild fails', async () => {
      const h = buildHarness();
      h.admin.drop.mockRejectedValue(new Error('Connection refused'));

      const job = h.service.start(COLLECTION);
      await settle(h.service, job.id);

      expect(h.interlock.rebuildRunning).toBe(false);
    });

    it('refuses to start while a per-user full reindex is running', () => {
      const h = buildHarness();
      h.interlock.fullReindexUsers.add('user-a');

      expect(() => h.service.start(COLLECTION)).toThrow(/reindex is already running for: user-a/);
      expect(h.admin.drop).not.toHaveBeenCalled();
    });

    it('refuses to start while an indexer is mid-scan', () => {
      const h = buildHarness();
      h.indexers.get('user-b')!.indexer.isIndexing = true;

      expect(() => h.service.start(COLLECTION)).toThrow(/user-b/);
    });

    it('makes a per-user full reindex 409 while the rebuild owns the collection', async () => {
      const h = buildHarness();
      let releaseDrop!: () => void;
      h.admin.drop.mockReturnValue(
        new Promise<void>((resolve) => {
          releaseDrop = resolve;
        }),
      );
      // Same interlock instance the routes hand to both services.
      const reindex = new ReindexService(h.fastify, h.interlock);

      const job = h.service.start(COLLECTION);

      await expect(
        reindex.createJob(
          'full',
          undefined,
          {} as never,
          { delete: vi.fn().mockResolvedValue(undefined) } as never,
          'user-a',
        ),
      ).rejects.toThrow(/collection rebuild is in progress/);

      releaseDrop();
      await settle(h.service, job.id);
    });
  });

  describe('drop and create', () => {
    it('walks dropping → creating → indexing → done', async () => {
      const h = buildHarness(['user-a']);
      const indexer = h.indexers.get('user-a')!.indexer;
      indexer.autoFinish = false;

      let releaseDrop!: () => void;
      let releaseCreate!: () => void;
      h.admin.drop.mockReturnValue(
        new Promise<void>((resolve) => {
          releaseDrop = resolve;
        }),
      );
      h.admin.create.mockReturnValue(
        new Promise<void>((resolve) => {
          releaseCreate = resolve;
        }),
      );

      const job = h.service.start(COLLECTION);

      // The collection still exists — nothing is lost yet.
      expect(job.phase).toBe('dropping');
      expect(h.admin.create).not.toHaveBeenCalled();

      releaseDrop();
      await flushMicrotasks();
      // The collection is GONE from here until createCollection resolves.
      expect(job.phase).toBe('creating');
      expect(indexer.restarts).toEqual([]);

      releaseCreate();
      await flushMicrotasks();
      // The collection exists again and is filling up.
      expect(job.phase).toBe('indexing');
      expect(job.status).toBe('running');
      expect(indexer.restarts).toEqual([true]);
      expect(job.finishedAt).toBeUndefined();

      indexer.finishScan();
      const settled = await settle(h.service, job.id);

      expect(settled.phase).toBe('done');
      expect(settled.status).toBe('completed');
      expect(settled.finishedAt).toBeDefined();
    });

    it('fails without creating anything when the drop fails, and says nothing was destroyed', async () => {
      const h = buildHarness();
      h.admin.drop.mockRejectedValue(new Error('Connection refused'));

      const job = await settle(h.service, h.service.start(COLLECTION).id);

      expect(job.status).toBe('failed');
      expect(job.phase).toBe('dropping');
      expect(job.errors[0]).toMatch(/Nothing was destroyed/);
      expect(h.admin.create).not.toHaveBeenCalled();
      // No user was restarted — the corpus is exactly as it was.
      expect(h.indexers.get('user-a')!.indexer.restarts).toEqual([]);
    });

    it('screams when the collection was dropped but could not be re-created', async () => {
      const h = buildHarness();
      h.admin.create.mockRejectedValue(new Error('Quota exceeded'));

      const job = await settle(h.service, h.service.start(COLLECTION).id);

      expect(job.status).toBe('failed');
      // The status has to make "the collection is gone" impossible to miss.
      expect(job.phase).toBe('creating');
      expect(job.errors[0]).toMatch(/FATAL/);
      expect(job.errors[0]).toMatch(/DROPPED but could not be re-created/);
      expect(job.errors[0]).toMatch(/Quota exceeded/);
      expect(job.usersDone).toBe(0);
    });
  });

  describe('per-user indexing', () => {
    it('force-restarts every registered user and counts the files', async () => {
      const h = buildHarness();
      h.indexers.get('user-a')!.indexer.scanFiles = 3;
      h.indexers.get('user-b')!.indexer.scanFiles = 2;

      const job = await settle(h.service, h.service.start(COLLECTION).id);

      // force=true is what clears indexed_files so every file is re-embedded.
      expect(h.indexers.get('user-a')!.indexer.restarts).toEqual([true]);
      expect(h.indexers.get('user-b')!.indexer.restarts).toEqual([true]);
      expect(job.usersDone).toBe(2);
      expect(job.usersTotal).toBe(2);
      expect(job.filesProcessed).toBe(5);
      expect(job.errors).toEqual([]);
    });

    it('counts distinct dispatched files, not emissions', async () => {
      const h = buildHarness(['user-a']);
      const indexer = h.indexers.get('user-a')!.indexer;
      indexer.scanFiles = 3;

      let replayed = false;
      indexer.on('changes', (events: FileChangeEvent[]) => {
        if (replayed) return;
        replayed = true;
        // A later poll cycle re-dispatches a file already seen plus one genuinely new
        // one. Summing emissions reports 5 files in a 4-file vault.
        indexer.emit('changes', [
          events[0],
          { path: 'note-9.md', type: 'created', contentHash: 'h9' },
        ]);
      });

      const job = await settle(h.service, h.service.start(COLLECTION).id);

      expect(job.filesProcessed).toBe(4);
    });

    it('counts the same path under two users separately', async () => {
      const h = buildHarness(['user-a', 'user-b']);
      // Both vaults contain note-0.md — two tenants, two files to embed.
      h.indexers.get('user-a')!.indexer.scanFiles = 1;
      h.indexers.get('user-b')!.indexer.scanFiles = 1;

      const job = await settle(h.service, h.service.start(COLLECTION).id);

      expect(job.filesProcessed).toBe(2);
    });

    it('records a user whose reindex throws and still indexes the rest', async () => {
      const h = buildHarness();
      const broken = h.indexers.get('user-a')!.indexer;
      vi.spyOn(broken, 'restart').mockImplementation(() => {
        throw new Error('database is locked');
      });

      const job = await settle(h.service, h.service.start(COLLECTION).id);

      expect(job.status).toBe('completed');
      expect(job.errorCount).toBe(1);
      expect(job.errors[0]).toMatch(/user-a: database is locked/);
      // The failure must not cost every other tenant their index.
      expect(h.indexers.get('user-b')!.indexer.restarts).toEqual([true]);
      expect(job.usersDone).toBe(2);
    });

    it('records per-file pipeline failures against the user that produced them', async () => {
      const h = buildHarness();
      const indexer = h.indexers.get('user-a')!.indexer;
      indexer.on('changes', () => {
        h.pipelineEvents.emit('file-failed', {
          userId: 'user-a',
          path: 'notes/broken.md',
          error: 'embedding failed',
        });
        // A failure from a user that is not being indexed right now is not this
        // iteration's business.
        h.pipelineEvents.emit('file-failed', {
          userId: 'user-b',
          path: 'notes/other.md',
          error: 'ignored',
        });
      });

      const job = await settle(h.service, h.service.start(COLLECTION).id);

      expect(job.errors).toEqual(['user-a/notes/broken.md: embedding failed']);
      expect(job.status).toBe('completed');
    });

    it('leaves no listeners behind on the pipeline bus', async () => {
      const h = buildHarness();

      await settle(h.service, h.service.start(COLLECTION).id);

      expect(h.pipelineEvents.listenerCount('file-failed')).toBe(0);
    });

    it('reports a user with no indexer instead of skipping them silently', async () => {
      const h = buildHarness(['user-a', 'ghost']);
      h.indexers.delete('ghost');

      const job = await settle(h.service, h.service.start(COLLECTION).id);

      expect(job.status).toBe('completed');
      expect(job.errors[0]).toMatch(/ghost: no indexer registered/);
      expect(job.usersDone).toBe(2);
    });

    it('does not hang when a scan dies without emitting scanComplete', async () => {
      const h = buildHarness();
      // runInitialScan() threw: isIndexing drops back to false, nothing is emitted.
      h.indexers.get('user-a')!.indexer.scanFiles = null;

      const job = await settle(h.service, h.service.start(COLLECTION).id, 5_000);

      expect(job.status).toBe('completed');
      expect(job.usersDone).toBe(2);
      expect(h.indexers.get('user-b')!.indexer.restarts).toEqual([true]);
    });
  });

  describe('getJob', () => {
    it('returns undefined for an unknown id', () => {
      const h = buildHarness();
      expect(h.service.getJob('00000000-0000-0000-0000-000000000000')).toBeUndefined();
    });
  });
});
