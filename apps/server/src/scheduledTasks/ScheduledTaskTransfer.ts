/**
 * Moving a routine's runner to another machine (1267 T-05; 1390 AC-45). Away
 * mode calls it for a routine that does not follow its coordinator. The order
 * keeps it from ever firing on both machines, and one operation id names the
 * whole move:
 *
 * 0. `status`: the target must say it keeps runner records and answers a
 *    repeated enable without acting twice. A machine that cannot (the release
 *    before this one answers 400) is sent nothing more, and the routine stays
 *    here untouched.
 * 1. `runner-stage`: the target saves it turned off, recording the grant (it
 *    runs only while that grant still allows routines there).
 * 2. This machine turns it off, with a "Paused while away" note, and reads
 *    its run state again: a run that slipped in before the pause counts.
 * 3. `runner-enable`: the target writes that run state, the due slot with it,
 *    and turns it on, once. Only its answer marks the routine moved. A
 *    refusal turns it back on here. No answer leaves it off here and the move
 *    open: the next try asks `status` first and finishes or repeats the same
 *    enable, which the target answers from its receipt without writing again.
 *
 * Bring back sends `release`: the target turns its copy off, removes it and
 * answers with its run state, which this machine takes before it turns its
 * own copy back on. Without that answer this copy stays off.
 *
 * `stage`, `enable` and `release` without an operation id are the release
 * before this one's requests. They are still answered, so that release can
 * move a routine here; this machine no longer sends the first two.
 */
import {
  AWAY_ROUTINES_PATH,
  CoordinatorRoutineCopy,
  type EnvironmentId,
  type Project,
  type ProjectId,
  type ScheduledTask,
  ScheduledTaskId,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { AwayPeerError, type AwayPeerPost, makeAwayPeerPost } from "../away/awayPeerCall.ts";
import * as FleetTargets from "../fleet/FleetTargets.ts";
import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ScheduledTaskService } from "./ScheduledTaskService.ts";
import { isCoordinatorOwnedRoutine, routineCopyOf } from "./ScheduledTaskCopies.ts";
import {
  runsHere,
  type RoutineRunnerRecord,
  type RoutineRunnerRecords,
} from "./ScheduledTaskRunner.ts";
import {
  affirmsRunner,
  RoutineRunnerRequest,
  RoutineRunnerResponse,
  RoutineTransferRefusal,
  RoutineTransferRequest,
  RoutineTransferResponse,
  ROUTINE_TRANSFER_PROTOCOL_VERSION,
  TransferRunState,
} from "./ScheduledTaskRunnerWire.ts";
import { nextRunAt } from "./ScheduledTaskStorage.ts";
import { makeTransferIn } from "./ScheduledTaskTransferIn.ts";

export { RoutineTransferRefusal, TransferRunState };
export { ROUTINE_TRANSFER_PROTOCOL_VERSION, RoutineTransferRequest, RoutineTransferResponse };
export {
  cappedRuntimeMode,
  makeTransferIn,
  type TransferInDeps,
} from "./ScheduledTaskTransferIn.ts";

const TRANSFER_TIMEOUT_MS = 30_000;

// --- notes ----------------------------------------------------------------------------

export const awayPausedNote = (targetLabel: string) =>
  `Paused while away on ${targetLabel}.`.slice(0, 500);

/** Whether Away moves `task` by transfer: it neither follows a coordinator nor has a URL here. */
export const isTransferredRoutine = (task: Pick<ScheduledTask, "ownThread" | "schedule">) =>
  task.ownThread !== true && task.schedule.type !== "webhook";

/**
 * The run state to send after the pause: a run that started or ended between
 * the first read and the pause moves the next run on from that run, so the
 * target does not repeat it.
 */
export function settledRunState(
  task: Pick<ScheduledTask, "schedule">,
  before: TransferRunState,
  after: TransferRunState & { readonly running: boolean },
  nowMs: number,
): TransferRunState {
  if (!after.running && after.runCount === before.runCount && after.lastRunAt === before.lastRunAt)
    return before;
  const fromMs = after.running ? nowMs : Date.parse(after.lastRunAt ?? "") || nowMs;
  return {
    ...after,
    nextRunAt:
      task.schedule.type === "once"
        ? null
        : nextRunAt({ enabled: true, schedule: task.schedule }, DateTime.makeUnsafe(fromMs)),
  };
}

// --- this machine's side ----------------------------------------------------------------

export interface TransferOutDeps {
  readonly post: AwayPeerPost;
  /** The routine's run state here now, whether a run is going and, when read, whether it is on. */
  readonly readState: (
    taskId: ScheduledTask["id"],
  ) => Effect.Effect<
    (TransferRunState & { readonly running: boolean; readonly enabled?: boolean }) | null
  >;
  readonly setEnabled: (taskId: ScheduledTask["id"], enabled: boolean) => Effect.Effect<boolean>;
  /** Writes the note the routine shows while Away keeps it off; null clears it. */
  readonly note: (taskId: ScheduledTask["id"], note: string | null) => Effect.Effect<void>;
  /** Writes run state onto this machine's copy (Bring back, and a move the target refused). */
  readonly writeState: (
    task: Pick<ScheduledTask, "id" | "projectId">,
    state: TransferRunState,
  ) => Effect.Effect<void>;
  readonly nowMs: Effect.Effect<number>;
  /** This machine's runner records (ScheduledTaskRunner). */
  readonly records: Pick<RoutineRunnerRecords, "read" | "write" | "remove">;
  /** Whether every other machine of the project rests its copy of this routine. */
  readonly covered: (record: RoutineRunnerRecord, projectId: string) => Effect.Effect<boolean>;
  readonly selfEnvironmentId: Effect.Effect<string | null>;
  /** This machine's count of changes to the routine; the target continues from it. */
  readonly revisionOf: (taskId: string) => Effect.Effect<number>;
  /** Sets that count: a routine taken back continues above the machine that ran it meanwhile. */
  readonly setRevision: (taskId: string, revision: number) => Effect.Effect<void>;
  /** One id for a whole move; every step of it, and every retry, carries it. */
  readonly newOperationId: Effect.Effect<string>;
  /** The routine as it is sent to another machine; null when it cannot be. */
  readonly copyOf: (task: ScheduledTask) => CoordinatorRoutineCopy | null;
  /**
   * Claims the routine for a move before anything leaves this machine: under
   * the change lock, the routine as it is now and the `moving` record that
   * refuses every other change. A routine that is off, gone or no longer as
   * `expected` is not claimed.
   */
  readonly claim: (input: {
    readonly taskId: ScheduledTask["id"];
    readonly expected: RoutineRunnerRecord | null;
    readonly moving: (revision: number) => RoutineRunnerRecord;
  }) => Effect.Effect<
    | {
        readonly kind: "claimed";
        readonly task: ScheduledTask;
        readonly record: RoutineRunnerRecord;
      }
    | { readonly kind: "refused"; readonly detail: string }
  >;
  /**
   * Turns the routine off here for a move and records that with the state it
   * carries, as one write: a move whose record does not say `off` never
   * touched the row, so nothing a person did to it is ever undone.
   */
  readonly commitOff: (input: {
    readonly task: ScheduledTask;
    readonly note: string;
    readonly record: (runState: TransferRunState) => RoutineRunnerRecord;
  }) => Effect.Effect<RoutineRunnerRecord | null>;
  /**
   * The end of Bring back, as one write: who runs the routine, its revision,
   * whether it is on and the state it came back with. False when it was not saved.
   */
  readonly commitReturn: (input: {
    readonly task: Pick<ScheduledTask, "id" | "projectId">;
    /** The record to keep; null removes it. */
    readonly record: RoutineRunnerRecord | null;
    readonly revision: number;
    readonly enabled: boolean;
    readonly runState: TransferRunState | null;
  }) => Effect.Effect<boolean>;
}

export type TransferOutcome =
  | { readonly kind: "moved"; readonly targetProjectId: string | null; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string; readonly offHere: boolean };

export type TransferBackOutcome =
  | { readonly kind: "returned"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string };

const decodeResponse = Schema.decodeUnknownOption(RoutineTransferResponse);
const encodeRequest = Schema.encodeSync(RoutineTransferRequest);
const decodeRunnerResponse = Schema.decodeUnknownOption(RoutineRunnerResponse);
const encodeRunnerRequest = Schema.encodeSync(RoutineRunnerRequest);

/** One runner request to another machine's routines route, with its answer read. */
export const makeRunnerCall =
  (post: AwayPeerPost) => (target: string, request: RoutineRunnerRequest) =>
    post(
      target as EnvironmentId,
      AWAY_ROUTINES_PATH,
      encodeRunnerRequest(request),
      TRANSFER_TIMEOUT_MS,
    ).pipe(
      Effect.flatMap((answer) => {
        const decoded = decodeRunnerResponse(answer.json);
        return Option.isSome(decoded)
          ? Effect.succeed(decoded.value)
          : Effect.fail(
              new AwayPeerError({
                message: "The other machine sent an answer this version cannot read.",
                refused: false,
                uncertain: true,
              }),
            );
      }),
    );

/** A move in flight, kept on the source's runner record until it ends either way. */
const MoveOperation = Schema.Struct({
  target: Schema.String,
  targetLabel: Schema.String,
  targetProjectId: Schema.NullOr(Schema.String),
  capped: Schema.Boolean,
  /**
   * `claimed`: recorded here, nothing sent yet. `staged`: saved there, still on
   * here. `off`: off here, written with this record; the enable may have been sent.
   */
  phase: Schema.Literals(["claimed", "staged", "off"]),
  /** Whether it was on when the move claimed it. Only a claimed routine that is on moves. */
  wasEnabled: Schema.optional(Schema.Boolean),
  runState: Schema.NullOr(TransferRunState),
  /** The record this routine had before the move, restored when the move is called off. */
  prior: Schema.NullOr(Schema.Unknown),
});
type MoveOperation = typeof MoveOperation.Type;
const decodeOperation = Schema.decodeUnknownOption(MoveOperation);

/**
 * Whether a failed call says the target did not act and will not. An answer in
 * the 500s is this release failing to read its own state: it may have acted before.
 */
const definiteNo = (failure: AwayPeerError) =>
  failure.refused && !failure.uncertain && (failure.status ?? 0) < 500;

export const needsUpdateDetail = (targetLabel: string) =>
  `Stays here: ${targetLabel} must be updated before a routine can move to it.`.slice(0, 500);

export const makeTransferOut = (deps: TransferOutDeps) => {
  const call = (target: EnvironmentId, request: RoutineTransferRequest) =>
    deps.post(target, AWAY_ROUTINES_PATH, encodeRequest(request), TRANSFER_TIMEOUT_MS).pipe(
      Effect.flatMap((answer) => {
        const decoded = decodeResponse(answer.json);
        return Option.isSome(decoded)
          ? Effect.succeed(decoded.value)
          : Effect.fail(
              new AwayPeerError({
                message: "The other machine sent an answer this version cannot read.",
                refused: false,
                uncertain: true,
              }),
            );
      }),
    );
  const ask = makeRunnerCall(deps.post);

  const failed = (detail: string, offHere: boolean) =>
    ({ kind: "failed", detail: detail.slice(0, 500), offHere }) as const;

  /** Puts back the record the routine had before the move. */
  const restoreRecord = (taskId: string, prior: unknown) =>
    (prior === null || prior === undefined
      ? deps.records.remove(taskId)
      : deps.records.write(prior as RoutineRunnerRecord)
    ).pipe(Effect.ignore);

  const abort = (target: string, operationId: string, routineId: ScheduledTask["id"]) =>
    ask(target, { op: "runner-abort", operationId, routineId }).pipe(Effect.result);

  /** The move is off and the routine runs here as it did. */
  const backHere = (
    task: Pick<ScheduledTask, "id" | "projectId">,
    operation: MoveOperation,
    turnOn: boolean,
  ) =>
    Effect.gen(function* () {
      if (turnOn) {
        yield* deps.setEnabled(task.id, true);
        // Turning on computes its own next run; the carried state keeps the due slot.
        if (operation.runState !== null) yield* deps.writeState(task, operation.runState);
        yield* deps.note(task.id, null);
      }
      yield* restoreRecord(task.id, operation.prior);
    });

  const movedDetail = (targetLabel: string, capped: boolean) =>
    (capped
      ? `Runs on ${targetLabel} now, with the access its grant there allows.`
      : `Runs on ${targetLabel} now, with its run state.`
    ).slice(0, 500);

  /** The last step, and every retry of it: the same enable under the same operation id. */
  const finish = (
    task: Pick<ScheduledTask, "id" | "projectId">,
    record: RoutineRunnerRecord,
    operation: MoveOperation,
    already: { readonly revision: number } | null,
  ): Effect.Effect<TransferOutcome> =>
    Effect.gen(function* () {
      const self = yield* deps.selfEnvironmentId;
      const moved = (revision: number) =>
        Effect.gen(function* () {
          // Off here for good: this copy names its runner and never fires again.
          yield* deps.records
            .write({
              taskId: task.id,
              state: "disarmed",
              runnerEnvironmentId: operation.target,
              runnerLabel: operation.targetLabel,
              revision,
              acked: [],
              operationId: record.operationId,
              // Kept for Bring back: what this machine was to the routine before it moved.
              operation: { ...operation, runState: null },
              asked: [],
              // Its row is off for the move; this is what it follows the coordinator with again.
              copyEnabled: operation.wasEnabled ?? true,
              // The move sent this row's definition, and nothing changes one that moves.
              installedRevision: revision,
            })
            .pipe(Effect.ignore);
          return {
            kind: "moved",
            targetProjectId: operation.targetProjectId,
            detail: movedDetail(operation.targetLabel, operation.capped),
          } as const;
        });
      if (already !== null) return yield* moved(already.revision);
      const revision = yield* deps.revisionOf(task.id);
      if (operation.runState === null || record.operationId === null)
        return failed(
          "This move lost its run state. Bring the routine back, then try again.",
          true,
        );
      const enabled = yield* ask(operation.target, {
        op: "runner-enable",
        operationId: record.operationId,
        routineId: task.id,
        runState: operation.runState,
        revision,
        acked: [...new Set([...record.acked, ...(self === null ? [] : [self])])],
      }).pipe(Effect.result);
      if (enabled._tag === "Success" && enabled.success.enabled === true)
        return yield* moved(enabled.success.revision ?? revision + 1);
      if (enabled._tag === "Failure" && !definiteNo(enabled.failure))
        return failed(
          `${operation.targetLabel} did not confirm it turned the routine on. It stays off here; try the move again, or Bring back turns it on here.`,
          true,
        );
      // A definite no: it never ran there, so it runs here again.
      yield* abort(operation.target, record.operationId, task.id);
      yield* backHere(task, operation, true);
      return failed(
        `Stays here: ${
          enabled._tag === "Failure"
            ? enabled.failure.message
            : `${operation.targetLabel} kept it off.`
        }`,
        false,
      );
    });

  /** A move that was cut off: asks where it stands before anything else is sent. */
  const resume = (
    task: Pick<ScheduledTask, "id" | "projectId">,
    target: EnvironmentId,
    record: RoutineRunnerRecord,
  ): Effect.Effect<TransferOutcome> =>
    Effect.gen(function* () {
      const operation = Option.getOrNull(decodeOperation(record.operation));
      if (operation === null || record.operationId === null)
        return failed(
          "This routine's move could not be read. Bring it back, then try again.",
          true,
        );
      // Cut off before this machine turned it off: no enable was ever sent, so the
      // move is called off here whatever the target answers, and starts clean next time.
      // Turning it off is written with the record that says so, so the row is as a
      // person left it: it is never turned on from here.
      const callOffUnsent = Effect.gen(function* () {
        yield* abort(operation.target, record.operationId!, task.id);
        yield* backHere(task, operation, false);
        return failed("Stays here: the move was cut off before it began. Try again.", false);
      });
      if (operation.target !== target)
        return operation.phase === "off"
          ? failed(`Stays as it is: it is moving to ${operation.targetLabel}.`, true)
          : yield* callOffUnsent;
      const asked = yield* ask(target, {
        op: "status",
        routineId: task.id,
        operationId: record.operationId,
      }).pipe(Effect.result);
      if (operation.phase !== "off") return yield* callOffUnsent;
      if (asked._tag === "Failure" || !affirmsRunner(asked.success))
        return failed(
          `${operation.targetLabel} did not say where the move stands. It stays off here; try again.`,
          true,
        );
      switch (asked.success.operation) {
        case "enabled":
          return yield* finish(task, record, operation, {
            revision: asked.success.routine?.revision ?? (yield* deps.revisionOf(task.id)) + 1,
          });
        case "staged":
          return yield* finish(task, record, operation, null);
        default: {
          // Not there as far as it can tell. The enable may still be on its way, so the
          // move is called off there first: after that a late enable is refused for good.
          const called = yield* abort(target, record.operationId, task.id);
          if (called._tag === "Failure" || called.success.operation !== "aborted")
            return failed(
              `${operation.targetLabel} did not confirm the move is called off. It stays off here; try again.`,
              true,
            );
          yield* backHere(task, operation, true);
          return failed(`Stays here: ${operation.targetLabel} does not hold the move.`, false);
        }
      }
    });

  /** Moves one routine to `target`, ending with it off here and on there, or as it was. */
  const moveOut = (input: {
    readonly task: ScheduledTask;
    readonly target: EnvironmentId;
    readonly targetLabel: string;
    readonly copy: CoordinatorRoutineCopy;
    readonly boundThreadId: string | null;
  }): Effect.Effect<TransferOutcome> =>
    Effect.gen(function* () {
      const { task, target, targetLabel } = input;
      const existing = yield* deps.records.read(task.id);
      if (existing?.state === "moving") return yield* resume(task, target, existing);
      if (existing !== null && existing.state !== "settled")
        return failed(
          existing.state === "disarmed"
            ? `Stays as it is: ${existing.runnerLabel ?? "another machine"} runs it.`
            : "Stays as it is: it is not this machine's to move yet.",
          false,
        );
      // A coordinator's routine moves only once every machine rests its copy: until then
      // a copy elsewhere could still fire it under the coordinator rule.
      if (
        isCoordinatorOwnedRoutine(task) &&
        (existing === null || !(yield* deps.covered(existing, task.projectId)))
      )
        return failed(
          "Stays here: it runs where its project's coordinator runs until every linked machine confirms its runner.",
          false,
        );
      // 0. The target says it can take a runner. Anything else: nothing was sent, nothing changes.
      const probe = yield* ask(target, { op: "status", routineId: task.id }).pipe(Effect.result);
      if (probe._tag === "Failure")
        return failed(
          probe.failure.refused && !probe.failure.uncertain
            ? needsUpdateDetail(targetLabel)
            : `Stays here: ${probe.failure.message}`,
          false,
        );
      if (!affirmsRunner(probe.success)) return failed(needsUpdateDetail(targetLabel), false);
      const operationId = yield* deps.newOperationId;
      const self = yield* deps.selfEnvironmentId;
      const claimedOperation: MoveOperation = {
        target,
        targetLabel,
        targetProjectId: null,
        capped: false,
        phase: "claimed",
        wasEnabled: true,
        runState: null,
        prior: existing,
      };
      // 1. Claimed here, before the routine is read for sending: from now on nobody
      //    changes it, so what is staged is what moves. A move this machine cannot
      //    remember is not started.
      const claim = yield* deps.claim({
        taskId: task.id,
        expected: existing,
        moving: (revision) => ({
          taskId: task.id,
          state: "moving",
          runnerEnvironmentId: self ?? "",
          runnerLabel: null,
          revision,
          acked: existing?.acked ?? [],
          operationId,
          operation: claimedOperation,
        }),
      });
      if (claim.kind === "refused") return failed(claim.detail, false);
      const claimed = claim.task;
      const copy = deps.copyOf(claimed);
      if (copy === null) {
        yield* restoreRecord(task.id, existing);
        return failed("Stays here: this routine cannot be sent.", false);
      }
      // 2. Saved there, off.
      const staged = yield* ask(target, {
        op: "runner-stage",
        operationId,
        sourceProjectId: claimed.projectId,
        routine: { ...copy, enabled: false },
        ownThread: claimed.ownThread === true,
        boundThreadId: input.boundThreadId,
      }).pipe(Effect.result);
      if (staged._tag === "Failure") {
        // It may have been saved there, off: taken away again so nothing is left behind.
        if (staged.failure.uncertain) yield* abort(target, operationId, task.id);
        yield* restoreRecord(task.id, existing);
        return failed(`Stays here: ${staged.failure.message}`, false);
      }
      const operation: MoveOperation = {
        ...claimedOperation,
        targetProjectId: staged.success.projectId ?? null,
        capped: staged.success.capped === true,
        phase: "staged",
      };
      // 3. Off here, with the state as it is now and the record that says so, in one
      //    write. It is turned on there only once that write is made: otherwise it
      //    could fire on both, or a retry could not repeat the enable.
      let offOperation: MoveOperation = operation;
      const offRecord = yield* deps.commitOff({
        task: claimed,
        note: awayPausedNote(targetLabel),
        record: (runState) => {
          offOperation = { ...operation, phase: "off", runState };
          return { ...claim.record, operation: offOperation };
        },
      });
      if (offRecord === null) {
        yield* abort(target, operationId, task.id);
        yield* backHere(task, operation, false);
        return failed(
          "Stays here: it could not be turned off on this machine, so it was not turned on there.",
          false,
        );
      }
      // 4. On there, acknowledged.
      return yield* finish(task, offRecord, offOperation, null);
    });

  /** Takes a moved routine back: off and gone there first, then on here with its state. */
  const bringBack = (input: {
    readonly task: Pick<ScheduledTask, "id" | "projectId">;
    readonly target: EnvironmentId;
    readonly targetLabel: string;
    readonly wasEnabled: boolean;
  }): Effect.Effect<TransferBackOutcome> =>
    Effect.gen(function* () {
      const released = yield* call(input.target, {
        protocolVersion: ROUTINE_TRANSFER_PROTOCOL_VERSION,
        op: "release",
        routineId: ScheduledTaskId.make(input.task.id),
      }).pipe(Effect.result);
      if (released._tag === "Failure")
        return {
          kind: "failed",
          detail: `${released.failure.message} It stays off here so it never runs on both.`.slice(
            0,
            500,
          ),
        } as const;
      const state = released.success.runState ?? null;
      // Gone there: this machine runs it again, under the record it had before the move.
      const record = yield* deps.records.read(input.task.id);
      const kept =
        record === null || runsHere(record)
          ? record
          : ((Option.getOrNull(decodeOperation(record.operation))?.prior ??
              null) as RoutineRunnerRecord | null);
      // Who runs it, its count, whether it is on and its state are one write. Until
      // it is made the routine has not come back: it stays off here and Bring back
      // asks again, and the other machine answers with the same state.
      const saved = yield* deps.commitReturn({
        task: input.task,
        record: kept,
        // Above the count the other copies heard from that machine: they follow the
        // higher one, so they name this machine again.
        revision:
          Math.max(released.success.revision ?? 0, yield* deps.revisionOf(input.task.id)) + 1,
        enabled: input.wasEnabled,
        runState: state === null ? null : input.wasEnabled ? state : { ...state, nextRunAt: null },
      });
      if (!saved)
        return {
          kind: "failed",
          detail:
            `${input.targetLabel} let it go, but this machine could not save it. It stays off here; bring it back again.`.slice(
              0,
              500,
            ),
        } as const;
      return { kind: "returned", detail: "Runs here again." } as const;
    });

  return { moveOut, bringBack } as const;
};

// --- run state in the scheduler's table ---------------------------------------------------

const readStateRow = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly next_run_at: string | null;
      readonly last_run_at: string | null;
      readonly last_run_status: string | null;
      readonly run_count: number;
      readonly once_generation: number | null;
      readonly enabled: number | boolean | null;
    }>`
      SELECT next_run_at, last_run_at, last_run_status, run_count, enabled,
        json_extract(run_policy_json, '$.onceGeneration') AS once_generation
      FROM scheduled_tasks WHERE task_id = ${id}
    `;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      runCount: Math.max(0, Math.trunc(row.run_count)),
      onceGeneration:
        typeof row.once_generation === "number" && row.once_generation > 0
          ? Math.trunc(row.once_generation)
          : 0,
      running: row.last_run_status === "running",
      enabled: row.enabled === true || row.enabled === 1,
    };
  });

const writeStateRow = (projectId: string, id: string, state: TransferRunState) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE scheduled_tasks
      SET next_run_at = ${state.nextRunAt}, last_run_at = ${state.lastRunAt},
        run_count = ${state.runCount},
        run_policy_json = CASE WHEN ${state.onceGeneration} > 0
          THEN json_set(COALESCE(run_policy_json, '{}'), '$.onceGeneration', ${state.onceGeneration})
          ELSE run_policy_json END
      WHERE task_id = ${id} AND project_id = ${projectId}
        AND last_run_status <> 'running'
    `;
  });

// --- pausing here ----------------------------------------------------------------------------

/**
 * Turns a routine off here with `note` shown on it, or, with null, back on
 * with the note cleared. True only when the row reads as asked afterwards.
 * Local and fast: the lid-close path runs it inside the five-second window.
 */
export const makePauseHere =
  (scheduled: Pick<ScheduledTaskService["Service"], "setEnabled">, sql: SqlClient.SqlClient) =>
  (taskId: string, note: string | null): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const id = ScheduledTaskId.make(taskId);
      const enabled = note === null;
      yield* scheduled.setEnabled({ id, enabled });
      yield* sql`UPDATE scheduled_tasks SET last_run_error = ${note} WHERE task_id = ${id}`;
      const rows = yield* sql<{ readonly enabled: number | boolean | null }>`
        SELECT enabled FROM scheduled_tasks WHERE task_id = ${id}
      `;
      const row = rows[0];
      return row !== undefined && (row.enabled === true || row.enabled === 1) === enabled;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Away could not pause or resume a routine", { cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

// --- the service ------------------------------------------------------------------------------

export class ScheduledTaskTransfer extends Context.Service<
  ScheduledTaskTransfer,
  ReturnType<typeof makeTransferOut> & {
    /**
     * On the target: one request from the routines route, of this release
     * (a runner request) or of the one before it.
     */
    readonly receive: (
      caller: ReceiverCaller,
      request: RoutineTransferRequest | RoutineRunnerRequest,
    ) => Effect.Effect<RoutineTransferResponse | RoutineRunnerResponse, RoutineTransferRefusal>;
    /**
     * Turns a routine off here with `note` shown on it (a webhook routine
     * while away), or, with null, back on with the note cleared. True when done.
     */
    readonly pauseHere: (taskId: string, note: string | null) => Effect.Effect<boolean>;
  }
>()("specweave-studio/scheduledTasks/ScheduledTaskTransfer") {}

/** What the transfer is built from; the live values come from `make`. */
export interface TransferParts {
  readonly sql: SqlClient.SqlClient;
  readonly scheduled: ScheduledTaskService["Service"];
  readonly post: AwayPeerPost;
  /** This machine's projects, deleted ones included. */
  readonly projects: Effect.Effect<ReadonlyArray<Project>>;
  /** What this machine calls another one. */
  readonly label: (environmentId: string) => Effect.Effect<string | null>;
}

export const makeTransfer = ({ sql, scheduled, post, projects, label }: TransferParts) =>
  Effect.gen(function* () {
    if (scheduled.runner === undefined)
      return yield* Effect.die("This scheduler keeps no routine runners.");
    const runner = yield* scheduled.runner();
    // From here on this machine can settle runners with, and send changes to, the others.
    yield* runner.attach({ post: makeRunnerCall(post), label });
    const withSql = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const logged =
      (what: string) =>
      <B>(fallback: B) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`Away routine transfer could not ${what}`, { cause }).pipe(
              Effect.as(fallback),
            ),
          ),
        );

    const out = makeTransferOut({
      post,
      readState: (id) => withSql(readStateRow(id)).pipe(logged("read run state")(null)),
      // The scheduler's own write: the public one refuses a routine that is moving.
      setEnabled: (id, enabled) =>
        runner.internal
          .setEnabled({ id, enabled })
          .pipe(Effect.as(true), logged("turn a routine on or off")(false)),
      note: (id, note) =>
        withSql(
          Effect.gen(function* () {
            const db = yield* SqlClient.SqlClient;
            yield* db`UPDATE scheduled_tasks SET last_run_error = ${note} WHERE task_id = ${id}`;
          }),
        ).pipe(logged("write a routine's note")(undefined)),
      writeState: (task, state) =>
        withSql(writeStateRow(task.projectId, task.id, state)).pipe(
          logged("write run state")(undefined),
        ),
      nowMs: Effect.map(DateTime.now, DateTime.toEpochMillis),
      records: runner.records,
      covered: (record, projectId) => runner.covered(record, projectId as ProjectId),
      selfEnvironmentId: runner.selfEnvironmentId,
      revisionOf: runner.revision,
      setRevision: (taskId, revision) =>
        runner.records.setRevision(taskId, revision).pipe(Effect.ignore),
      newOperationId: runner.newId.pipe(Effect.map((id) => `routine-move:${id}`)),
      copyOf: (task) => routineCopyOf({ ...task, ownThread: true }),
      claim: (input) =>
        runner
          .locked(
            runner.records.atomically(
              Effect.gen(function* () {
                const now = yield* runner.records.readStrict(input.taskId);
                if ((now?.state ?? null) !== (input.expected?.state ?? null))
                  return {
                    kind: "refused",
                    detail: "Stays as it is: it changed while the move began. Try again.",
                  } as const;
                const listed = yield* scheduled.list();
                const task = listed.tasks.find((entry) => entry.id === input.taskId);
                if (task === undefined)
                  return { kind: "refused", detail: "This routine is gone." } as const;
                const state = yield* withSql(readStateRow(input.taskId));
                if (state === null || !state.enabled)
                  return {
                    kind: "refused",
                    detail: "Stays here, off: it was turned off on this machine.",
                  } as const;
                const record = input.moving(yield* runner.revision(input.taskId));
                yield* runner.records.write(record);
                return { kind: "claimed", task: { ...task, enabled: true }, record } as const;
              }),
            ),
          )
          .pipe(
            logged("record a move")({
              kind: "refused",
              detail: "Stays here: this machine could not record the move.",
            } as const),
          ),
      commitOff: (input) =>
        runner
          .locked(
            runner.records.atomically(
              Effect.gen(function* () {
                const before = yield* withSql(readStateRow(input.task.id));
                if (before === null) return yield* Effect.fail("gone" as const);
                yield* runner.internal.setEnabled({ id: input.task.id, enabled: false });
                const after = yield* withSql(readStateRow(input.task.id));
                if (after === null || after.enabled) return yield* Effect.fail("on" as const);
                yield* runner.records.setNote(input.task.id, input.note);
                const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
                const record = input.record(settledRunState(input.task, before, after, nowMs));
                yield* runner.records.write(record);
                return record;
              }),
            ),
          )
          .pipe(logged("turn a routine off for its move")(null)),
      commitReturn: (input) =>
        runner
          .locked(
            runner.records.atomically(
              Effect.gen(function* () {
                if (input.record === null) yield* runner.records.remove(input.task.id);
                else yield* runner.records.write(input.record);
                yield* runner.records.setRevision(input.task.id, input.revision);
                // On first, then the state: turning on computes its own next run, which the state replaces.
                if (input.enabled)
                  yield* runner.internal.setEnabled({ id: input.task.id, enabled: true });
                if (input.runState !== null)
                  yield* withSql(
                    writeStateRow(input.task.projectId, input.task.id, input.runState),
                  );
                yield* runner.records.setNote(input.task.id, null);
              }),
            ),
          )
          .pipe(Effect.as(true), logged("save a routine that came back")(false)),
    });

    const into = makeTransferIn({
      projects,
      findTask: (id) =>
        Effect.gen(function* () {
          // A list that cannot be read is not an empty one: the caller must not take
          // the routine for gone from here.
          const listed = yield* scheduled.list();
          const task = listed.tasks.find((entry) => entry.id === id);
          if (task === undefined) return null;
          const grantedBy =
            scheduled.readGrant === undefined ? undefined : yield* scheduled.readGrant(task.id);
          return { projectId: task.projectId, grantedBy };
        }).pipe(Effect.mapError(() => "its routines could not be read.")),
      upsert: (input, grantedBy) =>
        runner.internal.upsert(input, { grantedBy }).pipe(
          Effect.asVoid,
          Effect.mapError((error) => error.message),
        ),
      setEnabled: (id, enabled) =>
        runner.internal.setEnabled({ id, enabled }).pipe(
          Effect.as(true),
          Effect.mapError((error) => error.message),
        ),
      remove: (id) =>
        runner.internal.remove({ id }).pipe(
          Effect.asVoid,
          Effect.mapError((error) => error.message),
        ),
      records: runner.records,
      selfEnvironmentId: runner.selfEnvironmentId,
      revisionOf: runner.revision,
      commitEnable: (input) =>
        runner.records
          .atomically(
            Effect.gen(function* () {
              yield* withSql(writeStateRow(input.projectId, input.routineId, input.runState));
              yield* runner.records.write(input.record);
              // This machine counts on from the source: a change made against the source's count is stale.
              yield* runner.records.setRevision(input.routineId, input.record.revision);
              yield* runner.records.putReceipt(input.receiptKey, input.routineId, input.answer);
            }),
          )
          .pipe(Effect.mapError(() => "its run state could not be written.")),
      readState: (id) =>
        withSql(readStateRow(id)).pipe(
          Effect.map((row) =>
            row === null
              ? null
              : {
                  nextRunAt: row.nextRunAt,
                  lastRunAt: row.lastRunAt,
                  runCount: row.runCount,
                  onceGeneration: row.onceGeneration,
                },
          ),
          logged("read run state")(null),
        ),
      writeState: (projectId, id, state) =>
        withSql(writeStateRow(projectId, id, state)).pipe(logged("write run state")(undefined)),
      atomically: (effect) =>
        runner.records.atomically(effect).pipe(
          Effect.mapError((error) =>
            // A refusal passes through; anything else is this machine failing to write.
            error._tag === "RoutineTransferRefusal"
              ? error
              : new RoutineTransferRefusal({
                  status: 503,
                  message: "This machine could not save the release.",
                }),
          ),
        ),
    });

    const pauseHere = makePauseHere(scheduled, sql);

    const receive: ScheduledTaskTransfer["Service"]["receive"] = (caller, request) => {
      if (!("protocolVersion" in request)) {
        switch (request.op) {
          case "runner-stage":
          case "runner-enable":
          case "runner-abort":
            // One step at a time with this machine's own changes and settling.
            return runner.locked(into.receiveMove(caller, request));
          default:
            return runner.receive(caller, request);
        }
      }
      return runner.locked(into.receive(caller, request));
    };

    return ScheduledTaskTransfer.of({ ...out, receive, pauseHere });
  });

export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const fleet = yield* FleetTargets.FleetTargets;
  return yield* makeTransfer({
    sql: yield* SqlClient.SqlClient,
    scheduled: yield* ScheduledTaskService,
    post: yield* makeAwayPeerPost,
    projects: projects.snapshot.pipe(
      Effect.map((snapshot) => snapshot.projects),
      Effect.orElseSucceed(() => []),
    ),
    label: (environmentId) =>
      fleet.load.pipe(
        Effect.map(
          (config) =>
            config?.machines.find((machine) => machine.environmentId === environmentId)?.label ??
            null,
        ),
        Effect.orElseSucceed(() => null),
      ),
  });
});

/** Needs the scheduler, projects, SQL and the fleet (for the work-grant channel). */
export const layer = Layer.effect(ScheduledTaskTransfer, make);
