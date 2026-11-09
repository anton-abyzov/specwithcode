/**
 * Away mode's routine transfer (1267 T-05, AC-06): a routine that does not
 * follow its coordinator (one bound to a worker thread, or an older routine
 * without a thread of its own) moves to the target under the target's work
 * grant for this machine, with its run state. The order keeps it from ever
 * firing on both machines:
 *
 * 1. `stage`: the target saves it turned off, recording the grant (it runs
 *    only while that grant still allows routines there).
 * 2. This machine turns it off, with a "Paused while away" note, and reads
 *    its run state again: a run that slipped in before the pause counts.
 * 3. `enable`: the target writes that run state and turns it on, and answers.
 *    Only that answer marks it moved. A refusal turns it back on here; no
 *    answer leaves it off on both until Bring back or a retry.
 *
 * Bring back sends `release`: the target turns its copy off, removes it and
 * answers with its run state, which this machine takes before it turns its
 * own copy back on. Without that answer this copy stays off.
 */
import {
  AWAY_ROUTINES_PATH,
  CoordinatorRoutineCopy,
  type EnvironmentId,
  NonNegativeInt,
  type Project,
  type RuntimeMode,
  type ScheduledTask,
  type ScheduledTaskGrantedBy,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { AwayPeerError, type AwayPeerPost, makeAwayPeerPost } from "../away/awayPeerCall.ts";
import { accountInGrant, projectInGrant } from "../fleet/workGrantPolicy.ts";
import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { exceededDispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ScheduledTaskService } from "./ScheduledTaskService.ts";
import { nextRunAt } from "./ScheduledTaskStorage.ts";

// --- wire ---------------------------------------------------------------------------

export const ROUTINE_TRANSFER_PROTOCOL_VERSION = 1;
const TRANSFER_TIMEOUT_MS = 30_000;
const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** A routine's run state, so the target neither repeats nor skips a run. */
export const TransferRunState = Schema.Struct({
  nextRunAt: Schema.NullOr(bounded(64)),
  lastRunAt: Schema.NullOr(bounded(64)),
  runCount: NonNegativeInt,
  onceGeneration: NonNegativeInt,
});
export type TransferRunState = typeof TransferRunState.Type;

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

export class RoutineTransferRefusal extends Data.TaggedError("RoutineTransferRefusal")<{
  readonly status: number;
  readonly message: string;
}> {}

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
  /** Writes run state onto this machine's copy (Bring back). */
  readonly writeState: (
    task: Pick<ScheduledTask, "id" | "projectId">,
    state: TransferRunState,
  ) => Effect.Effect<void>;
  readonly nowMs: Effect.Effect<number>;
}

export type TransferOutcome =
  | { readonly kind: "moved"; readonly targetProjectId: string | null; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string; readonly offHere: boolean };

export type TransferBackOutcome =
  | { readonly kind: "returned"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string };

const decodeResponse = Schema.decodeUnknownOption(RoutineTransferResponse);
const encodeRequest = Schema.encodeSync(RoutineTransferRequest);

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
      const before = yield* deps.readState(task.id);
      if (before === null)
        return { kind: "failed", detail: "This routine is gone.", offHere: false } as const;
      // 1. Saved there, off.
      const staged = yield* call(target, {
        protocolVersion: ROUTINE_TRANSFER_PROTOCOL_VERSION,
        op: "stage",
        sourceProjectId: task.projectId,
        routine: { ...input.copy, enabled: false },
        ownThread: task.ownThread === true,
        boundThreadId: input.boundThreadId,
      }).pipe(Effect.result);
      if (staged._tag === "Failure")
        return {
          kind: "failed",
          detail: `Stays here: ${staged.failure.message}`.slice(0, 500),
          offHere: false,
        } as const;
      // 2. Off here, then the state as it is now. It is turned on there only once
      //    this machine's row reads off: otherwise it could fire on both.
      const off = yield* deps.setEnabled(task.id, false);
      const after = off ? yield* deps.readState(task.id) : null;
      if (!off || after === null || after.enabled === true) {
        // The staged copy there is off; take it away again so nothing is left behind.
        yield* call(target, {
          protocolVersion: ROUTINE_TRANSFER_PROTOCOL_VERSION,
          op: "release",
          routineId: task.id,
        }).pipe(Effect.ignore);
        return {
          kind: "failed",
          detail:
            "Stays here: it could not be turned off on this machine, so it was not turned on there.",
          offHere: false,
        } as const;
      }
      yield* deps.note(task.id, awayPausedNote(targetLabel));
      const state = settledRunState(
        task,
        before,
        after ?? { ...before, running: false },
        yield* deps.nowMs,
      );
      // 3. On there, acknowledged.
      const enabled = yield* call(target, {
        protocolVersion: ROUTINE_TRANSFER_PROTOCOL_VERSION,
        op: "enable",
        routineId: task.id,
        runState: state,
      }).pipe(Effect.result);
      if (enabled._tag === "Success" && enabled.success.enabled)
        return {
          kind: "moved",
          targetProjectId: staged.success.projectId ?? null,
          detail: (enabled.success.capped === true || staged.success.capped === true
            ? `Runs on ${targetLabel} now, with the access its grant there allows.`
            : `Runs on ${targetLabel} now, with its run state.`
          ).slice(0, 500),
        } as const;
      if (enabled._tag === "Failure" && enabled.failure.uncertain)
        return {
          kind: "failed",
          detail:
            `${targetLabel} did not confirm it turned the routine on. It stays off here; Bring back turns it on again.`.slice(
              0,
              500,
            ),
          offHere: true,
        } as const;
      // A definite no: it never ran there, so it runs here again.
      yield* deps.setEnabled(task.id, true);
      yield* deps.note(task.id, null);
      return {
        kind: "failed",
        detail: `Stays here: ${
          enabled._tag === "Failure" ? enabled.failure.message : `${targetLabel} kept it off.`
        }`.slice(0, 500),
        offHere: false,
      } as const;
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
}

const decodeUpsert = Schema.decodeUnknownOption(ScheduledTaskUpsertInput);

const refuse = (status: number, message: string) =>
  new RoutineTransferRefusal({ status, message: message.slice(0, 500) });

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

export const makeTransferIn = (deps: TransferInDeps) => {
  /** The caller's own routine here, or a refusal: Away touches only what it moved. */
  const ownRoutine = (caller: ReceiverCaller, id: string) =>
    Effect.gen(function* () {
      const held = yield* deps.findTask(id);
      if (held === null) return null;
      if (held.grantedBy?.coordinatorEnvironmentId !== caller.sourceEnvironmentId)
        return yield* refuse(403, "That routine was not moved here by that machine.");
      return held;
    });

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
          return {
            routineId: routine.id,
            projectId: project.id,
            enabled: false,
            capped: runtime.capped,
          };
        }
        case "enable": {
          const held = yield* ownRoutine(caller, request.routineId);
          if (held === null) return yield* refuse(404, "That routine is not on this machine.");
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
          return { routineId: request.routineId, enabled: false, runState };
        }
      }
    });
  return { receive } as const;
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
    /** On the target: one request from the routines route. */
    readonly receive: ReturnType<typeof makeTransferIn>["receive"];
    /**
     * Turns a routine off here with `note` shown on it (a webhook routine
     * while away), or, with null, back on with the note cleared. True when done.
     */
    readonly pauseHere: (taskId: string, note: string | null) => Effect.Effect<boolean>;
  }
>()("specweave-studio/scheduledTasks/ScheduledTaskTransfer") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const scheduled = yield* ScheduledTaskService;
  const projects = yield* ProjectService.ProjectService;
  const post = yield* makeAwayPeerPost;
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
    setEnabled: (id, enabled) =>
      scheduled
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
  });

  const into = makeTransferIn({
    projects: projects.snapshot.pipe(
      Effect.map((snapshot) => snapshot.projects),
      Effect.orElseSucceed(() => []),
    ),
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
      scheduled.upsert(input, { grantedBy }).pipe(
        Effect.asVoid,
        Effect.mapError((error) => error.message),
      ),
    setEnabled: (id, enabled) =>
      scheduled.setEnabled({ id, enabled }).pipe(
        Effect.as(true),
        Effect.mapError((error) => error.message),
      ),
    remove: (id) =>
      scheduled.delete({ id }).pipe(
        Effect.asVoid,
        Effect.mapError((error) => error.message),
      ),
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

  return ScheduledTaskTransfer.of({ ...out, receive: into.receive, pauseHere });
});

/** Needs the scheduler, projects, SQL and the fleet (for the work-grant channel). */
export const layer = Layer.effect(ScheduledTaskTransfer, make);
