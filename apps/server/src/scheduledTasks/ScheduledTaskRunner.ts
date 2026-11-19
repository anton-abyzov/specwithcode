/**
 * One durable runner per routine (1390 AC-45, EC-08, EC2-06).
 *
 * Every machine that has a project may run its own coordinator, so "the
 * machine that coordinates" no longer picks the one copy of a routine that
 * fires. Each routine instead has a runner record: the machine that runs it,
 * and the revision of its definition there. A coordinator change or a thread
 * handoff never moves it.
 *
 * The record is all or nothing across a project's machines. A release before
 * this one keeps a turned-on copy of a coordinator's routines and fires it
 * the moment that machine coordinates, so a runner that fired regardless of
 * the coordinator would fire the same due slot twice. Hence:
 *
 * - No record: the routine runs exactly as before, under the coordinator gate
 *   (ScheduledTaskCoordinatorGate). That is every routine until its project's
 *   machines agree.
 * - The machine that runs a routine today (its coordinator gate lets it fire)
 *   asks every other linked machine to rest its copy (`runner-disarm`). Only
 *   when all of them answered that they did does it record itself `settled`
 *   and fire whatever the coordinator binding says. A machine that cannot
 *   answer (an older release) keeps the old rule in force for everyone, and
 *   the machines that already rested are told to follow the coordinator again.
 * - `disarmed`: another machine runs it. This copy never fires and is never
 *   changed here: a change goes to the runner, with the revision it was made
 *   against, and the runner refuses a stale one.
 * - `staged` and `moving`: an explicit runner move is in flight
 *   (ScheduledTaskTransfer); nothing fires and nothing changes until it ends.
 *
 * A webhook routine never has a record: its URL and secret are this
 * machine's. A routine bound to a worker thread that was handed off rests
 * with a note naming the machine; moving the routine is a separate, explicit act.
 */
import {
  type CoordinatorRoutineCopy,
  type ProjectId,
  type ScheduledTask,
  type ScheduledTaskDeleteInput,
  type ScheduledTaskDeleteResult,
  type ScheduledTaskError,
  type ScheduledTaskGrantedBy,
  ScheduledTaskId,
  type ScheduledTaskListResult,
  type ScheduledTaskMutationResult,
  type ScheduledTaskSetEnabledInput,
  ScheduledTaskUpsertInput,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/sql/SqlClient";

import type { AwayPeerError } from "../away/awayPeerCall.ts";
import { accountInGrant, projectInGrant } from "../fleet/workGrantPolicy.ts";
import { parseJson as readJson, stringifyJson } from "../json.ts";
import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { othersRoutineRefusal } from "../mcp/routineOwnership.ts";
import type * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  HANDOFF_ROUTINE_WAIT,
  HANDOVER_ROUTINE_CHANGE_REFUSAL,
  RESTING_ROUTINE_CHANGE_REFUSAL,
  type RoutineCoordinatorHold,
} from "./ScheduledTaskCoordinatorGate.ts";
import { isCoordinatorOwnedRoutine, routineCopyOf } from "./ScheduledTaskCopies.ts";
import {
  affirmsRunner,
  refuseTransfer,
  ROUTINE_RUNNER_CAPABILITY,
  type RoutineRunnerEdit,
  type RoutineRunnerRequest,
  type RoutineRunnerResponse,
  type RoutineTransferRefusal,
} from "./ScheduledTaskRunnerWire.ts";
import { taskError } from "./ScheduledTaskStorage.ts";

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

// --- the runner ------------------------------------------------------------------------

type GateTask = Pick<ScheduledTask, "projectId" | "ownThread" | "schedule"> & {
  readonly id?: ScheduledTask["id"] | undefined;
  readonly threadId?: ScheduledTask["threadId"] | undefined;
};

/** How this machine reaches another one's routines route; set once the fleet is up. */
export interface RoutineRunnerPeers {
  readonly post: (
    target: string,
    request: RoutineRunnerRequest,
  ) => Effect.Effect<RoutineRunnerResponse, AwayPeerError>;
  readonly label: (environmentId: string) => Effect.Effect<string | null>;
}

export interface RoutineRunnerDeps {
  readonly sql: SqlClient.SqlClient;
  /** The coordinator gate of the release before runners (ScheduledTaskCoordinatorGate). */
  readonly legacyHold: (
    task: Pick<ScheduledTask, "projectId" | "ownThread" | "schedule">,
  ) => Effect.Effect<RoutineCoordinatorHold | null>;
  readonly projects: ProjectStore.ProjectStoreV2["Service"];
  /** Whether this machine's copy of the project coordinates it now. */
  readonly roleActive: (projectId: ProjectId) => Effect.Effect<boolean>;
  /** This machine, or null on a host with no identity (then nothing is settled with peers). */
  readonly selfEnvironmentId: Effect.Effect<string | null>;
  /** The machine a thread was handed off to, when this copy of it no longer runs. */
  readonly threadMovedTo: (threadId: string) => Effect.Effect<string | null>;
  readonly findTask: (
    id: ScheduledTaskId,
  ) => Effect.Effect<ScheduledTask | null, ScheduledTaskError>;
  readonly listTasks: Effect.Effect<ReadonlyArray<ScheduledTask>, ScheduledTaskError>;
  /** The scheduler's own writes, which no runner rule guards. */
  readonly upsert: (
    input: ScheduledTaskUpsertInput,
    options?: { readonly grantedBy?: ScheduledTaskGrantedBy | null | undefined },
  ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
  readonly setEnabled: (
    input: ScheduledTaskSetEnabledInput,
  ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
  readonly remove: (
    input: ScheduledTaskDeleteInput,
  ) => Effect.Effect<ScheduledTaskDeleteResult, ScheduledTaskError>;
  readonly readGrant: (
    id: ScheduledTaskId,
  ) => Effect.Effect<ScheduledTaskGrantedBy | undefined, ScheduledTaskError>;
  readonly notifyChanged: Effect.Effect<void>;
  /** A new random id, for a move's operation. */
  readonly newId: Effect.Effect<string>;
}

/** How often this machine asks its peers again about routines not settled yet. */
const SETTLE_RETRY_MS = 60_000;
/**
 * How often a server looks for routines to settle with the other machines,
 * at the earliest. The look starts after a pass over due routines, on a fiber
 * of its own: it waits on other machines, and the scheduler's sources take
 * turns on a fixed beat. Null (a test that settles by hand) never looks.
 */
export class RoutineRunnerPace extends Context.Reference<{ readonly everyMs: number | null }>(
  "specweave-studio/scheduledTasks/RoutineRunnerPace",
  { defaultValue: () => ({ everyMs: 30_000 }) },
) {}

const decodeUpsert = Schema.decodeUnknownOption(ScheduledTaskUpsertInput);

const isRunnerRoutine = (task: Pick<ScheduledTask, "ownThread" | "schedule">) =>
  isCoordinatorOwnedRoutine(task) && task.schedule.type !== "webhook";

export const makeRoutineRunner = (deps: RoutineRunnerDeps) =>
  Effect.gen(function* () {
    const { sql } = deps;
    const records = makeRunnerRecords(sql);
    const peersRef = yield* Ref.make<RoutineRunnerPeers | null>(null);
    // One change at a time: the revision check, the change and the bump are one step.
    const lock = yield* Semaphore.make(1);
    // One settling pass at a time; it takes `lock` only around its own writes.
    const settling = yield* Semaphore.make(1);
    const writing = <A, E>(effect: Effect.Effect<A, E>) => lock.withPermits(1)(effect);
    /** The revision each routine's resting copies last heard, since this server started. */
    const pushed = new Map<string, number>();
    const lastAsked = new Map<string, number>();

    /** The project's other machines, or null when this machine cannot tell itself apart. */
    const othersOf = (projectId: ProjectId) =>
      Effect.gen(function* () {
        const row = yield* deps.projects
          .get(projectId)
          .pipe(Effect.orElseSucceed(() => Option.none<ProjectStore.ProjectRow>()));
        if (Option.isNone(row)) return null;
        const members = row.value.workspaceSettings?.logicalProject?.members ?? [];
        if (members.length === 0) return [] as ReadonlyArray<string>;
        const self = yield* deps.selfEnvironmentId;
        if (self === null) return null;
        return [
          ...new Set(
            members
              .filter((member) => member.environmentId !== self)
              .map((member) => member.environmentId as string),
          ),
        ];
      });

    /** Whether every other machine of the project rests its copy of this routine. */
    const covered = (record: RoutineRunnerRecord, projectId: ProjectId) =>
      othersOf(projectId).pipe(
        Effect.map(
          (others) => others !== null && others.every((member) => record.acked.includes(member)),
        ),
      );

    // --- the gate ----------------------------------------------------------------------

    const hold = (task: GateTask): Effect.Effect<RoutineCoordinatorHold | null> =>
      Effect.gen(function* () {
        // A webhook routine stays with the machine its URL points to, and has no record.
        if (task.schedule.type === "webhook") return null;
        const record = task.id === undefined ? null : yield* records.readStrict(task.id);
        if (record !== null) {
          if (record.state === "disarmed")
            return { kind: "rest", note: runsElsewhereNote(record.runnerLabel) } as const;
          if (record.state === "staged" || record.state === "moving")
            return { kind: "wait", reason: MOVING_ROUTINE_WAIT } as const;
        }
        if (!isCoordinatorOwnedRoutine(task)) {
          if (task.threadId != null) {
            const movedTo = yield* deps.threadMovedTo(task.threadId);
            if (movedTo !== null)
              return { kind: "rest", note: threadHandedOffNote(movedTo) } as const;
          }
          return null;
        }
        if (
          record !== null &&
          record.state === "settled" &&
          (yield* covered(record, task.projectId))
        )
          return null;
        // Not every machine confirmed: exactly the rule of the release before.
        return yield* deps.legacyHold(task);
      }).pipe(
        // Unknown never fires: a copy that cannot read its runner waits for the next poll.
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not read a routine's runner", { cause }).pipe(
            Effect.as({ kind: "wait", reason: "Waiting: its runner could not be read." } as const),
          ),
        ),
      );

    // --- settling with the other machines ------------------------------------------------

    const selfRecord = (
      taskId: string,
      self: string | null,
      previous: RoutineRunnerRecord | null,
      acked: ReadonlyArray<string>,
      state: "settling" | "settled",
    ): RoutineRunnerRecord => ({
      taskId,
      state,
      runnerEnvironmentId: self ?? "",
      runnerLabel: null,
      revision: previous?.revision ?? 0,
      acked,
      operationId: null,
      operation: null,
    });

    /**
     * Records what the other machines confirmed, and `settled` once all of them
     * did. Read again under the lock, and only while this machine still runs the
     * routine under the coordinator rule: one that stopped coordinating meanwhile
     * never becomes the runner over the machine that fires it now.
     */
    const settleIfStillClaimed = (
      task: ScheduledTask,
      self: string | null,
      others: ReadonlyArray<string>,
      added: ReadonlyArray<string>,
    ) =>
      writing(
        Effect.gen(function* () {
          const record = yield* records.read(task.id);
          if (record !== null && !runsHere(record)) return;
          const acked = [...new Set([...(record?.acked ?? []), ...added])];
          const complete = others.every((member) => acked.includes(member));
          if (record?.state !== "settled" && (yield* deps.legacyHold(task)) !== null) {
            // Kept as confirmed so far; the next pass frees these machines again.
            if (acked.length > 0)
              yield* records.write(selfRecord(task.id, self, record, acked, "settling"));
            return;
          }
          yield* records.write(
            selfRecord(task.id, self, record, acked, complete ? "settled" : "settling"),
          );
          yield* deps.notifyChanged;
        }),
      );

    /** Tells the machines that already rest their copies to follow the coordinator again. */
    const rearm = (peers: RoutineRunnerPeers, task: ScheduledTask, record: RoutineRunnerRecord) =>
      Effect.gen(function* () {
        // First, this machine stops firing as the runner: back under the coordinator gate.
        if (record.state === "settled")
          yield* writing(
            Effect.gen(function* () {
              const now = yield* records.read(task.id);
              if (now?.state === "settled") yield* records.write({ ...now, state: "settling" });
            }),
          );
        const freed: Array<string> = [];
        for (const member of record.acked) {
          const told = yield* peers
            .post(member, { op: "runner-rearm", routineIds: [task.id] })
            .pipe(Effect.result);
          if (told._tag === "Success" || isOlderRelease(told.failure)) freed.push(member);
        }
        yield* writing(
          Effect.gen(function* () {
            const now = yield* records.read(task.id);
            if (now === null || !runsHere(now)) return;
            const acked = now.acked.filter((entry) => !freed.includes(entry));
            if (acked.length === 0) yield* records.remove(task.id);
            else yield* records.write({ ...now, state: "settling", acked });
          }),
        );
      });

    /**
     * Settling asks other machines, each for up to half a minute, so it never
     * holds this machine's change lock while it asks: only while it writes, and
     * every write reads the record again first.
     */
    const reconcileOnce = (force: boolean) =>
      Effect.gen(function* () {
        const self = yield* deps.selfEnvironmentId;
        const tasks = (yield* deps.listTasks).filter(isRunnerRoutine);
        if (tasks.length === 0) return;
        const all = yield* records.all;
        const counts = yield* records.revisions;
        const peers = yield* Ref.get(peersRef);
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const byProject = new Map<string, Array<ScheduledTask>>();
        for (const task of tasks)
          byProject.set(task.projectId, [...(byProject.get(task.projectId) ?? []), task]);
        for (const [projectId, owned] of byProject) {
          const others = yield* othersOf(projectId as ProjectId);
          // A project no other machine shares has nothing to settle: it runs as it did.
          if (others === null || others.length === 0) continue;
          const need = new Map<string, Array<ScheduledTask>>();
          /** Routines this machine runs whose resting copies have not heard their latest revision. */
          const stale = new Map<string, Array<ScheduledTask>>();
          for (const task of owned) {
            const record = all.get(task.id) ?? null;
            if (record !== null && !runsHere(record)) continue;
            // Only the machine that runs it today claims it, or goes on claiming it.
            if (record?.state !== "settled") {
              const held = yield* deps.legacyHold(task);
              if (held !== null) {
                // It stopped coordinating before every machine confirmed: the machines
                // that already rest their copies follow the coordinator again.
                if (record !== null && held.kind === "rest" && peers !== null)
                  yield* rearm(peers, task, record);
                continue;
              }
            }
            const missing = others.filter((member) => !(record?.acked ?? []).includes(member));
            if (missing.length === 0) {
              if (record?.state !== "settled") yield* settleIfStillClaimed(task, self, others, []);
              else if ((counts.get(task.id) ?? 0) !== pushed.get(task.id))
                for (const member of others)
                  stale.set(member, [...(stale.get(member) ?? []), task]);
              continue;
            }
            for (const member of missing) need.set(member, [...(need.get(member) ?? []), task]);
          }
          if (peers !== null && stale.size > 0) {
            const reached = new Map<string, number>();
            for (const [member, list] of stale) {
              const told = yield* peers
                .post(member, {
                  op: "runner-disarm",
                  sourceProjectId: projectId,
                  routineIds: list.map((task) => task.id),
                  revisions: list.map((task) => counts.get(task.id) ?? 0),
                })
                .pipe(Effect.result);
              if (told._tag === "Success")
                for (const id of told.success.acked ?? [])
                  reached.set(id, (reached.get(id) ?? 0) + 1);
            }
            for (const task of new Set([...stale.values()].flat()))
              if (reached.get(task.id) === others.length)
                pushed.set(task.id, counts.get(task.id) ?? 0);
          }
          if (need.size === 0 || peers === null) continue;
          if (
            !force &&
            now - (lastAsked.get(projectId) ?? Number.NEGATIVE_INFINITY) < SETTLE_RETRY_MS
          )
            continue;
          lastAsked.set(projectId, now);
          // First every machine says it keeps runner records. One that says no keeps
          // the old rule for all of them; one that does not answer is asked again later.
          let old = false;
          let silent = false;
          for (const member of need.keys()) {
            const asked = yield* peers.post(member, { op: "status" }).pipe(Effect.result);
            if (asked._tag === "Success") {
              if (!affirmsRunner(asked.success)) old = true;
            } else if (isOlderRelease(asked.failure)) old = true;
            else silent = true;
          }
          if (old) {
            for (const task of new Set([...need.values()].flat())) {
              const record = all.get(task.id);
              if (record !== undefined && runsHere(record)) yield* rearm(peers, task, record);
            }
            yield* deps.notifyChanged;
            continue;
          }
          if (silent) continue;
          const ackedNow = new Map<string, Array<string>>();
          for (const [member, list] of need) {
            const answered = yield* peers
              .post(member, {
                op: "runner-disarm",
                sourceProjectId: projectId,
                routineIds: list.map((task) => task.id),
                revisions: list.map((task) => counts.get(task.id) ?? 0),
              })
              .pipe(Effect.result);
            if (answered._tag === "Failure") continue;
            for (const id of answered.success.acked ?? [])
              ackedNow.set(id, [...(ackedNow.get(id) ?? []), member]);
          }
          for (const task of owned) {
            const added = ackedNow.get(task.id);
            if (added === undefined) continue;
            yield* settleIfStillClaimed(task, self, others, added);
          }
          yield* deps.notifyChanged;
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not settle routine runners", { cause }),
        ),
      );

    /** Settles what can be settled now; `force` skips the wait between asks (tests, a new routine). */
    const reconcile = (options?: { readonly force?: boolean }) =>
      settling.withPermits(1)(reconcileOnce(options?.force === true));

    /** One paced look. Nothing to do until this machine can reach the others. */
    const tick = Effect.gen(function* () {
      if ((yield* Ref.get(peersRef)) === null) return;
      yield* reconcile();
    });

    /**
     * A look at most every `everyMs`, started by the caller after a due pass. On a
     * fiber of its own: it waits on other machines, and a due pass never waits on it.
     */
    const pacedLook = (everyMs: number) =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const looks = { last: Number.NEGATIVE_INFINITY, running: false };
        return Effect.gen(function* () {
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          if (looks.running || now - looks.last < everyMs) return;
          looks.last = now;
          looks.running = true;
          yield* tick.pipe(
            Effect.ensuring(Effect.sync(() => void (looks.running = false))),
            Effect.forkIn(scope),
          );
        });
      });

    // --- changes -------------------------------------------------------------------------

    /** Whether a resting routine is a copy the coordinator sent here (see the scheduler's `onRunner`). */
    const isCoordinatorCopy = (id: ScheduledTaskId, logicalProjectId: string | null | undefined) =>
      sql<{ readonly copied: string | null }>`
        SELECT json_extract(run_policy_json, '$.copiedFrom') AS copied
        FROM scheduled_tasks WHERE task_id = ${id}
      `.pipe(
        // A mark left by an earlier shared project is not this coordinator's copy.
        Effect.map((rows) => {
          const copied = rows[0]?.copied ?? null;
          return copied !== null && (logicalProjectId == null || copied === logicalProjectId);
        }),
        // Unknown counts as a copy: the refusal stands.
        Effect.orElseSucceed(() => true),
      );

    type Target =
      | { readonly id: ScheduledTaskId }
      | Pick<ScheduledTask, "projectId" | "ownThread" | "schedule">;

    /** The release-before rule for a routine with no runner: changed only where it coordinates. */
    const legacyRefusal = (target: Target, ownRemovable: boolean) =>
      Effect.gen(function* () {
        const task = "id" in target ? yield* deps.findTask(target.id) : target;
        const held = task === null ? null : yield* deps.legacyHold(task);
        if (
          held?.kind === "rest" &&
          ownRemovable &&
          "id" in target &&
          !(yield* isCoordinatorCopy(target.id, held.logicalProjectId))
        )
          return null;
        return held?.kind === "rest"
          ? RESTING_ROUTINE_CHANGE_REFUSAL
          : held?.kind === "wait" && held.reason === HANDOFF_ROUTINE_WAIT
            ? HANDOVER_ROUTINE_CHANGE_REFUSAL
            : null;
      });

    const revisionFailed = (cause: unknown) =>
      taskError("Could not read or record the routine's revision.", { cause });
    const bump = (taskId: string) =>
      records.bumpRevision(taskId).pipe(Effect.mapError(revisionFailed));
    /**
     * The revision a change must have been made against: the runner's, as this
     * copy last heard it, where another machine runs the routine; this
     * machine's own count everywhere else.
     */
    const revisionOf = (taskId: string, record: RoutineRunnerRecord | null) =>
      record?.state === "disarmed"
        ? Effect.succeed(record.revision)
        : records.revision(taskId).pipe(Effect.mapError(revisionFailed));

    /** The copy as this machine keeps it after its runner changed it. */
    const keepCopy = (existing: ScheduledTask, copy: CoordinatorRoutineCopy) =>
      Effect.gen(function* () {
        const input = decodeUpsert({
          id: existing.id,
          title: copy.title,
          prompt: copy.prompt,
          enabled: copy.enabled,
          schedule: copy.schedule,
          projectId: existing.projectId,
          threadId: existing.threadId,
          workspaceStrategy: copy.workspaceStrategy,
          modelSelection: copy.modelSelection,
          runtimeMode: copy.runtimeMode,
          interactionMode: copy.interactionMode,
          createdBy: copy.createdBy,
          creationSource: "server",
          modelPinned: copy.modelPinned ?? false,
          check: copy.check ?? null,
          brief: copy.brief ?? null,
          ownThread: existing.ownThread === true,
        });
        if (Option.isNone(input)) return;
        yield* deps.upsert(input.value);
      }).pipe(
        // The runner has the change; this copy catches up with its next replica.
        Effect.catch((cause) =>
          Effect.logWarning("Could not keep a routine's copy after its runner changed it", {
            cause,
          }),
        ),
      );

    /**
     * Tells every machine that rests its copy of a routine this machine runs
     * that it is deleted. Returns the machines that did not confirm.
     */
    const tellDeleted = (record: RoutineRunnerRecord, id: ScheduledTaskId, except: string | null) =>
      Effect.gen(function* () {
        const peers = yield* Ref.get(peersRef);
        const unreached: Array<string> = [];
        for (const member of record.acked) {
          if (member === except) continue;
          const told =
            peers === null
              ? null
              : yield* peers
                  .post(member, { op: "runner-rearm", routineIds: [id], deleted: true })
                  .pipe(Effect.result);
          if (told === null || (told._tag === "Failure" && !isOlderRelease(told.failure)))
            unreached.push((peers === null ? null : yield* peers.label(member)) ?? member);
        }
        return unreached;
      });

    /** Sends a change to the runner. Nothing is written here unless the runner made it. */
    const forward = (
      record: RoutineRunnerRecord,
      existing: ScheduledTask,
      edit: RoutineRunnerEdit,
      expectedRevision: number | undefined,
    ) =>
      Effect.gen(function* () {
        const peers = yield* Ref.get(peersRef);
        if (peers === null)
          return yield* taskError(
            runsElsewhereRefusal(record.runnerLabel, "this machine cannot reach it yet"),
            { taskId: existing.id },
          );
        const answered = yield* peers
          .post(record.runnerEnvironmentId, {
            op: "runner-edit",
            routineId: existing.id,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
            edit,
          })
          .pipe(Effect.result);
        if (answered._tag === "Failure")
          return yield* taskError(
            runsElsewhereRefusal(record.runnerLabel, answered.failure.message),
            { taskId: existing.id },
          );
        const answer = answered.success;
        if (affirmsRunner(answer) && answer.stale === true) {
          // Not made. This copy now shows what the runner holds, and its revision,
          // so the change can be made again against it.
          if (answer.copy != null) yield* keepCopy(existing, answer.copy);
          if (answer.revision !== undefined)
            yield* records.write({ ...record, revision: answer.revision }).pipe(Effect.ignore);
          yield* deps.notifyChanged;
          return yield* taskError(STALE_ROUTINE_EDIT_REFUSAL, { taskId: existing.id });
        }
        if (!affirmsRunner(answer) || answer.revision === undefined)
          return yield* taskError(
            runsElsewhereRefusal(record.runnerLabel, "it sent an answer this version cannot read"),
            { taskId: existing.id },
          );
        if (answer.copy == null) {
          yield* deps.remove({ id: existing.id }).pipe(Effect.ignore);
          yield* records.remove(existing.id).pipe(Effect.ignore);
          return null;
        }
        yield* keepCopy(existing, answer.copy);
        yield* records.write({ ...record, revision: answer.revision }).pipe(Effect.ignore);
        return yield* deps.findTask(existing.id);
      });

    /**
     * One public change to routines, judged before it is made. `forwarded`
     * builds the change for the runner when this machine only keeps a copy.
     */
    const guard = <A>(input: {
      readonly targets: ReadonlyArray<Target>;
      readonly change: Effect.Effect<A, ScheduledTaskError>;
      readonly ownRemovable?: boolean | undefined;
      readonly expectedRevision?: number | undefined;
      /** Runs once the change is allowed, before it is made; a failure calls it off. */
      readonly before?: Effect.Effect<void, ScheduledTaskError> | undefined;
      readonly forwarded?:
        | ((existing: ScheduledTask) => {
            readonly edit: RoutineRunnerEdit;
            readonly done: (task: ScheduledTask | null) => A;
          })
        | undefined;
    }): Effect.Effect<A, ScheduledTaskError> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const bumped: Array<string> = [];
          /** Projects of routines this machine runs whatever the coordinator binding says. */
          const runnerProjects = new Set<string>();
          for (const target of input.targets) {
            const record = "id" in target ? yield* records.read(target.id) : null;
            if (record !== null && "id" in target) {
              if (record.state === "staged" || record.state === "moving")
                return yield* taskError(MOVING_ROUTINE_CHANGE_REFUSAL, { taskId: target.id });
              if (record.state === "disarmed") {
                const existing = yield* deps.findTask(target.id);
                if (existing !== null && input.forwarded !== undefined) {
                  const { edit, done } = input.forwarded(existing);
                  const task = yield* forward(record, existing, edit, input.expectedRevision);
                  yield* deps.notifyChanged;
                  return done(task);
                }
                // A copy that lost its row has nothing to change here.
                if (existing !== null)
                  return yield* taskError(
                    runsElsewhereRefusal(record.runnerLabel, "it can only be changed there"),
                    { taskId: target.id },
                  );
              }
            }
            if ("id" in target) {
              if (
                input.expectedRevision !== undefined &&
                input.expectedRevision !== (yield* revisionOf(target.id, record))
              )
                return yield* taskError(STALE_ROUTINE_EDIT_REFUSAL, { taskId: target.id });
              bumped.push(target.id);
              if (record?.state === "settled") {
                // Every other machine rests its copy: the coordinator no longer decides.
                const existing = yield* deps.findTask(target.id);
                if (existing !== null && (yield* covered(record, existing.projectId))) {
                  runnerProjects.add(existing.projectId);
                  continue;
                }
              }
            }
            // A save of such a routine in its own project is the runner's to make.
            if (!("id" in target) && runnerProjects.has(target.projectId)) continue;
            const refusal = yield* legacyRefusal(target, input.ownRemovable === true);
            if (refusal !== null)
              return yield* taskError(refusal, {
                ...("id" in target ? { taskId: target.id } : {}),
              });
          }
          if (input.before !== undefined) yield* input.before;
          const result = yield* input.change;
          for (const id of bumped) yield* bump(id);
          return result;
        }),
      );

    const guardUpsert = (
      input: ScheduledTaskUpsertInput,
      change: Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>,
    ) =>
      guard({
        targets: [
          ...(input.id === undefined ? [] : [{ id: input.id }]),
          {
            projectId: input.projectId,
            // An unbound routine runs in a thread of its own (asOwnThreadRoutine). A
            // webhook routine never travels, so it is never held: only the kind matters.
            ownThread:
              (input.ownThread === true || input.threadId == null) &&
              input.schedule.type !== "webhook",
            schedule: { type: "manual" },
          },
        ],
        change,
        expectedRevision: input.expectedRevision,
        forwarded: (existing) => ({
          edit: {
            kind: "save",
            routine: {
              id: existing.id,
              title: input.title,
              prompt: input.prompt,
              enabled: input.enabled,
              schedule: input.schedule as CoordinatorRoutineCopy["schedule"],
              workspaceStrategy: input.workspaceStrategy,
              modelSelection: input.modelSelection,
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              createdBy: input.createdBy ?? existing.createdBy,
              ...(input.modelPinned === undefined
                ? existing.modelPinned === undefined
                  ? {}
                  : { modelPinned: existing.modelPinned }
                : { modelPinned: input.modelPinned }),
              check: input.check === undefined ? (existing.check ?? null) : input.check,
              brief: input.brief === undefined ? (existing.brief ?? null) : input.brief,
            },
          },
          done: (task) => ({ task: task ?? existing }),
        }),
      });

    const guardSetEnabled = (
      input: ScheduledTaskSetEnabledInput,
      change: Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>,
    ) =>
      guard({
        targets: [{ id: input.id }],
        change,
        ownRemovable: !input.enabled,
        expectedRevision: input.expectedRevision,
        forwarded: (existing) => ({
          edit: { kind: "enabled", enabled: input.enabled },
          done: (task) => ({ task: task ?? { ...existing, enabled: input.enabled } }),
        }),
      });

    const guardDelete = (
      input: ScheduledTaskDeleteInput,
      change: Effect.Effect<ScheduledTaskDeleteResult, ScheduledTaskError>,
    ) =>
      guard({
        targets: [{ id: input.id }],
        change,
        ownRemovable: true,
        expectedRevision: input.expectedRevision,
        // The copies that rest for it go first: one left behind would come back with a replica.
        before: Effect.gen(function* () {
          const record = yield* records.read(input.id);
          if (record === null || !runsHere(record)) return;
          const unreached = yield* tellDeleted(record, input.id, null);
          if (unreached.length > 0)
            return yield* taskError(deleteUnreachedRefusal(unreached), { taskId: input.id });
        }),
        forwarded: () => ({ edit: { kind: "delete" }, done: () => ({ id: input.id }) }),
      }).pipe(
        Effect.tap(() => records.remove(input.id).pipe(Effect.ignore)),
        Effect.tap(() => records.dropRevision(input.id).pipe(Effect.ignore)),
      );

    /** The list with each routine's runner, for the machines that show it. */
    const decorate = (listed: ScheduledTaskListResult): Effect.Effect<ScheduledTaskListResult> =>
      Effect.gen(function* () {
        const all = yield* records.all;
        const counts = yield* records.revisions;
        return {
          tasks: listed.tasks.map((task) => {
            const record = all.get(task.id);
            const revision =
              record?.state === "disarmed" ? record.revision : (counts.get(task.id) ?? 0);
            if (record === undefined || record.state === "settling") return { ...task, revision };
            return {
              ...task,
              revision,
              runner: {
                environmentId: record.runnerEnvironmentId,
                label: record.runnerLabel,
                revision,
                here: record.state === "settled" || record.state === "moving",
              },
            };
          }),
        };
      });

    // --- another machine asks --------------------------------------------------------------

    const base = { capabilities: [ROUTINE_RUNNER_CAPABILITY] } as const;

    /** This machine's linked copy of the caller's project, within the caller's grant. */
    const linkedProject = (caller: ReceiverCaller, sourceProjectId: string) =>
      Effect.gen(function* () {
        const grant = caller.grant;
        if (grant === null || grant.revoked)
          return yield* refuseTransfer(
            403,
            "This machine does not let that machine run work here.",
          );
        if (!grant.routines && grant.legacy !== true)
          return yield* refuseTransfer(
            403,
            "This machine does not let that machine's coordinator manage routines. Turn on Routines for it in Settings > Machines > Who can run work here.",
          );
        const rows = yield* deps.projects.list().pipe(Effect.orElseSucceed(() => []));
        const row = rows.find(
          (entry) =>
            entry.deletedAt === null &&
            (entry.workspaceSettings?.logicalProject?.members ?? []).some(
              (member) =>
                member.environmentId === caller.sourceEnvironmentId &&
                member.projectId === sourceProjectId,
            ),
        );
        if (row === undefined)
          return yield* refuseTransfer(
            404,
            "This project has no linked copy on this machine. Link it first.",
          );
        if (
          !projectInGrant(grant.projects, caller.sourceEnvironmentId, {
            id: row.projectId,
            workspaceSettings: row.workspaceSettings,
          })
        )
          return yield* refuseTransfer(
            403,
            "This machine's work grant for that machine leaves this project out.",
          );
        return row;
      });

    const disarm = (
      caller: ReceiverCaller,
      request: Extract<RoutineRunnerRequest, { op: "runner-disarm" }>,
    ) =>
      Effect.gen(function* () {
        const project = yield* linkedProject(caller, request.sourceProjectId);
        const self = yield* deps.selfEnvironmentId;
        const coordinates = yield* deps.roleActive(project.projectId);
        const peers = yield* Ref.get(peersRef);
        const label =
          request.runnerLabel ??
          (peers === null ? null : yield* peers.label(caller.sourceEnvironmentId));
        const acked: Array<ScheduledTaskId> = [];
        const refused: Array<ScheduledTaskId> = [];
        // Both machines may coordinate and both may claim: the lower id keeps a routine it runs.
        const winsTie = self !== null && self < caller.sourceEnvironmentId;
        for (const [index, id] of request.routineIds.entries()) {
          const held = yield* deps.findTask(id).pipe(Effect.orElseSucceed(() => null));
          if (held !== null && held.projectId !== project.projectId) {
            refused.push(id);
            continue;
          }
          // Only a routine that follows its project's coordinator has a runner to settle.
          if (held !== null && !isRunnerRoutine(held)) {
            refused.push(id);
            continue;
          }
          const record = yield* records.read(id);
          const runsItToday =
            held !== null &&
            held.enabled &&
            isRunnerRoutine(held) &&
            coordinates &&
            (yield* deps.legacyHold(held)) === null;
          if (
            record !== null &&
            (record.state === "settled" || record.state === "staged" || record.state === "moving")
          ) {
            refused.push(id);
            continue;
          }
          if (runsItToday && winsTie) {
            refused.push(id);
            continue;
          }
          yield* records.write({
            taskId: id,
            state: "disarmed",
            runnerEnvironmentId: caller.sourceEnvironmentId,
            runnerLabel: label,
            // The runner's revision, so a change made on this copy is made against it.
            revision: request.revisions?.[index] ?? record?.revision ?? 0,
            acked: [],
            operationId: null,
            operation: null,
          });
          acked.push(id);
        }
        yield* deps.notifyChanged;
        return { ...base, acked, refused } satisfies RoutineRunnerResponse;
      });

    const rearmHere = (
      caller: ReceiverCaller,
      request: Extract<RoutineRunnerRequest, { op: "runner-rearm" }>,
    ) =>
      Effect.gen(function* () {
        for (const id of request.routineIds) {
          const record = yield* records.read(id);
          if (
            record?.state === "disarmed" &&
            record.runnerEnvironmentId === caller.sourceEnvironmentId
          ) {
            if (request.deleted === true) {
              yield* deps.remove({ id }).pipe(Effect.ignore);
              yield* records.dropRevision(id).pipe(Effect.ignore);
            }
            yield* records.remove(id);
          }
        }
        yield* deps.notifyChanged;
        return { ...base, acked: [...request.routineIds] } satisfies RoutineRunnerResponse;
      });

    /** A change a copy's machine sends: made here only by the runner, against the revision it names. */
    const editHere = (
      caller: ReceiverCaller,
      request: Extract<RoutineRunnerRequest, { op: "runner-edit" }>,
    ) =>
      Effect.gen(function* () {
        const grant = caller.grant;
        if (grant === null || grant.revoked)
          return yield* refuseTransfer(
            403,
            "This machine does not let that machine run work here.",
          );
        if (!grant.routines && grant.legacy !== true)
          return yield* refuseTransfer(
            403,
            "This machine does not let that machine's coordinator manage routines. Turn on Routines for it in Settings > Machines > Who can run work here.",
          );
        const task = yield* deps
          .findTask(request.routineId)
          .pipe(Effect.mapError(() => refuseTransfer(409, "That routine could not be read here.")));
        if (task === null)
          return yield* refuseTransfer(404, "That routine is not on this machine.");
        const record = yield* records.read(task.id);
        if (record === null || !runsHere(record))
          return yield* refuseTransfer(409, "This machine does not run that routine.");
        const row = yield* deps.projects
          .get(task.projectId)
          .pipe(Effect.orElseSucceed(() => Option.none<ProjectStore.ProjectRow>()));
        if (
          Option.isNone(row) ||
          !projectInGrant(grant.projects, caller.sourceEnvironmentId, {
            id: row.value.projectId,
            workspaceSettings: row.value.workspaceSettings,
          })
        )
          return yield* refuseTransfer(
            403,
            "This machine's work grant for that machine leaves this project out.",
          );
        const grantedBy = yield* deps
          .readGrant(task.id)
          .pipe(
            Effect.mapError(() => refuseTransfer(409, "That routine's grant could not be read.")),
          );
        // The owner's own machines change the routine they all hold; another person's
        // machine changes only what its own work set up here.
        const others =
          grant.owner === "self"
            ? null
            : othersRoutineRefusal(
                {
                  coordinatorLabel: "that machine",
                  grant: {
                    coordinatorEnvironmentId: grant.coordinatorEnvironmentId,
                    ...(grant.kind === undefined ? {} : { kind: grant.kind }),
                  },
                },
                task,
                grantedBy,
                request.edit.kind === "delete" ? "delete" : "change",
              );
        if (others !== null) return yield* refuseTransfer(403, others);
        const failed = (error: ScheduledTaskError) =>
          refuseTransfer(409, `Not changed: ${error.message}`);
        const current = yield* revisionOf(task.id, record).pipe(Effect.mapError(failed));
        if (request.expectedRevision !== undefined && request.expectedRevision !== current)
          // Not made: the caller gets what this machine holds, to show and to change again.
          return {
            ...base,
            stale: true,
            revision: current,
            copy: routineCopyOf({ ...task, ownThread: true }),
          } satisfies RoutineRunnerResponse;
        switch (request.edit.kind) {
          case "delete": {
            const unreached = yield* tellDeleted(record, task.id, caller.sourceEnvironmentId);
            if (unreached.length > 0)
              return yield* refuseTransfer(409, deleteUnreachedRefusal(unreached));
            yield* deps.remove({ id: task.id }).pipe(Effect.mapError(failed));
            yield* records.remove(task.id).pipe(Effect.ignore);
            yield* records.dropRevision(task.id).pipe(Effect.ignore);
            return {
              ...base,
              revision: current + 1,
              copy: null,
            } satisfies RoutineRunnerResponse;
          }
          case "enabled": {
            yield* deps
              .setEnabled({ id: task.id, enabled: request.edit.enabled })
              .pipe(Effect.mapError(failed));
            break;
          }
          case "save": {
            const routine = request.edit.routine;
            if (routine.id !== task.id)
              return yield* refuseTransfer(400, "That change names another routine.");
            if (!accountInGrant(grant.accounts, routine.modelSelection.instanceId))
              return yield* refuseTransfer(
                403,
                "This machine's work grant does not allow that routine's sign-in.",
              );
            const input = decodeUpsert({
              id: task.id,
              title: routine.title,
              prompt: routine.prompt,
              enabled: routine.enabled,
              schedule: routine.schedule,
              projectId: task.projectId,
              threadId: task.threadId,
              workspaceStrategy: routine.workspaceStrategy,
              modelSelection: routine.modelSelection,
              runtimeMode: routine.runtimeMode,
              interactionMode: routine.interactionMode,
              createdBy: task.createdBy,
              creationSource: task.creationSource,
              modelPinned: routine.modelPinned ?? false,
              check: routine.check ?? null,
              brief: routine.brief ?? null,
              ownThread: task.ownThread === true,
            });
            if (Option.isNone(input))
              return yield* refuseTransfer(400, "That routine does not match this version.");
            yield* deps.upsert(input.value).pipe(Effect.mapError(failed));
            break;
          }
        }
        yield* bump(task.id).pipe(Effect.mapError(failed));
        const after = yield* deps.findTask(task.id).pipe(Effect.orElseSucceed(() => null));
        return {
          ...base,
          revision: current + 1,
          copy: after === null ? null : routineCopyOf({ ...after, ownThread: true }),
        } satisfies RoutineRunnerResponse;
      });

    /** `status`, `runner-disarm`, `runner-rearm`, `runner-edit`; the move ops are ScheduledTaskTransfer's. */
    const receive = (
      caller: ReceiverCaller,
      request: Extract<
        RoutineRunnerRequest,
        { op: "status" | "runner-disarm" | "runner-rearm" | "runner-edit" }
      >,
    ): Effect.Effect<RoutineRunnerResponse, RoutineTransferRefusal> => {
      const unreadable = () =>
        refuseTransfer(503, "This machine could not read its routine runners.");
      switch (request.op) {
        case "status":
          return Effect.gen(function* () {
            const record =
              request.routineId === undefined ? null : yield* records.readStrict(request.routineId);
            const task =
              request.routineId === undefined
                ? null
                : yield* deps.findTask(request.routineId).pipe(Effect.orElseSucceed(() => null));
            const operation =
              request.operationId === undefined
                ? undefined
                : (yield* records.receipt(`${request.operationId}:abort`)) !== null
                  ? ("aborted" as const)
                  : (yield* records.receipt(`${request.operationId}:enable`)) !== null
                    ? ("enabled" as const)
                    : record?.state === "staged" && record.operationId === request.operationId
                      ? ("staged" as const)
                      : ("unknown" as const);
            return {
              ...base,
              routine:
                task === null
                  ? null
                  : {
                      state: record?.state ?? "none",
                      runnerEnvironmentId: record?.runnerEnvironmentId ?? null,
                      revision: yield* revisionOf(task.id, record),
                      enabled: task.enabled,
                    },
              ...(operation === undefined ? {} : { operation }),
            } satisfies RoutineRunnerResponse;
          }).pipe(Effect.catchCause(() => Effect.fail(unreadable())));
        case "runner-disarm":
          return lock
            .withPermits(1)(disarm(caller, request))
            .pipe(Effect.catchCause((cause) => failOrUnreadable(cause, unreadable)));
        case "runner-rearm":
          return lock
            .withPermits(1)(rearmHere(caller, request))
            .pipe(Effect.catchCause((cause) => failOrUnreadable(cause, unreadable)));
        case "runner-edit":
          return lock
            .withPermits(1)(editHere(caller, request))
            .pipe(Effect.catchCause((cause) => failOrUnreadable(cause, unreadable)));
      }
    };

    return {
      hold,
      guardUpsert,
      guardSetEnabled,
      guardDelete,
      decorate,
      reconcile,
      pacedLook,
      receive,
      records,
      covered,
      /** Serializes a move's steps with changes and settling on this machine. */
      locked: <A, E>(effect: Effect.Effect<A, E>) => lock.withPermits(1)(effect),
      selfEnvironmentId: deps.selfEnvironmentId,
      newId: deps.newId,
      /** This machine's own count of changes to a routine. */
      revision: (taskId: string) => records.revision(taskId).pipe(Effect.orElseSucceed(() => 0)),
      /** The scheduler's own writes, for the move and for replicas. */
      internal: { upsert: deps.upsert, setEnabled: deps.setEnabled, remove: deps.remove },
      /** Called once the fleet is up; before that nothing is settled with, or sent to, another machine. */
      attach: (peers: RoutineRunnerPeers) => Ref.set(peersRef, peers),
    } as const;
  });

export type RoutineRunner = Effect.Success<ReturnType<typeof makeRoutineRunner>>;

/** A refusal passes through; anything else is this machine failing to read its own state. */
const failOrUnreadable = (
  cause: Cause.Cause<unknown>,
  unreadable: () => RoutineTransferRefusal,
): Effect.Effect<never, RoutineTransferRefusal> => {
  const failure = Cause.squash(cause);
  return Effect.fail(
    typeof failure === "object" &&
      failure !== null &&
      "_tag" in failure &&
      (failure as { _tag: unknown })._tag === "RoutineTransferRefusal"
      ? (failure as RoutineTransferRefusal)
      : unreadable(),
  );
};

/**
 * A machine of the release before answers a request it does not know with 400,
 * and one older still has no such route. Any other failure says nothing about
 * its release.
 */
const isOlderRelease = (failure: AwayPeerError) =>
  failure.refused && !failure.uncertain && (failure.status === 400 || failure.status === 404);
