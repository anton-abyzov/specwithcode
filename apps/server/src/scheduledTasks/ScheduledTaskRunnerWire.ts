/**
 * What two machines say to each other about a routine's runner (1390 AC-45),
 * on the routines route (`POST /api/away/v1/routines`).
 *
 * Every request here has an `op` the release before this one does not know,
 * so that release answers 400 and changes nothing: it can never take one of
 * these for its own `stage` or `enable`, which have no operation id and turn
 * a routine on before writing its run state. A machine is asked `status`
 * first, and only one that answers with `ROUTINE_RUNNER_CAPABILITY` is sent
 * anything else.
 */
import {
  CoordinatorRoutineCopy,
  NonNegativeInt,
  ScheduledTaskId,
} from "@specweave-studio/contracts";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";

/** A machine that says this keeps runner records and answers a repeated enable without acting twice. */
export const ROUTINE_RUNNER_CAPABILITY = "routine-runner.v1";

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const OperationId = bounded(128).check(Schema.isMinLength(8));
const RoutineIds = Schema.Array(ScheduledTaskId).check(Schema.isMaxLength(400));

/** A routine's run state, so the target neither repeats nor skips a run. */
export const TransferRunState = Schema.Struct({
  nextRunAt: Schema.NullOr(bounded(64)),
  lastRunAt: Schema.NullOr(bounded(64)),
  runCount: NonNegativeInt,
  onceGeneration: NonNegativeInt,
});
export type TransferRunState = typeof TransferRunState.Type;

/** A change to a routine, sent to its runner by a machine that only keeps a copy. */
export const RoutineRunnerEdit = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("save"), routine: CoordinatorRoutineCopy }),
  Schema.Struct({ kind: Schema.Literal("enabled"), enabled: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("delete") }),
]);
export type RoutineRunnerEdit = typeof RoutineRunnerEdit.Type;

export const RoutineRunnerRequest = Schema.Union([
  /** Whether this machine keeps runner records, and where a routine or an operation stands here. */
  Schema.Struct({
    op: Schema.Literal("status"),
    routineId: Schema.optional(ScheduledTaskId),
    operationId: Schema.optional(OperationId),
  }),
  /**
   * The caller runs these routines of the shared project. This machine's
   * copies of them never fire again until the caller says otherwise.
   */
  Schema.Struct({
    op: Schema.Literal("runner-disarm"),
    /** The caller's copy of the project; this machine uses its own linked copy. */
    sourceProjectId: bounded(256),
    routineIds: RoutineIds,
    /** Each routine's revision on the caller, in the order of `routineIds`. */
    revisions: Schema.optional(Schema.Array(NonNegativeInt).check(Schema.isMaxLength(400))),
    runnerLabel: Schema.optional(bounded(256)),
    /**
     * Only the revisions are news: a copy that rests for another runner keeps
     * it unless these are newer, so a push queued before a move changes nothing.
     */
    refresh: Schema.optional(Schema.Boolean),
    /**
     * The caller ran these routines under the release before's rule and still
     * may; without it the caller only offers to. A machine that runs one itself
     * keeps it from a caller that only offers.
     */
    incumbent: Schema.optional(Schema.Boolean),
    /**
     * Each routine as the caller holds it at that revision, in the order of
     * `routineIds`. A copy takes a revision only together with its definition.
     */
    routines: Schema.optional(
      Schema.Array(Schema.NullOr(CoordinatorRoutineCopy)).check(Schema.isMaxLength(400)),
    ),
  }),
  /** The caller no longer claims these routines: this machine's copies follow the coordinator again. */
  Schema.Struct({
    op: Schema.Literal("runner-rearm"),
    routineIds: RoutineIds,
    /** The caller deleted them: this machine's resting copies go too. */
    deleted: Schema.optional(Schema.Boolean),
  }),
  /** A change made on a machine that keeps a copy, for the runner to make. */
  Schema.Struct({
    op: Schema.Literal("runner-edit"),
    routineId: ScheduledTaskId,
    /** The runner revision the change was made against; any other is refused. Omitted, it is not checked. */
    expectedRevision: Schema.optional(NonNegativeInt),
    /**
     * The hash of the definition the change was made on (ScheduledTaskDefinitionHash).
     * Unless it is the one this machine holds now, the change is not made and is
     * answered with what this machine holds, whatever the revisions say. So is
     * a change that names none.
     */
    seen: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
    edit: RoutineRunnerEdit,
  }),
  /** Step 1 of a runner move: saved here, off, under the move's operation id. */
  Schema.Struct({
    op: Schema.Literal("runner-stage"),
    operationId: OperationId,
    sourceProjectId: bounded(256),
    routine: CoordinatorRoutineCopy,
    ownThread: Schema.Boolean,
    boundThreadId: Schema.NullOr(bounded(512)),
  }),
  /**
   * The last step: the source is off, so this machine takes the due slot and
   * run state and turns the routine on, once. Asked again under the same
   * operation id it answers as it did and writes nothing.
   */
  Schema.Struct({
    op: Schema.Literal("runner-enable"),
    operationId: OperationId,
    routineId: ScheduledTaskId,
    runState: TransferRunState,
    /** The source's runner revision; this machine continues from the next. */
    revision: NonNegativeInt,
    /** The machines whose copies already rest for this routine, the source among them. */
    acked: Schema.Array(bounded(256)).check(Schema.isMaxLength(256)),
  }),
  /** The move is off: the staged copy goes, and a late enable for it is refused. */
  Schema.Struct({
    op: Schema.Literal("runner-abort"),
    operationId: OperationId,
    routineId: ScheduledTaskId,
  }),
]);
export type RoutineRunnerRequest = typeof RoutineRunnerRequest.Type;

export const RUNNER_OPS: ReadonlySet<string> = new Set([
  "status",
  "runner-disarm",
  "runner-rearm",
  "runner-edit",
  "runner-stage",
  "runner-enable",
  "runner-abort",
]);

export const RoutineRunnerOperationState = Schema.Literals([
  "unknown",
  "staged",
  "enabled",
  "aborted",
]);
export type RoutineRunnerOperationState = typeof RoutineRunnerOperationState.Type;

/** One answer shape for every runner request; each op fills what it has. */
export const RoutineRunnerResponse = Schema.Struct({
  capabilities: Schema.Array(bounded(64)).check(Schema.isMaxLength(32)),
  /** `status`: the routine as this machine holds it, or null when it has none. */
  routine: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        state: bounded(32),
        runnerEnvironmentId: Schema.NullOr(bounded(256)),
        revision: NonNegativeInt,
        enabled: Schema.Boolean,
      }),
    ),
  ),
  /** `status`, the move ops: where the operation stands here. */
  operation: Schema.optional(RoutineRunnerOperationState),
  /** `runner-disarm`: the routines whose copies rest here now, and those this machine runs itself. */
  acked: Schema.optional(RoutineIds),
  refused: Schema.optional(RoutineIds),
  /** `runner-edit`, `runner-enable`: the runner revision after the request. */
  revision: Schema.optional(NonNegativeInt),
  /** `runner-edit`: the change was made against an older revision and was not made. */
  stale: Schema.optional(Schema.Boolean),
  /** `runner-edit`: the routine as the runner holds it now; null once deleted. */
  copy: Schema.optional(Schema.NullOr(CoordinatorRoutineCopy)),
  /** The move ops: this machine's copy of the project, whether it is on, and whether its access was capped. */
  projectId: Schema.optional(bounded(256)),
  enabled: Schema.optional(Schema.Boolean),
  capped: Schema.optional(Schema.Boolean),
});
export type RoutineRunnerResponse = typeof RoutineRunnerResponse.Type;

export class RoutineTransferRefusal extends Data.TaggedError("RoutineTransferRefusal")<{
  readonly status: number;
  readonly message: string;
}> {}

export const refuseTransfer = (status: number, message: string) =>
  new RoutineTransferRefusal({ status, message: message.slice(0, 500) });

/** Whether an answer names the capability; anything else is a machine that cannot be a runner's peer. */
export const affirmsRunner = (answer: Pick<RoutineRunnerResponse, "capabilities"> | null) =>
  answer !== null && answer.capabilities.includes(ROUTINE_RUNNER_CAPABILITY);

// --- the release before: stage, enable and release without an operation id -------------

export const ROUTINE_TRANSFER_PROTOCOL_VERSION = 1;

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
  /** `release`: the count of changes this machine reached as the routine's runner. */
  revision: Schema.optional(NonNegativeInt),
});
export type RoutineTransferResponse = typeof RoutineTransferResponse.Type;
