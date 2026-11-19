// @effect-diagnostics nodeBuiltinImport:off - operation ids come from node:crypto.
/**
 * Runs a thread's move under its transfer record (1390). The server owns the
 * run: a window that closes does not cut it, and a restart finds the record
 * and carries on with the same operation and the same destination.
 *
 * The order is fixed. The record is written, then the thread is held, its
 * turn stopped, the record marked sent, and only then is the takeover sent.
 * What the record says decides what may happen next:
 *
 * - never sent (`pending`, `held`): nothing left this machine, so the hold can
 *   be released here ("Resume here");
 * - sent with no answer (`sent`, `unknown`): the destination may run the
 *   thread, so nothing starts here and no other destination is tried; the same
 *   operation is sent again until the destination answers;
 * - a definite "not accepted": the hold is released and the epoch it used is
 *   never used again.
 *
 * A hold found without a record was made before records existed. It stays
 * held until every machine that could have accepted it says it did not.
 */
import * as NodeCrypto from "node:crypto";

import {
  type EnvironmentId,
  type HandOffInput,
  type HandOffResult,
  type HandoffCheckpoint,
  type HandoffContinueHereInput,
  HandoffModeError,
  type HandoffModeErrorCode,
  type HandoffPreflightFailure,
  type HandoffTransferCandidate,
  type HandoffTransferRecord,
  type HandoffTransferTrigger,
  isHandoffTransferFinished,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@specweave-studio/contracts";
import type * as KeyedLock from "@specweave-studio/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import type { HandoffPeerError } from "./handoffPeers.ts";
import { shouldResume } from "./handoffPreflight.ts";
import * as Resume from "./handoffResume.ts";
import { HandoffRefusal, type ReceiverCaller } from "./HandoffReceiver.ts";
import type { HandoffDocument, HandoffThreadRecord } from "./handoffState.ts";
import {
  arrivalOf,
  type HandoffTransferStoreShape,
  openTransfer,
  openTransfers,
  putTransfer,
  reverseMoveSuppressed,
  transitionTransfer,
} from "./HandoffTransferStore.ts";
import type {
  HeartbeatRequest,
  HeartbeatResponse,
  PeerPreflightResponse,
  TakeoverReason,
  TakeoverRequest,
  TakeoverResponse,
  TransferPullRequest,
  TransferStatusRequest,
  TransferStatusResponse,
} from "./handoffWire.ts";

/** A move a restart cut before it was sent carries on by itself only this long after it was asked. */
const UNSENT_REPLAY_WINDOW_MS = 15 * 60_000;

const TURN_DID_NOT_STOP = "Its turn did not stop in 45 seconds, so the thread stays here.";
const UNSENT_TOO_OLD =
  "The handoff was cut before anything was sent, so the thread stays here. Hand it off again to move it.";
const RESUMED_HERE = "Resumed here before anything was sent.";
const NO_MACHINE_ACCEPTED = "No machine accepted this handoff, so the thread runs here again.";
const LEGACY_HOLD_WAITS =
  "This thread was being handed off when SpecWithCode was updated. It stays paused until every machine that holds a copy confirms it did not continue it.";
const NOT_RECORDED =
  "This machine could not save how the handoff ended, so the thread stays paused until it can.";
const needsUpdateWaits = (label: string) =>
  `${label} needs an update before it can say whether it continued this thread. The thread stays paused until then.`;
const ARRIVED_FOR_THIS_RUN =
  "This thread arrived from that machine for this run, so it is not sent back automatically.";
const BATCH_CUT = "The handoff was cut before this thread was held, so it stays here.";

const failed = (code: HandoffModeErrorCode, message: string) =>
  new HandoffModeError({ code, message });

type PeerFailure = HandoffPeerError | HandoffRefusal;

/** Did the destination itself answer no? A lost answer or a failure on this machine did not. */
const destinationRefused = (error: PeerFailure) =>
  error._tag === "HandoffRefusal"
    ? error.uncertain !== true
    : !error.uncertain && error.local !== true && error.code !== "unreachable";

/** The answer never came, or the destination says it may have acted. */
const inDoubt = (error: PeerFailure) => error.uncertain === true;

export interface TransferRunnerDeps {
  readonly self: EnvironmentId;
  readonly selfLabel: string;
  readonly store: HandoffTransferStoreShape;
  readonly locks: KeyedLock.KeyedLock<string>;
  readonly nowIso: Effect.Effect<string>;
  readonly document: Effect.Effect<HandoffDocument, HandoffModeError>;
  readonly updateRecord: (
    threadId: ThreadId,
    change: (record: HandoffThreadRecord) => HandoffThreadRecord,
  ) => Effect.Effect<HandoffThreadRecord | undefined, HandoffModeError>;
  readonly shellOf: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell, HandoffModeError>;
  /** A fresh checkpoint, here only; null when the thread has none. */
  readonly localCheckpoint: (threadId: ThreadId) => Effect.Effect<HandoffCheckpoint | null>;
  /** A fresh checkpoint replicated to the destination. */
  readonly prepare: (
    threadId: ThreadId,
    destination: EnvironmentId,
  ) => Effect.Effect<
    { readonly shell: OrchestrationV2ThreadShell; readonly checkpoint: HandoffCheckpoint },
    HandoffModeError
  >;
  /**
   * Does that machine keep transfer records? Asked before a takeover is sent
   * again; it fails when the machine does not answer.
   */
  readonly keepsRecords: (destination: EnvironmentId) => Effect.Effect<boolean, HandoffModeError>;
  readonly peerPreflight: (
    destination: EnvironmentId,
    threads: ReadonlyArray<{
      readonly shell: OrchestrationV2ThreadShell;
      readonly sequence: number;
      readonly modelSelection: ModelSelection | null;
    }>,
  ) => Effect.Effect<PeerPreflightResponse, HandoffModeError>;
  readonly preflightError: (failures: ReadonlyArray<HandoffPreflightFailure>) => HandoffModeError;
  /** True once the turn has ended; false when it still runs after the wait. */
  readonly interruptRun: (
    shell: OrchestrationV2ThreadShell,
    reason: string,
  ) => Effect.Effect<boolean>;
  readonly resumeTurn: (shell: OrchestrationV2ThreadShell) => Effect.Effect<void>;
  readonly sendTakeover: (
    destination: EnvironmentId,
    request: TakeoverRequest,
  ) => Effect.Effect<TakeoverResponse, PeerFailure>;
  readonly fenceSource: (
    shell: OrchestrationV2ThreadShell,
    destination: EnvironmentId,
    response: TakeoverResponse,
    epoch: number,
    reason: TakeoverReason,
  ) => Effect.Effect<void>;
  readonly transferStatus: (
    destination: EnvironmentId,
    request: TransferStatusRequest,
  ) => Effect.Effect<TransferStatusResponse, PeerFailure>;
  readonly heartbeat: (
    destination: EnvironmentId,
    request: HeartbeatRequest,
  ) => Effect.Effect<HeartbeatResponse, HandoffPeerError>;
  readonly transferPull: (
    source: EnvironmentId,
    request: TransferPullRequest,
  ) => Effect.Effect<TakeoverResponse, HandoffPeerError>;
}

export interface TransferStart {
  readonly trigger?: HandoffTransferTrigger | undefined;
  /** A record a batch wrote for this thread before its first hold. */
  readonly operationId?: string | undefined;
}

const MANUAL: HandoffTransferTrigger = { kind: "manual" };

export function makeTransferRunner(deps: TransferRunnerDeps) {
  const { self, selfLabel, store } = deps;
  /** Threads whose move runs in this process now; a tick leaves them alone. */
  const running = new Set<string>();
  /** Records a batch of this process wrote and has not reached yet; a tick leaves them alone. */
  const planning = new Set<string>();

  const recordOf = (threadId: ThreadId) =>
    deps.document.pipe(Effect.map((document) => document.threads[threadId]));

  const patch = (
    operationId: string,
    from: ReadonlyArray<HandoffTransferRecord["state"]>,
    change: Partial<HandoffTransferRecord> & { readonly state: HandoffTransferRecord["state"] },
  ) =>
    Effect.flatMap(deps.nowIso, (now) =>
      store.update((document) => transitionTransfer(document, operationId, from, change, now)),
    );

  /**
   * Ends a record, and says whether that was written. A hold is given back
   * only after it was: a record left open would be sent again later.
   */
  const finish = (
    operationId: string,
    state: "stayed" | "failed" | "resumed" | "ready",
    detail: string | null,
    receipt: TakeoverResponse | null = null,
  ) =>
    patch(operationId, ["pending", "held", "sent", "accepted", "unknown"], {
      state,
      detail: detail === null ? null : detail.slice(0, 1000),
      ...(receipt === null ? {} : { receipt }),
    }).pipe(Effect.match({ onFailure: () => false, onSuccess: (written) => written !== null }));

  /** Gives back a hold nothing was sent under: the epoch was never used. */
  const releaseUnsent = (threadId: ThreadId, lastError: string | null) =>
    deps
      .updateRecord(threadId, (record) => ({
        ...record,
        lease:
          record.lease === null || record.lease.state !== "handing-off"
            ? record.lease
            : { ...record.lease, state: "active" },
        pendingTakeover: null,
        lastError,
      }))
      .pipe(Effect.ignore);

  /**
   * Gives back a hold whose takeover was definitely not accepted. The epoch it
   * was sent at is used up: the next move takes a newer one, so a late copy of
   * this takeover is stale wherever it lands.
   */
  const releaseRefused = (threadId: ThreadId, epoch: number, lastError: string | null) =>
    deps
      .updateRecord(threadId, (record) => ({
        ...record,
        lease:
          record.lease === null
            ? null
            : {
                ...record.lease,
                state: "active",
                epoch: Math.max(record.lease.epoch, epoch),
              },
        pendingTakeover: null,
        lastError,
      }))
      .pipe(Effect.ignore);

  const result = (destination: EnvironmentId, response: TakeoverResponse): HandOffResult => ({
    environmentId: destination,
    machineLabel: response.machineLabel,
    threadId: response.threadId,
    modelSelection: response.modelSelection,
    notice: response.notice,
  });

  const requestOf = (record: HandoffTransferRecord): TakeoverRequest => ({
    sourceEnvironmentId: self,
    sourceThreadId: record.lineage.sourceThreadId,
    epoch: record.lineage.epoch,
    sequence: record.sequence ?? 0,
    reason: record.reason as TakeoverReason,
    modelSelection: record.modelSelection,
    operationId: record.operationId,
    trigger: record.trigger,
  });

  /**
   * Sends a record's takeover and settles it. Called for the first send and
   * for every repeat: the destination answers a repeat of an operation it
   * accepted with the same receipt. `first` is the send right after the hold:
   * a failure on this machine then means nothing left it.
   */
  const dispatch = (
    record: HandoffTransferRecord,
    destination: EnvironmentId,
    shell: OrchestrationV2ThreadShell,
    first: boolean,
    onRefused: Effect.Effect<void>,
  ): Effect.Effect<TakeoverResponse, HandoffModeError> =>
    Effect.gen(function* () {
      const threadId = record.lineage.sourceThreadId;
      const epoch = record.lineage.epoch;
      const answer = yield* deps.sendTakeover(destination, requestOf(record)).pipe(Effect.result);
      let response = answer._tag === "Success" ? answer.success : null;
      const error = answer._tag === "Failure" ? answer.failure : null;
      const neverLeft =
        first && error?._tag === "HandoffPeerError" && error.local === true && !error.uncertain;
      let open = error !== null && !neverLeft && (inDoubt(error) || !destinationRefused(error));
      if (error !== null && !open && !neverLeft && (error.code === "fenced" || !first)) {
        // The destination holds a newer epoch of this thread, or it refuses a
        // repeat: it may have accepted the first send, and a refusal given
        // before its records were read (it is updating, the grant was withdrawn)
        // says nothing about that. It says which: it continued the thread, or
        // this operation is not accepted for good.
        const status = yield* deps
          .transferStatus(destination, {
            sourceEnvironmentId: self,
            sourceThreadId: threadId,
            epoch,
            operationId: record.operationId,
          })
          .pipe(Effect.result);
        if (status._tag === "Success") {
          if (status.success.status === "accepted") response = status.success.receipt;
        } else {
          open = true;
          const failure = status.failure;
          if (
            record.legacy &&
            failure._tag === "HandoffPeerError" &&
            failure.needsUpdate === true
          ) {
            // That machine keeps no records. From now on it is asked the way a
            // hold with nothing on file is: by a heartbeat at this epoch, twice.
            yield* patch(record.operationId, ["sent", "unknown", "accepted"], {
              state: "unknown",
              sequence: null,
              candidates: [{ environmentId: destination, verdict: "unasked", fencedAt: null }],
            }).pipe(Effect.ignore);
            return yield* failed(error.code, error.message);
          }
        }
      }
      if (response !== null) {
        yield* finish(record.operationId, response.resumed ? "resumed" : "ready", null, response);
        yield* deps.fenceSource(
          shell,
          destination,
          response,
          epoch,
          record.reason as TakeoverReason,
        );
        return response;
      }
      const refusal = error ?? failed("failed", "The destination did not accept the handoff.");
      if (open) {
        // No definite answer: nothing starts here, and no other destination is tried.
        yield* patch(record.operationId, ["sent", "unknown", "accepted"], {
          state: "unknown",
          detail: refusal.message.slice(0, 1000),
        }).pipe(Effect.ignore);
        yield* deps
          .updateRecord(threadId, (current) => ({
            ...current,
            lastError: `${refusal.message} This thread stays paused until that machine answers.`,
          }))
          .pipe(Effect.ignore);
        return yield* failed(refusal.code, refusal.message);
      }
      const grant =
        error !== null && destinationRefused(error) && error.check === "grant"
          ? `Not moved: ${error.message}`.slice(0, 1000)
          : null;
      if (!(yield* finish(record.operationId, "failed", grant ?? refusal.message))) {
        // Still open on file, so it will be sent again: the thread stays held.
        yield* deps
          .updateRecord(threadId, (current) => ({ ...current, lastError: NOT_RECORDED }))
          .pipe(Effect.ignore);
        return yield* failed(refusal.code, refusal.message);
      }
      yield* releaseRefused(threadId, epoch, grant);
      yield* onRefused;
      return yield* failed(refusal.code, refusal.message);
    });

  const adoptLegacy = (threadId: ThreadId, held: HandoffThreadRecord) =>
    Effect.gen(function* () {
      const now = yield* deps.nowIso;
      const pending = held.pendingTakeover ?? null;
      // This machine too: a move to another model here is taken over by its own receiver.
      const candidates: Array<HandoffTransferCandidate> = [
        ...new Set([...held.replicas.map((replica) => replica.environmentId), self]),
      ].map((environmentId) => ({ environmentId, verdict: "unasked", fencedAt: null }));
      const record: HandoffTransferRecord = {
        operationId: `legacy:${NodeCrypto.randomUUID()}`,
        batchId: null,
        lineage: {
          sourceEnvironmentId: self,
          sourceThreadId: threadId,
          epoch: pending?.request.epoch ?? (held.lease?.epoch ?? 0) + 1,
        },
        projectId: held.projectId,
        targetEnvironmentId:
          pending === null ? null : (pending.destinationEnvironmentId as EnvironmentId),
        sequence: pending?.request.sequence ?? null,
        disposition: "resume",
        // A hold from before records may have been sent: it is never "held".
        state: "unknown",
        legacy: true,
        candidates,
        trigger: MANUAL,
        reason: pending?.request.reason ?? "handoff",
        modelSelection: pending?.request.modelSelection ?? null,
        receipt: null,
        detail: LEGACY_HOLD_WAITS,
        createdAt: now,
        updatedAt: now,
        sentAt: null,
      };
      return yield* store.update((document) => {
        const open = openTransfer(document, self, threadId);
        return open === undefined
          ? ([record, putTransfer(document, record)] as const)
          : ([open, document] as const);
      });
    });

  /**
   * A hold from before records, with no request on file: ask each machine that
   * holds a copy. One that keeps records writes "not accepted" before saying
   * it. One that does not is told the epoch in a heartbeat, which makes a late
   * takeover stale there, and is asked whether it continued the thread. Its
   * "yes" fences the thread here. Its "no" proves nothing: that release
   * launches before it writes that it continued, so the hold waits until that
   * machine is updated and can answer for the transfer.
   */
  const settleLegacy = (
    record: HandoffTransferRecord,
    shell: OrchestrationV2ThreadShell,
  ): Effect.Effect<TakeoverResponse | null, HandoffModeError> =>
    Effect.gen(function* () {
      const threadId = record.lineage.sourceThreadId;
      const epoch = record.lineage.epoch;
      const nowText = yield* deps.nowIso;
      const next: Array<HandoffTransferCandidate> = [];
      let outdated: string | null = null;
      for (const candidate of record.candidates) {
        if (candidate.verdict === "not-accepted") {
          next.push(candidate);
          continue;
        }
        const peer = candidate.environmentId;
        const status = yield* deps
          .transferStatus(peer, {
            sourceEnvironmentId: self,
            sourceThreadId: threadId,
            epoch,
            operationId: null,
          })
          .pipe(Effect.result);
        if (status._tag === "Success") {
          const receipt = status.success.receipt;
          if (status.success.status === "accepted" && receipt !== null) {
            yield* finish(record.operationId, receipt.resumed ? "resumed" : "ready", null, receipt);
            yield* deps.fenceSource(shell, peer, receipt, epoch, "handoff");
            return receipt;
          }
          next.push({ ...candidate, verdict: "not-accepted" });
          continue;
        }
        const error = status.failure;
        if (error._tag !== "HandoffPeerError" || error.needsUpdate !== true) {
          // No answer from this machine: nothing is proven.
          next.push(candidate);
          continue;
        }
        const beat = yield* deps
          .heartbeat(peer, {
            sourceEnvironmentId: self,
            sourceLabel: selfLabel.slice(0, 120),
            leases: [{ sourceThreadId: threadId, epoch }],
          })
          .pipe(Effect.result);
        if (beat._tag !== "Success") {
          next.push(candidate);
          continue;
        }
        const continued = beat.success.continued.find((entry) => entry.sourceThreadId === threadId);
        if (continued !== undefined) {
          const receipt: TakeoverResponse = {
            threadId: continued.threadId,
            machineLabel: beat.success.machineLabel,
            modelSelection: null,
            resumed: false,
            notice: null,
          };
          yield* finish(record.operationId, "resumed", null, receipt);
          yield* deps.fenceSource(shell, peer, receipt, continued.epoch, "handoff");
          return receipt;
        }
        outdated = beat.success.machineLabel;
        next.push(
          candidate.verdict === "fenced"
            ? candidate
            : { ...candidate, verdict: "fenced", fencedAt: nowText },
        );
      }
      const waits = outdated === null ? LEGACY_HOLD_WAITS : needsUpdateWaits(outdated);
      if (next.every((candidate) => candidate.verdict === "not-accepted")) {
        if (yield* finish(record.operationId, "failed", NO_MACHINE_ACCEPTED)) {
          yield* releaseRefused(threadId, epoch, null);
          return null;
        }
      }
      yield* patch(record.operationId, ["unknown"], { state: "unknown", candidates: next }).pipe(
        Effect.ignore,
      );
      yield* deps
        .updateRecord(threadId, (current) => ({ ...current, lastError: waits }))
        .pipe(Effect.ignore);
      return null;
    });

  /** Carries on with an open record: the same operation, the same destination. */
  const settle = (
    record: HandoffTransferRecord,
  ): Effect.Effect<TakeoverResponse | null, HandoffModeError> =>
    Effect.gen(function* () {
      const threadId = record.lineage.sourceThreadId;
      const shell = yield* deps.shellOf(threadId);
      if (record.state === "pending" || record.state === "held") {
        const destination = record.targetEnvironmentId;
        if (destination === null) return null;
        return (yield* run(
          {
            threadId,
            destinationEnvironmentId: destination,
            ...(record.modelSelection === null ? {} : { modelSelection: record.modelSelection }),
          },
          record.reason as TakeoverReason,
          { trigger: record.trigger, operationId: record.operationId },
          true,
        )).receipt;
      }
      if (record.targetEnvironmentId === null || record.sequence === null) {
        return yield* settleLegacy(record, shell);
      }
      const destination = record.targetEnvironmentId;
      // A takeover goes only to a machine that keeps transfer records, the repeat
      // as much as the first send: one that does not would start the thread
      // without anything on file to answer for it. No answer leaves the hold as it is.
      const keeps = yield* deps.keepsRecords(destination).pipe(Effect.result);
      if (keeps._tag === "Failure") {
        yield* patch(record.operationId, ["sent", "unknown", "accepted"], {
          state: "unknown",
          detail: keeps.failure.message.slice(0, 1000),
        }).pipe(Effect.ignore);
        return null;
      }
      if (!keeps.success) {
        // It may confirm a continuation it has; it is never asked to make one.
        const asked = yield* patch(record.operationId, ["sent", "unknown", "accepted"], {
          state: "unknown",
          sequence: null,
          candidates: [{ environmentId: destination, verdict: "unasked", fencedAt: null }],
        });
        return asked === null ? null : yield* settleLegacy(asked, shell);
      }
      return yield* dispatch(record, destination, shell, false, Effect.void);
    });

  /** One thread's move, start to finish, under the thread's lock. */
  const run = (
    input: HandOffInput,
    reason: TakeoverReason,
    start: TransferStart,
    resuming: boolean,
  ): Effect.Effect<
    { readonly result: HandOffResult; readonly receipt: TakeoverResponse | null },
    HandoffModeError
  > =>
    Effect.gen(function* () {
      const destination = input.destinationEnvironmentId;
      const threadId = input.threadId;
      const trigger = start.trigger ?? MANUAL;
      if (start.operationId !== undefined) planning.delete(start.operationId);
      const current = yield* recordOf(threadId);
      const transfers = yield* store.read;
      const planned =
        start.operationId === undefined ? undefined : transfers.transfers[start.operationId];
      if (planned !== undefined && isHandoffTransferFinished(planned.state)) {
        // Resumed here, or too old, while this move waited its turn.
        return yield* failed("busy", planned.detail ?? RESUMED_HERE);
      }
      /**
       * Ends a record a batch wrote for a thread that then never left. A move
       * carried on after a restart also gives back its hold: nothing was sent.
       */
      const stays = (error: HandoffModeError) =>
        planned === undefined
          ? Effect.void
          : finish(planned.operationId, "stayed", error.message).pipe(
              Effect.andThen((ended) =>
                resuming && ended ? releaseUnsent(threadId, error.message) : Effect.void,
              ),
            );
      if (current?.continuedOn != null) {
        if (current.continuedOn.environmentId === destination) {
          // A retry after a timeout: the first move already happened.
          return {
            result: {
              environmentId: destination,
              machineLabel: current.continuedOn.machineLabel,
              threadId: current.continuedOn.threadId,
              modelSelection: null,
              notice: `Already continued on ${current.continuedOn.machineLabel}.`,
            },
            receipt: null,
          };
        }
        const error = failed(
          "fenced",
          `This thread already continues on ${current.continuedOn.machineLabel}.`,
        );
        yield* stays(error);
        return yield* error;
      }
      const open = openTransfer(transfers, self, threadId);
      if (!resuming && current?.lease?.state === "handing-off") {
        const record = open ?? (yield* adoptLegacy(threadId, current));
        if (record.targetEnvironmentId !== destination) {
          // An open move is never abandoned for another destination.
          return yield* failed(
            "busy",
            "A handoff of this thread did not finish; it stays paused until the other machine answers.",
          );
        }
        const receipt = yield* settle(record);
        if (receipt === null) return yield* failed("busy", record.detail ?? LEGACY_HOLD_WAITS);
        return { result: result(destination, receipt), receipt };
      }
      if (!resuming && open !== undefined && open.operationId !== start.operationId) {
        if (open.state !== "pending") {
          return yield* failed(
            "busy",
            "A handoff of this thread did not finish; it stays paused until the other machine answers.",
          );
        }
        // A record written for a move that never held the thread gives way to this one.
        yield* finish(open.operationId, "stayed", UNSENT_TOO_OLD);
      }
      if (destination === self && input.modelSelection === undefined) {
        const error = failed(
          "invalid",
          "Pick another machine, or another model to continue on this machine.",
        );
        yield* stays(error);
        return yield* error;
      }
      if (
        reverseMoveSuppressed({
          arrival: arrivalOf(transfers, threadId),
          destinationEnvironmentId: destination,
          trigger,
          runsSinceArrival: Object.keys(current?.runEpochs ?? {}).length,
          now: yield* Clock.currentTimeMillis,
        })
      ) {
        const error = failed("invalid", ARRIVED_FOR_THIS_RUN);
        yield* stays(error);
        return yield* error;
      }
      const modelSelection = input.modelSelection ?? null;

      // 1. Replicate and preflight: every refusal comes before the hold, so no turn stops for it.
      const first = yield* deps.prepare(threadId, destination).pipe(Effect.tapError(stays));
      if (Resume.hasUnsettledChild(first.checkpoint)) {
        const error = failed("failed", Resume.UNSETTLED_CHILD_REFUSAL);
        yield* stays(error);
        return yield* error;
      }
      const checked = yield* deps
        .peerPreflight(destination, [
          { shell: first.shell, sequence: first.checkpoint.sequence, modelSelection },
        ])
        .pipe(Effect.tapError(stays));
      const failures = checked.results[0]?.failures ?? [];
      if (failures.length > 0) {
        const error = deps.preflightError(failures);
        yield* stays(error);
        return yield* error;
      }

      // 2. The record, before the hold: operation, destination, checkpoint, disposition.
      const now = yield* deps.nowIso;
      const operationId = planned?.operationId ?? NodeCrypto.randomUUID();
      const written: HandoffTransferRecord = {
        operationId,
        batchId: planned?.batchId ?? null,
        lineage: {
          sourceEnvironmentId: self,
          sourceThreadId: threadId,
          epoch: (current?.lease?.epoch ?? 0) + 1,
        },
        projectId: first.shell.projectId,
        targetEnvironmentId: destination,
        sequence: first.checkpoint.sequence,
        disposition:
          first.shell.activeRunId !== null || shouldResume(first.checkpoint.runEnding)
            ? "resume"
            : "ready",
        state: planned?.state === "held" ? "held" : "pending",
        legacy: false,
        candidates: [],
        trigger,
        reason,
        modelSelection,
        receipt: null,
        detail: null,
        createdAt: planned?.createdAt ?? now,
        updatedAt: now,
        sentAt: null,
      };
      const recorded = yield* store.update((document) => {
        const present = document.transfers[operationId];
        // A record that ended meanwhile is never opened again.
        if (present !== undefined && isHandoffTransferFinished(present.state)) {
          return [false, document] as const;
        }
        return [true, putTransfer(document, written)] as const;
      });
      if (!recorded) return yield* failed("busy", RESUMED_HERE);

      // 3. Hold the thread: no new turn starts, a running one stops.
      const held = yield* deps
        .updateRecord(threadId, (record) => ({
          ...record,
          lease: {
            holderEnvironmentId: self,
            holderLabel: selfLabel,
            holderThreadId: threadId,
            epoch: record.lease?.epoch ?? 0,
            renewedAt: now,
            state: "handing-off",
          },
          pendingTakeover: null,
        }))
        .pipe(Effect.tapError((error) => finish(operationId, "stayed", error.message)));
      const epoch = (held?.lease?.epoch ?? 0) + 1;
      const holding = yield* patch(operationId, ["pending", "held"], {
        state: "held",
        lineage: { ...written.lineage, epoch },
      });
      if (holding === null) {
        yield* releaseUnsent(threadId, null);
        return yield* failed("busy", RESUMED_HERE);
      }
      /** Nothing was sent: the thread is given back, and the record says why it stayed. */
      const staysHeld = (message: string | null, detail: string) =>
        finish(operationId, "stayed", detail).pipe(
          Effect.andThen((ended) => (ended ? releaseUnsent(threadId, message) : Effect.void)),
        );
      // Read the run after the hold: a turn that started before it is the one to stop.
      const heldShell = yield* deps
        .shellOf(threadId)
        .pipe(Effect.tapError((error) => staysHeld(null, error.message)));
      let checkpoint = first.checkpoint;
      const resume = deps.resumeTurn(heldShell);
      if (heldShell.activeRunId !== null) {
        yield* deps
          .updateRecord(threadId, (record) => ({
            ...record,
            fencedBy: reason === "sleep" ? "sleep" : "handoff",
          }))
          .pipe(Effect.ignore);
        const stopped = yield* deps.interruptRun(
          heldShell,
          `Handing this thread to ${checked.machineLabel}.`,
        );
        if (!stopped) {
          // The destination must never start the next turn while this one still runs.
          yield* staysHeld(TURN_DID_NOT_STOP, TURN_DID_NOT_STOP);
          return yield* failed("busy", TURN_DID_NOT_STOP);
        }
        const again = yield* deps.prepare(threadId, destination).pipe(
          Effect.tapError((error) => {
            const message =
              `The handoff stopped the running turn but could not send its last checkpoint: ${error.message} The turn continues here; hand it off again to move it.`.slice(
                0,
                1000,
              );
            return staysHeld(message, message).pipe(Effect.andThen(resume));
          }),
        );
        checkpoint = again.checkpoint;
      }
      if (Resume.hasUnsettledChild(checkpoint)) {
        yield* staysHeld(null, Resume.UNSETTLED_CHILD_REFUSAL).pipe(Effect.andThen(resume));
        return yield* failed("failed", Resume.UNSETTLED_CHILD_REFUSAL);
      }

      // 4. "Sent" is on record before anything is sent. It and "Resume here"
      // start from the same state, so exactly one of them applies.
      const sent = yield* patch(operationId, ["held"], {
        state: "sent",
        sequence: checkpoint.sequence,
        sentAt: yield* deps.nowIso,
      });
      if (sent === null) return yield* failed("busy", RESUMED_HERE);
      yield* deps
        .updateRecord(threadId, (record) => ({
          ...record,
          pendingTakeover: { destinationEnvironmentId: destination, request: requestOf(sent) },
        }))
        .pipe(Effect.ignore);

      // 5. The destination takes over at the next epoch.
      const response = yield* dispatch(sent, destination, first.shell, true, resume);
      return { result: result(destination, response), receipt: response };
    });

  /**
   * Runs `effect` for a thread in a fiber of this server, not of the caller:
   * a caller that goes away (a closed window) stops waiting and stops nothing.
   */
  const owned = <A>(threadId: ThreadId, effect: Effect.Effect<A, HandoffModeError>) =>
    deps.locks
      .withLock(
        threadId,
        Effect.suspend(() => {
          running.add(threadId);
          return effect;
        }).pipe(Effect.ensuring(Effect.sync(() => running.delete(threadId)))),
      )
      .pipe(Effect.forkDetach, Effect.flatMap(Fiber.join));

  const handOff = (input: HandOffInput, reason: TakeoverReason, start: TransferStart = {}) =>
    owned(input.threadId, run(input, reason, start, false)).pipe(
      Effect.map((moved) => moved.result),
    );

  /**
   * Before the first hold of a batch: one record per thread, with its
   * operation id, destination, checkpoint and disposition.
   */
  const planBatch = (
    threadIds: ReadonlyArray<ThreadId>,
    destination: EnvironmentId,
    reason: TakeoverReason,
    trigger: HandoffTransferTrigger = MANUAL,
  ): Effect.Effect<ReadonlyMap<ThreadId, string>, HandoffModeError> =>
    Effect.gen(function* () {
      const document = yield* deps.document;
      const now = yield* deps.nowIso;
      const batchId = NodeCrypto.randomUUID();
      const records: Array<HandoffTransferRecord> = [];
      for (const threadId of threadIds) {
        const record = document.threads[threadId];
        if (record === undefined || record.continuedOn !== null) continue;
        if (record.lease?.state === "handing-off") continue;
        const shell = yield* deps.shellOf(threadId).pipe(Effect.option);
        if (shell._tag === "None") continue;
        const checkpoint = (yield* deps.localCheckpoint(threadId)) ?? record.checkpoint;
        records.push({
          operationId: NodeCrypto.randomUUID(),
          batchId,
          lineage: {
            sourceEnvironmentId: self,
            sourceThreadId: threadId,
            epoch: (record.lease?.epoch ?? 0) + 1,
          },
          projectId: record.projectId,
          targetEnvironmentId: destination,
          sequence: checkpoint?.sequence ?? null,
          disposition:
            shell.value.activeRunId !== null ||
            (checkpoint !== null && shouldResume(checkpoint.runEnding))
              ? "resume"
              : "ready",
          state: "pending",
          legacy: false,
          candidates: [],
          trigger,
          reason,
          modelSelection: null,
          receipt: null,
          detail: null,
          createdAt: now,
          updatedAt: now,
          sentAt: null,
        });
      }
      return yield* store.update((current) => {
        // A thread with a move still open keeps that move.
        const fresh = records.filter(
          (record) => openTransfer(current, self, record.lineage.sourceThreadId) === undefined,
        );
        if (fresh.length === 0) return [new Map<ThreadId, string>(), current] as const;
        const next = fresh.reduce(putTransfer, {
          ...current,
          batches: {
            ...current.batches,
            [batchId]: {
              batchId,
              targetEnvironmentId: destination,
              trigger,
              operationIds: fresh.map((record) => record.operationId),
              createdAt: now,
            },
          },
        });
        for (const record of fresh) planning.add(record.operationId);
        return [
          new Map(fresh.map((record) => [record.lineage.sourceThreadId, record.operationId])),
          next,
        ] as const;
      });
    });

  /** The batch is over: a record it wrote and never reached held nothing, so it ends as stayed. */
  const endBatch = (planned: ReadonlyMap<ThreadId, string>) =>
    Effect.gen(function* () {
      for (const operationId of planned.values()) {
        if (!planning.delete(operationId)) continue;
        yield* patch(operationId, ["pending"], { state: "stayed", detail: BATCH_CUT }).pipe(
          Effect.ignore,
        );
      }
    });

  /** "Resume here": releases a hold nothing was sent under. A sent one is never released by hand. */
  const resumeHere = (threadId: ThreadId): Effect.Effect<boolean, HandoffModeError> =>
    // A move that runs in this process now is not stuck: it ends by itself.
    running.has(threadId)
      ? Effect.succeed(false)
      : owned(
          threadId,
          Effect.gen(function* () {
            const open = openTransfer(yield* store.read, self, threadId);
            if (open === undefined) return false;
            const released = yield* patch(open.operationId, ["pending", "held"], {
              state: "stayed",
              detail: RESUMED_HERE,
            });
            if (released === null) return false;
            planning.delete(open.operationId);
            yield* releaseUnsent(threadId, null);
            return true;
          }),
        );

  const resumeUnsent = Effect.gen(function* () {
    for (const record of openTransfers(yield* store.read, self)) {
      if (record.state !== "pending" && record.state !== "held") continue;
      yield* resumeHere(record.lineage.sourceThreadId);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Handoff could not release its unsent holds", { cause }),
    ),
  );

  /**
   * After a start, and on every lease tick: holds from before records are
   * adopted, and every open record is carried on. Nothing here picks a new
   * destination, and nothing is released without a definite answer.
   */
  const reconcile = Effect.gen(function* () {
    const document = yield* deps.document;
    for (const [id, listed] of Object.entries(document.threads)) {
      if (listed.continuedOn !== null || listed.lease?.state !== "handing-off") continue;
      if (listed.lease.holderEnvironmentId !== self || running.has(id)) continue;
      const threadId = id as ThreadId;
      yield* owned(
        threadId,
        Effect.gen(function* () {
          // Read again under the lock: a move that just ended leaves nothing to adopt.
          const record = yield* recordOf(threadId);
          if (record === undefined || record.continuedOn !== null) return;
          if (record.lease?.state !== "handing-off") return;
          const transfers = yield* store.read;
          if (openTransfer(transfers, self, threadId) !== undefined) return;
          // A record that ended just before a stop that kept the hold: finish the release.
          const epoch = record.lease.epoch + 1;
          const ended = Object.values(transfers.transfers)
            .filter(
              (entry) =>
                entry.lineage.sourceEnvironmentId === self &&
                entry.lineage.sourceThreadId === threadId &&
                entry.lineage.epoch === epoch,
            )
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
          if (ended?.state === "stayed") return yield* releaseUnsent(threadId, ended.detail);
          if (ended?.state === "failed") return yield* releaseRefused(threadId, epoch, null);
          yield* adoptLegacy(threadId, record);
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logInfo("Handoff could not adopt an old hold", { threadId, cause }),
        ),
      );
    }
    const now = yield* Clock.currentTimeMillis;
    for (const listed of openTransfers(yield* store.read, self)) {
      const threadId = listed.lineage.sourceThreadId;
      if (running.has(threadId) || planning.has(listed.operationId)) continue;
      yield* owned(
        threadId,
        Effect.gen(function* () {
          // Read again under the lock: a move that just ended leaves nothing to do.
          const record = (yield* store.read).transfers[listed.operationId];
          if (record === undefined) return;
          const unsent = record.state === "pending" || record.state === "held";
          if (!unsent && record.state !== "sent" && record.state !== "unknown") return;
          const held = (yield* recordOf(threadId))?.lease?.state === "handing-off";
          if (unsent && !held) {
            // Written for a batch that stopped before it held this thread.
            yield* finish(record.operationId, "stayed", BATCH_CUT);
            return;
          }
          if (unsent && now - Date.parse(record.createdAt) > UNSENT_REPLAY_WINDOW_MS) {
            if (yield* finish(record.operationId, "stayed", UNSENT_TOO_OLD)) {
              yield* releaseUnsent(threadId, UNSENT_TOO_OLD);
            }
            return;
          }
          yield* settle(record);
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logInfo("Handoff carried on with an open transfer", { threadId, cause }),
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Handoff could not reconcile its transfers", { cause }),
    ),
  );

  /**
   * "Continue here" on a machine that holds a copy: it asks the machine that
   * runs the thread to hand it over, and takes nothing by itself. A source
   * that does not answer may still be running the thread, so the copy stays
   * readable and nothing starts here.
   */
  const pull = (input: HandoffContinueHereInput, sourceLabel: string) =>
    deps
      .transferPull(input.sourceEnvironmentId, {
        sourceEnvironmentId: self,
        threadId: input.sourceThreadId,
        modelSelection: input.modelSelection ?? null,
      })
      .pipe(
        Effect.mapError((error) =>
          error.needsUpdate === true
            ? failed("invalid", error.message)
            : error.uncertain || error.local === true || error.code === "unreachable"
              ? failed(
                  "busy",
                  `${sourceLabel} has not answered, so it may still be running this thread. The copy here stays readable and starts nothing until ${sourceLabel} hands the thread over; try again once it is back.`,
                )
              : failed(error.code, error.message),
        ),
        Effect.map((response) => result(self, response)),
      );

  /** The source's side of a pull: the same move as one started here, to the machine that asked. */
  const servePull = (caller: ReceiverCaller, request: TransferPullRequest) =>
    Effect.gen(function* () {
      const record = yield* recordOf(request.threadId);
      const asks = caller.sourceEnvironmentId;
      if (record === undefined || !record.replicas.some((entry) => entry.environmentId === asks)) {
        return yield* failed(
          "not_found",
          `${selfLabel}: that machine holds no copy of this thread`,
        );
      }
      const moved = yield* owned(
        request.threadId,
        run(
          {
            threadId: request.threadId,
            destinationEnvironmentId: asks,
            ...(request.modelSelection === null ? {} : { modelSelection: request.modelSelection }),
          },
          "continue-here",
          { trigger: { kind: "pull" } },
          false,
        ),
      );
      return (
        moved.receipt ?? {
          threadId: moved.result.threadId,
          machineLabel: moved.result.machineLabel,
          modelSelection: moved.result.modelSelection,
          resumed: false,
          notice: moved.result.notice,
        }
      );
    }).pipe(
      Effect.mapError(
        (error) =>
          new HandoffRefusal({
            status: error.code === "failed" ? 500 : 409,
            code: error.code,
            message: error.message,
          }),
      ),
    );

  return { handOff, planBatch, endBatch, resumeUnsent, reconcile, pull, servePull };
}
