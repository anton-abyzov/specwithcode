/**
 * The machine-to-machine handoff API. The source posts to the destination
 * with its worker credential (the destination's work grant for the source):
 * negotiate which commits the destination holds, replicate a checkpoint as a
 * frame (JSON metadata then a Git bundle), preflight threads, take one over
 * at the next epoch, and heartbeat the leases it holds.
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  HandoffCheckpoint,
  HandoffLease,
  HandoffModeErrorCode,
  HandoffPreflightCheck,
  HandoffPreflightFailure,
  ModelSelection,
  NonNegativeInt,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadExecutionRecord,
  ThreadId,
} from "@specweave-studio/contracts";

export const HANDOFF_PEER_PREFIX = "/api/handoff/v1";
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
});
export type ReplicateMeta = typeof ReplicateMeta.Type;
export const ReplicateResponse = Schema.Struct({ sequence: NonNegativeInt });
export type ReplicateResponse = typeof ReplicateResponse.Type;

export const PeerPreflightRequest = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
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
  leases: Schema.Array(Schema.Struct({ sourceThreadId: ThreadId, epoch: NonNegativeInt })).check(
    Schema.isMaxLength(500),
  ),
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

export type PeerPath = "negotiate" | "replicate" | "preflight" | "takeover" | "heartbeat";
export const PEER_PATHS: ReadonlySet<string> = new Set<PeerPath>([
  "negotiate",
  "replicate",
  "preflight",
  "takeover",
  "heartbeat",
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
