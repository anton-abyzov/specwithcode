/**
 * Release 1.0.379's ScheduledTaskCopies.ts, as it shipped: what a machine that
 * was not updated, or was put back on that release, does with the routines a
 * coordinator sends it, in a replica and in a handover. Its replica writer
 * saves each routine as sent, on or off, and knows nothing of a runner record.
 *
 * Only the service class is left out (the type of the one beside it stands
 * in) and `makeRoutineCopies` is named for its release. Never edited to
 * follow the code beside it.
 */
import {
  COORDINATOR_ROUTINE_COPIES_MAX,
  CoordinatorRoutineCopy,
  type ProjectId,
  type ScheduledTask,
  type ScheduledTaskError,
  type ScheduledTaskGrantedBy,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { sha256 } from "../nodeCrypto.ts";
import type { RoutineCopies } from "./ScheduledTaskCopies.ts";
import { decodeRoutineGrantJson, taskError } from "./ScheduledTaskStorage.ts";

/**
 * Routine failover for automatic coordinator takeover. The coordinator's lease
 * loop sends its standby the project's coordinator-owned routines; the
 * standby keeps them as routines of its own copy, under the same ids, and
 * they rest there (see ScheduledTaskCoordinatorGate) until that copy
 * coordinates. Served by ScheduledTaskService; kept apart so the project link
 * and the lease loop need not depend on the scheduler.
 */
export interface RoutineCopiesSnapshot {
  readonly routines: ReadonlyArray<CoordinatorRoutineCopy>;
  /** `coordinatorRoutinesDigest(routines)`. */
  readonly digest: string;
}

/**
 * Whether the project's coordinator owns the routine, so it follows the
 * coordinator: a routine with a thread of its own. A routine bound to a
 * worker thread stays with that machine's worker.
 */
export const isCoordinatorOwnedRoutine = (task: Pick<ScheduledTask, "ownThread">) =>
  task.ownThread === true;

/**
 * The routine as its standby keeps it, or null when it does not travel: a
 * worker's routine, or a webhook one, whose URL and signing secret belong to
 * this machine. A one-time routine that already ran goes turned off. A
 * routine made under another machine's work grant keeps that grant, so the
 * copy runs only within the grant that machine gives the standby.
 */
export function routineCopyOf(
  task: ScheduledTask,
  grantedBy?: ScheduledTaskGrantedBy | undefined,
): CoordinatorRoutineCopy | null {
  if (!isCoordinatorOwnedRoutine(task) || task.schedule.type === "webhook") return null;
  const spent = task.schedule.type === "once" && task.nextRunAt === null;
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled && !spent,
    schedule: task.schedule,
    workspaceStrategy: task.workspaceStrategy,
    modelSelection: task.modelSelection,
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
    createdBy: task.createdBy,
    ...(task.modelPinned === undefined ? {} : { modelPinned: task.modelPinned }),
    ...(task.check ? { check: task.check } : {}),
    ...(task.brief ? { brief: task.brief } : {}),
    ...(grantedBy === undefined ? {} : { grantedBy }),
  };
}

/** The project's routines that travel, in id order, at most COORDINATOR_ROUTINE_COPIES_MAX. */
export function routineCopiesOf(
  tasks: ReadonlyArray<ScheduledTask>,
  projectId: ProjectId,
  grants: ReadonlyMap<string, ScheduledTaskGrantedBy> = new Map(),
): ReadonlyArray<CoordinatorRoutineCopy> {
  return tasks
    .filter((task) => task.projectId === projectId)
    .flatMap((task) => {
      const copy = routineCopyOf(task, grants.get(task.id));
      return copy === null ? [] : [copy];
    })
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, COORDINATOR_ROUTINE_COPIES_MAX);
}

/**
 * Which routines a replica carries. Apart from `coordinatorContentDigest`, so
 * a standby that predates routine copies still accepts the notes, goal and
 * instructions it checks. The standby keeps the coordinator's value as sent:
 * it may read fewer routines than were sent (ForwardCompatibleArray).
 */
const encodeRoutinesJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(CoordinatorRoutineCopy)),
);

export function coordinatorRoutinesDigest(routines: ReadonlyArray<CoordinatorRoutineCopy>) {
  return sha256([encodeRoutinesJson(routines)]).toString("hex");
}

/**
 * The most a replica's routines may take as JSON. The replica limit leaves this
 * much beside the largest notes, on standbys that predate routine copies too.
 */
export const COORDINATOR_ROUTINE_COPIES_MAX_BYTES = 256 * 1024;

/** Whether a copy holds every routine sent; a full list may have been cut, so nothing is removed. */
export const routineCopiesComplete = (routines: ReadonlyArray<CoordinatorRoutineCopy>) =>
  routines.length < COORDINATOR_ROUTINE_COPIES_MAX;

export interface RoutineCopiesDeps {
  readonly listTasks: Effect.Effect<ReadonlyArray<ScheduledTask>, ScheduledTaskError>;
  /** Moves on whenever a routine changes, so a snapshot is read again only then. */
  readonly generation: Effect.Effect<number>;
  readonly findTask: (
    id: ScheduledTaskId,
  ) => Effect.Effect<ScheduledTask | null, ScheduledTaskError>;
  readonly upsert: (
    input: ScheduledTaskUpsertInput,
    options: { readonly grantedBy: ScheduledTaskGrantedBy | null },
  ) => Effect.Effect<unknown, ScheduledTaskError>;
  readonly remove: (id: ScheduledTaskId) => Effect.Effect<unknown, ScheduledTaskError>;
}

const decodeUpsert = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

/** The `RoutineCopies` service over the scheduler's own reads and saves. */
export const makeRoutineCopies379 = (deps: RoutineCopiesDeps) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const failed = (message: string) => (cause: unknown) => taskError(message, { cause });

    const markShared = (
      projectId: ProjectId,
      logicalProjectId: string,
      ids: ReadonlyArray<string>,
    ) =>
      Effect.forEach(
        ids,
        (id) => sql`
          UPDATE scheduled_tasks
          SET run_policy_json = json_set(COALESCE(run_policy_json, '{}'), '$.copiedFrom', ${logicalProjectId})
          WHERE task_id = ${id} AND project_id = ${projectId}
            AND json_extract(run_policy_json, '$.copiedFrom') IS NOT ${logicalProjectId}
        `,
        { concurrency: 1, discard: true },
      ).pipe(Effect.mapError(failed("Could not mark a routine copy.")));

    // The grants routines were made under, by id; read with the routines they belong to.
    const grantsOf = (projectId: ProjectId) =>
      sql<{ readonly task_id: string; readonly run_policy_json: string | null }>`
        SELECT task_id, run_policy_json FROM scheduled_tasks
        WHERE project_id = ${projectId}
          AND json_extract(run_policy_json, '$.grantedBy') IS NOT NULL
      `.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodeRoutineGrantJson(row.run_policy_json).pipe(
              Effect.map((grantedBy) => [row.task_id, grantedBy] as const),
            ),
          ),
        ),
        Effect.map(
          (pairs) =>
            new Map(
              pairs.flatMap(([id, grantedBy]) =>
                grantedBy === undefined ? [] : [[id, grantedBy] as const],
              ),
            ),
        ),
        Effect.mapError(failed("Could not read the grants of routine copies.")),
      );

    // Read on every lease, so kept until a routine changes.
    const cached = new Map<
      string,
      { readonly generation: number; readonly snapshot: RoutineCopiesSnapshot | null }
    >();
    const snapshot: RoutineCopies["Service"]["snapshot"] = ({ projectId, logicalProjectId }) =>
      Effect.gen(function* () {
        const generation = yield* deps.generation;
        const key = `${projectId}\u0000${logicalProjectId}`;
        const held = cached.get(key);
        if (held !== undefined && held.generation === generation) return held.snapshot;
        const routines = routineCopiesOf(
          yield* deps.listTasks,
          projectId,
          yield* grantsOf(projectId),
        );
        const json = encodeRoutinesJson(routines);
        let result: RoutineCopiesSnapshot | null = null;
        if (Buffer.byteLength(json) > COORDINATOR_ROUTINE_COPIES_MAX_BYTES) {
          yield* Effect.logWarning("Routines too large to copy to the standby", {
            projectId,
            routines: routines.length,
          });
        } else {
          yield* markShared(
            projectId,
            logicalProjectId,
            routines.map((copy) => copy.id),
          );
          result = { routines, digest: coordinatorRoutinesDigest(routines) };
        }
        cached.set(key, { generation, snapshot: result });
        return result;
      });

    const keep = (
      projectId: ProjectId,
      logicalProjectId: string,
      copy: CoordinatorRoutineCopy,
      grants: ReadonlyMap<string, ScheduledTaskGrantedBy>,
    ) =>
      Effect.gen(function* () {
        const held = yield* deps.findTask(copy.id);
        // An id this machine uses for another project's routine is never taken over.
        if (held !== null && held.projectId !== projectId) {
          yield* Effect.logWarning("Skipped a routine copy whose id another project uses here", {
            taskId: copy.id,
          });
          return;
        }
        // Unchanged: only marked, so a resend of 200 routines saves only those that changed.
        const kept = held === null ? null : routineCopyOf(held, grants.get(held.id));
        const same = kept !== null && encodeRoutinesJson([kept]) === encodeRoutinesJson([copy]);
        if (same) return yield* markShared(projectId, logicalProjectId, [copy.id]);
        const input = yield* decodeUpsert({
          id: copy.id,
          title: copy.title,
          prompt: copy.prompt,
          enabled: copy.enabled,
          schedule: copy.schedule,
          projectId,
          threadId: null,
          workspaceStrategy: copy.workspaceStrategy,
          modelSelection: copy.modelSelection,
          runtimeMode: copy.runtimeMode,
          interactionMode: copy.interactionMode,
          createdBy: copy.createdBy,
          creationSource: "server",
          modelPinned: copy.modelPinned ?? false,
          // A copy matches the coordinator's: what it left out is cleared here.
          check: copy.check ?? null,
          brief: copy.brief ?? null,
          ownThread: true,
        }).pipe(Effect.mapError(failed("Could not read a routine copy.")));
        // The copy's grant, or none: an owner's routine sent from there is the owner's here.
        yield* deps.upsert(input, { grantedBy: copy.grantedBy ?? null });
        yield* markShared(projectId, logicalProjectId, [copy.id]);
      }).pipe(
        // One routine this copy refuses (team rules, say) never holds back the others.
        Effect.catch((error) =>
          Effect.logWarning("Could not keep a routine copy", { taskId: copy.id, cause: error }),
        ),
      );

    const replace: RoutineCopies["Service"]["replace"] = ({
      projectId,
      logicalProjectId,
      routines,
    }) =>
      Effect.gen(function* () {
        const grants = yield* grantsOf(projectId);
        yield* Effect.forEach(routines, (copy) => keep(projectId, logicalProjectId, copy, grants), {
          concurrency: 1,
          discard: true,
        });
        if (!routineCopiesComplete(routines)) return;
        const sent = new Set<string>(routines.map((copy) => copy.id));
        const held = yield* sql<{ readonly task_id: string }>`
          SELECT task_id FROM scheduled_tasks
          WHERE project_id = ${projectId}
            AND json_extract(run_policy_json, '$.copiedFrom') = ${logicalProjectId}
        `.pipe(Effect.mapError(failed("Could not list routine copies.")));
        yield* Effect.forEach(
          held.filter((row) => !sent.has(row.task_id)),
          (row) => deps.remove(ScheduledTaskId.make(row.task_id)),
          { concurrency: 1, discard: true },
        );
      });

    const owned: NonNullable<RoutineCopies["Service"]["owned"]> = (projectId) =>
      deps.listTasks.pipe(
        Effect.map((tasks) =>
          tasks
            .filter(
              (task) =>
                task.projectId === projectId &&
                task.enabled &&
                isCoordinatorOwnedRoutine(task) &&
                task.schedule.type !== "webhook",
            )
            .slice(0, COORDINATOR_ROUTINE_COPIES_MAX)
            .map((task) => ({ id: task.id, title: task.title.slice(0, 1000) })),
        ),
      );

    return { snapshot, replace, owned };
  });
