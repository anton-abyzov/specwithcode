/**
 * The machine-to-machine handoff API. The source posts to the destination
 * with its worker credential (the destination's work grant for the source):
 * negotiate which commits the destination holds, replicate a checkpoint as a
 * frame (JSON metadata then a Git bundle), preflight threads, take one over
 * at the next epoch, and heartbeat the leases it holds.
 */
import * as Schema from "effect/Schema";

import {
  CoordinatorStandbyAfterMinutes,
  EnvironmentId,
  HandoffCheckpoint,
  HandoffLease,
  HandoffModeErrorCode,
  HandoffPreflightCheck,
  HandoffPreflightFailure,
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
  ThreadExecutionRecord,
  ThreadId,
} from "@specweave-studio/contracts";

import packageJson from "../../package.json" with { type: "json" };
import { CoordinatorStandbyShadowWorker } from "../project/CoordinatorStandbyStore.ts";

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
});
export type ReplicateMeta = typeof ReplicateMeta.Type;
export const ReplicateResponse = Schema.Struct({ sequence: NonNegativeInt });
export type ReplicateResponse = typeof ReplicateResponse.Type;

export const PeerPreflightRequest = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  protocolVersion: Schema.optional(NonNegativeInt),
  appVersion: Schema.optional(text(40)),
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
});
export type CoordinatorReplicaRequest = typeof CoordinatorReplicaRequest.Type;
export const CoordinatorReplicaResponse = Schema.Struct({
  replicatedAt: IsoDateTime,
  replayed: Schema.Boolean,
});
export type CoordinatorReplicaResponse = typeof CoordinatorReplicaResponse.Type;

export type PeerPath =
  | "negotiate"
  | "replicate"
  | "preflight"
  | "takeover"
  | "heartbeat"
  | "coordinator-lease"
  | "coordinator-replica";
export const PEER_PATHS: ReadonlySet<string> = new Set<PeerPath>([
  "negotiate",
  "replicate",
  "preflight",
  "takeover",
  "heartbeat",
  "coordinator-lease",
  "coordinator-replica",
]);

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
