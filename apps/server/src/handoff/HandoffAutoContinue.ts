/**
 * Draining machines an earlier release armed to continue threads on silence.
 *
 * Silence never starts a handoff (1390 AC-36): no heartbeat names a machine to
 * continue a thread on its own, and no machine here continues one because its
 * source went quiet. A machine armed by an earlier release may still act on
 * what it was told, so the source keeps the protection it had. Each heartbeat
 * names no delay, which disarms the machine that answers it; until it answers,
 * every thread it could continue stops starting turns here once it has been
 * quiet for its delay less a margin. That fence is saved, so a restart during
 * a partition keeps it. A machine that never answers stays listed as pending.
 */
import {
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  isResumableHandoffEnding,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type {
  AutoContinuePeerState,
  HandoffDocument,
  HandoffThreadRecord,
} from "./handoffState.ts";

/**
 * How much earlier the source fences than an armed machine may act:
 * two missed 30-second heartbeats, the 10-second request timeout, and a
 * minute for clocks and slow ticks (the same margin as the coordinator fence).
 */
export const AUTO_CONTINUE_FENCE_MARGIN_MS = 2 * 30_000 + 10_000 + 60_000;
/**
 * The leases each heartbeat carries, by the machine it goes to: every thread
 * held here, for each machine holding its copy. No lease names a delay, since
 * silence starts nothing. A machine an earlier release armed gets a heartbeat
 * even with no copy left to watch, so it hears that and is disarmed by it.
 */
export function heartbeatLeases(
  document: Pick<HandoffDocument, "threads" | "autoContinuePeers">,
  self: EnvironmentId,
): Map<EnvironmentId, Array<{ sourceThreadId: ThreadId; epoch: number }>> {
  const byPeer = new Map<EnvironmentId, Array<{ sourceThreadId: ThreadId; epoch: number }>>(
    Object.keys(document.autoContinuePeers ?? {}).map((peer) => [peer as EnvironmentId, []]),
  );
  for (const [id, record] of Object.entries(document.threads)) {
    if (record.continuedOn !== null || record.lease === null) continue;
    if (record.lease.holderEnvironmentId !== self) continue;
    for (const replica of record.replicas) {
      if (replica.environmentId === self) continue;
      const list = byPeer.get(replica.environmentId) ?? [];
      list.push({ sourceThreadId: id as ThreadId, epoch: record.lease.epoch });
      byPeer.set(replica.environmentId, list);
    }
  }
  byPeer.delete(self);
  return byPeer;
}

/**
 * The peer answered a heartbeat, which names no delay: it dropped every
 * designation from this machine and can no longer act on its own.
 */
export function noteAnswered(
  peers: Readonly<Record<string, AutoContinuePeerState>>,
  peer: string,
): Readonly<Record<string, AutoContinuePeerState>> {
  if (peers[peer] === undefined) return peers;
  const { [peer]: _dropped, ...rest } = peers;
  return rest;
}

/** Whether `peer` may act on its own soon: silent for its delay less the margin. */
export function peerPastFence(state: AutoContinuePeerState | undefined, nowMs: number): boolean {
  if (state === undefined) return false;
  const baseline = Date.parse(state.baselineAt);
  // An unreadable time cannot vouch for anything, so it fences.
  if (!Number.isFinite(baseline)) return true;
  return nowMs - baseline >= state.minutes * 60_000 - AUTO_CONTINUE_FENCE_MARGIN_MS;
}

export interface FencePlan {
  /** Threads to fence now, with the peer that may continue them. */
  readonly fence: ReadonlyArray<{ readonly threadId: ThreadId; readonly peer: EnvironmentId }>;
  /** Threads whose fence lifts: their peer answered again. */
  readonly lift: ReadonlyArray<ThreadId>;
}

/**
 * Which threads held here stop or resume. A thread is fenced while any
 * machine holding its copy may continue it on its own and has gone quiet.
 */
export function planSourceFence(
  document: Pick<HandoffDocument, "threads" | "autoContinuePeers">,
  self: EnvironmentId,
  nowMs: number,
): FencePlan {
  const peers = document.autoContinuePeers ?? {};
  const fence: Array<{ threadId: ThreadId; peer: EnvironmentId }> = [];
  const lift: Array<ThreadId> = [];
  for (const [id, record] of Object.entries(document.threads)) {
    const threadId = id as ThreadId;
    const held =
      record.continuedOn === null &&
      record.lease !== null &&
      record.lease.holderEnvironmentId === self;
    const quiet = held
      ? record.replicas.find(
          (replica) =>
            replica.environmentId !== self &&
            peerPastFence(peers[replica.environmentId], nowMs) &&
            copyMayResume(record, replica.sequence),
        )
      : undefined;
    const fencedBy = record.autoFence ?? null;
    if (quiet !== undefined) {
      if (fencedBy === null) fence.push({ threadId, peer: quiet.environmentId });
    } else if (fencedBy !== null) {
      lift.push(threadId);
    }
  }
  return { fence, lift };
}

/**
 * Whether the copy a peer holds could be continued: only a copy whose run was
 * still going is. A peer that acknowledged the newest checkpoint, which shows
 * a finished run, can never continue it, so that thread keeps running here.
 */
function copyMayResume(
  record: Pick<HandoffThreadRecord, "checkpoint">,
  acknowledged: number | null,
): boolean {
  const checkpoint = record.checkpoint;
  if (checkpoint === null) return false;
  if (acknowledged === null || acknowledged < checkpoint.sequence) return true;
  return isResumableHandoffEnding(checkpoint.runEnding);
}

/** Why a turn may not start on a copy the source fenced for automatic continuation. */
export function autoFenceRefusal(record: Pick<HandoffThreadRecord, "autoFence">): string | null {
  const fence = record.autoFence ?? null;
  if (fence === null) return null;
  return `${fence.machineLabel} is not answering and may continue this thread. It starts no turn here until ${fence.machineLabel} answers.`;
}

// Loops, wired into HandoffMoves

export interface AutoContinueDeps {
  readonly self: EnvironmentId;
  readonly document: Effect.Effect<HandoffDocument, unknown>;
  readonly updateRecord: (
    threadId: ThreadId,
    change: (record: HandoffThreadRecord) => HandoffThreadRecord,
  ) => Effect.Effect<void>;
  readonly threadShell: (threadId: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null>;
  readonly peerLabel: (environmentId: EnvironmentId) => Effect.Effect<string>;
  readonly interruptRun: (shell: OrchestrationV2ThreadShell, reason: string) => Effect.Effect<void>;
}

export const makeAutoContinueLoops = (deps: AutoContinueDeps) => {
  /**
   * On the source, every lease tick: fences each thread a quiet armed machine
   * may continue, interrupting a running turn, and lifts the fence once that
   * machine answers.
   */
  const fenceQuiet = (now: number) =>
    Effect.gen(function* () {
      const plan = planSourceFence(yield* deps.document, deps.self, now);
      for (const { threadId, peer } of plan.fence) {
        const machineLabel = (yield* deps.peerLabel(peer)).slice(0, 120);
        const at = DateTime.formatIso(DateTime.makeUnsafe(now));
        const shell = yield* deps.threadShell(threadId);
        const running = shell !== null && shell.activeRunId !== null;
        yield* deps.updateRecord(threadId, (current) => ({
          ...current,
          autoFence: { environmentId: peer, machineLabel, at },
          fencedBy: running ? "sleep" : current.fencedBy,
        }));
        yield* Effect.logWarning("Handoff mode fenced a thread its continuing machine may take", {
          threadId,
          peer,
        });
        if (running) {
          yield* deps.interruptRun(
            shell,
            `${machineLabel} is not answering and may continue this thread. It paused here.`,
          );
        }
      }
      for (const threadId of plan.lift) {
        yield* deps.updateRecord(threadId, (current) => ({ ...current, autoFence: null }));
      }
    });

  return { fenceQuiet } as const;
};
