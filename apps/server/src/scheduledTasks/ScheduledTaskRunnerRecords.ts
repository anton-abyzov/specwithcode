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
/** Why a copy waits: no machine has yet shown that it is the one that runs the routine. */
export const UNCONFIRMED_RUNNER_WAIT =
  "Waiting: the machines that share this project have not confirmed which one runs this routine.";
export const copyNotRemovedRefusal = (label: string | null) =>
  `Deleted on ${named(label)}. This machine's copy could not be removed yet; it stays off and is removed on its own.`.slice(
    0,
    500,
  );
/** A change to a routine another machine runs that does not say which definition it was made on. */
export const UNSEEN_ROUTINE_EDIT_REFUSAL =
  "This routine runs on another machine, and this change did not say which version of it was shown, so nothing was changed. Reload the routines, or update the app, and try again.";
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
  /**
   * `settling`, `settled`: the machines asked to rest their copies whose answer
   * is not known. One of them may rest already, so it is told to follow the
   * coordinator again whenever the ones that answered are.
   */
  readonly asked?: ReadonlyArray<string> | undefined;
  /**
   * `disarmed`: whether the routine is on at its runner. The copy's own row is
   * off while it rests, so a release before this one never fires it; this is
   * what a person sees, and what the row returns to.
   */
  readonly copyEnabled?: boolean | null | undefined;
  /**
   * `disarmed`: the runner's revision whose definition this copy's row holds,
   * or null when the row was not written from its runner. `revision` alone only
   * says what the runner counted, not that this copy took that definition.
   */
  readonly installedRevision?: number | null | undefined;
  /**
   * `disarmed`: the hash of the definition as its runner sent it, written with
   * the row that took it. This machine may hold that row under its own limits
   * (a lower runtime mode, another sign-in), so the row's own hash is not the
   * runner's; this is what a change made here names. Null when the row was not
   * written from its runner: then the row itself is hashed.
   */
  readonly definitionHash?: string | null | undefined;
}

/** A resting copy whose routine was deleted at its runner and whose own row is still to go. */
export const PENDING_COPY_DELETE = { pendingDelete: true } as const;
export const isPendingCopyDelete = (record: Pick<RoutineRunnerRecord, "state" | "operation">) =>
  record.state === "disarmed" &&
  typeof record.operation === "object" &&
  record.operation !== null &&
  (record.operation as { readonly pendingDelete?: unknown }).pendingDelete === true;

/** Whether the record makes this machine the one that runs the routine. */
export const runsHere = (record: Pick<RoutineRunnerRecord, "state"> | null | undefined) =>
  record != null && (record.state === "settled" || record.state === "settling");

/** Whether the record makes this machine the one that runs or moves the routine. */
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
  readonly asked_json: string;
  readonly copy_enabled: number | null;
  readonly installed_revision: number | null;
  readonly definition_hash: string | null;
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
  const asked = parseJson(row.asked_json);
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    taskId: row.task_id,
    state: row.state as RoutineRunnerState,
    runnerEnvironmentId: row.runner_environment_id,
    runnerLabel: row.runner_label,
    revision: Math.max(0, Math.trunc(row.revision)),
    acked: strings(acked),
    operationId: row.operation_id,
    operation: parseJson(row.operation_json),
    asked: strings(asked),
    copyEnabled: row.copy_enabled === null ? null : row.copy_enabled !== 0,
    installedRevision:
      row.installed_revision === null ? null : Math.max(0, Math.trunc(row.installed_revision)),
    definitionHash: row.definition_hash ?? null,
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
    sql<RecordRow>`
      SELECT r.*, d.definition_hash FROM scheduled_task_runners r
      LEFT JOIN scheduled_task_copy_definitions d ON d.task_id = r.task_id
      WHERE r.task_id = ${taskId}
    `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : recordOf(rows[0]))));
  const all = sql<RecordRow>`
    SELECT r.*, d.definition_hash FROM scheduled_task_runners r
    LEFT JOIN scheduled_task_copy_definitions d ON d.task_id = r.task_id
  `.pipe(
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
    // The record and the hash of what its row took are one write.
    sql.withTransaction(writeRecord(record));
  const writeRecord = (record: RoutineRunnerRecord) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const acked = stringifyJson([...new Set(record.acked)].toSorted());
      const operation = record.operation == null ? null : stringifyJson(record.operation);
      const asked = stringifyJson([...new Set(record.asked ?? [])].toSorted());
      const copyEnabled = record.copyEnabled == null ? null : record.copyEnabled ? 1 : 0;
      yield* sql`
        INSERT INTO scheduled_task_runners (
          task_id, state, runner_environment_id, runner_label, revision,
          acked_json, operation_id, operation_json, updated_at, asked_json, copy_enabled,
          installed_revision
        ) VALUES (
          ${record.taskId}, ${record.state}, ${record.runnerEnvironmentId}, ${record.runnerLabel},
          ${record.revision}, ${acked}, ${record.operationId}, ${operation}, ${now},
          ${asked}, ${copyEnabled}, ${record.installedRevision ?? null}
        )
        ON CONFLICT (task_id) DO UPDATE SET
          state = excluded.state,
          runner_environment_id = excluded.runner_environment_id,
          runner_label = excluded.runner_label,
          revision = excluded.revision,
          acked_json = excluded.acked_json,
          operation_id = excluded.operation_id,
          operation_json = excluded.operation_json,
          updated_at = excluded.updated_at,
          asked_json = excluded.asked_json,
          copy_enabled = excluded.copy_enabled,
          installed_revision = excluded.installed_revision
      `;
      if (record.definitionHash == null)
        yield* sql`DELETE FROM scheduled_task_copy_definitions WHERE task_id = ${record.taskId}`;
      else
        yield* sql`
          INSERT INTO scheduled_task_copy_definitions (task_id, definition_hash)
          VALUES (${record.taskId}, ${record.definitionHash})
          ON CONFLICT (task_id) DO UPDATE SET definition_hash = excluded.definition_hash
        `;
    });
  const remove = (taskId: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM scheduled_task_runners WHERE task_id = ${taskId}`;
        yield* sql`DELETE FROM scheduled_task_copy_definitions WHERE task_id = ${taskId}`;
      }),
    );
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
  /** The line a person reads under the routine; null clears it. */
  const setNote = (taskId: string, note: string | null) =>
    sql`UPDATE scheduled_tasks SET last_run_error = ${note} WHERE task_id = ${taskId}`.pipe(
      Effect.asVoid,
    );
  /**
   * Turns the row on or off and nothing else: the slot it is due at and its
   * one-time generation stay. A copy that rests, or follows the coordinator
   * again, was not armed anew by a person.
   */
  const setRowEnabled = (taskId: string, enabled: boolean) =>
    sql`UPDATE scheduled_tasks SET enabled = ${enabled ? 1 : 0} WHERE task_id = ${taskId}`.pipe(
      Effect.asVoid,
    );
  /** The slot the row is due at, and nothing else. */
  const setSlot = (taskId: string, nextRunAt: string | null) =>
    sql`UPDATE scheduled_tasks SET next_run_at = ${nextRunAt} WHERE task_id = ${taskId}`.pipe(
      Effect.asVoid,
    );
  const dropRevision = (taskId: string) =>
    sql`DELETE FROM scheduled_task_revisions WHERE task_id = ${taskId}`.pipe(Effect.asVoid);
  return {
    /** How many changes this machine made to the routine; 0 before the first. */
    revision,
    revisions: revisions.pipe(quiet("read routine revisions", new Map<string, number>())),
    /** Fails when the counts cannot be read: for a read that must not guess. */
    revisionsStrict: revisions,
    setRevision,
    setRowEnabled,
    setSlot,
    bumpRevision,
    dropRevision,
    setNote,
    /** Unreadable counts as none; the callers that must not guess use `readStrict`. */
    read: (taskId: string) => read(taskId).pipe(quiet("read a routine's runner", null)),
    readStrict: read,
    all: all.pipe(quiet("read routine runners", new Map<string, RoutineRunnerRecord>())),
    /** Fails when the records cannot be read: for a read where none is not a safe guess. */
    allStrict: all,
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
