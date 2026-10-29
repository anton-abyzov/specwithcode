/**
 * Automatic continuation of handoff-mode threads (`autoTakeoverMinutes`).
 *
 * Only one machine may continue a thread on its own: the one the source names
 * in its own heartbeat, which is its sleep target, else the project's armed
 * coordinator standby. The source sends the delay with that heartbeat, so both
 * sides count the same minutes, and no other machine holding a copy ever acts.
 *
 * The source fences first. Once the designated machine has not answered for
 * the delay less a margin, every thread it could continue stops starting
 * turns here, and that fence is saved, so a restart during a partition keeps
 * it. The designated machine continues a copy only after hearing the source
 * while it was itself awake, then the full delay of silence. Coordinator
 * threads never move this way; automatic coordinator takeover handles them.
 */
import {
  type EnvironmentId,
  type HandOffResult,
  type HandoffConfig,
  type HandoffContinueHereInput,
  type HandoffModeError,
  type OrchestrationV2ThreadShell,
  type Project,
  type ProjectId,
  type ProjectCoordinatorBinding,
  type ThreadId,
  isProjectCoordinatorThreadId,
  isResumableHandoffEnding,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  type MonotonicClock,
  STANDBY_TICK_MS,
  clockJumped,
  systemMonotonicClock,
  type ClockSample,
} from "../project/CoordinatorStandbyWatch.ts";
import {
  type AutoContinuePeerState,
  type HandoffDocument,
  type HandoffThreadRecord,
  incomingKey,
} from "./handoffState.ts";

/** The shortest delay automatic continuation waits, whatever the setting says. */
export const AUTO_CONTINUE_MIN_MINUTES = 5;
/**
 * How much earlier the source fences than the designated machine may act:
 * two missed 30-second heartbeats, the 10-second request timeout, and a
 * minute for clocks and slow ticks (the same margin as the coordinator fence).
 */
export const AUTO_CONTINUE_FENCE_MARGIN_MS = 2 * 30_000 + 10_000 + 60_000;
/** A continuation that failed is tried again after this long, not on every tick. */
export const AUTO_CONTINUE_RETRY_MS = 10 * 60_000;

/** The monotonic clock the designated machine's watch uses; tests replace it. */
export const AutoContinueMonotonicClock = Context.Reference<MonotonicClock>(
  "specweave-studio/handoff/AutoContinueMonotonicClock",
  { defaultValue: () => systemMonotonicClock },
);

/** The delay in minutes, at least five; null when the setting is off. */
export function autoContinueMinutes(config: Pick<HandoffConfig, "autoTakeoverMinutes">) {
  const minutes = config.autoTakeoverMinutes;
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.max(AUTO_CONTINUE_MIN_MINUTES, Math.floor(minutes));
}

export interface AutoContinueProject {
  readonly id: string;
  readonly workspaceSettings?:
    | {
        readonly coordinatorThreadId?: string | null;
        readonly coordinatorBinding?: ProjectCoordinatorBinding | null | undefined;
      }
    | null
    | undefined;
}

/**
 * The one machine allowed to continue a thread on its own: the sleep target,
 * else the armed standby of the project's active coordinator. Null for a
 * coordinator thread, which only coordinator takeover moves.
 */
export function designatedMachine(input: {
  readonly config: Pick<HandoffConfig, "sleepTarget">;
  readonly project: AutoContinueProject | null;
  readonly threadId: string;
  readonly self: EnvironmentId;
}): EnvironmentId | null {
  const project = input.project;
  if (
    project !== null &&
    isProjectCoordinatorThreadId(input.threadId, {
      id: project.id,
      workspaceSettings: {
        coordinatorThreadId: project.workspaceSettings?.coordinatorThreadId ?? null,
      },
    })
  )
    return null;
  const binding = project?.workspaceSettings?.coordinatorBinding ?? null;
  const standby =
    binding?.state === "active" ? (binding.standby?.member.environmentId ?? null) : null;
  const target = input.config.sleepTarget ?? standby;
  return target === null || target === input.self ? null : target;
}

// Source

/**
 * Records that this heartbeat names `peer` as the machine to continue after
 * `minutes`, before it is sent: a heartbeat whose answer is lost may still
 * have reached the peer. The silence counts from the first announcement, and
 * the shortest delay announced since the peer last answered wins.
 */
export function noteAnnounced(
  peers: Readonly<Record<string, AutoContinuePeerState>>,
  peer: string,
  minutes: number,
  now: string,
): Readonly<Record<string, AutoContinuePeerState>> {
  const current = peers[peer];
  if (current === undefined) return { ...peers, [peer]: { minutes, baselineAt: now } };
  if (current.minutes <= minutes) return peers;
  return { ...peers, [peer]: { ...current, minutes } };
}

/**
 * The peer answered a heartbeat that announced `minutes` (null: it named no
 * delay, so the peer dropped every designation from this machine). Its clock
 * starts again from now.
 */
export function noteAnswered(
  peers: Readonly<Record<string, AutoContinuePeerState>>,
  peer: string,
  minutes: number | null,
  now: string,
): Record<string, AutoContinuePeerState> {
  const { [peer]: _dropped, ...rest } = peers;
  return minutes === null ? rest : { ...rest, [peer]: { minutes, baselineAt: now } };
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

// Designated machine

/**
 * The designated machine's watch: silence counts only across time it was
 * awake to hear heartbeats. It starts at process start and again whenever the
 * wall clock moves backwards or runs ahead of the monotonic clock.
 */
export function makeAutoContinueWatch(monotonic: MonotonicClock, startWallMs: number) {
  let previous: ClockSample = { wallMs: startWallMs, monoMs: monotonic.nowMs() };
  let watchingSinceMs = startWallMs;
  return {
    /** The start of the current watch, after checking the clock at `wallMs`. */
    observe(wallMs: number): number {
      const current: ClockSample = { wallMs, monoMs: monotonic.nowMs() };
      if (clockJumped(previous, current, STANDBY_TICK_MS)) watchingSinceMs = wallMs;
      previous = current;
      return watchingSinceMs;
    },
  };
}

export interface AutoContinueCandidate {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
}

/**
 * Copies this machine continues now: the source named it with a delay in its
 * latest heartbeat, the copy was still running, the source was heard during
 * the current watch, and the full delay passed since.
 */
export function autoContinueCandidates(
  document: Pick<HandoffDocument, "incoming" | "incomingDetails">,
  input: {
    readonly nowMs: number;
    readonly watchingSinceMs: number;
    /** The local project linked to the source's, for its members' coordinator threads. */
    readonly projectOf: (projectId: string) => {
      readonly workspaceSettings?:
        | {
            readonly logicalProject?:
              | {
                  readonly members: ReadonlyArray<{
                    readonly environmentId: string;
                    readonly coordinatorThreadId?: string;
                  }>;
                }
              | null
              | undefined;
          }
        | null
        | undefined;
    } | null;
  },
): Array<AutoContinueCandidate> {
  const out: Array<AutoContinueCandidate> = [];
  for (const replica of document.incoming) {
    if (replica.continuedThreadId !== null || replica.projectId === null) continue;
    const detail = (document.incomingDetails ?? {})[
      incomingKey(replica.sourceEnvironmentId, replica.sourceThreadId)
    ];
    const announced = detail?.autoContinueMinutes ?? null;
    if (detail === undefined || announced === null || announced <= 0) continue;
    if (replica.sourceThreadId === `project-coordinator:${detail.sourceProjectId}`) continue;
    const members =
      input.projectOf(replica.projectId)?.workspaceSettings?.logicalProject?.members ?? [];
    if (
      members.some(
        (member) =>
          member.environmentId === replica.sourceEnvironmentId &&
          member.coordinatorThreadId === replica.sourceThreadId,
      )
    )
      continue;
    if (!isResumableHandoffEnding(replica.checkpoint.runEnding)) continue;
    const seen = Date.parse(replica.sourceLastSeenAt ?? "");
    if (!Number.isFinite(seen) || seen < input.watchingSinceMs) continue;
    const minutes = Math.max(AUTO_CONTINUE_MIN_MINUTES, announced);
    if (input.nowMs - seen < minutes * 60_000) continue;
    out.push({
      sourceEnvironmentId: replica.sourceEnvironmentId,
      sourceThreadId: replica.sourceThreadId,
    });
  }
  return out;
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
  readonly project: (projectId: ProjectId) => Effect.Effect<Project | null>;
  readonly continueHereAs: (
    input: HandoffContinueHereInput,
    reason: "auto-takeover",
  ) => Effect.Effect<HandOffResult, HandoffModeError>;
}

export const makeAutoContinueLoops = (deps: AutoContinueDeps) =>
  Effect.gen(function* () {
    // The designated machine's watch, and when a failed continuation may be tried again.
    const watch = makeAutoContinueWatch(
      yield* AutoContinueMonotonicClock,
      yield* Clock.currentTimeMillis,
    );
    const retryAt = new Map<string, number>();

    /**
     * On the source, every lease tick: fences each thread a quiet designated
     * machine may continue, interrupting a running turn, and lifts the fence
     * once that machine answers.
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

    /**
     * On the designated machine: continues each copy whose source stayed quiet
     * for the delay it named, under the reason "auto-takeover". A failure waits
     * ten minutes before the next attempt.
     */
    const continueDue = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const watchingSinceMs = watch.observe(now);
      const document = yield* deps.document;
      const local = new Map<string, Project | null>();
      for (const replica of document.incoming) {
        const detail = (document.incomingDetails ?? {})[
          incomingKey(replica.sourceEnvironmentId, replica.sourceThreadId)
        ];
        if (replica.projectId === null || (detail?.autoContinueMinutes ?? null) === null) continue;
        if (!local.has(replica.projectId))
          local.set(replica.projectId, yield* deps.project(replica.projectId));
      }
      if (local.size === 0) return;
      const due = autoContinueCandidates(document, {
        nowMs: now,
        watchingSinceMs,
        projectOf: (projectId) => local.get(projectId) ?? null,
      });
      for (const candidate of due) {
        const key = incomingKey(candidate.sourceEnvironmentId, candidate.sourceThreadId);
        if ((retryAt.get(key) ?? 0) > now) continue;
        const done = yield* deps.continueHereAs(candidate, "auto-takeover").pipe(Effect.result);
        if (done._tag === "Failure") {
          retryAt.set(key, now + AUTO_CONTINUE_RETRY_MS);
          yield* Effect.logWarning("Handoff mode could not continue a quiet machine's thread", {
            ...candidate,
            error: done.failure.message,
          });
        } else {
          retryAt.delete(key);
          yield* Effect.logInfo("Handoff mode continued a quiet machine's thread here", {
            ...candidate,
            threadId: done.success.threadId,
          });
        }
      }
    });

    return { fenceQuiet, continueDue } as const;
  });
