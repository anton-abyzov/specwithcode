/**
 * The runner table and what a routine says about its runner (1390 AC-45):
 * the record, its states, the notes and refusals a person reads. Kept apart
 * from ScheduledTaskRunner so the move and the receiving side read the same
 * shapes.
 */
import type { ScheduledTask } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type { AwayPeerError } from "../away/awayPeerCall.ts";
import { parseJson as readJson, stringifyJson } from "../json.ts";
import { isCoordinatorOwnedRoutine } from "./ScheduledTaskCopies.ts";

// --- notes and refusals ----------------------------------------------------------------

const named = (label: string | null) => label ?? "another machine";
export const runsElsewhereNote = (label: string | null) =>
  `Not run on this machine: ${named(label)} runs this routine.`.slice(0, 500);
export const runsElsewhereRefusal = (label: string | null, why: string) =>
  `This routine runs on ${named(label)}, and the change did not reach it (${why}). Nothing was changed. Try again when that machine is reachable, or change it there.`.slice(
    0,
    500,
  );
export const threadHandedOffNote = (label: string) =>
  `Its thread was handed off to ${label}.`.slice(0, 500);
export const MOVING_ROUTINE_WAIT = "Waiting: this routine is moving to another machine.";
export const MOVING_ROUTINE_CHANGE_REFUSAL =
  "This routine is moving to another machine, so it cannot change right now. Try again in a moment.";
export const deleteUnreachedRefusal = (labels: ReadonlyArray<string>) =>
  `Not deleted: ${labels.join(", ")} did not confirm removing its copy, and the routine would come back from it. Try again when it is reachable.`.slice(
    0,
    500,
  );
export const STALE_ROUTINE_EDIT_REFUSAL =
  "This routine changed since you opened it, so your change was not saved. Open it again and repeat the change.";

// --- the record ------------------------------------------------------------------------

export type RoutineRunnerState = "settling" | "settled" | "disarmed" | "staged" | "moving";

export interface RoutineRunnerRecord {
  readonly taskId: string;
  readonly state: RoutineRunnerState;
  /** The machine that runs it: this one for `settling`, `settled` and `moving`. */
  readonly runnerEnvironmentId: string;
  readonly runnerLabel: string | null;
  readonly revision: number;
  /** `settling`, `settled`: the machines whose copies rest for this routine. */
  readonly acked: ReadonlyArray<string>;
  readonly operationId: string | null;
  /** The move in flight, as ScheduledTaskTransfer wrote it. */
  readonly operation: unknown;
}

/** Whether the record makes this machine the one that runs the routine. */
export const runsHere = (record: Pick<RoutineRunnerRecord, "state"> | null | undefined) =>
  record != null && (record.state === "settled" || record.state === "settling");

/** Whether the record keeps a replica or a handover from rewriting the routine here. */
export const keepsOwnState = (record: Pick<RoutineRunnerRecord, "state"> | null) =>
  record !== null &&
  (record.state === "settled" || record.state === "staged" || record.state === "moving");

interface RecordRow {
  readonly task_id: string;
  readonly state: string;
  readonly runner_environment_id: string;
  readonly runner_label: string | null;
  readonly revision: number;
  readonly acked_json: string;
  readonly operation_id: string | null;
  readonly operation_json: string | null;
}

const STATES: ReadonlySet<string> = new Set([
  "settling",
  "settled",
  "disarmed",
  "staged",
  "moving",
]);

const parseJson = (json: string | null): unknown => {
  if (json === null) return null;
  try {
    return readJson(json);
  } catch {
    return null;
  }
};

const recordOf = (row: RecordRow): RoutineRunnerRecord | null => {
  if (!STATES.has(row.state)) return null;
  const acked = parseJson(row.acked_json);
  return {
    taskId: row.task_id,
    state: row.state as RoutineRunnerState,
    runnerEnvironmentId: row.runner_environment_id,
    runnerLabel: row.runner_label,
    revision: Math.max(0, Math.trunc(row.revision)),
    acked: Array.isArray(acked)
      ? acked.filter((entry): entry is string => typeof entry === "string")
      : [],
    operationId: row.operation_id,
    operation: parseJson(row.operation_json),
  };
};

/** The runner table, for the scheduler and for the move (ScheduledTaskTransfer). Never fails. */
export const makeRunnerRecords = (sql: SqlClient.SqlClient) => {
  const quiet =
    <B>(what: string, fallback: B) =>
    <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A | B> =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Could not ${what}`, { cause }).pipe(Effect.as(fallback)),
        ),
      );
  const read = (taskId: string) =>
    sql<RecordRow>`SELECT * FROM scheduled_task_runners WHERE task_id = ${taskId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : recordOf(rows[0]))),
    );
  const all = sql<RecordRow>`SELECT * FROM scheduled_task_runners`.pipe(
    Effect.map(
      (rows) =>
        new Map(
          rows.flatMap((row) => {
            const record = recordOf(row);
            return record === null ? [] : [[record.taskId, record] as const];
          }),
        ),
    ),
  );
  const write = (record: RoutineRunnerRecord) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const acked = stringifyJson([...new Set(record.acked)].toSorted());
      const operation = record.operation == null ? null : stringifyJson(record.operation);
      yield* sql`
        INSERT INTO scheduled_task_runners (
          task_id, state, runner_environment_id, runner_label, revision,
          acked_json, operation_id, operation_json, updated_at
        ) VALUES (
          ${record.taskId}, ${record.state}, ${record.runnerEnvironmentId}, ${record.runnerLabel},
          ${record.revision}, ${acked}, ${record.operationId}, ${operation}, ${now}
        )
        ON CONFLICT (task_id) DO UPDATE SET
          state = excluded.state,
          runner_environment_id = excluded.runner_environment_id,
          runner_label = excluded.runner_label,
          revision = excluded.revision,
          acked_json = excluded.acked_json,
          operation_id = excluded.operation_id,
          operation_json = excluded.operation_json,
          updated_at = excluded.updated_at
      `;
    });
  const remove = (taskId: string) =>
    sql`DELETE FROM scheduled_task_runners WHERE task_id = ${taskId}`.pipe(Effect.asVoid);
  const receipt = (key: string) =>
    sql<{ readonly answer_json: string }>`
      SELECT answer_json FROM scheduled_task_runner_receipts WHERE receipt_key = ${key}
    `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : parseJson(rows[0].answer_json))));
  const putReceipt = (key: string, taskId: string, answer: unknown) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT OR IGNORE INTO scheduled_task_runner_receipts (receipt_key, task_id, answer_json, created_at)
        VALUES (${key}, ${taskId}, ${stringifyJson(answer)}, ${now})
      `;
    });
  const revision = (taskId: string) =>
    sql<{ readonly revision: number }>`
      SELECT revision FROM scheduled_task_revisions WHERE task_id = ${taskId}
    `.pipe(Effect.map((rows) => Math.max(0, Math.trunc(rows[0]?.revision ?? 0))));
  const revisions = sql<{ readonly task_id: string; readonly revision: number }>`
    SELECT task_id, revision FROM scheduled_task_revisions
  `.pipe(Effect.map((rows) => new Map(rows.map((row) => [row.task_id, row.revision] as const))));
  const setRevision = (taskId: string, value: number) =>
    sql`
      INSERT INTO scheduled_task_revisions (task_id, revision) VALUES (${taskId}, ${value})
      ON CONFLICT (task_id) DO UPDATE SET revision = excluded.revision
    `.pipe(Effect.asVoid);
  const bumpRevision = (taskId: string) =>
    sql`
      INSERT INTO scheduled_task_revisions (task_id, revision) VALUES (${taskId}, 1)
      ON CONFLICT (task_id) DO UPDATE SET revision = revision + 1
    `.pipe(Effect.asVoid);
  const dropRevision = (taskId: string) =>
    sql`DELETE FROM scheduled_task_revisions WHERE task_id = ${taskId}`.pipe(Effect.asVoid);
  return {
    /** How many changes this machine made to the routine; 0 before the first. */
    revision,
    revisions: revisions.pipe(quiet("read routine revisions", new Map<string, number>())),
    setRevision,
    bumpRevision,
    dropRevision,
    /** Unreadable counts as none; the callers that must not guess use `readStrict`. */
    read: (taskId: string) => read(taskId).pipe(quiet("read a routine's runner", null)),
    readStrict: read,
    all: all.pipe(quiet("read routine runners", new Map<string, RoutineRunnerRecord>())),
    write,
    remove,
    receipt,
    putReceipt,
    /** Every statement of `effect`, or none. */
    atomically: <A, E>(effect: Effect.Effect<A, E>) => sql.withTransaction(effect),
  } as const;
};
export type RoutineRunnerRecords = ReturnType<typeof makeRunnerRecords>;

/** Whether a routine has a runner at all: one that follows its project's coordinator, and has no URL here. */
export const isRunnerRoutine = (task: Pick<ScheduledTask, "ownThread" | "schedule">) =>
  isCoordinatorOwnedRoutine(task) && task.schedule.type !== "webhook";

/**
 * A machine of the release before answers a request it does not know with 400,
 * and one older still has no such route. Any other failure says nothing about
 * its release.
 */
export const isOlderRelease = (failure: AwayPeerError) =>
  failure.refused && !failure.uncertain && (failure.status === 400 || failure.status === 404);
