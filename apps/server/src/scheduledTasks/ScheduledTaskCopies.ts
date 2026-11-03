import {
  COORDINATOR_ROUTINE_COPIES_MAX,
  CoordinatorRoutineCopy,
  type ProjectId,
  type ScheduledTask,
  type ScheduledTaskError,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { sha256 } from "../nodeCrypto.ts";
import { taskError } from "./ScheduledTaskStorage.ts";

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

export class RoutineCopies extends Context.Service<
  RoutineCopies,
  {
    /**
     * What this copy would send its standby, or null when its routines are too
     * large to travel with the notes (then none are sent, and the standby keeps
     * what it has). The routines sent are marked as the logical project's, so a
     * machine that later stands by for another copy drops them once deleted there.
     */
    readonly snapshot: (input: {
      readonly projectId: ProjectId;
      readonly logicalProjectId: string;
    }) => Effect.Effect<RoutineCopiesSnapshot | null, ScheduledTaskError>;
    /**
     * Keeps `routines` as this copy's own: each saved under its id, and the
     * routines marked as `logicalProjectId`'s (copied here, or sent from here
     * while this copy coordinated) that are no longer sent removed. Its other
     * routines are never removed.
     */
    readonly replace: (input: {
      readonly projectId: ProjectId;
      readonly logicalProjectId: string;
      readonly routines: ReadonlyArray<CoordinatorRoutineCopy>;
    }) => Effect.Effect<void, ScheduledTaskError>;
  }
>()("specweave-studio/scheduledTasks/ScheduledTaskCopies/RoutineCopies") {}

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
 * this machine. A one-time routine that already ran goes turned off.
 */
export function routineCopyOf(task: ScheduledTask): CoordinatorRoutineCopy | null {
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
  };
}

/** The project's routines that travel, in id order, at most COORDINATOR_ROUTINE_COPIES_MAX. */
export function routineCopiesOf(
  tasks: ReadonlyArray<ScheduledTask>,
  projectId: ProjectId,
): ReadonlyArray<CoordinatorRoutineCopy> {
  return tasks
    .filter((task) => task.projectId === projectId)
    .flatMap((task) => {
      const copy = routineCopyOf(task);
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
  readonly upsert: (input: ScheduledTaskUpsertInput) => Effect.Effect<unknown, ScheduledTaskError>;
  readonly remove: (id: ScheduledTaskId) => Effect.Effect<unknown, ScheduledTaskError>;
}

const decodeUpsert = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

/** The `RoutineCopies` service over the scheduler's own reads and saves. */
export const makeRoutineCopies = (deps: RoutineCopiesDeps) =>
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
        const routines = routineCopiesOf(yield* deps.listTasks, projectId);
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

    const keep = (projectId: ProjectId, logicalProjectId: string, copy: CoordinatorRoutineCopy) =>
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
        const kept = held === null ? null : routineCopyOf(held);
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
        yield* deps.upsert(input);
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
        yield* Effect.forEach(routines, (copy) => keep(projectId, logicalProjectId, copy), {
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

    return RoutineCopies.of({ snapshot, replace });
  });
