import type {
  EnvironmentId,
  LinkedServerSyncKind,
  LinkedServerSyncPair,
  LogicalProjectMember,
  ProjectCoordinatorBinding,
  ProjectId,
} from "@specweave-studio/contracts";

/**
 * The decisions behind keeping linked copies in step, shared by the app
 * window and the servers so both choose the same thing: which copy gives way
 * after a takeover, which copies keep a replica of the coordinator's notes,
 * which server drives a pair, and when the app may leave a pair to it.
 *
 * @module linkedPairSync
 */

/** How often a server syncs each pair it drives. */
export const LINKED_PAIR_SYNC_MS = 60_000;
/** The longest a failing pair waits before its server tries again. */
export const LINKED_PAIR_BACKOFF_MAX_MS = 5 * 60_000;
/** How recent a server's successful pass must be for the app to leave the pair to it. */
export const SERVER_SYNC_FRESH_MS = 3 * 60_000;

/** What a sync decision needs to know about one copy. */
export interface LinkedCopy {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly logicalProjectId: string | undefined;
  readonly binding: ProjectCoordinatorBinding | undefined;
}

const sameRef = (
  member: Pick<LogicalProjectMember, "environmentId" | "projectId">,
  copy: Pick<LinkedCopy, "environmentId" | "projectId">,
) => member.environmentId === copy.environmentId && member.projectId === copy.projectId;

/**
 * Whether `previous` must give way to `successor`: the successor took over from
 * it while it was unreachable, and it still coordinates at a lower epoch.
 */
export function pendingSupersede(successor: LinkedCopy, previous: LinkedCopy): boolean {
  const binding = successor.binding;
  if (binding?.state !== "active" || !binding.predecessor || !binding.takenOverAt) return false;
  if (!sameRef(binding.predecessor, previous)) return false;
  return (
    previous.logicalProjectId !== undefined &&
    previous.logicalProjectId === successor.logicalProjectId &&
    (previous.binding?.state ?? "active") === "active" &&
    (previous.binding?.epoch ?? 0) < binding.epoch
  );
}

/** Whether `member` keeps a replica of `coordinator`'s notes, goal and instructions. */
export function isReplicaTarget(coordinator: LinkedCopy, member: LinkedCopy): boolean {
  return (
    member.environmentId !== coordinator.environmentId &&
    member.logicalProjectId !== undefined &&
    member.logicalProjectId === coordinator.logicalProjectId &&
    member.binding?.state === "transferred"
  );
}

/** The replica a member holds, as its digest describes it. */
export interface HeldReplica {
  readonly from: Pick<LogicalProjectMember, "environmentId" | "projectId">;
  readonly digest: string;
  readonly fromEpoch?: number | undefined;
}

/** One side of a pair as a sync pass sees it. */
export interface PairSide extends LinkedCopy {
  /** Of this copy's own notes, goal and instructions. */
  readonly coordinatorDigest: string;
  readonly replica: HeldReplica | null;
}

/**
 * What the pair's driver does about the notes replica: `push` its own
 * content to the peer, `pull` the peer's into itself, or nothing. Only an
 * active copy is copied, only into a member of the same project, and never
 * over a replica of a newer coordinator, so two coordinators of one project
 * do not keep replacing each other's copy.
 */
export function replicaStep(self: PairSide, peer: PairSide): "push" | "pull" | null {
  const decide = (coordinator: PairSide, member: PairSide) => {
    if (coordinator.binding?.state !== "active" || !isReplicaTarget(coordinator, member))
      return false;
    const held = member.replica;
    if (held === null) return true;
    if (sameRef(held.from, coordinator)) return held.digest !== coordinator.coordinatorDigest;
    return (held.fromEpoch ?? -1) <= coordinator.binding.epoch;
  };
  if (decide(self, peer)) return "push";
  if (decide(peer, self)) return "pull";
  return null;
}

/** Exactly one server drives a pair: the one with the lower environment ID. */
export function drivesPair(self: EnvironmentId, peer: EnvironmentId): boolean {
  return self < peer;
}

/** The wait before retrying a pair after `failures` failed passes in a row. */
export function pairBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(LINKED_PAIR_SYNC_MS * 2 ** (failures - 1), LINKED_PAIR_BACKOFF_MAX_MS);
}

/**
 * Whether the driving server's status shows `kind` in step with `peer`
 * recently enough for the app to leave the pair to it.
 */
export function serverSyncCovers(
  pairs: ReadonlyArray<LinkedServerSyncPair>,
  peer: Pick<LinkedCopy, "environmentId" | "projectId">,
  kind: LinkedServerSyncKind,
  now: number,
): boolean {
  return pairs.some((pair) => {
    if (
      pair.kind !== kind ||
      pair.peerEnvironmentId !== peer.environmentId ||
      pair.peerProjectId !== peer.projectId ||
      pair.lastError !== null ||
      pair.lastSuccessAt === null
    )
      return false;
    const at = Date.parse(pair.lastSuccessAt);
    return Number.isFinite(at) && now - at <= SERVER_SYNC_FRESH_MS && at <= now + 60_000;
  });
}
