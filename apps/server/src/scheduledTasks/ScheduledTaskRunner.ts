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
import { isCoordinatorOwnedRoutine } from "./ScheduledTaskCopies.ts";
import {
  affirmsRunner,
  type RoutineRunnerEdit,
  type RoutineRunnerRequest,
  type RoutineRunnerResponse,
} from "./ScheduledTaskRunnerWire.ts";
import { taskError } from "./ScheduledTaskStorage.ts";

import { makeRunnerReceive } from "./ScheduledTaskRunnerReceive.ts";
import {
  deleteUnreachedRefusal,
  isOlderRelease,
  isRunnerRoutine,
  makeRunnerRecords,
  MOVING_ROUTINE_CHANGE_REFUSAL,
  MOVING_ROUTINE_WAIT,
  type RoutineRunnerRecord,
  runsElsewhereNote,
  runsElsewhereRefusal,
  runsHere,
  STALE_ROUTINE_EDIT_REFUSAL,
  threadHandedOffNote,
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
                  refresh: true,
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
        const restsFor = (now: RoutineRunnerRecord) =>
          now.state === "disarmed" && now.runnerEnvironmentId === record.runnerEnvironmentId;
        /** What the runner holds, written only while this is still its resting copy. */
        const keep = (
          copy: CoordinatorRoutineCopy | null | undefined,
          revision: number | undefined,
        ) =>
          writing(
            Effect.gen(function* () {
              const now = yield* records.read(existing.id);
              // Still this runner's resting copy, and not an answer older than one already kept.
              if (now === null || !restsFor(now)) return;
              if (revision !== undefined && revision < now.revision) return;
              if (copy != null) yield* keepCopy(existing, copy);
              if (revision !== undefined)
                yield* records.write({ ...now, revision }).pipe(Effect.ignore);
            }),
          );
        const gone = writing(
          Effect.gen(function* () {
            const now = yield* records.read(existing.id);
            if (now !== null && !restsFor(now)) return;
            yield* deps.remove({ id: existing.id }).pipe(Effect.ignore);
            yield* records.remove(existing.id).pipe(Effect.ignore);
            yield* records.dropRevision(existing.id).pipe(Effect.ignore);
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
          const task = yield* forward(record, existing, edit, input.expectedRevision);
          yield* deps.notifyChanged;
          return done(task);
        }
        return yield* guardHere(input);
      });

    const guardHere = <A>(input: {
      readonly targets: ReadonlyArray<Target>;
      readonly change: Effect.Effect<A, ScheduledTaskError>;
      readonly ownRemovable?: boolean | undefined;
      readonly expectedRevision?: number | undefined;
      readonly before?: Effect.Effect<void, ScheduledTaskError> | undefined;
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

    const receive = makeRunnerReceive({
      deps,
      records,
      lock,
      peersRef,
      revisionOf,
      bump,
      tellDeleted,
    });

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
