/**
 * Where a linked personal assistant's routines run (1448 AC-09, C5).
 *
 * A personal assistant's routines are never copied between its linked seats,
 * so each routine runs on the seat it was made on, whichever seat is the
 * routine runner (`routineOwner`). The runner decides only two cases: a copy
 * a seat rested for another machine (a disarmed runner record), which the new
 * runner takes back (`makePersonalTakeover`), and a project whose `userdata`
 * was copied to another machine (the same project id on two members), where
 * both seats hold the same routines and only the runner fires them.
 *
 * A routine bound to a worker's thread and a webhook routine never travel, so
 * this gate leaves them alone: the thread hold and the webhook's own machine
 * decide where they run.
 */
import type {
  ProjectId,
  ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskId,
} from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { SqlError } from "effect/sql/SqlError";

import type { AwayPeerError } from "../away/awayPeerCall.ts";
import type * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type { RoutineCoordinatorHold } from "./ScheduledTaskCoordinatorGate.ts";
import {
  isPendingCopyDelete,
  isRunnerRoutine,
  type RoutineRunnerRecord,
  type RoutineRunnerRecords,
} from "./ScheduledTaskRunnerRecords.ts";
import { nextRunAt } from "./ScheduledTaskStorage.ts";

export const PERSONAL_RESTING_NOTE =
  "Not run on this machine: the routine runner chosen in Settings runs this personal assistant's shared routines. Choose this machine as the runner to run it here.";

/** This seat's part in its personal assistant's routines: it runs them, rests them, or neither (not a linked personal assistant). */
export type PersonalRunnerSeat = "runs" | "rests" | null;

export const personalRunnerSeat = (
  settings: ProjectStore.ProjectRow["workspaceSettings"] | null | undefined,
): PersonalRunnerSeat => {
  if (!isPersonalAssistantProject({ workspaceSettings: settings })) return null;
  if ((settings?.logicalProject?.members.length ?? 0) <= 1) return null;
  return settings?.coordinatorBinding?.routineOwner === false ? "rests" : "runs";
};

/** The seat as the project row says now; a row that is gone or unreadable is no seat. */
export const readPersonalRunnerSeat =
  (projects: ProjectStore.ProjectStoreV2["Service"]) =>
  (projectId: ProjectId): Effect.Effect<PersonalRunnerSeat> =>
    projects.get(projectId).pipe(
      Effect.map((row) =>
        Option.isNone(row) ? null : personalRunnerSeat(row.value.workspaceSettings),
      ),
      Effect.orElseSucceed(() => null),
    );

/**
 * Whether this project's `userdata` was copied to another linked machine: the
 * same project id on two members, so both seats hold the same routine ids.
 */
export const copiedUserdata = (
  settings: ProjectStore.ProjectRow["workspaceSettings"] | null | undefined,
  projectId: ProjectId,
): boolean =>
  (settings?.logicalProject?.members ?? []).filter((member) => member.projectId === projectId)
    .length > 1;

/** `copiedUserdata` as the project row says now; a row that is gone or unreadable is not copied. */
export const readCopiedUserdata =
  (projects: ProjectStore.ProjectStoreV2["Service"]) =>
  (projectId: ProjectId): Effect.Effect<boolean> =>
    projects.get(projectId).pipe(
      Effect.map(
        (row) => Option.isSome(row) && copiedUserdata(row.value.workspaceSettings, projectId),
      ),
      Effect.orElseSucceed(() => false),
    );

type PersonalHold =
  | { readonly handled: false }
  | { readonly handled: true; readonly hold: RoutineCoordinatorHold | null };

/**
 * The personal gate in front of the runner's own. Only a routine that travels
 * is decided here, and on a seat that is not the runner only a copy it rested
 * for another machine (a disarmed runner record), or any routine of a project
 * whose `userdata` was copied to another member, rests. A routine that lives only on this seat runs
 * here whichever seat is the runner: a personal assistant's routines are never
 * copied to its other seats (grants and runner staging refuse personal
 * projects), so resting one would leave it running nowhere. A seat that rests
 * a copy still runs it while every other seat of the link answered that it
 * does not list this one.
 */
export const makePersonalRoutineHold =
  (deps: {
    readonly projects: ProjectStore.ProjectStoreV2["Service"];
    readonly unlinkedByAll: (projectId: ProjectId) => Effect.Effect<boolean>;
    /** Whether this seat holds the routine as a copy it rested for another machine. */
    readonly restedCopy: (taskId: ScheduledTaskId) => Effect.Effect<boolean>;
  }) =>
  (
    task: Pick<ScheduledTask, "projectId" | "ownThread" | "schedule"> & {
      readonly id?: ScheduledTask["id"] | undefined;
    },
  ): Effect.Effect<PersonalHold> =>
    Effect.gen(function* () {
      if (!isRunnerRoutine(task)) return { handled: false } as const;
      const row = yield* deps.projects
        .get(task.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none<ProjectStore.ProjectRow>()));
      if (Option.isNone(row)) return { handled: false } as const;
      const seat = personalRunnerSeat(row.value.workspaceSettings);
      if (seat === null) return { handled: false } as const;
      if (seat === "runs") return { handled: true, hold: null } as const;
      // A routine that lives only here runs here (the coordinator gate would rest it on
      // routineOwner false, and no other seat holds it). On a copied project every
      // routine may also sit on the runner under the same id, so the runner alone fires.
      if (
        !copiedUserdata(row.value.workspaceSettings, task.projectId) &&
        (task.id === undefined || !(yield* deps.restedCopy(task.id)))
      )
        return { handled: true, hold: null } as const;
      if (yield* deps.unlinkedByAll(task.projectId)) return { handled: true, hold: null } as const;
      return {
        handled: true,
        hold: {
          kind: "rest",
          note: PERSONAL_RESTING_NOTE,
          logicalProjectId: row.value.workspaceSettings?.logicalProject?.id ?? null,
        },
      } as const;
    });

/**
 * Which of a project's other machines answered a request to rest copies with
 * "this project has no linked copy here" (404 from a machine that affirmed it
 * keeps runner records, so the route exists). Kept in memory: a restart asks again.
 */
export const makePeerLinkMemory = () => {
  const unlinked = new Map<string, Set<string>>();
  return {
    note: (projectId: string, member: string, failure: AwayPeerError | null) => {
      // Unreached says nothing; any other answer from that machine means it lists this one.
      if (failure !== null && (!failure.refused || failure.uncertain)) return;
      const set = unlinked.get(projectId) ?? new Set<string>();
      if (failure?.status === 404) set.add(member);
      else set.delete(member);
      unlinked.set(projectId, set);
    },
    /** Whether every one of `others` answered that it does not list this machine. */
    allUnlinked: (projectId: string, others: ReadonlyArray<string> | null) =>
      others !== null &&
      others.length > 0 &&
      others.every((member) => unlinked.get(projectId)?.has(member) === true),
  };
};

/**
 * The seat chosen as the runner takes back a copy it rested for another seat:
 * the row as it was before it rested, due at its next slot, not one already
 * past (the former runner fired that one). Local only, before every due pass,
 * so a runner change needs no answer from the former runner.
 */
export const makePersonalTakeover = (deps: {
  readonly records: RoutineRunnerRecords;
  readonly listTasks: Effect.Effect<ReadonlyArray<ScheduledTask>, ScheduledTaskError>;
  readonly findTask: (
    id: ScheduledTaskId,
  ) => Effect.Effect<ScheduledTask | null, ScheduledTaskError>;
  readonly seat: (projectId: ProjectId) => Effect.Effect<PersonalRunnerSeat>;
  /** Whether the project's `userdata` was copied to another linked machine (`copiedUserdata`). */
  readonly copied: (projectId: ProjectId) => Effect.Effect<boolean>;
  readonly writing: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  readonly followAgain: (
    id: ScheduledTaskId,
    record: RoutineRunnerRecord,
  ) => Effect.Effect<void, ScheduledTaskError | SqlError>;
  readonly notifyChanged: Effect.Effect<void>;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const all = yield* deps.records.all;
    const tasks = (yield* deps.listTasks).filter(isRunnerRoutine);
    const anyDisarmed = [...all.values()].some((record) => record.state === "disarmed");
    // A one-time slot this seat rested on a copied project (the same routine on the
    // runner) belonged to the former runner, which fired its own copy.
    const restedOnce = tasks.filter(
      (task) =>
        task.schedule.type === "once" &&
        task.nextRunAt !== null &&
        task.lastRunError === PERSONAL_RESTING_NOTE &&
        !all.has(task.id),
    );
    if (!anyDisarmed && restedOnce.length === 0) return;
    let changed = false;
    const seats = new Map<string, PersonalRunnerSeat>();
    const seatOf = (projectId: ProjectId) =>
      Effect.gen(function* () {
        if (!seats.has(projectId)) seats.set(projectId, yield* deps.seat(projectId));
        return seats.get(projectId) ?? null;
      });
    for (const task of restedOnce) {
      if ((yield* seatOf(task.projectId)) !== "runs" || !(yield* deps.copied(task.projectId)))
        continue;
      const at = yield* DateTime.now;
      if (Date.parse(task.nextRunAt!) > DateTime.toEpochMillis(at)) continue;
      yield* deps.writing(deps.records.setSlot(task.id, null));
      changed = true;
    }
    for (const task of tasks) {
      const record = all.get(task.id);
      if (record?.state !== "disarmed" || isPendingCopyDelete(record)) continue;
      if ((yield* seatOf(task.projectId)) !== "runs") continue;
      changed =
        (yield* deps.writing(
          deps.records.atomically(
            Effect.gen(function* () {
              const now = yield* deps.records.readStrict(task.id);
              if (now?.state !== "disarmed" || isPendingCopyDelete(now)) return false;
              yield* deps.followAgain(task.id, now);
              const held = yield* deps.findTask(task.id);
              if (held === null || !held.enabled) return true;
              const at = yield* DateTime.now;
              const due = held.nextRunAt === null ? null : Date.parse(held.nextRunAt);
              const past = due === null || due <= DateTime.toEpochMillis(at);
              // A one-time slot that passed while this seat rested belonged to the former
              // runner (a run never reaches this copy), so it is never fired here again.
              if (held.schedule.type === "once") {
                if (past && held.nextRunAt !== null) yield* deps.records.setSlot(task.id, null);
              } else if (past) yield* deps.records.setSlot(task.id, nextRunAt(held, at));
              return true;
            }),
          ),
        )) || changed;
    }
    if (changed) yield* deps.notifyChanged;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not take back a personal assistant's routines", { cause }),
    ),
  );
