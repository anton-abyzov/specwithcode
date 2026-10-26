/**
 * Handoff mode: a thread that keeps a resumable checkpoint (a hidden Git ref,
 * the transcript and a short note) on the machines of its logical project, so
 * any of them can continue it when this machine closes, sleeps or vanishes.
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  RunId,
  ThreadId,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import type {
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2RunInterruptCause,
  OrchestrationV2RunStatus,
} from "./orchestrationV2.ts";
import { ThreadSideEffect, ThreadSourceRoot } from "./threadExecution.ts";

/** Checkpoint commits live here, one ref per thread; branches are never touched. */
export const HANDOFF_HIDDEN_REF_PREFIX = "refs/specwithcode/handoff/";
export const HANDOFF_LEASE_RENEW_MS = 30_000;
/** Three missed renewals: the holder is treated as unreachable. */
export const HANDOFF_LEASE_STALE_MS = 90_000;
export const HANDOFF_LONG_TURN_CHECKPOINT_MS = 300_000;
export const HANDOFF_NOTE_MAX_WORDS = 120;
export const HANDOFF_MAX_SNAPSHOT_FILE_BYTES = 10 * 1024 * 1024;
export const HANDOFF_MAX_SNAPSHOT_FILES = 20_000;
/** Bigger replication bundles are refused with "copy the folder first". */
export const HANDOFF_MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));

export const HandoffModeSetting = Schema.Literals(["off", "on"]);
export type HandoffModeSetting = typeof HandoffModeSetting.Type;
export const HandoffThreadModeSetting = Schema.Literals(["inherit", "off", "on"]);
export type HandoffThreadModeSetting = typeof HandoffThreadModeSetting.Type;
/** Who writes the per-turn note: nobody, the cheap text-generation model, or the thread's model. */
export const HandoffNoteModel = Schema.Literals(["off", "cheap", "thread"]);
export type HandoffNoteModel = typeof HandoffNoteModel.Type;

export const HandoffConfig = Schema.Struct({
  defaultMode: HandoffModeSetting,
  noteModel: HandoffNoteModel,
  /** Push each thread's hidden ref to `origin` when the repository has one. Branches never. */
  pushToOrigin: Schema.Boolean,
  /** When this Mac sleeps, hand its running handoff-mode threads to this machine. */
  sleepTarget: Schema.NullOr(EnvironmentId),
  /** Continue automatically after the holder has been unreachable this long; 0 is off. */
  autoTakeoverMinutes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(1440)),
});
export type HandoffConfig = typeof HandoffConfig.Type;

export const DEFAULT_HANDOFF_CONFIG: HandoffConfig = {
  defaultMode: "off",
  noteModel: "cheap",
  pushToOrigin: true,
  sleepTarget: null,
  autoTakeoverMinutes: 0,
};

export const HandoffNote = Schema.Struct({
  done: bounded(2000),
  next: bounded(2000),
  openQuestions: bounded(2000),
  createdAt: IsoDateTime,
});
export type HandoffNote = typeof HandoffNote.Type;

export const HandoffSkippedFile = Schema.Struct({
  path: bounded(4096),
  bytes: NonNegativeInt,
  reason: Schema.Literals(["too-large", "too-many-files", "submodule"]),
});
export type HandoffSkippedFile = typeof HandoffSkippedFile.Type;

/**
 * How the thread's latest run ended, as the source recorded it. Only "active",
 * "handoff", "sleep" and "usage-limit" are resumed on the destination; a user
 * Stop is final, and completed, cancelled or failed runs never restart.
 */
export const HandoffRunEnding = Schema.Literals([
  "active",
  "handoff",
  "sleep",
  "usage-limit",
  "service-update",
  "user-stop",
  "completed",
  "cancelled",
  "failed",
  "none",
]);
export type HandoffRunEnding = typeof HandoffRunEnding.Type;

const RESUMABLE_ENDINGS: ReadonlySet<HandoffRunEnding> = new Set([
  "active",
  "handoff",
  "sleep",
  "usage-limit",
]);

export function isResumableHandoffEnding(ending: HandoffRunEnding): boolean {
  return RESUMABLE_ENDINGS.has(ending);
}

/**
 * Classifies a run for resume. `fencedBy` is set when handoff mode itself
 * interrupted the run (an explicit handoff or a sleep), which the run's own
 * interrupt cause cannot express.
 */
export function handoffRunEnding(run: {
  readonly status: OrchestrationV2RunStatus | null;
  readonly interruptCause?: OrchestrationV2RunInterruptCause | null;
  readonly failureClass?: OrchestrationV2ProviderFailureClass | null;
  readonly fencedBy?: "handoff" | "sleep" | null;
}): HandoffRunEnding {
  // The user's own Stop stays final even on a thread handoff mode fenced.
  const userStopped = run.status === "interrupted" && run.interruptCause === "user";
  if (
    run.fencedBy != null &&
    !userStopped &&
    (run.status === "interrupted" || isActiveStatus(run.status))
  ) {
    return run.fencedBy;
  }
  switch (run.status) {
    case null:
      return "none";
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return "active";
    case "completed":
    case "rolled_back":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return run.failureClass === "usage_limit" ? "usage-limit" : "failed";
    case "interrupted":
      // Older interrupt items carry no cause and count as the user's Stop.
      if (run.interruptCause === "service_update") return "service-update";
      return "user-stop";
  }
}

function isActiveStatus(status: OrchestrationV2RunStatus | null): boolean {
  return (
    status === "preparing" ||
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting"
  );
}

export const HandoffCheckpointReason = Schema.Literals([
  "turn-end",
  "interval",
  "manual",
  "handoff",
  "fence",
]);
export type HandoffCheckpointReason = typeof HandoffCheckpointReason.Type;

/** Child execution stays on its acknowledged owner, or is already terminal. */
export const HandoffChildDisposition = Schema.Struct({
  taskId: Schema.String,
  parentThreadId: ThreadId,
  childThreadId: Schema.NullOr(ThreadId),
  sourceEnvironmentId: EnvironmentId,
  ownerEpoch: NonNegativeInt,
  origin: Schema.Literals(["provider_native", "app_owned"]),
  providerThreadId: Schema.NullOr(Schema.String),
  status: Schema.String,
  disposition: Schema.Literals(["settled", "leased", "unknown"]),
  context: Schema.String,
});
export type HandoffChildDisposition = typeof HandoffChildDisposition.Type;

export const HandoffCheckpoint = Schema.Struct({
  sequence: NonNegativeInt,
  commit: sha,
  baseCommit: sha,
  branch: Schema.NullOr(bounded(512)),
  ref: bounded(512),
  createdAt: IsoDateTime,
  reason: HandoffCheckpointReason,
  skipped: Schema.Array(HandoffSkippedFile).check(Schema.isMaxLength(200)),
  /** Untracked secret-like files (.env and friends) left out of the snapshot. */
  excludedSecretCount: NonNegativeInt,
  /**
   * Secret-like and ignored env files the source worktree has (paths only,
   * never contents). The destination must already hold each one, through
   * the folder copy's secret step, before a thread can move there.
   */
  requiredSecretPaths: Schema.optional(Schema.Array(bounded(1024)).check(Schema.isMaxLength(200))),
  transcriptMessageCount: NonNegativeInt,
  note: Schema.NullOr(HandoffNote),
  pushedToOrigin: Schema.Boolean,
  /** The lease epoch the checkpoint was written under. */
  epoch: NonNegativeInt,
  latestRunId: Schema.NullOr(RunId),
  /** Idempotency key of the latest turn; a continuation inherits it. */
  turnKey: Schema.NullOr(bounded(300)),
  runEnding: HandoffRunEnding,
  /** Side effects already done under this thread's turns, so none repeats. */
  sideEffects: Schema.Array(ThreadSideEffect).check(Schema.isMaxLength(200)),
  sourceRoot: ThreadSourceRoot,
  children: Schema.optional(Schema.Array(HandoffChildDisposition).check(Schema.isMaxLength(200))),
});
export type HandoffCheckpoint = typeof HandoffCheckpoint.Type;

export const HandoffReplicaState = Schema.Literals([
  "current",
  "behind",
  "failed",
  "needs-grant",
  "too-large",
]);
export type HandoffReplicaState = typeof HandoffReplicaState.Type;

export const HandoffReplicaStatus = Schema.Struct({
  environmentId: EnvironmentId,
  machineLabel: bounded(120),
  state: HandoffReplicaState,
  /** The newest checkpoint sequence the machine acknowledged. */
  sequence: Schema.NullOr(NonNegativeInt),
  detail: Schema.NullOr(bounded(500)),
  updatedAt: IsoDateTime,
});
export type HandoffReplicaStatus = typeof HandoffReplicaStatus.Type;

export const HandoffLeaseState = Schema.Literals(["active", "handing-off", "fenced"]);
export type HandoffLeaseState = typeof HandoffLeaseState.Type;

export const HandoffLease = Schema.Struct({
  holderEnvironmentId: EnvironmentId,
  holderLabel: bounded(120),
  holderThreadId: ThreadId,
  epoch: NonNegativeInt,
  renewedAt: IsoDateTime,
  state: HandoffLeaseState,
});
export type HandoffLease = typeof HandoffLease.Type;

/** The badge a thread row shows. `ready` uses the accent color. */
export const HandoffBadge = Schema.Literals([
  "ready",
  "behind",
  "handing-off",
  "continued",
  "source-unreachable",
  "paused",
]);
export type HandoffBadge = typeof HandoffBadge.Type;

export const HandoffContinuation = Schema.Struct({
  environmentId: EnvironmentId,
  machineLabel: bounded(120),
  threadId: ThreadId,
  at: IsoDateTime,
});
export type HandoffContinuation = typeof HandoffContinuation.Type;

export const HandoffThreadState = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  mode: HandoffThreadModeSetting,
  effectiveMode: HandoffModeSetting,
  badge: Schema.NullOr(HandoffBadge),
  checkpoint: Schema.NullOr(HandoffCheckpoint),
  replicas: Schema.Array(HandoffReplicaStatus),
  lease: Schema.NullOr(HandoffLease),
  continuedOn: Schema.NullOr(HandoffContinuation),
  /** Local branch holding changes made here after another machine took over. */
  fencedBranch: Schema.NullOr(bounded(512)),
  lastError: Schema.NullOr(bounded(500)),
});
export type HandoffThreadState = typeof HandoffThreadState.Type;

/** A checkpoint another machine replicated here, which this machine can continue. */
export const HandoffIncomingReplica = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceLabel: bounded(120),
  sourceThreadId: ThreadId,
  /**
   * The local project explicitly linked to the source project (0948), when
   * there is one. Never matched by name.
   */
  projectId: Schema.NullOr(ProjectId),
  title: bounded(500),
  checkpoint: HandoffCheckpoint,
  lease: HandoffLease,
  /** When the source last answered; drives "Unknown · <machine> last seen <time>". */
  sourceLastSeenAt: Schema.NullOr(IsoDateTime),
  sourceUnreachable: Schema.Boolean,
  receivedAt: IsoDateTime,
  continuedThreadId: Schema.NullOr(ThreadId),
});
export type HandoffIncomingReplica = typeof HandoffIncomingReplica.Type;

export const HandoffPreflightCheck = Schema.Literals([
  "checkpoint",
  "ignored-files",
  "grant",
  "provider",
  "model",
  "project-link",
  "lease",
  "version",
]);
export type HandoffPreflightCheck = typeof HandoffPreflightCheck.Type;

/** One failed check, worded for the user: "Minis: no .env.local". */
export const HandoffPreflightFailure = Schema.Struct({
  check: HandoffPreflightCheck,
  message: bounded(500),
});
export type HandoffPreflightFailure = typeof HandoffPreflightFailure.Type;

export const HandoffPreflightResult = Schema.Struct({
  threadId: ThreadId,
  title: bounded(500),
  ok: Schema.Boolean,
  failures: Schema.Array(HandoffPreflightFailure),
  /** Whether the destination starts a turn after the move (see handoffRunEnding). */
  resume: Schema.Boolean,
  runEnding: HandoffRunEnding,
});
export type HandoffPreflightResult = typeof HandoffPreflightResult.Type;

export const HandoffPreflightInput = Schema.Struct({
  destinationEnvironmentId: EnvironmentId,
  threadIds: Schema.Array(ThreadId).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  modelSelection: Schema.optional(ModelSelection),
});
export type HandoffPreflightInput = typeof HandoffPreflightInput.Type;

/** moved: continued on the destination. stayed: a check failed; the source is untouched. */
export const HandoffMachineThreadOutcome = Schema.Literals(["moved", "stayed", "skipped"]);
export type HandoffMachineThreadOutcome = typeof HandoffMachineThreadOutcome.Type;

export const HandoffMachineThreadResult = Schema.Struct({
  threadId: ThreadId,
  title: bounded(500),
  outcome: HandoffMachineThreadOutcome,
  /** The exact reason for "stayed" or "skipped"; the destination thread for "moved". */
  detail: Schema.NullOr(bounded(500)),
  continuedThreadId: Schema.NullOr(ThreadId),
  resumed: Schema.Boolean,
});
export type HandoffMachineThreadResult = typeof HandoffMachineThreadResult.Type;

export const HandoffMachineRun = Schema.Struct({
  destinationEnvironmentId: EnvironmentId,
  destinationLabel: bounded(120),
  reason: Schema.Literals(["manual", "sleep"]),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  results: Schema.Array(HandoffMachineThreadResult),
});
export type HandoffMachineRun = typeof HandoffMachineRun.Type;

export const HandoffModeSnapshot = Schema.Struct({
  environmentId: EnvironmentId,
  machineLabel: bounded(120),
  config: HandoffConfig,
  projectModes: Schema.Record(Schema.String, HandoffModeSetting),
  threads: Schema.Array(HandoffThreadState),
  incoming: Schema.Array(HandoffIncomingReplica),
  /** Set after a wake that found no peer: handoff-mode threads wait until one answers. */
  pausedSince: Schema.NullOr(IsoDateTime),
  machineRun: Schema.NullOr(HandoffMachineRun),
});
export type HandoffModeSnapshot = typeof HandoffModeSnapshot.Type;

export const HandoffModeErrorCode = Schema.Literals([
  "not_found",
  "invalid",
  "busy",
  "not_a_repository",
  "unreachable",
  "needs_grant",
  "fenced",
  "too_large",
  "failed",
]);
export type HandoffModeErrorCode = typeof HandoffModeErrorCode.Type;

export class HandoffModeError extends Schema.TaggedError<HandoffModeError>()("HandoffModeError", {
  code: HandoffModeErrorCode,
  message: Schema.String,
}) {}

export const HandoffModeEmptyInput = Schema.Struct({});
export const HandoffConfigPatch = Schema.Struct({
  defaultMode: Schema.optional(HandoffModeSetting),
  noteModel: Schema.optional(HandoffNoteModel),
  pushToOrigin: Schema.optional(Schema.Boolean),
  sleepTarget: Schema.optional(Schema.NullOr(EnvironmentId)),
  autoTakeoverMinutes: Schema.optional(HandoffConfig.fields.autoTakeoverMinutes),
});
export type HandoffConfigPatch = typeof HandoffConfigPatch.Type;
export const HandoffSetThreadModeInput = Schema.Struct({
  threadId: ThreadId,
  mode: HandoffThreadModeSetting,
});
export const HandoffSetProjectModeInput = Schema.Struct({
  projectId: ProjectId,
  mode: Schema.NullOr(HandoffModeSetting),
});
export const HandoffThreadInput = Schema.Struct({ threadId: ThreadId });

export const HandOffInput = Schema.Struct({
  threadId: ThreadId,
  /** This machine's own id continues the same thread with another model. */
  destinationEnvironmentId: EnvironmentId,
  modelSelection: Schema.optional(ModelSelection),
});
export type HandOffInput = typeof HandOffInput.Type;

export const HandOffResult = Schema.Struct({
  environmentId: EnvironmentId,
  machineLabel: bounded(120),
  threadId: ThreadId,
  /** The model the destination started with, which may be its default. */
  modelSelection: Schema.NullOr(ModelSelection),
  notice: Schema.NullOr(bounded(500)),
});
export type HandOffResult = typeof HandOffResult.Type;

export const HandOffMachineInput = Schema.Struct({
  destinationEnvironmentId: EnvironmentId,
  reason: Schema.Literals(["manual", "sleep"]),
  /** The threads to move; omitted moves every running handoff-mode thread. */
  threadIds: Schema.optional(Schema.Array(ThreadId).check(Schema.isMaxLength(100))),
});
export type HandOffMachineInput = typeof HandOffMachineInput.Type;

export const HandoffContinueHereInput = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  modelSelection: Schema.optional(ModelSelection),
});
export type HandoffContinueHereInput = typeof HandoffContinueHereInput.Type;
