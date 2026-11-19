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

/**
 * Named by a machine that starts a hand off by itself when a thread's track
 * is out there, and that answers such a start for the thread's own track only.
 * It says nothing about transfer records or plans, and they say nothing about
 * it: a machine that does not name it is never the target of an automatic
 * track start, and is never answered for one.
 */
export const HANDOFF_TRACK_START_CAPABILITY = "handoff.track-start";

/** Whether a peer's advertised list names the automatic track start. Absent means no. */
export function hasHandoffTrackStart(capabilities: ReadonlyArray<string> | undefined): boolean {
  return capabilities?.includes(HANDOFF_TRACK_START_CAPABILITY) === true;
}

/**
 * The batch's own wire additions: a takeover that names its disposition and
 * the revision of the context it hands over, and project folder work put into
 * the destination's working folder. A machine that does not name it takes no
 * batch: its rows read "Needs update" and nothing is held for it.
 */
export const HANDOFF_BATCH_CAPABILITY = "handoff.batch";

export function hasHandoffBatch(capabilities: ReadonlyArray<string> | undefined): boolean {
  return capabilities?.includes(HANDOFF_BATCH_CAPABILITY) === true;
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
  /**
   * The run an automatic move was admitted for, and how it was to arrive.
   * The source refuses the move before the hold when either no longer holds.
   */
  runId: Schema.optional(text(256)),
  disposition: Schema.optional(HandoffTransferDisposition),
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

/** The machine where a thread waits for the moved work's result, and the machines it can ask. */
export const HandoffTransferLauncher = Schema.Struct({
  environmentId: EnvironmentId,
  label: text(120),
  reachable: Schema.Array(EnvironmentId),
});
export type HandoffTransferLauncher = typeof HandoffTransferLauncher.Type;
/**
 * The revision of a thread's context a handoff carries: the checkpoint's
 * sequence and its commit. The destination takes the thread at exactly this
 * revision or refuses; it never takes "whatever arrived last".
 */
export const HandoffContextRevision = Schema.Struct({
  sequence: NonNegativeInt,
  commit: text(64),
});
export type HandoffContextRevision = typeof HandoffContextRevision.Type;

/**
 * What a batch says about one thread's takeover: the batch, what the
 * destination does on arrival, and the revision handed over. Both machines
 * keep it as it was first sent, so a repeat after a restart is the same ask.
 */
export const HandoffBatchEnvelope = Schema.Struct({
  batchId: HandoffTransferOperationId,
  disposition: HandoffTransferDisposition,
  context: HandoffContextRevision,
});
export type HandoffBatchEnvelope = typeof HandoffBatchEnvelope.Type;

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
  /**
   * Who the takeover names as waiting for the result, written with "sent" so a
   * repeat names the same machine. Null: nobody waits. Absent: not recorded
   * (the record was sent by a build from before this field).
   */
  launcher: Schema.optionalKey(Schema.NullOr(HandoffTransferLauncher)),
  /**
   * The thread was a review when it was sent: every repeat goes the way the
   * first send went. Absent from a record sent before this field.
   */
  review: Schema.optionalKey(Schema.Boolean),
  /**
   * Set for a move a batch sends to a destination that names the batch
   * capability: the takeover then carries the disposition and this revision.
   * Absent on a record from before batches.
   */
  context: Schema.optional(HandoffContextRevision),
});
export type HandoffTransferRecord = typeof HandoffTransferRecord.Type;

/** How a batch began: a person asked, or the usage-limit rule did. */
export const HandoffBatchStart = Schema.Literals(["manual", "automatic"]);
export type HandoffBatchStart = typeof HandoffBatchStart.Type;

/**
 * One row of a batch as the source keeps it. A thread row with an operation
 * reads its state from that thread's transfer record; a thread that never got
 * a record, and project folder work (which has no lineage), keep their own.
 */
export const HandoffBatchStoredRow = Schema.Struct({
  kind: Schema.Literals(["thread", "folder-work"]),
  /** The thread's id, or the project's for folder work. */
  id: text(256),
  title: text(500),
  projectId: Schema.NullOr(ProjectId),
  operationId: Schema.NullOr(HandoffTransferOperationId),
  disposition: Schema.NullOr(HandoffTransferDisposition),
  state: HandoffTransferState,
  detail: Schema.NullOr(text(1000)),
  /**
   * The thread on the destination, for a row with no record of its own: the
   * thread had moved there before this batch asked.
   */
  continuedThreadId: Schema.optional(Schema.NullOr(ThreadId)),
});
export type HandoffBatchStoredRow = typeof HandoffBatchStoredRow.Type;

/** The threads one request moves together, written before the first of them is held. */
export const HandoffTransferBatch = Schema.Struct({
  batchId: HandoffTransferOperationId,
  targetEnvironmentId: EnvironmentId,
  trigger: HandoffTransferTrigger,
  operationIds: Schema.Array(HandoffTransferOperationId),
  createdAt: IsoDateTime,
  // Written by a batch run (1390 T-11); absent on a batch from before it.
  start: Schema.optional(HandoffBatchStart),
  targetLabel: Schema.optional(text(120)),
  rows: Schema.optional(Schema.Array(HandoffBatchStoredRow).check(Schema.isMaxLength(200))),
  finishedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
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
  /** The batch's fields of the takeover that was accepted. Absent: it had none. */
  batch: Schema.optional(HandoffBatchEnvelope),
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

// The batch: one type for a manual and an automatic start

export const HANDOFF_BATCH_MAX_THREADS = 100;
export const HANDOFF_BATCH_MAX_PROJECTS = 20;

/**
 * What a batch is asked to move: threads, each with what the destination does
 * with it, and the project folder work of the projects named. There is no
 * field for a coordinator, a routine or project memory: a batch changes which
 * machine runs a thread and nothing else.
 */
export const HandoffBatchInput = Schema.Struct({
  destinationEnvironmentId: EnvironmentId,
  start: HandoffBatchStart,
  /** Absent means a person asked. An automatic start names the rule that set it off. */
  trigger: Schema.optional(HandoffTransferTrigger),
  threads: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      /** From the plan. Absent means the thread's own state decides, as a single move does. */
      disposition: Schema.optional(HandoffTransferDisposition),
      modelSelection: Schema.optional(ModelSelection),
    }),
  ).check(Schema.isMaxLength(HANDOFF_BATCH_MAX_THREADS)),
  /** Projects whose folder work goes along. Only a manual start carries any. */
  folderWork: Schema.optional(
    Schema.Array(ProjectId).check(Schema.isMaxLength(HANDOFF_BATCH_MAX_PROJECTS)),
  ),
});
export type HandoffBatchInput = typeof HandoffBatchInput.Type;

export const HandoffBatchRow = Schema.Struct({
  kind: Schema.Literals(["thread", "folder-work"]),
  id: text(256),
  title: text(500),
  projectId: Schema.NullOr(ProjectId),
  operationId: Schema.NullOr(HandoffTransferOperationId),
  disposition: Schema.NullOr(HandoffTransferDisposition),
  state: HandoffTransferState,
  /** "Resumed on {machine}", "Ready on {machine}", or why it stayed. */
  detail: Schema.NullOr(text(1000)),
  /** The revision the thread was handed over at, once it was sent. */
  context: Schema.NullOr(HandoffContextRevision),
  /** The thread on the destination, once it accepted. */
  continuedThreadId: Schema.NullOr(ThreadId),
});
export type HandoffBatchRow = typeof HandoffBatchRow.Type;

export const HandoffBatchRun = Schema.Struct({
  batchId: HandoffTransferOperationId,
  start: HandoffBatchStart,
  trigger: HandoffTransferTrigger,
  destination: Schema.Struct({ environmentId: EnvironmentId, label: text(120) }),
  rows: Schema.Array(HandoffBatchRow),
  startedAt: IsoDateTime,
  /** Null while a row still waits for the destination's answer. */
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type HandoffBatchRun = typeof HandoffBatchRun.Type;

export const HandoffBatchReadInput = Schema.Struct({
  /** Absent reads every batch this machine still has on record, newest first. */
  batchId: Schema.optional(HandoffTransferOperationId),
});
export type HandoffBatchReadInput = typeof HandoffBatchReadInput.Type;
