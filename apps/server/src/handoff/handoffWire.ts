/**
 * The machine-to-machine handoff API. The source posts to the destination
 * with its worker credential (the destination's work grant for the source):
 * negotiate which commits the destination holds, replicate a checkpoint as a
 * frame (JSON metadata then a Git bundle), preflight threads, take one over
 * at the next epoch, and heartbeat the leases it holds.
 */
import * as Schema from "effect/Schema";

import {
  CoordinatorRoutineCopies,
  CoordinatorStandbyAfterMinutes,
  EnvironmentId,
  HANDOFF_TRACK_START_CAPABILITY,
  HANDOFF_V2_CAPABILITY,
  HandoffCapabilities,
  HandoffCheckpoint,
  HandoffLease,
  HandoffModeErrorCode,
  HandoffPreflightCheck,
  HandoffPreflightFailure,
  HandoffTransferOperationId,
  HandoffTransferTrigger,
  hasHandoffV2,
  IsoDateTime,
  LogicalProjectMember,
  ModelSelection,
  NonNegativeInt,
  ProjectCoordinatorBinding,
  ProjectId,
  PROJECT_LINK_MAX_BYTES,
  ProjectLinkNote,
  PROJECT_GOAL_MAX_LENGTH,
  PROJECT_INSTRUCTIONS_MAX_LENGTH,
  ProviderInteractionMode,
  RuntimeMode,
  TeamRulesCarried,
  ThreadExecutionRecord,
  ThreadId,
} from "@specweave-studio/contracts";

import packageJson from "../../package.json" with { type: "json" };
import { CoordinatorStandbyShadowWorker } from "../project/CoordinatorStandbyStore.ts";
import { HandoffReviewLock } from "./handoffReviewLock.ts";
import { HANDOFF_PLAN_CAPABILITY } from "./handoffPlan.ts";

export const HANDOFF_PEER_PREFIX = "/api/handoff/v1";
/**
 * Bumped whenever what the two machines do with these messages changes, not
 * only their shape. Machines hand off only at the same version; a build from
 * before this field existed counts as 1.
 */
export const HANDOFF_PROTOCOL_VERSION = 2;
export const HANDOFF_APP_VERSION: string = packageJson.version;

/**
 * The version check a handoff fails when the two machines speak different
 * protocol versions, worded for the user: which machine to update first.
 */
export function versionFailure(input: {
  readonly peerLabel: string;
  readonly peerProtocolVersion: number | undefined;
  readonly peerAppVersion: string | undefined;
  readonly selfLabel: string;
}): HandoffPreflightFailure | null {
  const theirs = input.peerProtocolVersion ?? 1;
  if (theirs === HANDOFF_PROTOCOL_VERSION) return null;
  const older = theirs < HANDOFF_PROTOCOL_VERSION ? input.peerLabel : input.selfLabel;
  const mention = older.startsWith("The ") ? `t${older.slice(1)}` : older;
  const peerVersion = input.peerAppVersion ?? "an older version";
  return {
    check: "version",
    message: `${input.peerLabel} runs SpecWithCode ${peerVersion} and ${input.selfLabel} runs ${HANDOFF_APP_VERSION}; they cannot hand off between these versions. Update ${mention} first.`,
  };
}
/**
 * What this machine's handoff does beyond the numbered protocol. `handoff.v2`
 * is the transfer record alone; the protocol version says nothing about it.
 */
export const HANDOFF_CAPABILITIES: ReadonlyArray<string> = [
  HANDOFF_V2_CAPABILITY,
  HANDOFF_PLAN_CAPABILITY,
  HANDOFF_TRACK_START_CAPABILITY,
];

/**
 * The check a handoff fails when the other machine does not keep transfer
 * records. It is refused before anything is held, and nothing falls back to
 * the older exchange.
 */
export function capabilityFailure(input: {
  readonly peerLabel: string;
  readonly capabilities: ReadonlyArray<string> | undefined;
}): HandoffPreflightFailure | null {
  if (hasHandoffV2(input.capabilities)) return null;
  return {
    check: "version",
    message: `Needs update: ${input.peerLabel} runs a SpecWithCode from before handoff transfer records, so no thread moves between it and this machine. Update SpecWithCode on ${input.peerLabel} first.`,
  };
}
export const HANDOFF_FRAME_META_MAX_BYTES = 4 * 1024 * 1024;
export const HANDOFF_JSON_MAX_BYTES = 1024 * 1024;
export const HANDOFF_TRANSCRIPT_MAX_MESSAGES = 8;
export const HANDOFF_TRANSCRIPT_MESSAGE_MAX_CHARS = 1500;

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}([0-9a-f]{24})?$/));
/**
 * Where the repository sits relative to the source's project folder, with `/`
 * separators: "" for the folder itself, "repo-a" for a nested checkout, ".."
 * when the project folder sits inside the repository. The destination maps it
 * under its own linked project folder, never anywhere else.
 */
const repositoryPath = text(1024);

export const PeerTranscriptMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: text(HANDOFF_TRANSCRIPT_MESSAGE_MAX_CHARS),
});
export type PeerTranscriptMessage = typeof PeerTranscriptMessage.Type;

export const NegotiateRequest = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceProjectId: ProjectId,
  sourceThreadId: ThreadId,
  repositoryPath,
  candidates: Schema.Array(sha).check(Schema.isMaxLength(48)),
});
export type NegotiateRequest = typeof NegotiateRequest.Type;
export const NegotiateResponse = Schema.Struct({ known: Schema.Array(sha) });
export type NegotiateResponse = typeof NegotiateResponse.Type;

/**
 * The machine where a thread waits for this work's result, and the machines
 * it can ask for it. The result is pulled by that machine, so the work may
 * move on only to a machine in `reachable`, or back to it.
 */
export const HandoffLauncher = Schema.Struct({
  environmentId: EnvironmentId,
  label: text(120),
  reachable: Schema.Array(EnvironmentId),
});
export type HandoffLauncher = typeof HandoffLauncher.Type;

export const ReplicateMeta = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceLabel: text(120),
  sourceProjectId: ProjectId,
  sourceThreadId: ThreadId,
  repositoryPath,
  title: text(500),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  checkpoint: HandoffCheckpoint,
  lease: Schema.NullOr(HandoffLease),
  transcript: Schema.Array(PeerTranscriptMessage).check(
    Schema.isMaxLength(HANDOFF_TRANSCRIPT_MAX_MESSAGES),
  ),
  /** The source thread's owner and execution history, carried into the continuation. */
  execution: Schema.NullOr(ThreadExecutionRecord),
  protocolVersion: Schema.optional(NonNegativeInt),
  appVersion: Schema.optional(text(40)),
  /** The ceiling the thread carries. The sender refuses a machine too old to hold it. */
  carried: Schema.optional(TeamRulesCarried),
  /** Who waits for the result of a continuation that arrived on the sender. */
  launcher: Schema.optional(HandoffLauncher),
  /**
   * A review thread's reviewer lock; null for a thread that is no review, and
   * absent from a sender older than the lock. Sent only to a machine with the
   * `handoffReviewLock` capability.
   */
  reviewLock: Schema.optional(Schema.NullOr(HandoffReviewLock)),
});
export type ReplicateMeta = typeof ReplicateMeta.Type;
export const ReplicateResponse = Schema.Struct({ sequence: NonNegativeInt });
export type ReplicateResponse = typeof ReplicateResponse.Type;

/**
 * Sync extras (1390): work Git does not carry, sent as a bundle and landed as
 * a branch `swc/from-{machine}/…`. They have no thread, so they have their own
 * messages; a machine from before them answers 404 for both paths.
 */
export const ExtrasNegotiateRequest = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceProjectId: ProjectId,
  repositoryPath,
  candidates: Schema.Array(sha).check(Schema.isMaxLength(48)),
});
export type ExtrasNegotiateRequest = typeof ExtrasNegotiateRequest.Type;

export const ExtrasReplicateMeta = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceLabel: text(120),
  sourceProjectId: ProjectId,
  repositoryPath,
  /** The Sync run this extra belongs to; six characters of it name a branch that must sit beside another. */
  operationId: text(64),
  /** The branch's name on the source, or `uncommitted-{yyyymmdd-hhmmss}-{id}` for a snapshot. */
  leaf: text(255),
  commit: sha,
});
export type ExtrasReplicateMeta = typeof ExtrasReplicateMeta.Type;
export const ExtrasReplicateResponse = Schema.Struct({
  machineLabel: text(120),
  /** The branch the extra arrived as. */
  branch: text(512),
  landed: Schema.Literals(["created", "moved-forward", "unchanged", "beside", "checked-out"]),
});
export type ExtrasReplicateResponse = typeof ExtrasReplicateResponse.Type;

export const PeerPreflightRequest = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  protocolVersion: Schema.optional(NonNegativeInt),
  appVersion: Schema.optional(text(40)),
  /** Absent from a machine that keeps no transfer records. */
  capabilities: Schema.optional(HandoffCapabilities),
  threads: Schema.Array(
    Schema.Struct({
      sourceThreadId: ThreadId,
      /** Checked against this machine's explicit project links even before a replica exists. */
      sourceProjectId: ProjectId,
      /** The checkpoint the source will hand over; the destination must hold it. */
      sequence: NonNegativeInt,
      modelSelection: Schema.NullOr(ModelSelection),
    }),
  ).check(Schema.isMaxLength(100)),
});
export type PeerPreflightRequest = typeof PeerPreflightRequest.Type;
export const PeerPreflightResponse = Schema.Struct({
  machineLabel: text(120),
  protocolVersion: Schema.optional(NonNegativeInt),
  appVersion: Schema.optional(text(40)),
  capabilities: Schema.optional(HandoffCapabilities),
  results: Schema.Array(
    Schema.Struct({
      sourceThreadId: ThreadId,
      failures: Schema.Array(HandoffPreflightFailure),
    }),
  ),
});
export type PeerPreflightResponse = typeof PeerPreflightResponse.Type;

export const TakeoverReason = Schema.Literals([
  "handoff",
  "machine-handoff",
  "sleep",
  "continue-here",
  "auto-takeover",
]);
export type TakeoverReason = typeof TakeoverReason.Type;

export const TakeoverRequest = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  /** The epoch the destination takes the lease at; one more than the source held. */
  epoch: NonNegativeInt,
  sequence: NonNegativeInt,
  reason: TakeoverReason,
  modelSelection: Schema.NullOr(ModelSelection),
  /** Set while a thread waits for the result. Older receivers ignore it. */
  launcher: Schema.optional(HandoffLauncher),
  /**
   * The source's transfer record for this move. The destination writes its
   * verdict under it before it launches, and answers every repeat the same.
   * Absent from a machine that keeps no transfer records.
   */
  operationId: Schema.optional(HandoffTransferOperationId),
  trigger: Schema.optional(HandoffTransferTrigger),
  /** The thread is a review: it is taken over only through `review-takeover`. */
  review: Schema.optional(Schema.Boolean),
});
export type TakeoverRequest = typeof TakeoverRequest.Type;
export const TakeoverResponse = Schema.Struct({
  threadId: ThreadId,
  /** The destination project the continuation lives in. */
  projectId: Schema.optional(ProjectId),
  machineLabel: text(120),
  modelSelection: Schema.NullOr(ModelSelection),
  resumed: Schema.Boolean,
  notice: Schema.NullOr(text(500)),
});
export type TakeoverResponse = typeof TakeoverResponse.Type;

/**
 * A source asks what became of a takeover it has no answer for. The
 * destination answers "accepted" with its receipt, or writes "not accepted"
 * and answers that: a takeover for the same lineage arriving later is refused.
 */
export const TransferStatusRequest = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  epoch: NonNegativeInt,
  /** Null for a hold made before transfer records existed. */
  operationId: Schema.NullOr(HandoffTransferOperationId),
});
export type TransferStatusRequest = typeof TransferStatusRequest.Type;
export const TransferStatusResponse = Schema.Struct({
  machineLabel: text(120),
  status: Schema.Literals(["accepted", "not-accepted"]),
  receipt: Schema.NullOr(TakeoverResponse),
});
export type TransferStatusResponse = typeof TransferStatusResponse.Type;

/**
 * "Continue here" asked on a machine that holds a copy. It never takes the
 * thread itself: it asks the machine that runs it to hand the thread over,
 * which is the same move, under the same record, as a handoff started there.
 * `sourceEnvironmentId` is the asking machine, as in every request.
 */
export const TransferPullRequest = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  threadId: ThreadId,
  modelSelection: Schema.NullOr(ModelSelection),
});
export type TransferPullRequest = typeof TransferPullRequest.Type;

export const HeartbeatRequest = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceLabel: text(120),
  leases: Schema.Array(
    Schema.Struct({
      sourceThreadId: ThreadId,
      epoch: NonNegativeInt,
      /**
       * Sent only to the one machine allowed to continue this thread on its own
       * (the sleep target, else the project's standby): the delay it waits. Older
       * receivers ignore it.
       */
      autoContinueMinutes: Schema.optional(NonNegativeInt),
    }),
  ).check(Schema.isMaxLength(500)),
});
export type HeartbeatRequest = typeof HeartbeatRequest.Type;
/** Threads the destination continued at a newer epoch: the source must fence them. */
export const HeartbeatResponse = Schema.Struct({
  machineLabel: text(120),
  continued: Schema.Array(
    Schema.Struct({ sourceThreadId: ThreadId, epoch: NonNegativeInt, threadId: ThreadId }),
  ),
});
export type HeartbeatResponse = typeof HeartbeatResponse.Type;

export const PeerErrorBody = Schema.Struct({
  error: text(1000),
  code: Schema.optional(HandoffModeErrorCode),
  /** The preflight check a refusal maps to, so the source reports it per thread. */
  check: Schema.optional(HandoffPreflightCheck),
  /**
   * True when this machine may have acted before it failed: the answer is not
   * a "no", and the source keeps its hold. Absent on every plain refusal.
   */
  uncertain: Schema.optional(Schema.Boolean),
});
export type PeerErrorBody = typeof PeerErrorBody.Type;

/**
 * Automatic coordinator takeover. The coordinator pushes a lease to its armed
 * standby every 30 seconds (`coordinator-lease`), and its notes, goal and
 * instructions when the standby asks (`coordinator-replica`). Bumped whenever
 * what the two machines do with these changes; a mismatch is refused.
 */
export const COORDINATOR_LEASE_PROTOCOL_VERSION = 1;
/** Notes up to the link cap, which JSON escaping can at most double, plus goal and instructions. */
export const COORDINATOR_REPLICA_MAX_BYTES = 2 * PROJECT_LINK_MAX_BYTES + HANDOFF_JSON_MAX_BYTES;

export const CoordinatorLeaseRequest = Schema.Struct({
  protocolVersion: NonNegativeInt,
  /** `release` disarms the standby; `pause` announces a planned stop. */
  kind: Schema.Literals(["lease", "release", "pause"]),
  logicalProjectId: text(512),
  epoch: NonNegativeInt,
  seq: NonNegativeInt,
  /** The coordinator's view only; the standby keeps the delay the owner accepted there. */
  afterMinutes: CoordinatorStandbyAfterMinutes,
  /** `coordinatorContentDigest` of the coordinator's notes, goal and instructions. */
  contentDigest: text(128),
  /**
   * `coordinatorRoutinesDigest` of the routines the coordinator would send.
   * Optional so either side may predate routine copies; neither changes the
   * protocol version, since an older peer only ignores them.
   */
  routinesDigest: Schema.optional(text(128)),
  runningThreads: Schema.Array(Schema.Struct({ threadId: ThreadId, title: text(500) })).check(
    Schema.isMaxLength(200),
  ),
  workers: Schema.Array(CoordinatorStandbyShadowWorker).check(Schema.isMaxLength(200)),
  pausedUntil: Schema.optional(IsoDateTime),
  sleeping: Schema.optional(Schema.Boolean),
});
export type CoordinatorLeaseRequest = typeof CoordinatorLeaseRequest.Type;
export const CoordinatorLeaseResponse = Schema.Struct({
  /** Set once the standby took over: the old coordinator verifies it and gives way. */
  takenOver: Schema.NullOr(
    Schema.Struct({
      coordinatorBinding: ProjectCoordinatorBinding,
      successor: LogicalProjectMember,
    }),
  ),
  /** The standby's replica is not this content; send `coordinator-replica`. */
  wantsContent: Schema.Boolean,
  /** The standby is about to sleep; its silence is no reason to fence. */
  standbySleeping: Schema.Boolean,
  /** The standby's own receive time. */
  receivedAt: IsoDateTime,
});
export type CoordinatorLeaseResponse = typeof CoordinatorLeaseResponse.Type;

export const CoordinatorReplicaRequest = Schema.Struct({
  protocolVersion: NonNegativeInt,
  logicalProjectId: text(512),
  epoch: NonNegativeInt,
  digest: text(128),
  goal: text(PROJECT_GOAL_MAX_LENGTH),
  instructions: text(PROJECT_INSTRUCTIONS_MAX_LENGTH),
  notes: Schema.Array(ProjectLinkNote).check(Schema.isMaxLength(4096)),
  notesTruncated: Schema.Boolean,
  /** The coordinator's routines for the standby to keep (see CoordinatorRoutineCopy). */
  routines: Schema.optional(CoordinatorRoutineCopies),
  routinesDigest: Schema.optional(text(128)),
});
export type CoordinatorReplicaRequest = typeof CoordinatorReplicaRequest.Type;
export const CoordinatorReplicaResponse = Schema.Struct({
  replicatedAt: IsoDateTime,
  replayed: Schema.Boolean,
});
export type CoordinatorReplicaResponse = typeof CoordinatorReplicaResponse.Type;

/**
 * Linked project memory, driven by the coordinator's server: `memory-export`
 * reads one page of a copy's memory, `memory-merge` merges another copy's page
 * into it (`LinkedMemoryPeers`). A page is at most the link cap, which JSON
 * escaping can at most double.
 */
export const LINKED_MEMORY_PEER_MAX_BYTES = COORDINATOR_REPLICA_MAX_BYTES;
/** A coordinator's content or a plan, either way (`linkedSyncWire.ts`): the same cap as a memory page. */
export const LINKED_SYNC_PEER_MAX_BYTES = COORDINATOR_REPLICA_MAX_BYTES;

export type PeerPath =
  | "negotiate"
  | "replicate"
  | "preflight"
  | "takeover"
  | "heartbeat"
  | "coordinator-lease"
  | "coordinator-replica"
  | "memory-export"
  | "memory-merge"
  | "linked-digest"
  | "linked-content"
  | "linked-replica"
  | "linked-supersede"
  | "linked-members"
  | "plan-export"
  | "plan-merge"
  | "extras-negotiate"
  | "extras-replicate"
  | "transfer-status"
  | "transfer-pull"
  | "review-replicate"
  | "review-takeover"
  | "check";
export const PEER_PATHS: ReadonlySet<string> = new Set<PeerPath>([
  "negotiate",
  "replicate",
  "preflight",
  "takeover",
  "heartbeat",
  "coordinator-lease",
  "coordinator-replica",
  "memory-export",
  "memory-merge",
  "linked-digest",
  "linked-content",
  "linked-replica",
  "linked-supersede",
  "linked-members",
  "plan-export",
  "plan-merge",
  "extras-negotiate",
  "extras-replicate",
  "transfer-status",
  "transfer-pull",
  "review-replicate",
  "review-takeover",
  "check",
]);

/**
 * A review thread's checkpoint and takeover have paths of their own. A server
 * from before the reviewer lock has neither, so it can never take a review as
 * an ordinary thread, whatever this machine last read about it.
 */
export const reviewPath = (path: "replicate" | "takeover", review: boolean): PeerPath =>
  review ? `review-${path}` : path;

export class FrameError extends Error {}

/** `[u32 big-endian meta length][meta JSON][bundle bytes]`; the bundle may be empty. */
export function encodeFrame(meta: unknown, bundle: Uint8Array | null): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  if (json.byteLength > HANDOFF_FRAME_META_MAX_BYTES) {
    throw new FrameError("The checkpoint metadata is too large.");
  }
  const body = bundle ?? new Uint8Array();
  const out = new Uint8Array(4 + json.byteLength + body.byteLength);
  new DataView(out.buffer).setUint32(0, json.byteLength, false);
  out.set(json, 4);
  out.set(body, 4 + json.byteLength);
  return out;
}

export function decodeFrame(bytes: Uint8Array): { meta: unknown; bundle: Uint8Array } {
  if (bytes.byteLength < 4) throw new FrameError("The frame is truncated.");
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  if (length > HANDOFF_FRAME_META_MAX_BYTES || 4 + length > bytes.byteLength) {
    throw new FrameError("The frame metadata length is invalid.");
  }
  let meta: unknown;
  try {
    meta = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
  } catch {
    throw new FrameError("The frame metadata is not JSON.");
  }
  return { meta, bundle: bytes.subarray(4 + length) };
}

/** The last messages, newest kept, each capped, for the transcript delta. */
export function transcriptTail(
  messages: ReadonlyArray<PeerTranscriptMessage>,
): Array<PeerTranscriptMessage> {
  return messages.slice(-HANDOFF_TRANSCRIPT_MAX_MESSAGES).map((message) => ({
    role: message.role,
    text:
      message.text.length > HANDOFF_TRANSCRIPT_MESSAGE_MAX_CHARS
        ? `${message.text.slice(0, HANDOFF_TRANSCRIPT_MESSAGE_MAX_CHARS - 1)}…`
        : message.text,
  }));
}
