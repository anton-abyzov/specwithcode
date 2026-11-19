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
  NonNegativeInt,
  type Project,
  type ProjectId,
  type RuntimeMode,
  type ScheduledTask,
  type ScheduledTaskGrantedBy,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
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
import { accountInGrant, projectInGrant } from "../fleet/workGrantPolicy.ts";
import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { exceededDispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ScheduledTaskService } from "./ScheduledTaskService.ts";
import { isCoordinatorOwnedRoutine } from "./ScheduledTaskCopies.ts";
import {
  runsHere,
  type RoutineRunnerRecord,
  type RoutineRunnerRecords,
} from "./ScheduledTaskRunner.ts";
import {
  affirmsRunner,
  refuseTransfer,
  ROUTINE_RUNNER_CAPABILITY,
  RoutineRunnerRequest,
  RoutineRunnerResponse,
  RoutineTransferRefusal,
  RUNNER_OPS,
  TransferRunState,
} from "./ScheduledTaskRunnerWire.ts";
import { nextRunAt } from "./ScheduledTaskStorage.ts";

export { RoutineTransferRefusal, TransferRunState };

// --- wire ---------------------------------------------------------------------------

export const ROUTINE_TRANSFER_PROTOCOL_VERSION = 1;
const TRANSFER_TIMEOUT_MS = 30_000;
const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const RoutineTransferRequest = Schema.Union([
  Schema.Struct({
    protocolVersion: NonNegativeInt,
    op: Schema.Literal("stage"),
    /** The caller's copy of the project; the target uses its own linked copy. */
    sourceProjectId: bounded(256),
    routine: CoordinatorRoutineCopy,
    ownThread: Schema.Boolean,
    /** The target's thread the routine posts into: the continuation of the moved worker. */
    boundThreadId: Schema.NullOr(bounded(512)),
  }),
  Schema.Struct({
    protocolVersion: NonNegativeInt,
    op: Schema.Literal("enable"),
    routineId: ScheduledTaskId,
    runState: TransferRunState,
  }),
  Schema.Struct({
    protocolVersion: NonNegativeInt,
    op: Schema.Literal("release"),
    routineId: ScheduledTaskId,
  }),
]);
export type RoutineTransferRequest = typeof RoutineTransferRequest.Type;

export const RoutineTransferResponse = Schema.Struct({
  routineId: bounded(256),
  /** The target's copy of the project. */
  projectId: Schema.optional(bounded(256)),
  enabled: Schema.Boolean,
  /** `release`: the state the target's copy ended with; null when it had none. */
  runState: Schema.optional(Schema.NullOr(TransferRunState)),
  /** The routine runs with less access there than here (the grant's cap). */
  capped: Schema.optional(Schema.Boolean),
});
export type RoutineTransferResponse = typeof RoutineTransferResponse.Type;

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
  /** One id for a whole move; every step of it, and every retry, carries it. */
  readonly newOperationId: Effect.Effect<string>;
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
  /** `staged`: saved there, still on here. `off`: off here, the enable may have been sent. */
  phase: Schema.Literals(["staged", "off"]),
  runState: Schema.NullOr(TransferRunState),
  /** The record this routine had before the move, restored when the move is called off. */
  prior: Schema.NullOr(Schema.Unknown),
});
type MoveOperation = typeof MoveOperation.Type;
const decodeOperation = Schema.decodeUnknownOption(MoveOperation);

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
              operation: null,
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
      if (enabled._tag === "Failure" && !(enabled.failure.refused && !enabled.failure.uncertain))
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
      if (operation.target !== target)
        return failed(
          `Stays as it is: it is moving to ${operation.targetLabel}.`,
          operation.phase === "off",
        );
      const asked = yield* ask(target, {
        op: "status",
        routineId: task.id,
        operationId: record.operationId,
      }).pipe(Effect.result);
      if (asked._tag === "Failure" || !affirmsRunner(asked.success))
        return failed(
          `${operation.targetLabel} did not say where the move stands. It stays as it is; try again.`,
          operation.phase === "off",
        );
      switch (asked.success.operation) {
        case "enabled":
          return yield* finish(task, record, operation, {
            revision: asked.success.routine?.revision ?? (yield* deps.revisionOf(task.id)) + 1,
          });
        case "staged":
          if (operation.phase === "off") return yield* finish(task, record, operation, null);
          // Cut off before this machine turned it off: called off, to start clean.
          yield* abort(target, record.operationId, task.id);
          yield* backHere(task, operation, false);
          return failed("Stays here: the move was cut off before it began. Try again.", false);
        default:
          // Not there, or called off there: it runs here.
          yield* backHere(task, operation, operation.phase === "off");
          return failed(`Stays here: ${operation.targetLabel} does not hold the move.`, false);
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
      const before = yield* deps.readState(task.id);
      if (before === null) return failed("This routine is gone.", false);
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
      // 1. Saved there, off.
      const staged = yield* ask(target, {
        op: "runner-stage",
        operationId,
        sourceProjectId: task.projectId,
        routine: { ...input.copy, enabled: false },
        ownThread: task.ownThread === true,
        boundThreadId: input.boundThreadId,
      }).pipe(Effect.result);
      if (staged._tag === "Failure") {
        // It may have been saved there, off: taken away again so nothing is left behind.
        if (staged.failure.uncertain) yield* abort(target, operationId, task.id);
        return failed(`Stays here: ${staged.failure.message}`, false);
      }
      const self = yield* deps.selfEnvironmentId;
      const operation: MoveOperation = {
        target,
        targetLabel,
        targetProjectId: staged.success.projectId ?? null,
        capped: staged.success.capped === true,
        phase: "staged",
        runState: null,
        prior: existing,
      };
      const moving: RoutineRunnerRecord = {
        taskId: task.id,
        state: "moving",
        runnerEnvironmentId: self ?? "",
        runnerLabel: null,
        revision: existing?.revision ?? 0,
        acked: existing?.acked ?? [],
        operationId,
        operation,
      };
      yield* deps.records.write(moving).pipe(Effect.ignore);
      // 2. Off here, then the state as it is now. It is turned on there only once
      //    this machine's row reads off: otherwise it could fire on both.
      const off = yield* deps.setEnabled(task.id, false);
      const after = off ? yield* deps.readState(task.id) : null;
      if (!off || after === null || after.enabled === true) {
        yield* abort(target, operationId, task.id);
        yield* backHere(task, operation, false);
        return failed(
          "Stays here: it could not be turned off on this machine, so it was not turned on there.",
          false,
        );
      }
      yield* deps.note(task.id, awayPausedNote(targetLabel));
      const runState = settledRunState(task, before, after, yield* deps.nowMs);
      const offOperation: MoveOperation = { ...operation, phase: "off", runState };
      const offRecord = { ...moving, operation: offOperation };
      // Written before the enable leaves: a retry repeats this enable and no other.
      yield* deps.records.write(offRecord).pipe(Effect.ignore);
      // 3. On there, acknowledged.
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
      if (record !== null && !runsHere(record)) {
        const operation = Option.getOrNull(decodeOperation(record.operation));
        yield* restoreRecord(input.task.id, operation?.prior ?? null);
      }
      yield* deps.note(input.task.id, null);
      // On first, then the state: turning on computes its own next run, which the state replaces.
      if (input.wasEnabled) yield* deps.setEnabled(input.task.id, true);
      if (state !== null)
        yield* deps.writeState(
          input.task,
          input.wasEnabled ? state : { ...state, nextRunAt: null },
        );
      return { kind: "returned", detail: "Runs here again." } as const;
    });

  return { moveOut, bringBack } as const;
};

// --- the target's side -------------------------------------------------------------------

export interface TransferInDeps {
  readonly projects: Effect.Effect<ReadonlyArray<Project>>;
  /** The project a routine id belongs to here, and the grant it was saved under. */
  readonly findTask: (id: string) => Effect.Effect<{
    readonly projectId: string;
    readonly grantedBy: ScheduledTaskGrantedBy | undefined;
  } | null>;
  readonly upsert: (
    input: ScheduledTaskUpsertInput,
    grantedBy: ScheduledTaskGrantedBy,
  ) => Effect.Effect<void, string>;
  readonly setEnabled: (id: ScheduledTaskId, enabled: boolean) => Effect.Effect<boolean, string>;
  readonly remove: (id: ScheduledTaskId) => Effect.Effect<void, string>;
  readonly readState: (id: string) => Effect.Effect<TransferRunState | null>;
  readonly writeState: (
    projectId: string,
    id: string,
    state: TransferRunState,
  ) => Effect.Effect<void>;
  /** This machine's runner records (ScheduledTaskRunner). */
  readonly records: Pick<
    RoutineRunnerRecords,
    "read" | "write" | "remove" | "receipt" | "putReceipt"
  >;
  readonly selfEnvironmentId: Effect.Effect<string | null>;
  /**
   * The end of a move, as one write: the carried run state, this machine as
   * the runner, and the receipt that answers every repeat. All of it or none.
   */
  readonly commitEnable: (input: {
    readonly projectId: string;
    readonly routineId: string;
    readonly runState: TransferRunState;
    readonly record: RoutineRunnerRecord;
    readonly receiptKey: string;
    readonly answer: RoutineRunnerResponse;
  }) => Effect.Effect<void, string>;
}

const decodeUpsert = Schema.decodeUnknownOption(ScheduledTaskUpsertInput);

const refuse = refuseTransfer;

/** The routine's mode, no higher than the caller's ceiling here. */
export function cappedRuntimeMode(
  mode: RuntimeMode,
  ceiling: RuntimeMode | null | undefined,
): { readonly mode: RuntimeMode; readonly capped: boolean } {
  if (ceiling == null) return { mode, capped: false };
  const over = exceededDispatchModeLimit(
    { runtimeMode: ceiling, interactionMode: "default" },
    { runtimeMode: mode, interactionMode: "default" },
  );
  return over === undefined ? { mode, capped: false } : { mode: ceiling, capped: true };
}

type MoveRequest = Extract<
  RoutineRunnerRequest,
  { op: "runner-stage" | "runner-enable" | "runner-abort" }
>;
const decodeStoredAnswer = Schema.decodeUnknownOption(RoutineRunnerResponse);

export const makeTransferIn = (deps: TransferInDeps) => {
  const capable = { capabilities: [ROUTINE_RUNNER_CAPABILITY] } as const;
  const unreadable = () => refuse(503, "This machine could not read its routine runners.");
  const strict = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.catchCause(() => Effect.fail(unreadable())));

  /** The caller's own routine here, or a refusal: Away touches only what it moved. */
  const ownRoutine = (caller: ReceiverCaller, id: string) =>
    Effect.gen(function* () {
      const held = yield* deps.findTask(id);
      if (held === null) return null;
      if (held.grantedBy?.coordinatorEnvironmentId !== caller.sourceEnvironmentId)
        return yield* refuse(403, "That routine was not moved here by that machine.");
      return held;
    });

  /** Saves the caller's routine here, turned off, in its linked copy and within its grant. */
  const stageHere = (
    caller: ReceiverCaller,
    request: {
      readonly sourceProjectId: string;
      readonly routine: CoordinatorRoutineCopy;
      readonly ownThread: boolean;
      readonly boundThreadId: string | null;
    },
  ) =>
    Effect.gen(function* () {
      const grant = caller.grant;
      if (grant === null || grant.revoked)
        return yield* refuse(403, "This machine does not let that machine run work here.");
      if (!grant.routines && grant.legacy !== true)
        return yield* refuse(
          403,
          "This machine does not let that machine's coordinator manage routines. Turn on Routines for it in Settings > Machines > Who can run work here.",
        );
      const all = yield* deps.projects;
      const project = all.find(
        (entry) =>
          entry.deletedAt === null &&
          (entry.workspaceSettings?.logicalProject?.members ?? []).some(
            (member) =>
              member.environmentId === caller.sourceEnvironmentId &&
              member.projectId === request.sourceProjectId,
          ),
      );
      if (project === undefined)
        return yield* refuse(
          404,
          "This project has no linked copy on this machine. Link it first.",
        );
      if (!projectInGrant(grant.projects, caller.sourceEnvironmentId, project))
        return yield* refuse(
          403,
          "This machine's work grant for that machine leaves this project out.",
        );
      const routine = request.routine;
      if (!accountInGrant(grant.accounts, routine.modelSelection.instanceId))
        return yield* refuse(
          403,
          "This machine's work grant does not allow that routine's sign-in.",
        );
      const held = yield* deps.findTask(routine.id);
      if (held !== null && held.projectId !== project.id)
        return yield* refuse(409, "Another project here uses that routine's id.");
      if (
        held !== null &&
        held.grantedBy !== undefined &&
        held.grantedBy.coordinatorEnvironmentId !== caller.sourceEnvironmentId
      )
        return yield* refuse(409, "Another machine's work set up that routine here.");
      // A routine this machine runs itself, or is moving, is not another machine's to stage.
      const record = yield* strict(deps.records.read(routine.id));
      if (record !== null && record.state !== "disarmed")
        return yield* refuse(409, "This machine runs that routine itself.");
      const runtime = cappedRuntimeMode(routine.runtimeMode, caller.runtimeCeiling);
      const input = decodeUpsert({
        id: routine.id,
        title: routine.title,
        prompt: routine.prompt,
        enabled: false,
        schedule: routine.schedule,
        projectId: project.id,
        threadId: request.boundThreadId,
        workspaceStrategy: routine.workspaceStrategy,
        modelSelection: routine.modelSelection,
        runtimeMode: runtime.mode,
        interactionMode: routine.interactionMode,
        createdBy: routine.createdBy,
        creationSource: "server",
        modelPinned: routine.modelPinned ?? false,
        check: routine.check ?? null,
        brief: routine.brief ?? null,
        ownThread: request.ownThread,
      });
      if (Option.isNone(input))
        return yield* refuse(400, "That routine does not match this version.");
      yield* deps
        .upsert(input.value, {
          coordinatorEnvironmentId: caller.sourceEnvironmentId,
          runtimeCap: caller.runtimeCeiling ?? null,
          accounts: grant.accounts,
        })
        .pipe(Effect.mapError((message) => refuse(409, `Not saved here: ${message}`)));
      return { routineId: routine.id, projectId: project.id, capped: runtime.capped };
    });

  /** The requests of the release before runner records; answered as that release answers them. */
  const receive = (
    caller: ReceiverCaller,
    request: RoutineTransferRequest,
  ): Effect.Effect<RoutineTransferResponse, RoutineTransferRefusal> =>
    Effect.gen(function* () {
      if (request.protocolVersion !== ROUTINE_TRANSFER_PROTOCOL_VERSION)
        return yield* refuse(
          409,
          "The two machines run different versions of Away mode. Update both.",
        );
      const grant = caller.grant;
      if (grant === null || grant.revoked)
        return yield* refuse(403, "This machine does not let that machine run work here.");
      switch (request.op) {
        case "stage": {
          const staged = yield* stageHere(caller, request);
          return { ...staged, enabled: false };
        }
        case "enable": {
          const held = yield* ownRoutine(caller, request.routineId);
          if (held === null) return yield* refuse(404, "That routine is not on this machine.");
          // A routine with a runner record is turned on only by its move's own enable.
          if ((yield* strict(deps.records.read(request.routineId))) !== null)
            return yield* refuse(
              409,
              "That routine has a runner here; it is not turned on this way.",
            );
          // On first, then the state: turning on computes its own next run, which the state replaces.
          yield* deps
            .setEnabled(request.routineId, true)
            .pipe(Effect.mapError((message) => refuse(409, `Not turned on here: ${message}`)));
          yield* deps.writeState(held.projectId, request.routineId, request.runState);
          return { routineId: request.routineId, projectId: held.projectId, enabled: true };
        }
        case "release": {
          const held = yield* ownRoutine(caller, request.routineId);
          // Already gone: a retry after the first answer was lost.
          if (held === null)
            return { routineId: request.routineId, enabled: false, runState: null };
          // Read first: turning it off clears its next run.
          const runState = yield* deps.readState(request.routineId);
          yield* deps
            .setEnabled(request.routineId, false)
            .pipe(Effect.mapError((message) => refuse(409, `Not turned off here: ${message}`)));
          yield* deps
            .remove(request.routineId)
            .pipe(Effect.mapError((message) => refuse(409, `Not removed here: ${message}`)));
          // A routine this machine ran by a runner record goes back to its caller: the
          // record stays, resting, so a copy that arrives later cannot fire here as well.
          const record = yield* strict(deps.records.read(request.routineId));
          if (record !== null)
            yield* strict(
              deps.records.write({
                ...record,
                state: "disarmed",
                runnerEnvironmentId: caller.sourceEnvironmentId,
                runnerLabel: null,
                acked: [],
                operation: null,
              }),
            );
          return { routineId: request.routineId, enabled: false, runState };
        }
      }
    });

  /** The steps of a runner move, each under the move's operation id. */
  const receiveMove = (
    caller: ReceiverCaller,
    request: MoveRequest,
  ): Effect.Effect<RoutineRunnerResponse, RoutineTransferRefusal> =>
    Effect.gen(function* () {
      const stored = (key: string) =>
        strict(deps.records.receipt(key)).pipe(
          Effect.map((answer) =>
            answer === null ? null : Option.getOrNull(decodeStoredAnswer(answer)),
          ),
        );
      switch (request.op) {
        case "runner-stage": {
          const routineId = request.routine.id;
          const before = yield* stored(`${request.operationId}:stage`);
          if (before !== null) return before;
          if ((yield* stored(`${request.operationId}:abort`)) !== null)
            return yield* refuse(409, "That move was called off.");
          const staged = yield* stageHere(caller, request);
          const answer: RoutineRunnerResponse = {
            ...capable,
            projectId: staged.projectId,
            enabled: false,
            capped: staged.capped,
            operation: "staged",
          };
          yield* strict(
            deps.records.write({
              taskId: routineId,
              state: "staged",
              runnerEnvironmentId: caller.sourceEnvironmentId,
              runnerLabel: null,
              revision: 0,
              acked: [],
              operationId: request.operationId,
              operation: { projectId: staged.projectId, capped: staged.capped },
            }),
          );
          yield* strict(deps.records.putReceipt(`${request.operationId}:stage`, routineId, answer));
          return answer;
        }
        case "runner-enable": {
          // Asked again: the first answer, and nothing written. The routine may have run since.
          const before = yield* stored(`${request.operationId}:enable`);
          if (before !== null) return before;
          if ((yield* stored(`${request.operationId}:abort`)) !== null)
            return yield* refuse(409, "That move was called off.");
          const record = yield* strict(deps.records.read(request.routineId));
          if (
            record === null ||
            record.state !== "staged" ||
            record.operationId !== request.operationId
          )
            return yield* refuse(409, "That move is not staged on this machine.");
          const held = yield* ownRoutine(caller, request.routineId);
          if (held === null) return yield* refuse(404, "That routine is not on this machine.");
          const self = yield* deps.selfEnvironmentId;
          // On, but still `staged`: it cannot fire until the write below ends the move.
          yield* deps
            .setEnabled(request.routineId, true)
            .pipe(Effect.mapError((message) => refuse(409, `Not turned on here: ${message}`)));
          const revision = request.revision + 1;
          const answer: RoutineRunnerResponse = {
            ...capable,
            projectId: held.projectId,
            enabled: true,
            revision,
            operation: "enabled",
          };
          yield* deps
            .commitEnable({
              projectId: held.projectId,
              routineId: request.routineId,
              runState: request.runState,
              record: {
                taskId: request.routineId,
                state: "settled",
                runnerEnvironmentId: self ?? "",
                runnerLabel: null,
                revision,
                acked: [...request.acked],
                operationId: request.operationId,
                operation: null,
              },
              receiptKey: `${request.operationId}:enable`,
              answer,
            })
            .pipe(Effect.mapError((message) => refuse(503, `Not turned on here: ${message}`)));
          return answer;
        }
        case "runner-abort": {
          if ((yield* stored(`${request.operationId}:enable`)) !== null)
            return yield* refuse(409, "That move already turned the routine on here.");
          const answer: RoutineRunnerResponse = {
            ...capable,
            enabled: false,
            operation: "aborted",
          };
          // First, so an enable that arrives late is refused for good.
          yield* strict(
            deps.records.putReceipt(`${request.operationId}:abort`, request.routineId, answer),
          );
          const record = yield* strict(deps.records.read(request.routineId));
          if (record?.state === "staged" && record.operationId === request.operationId) {
            const held = yield* ownRoutine(caller, request.routineId);
            if (held !== null) {
              yield* deps
                .setEnabled(request.routineId, false)
                .pipe(Effect.mapError((message) => refuse(409, `Not turned off here: ${message}`)));
              yield* deps
                .remove(request.routineId)
                .pipe(Effect.mapError((message) => refuse(409, `Not removed here: ${message}`)));
            }
            yield* strict(deps.records.remove(request.routineId));
          }
          return answer;
        }
      }
    });
  return { receive, receiveMove } as const;
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
      newOperationId: runner.newId.pipe(Effect.map((id) => `routine-move:${id}`)),
    });

    const into = makeTransferIn({
      projects,
      findTask: (id) =>
        Effect.gen(function* () {
          const listed = yield* scheduled.list().pipe(Effect.orElseSucceed(() => ({ tasks: [] })));
          const task = listed.tasks.find((entry) => entry.id === id);
          if (task === undefined) return null;
          const grantedBy =
            scheduled.readGrant === undefined
              ? undefined
              : yield* scheduled.readGrant(task.id).pipe(Effect.orElseSucceed(() => undefined));
          return { projectId: task.projectId, grantedBy };
        }),
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
