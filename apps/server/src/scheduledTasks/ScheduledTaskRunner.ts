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
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/sql/SqlClient";

import type { AwayPeerError } from "../away/awayPeerCall.ts";
import type * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import {
  HANDOFF_ROUTINE_WAIT,
  HANDOVER_ROUTINE_CHANGE_REFUSAL,
  RESTING_ROUTINE_CHANGE_REFUSAL,
  type RoutineCoordinatorHold,
} from "./ScheduledTaskCoordinatorGate.ts";
import { stringifyJson } from "../json.ts";
import { isCoordinatorOwnedRoutine, routineCopyOf } from "./ScheduledTaskCopies.ts";
import {
  affirmsRunner,
  keepsUnchanged,
  type RoutineRunnerEdit,
  type RoutineRunnerRequest,
  type RoutineRunnerResponse,
} from "./ScheduledTaskRunnerWire.ts";
import { nextRunAt, taskError } from "./ScheduledTaskStorage.ts";

import { definitionHashOf, sameValue } from "./ScheduledTaskDefinitionHash.ts";
import { makeRunnerReceive } from "./ScheduledTaskRunnerReceive.ts";
import {
  copyNotRemovedRefusal,
  deleteUnreachedRefusal,
  isOlderRelease,
  isPendingCopyDelete,
  keepsOwnState,
  PENDING_COPY_DELETE,
  UNCONFIRMED_RUNNER_WAIT,
  isRunnerRoutine,
  makeRunnerRecords,
  MOVING_ROUTINE_CHANGE_REFUSAL,
  MOVING_ROUTINE_WAIT,
  type RoutineRunnerRecord,
  runsElsewhereNote,
  runsElsewhereRefusal,
  runsHere,
  STALE_ROUTINE_EDIT_REFUSAL,
  OLDER_RUNNER_SAVE_REFUSAL,
  UNSEEN_ROUTINE_EDIT_REFUSAL,
  HANDOVER_RESTING_COPY_REFUSAL,
} from "./ScheduledTaskRunnerRecords.ts";

export * from "./ScheduledTaskRunnerRecords.ts";

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
  /** Whether that copy's binding is one the release before let fire alone (ScheduledTaskRunnerRole). */
  readonly legacyOwner: (projectId: ProjectId) => Effect.Effect<boolean>;
  /** This machine, or null on a host with no identity (then nothing is settled with peers). */
  readonly selfEnvironmentId: Effect.Effect<string | null>;
  /** Holds a worker's routine unless a turn on its thread could start here (routineThreadHold). */
  readonly threadHold: (task: GateTask) => Effect.Effect<RoutineCoordinatorHold | null>;
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
/** How long a due pass waits for the look before it; the look goes on without it. */
const LOOK_WAIT_MS = 2_000;
/** The most one request to rest copies carries: the routines route reads 256 KB. */
const PUSH_BYTES = 150_000;
const PUSH_ROUTINES = 100;
/**
 * How often a server looks for routines to settle with the other machines,
 * at the earliest. The look runs before a pass over due routines. Null (a
 * test that settles by hand) never looks.
 */
export class RoutineRunnerPace extends Context.Reference<{ readonly everyMs: number | null }>(
  "specweave-studio/scheduledTasks/RoutineRunnerPace",
  { defaultValue: () => ({ everyMs: 30_000 }) },
) {}

const decodeUpsert = Schema.decodeUnknownOption(ScheduledTaskUpsertInput);
const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);
/** The hash of a resting copy's definition as its list shows it: on as it is at its runner. */
const shownDefinition = (
  task: ScheduledTask,
  record: Pick<RoutineRunnerRecord, "copyEnabled" | "definitionHash">,
) =>
  // As its runner sent it, where this row took it from there: the row may hold
  // it under this machine's own limits, and the runner hashes what it holds.
  record.definitionHash ??
  definitionHashOf({ ...task, enabled: record.copyEnabled ?? task.enabled });
/** When a routine on this schedule is next due, as a save that turns it on makes it. */
const freshSlot = (schedule: ScheduledTask["schedule"], now: DateTime.DateTime) =>
  nextRunAt({ enabled: true, schedule }, now);

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
    /** Projects with a machine of the release before, as the last look found them. */
    const legacySets = new Set<string>();

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

    /**
     * Whether this machine may fire a routine no runner is settled for, once
     * the release before's gate lets it. Two machines may both coordinate, and
     * that gate lets both through, so only the one whose binding the release
     * before let fire alone goes on firing. Any other copy waits, unless a
     * machine of that release shares the project: then its rule is the rule.
     */
    const mayFireUnsettled = (projectId: ProjectId) =>
      Effect.gen(function* () {
        const others = yield* othersOf(projectId);
        if (others === null || others.length === 0) return true;
        if (yield* deps.legacyOwner(projectId)) return true;
        return legacySets.has(projectId);
      });

    /** Whether this machine runs the routine by its settled record, whatever the coordinator binding says. */
    const ownsRun = (task: GateTask): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        if (task.id === undefined || !isRunnerRoutine(task)) return false;
        const record = yield* records.read(task.id);
        return record?.state === "settled" && (yield* covered(record, task.projectId));
      });

    /**
     * The routines whose copy on `recipient` rests for this machine by an
     * acknowledgement this machine still counts: it runs them, or will once the
     * other machines confirm too. What this machine sends that recipient as a
     * coordinator (a replica, a handover) carries them off, whatever the other
     * machines did: one put back on the release before saves what it is sent,
     * and would fire a copy sent on beside this machine. Fails when the records
     * cannot be read: unknown is never sent as on.
     */
    const restsAt = (
      recipient: string,
      /**
       * The recipient takes the coordinator role with what it is sent. A routine
       * this machine has not settled runs where the coordinator is, so it would
       * run nowhere if it went there off: the recipient is told to follow the
       * coordinator again, its acknowledgement ends here, and only then is the
       * routine left on. A settled routine runs here whatever the role, and
       * goes off as ever.
       */
      handover = false,
    ): Effect.Effect<ReadonlySet<string>, ScheduledTaskError> =>
      Effect.gen(function* () {
        const rests = new Set<string>();
        for (const record of (yield* records.allStrict).values()) {
          if (!runsHere(record)) continue;
          const confirmed = record.acked.includes(recipient);
          // Asked and unanswered, the recipient may rest all the same: its answer
          // can be lost after it acted. Only a handover has to know.
          const settlingHandover = handover && record.state === "settling";
          if (!confirmed && !(settlingHandover && (record.asked ?? []).includes(recipient)))
            continue;
          if (!settlingHandover) {
            rests.add(record.taskId);
            continue;
          }
          // The recipient follows the coordinator again before anything is sent: this
          // machine may be gone the moment the handover is taken, and a copy that
          // still rested for it would then run nowhere. One of the release before
          // keeps no record to rest by. Unanswered, the handover is not safe.
          const peers = yield* Ref.get(peersRef);
          const told =
            peers === null
              ? null
              : yield* peers
                  .post(recipient, {
                    op: "runner-rearm",
                    routineIds: [ScheduledTaskId.make(record.taskId)],
                  })
                  .pipe(Effect.result);
          if (told === null || (told._tag === "Failure" && !isOlderRelease(told.failure)))
            return yield* taskError(HANDOVER_RESTING_COPY_REFUSAL, {
              taskId: ScheduledTaskId.make(record.taskId),
            });
          const freed = yield* writing(
            records.atomically(
              Effect.gen(function* () {
                const now = yield* records.readStrict(record.taskId);
                if (now === null || !runsHere(now)) return true;
                // Settled meanwhile: it runs here, and the copy stays off.
                if (now.state !== "settling") return false;
                yield* records.write({
                  ...now,
                  acked: now.acked.filter((member) => member !== recipient),
                  asked: (now.asked ?? []).filter((member) => member !== recipient),
                });
                return true;
              }),
            ),
          );
          if (!freed) rests.add(record.taskId);
        }
        return rests as ReadonlySet<string>;
      }).pipe(
        Effect.mapError((cause) =>
          isTaskError(cause)
            ? cause
            : taskError("Could not read which routines rest for this machine.", { cause }),
        ),
      );

    // --- the gate ----------------------------------------------------------------------

    const hold = (task: GateTask): Effect.Effect<RoutineCoordinatorHold | null> =>
      Effect.gen(function* () {
        // A worker's routine runs here only where a turn on its thread could start,
        // whatever starts it (1390 AC-45).
        const thread = yield* deps.threadHold(task);
        if (thread !== null) return thread;
        // A webhook routine stays with the machine its URL points to, and has no record.
        if (task.schedule.type === "webhook") return null;
        const record = task.id === undefined ? null : yield* records.readStrict(task.id);
        if (record !== null) {
          if (record.state === "disarmed")
            return { kind: "rest", note: runsElsewhereNote(record.runnerLabel) } as const;
          if (record.state === "staged" || record.state === "moving")
            return { kind: "wait", reason: MOVING_ROUTINE_WAIT } as const;
        }
        if (!isCoordinatorOwnedRoutine(task)) return null;
        if (
          record !== null &&
          record.state === "settled" &&
          (yield* covered(record, task.projectId))
        )
          return null;
        // Not every machine confirmed: the rule of the release before, for the one
        // machine it let fire alone. A copy that cannot show it is that one waits.
        const legacy = yield* deps.legacyHold(task);
        if (legacy !== null || (yield* mayFireUnsettled(task.projectId))) return legacy;
        return { kind: "wait", reason: UNCONFIRMED_RUNNER_WAIT } as const;
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
      asked: ReadonlyArray<string> = previous?.asked ?? [],
    ): RoutineRunnerRecord => ({
      taskId,
      state,
      runnerEnvironmentId: self ?? "",
      runnerLabel: null,
      revision: previous?.revision ?? 0,
      acked,
      operationId: null,
      operation: null,
      asked,
      copyEnabled: null,
    });

    /**
     * Records what the other machines answered: `added` confirmed, `cleared`
     * said no and so wrote nothing. `settled` once all of them confirmed. Read
     * again under the lock, and only while this machine still runs the routine
     * under the coordinator rule: one that stopped coordinating meanwhile never
     * becomes the runner over the machine that fires it now.
     */
    const settleIfStillClaimed = (
      task: ScheduledTask,
      self: string | null,
      others: ReadonlyArray<string>,
      added: ReadonlyArray<string>,
      cleared: ReadonlyArray<string> = [],
    ) =>
      writing(
        Effect.gen(function* () {
          const record = yield* records.read(task.id);
          if (record !== null && !runsHere(record)) return;
          const acked = [...new Set([...(record?.acked ?? []), ...added])];
          const asked = (record?.asked ?? []).filter(
            (member) => !added.includes(member) && !cleared.includes(member),
          );
          const complete = others.every((member) => acked.includes(member));
          if (record?.state !== "settled" && (yield* deps.legacyHold(task)) !== null) {
            // Kept as answered so far; the next pass frees these machines again.
            if (acked.length > 0 || asked.length > 0 || record !== null)
              yield* records.write(selfRecord(task.id, self, record, acked, "settling", asked));
            return;
          }
          yield* records.write(
            selfRecord(task.id, self, record, acked, complete ? "settled" : "settling", asked),
          );
          yield* deps.notifyChanged;
        }),
      );

    /**
     * Written before a machine is asked to rest its copies: it may do so and
     * its answer be lost, and then only this record says it was ever asked.
     */
    const markAsked = (tasks: ReadonlyArray<ScheduledTask>, self: string | null, member: string) =>
      writing(
        Effect.forEach(
          tasks,
          (task) =>
            Effect.gen(function* () {
              const record = yield* records.read(task.id);
              if (record !== null && !runsHere(record)) return;
              yield* records.write(
                selfRecord(
                  task.id,
                  self,
                  record,
                  record?.acked ?? [],
                  record?.state === "settled" ? "settled" : "settling",
                  [...new Set([...(record?.asked ?? []), member])],
                ),
              );
            }),
          { discard: true },
        ),
      ).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

    /**
     * Tells the machines that rest their copies, and the ones that may, to
     * follow the coordinator again.
     */
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
        for (const member of new Set([...record.acked, ...(record.asked ?? [])])) {
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
            const asked = (now.asked ?? []).filter((entry) => !freed.includes(entry));
            if (acked.length === 0 && asked.length === 0) yield* records.remove(task.id);
            else yield* records.write({ ...now, state: "settling", acked, asked });
          }),
        );
      });

    /** As sent: a prompt outside ASCII takes more bytes than it has characters. */
    const copyBytes = (task: ScheduledTask) =>
      Buffer.byteLength(stringifyJson(routineCopyOf(task)), "utf8");
    /** What the routine adds to a request: one too large to send goes as its id alone. */
    const sentBytes = (task: ScheduledTask) => {
      const bytes = copyBytes(task);
      return bytes > PUSH_BYTES ? 0 : bytes;
    };
    /** Requests no larger than the routines route reads, each with its routines' definitions. */
    const batches = (list: ReadonlyArray<ScheduledTask>) => {
      const out: Array<Array<ScheduledTask>> = [];
      let size = 0;
      for (const task of list) {
        const bytes = sentBytes(task);
        if (out.length === 0 || size + bytes > PUSH_BYTES || out.at(-1)!.length >= PUSH_ROUTINES) {
          out.push([]);
          size = 0;
        }
        out.at(-1)!.push(task);
        size += bytes;
      }
      return out;
    };

    /**
     * Asks `member` to rest its copies of `list`, each sent as this machine
     * holds it with its revision. What it confirmed, what it said no to, and
     * the failure that ended the asking, if any.
     */
    const askToRest = (
      peers: RoutineRunnerPeers,
      member: string,
      projectId: string,
      list: ReadonlyArray<ScheduledTask>,
      kind: { readonly refresh?: true; readonly incumbent?: boolean },
    ) =>
      Effect.gen(function* () {
        const acked: Array<string> = [];
        const refused: Array<string> = [];
        /** The revision each routine went with. */
        const sent = new Map<string, number>();
        for (const planned of batches(list)) {
          // Each definition and its revision are read in one transaction, just
          // before they go: a change saved between two reads would pair the old
          // definition with the new count, and a copy would take that for current.
          const read = yield* records
            .atomically(
              Effect.gen(function* () {
                const ids = new Set<string>(planned.map((task) => task.id));
                const tasks = (yield* deps.listTasks).filter((task) => ids.has(task.id));
                return { tasks, counts: yield* records.revisionsStrict };
              }),
            )
            .pipe(Effect.result);
          // Unreadable now: nothing is sent, and the next look asks again.
          if (read._tag === "Failure") continue;
          const { counts } = read.success;
          const batch = read.success.tasks.filter(isRunnerRoutine);
          if (batch.length === 0) continue;
          const answered = yield* peers
            .post(member, {
              op: "runner-disarm",
              sourceProjectId: projectId,
              routineIds: batch.map((task) => task.id),
              revisions: batch.map((task) => counts.get(task.id) ?? 0),
              // One too large for a request goes without its definition: its copy
              // rests all the same, and keeps the revision it holds.
              routines: batch.map((task) =>
                copyBytes(task) > PUSH_BYTES ? null : routineCopyOf(task),
              ),
              ...kind,
            })
            .pipe(Effect.result);
          if (answered._tag === "Failure")
            return { acked, refused, sent, failure: answered.failure };
          for (const task of batch) sent.set(task.id, counts.get(task.id) ?? 0);
          acked.push(...(answered.success.acked ?? []));
          refused.push(...(answered.success.refused ?? []));
        }
        return { acked, refused, sent, failure: null };
      });

    /**
     * Whether a coordinator's replica leaves this routine alone: this machine
     * runs or moves it, or its copy rests and takes its definition from its
     * runner. A resting record with no row yet lets the replica bring the row.
     */
    const heldFromReplica = (id: ScheduledTaskId): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const record = yield* records.read(id);
        if (record?.state !== "disarmed") return keepsOwnState(record);
        return (yield* deps.findTask(id)) !== null;
      }).pipe(Effect.orElseSucceed(() => true));

    /**
     * A replica's save of a routine. One that rests here for a runner is saved
     * as a resting copy is kept: its row off, what the replica said it was in
     * the record, and the note a person reads, in one write.
     */
    const saveReplica = <A>(
      input: ScheduledTaskUpsertInput,
      save: (input: ScheduledTaskUpsertInput) => Effect.Effect<A, ScheduledTaskError>,
    ): Effect.Effect<A, ScheduledTaskError> =>
      Effect.gen(function* () {
        const id = input.id;
        const record = id === undefined ? null : yield* records.read(id);
        if (id === undefined || record?.state !== "disarmed") return yield* save(input);
        // What its runner said it is counts over the replica: a runner every machine
        // rests for sends its routine off (`runsAsRunner`), whatever it is there.
        const enabled = record.copyEnabled ?? input.enabled;
        return yield* atomic(
          Effect.gen(function* () {
            // Saved as it is at its runner, so it holds the slot it would be due
            // at; then off, with that slot kept for the day it follows again.
            const saved = yield* save({ ...input, enabled });
            if (enabled) yield* records.setRowEnabled(id, false);
            yield* records.setNote(id, runsElsewhereNote(record.runnerLabel));
            // A replica's definition is not one this copy took from its runner.
            yield* records.write({
              ...record,
              copyEnabled: enabled,
              installedRevision: null,
              definitionHash: null,
            });
            return saved;
          }),
        );
      });

    /**
     * A resting copy follows the coordinator again: its row on as it was before
     * it was turned off to rest, due at the slot it holds, the note gone, and no
     * record, in one write.
     */
    const followAgain = (id: ScheduledTaskId, record: RoutineRunnerRecord) =>
      records.atomically(
        Effect.gen(function* () {
          const held = yield* deps.findTask(id);
          if (held !== null && record.copyEnabled != null) {
            // Nobody armed it anew: the slot it is due at and its one-time
            // generation stay as its runner, or a handover, left them.
            if (held.enabled !== record.copyEnabled) {
              yield* records.setRowEnabled(id, record.copyEnabled);
              // A row that never held a slot gets one; a one-time routine without
              // one already ran, and stays so.
              if (record.copyEnabled && held.nextRunAt === null && held.schedule.type !== "once")
                yield* records.setSlot(id, freshSlot(held.schedule, yield* localNow));
            }
            yield* records.setNote(id, null);
          }
          yield* records.remove(id);
        }),
      );

    /** A copy whose routine was deleted at its runner: its row, its record and its count, or none. */
    const removeCopy = (id: ScheduledTaskId) =>
      records.atomically(
        Effect.gen(function* () {
          if ((yield* deps.findTask(id)) !== null) yield* deps.remove({ id });
          yield* records.remove(id);
          yield* records.dropRevision(id);
        }),
      );

    /**
     * Settling asks other machines, each for up to half a minute, so it never
     * holds this machine's change lock while it asks: only while it writes, and
     * every write reads the record again first.
     */
    const reconcileOnce = (force: boolean) =>
      Effect.gen(function* () {
        const self = yield* deps.selfEnvironmentId;
        const all = yield* records.all;
        // A copy deleted at its runner whose own row would not go: tried again.
        for (const record of all.values())
          if (isPendingCopyDelete(record))
            yield* writing(removeCopy(ScheduledTaskId.make(record.taskId))).pipe(Effect.ignore);
        const tasks = (yield* deps.listTasks).filter(isRunnerRoutine);
        if (tasks.length === 0) return;
        const counts = yield* records.revisions;
        const peers = yield* Ref.get(peersRef);
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const byProject = new Map<string, Array<ScheduledTask>>();
        for (const task of tasks)
          byProject.set(task.projectId, [...(byProject.get(task.projectId) ?? []), task]);
        for (const [projectId, owned] of byProject) {
          const others = yield* othersOf(projectId as ProjectId);
          if (others === null) continue;
          const left = new Set<string>();
          for (const task of owned) {
            const record = all.get(task.id) ?? null;
            // Its runner left the project: nobody is left to say it may run again,
            // so this copy follows the coordinator, as it did before it rested.
            if (
              record?.state === "disarmed" &&
              !isPendingCopyDelete(record) &&
              !others.includes(record.runnerEnvironmentId)
            ) {
              yield* writing(
                Effect.gen(function* () {
                  const now = yield* records.read(task.id);
                  if (now?.state === "disarmed" && !others.includes(now.runnerEnvironmentId))
                    yield* followAgain(task.id, now);
                }),
              ).pipe(Effect.ignore);
              left.add(task.id);
            }
          }
          // A project no other machine shares has nothing to settle: it runs as it did.
          if (others.length === 0) continue;
          const need = new Map<string, Array<ScheduledTask>>();
          /** Routines this machine runs whose resting copies have not heard their latest revision. */
          const stale = new Map<string, Array<ScheduledTask>>();
          for (const task of owned) {
            // Freed just now: it is claimed, if this machine runs it, on the next look.
            if (left.has(task.id)) continue;
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
            // The oldest revision any machine was sent: what all of them hold at least.
            const went = new Map<string, number>();
            for (const [member, list] of stale) {
              const told = yield* askToRest(peers, member, projectId, list, { refresh: true });
              for (const id of told.acked) {
                reached.set(id, (reached.get(id) ?? 0) + 1);
                const revision = told.sent.get(id) ?? 0;
                went.set(id, Math.min(went.get(id) ?? revision, revision));
              }
            }
            for (const task of new Set([...stale.values()].flat()))
              if (reached.get(task.id) === others.length)
                pushed.set(task.id, went.get(task.id) ?? 0);
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
          if (old) legacySets.add(projectId);
          else if (!silent) legacySets.delete(projectId);
          if (old) {
            for (const task of new Set([...need.values()].flat())) {
              const record = all.get(task.id);
              if (record !== undefined && runsHere(record)) yield* rearm(peers, task, record);
            }
            yield* deps.notifyChanged;
            continue;
          }
          if (silent) continue;
          const incumbent = yield* deps.legacyOwner(projectId as ProjectId);
          const ackedNow = new Map<string, Array<string>>();
          const clearedNow = new Map<string, Array<string>>();
          const note = (into: Map<string, Array<string>>, id: string, member: string) =>
            into.set(id, [...(into.get(id) ?? []), member]);
          for (const [member, list] of need) {
            // Not remembered, not asked: a machine that rests for a claim this one
            // forgot would never be told to follow the coordinator again.
            if (!(yield* markAsked(list, self, member))) continue;
            const answered = yield* askToRest(peers, member, projectId, list, { incumbent });
            for (const id of answered.acked) note(ackedNow, id, member);
            // A machine that said no wrote nothing: it is neither waited on nor told to rearm.
            const no =
              answered.failure !== null &&
              answered.failure.refused &&
              !answered.failure.uncertain &&
              (answered.failure.status ?? 0) < 500;
            for (const id of no
              ? list.map((task) => task.id).filter((id) => !answered.acked.includes(id))
              : answered.refused)
              note(clearedNow, id, member);
          }
          for (const task of owned) {
            const added = ackedNow.get(task.id) ?? [];
            const cleared = clearedNow.get(task.id) ?? [];
            if (added.length === 0 && cleared.length === 0) continue;
            yield* settleIfStillClaimed(task, self, others, added, cleared);
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
     * A look at most every `everyMs`, run by the caller before a due pass, so a
     * runner is settled before its routine is looked at wherever the other
     * machines answer in time. It asks other machines, so it runs on a fiber
     * of its own and the due pass waits for it only so long: a machine that
     * does not answer never holds up what is due.
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
          const look = yield* tick.pipe(
            Effect.ensuring(Effect.sync(() => void (looks.running = false))),
            Effect.forkIn(scope),
          );
          yield* Fiber.join(look).pipe(Effect.timeoutOption(LOOK_WAIT_MS), Effect.ignore);
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

    const isTaskError = (error: unknown): error is ScheduledTaskError =>
      typeof error === "object" &&
      error !== null &&
      (error as { readonly _tag?: unknown })._tag === "ScheduledTaskError";
    /** Every write of `effect`, or none of them. */
    const atomic = <A, E>(effect: Effect.Effect<A, E>) =>
      records
        .atomically(effect)
        .pipe(
          Effect.mapError((error) =>
            isTaskError(error) ? error : taskError("Could not save the change.", { cause: error }),
          ),
        );
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

    /**
     * Rests this machine's copy for the runner `record` names: the definition
     * the runner sent with its revision, the row off so a release before this
     * one never fires it, the note a person reads, and the record. All of it
     * or none: a copy never shows a revision whose definition it did not take.
     */
    const restCopy = (
      existing: ScheduledTask | null,
      copy: CoordinatorRoutineCopy | null,
      record: RoutineRunnerRecord,
      /** The definition as the runner sent it, where `copy` holds it under this machine's limits. */
      sent: CoordinatorRoutineCopy | null = copy,
    ) =>
      records.atomically(
        Effect.gen(function* () {
          let installed = record.installedRevision ?? null;
          let hash = record.definitionHash ?? null;
          if (existing !== null) {
            // Off first, by itself: the row keeps its slot and its one-time generation.
            if (existing.enabled) yield* records.setRowEnabled(existing.id, false);
            if (copy !== null) {
              const before = yield* records.read(existing.id);
              // Whether it was on before this: at its runner, for a copy that rested already.
              const was =
                before?.state === "disarmed" && before.copyEnabled != null
                  ? before.copyEnabled
                  : existing.enabled;
              const input = decodeUpsert({
                id: existing.id,
                title: copy.title,
                prompt: copy.prompt,
                enabled: false,
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
              if (Option.isNone(input))
                return yield* taskError("That routine does not match this version.", {
                  taskId: existing.id,
                });
              // Saved off, so an unchanged schedule keeps the slot the row holds.
              const saved = (yield* deps.upsert(input.value)).task;
              // Off at its runner: due at nothing. Turned on there, or on another
              // schedule: due as a save of it would make it.
              if (!copy.enabled) {
                if (saved.nextRunAt !== null) yield* records.setSlot(existing.id, null);
              } else if (!was || saved.nextRunAt === null)
                yield* records.setSlot(existing.id, freshSlot(saved.schedule, yield* localNow));
              installed = record.revision;
              hash = definitionHashOf(sent ?? copy);
            }
            yield* records.setNote(existing.id, runsElsewhereNote(record.runnerLabel));
          }
          yield* records.write({ ...record, installedRevision: installed, definitionHash: hash });
        }),
      );

    /**
     * Tells every machine that rests its copy of a routine this machine runs
     * that it is deleted. Returns the machines that did not confirm. When some
     * did not, the delete is off, and the ones that did have no copy and no
     * record any more: they leave the confirmed set, so this machine is back
     * under the coordinator rule until the next look settles with them again.
     * Called with the change lock held.
     */
    const tellDeleted = (record: RoutineRunnerRecord, id: ScheduledTaskId, except: string | null) =>
      Effect.gen(function* () {
        const peers = yield* Ref.get(peersRef);
        const unreached: Array<string> = [];
        const dropped: Array<string> = [];
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
          else dropped.push(member);
        }
        if (unreached.length > 0 && dropped.length > 0)
          yield* records
            .write({
              ...record,
              state: "settling",
              acked: record.acked.filter((member) => !dropped.includes(member)),
            })
            .pipe(Effect.ignore);
        return unreached;
      });

    /** Sends a change to the runner. Nothing is written here unless the runner made it. */
    const forward = (
      record: RoutineRunnerRecord,
      existing: ScheduledTask,
      edit: RoutineRunnerEdit,
      /** What the caller said its change was made on. */
      seen: { readonly revision: number | undefined; readonly hash: string | undefined },
    ) =>
      Effect.gen(function* () {
        const peers = yield* Ref.get(peersRef);
        if (peers === null)
          return yield* taskError(
            runsElsewhereRefusal(record.runnerLabel, "this machine cannot reach it yet"),
            { taskId: existing.id },
          );
        // The change was made on a definition somebody saw. Its hash goes with it,
        // and the runner makes the change only on that very definition: a count
        // can match a definition this copy never held. One that names a definition
        // this copy no longer shows is stale here already. A change that names none
        // cannot say what it was made on, and is not sent: this copy never names
        // one for its caller, since what it shows now is not what the caller saw.
        if (seen.hash === undefined)
          return yield* taskError(UNSEEN_ROUTINE_EDIT_REFUSAL, { taskId: existing.id });
        if (seen.hash !== shownDefinition(existing, record))
          return yield* taskError(STALE_ROUTINE_EDIT_REFUSAL, { taskId: existing.id });
        const installed = record.installedRevision ?? null;
        if (seen.revision !== undefined && installed !== null && seen.revision !== installed)
          return yield* taskError(STALE_ROUTINE_EDIT_REFUSAL, { taskId: existing.id });
        // A copy that shows the routine under its own limits leaves the fields its
        // caller did not change to the runner. One that cannot be asked to keep them
        // would write this copy's, so it is asked first whether it can.
        if (
          edit.kind === "save" &&
          (edit.kept ?? []).length > 0 &&
          seen.hash !==
            definitionHashOf({ ...existing, enabled: record.copyEnabled ?? existing.enabled })
        ) {
          const asked = yield* peers
            .post(record.runnerEnvironmentId, { op: "status" })
            .pipe(Effect.result);
          if (asked._tag === "Failure" && !isOlderRelease(asked.failure))
            return yield* taskError(
              runsElsewhereRefusal(record.runnerLabel, asked.failure.message),
              { taskId: existing.id },
            );
          if (asked._tag === "Failure" || !keepsUnchanged(asked.success))
            return yield* taskError(OLDER_RUNNER_SAVE_REFUSAL, { taskId: existing.id });
        }
        const answered = yield* peers
          .post(record.runnerEnvironmentId, {
            op: "runner-edit",
            routineId: existing.id,
            ...(installed === null ? {} : { expectedRevision: installed }),
            seen: seen.hash,
            edit,
          })
          .pipe(Effect.result);
        const restsFor = (now: RoutineRunnerRecord) =>
          now.state === "disarmed" && now.runnerEnvironmentId === record.runnerEnvironmentId;
        /** What the runner holds, taken only while this is still its resting copy. */
        const keep = (
          copy: CoordinatorRoutineCopy | null | undefined,
          revision: number | undefined,
        ) =>
          writing(
            Effect.gen(function* () {
              const now = yield* records.read(existing.id);
              // Still this runner's resting copy, and not an answer older than one already kept.
              if (now === null || !restsFor(now)) return;
              // A revision comes only with its definition.
              if (copy == null || revision === undefined || revision < now.revision) return;
              const held = yield* deps.findTask(existing.id);
              yield* restCopy(held, copy, { ...now, revision, copyEnabled: copy.enabled });
            }),
          ).pipe(
            // The runner has the change; this copy still shows the revision it holds.
            Effect.catch((cause) =>
              Effect.logWarning("Could not keep a routine's copy after its runner changed it", {
                cause,
              }),
            ),
          );
        /** Deleted at its runner: this copy goes whole, or keeps resting until it can. */
        const gone = writing(
          Effect.gen(function* () {
            const now = yield* records.read(existing.id);
            if (now !== null && !restsFor(now)) return;
            const removed = yield* removeCopy(existing.id).pipe(Effect.result);
            if (removed._tag === "Success") return;
            if (now !== null)
              yield* records.write({ ...now, operation: PENDING_COPY_DELETE }).pipe(Effect.ignore);
            return yield* taskError(copyNotRemovedRefusal(record.runnerLabel), {
              taskId: existing.id,
              cause: removed.failure,
            });
          }),
        );
        if (answered._tag === "Failure")
          return yield* taskError(
            runsElsewhereRefusal(record.runnerLabel, answered.failure.message),
            { taskId: existing.id },
          );
        const answer = answered.success;
        if (affirmsRunner(answer) && answer.stale === true) {
          // Not made. This copy now shows what the runner holds, and its revision,
          // so the change can be made again against it.
          yield* keep(answer.copy, answer.revision);
          yield* deps.notifyChanged;
          return yield* taskError(STALE_ROUTINE_EDIT_REFUSAL, { taskId: existing.id });
        }
        if (!affirmsRunner(answer) || answer.revision === undefined)
          return yield* taskError(
            runsElsewhereRefusal(record.runnerLabel, "it sent an answer this version cannot read"),
            { taskId: existing.id },
          );
        if (answer.copy == null) {
          yield* gone;
          return null;
        }
        yield* keep(answer.copy, answer.revision);
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
      readonly removes?: boolean | undefined;
      readonly expectedRevision?: number | undefined;
      /** The definition the caller saw, when it says (a copy's list sends it with each routine). */
      readonly expectedDefinition?: string | undefined;
      /** Runs once the change is allowed, before it is made; a failure calls it off. */
      readonly before?: Effect.Effect<void, ScheduledTaskError> | undefined;
      readonly forwarded?:
        | ((existing: ScheduledTask) => {
            readonly edit: RoutineRunnerEdit;
            readonly done: (task: ScheduledTask | null) => A;
          })
        | undefined;
    }): Effect.Effect<A, ScheduledTaskError> =>
      Effect.gen(function* () {
        // A change to a routine another machine runs is sent there with this
        // machine's lock released: the runner takes its own lock for it, and two
        // machines that each held theirs would wait on each other.
        const forwarded = input.forwarded;
        for (const target of input.targets) {
          if (!("id" in target) || forwarded === undefined) continue;
          const record = yield* records.read(target.id);
          if (record?.state !== "disarmed") continue;
          const existing = yield* deps.findTask(target.id);
          if (existing === null) continue;
          const { edit, done } = forwarded(existing);
          const task = yield* forward(record, existing, edit, {
            revision: input.expectedRevision,
            hash: input.expectedDefinition,
          });
          yield* deps.notifyChanged;
          return done(task);
        }
        return yield* guardHere(input);
      });

    /**
     * Whether a change names a definition this machine does not hold now. A
     * caller that listed the routine while another machine ran it names what it
     * saw; the routine may run here since, changed. Hashed as a runner hashes
     * what it holds for a change sent to it.
     */
    const namesAnother = (id: ScheduledTaskId, named: string | undefined) =>
      Effect.gen(function* () {
        if (named === undefined) return false;
        const held = yield* deps.findTask(id);
        return (
          held !== null &&
          named !== definitionHashOf(routineCopyOf({ ...held, ownThread: true }) ?? held)
        );
      });

    const guardHere = <A>(input: {
      readonly targets: ReadonlyArray<Target>;
      readonly change: Effect.Effect<A, ScheduledTaskError>;
      readonly ownRemovable?: boolean | undefined;
      readonly expectedRevision?: number | undefined;
      /** The definition the caller saw, when it says: checked here as its runner checks it. */
      readonly expectedDefinition?: string | undefined;
      readonly before?: Effect.Effect<void, ScheduledTaskError> | undefined;
      /** The change deletes the routine: nothing is left to count. */
      readonly removes?: boolean | undefined;
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
              if (yield* namesAnother(target.id, input.expectedDefinition))
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
          // The revision the change was made against, the change and the new
          // revision are one write: a change never stays at its old revision.
          const result = yield* atomic(
            Effect.gen(function* () {
              for (const id of bumped)
                if (
                  input.expectedRevision !== undefined &&
                  input.expectedRevision !== (yield* revisionOf(id, null))
                )
                  return yield* taskError(STALE_ROUTINE_EDIT_REFUSAL, {
                    taskId: ScheduledTaskId.make(id),
                  });
              // And the definition it named, in the same write as the change.
              for (const id of bumped)
                if (yield* namesAnother(ScheduledTaskId.make(id), input.expectedDefinition))
                  return yield* taskError(STALE_ROUTINE_EDIT_REFUSAL, {
                    taskId: ScheduledTaskId.make(id),
                  });
              const changed = yield* input.change;
              if (input.removes !== true) for (const id of bumped) yield* bump(id);
              return changed;
            }),
          );
          // The change told the screens before its count moved: told again, or a
          // list would show the old count and the next save would be refused as stale.
          if (bumped.length > 0) yield* deps.notifyChanged;
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
        expectedDefinition: input.expectedDefinition,
        forwarded: (existing) => ({
          edit: {
            kind: "save",
            kept: [
              ...(input.runtimeMode === existing.runtimeMode ? (["runtimeMode"] as const) : []),
              ...(sameValue(input.modelSelection, existing.modelSelection)
                ? (["modelSelection"] as const)
                : []),
            ],
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
        expectedDefinition: input.expectedDefinition,
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
        // The row, its runner record and its count go together, or none does:
        // a row left behind without its record would fire as nobody's routine.
        change: change.pipe(
          Effect.tap(() => records.remove(input.id)),
          Effect.tap(() => records.dropRevision(input.id)),
          Effect.mapError((error) =>
            isTaskError(error)
              ? error
              : taskError("Could not delete the routine.", { taskId: input.id, cause: error }),
          ),
        ),
        removes: true,
        ownRemovable: true,
        expectedRevision: input.expectedRevision,
        expectedDefinition: input.expectedDefinition,
        // The copies that rest for it go first: one left behind would come back with a replica.
        before: Effect.gen(function* () {
          // Unreadable is not "no copies": deleting then would leave them resting for good.
          const record = yield* records.readStrict(input.id).pipe(
            Effect.catchCause((cause) =>
              taskError("Not deleted: this machine could not read its runner.", {
                taskId: input.id,
                cause,
              }),
            ),
          );
          if (record === null || !runsHere(record)) return;
          const unreached = yield* tellDeleted(record, input.id, null);
          if (unreached.length > 0)
            return yield* taskError(deleteUnreachedRefusal(unreached), { taskId: input.id });
        }),
        forwarded: () => ({ edit: { kind: "delete" }, done: () => ({ id: input.id }) }),
      });

    /** The list with each routine's runner, for the machines that show it. */
    const decorate = (listed: ScheduledTaskListResult): Effect.Effect<ScheduledTaskListResult> =>
      Effect.gen(function* () {
        const all = yield* records.all;
        const counts = yield* records.revisions;
        return {
          // A copy deleted at its runner that would not go yet is not a routine any more.
          tasks: listed.tasks
            .filter((task) => {
              const record = all.get(task.id);
              return record === undefined || !isPendingCopyDelete(record);
            })
            .map((task) => {
              const record = all.get(task.id);
              // A copy shows the revision of the definition it holds, when it took one.
              const revision =
                record?.state === "disarmed"
                  ? (record.installedRevision ?? record.revision)
                  : (counts.get(task.id) ?? 0);
              if (record === undefined || record.state === "settling") return { ...task, revision };
              return {
                ...task,
                // A resting copy's row is off for the release before; this is what its runner holds.
                ...(record.state === "disarmed" && record.copyEnabled != null
                  ? { enabled: record.copyEnabled }
                  : {}),
                // The hash of what this very read shows, for a change made on it to name.
                ...(record.state === "disarmed"
                  ? { definitionHash: shownDefinition(task, record) }
                  : {}),
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

    const receive = makeRunnerReceive({
      deps,
      records,
      lock,
      peersRef,
      revisionOf,
      bump,
      tellDeleted,
      restCopy,
      removeCopy,
      followAgain,
    });

    return {
      hold,
      ownsRun,
      heldFromReplica,
      saveReplica,
      restsAt,
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
