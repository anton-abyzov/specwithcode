/**
 * Draining machines an earlier release armed to continue threads on silence.
 *
 * Silence never starts a handoff (1390 AC-36): no heartbeat names a machine to
 * continue a thread on its own, and no machine here continues one because its
 * source went quiet. A machine armed by an earlier release may still act on
 * what it was told, so the source keeps the protection it had. Each heartbeat
 * names no delay. A machine that answers it before it could have acted on its
 * own is disarmed by that answer. One quiet for its delay less a margin may
 * already have started: every thread it could continue stops starting turns
 * here, and stays stopped until that machine says, for each of them, that it
 * continued it or that nothing started there. That fence is saved, so a restart
 * during a partition keeps it. A machine that cannot say so (an earlier
 * release) stays listed as pending, and its threads stay paused.
 *
 * A takeover sleep started on an earlier release is held the same way: never
 * sent again (a receiver on that release would start it), given back only on
 * its destination's own "not started", fenced once it reports the thread.
 */
import {
  type EnvironmentId,
  type HandoffModeError,
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
import {
  HEARTBEAT_PAGE_MAX,
  type HeartbeatOperation,
  type HeartbeatResponse,
} from "./handoffWire.ts";

/**
 * How much earlier the source fences than an armed machine may act:
 * two missed 30-second heartbeats, the 10-second request timeout, and a
 * minute for clocks and slow ticks (the same margin as the coordinator fence).
 */
export const AUTO_CONTINUE_FENCE_MARGIN_MS = 2 * 30_000 + 10_000 + 60_000;
/** What a request to move threads because this machine sleeps is told. */
export const SLEEP_MOVES_NOTHING =
  "Threads move only when you hand them off. This machine going to sleep moves nothing.";

/**
 * Gives a thread back to this machine when the takeover still unanswered for it
 * was started by a sleep on an earlier release. Used only once the destination
 * answered, for that takeover, that nothing started there and nothing can.
 */
export function dropSleepTakeover(record: HandoffThreadRecord): HandoffThreadRecord {
  if (record.lease?.state !== "handing-off" || record.pendingTakeover?.request.reason !== "sleep")
    return record;
  return {
    ...record,
    lease: { ...record.lease, state: "active" },
    pendingTakeover: null,
    lastError: null,
  };
}

/**
 * The leases each heartbeat carries, by the machine it goes to: every thread
 * held here, for each machine holding its copy. No lease names a delay, since
 * silence starts nothing. A machine an earlier release armed gets a heartbeat
 * even with no copy left to watch, so it hears that and is disarmed by it.
 */
function heartbeatLeases(
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
 * Forgets an armed peer: it answered a heartbeat, which names no delay, so it
 * dropped every designation from this machine (`planAnswer` says when that
 * answer is enough).
 */
export function noteAnswered(
  peers: Readonly<Record<string, AutoContinuePeerState>>,
  peer: string,
): Readonly<Record<string, AutoContinuePeerState>> {
  if (peers[peer] === undefined) return peers;
  const { [peer]: _dropped, ...rest } = peers;
  return rest;
}

/** `noteAnswered` on the saved document, leaving it as it is when the peer was not armed. */
export const disarmPeer =
  (peer: string) =>
  (document: HandoffDocument): readonly [undefined, HandoffDocument] => {
    const before = document.autoContinuePeers ?? {};
    const after = noteAnswered(before, peer);
    return [undefined, after === before ? document : { ...document, autoContinuePeers: after }];
  };

/** Why a takeover sleep started on an earlier release is never sent again. */
export const SLEEP_HOLD_WAITS =
  "A move this machine's sleep started has no answer yet. It is not sent again; the thread stays paused here until that machine says whether it started.";

/** Whether `peer` may act on its own soon: silent for its delay less the margin. */
export function peerPastFence(state: AutoContinuePeerState | undefined, nowMs: number): boolean {
  if (state === undefined) return false;
  const baseline = Date.parse(state.baselineAt);
  // An unreadable time cannot vouch for anything, so it fences.
  if (!Number.isFinite(baseline)) return true;
  return nowMs - baseline >= state.minutes * 60_000 - AUTO_CONTINUE_FENCE_MARGIN_MS;
}

/** Whether `peer` holds a copy of a thread held here that it could continue on its own. */
function mayContinue(record: HandoffThreadRecord, peer: string, self: EnvironmentId): boolean {
  return (
    record.continuedOn === null &&
    record.lease !== null &&
    record.lease.holderEnvironmentId === self &&
    record.replicas.some(
      (replica) => replica.environmentId === peer && copyAtRisk(record, replica.sequence),
    )
  );
}

const operationKey = (operation: HeartbeatOperation) =>
  `${operation.sourceThreadId}\u0000${operation.epoch}`;

/**
 * What only `peer`'s own answer settles for this thread: a takeover a sleep sent it
 * on an earlier release, and, once it was quiet long enough to pass its own check,
 * a continuation it may have started on silence (at the epoch after the lease here).
 */
function operationsToSettle(
  record: HandoffThreadRecord,
  threadId: ThreadId,
  peer: EnvironmentId,
  self: EnvironmentId,
  peers: Readonly<Record<string, AutoContinuePeerState>>,
  nowMs: number,
): Array<HeartbeatOperation> {
  const operations: Array<HeartbeatOperation> = [];
  const pending = record.pendingTakeover ?? null;
  if (
    record.lease?.state === "handing-off" &&
    pending?.destinationEnvironmentId === peer &&
    pending.request.reason === "sleep"
  ) {
    operations.push({ sourceThreadId: threadId, epoch: pending.request.epoch });
  }
  const next = record.lease === null ? null : record.lease.epoch + 1;
  if (
    next !== null &&
    peerPastFence(peers[peer], nowMs) &&
    mayContinue(record, peer, self) &&
    !operations.some((operation) => operation.epoch === next)
  ) {
    operations.push({ sourceThreadId: threadId, epoch: next });
  }
  return operations;
}

export interface HeartbeatPage {
  readonly leases: ReadonlyArray<{ readonly sourceThreadId: ThreadId; readonly epoch: number }>;
  /** Operations on threads in `leases` that need the peer's own answer. */
  readonly settle: ReadonlyArray<HeartbeatOperation>;
}

const rotateFrom = <A>(list: ReadonlyArray<A>, start: number, count: number): Array<A> => {
  const taken = Math.min(Math.max(count, 0), list.length);
  return Array.from({ length: taken }, (_, index) => list[(start + index) % list.length]!);
};

/**
 * What each heartbeat carries, by machine, at most a page each. Threads whose
 * hold waits on that machine's answer come first; the rest take turns from
 * `cursors` (advanced here), so every thread is asked about within a few beats
 * and none waits on the page limit for ever.
 */
function heartbeatPages(
  document: Pick<HandoffDocument, "threads" | "autoContinuePeers">,
  self: EnvironmentId,
  nowMs: number,
  cursors: Map<EnvironmentId, number>,
): Map<EnvironmentId, HeartbeatPage> {
  const peers = document.autoContinuePeers ?? {};
  const pages = new Map<EnvironmentId, HeartbeatPage>();
  for (const [peer, leases] of heartbeatLeases(document, self)) {
    const urgent: typeof leases = [];
    const rest: typeof leases = [];
    const settleOf = new Map<ThreadId, Array<HeartbeatOperation>>();
    for (const lease of leases) {
      const record = document.threads[lease.sourceThreadId];
      if (record === undefined) continue;
      const settle = operationsToSettle(record, lease.sourceThreadId, peer, self, peers, nowMs);
      if (settle.length > 0) settleOf.set(lease.sourceThreadId, settle);
      const waits = settle.length > 0 || record.pendingTakeover?.destinationEnvironmentId === peer;
      (waits ? urgent : rest).push(lease);
    }
    const full = urgent.length >= HEARTBEAT_PAGE_MAX;
    const rotating = full ? urgent : rest;
    const start = (cursors.get(peer) ?? 0) % Math.max(rotating.length, 1);
    const turn = rotateFrom(rotating, start, HEARTBEAT_PAGE_MAX - (full ? 0 : urgent.length));
    cursors.set(peer, rotating.length === 0 ? 0 : (start + turn.length) % rotating.length);
    const page = full ? turn : [...urgent, ...turn];
    pages.set(peer, {
      leases: page,
      settle: page
        .flatMap((lease) => settleOf.get(lease.sourceThreadId) ?? [])
        .slice(0, HEARTBEAT_PAGE_MAX),
    });
  }
  return pages;
}

export interface AnswerPlan {
  /** The peer may be forgotten: it can no longer continue a thread here on its own. */
  readonly disarm: boolean;
  /** Takeovers sleep started that the peer says never started there: give them back. */
  readonly release: ReadonlyArray<ThreadId>;
  /** Takeovers someone asked for that are still unanswered: send them again. */
  readonly resend: ReadonlyArray<ThreadId>;
}

/**
 * What a peer's answer to `page` settles. Only threads that page named count, and
 * a hold lifts only on an answer for its own operation: "not started" for exactly
 * what was asked. An answer without one (an earlier release, a read it could not
 * make) settles nothing. `settled` keeps, across beats, the threads the peer
 * already settled; an armed peer is disarmed when it answered before it could act,
 * or once every thread it could have continued is settled.
 */
function planAnswer(input: {
  readonly document: Pick<HandoffDocument, "threads" | "autoContinuePeers">;
  readonly self: EnvironmentId;
  readonly peer: EnvironmentId;
  readonly page: HeartbeatPage;
  readonly answer: HeartbeatResponse;
  readonly nowMs: number;
  readonly settled: Set<ThreadId>;
}): AnswerPlan {
  const { document, self, peer, page, answer, nowMs, settled } = input;
  const peers = document.autoContinuePeers ?? {};
  const continued = new Set(answer.continued.map((entry) => entry.sourceThreadId));
  const asked = new Set(page.settle.map(operationKey));
  const notStarted = new Set(
    (answer.notStarted ?? []).map(operationKey).filter((key) => asked.has(key)),
  );
  const release: Array<ThreadId> = [];
  const resend: Array<ThreadId> = [];
  for (const { sourceThreadId } of page.leases) {
    if (continued.has(sourceThreadId)) {
      settled.add(sourceThreadId);
      continue;
    }
    const record = document.threads[sourceThreadId];
    if (record === undefined) continue;
    const operations = operationsToSettle(record, sourceThreadId, peer, self, peers, nowMs);
    const answered =
      operations.length > 0 &&
      operations.every((operation) => notStarted.has(operationKey(operation)));
    if (answered) settled.add(sourceThreadId);
    const pending = record.pendingTakeover ?? null;
    if (record.lease?.state !== "handing-off") continue;
    if (pending?.destinationEnvironmentId !== peer) continue;
    if (pending.request.reason !== "sleep") resend.push(sourceThreadId);
    else if (answered) release.push(sourceThreadId);
  }
  const state = peers[peer];
  const disarm =
    state !== undefined &&
    (!peerPastFence(state, nowMs) ||
      Object.entries(document.threads).every(
        ([id, record]) => !mayContinue(record, peer, self) || settled.has(id as ThreadId),
      ));
  return { disarm, release, resend };
}

export interface FencePlan {
  /** Threads to fence now, with the peer that may continue them. */
  readonly fence: ReadonlyArray<{ readonly threadId: ThreadId; readonly peer: EnvironmentId }>;
  /** Threads whose fence lifts: no machine that may have continued them is still armed. */
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
            copyAtRisk(record, replica.sequence),
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

/**
 * Whether a peer's copy is one it may have continued. Once a thread is fenced for
 * that, a later checkpoint the peer acknowledged proves nothing: a machine that
 * already started on an older copy, and has not recorded it yet, still takes newer
 * ones. Only an answer for the thread itself lifts it.
 */
function copyAtRisk(
  record: Pick<HandoffThreadRecord, "checkpoint" | "autoFence">,
  acknowledged: number | null,
): boolean {
  return (record.autoFence ?? null) !== null || copyMayResume(record, acknowledged);
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
  readonly document: Effect.Effect<HandoffDocument, HandoffModeError>;
  readonly updateRecord: (
    threadId: ThreadId,
    change: (record: HandoffThreadRecord) => HandoffThreadRecord,
  ) => Effect.Effect<void>;
  readonly threadShell: (threadId: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null>;
  readonly peerLabel: (environmentId: EnvironmentId) => Effect.Effect<string>;
  readonly interruptRun: (shell: OrchestrationV2ThreadShell, reason: string) => Effect.Effect<void>;
}

export const makeAutoContinueLoops = (deps: AutoContinueDeps) => {
  const cursors = new Map<EnvironmentId, number>();
  const settledBy = new Map<EnvironmentId, Set<ThreadId>>();

  /** This beat's page for each machine (`heartbeatPages`). */
  const pages = (document: HandoffDocument, nowMs: number) =>
    heartbeatPages(document, deps.self, nowMs, cursors);

  /** What `peer`'s answer to `page` settles (`planAnswer`). */
  const answered = (input: {
    readonly document: HandoffDocument;
    readonly peer: EnvironmentId;
    readonly page: HeartbeatPage;
    readonly answer: HeartbeatResponse;
    readonly now: number;
  }) => {
    const settled = settledBy.get(input.peer) ?? new Set<ThreadId>();
    settledBy.set(input.peer, settled);
    const { now, ...rest } = input;
    const plan = planAnswer({ ...rest, nowMs: now, self: deps.self, settled });
    if (plan.disarm) settledBy.delete(input.peer);
    return plan;
  };

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

  return { fenceQuiet, pages, answered } as const;
};
