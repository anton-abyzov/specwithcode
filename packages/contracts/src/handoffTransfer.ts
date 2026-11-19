/**
 * The per-thread transfer record of a handoff. A thread is named by its
 * lineage (the machine it leaves, its id there and the epoch it is handed at),
 * has one execution owner, and moves under one operation id that both machines
 * persist: the source before it holds the thread, the destination before it
 * launches anything. Either machine can then answer for that operation after a
 * restart or a lost reply.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * The base capability of the transfer record. A machine that does not name it
 * is never a destination, and a later wire feature names its own capability:
 * this one says nothing about them.
 */
export const HANDOFF_V2_CAPABILITY = "handoff.v2";

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const HandoffCapabilities = Schema.Array(text(64)).check(Schema.isMaxLength(32));
export type HandoffCapabilities = typeof HandoffCapabilities.Type;

/** Whether a peer's advertised list names the transfer record. Absent means no. */
export function hasHandoffV2(capabilities: ReadonlyArray<string> | undefined): boolean {
  return capabilities?.includes(HANDOFF_V2_CAPABILITY) === true;
}

export const HandoffTransferOperationId = text(128);

/**
 * `pending` and `held` were never sent. `sent`, `accepted` and `unknown` wait
 * for the destination's answer: the thread starts nothing here. `resumed` and
 * `ready` continue on the destination. `stayed` never left; `failed` was
 * definitely not accepted, so the thread runs here again.
 */
export const HandoffTransferState = Schema.Literals([
  "pending",
  "held",
  "sent",
  "accepted",
  "resumed",
  "ready",
  "stayed",
  "failed",
  "unknown",
]);
export type HandoffTransferState = typeof HandoffTransferState.Type;

/** What the destination does on arrival: continue the interrupted run, or install the thread idle. */
export const HandoffTransferDisposition = Schema.Literals(["resume", "ready"]);
export type HandoffTransferDisposition = typeof HandoffTransferDisposition.Type;

export const HandoffTransferLineage = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  /** The epoch the destination takes the thread at. Each operation that was sent uses its own. */
  epoch: NonNegativeInt,
});
export type HandoffTransferLineage = typeof HandoffTransferLineage.Type;

/**
 * Who asked. `automatic` is the usage-limit rule, with the run and the usage
 * window that set it off when the caller knows them; `pull` is "Continue here"
 * asked on the destination.
 */
export const HandoffTransferTrigger = Schema.Struct({
  kind: Schema.Literals(["manual", "automatic", "pull"]),
  key: Schema.optional(text(512)),
  reason: Schema.optional(text(120)),
  /** When the usage window that set off an automatic move resets, or absent when unknown. */
  usageWindowKey: Schema.optional(text(120)),
});
export type HandoffTransferTrigger = typeof HandoffTransferTrigger.Type;

/** The destination's answer for one operation: the same for every repeat of it. */
export const HandoffTransferReceipt = Schema.Struct({
  threadId: ThreadId,
  projectId: Schema.optional(ProjectId),
  machineLabel: text(120),
  modelSelection: Schema.NullOr(ModelSelection),
  resumed: Schema.Boolean,
  notice: Schema.NullOr(text(500)),
});
export type HandoffTransferReceipt = typeof HandoffTransferReceipt.Type;

/** A machine that may have accepted a hold made before transfer records existed. */
export const HandoffTransferCandidate = Schema.Struct({
  environmentId: EnvironmentId,
  /** `fenced-at` waits for a second answer after the takeover timeout has passed. */
  verdict: Schema.Literals(["unasked", "fenced", "not-accepted"]),
  fencedAt: Schema.NullOr(IsoDateTime),
});
export type HandoffTransferCandidate = typeof HandoffTransferCandidate.Type;

/** The source's record of one thread's move. */
export const HandoffTransferRecord = Schema.Struct({
  operationId: HandoffTransferOperationId,
  batchId: Schema.NullOr(HandoffTransferOperationId),
  lineage: HandoffTransferLineage,
  projectId: ProjectId,
  /** Null only for a hold from before transfer records whose destination is not known. */
  targetEnvironmentId: Schema.NullOr(EnvironmentId),
  /** The checkpoint handed over; null until the thread has one. */
  sequence: Schema.NullOr(NonNegativeInt),
  disposition: HandoffTransferDisposition,
  state: HandoffTransferState,
  /** A hold found without a record: it stays held until every candidate proves it never accepted. */
  legacy: Schema.Boolean,
  candidates: Schema.Array(HandoffTransferCandidate),
  trigger: HandoffTransferTrigger,
  /** The takeover reason on the wire. */
  reason: text(40),
  modelSelection: Schema.NullOr(ModelSelection),
  receipt: Schema.NullOr(HandoffTransferReceipt),
  detail: Schema.NullOr(text(1000)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  sentAt: Schema.NullOr(IsoDateTime),
});
export type HandoffTransferRecord = typeof HandoffTransferRecord.Type;

/** The threads one request moves together, written before the first of them is held. */
export const HandoffTransferBatch = Schema.Struct({
  batchId: HandoffTransferOperationId,
  targetEnvironmentId: EnvironmentId,
  trigger: HandoffTransferTrigger,
  operationIds: Schema.Array(HandoffTransferOperationId),
  createdAt: IsoDateTime,
});
export type HandoffTransferBatch = typeof HandoffTransferBatch.Type;

/**
 * The destination's verdict for one lineage, written before it launches. The
 * first verdict is final: a repeat reads it, and nothing overwrites it.
 */
export const HandoffTransferAcceptance = Schema.Struct({
  lineage: HandoffTransferLineage,
  /** Null for a takeover from a machine that sends no operation id. */
  operationId: Schema.NullOr(HandoffTransferOperationId),
  sequence: Schema.NullOr(NonNegativeInt),
  verdict: Schema.Literals(["accepted", "not-accepted"]),
  receipt: Schema.NullOr(HandoffTransferReceipt),
  /** Set once the continuation was launched and recorded. */
  launched: Schema.Boolean,
  /** The takeover as it was asked, so a launch a restart cut is finished the same way. */
  reason: text(40),
  modelSelection: Schema.NullOr(ModelSelection),
  trigger: Schema.NullOr(HandoffTransferTrigger),
  detail: Schema.NullOr(text(1000)),
  at: IsoDateTime,
});
export type HandoffTransferAcceptance = typeof HandoffTransferAcceptance.Type;

export const HandoffTransferDocument = Schema.Struct({
  version: Schema.Literal(1),
  transfers: Schema.Record(Schema.String, HandoffTransferRecord),
  batches: Schema.Record(Schema.String, HandoffTransferBatch),
  acceptances: Schema.Record(Schema.String, HandoffTransferAcceptance),
});
export type HandoffTransferDocument = typeof HandoffTransferDocument.Type;

/** Finished rows: the thread is where it will stay for this operation. */
export function isHandoffTransferFinished(state: HandoffTransferState): boolean {
  return state === "resumed" || state === "ready" || state === "stayed" || state === "failed";
}
