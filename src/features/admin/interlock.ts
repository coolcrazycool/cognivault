/**
 * The one piece of state the two admin jobs share.
 *
 * A collection rebuild drops the physical collection every tenant's vectors live in;
 * a per-user reindex writes into that same collection. Running them at the same time,
 * in either order, produces a corpus nobody can reason about:
 *  - reindex first, rebuild second → the freshly written vectors are dropped mid-flight
 *    and the user's `indexed_files` rows claim files that no longer have any vectors;
 *  - rebuild first, reindex second → the reindex purges and re-writes one user while the
 *    rebuild is walking the user list, so that user gets indexed twice and the rebuild's
 *    file counts are fiction.
 *
 * So exactly one of them runs at a time. The flag is plain mutable state rather than a
 * lock library because both writers are on the same event loop and never yield between
 * reading it and setting it — the check and the set are one synchronous block.
 *
 * It is per-process, like the job maps it guards. Two replicas can still start two
 * rebuilds; see the deploy notes — a rebuild is a single-operator, single-replica
 * maintenance action.
 */
export interface AdminInterlock {
  /** True from the moment a rebuild is accepted until it finishes or fails. */
  rebuildRunning: boolean;
  /** userIds whose full reindex has not reported completion yet. */
  readonly fullReindexUsers: Set<string>;
}

export function createAdminInterlock(): AdminInterlock {
  return {
    rebuildRunning: false,
    fullReindexUsers: new Set<string>(),
  };
}
