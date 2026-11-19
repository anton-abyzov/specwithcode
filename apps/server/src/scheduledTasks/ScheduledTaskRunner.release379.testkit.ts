/**
 * Release 1.0.379, the release before runner records (1390 EC2-09), as it
 * shipped and never edited to follow the code beside it:
 *
 * - the sender of a routine move (`makeTransferOut379`): stage while the
 *   routine is still on at the source, then turn it off and read it back,
 *   then enable;
 * - what its scheduler would start on a due pass (`wouldFire379`): its due
 *   query and its coordinator gate, which know nothing of a runner record.
 *
 * A machine in a test that moves or fires through these is a machine that
 * was not updated, or was downgraded.
 */
import {
  AWAY_ROUTINES_PATH,
  type CoordinatorRoutineCopy,
  type EnvironmentId,
  type ProjectId,
  type ScheduledTask,
  ScheduledTaskId,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { AwayPeerError, type AwayPeerPost } from "../away/awayPeerCall.ts";
import { parseJson } from "../json.ts";
import type * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  type CoordinatorRoleShape,
  type CoordinatorRoleStatus,
  coordinatorRoleOf,
} from "../project/CoordinatorRole.ts";
import type { CoordinatorWakeGateShape } from "../project/CoordinatorWakeGate.ts";
import { nextRunAt } from "./ScheduledTaskStorage.ts";
import {
  ROUTINE_TRANSFER_PROTOCOL_VERSION,
  RoutineTransferRequest,
  RoutineTransferResponse,
  type TransferRunState,
} from "./ScheduledTaskTransfer.release377.testkit.ts";

const TRANSFER_TIMEOUT_MS = 30_000;

// --- ScheduledTaskTransfer.ts, the sending side ------------------------------------------

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

export const makeTransferOut379 = (deps: TransferOutDeps) => {
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

// --- ScheduledTaskCopies.ts ---------------------------------------------------------------

const isCoordinatorOwnedRoutine = (task: Pick<ScheduledTask, "ownThread">) =>
  task.ownThread === true;

// --- ScheduledTaskCoordinatorGate.ts ------------------------------------------------------

type RoutineCoordinatorHold =
  | {
      readonly kind: "rest";
      readonly note: string;
      /** The shared project this copy rests in, when it is linked. */
      readonly logicalProjectId?: string | null;
    }
  | { readonly kind: "wait"; readonly reason: string };

const RESTING_ROUTINE_NOTE =
  "Not run on this machine: another machine runs this project's coordinator. It runs here if this one takes over.";
const HANDOFF_ROUTINE_WAIT = "Waiting: this project is being handed to another machine.";
/** Why a resting copy is not changed here (1267 D-12): its runner's copy is the only one written. */
export const RESTING_ROUTINE_CHANGE_REFUSAL =
  "This routine runs on the machine that coordinates this project, so change, run or delete it there: open it from that machine in SpecWithCode. To run it here instead, take over the coordinator on this machine first.";
/** Why a routine is not changed while its coordinator is being handed over: the change could miss the copy that travels. */
export const HANDOVER_ROUTINE_CHANGE_REFUSAL =
  "This project's coordinator is being handed to another machine, so its routines cannot change right now. Try again in a moment.";

interface RoutineCoordinatorGateDeps {
  /** This machine's coordinator roles; without it the project's own binding is read. */
  readonly role: CoordinatorRoleShape | undefined;
  readonly wakeGate: CoordinatorWakeGateShape;
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
}

/** Why `task` may not fire on this copy now, or null when it may. Never fails. */
const makeRoutineCoordinatorGate379 =
  (deps: RoutineCoordinatorGateDeps) =>
  (
    task: Pick<ScheduledTask, "projectId" | "ownThread" | "schedule">,
  ): Effect.Effect<RoutineCoordinatorHold | null> =>
    Effect.gen(function* () {
      // A webhook routine never travels (its URL and secret are this machine's), so it is never held.
      if (!isCoordinatorOwnedRoutine(task) || task.schedule.type === "webhook") return null;
      const row = yield* deps.projects
        .get(task.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none<ProjectStore.ProjectRow>()));
      // A project that is gone is refused by admission, with its own message.
      if (Option.isNone(row)) return null;
      const role: Option.Option<CoordinatorRoleStatus> =
        deps.role === undefined
          ? Option.some(
              coordinatorRoleOf({
                id: row.value.projectId,
                workspaceSettings: row.value.workspaceSettings ?? undefined,
              }),
            )
          : yield* deps.role.roleOf(task.projectId);
      if (Option.isNone(role)) return null;
      if (role.value.state === "transferring")
        return { kind: "wait", reason: HANDOFF_ROUTINE_WAIT } as const;
      if (!role.value.active)
        return {
          kind: "rest",
          note: RESTING_ROUTINE_NOTE,
          logicalProjectId: role.value.logicalProjectId,
        } as const;
      const coordinatorThread = (row.value.workspaceSettings?.coordinatorThreadId ??
        `project-coordinator:${task.projectId}`) as ThreadId;
      const fenced = yield* deps.wakeGate.check(coordinatorThread);
      return fenced === null ? null : ({ kind: "wait", reason: fenced } as const);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not check where a routine's project coordinates", {
          projectId: task.projectId as ProjectId,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );

// --- ScheduledTaskStorage.ts `listDueTasks`, and the poll over it -------------------------

/**
 * The routines the release's scheduler would start now on this database: the
 * rows its due query selects that its coordinator gate lets through.
 */
export const wouldFire379 = (
  sql: SqlClient.SqlClient,
  deps: RoutineCoordinatorGateDeps,
  now: DateTime.DateTime,
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      readonly task_id: string;
      readonly project_id: string;
      readonly schedule_json: string;
      readonly run_policy_json: string | null;
    }>`
    SELECT * FROM scheduled_tasks
    WHERE enabled = 1 AND next_run_at IS NOT NULL
      AND next_run_at <= ${DateTime.formatIso(now)} AND last_run_status <> 'running'
    ORDER BY next_run_at ASC, task_id ASC
  `;
    const gate = makeRoutineCoordinatorGate379(deps);
    const fired: Array<string> = [];
    for (const row of rows) {
      const policy = (row.run_policy_json === null ? null : parseJson(row.run_policy_json)) as {
        readonly ownThread?: boolean;
      } | null;
      const held = yield* gate({
        projectId: row.project_id as ProjectId,
        ownThread: policy?.ownThread === true,
        schedule: parseJson(row.schedule_json) as ScheduledTask["schedule"],
      });
      if (held === null) fired.push(row.task_id);
    }
    return fired;
  });
