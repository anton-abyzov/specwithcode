import type {
  EnvironmentId,
  LinkedServerSyncKind,
  LinkedServerSyncPair,
  ProjectId,
} from "@specweave-studio/contracts";
import { drivesPair, serverSyncCovers } from "@specweave-studio/shared/linkedPairSync";

/**
 * When the app may leave a linked pair to the servers. A server drives a pair
 * only toward machines it holds a work grant on, so a capable server is not
 * enough: the app skips a pair only while both machines run server-driven
 * sync and the driving one reports a recent successful pass for it. Any other
 * pair (an older machine, no grant, a failing pass) the app keeps driving.
 */

export interface SyncedCopy {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface ServerSyncPair {
  readonly kind: LinkedServerSyncKind;
  /** The copy whose server drives this pair. */
  readonly driver: SyncedCopy;
  readonly peer: SyncedCopy;
}

export interface ServerSyncOptions {
  /** Connected and new enough to sync linked copies itself. */
  readonly capable: (environmentId: EnvironmentId) => boolean;
  /** The driver copy's server status, or null when it could not be read. */
  readonly fetchStatus: (copy: SyncedCopy) => Promise<ReadonlyArray<LinkedServerSyncPair> | null>;
  readonly now: number;
}

/** Whether the app may leave `kind` between two copies to their servers. */
export type ServerCoverage = (kind: LinkedServerSyncKind, a: SyncedCopy, b: SyncedCopy) => boolean;

const copyKey = (copy: SyncedCopy) => `${copy.environmentId}\u0000${copy.projectId}`;
const coverageKey = (kind: LinkedServerSyncKind, a: SyncedCopy, b: SyncedCopy) =>
  [kind, ...[copyKey(a), copyKey(b)].toSorted()].join("\u0001");

/** The pairs of each group for `kind`, each driven by the copy on the lower environment ID. */
export function drivenPairs(
  groups: ReadonlyArray<ReadonlyArray<SyncedCopy>>,
  kind: LinkedServerSyncKind,
): ServerSyncPair[] {
  return groups.flatMap((members) =>
    members.flatMap((left, index) =>
      members
        .slice(index + 1)
        .flatMap((right) =>
          left.environmentId === right.environmentId
            ? []
            : drivesPair(left.environmentId, right.environmentId)
              ? [{ kind, driver: left, peer: right }]
              : [{ kind, driver: right, peer: left }],
        ),
    ),
  );
}

/**
 * Reads the driving servers' status once per driver copy and answers, for
 * this pass, which pairs the servers keep in step. Never throws: a status
 * that cannot be read leaves the pair to the app.
 */
export async function serverCoverage(
  pairs: ReadonlyArray<ServerSyncPair>,
  options: ServerSyncOptions,
): Promise<ServerCoverage> {
  const covered = new Set<string>();
  const statuses = new Map<string, Promise<ReadonlyArray<LinkedServerSyncPair> | null>>();
  const candidates = pairs.filter(
    (pair) =>
      options.capable(pair.driver.environmentId) && options.capable(pair.peer.environmentId),
  );
  // Every driver's status is asked for at once, not one driver after another.
  for (const pair of candidates) {
    const key = copyKey(pair.driver);
    if (!statuses.has(key))
      statuses.set(
        key,
        options.fetchStatus(pair.driver).catch(() => null),
      );
  }
  for (const pair of candidates) {
    const status = await statuses.get(copyKey(pair.driver))!;
    if (status !== null && serverSyncCovers(status, pair.peer, pair.kind, options.now))
      covered.add(coverageKey(pair.kind, pair.driver, pair.peer));
  }
  return (kind, a, b) => covered.has(coverageKey(kind, a, b));
}
