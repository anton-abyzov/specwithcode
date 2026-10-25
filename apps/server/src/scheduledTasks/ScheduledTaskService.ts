import {
  CommandId,
  MessageId,
  ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTaskDeleteInput,
  type ScheduledTaskDeleteResult,
  type ScheduledTaskGetWebhookDeliveryInput,
  type ScheduledTaskGetWebhookDeliveryResult,
  type ScheduledTaskListWebhookDeliveriesInput,
  type ScheduledTaskListWebhookDeliveriesResult,
  type ScheduledTaskRotateWebhookTokenInput,
  type ScheduledTaskListResult,
  type ScheduledTaskMutationResult,
  type ScheduledTaskRunNowInput,
  type ScheduledTaskRunNowResult,
  type ScheduledTaskSetEnabledInput,
  type ScheduledTaskUpsertInput,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectCoordinatorService } from "../project/ProjectCoordinatorService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { checkedPrompt, isModelPinned, runScheduledTaskCheck } from "./ScheduledTaskCheck.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import { isMissedFixedTimeRun, isSameSchedule } from "./Schedule.ts";
import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import { assertTaskAdmission, suspendedProjectState } from "./ScheduledTaskAdmission.ts";
import { reserveRun, completeRun } from "./ScheduledTaskRunReceipt.ts";
import { DEFER_DEFAULT_MS, routeRoutineFire } from "./ScheduledTaskProviderRoute.ts";
import { makeWebhookTrigger } from "./ScheduledTaskWebhookTrigger.ts";
import { makeRecordTurnFailure } from "./ScheduledTaskTurnFailure.ts";
import {
  firedOccurrence,
  isFinalPostFailure,
  NO_STUCK_FIRE,
  OCCURRENCE_PRUNE_EVERY_MS,
  occurrenceIds,
  ONCE_TURNED_OFF,
  onceFireOutcome,
  pendingOccurrence,
  saveOccurrence,
  scheduledFireKey,
  type StuckFire,
  stuckOnceFire,
} from "./ScheduledTaskOccurrence.ts";
import { followDispatchedOccurrences } from "./ScheduledTaskFollow.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import {
  asOwnThreadRoutine,
  bindOwnThread,
  ownThreadLaunchCommandId,
  readRoutineProject,
  type RoutineProject,
  withLiveOwnThread,
} from "./ScheduledTaskOwnThread.ts";
import { routineBriefHeader } from "@specweave-studio/shared/routineBrief";

import {
  decodeRow,
  encodeRunPolicyJson,
  errorMessage,
  iso,
  listDueTasks,
  nextRunAfter,
  nextRunAfterStuck,
  nextRunAt,
  readOnceGeneration,
  recoverInterruptedRow,
  taskError,
  type ScheduledTaskRow,
} from "./ScheduledTaskStorage.ts";
export { WEBHOOK_ROUTE_PREFIX, listDueTasks } from "./ScheduledTaskStorage.ts";
const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

export { relayHookBaseUrl } from "./ScheduledTaskStorage.ts";
import { ScheduledTaskWebhookOrigin, WebhookDeliverySkipped } from "./ScheduledTaskTypes.ts";
export { ScheduledTaskWebhookOrigin } from "./ScheduledTaskTypes.ts";

import type { WebhookTriggerRequest, WebhookTriggerResult } from "./ScheduledTaskTypes.ts";
export type {
  WebhookTriggerRequest,
  WebhookTriggerResult,
  WebhookDeliveryOutcome,
} from "./ScheduledTaskTypes.ts";

export class ScheduledTaskService extends Context.Service<
  ScheduledTaskService,
  {
    readonly list: () => Effect.Effect<ScheduledTaskListResult, ScheduledTaskError>;
    /** Emits the full task list on subscribe and again after every change (CRUD, run transitions, reschedules). */
    readonly subscribeList: () => Stream.Stream<ScheduledTaskListResult, ScheduledTaskError>;
    readonly upsert: (
      input: ScheduledTaskUpsertInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    /** Partial update flipping only the enabled flag; never touches other fields. */
    readonly setEnabled: (
      input: ScheduledTaskSetEnabledInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly delete: (
      input: ScheduledTaskDeleteInput,
    ) => Effect.Effect<ScheduledTaskDeleteResult, ScheduledTaskError>;
    readonly runNow: (
      input: ScheduledTaskRunNowInput,
    ) => Effect.Effect<ScheduledTaskRunNowResult, ScheduledTaskError>;
    /** Issues a new URL token for a webhook task; the old URL stops working at once. */
    readonly rotateWebhookToken: (
      input: ScheduledTaskRotateWebhookTokenInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly listWebhookDeliveries: (
      input: ScheduledTaskListWebhookDeliveriesInput,
    ) => Effect.Effect<ScheduledTaskListWebhookDeliveriesResult, ScheduledTaskError>;
    readonly getWebhookDelivery: (
      input: ScheduledTaskGetWebhookDeliveryInput,
    ) => Effect.Effect<ScheduledTaskGetWebhookDeliveryResult, ScheduledTaskError>;
    /**
     * A run counts as succeeded once its message is dispatched. When that
     * message's turn fails later, record the failure, unless the task has run
     * again since. "running" means the dispatch has not been recorded yet.
     */
    readonly recordTurnFailure: (input: {
      readonly id: ScheduledTaskId;
      readonly requestedAt: DateTime.DateTime;
      readonly error: string;
    }) => Effect.Effect<"recorded" | "running" | "stale", ScheduledTaskError>;
    /**
     * Verifies, logs and dispatches one webhook request. Returns as soon as the
     * delivery is logged; the run itself continues in the background so senders
     * with short timeouts get their answer immediately.
     */
    readonly triggerWebhook: (
      request: WebhookTriggerRequest,
    ) => Effect.Effect<WebhookTriggerResult, ScheduledTaskError>;
  }
>()("specweave-studio/scheduledTasks/ScheduledTaskService") {}

export const layer = Layer.effect(
  ScheduledTaskService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const coordinators = Option.getOrUndefined(
      yield* Effect.serviceOption(ProjectCoordinatorService),
    );
    const secretRequests = yield* SecretRequests.SecretRequests;
    const scheduler = yield* Scheduler.Scheduler;
    const updateHold = yield* ServiceUpdateHold.optional;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const processRunner = Option.getOrUndefined(
      yield* Effect.serviceOption(ProcessRunner.ProcessRunner),
    );
    const admission = yield* ProjectAdmission.ProjectAdmission;
    // Optional: a host without provider snapshots fires every run as before.
    const providerRegistry = Option.getOrUndefined(
      yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry),
    );
    // Optional: without settings a fire whose provider cannot take it waits, never moves.
    const serverSettings = Option.getOrUndefined(
      yield* Effect.serviceOption(ServerSettings.ServerSettingsService),
    );
    const readWebhookOrigin = yield* ScheduledTaskWebhookOrigin;
    const activeRuns = yield* Ref.make<ReadonlySet<ScheduledTaskId>>(new Set());
    // Sliding(1) coalesces the dirty-signal: every notification triggers a
    // full list() re-emit anyway, so a slow subscriber only ever needs the
    // latest signal — an unbounded backlog would just grow memory.
    const changesPubSub = yield* PubSub.sliding<void>(1);
    const notifyChanged = PubSub.publish(changesPubSub, undefined).pipe(Effect.asVoid);

    const selectAllRows = () => sql<ScheduledTaskRow>`
      SELECT
        task_id,
        title,
        prompt,
        enabled,
        schedule_json,
        project_id,
        thread_id,
        workspace_strategy_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        created_by,
        creation_source,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        last_run_status,
        last_run_error,
        run_count,
        webhook_token,
        webhook_secret,
        run_policy_json
      FROM scheduled_tasks
      ORDER BY updated_at DESC, task_id ASC
    `;

    // Strict decode for the API surface: a corrupt row is a visible error.
    const listRows = Effect.fn("ScheduledTaskService.listRows")(function* () {
      const rows = yield* selectAllRows();
      const origin = yield* readWebhookOrigin;
      const tasks = yield* Effect.forEach(rows, (row) => decodeRow(row, origin), {
        concurrency: 1,
      });
      // One project read per project, not per routine.
      const projectsById = new Map<string, RoutineProject | null>();
      for (const projectId of new Set(tasks.map((task) => task.projectId)))
        projectsById.set(
          projectId,
          yield* readRoutineProject(projectId).pipe(
            Effect.provideService(ProjectStore.ProjectStoreV2, projects),
          ),
        );
      return tasks.map((task) =>
        asOwnThreadRoutine(task, projectsById.get(task.projectId) ?? null),
      );
    });

    const getRows = (id: ScheduledTaskId) => sql<ScheduledTaskRow>`
      SELECT
        task_id,
        title,
        prompt,
        enabled,
        schedule_json,
        project_id,
        thread_id,
        workspace_strategy_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        created_by,
        creation_source,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        last_run_status,
        last_run_error,
        run_count,
        webhook_token,
        webhook_secret,
        run_policy_json
      FROM scheduled_tasks
      WHERE task_id = ${id}
    `;

    // The routine as it runs and lists: never in the coordinator (see asOwnThreadRoutine).
    const ownThreadRoutine = (task: ScheduledTask) =>
      readRoutineProject(task.projectId).pipe(
        Effect.map((project) => asOwnThreadRoutine(task, project)),
        Effect.provideService(ProjectStore.ProjectStoreV2, projects),
      );

    /** Load a task, returning `null` when it does not exist; real load/decode failures propagate. */
    const findTask = Effect.fn("ScheduledTaskService.findTask")(function* (id: ScheduledTaskId) {
      const rows = yield* getRows(id).pipe(
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: id, cause }),
        ),
      );
      const row = rows[0];
      if (row === undefined) return null;
      return yield* decodeRow(row, yield* readWebhookOrigin);
    });

    const findWebhookCredentials = (id: ScheduledTaskId) =>
      getRows(id).pipe(
        Effect.map((rows) =>
          rows[0] === undefined
            ? null
            : { token: rows[0].webhook_token, secret: rows[0].webhook_secret },
        ),
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: id, cause }),
        ),
      );

    const newWebhookToken = crypto.randomBytes(32).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
      Effect.mapError((cause) => taskError("Could not generate webhook token.", { cause })),
    );

    const loadTask = Effect.fn("ScheduledTaskService.loadTask")(function* (id: ScheduledTaskId) {
      const task = yield* findTask(id);
      if (task === null) {
        return yield* taskError("Schedule task not found.", { taskId: id });
      }
      return task;
    });

    // Run-state columns (last_run_*, run_count) are intentionally absent from
    // the conflict clause: they are owned by the run transitions below, and a
    // concurrent settings save must not overwrite an in-flight increment.
    // Check existence in the write itself so an edit cannot undo a deletion
    // that landed after upsert loaded the previous task.
    const saveTask = (
      task: ScheduledTask,
      requireExisting: boolean,
      webhook: {
        readonly token: string | null;
        readonly secret: string | null;
        /** False when the save carried no new secret, so a concurrent change survives. */
        readonly secretChanged: boolean;
      },
      onceGeneration: number,
    ) =>
      sql<{ task_id: string }>`
        INSERT INTO scheduled_tasks (
          task_id,
          title,
          prompt,
          enabled,
          schedule_json,
          project_id,
          thread_id,
          workspace_strategy_json,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_by,
          creation_source,
          created_at,
          updated_at,
          next_run_at,
          last_run_at,
          last_run_status,
          last_run_error,
          run_count,
          webhook_token,
          webhook_secret,
          run_policy_json
        )
        SELECT
          ${task.id},
          ${task.title},
          ${task.prompt},
          ${task.enabled ? 1 : 0},
          ${JSON.stringify(task.schedule)},
          ${task.projectId},
          ${task.threadId},
          ${JSON.stringify(task.workspaceStrategy)},
          ${JSON.stringify(task.modelSelection)},
          ${task.runtimeMode},
          ${task.interactionMode},
          ${task.createdBy},
          ${task.creationSource},
          ${task.createdAt},
          ${task.updatedAt},
          ${task.nextRunAt},
          ${task.lastRunAt},
          ${task.lastRunStatus},
          ${task.lastRunError},
          ${task.runCount},
          ${webhook.token},
          ${webhook.secret},
          ${encodeRunPolicyJson(task, onceGeneration)}
        WHERE ${requireExisting ? 0 : 1} = 1
           OR EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${task.id})
        ON CONFLICT (task_id)
        DO UPDATE SET
          title = excluded.title,
          prompt = excluded.prompt,
          enabled = excluded.enabled,
          schedule_json = excluded.schedule_json,
          project_id = excluded.project_id,
          thread_id = excluded.thread_id,
          workspace_strategy_json = excluded.workspace_strategy_json,
          model_selection_json = excluded.model_selection_json,
          run_policy_json = excluded.run_policy_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          creation_source = excluded.creation_source,
          updated_at = excluded.updated_at,
          next_run_at = excluded.next_run_at,
          -- Only rotate changes a live token, so a save racing a rotation
          -- cannot bring the old URL back.
          webhook_token = CASE
            WHEN excluded.webhook_token IS NULL THEN NULL
            ELSE COALESCE(scheduled_tasks.webhook_token, excluded.webhook_token)
          END,
          webhook_secret = CASE
            WHEN ${webhook.secretChanged ? 1 : 0} = 1 THEN excluded.webhook_secret
            ELSE scheduled_tasks.webhook_secret
          END
        RETURNING task_id
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not save schedule task.", { taskId: task.id, cause }),
        ),
        Effect.flatMap((rows) =>
          rows.length > 0
            ? Effect.void
            : taskError("Schedule task not found.", { taskId: task.id }),
        ),
      );

    const deleteRow = (id: ScheduledTaskId) =>
      sql
        .withTransaction(
          sql`DELETE FROM scheduled_task_webhook_deliveries WHERE task_id = ${id}`.pipe(
            Effect.andThen(
              sql`UPDATE scheduled_task_run_receipts SET result_json = NULL, task_created_at = '' WHERE task_id = ${id}`,
            ),
            Effect.andThen(sql`DELETE FROM scheduled_tasks WHERE task_id = ${id}`),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not delete schedule task.", { taskId: id, cause }),
          ),
        );

    // Run-state transitions use targeted UPDATEs (never the full-row upsert) so
    // a completing run cannot resurrect a deleted task or clobber concurrent
    // edits to the task definition.
    const markRunning = (task: ScheduledTask, startedAtIso: string) =>
      sql<{ task_id: string }>`
        UPDATE scheduled_tasks
        SET updated_at = ${startedAtIso},
            last_run_at = ${startedAtIso},
            last_run_status = 'running',
            last_run_error = NULL
        WHERE task_id = ${task.id} AND created_at = ${task.createdAt}
          AND last_run_status <> 'running' AND run_count = ${task.runCount}
          AND last_run_at IS ${task.lastRunAt} AND next_run_at IS ${task.nextRunAt}
        RETURNING task_id
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not mark schedule task as running.", { taskId: task.id, cause }),
        ),
        // A task deleted after the re-read must not be dispatched from the stale snapshot.
        Effect.flatMap((rows) =>
          rows.length > 0
            ? Effect.void
            : taskError("Routine was changed, deleted, or admitted by another worker.", {
                taskId: task.id,
              }),
        ),
      );

    const markCompleted = (input: {
      readonly id: ScheduledTaskId;
      readonly completedAtIso: string;
      readonly nextRunAtIso: string | null;
      readonly status: "succeeded" | "failed";
      readonly error: string | null;
      readonly startedAtIso: string;
      /** False for a deferred occurrence: nothing ran. */
      readonly countRun: boolean;
      /** A one-time task whose run is over without one to start. */
      readonly disable: boolean;
    }) =>
      sql`
        UPDATE scheduled_tasks
        SET updated_at = ${input.completedAtIso},
            enabled = CASE WHEN ${input.disable ? 1 : 0} = 1 THEN 0 ELSE enabled END,
            next_run_at = ${input.nextRunAtIso},
            last_run_status = ${input.status},
            last_run_error = ${input.error},
            run_count = run_count + ${input.countRun ? 1 : 0}
        WHERE task_id = ${input.id}
          AND last_run_status = 'running'
          AND last_run_at = ${input.startedAtIso}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not record schedule task run.", { taskId: input.id, cause }),
        ),
      );

    const recordTurnFailure = makeRecordTurnFailure({ sql, findTask, notifyChanged });

    // Best-effort escape hatch: if anything fails between markRunning and
    // markCompleted, write a full terminal record so runDueTasks neither skips
    // the task forever (it filters out 'running' rows) nor re-fires it
    // immediately: the dispatch may already have gone out, so next_run_at must
    // advance and run_count must count the attempt. A one-time task's fired
    // slot has nowhere to advance to: once its post went out, or after
    // ONCE_POST_ATTEMPTS fires that got stuck before posting, it turns off
    // with the error. Until then it backs off like a run a restart cut off,
    // under the same fire key, so the next try posts the same occurrence once.
    const releaseStuckRun = (
      task: ScheduledTask,
      message: string,
      scheduled: boolean,
      fire: StuckFire,
    ) =>
      Effect.gen(function* () {
        const now = yield* localNow;
        // Compute the next occurrence from the current row so a schedule
        // edited while the run was in flight is honoured; fall back to the
        // run's snapshot only if the re-read itself fails.
        const reread = yield* Effect.result(findTask(task.id));
        if (Result.isSuccess(reread) && reread.success === null) return; // deleted — nothing to release
        const source = Result.isSuccess(reread) && reread.success !== null ? reread.success : task;
        const ownSlot =
          scheduled &&
          source.schedule.type === "once" &&
          isSameSchedule(task.schedule, source.schedule);
        const retire =
          ownSlot &&
          (yield* stuckOnceFire(source, fire, message).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          ));
        const next = retire ? null : nextRunAfterStuck(source, now, DEFER_DEFAULT_MS);
        yield* sql`
          UPDATE scheduled_tasks
          SET last_run_status = 'failed',
              last_run_error = ${
                retire
                  ? `${message} ${ONCE_TURNED_OFF}`
                  : ownSlot && next !== null
                    ? `Trying again at ${next}: ${message}`
                    : message
              },
              enabled = CASE WHEN ${retire ? 1 : 0} = 1 THEN 0 ELSE enabled END,
              next_run_at = ${next},
              updated_at = ${iso(now)},
              run_count = run_count + 1
          WHERE task_id = ${task.id} AND last_run_status = 'running'
        `;
        yield* notifyChanged;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not release stuck schedule task run", {
            taskId: task.id,
            cause,
          }),
        ),
      );

    /** Refused, with the reason shown as is, while the service is held or gated for an update. */
    const refuseWhileUpdating = (taskId: ScheduledTaskId) =>
      updateHold
        .refuse("scheduled-task.run")
        .pipe(Effect.catch((refused) => Effect.fail(taskError(refused.message, { taskId }))));

    // An archived or paused project refuses its routines until it is restored.
    // Its due runs move on to their next time instead of failing on every poll,
    // and the first one says why, once per task. A one-time task keeps its
    // slot, so it fires once the project is back, and is not rewritten meanwhile.
    const suspendedTasks = yield* Ref.make<ReadonlySet<string>>(new Set());
    const deferSuspendedRun = Effect.fn("ScheduledTaskService.deferSuspendedRun")(function* (
      task: ScheduledTask,
      state: "archived" | "paused",
      now: DateTime.DateTime,
    ) {
      const next = nextRunAfter(task, now, false);
      const first = yield* Ref.modify(suspendedTasks, (ids) =>
        ids.has(task.id) ? [false, ids] : [true, new Set([...ids, task.id])],
      );
      if (first) {
        yield* Effect.logWarning("Scheduled task skipped while its project is not active", {
          taskId: task.id,
          projectId: task.projectId,
          reason: state,
          nextRunAt: next,
        });
      }
      if (next === task.nextRunAt) return task;
      yield* sql`
        UPDATE scheduled_tasks
        SET next_run_at = ${next},
            updated_at = ${iso(now)}
        WHERE task_id = ${task.id}
          AND next_run_at IS ${task.nextRunAt}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not reschedule schedule task run.", { taskId: task.id, cause }),
        ),
      );
      yield* notifyChanged;
      return { ...task, nextRunAt: next, updatedAt: iso(now) };
    });

    const runTask = Effect.fn("ScheduledTaskService.runTask")(function* (
      task: ScheduledTask,
      trigger: "scheduled" | "manual" | "webhook",
      webhook?: { readonly deliveryId: string; readonly prompt: string },
      manualCommandId?: CommandId,
    ) {
      // A run records its receipt first, which an update in progress must not see.
      yield* refuseWhileUpdating(task.id);
      const reserved = yield* Ref.modify(activeRuns, (active) => {
        if (active.has(task.id)) return [false, active] as const;
        const next = new Set(active);
        next.add(task.id);
        return [true, next] as const;
      });
      if (!reserved) {
        if (trigger !== "scheduled") {
          return yield* taskError("Schedule task is already running.", { taskId: task.id });
        }
        return task;
      }
      const admitted = yield* Ref.make(false);
      // What a stuck fire got to, for releaseStuckRun.
      const stuckFire = yield* Ref.make(NO_STUCK_FIRE);
      return yield* Effect.gen(function* () {
        const startedAt = yield* localNow;
        const startedAtIso = iso(startedAt);

        // The in-memory snapshot may be stale: re-read before touching run
        // state. The task may have been deleted, paused, or postponed since
        // the poll loaded it — none of those may fire.
        const stored = yield* findTask(task.id);
        // An own thread that is gone counts as none: this run starts a new one.
        const active =
          stored === null
            ? null
            : yield* ownThreadRoutine(stored).pipe(
                Effect.flatMap(withLiveOwnThread),
                Effect.provideService(SqlClient.SqlClient, sql),
              );
        if (active === null) {
          if (webhook !== undefined) {
            return yield* new WebhookDeliverySkipped({
              reason: "The task was deleted before this delivery ran.",
            });
          }
          // A manual run on a just-deleted task must fail loudly, not report
          // a successful run that never dispatched.
          if (trigger !== "scheduled") {
            return yield* taskError("Schedule task not found.", { taskId: task.id });
          }
          return task;
        }
        // A next_run_at corrupted between the poll read and this re-read must
        // not defect the poll; an unparseable value is treated as not due.
        const parsedNextRunAt =
          active.nextRunAt === null ? Option.none() : DateTime.make(active.nextRunAt);
        if (
          trigger === "scheduled" &&
          (!active.enabled ||
            Option.isNone(parsedNextRunAt) ||
            DateTime.toEpochMillis(parsedNextRunAt.value) > DateTime.toEpochMillis(startedAt))
        ) {
          return active;
        }
        // A queued delivery must not run a task that was paused, deleted and
        // recreated under the same id, or switched to another trigger while
        // it waited for its turn.
        if (webhook !== undefined) {
          const reason =
            active.createdAt !== task.createdAt
              ? "The task was replaced before this delivery ran."
              : active.schedule.type !== "webhook"
                ? "The task's trigger changed before this delivery ran."
                : !active.enabled
                  ? "The task was paused before this delivery ran."
                  : null;
          if (reason !== null) return yield* new WebhookDeliverySkipped({ reason });
        }

        const suspended = yield* assertTaskAdmission(active).pipe(
          Effect.provideService(ProjectStore.ProjectStoreV2, projects),
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.as(null),
          Effect.catch((error) => {
            const state = trigger === "scheduled" ? suspendedProjectState(error) : null;
            return state === null ? Effect.fail(error) : Effect.succeed(state);
          }),
        );
        if (suspended !== null) return yield* deferSuspendedRun(active, suspended, startedAt);
        yield* Ref.update(suspendedTasks, (ids) => {
          if (!ids.has(active.id)) return ids;
          const next = new Set(ids);
          next.delete(active.id);
          return next;
        });
        yield* markRunning(active, startedAtIso);
        yield* Ref.set(admitted, true);
        yield* notifyChanged;

        // A scheduled occurrence that waited for its provider keeps its fire
        // key, so its later dispatch is the same message, sent once. A
        // webhook run is keyed by its delivery so the same delivery can
        // never dispatch twice.
        // A one-time task's arming keys its fire, so turning it back on or
        // moving it posts anew (see scheduledFireKey).
        const generation =
          trigger === "scheduled" && active.schedule.type === "once"
            ? yield* readOnceGeneration(active).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.mapError((cause) =>
                  taskError("Could not read schedule task.", { taskId: active.id, cause }),
                ),
              )
            : 0;
        const pending =
          trigger === "scheduled"
            ? yield* pendingOccurrence(active, generation).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.catch((cause) =>
                  Effect.logWarning("Could not read a routine's waiting run", {
                    taskId: active.id,
                    cause,
                  }).pipe(Effect.as(null)),
                ),
              )
            : null;
        const fireKey =
          pending?.fireKey ??
          (webhook === undefined
            ? manualCommandId === undefined
              ? trigger === "scheduled"
                ? scheduledFireKey(active, generation)
                : `${active.id}:${yield* crypto.randomUUIDv4}:manual`
              : `${active.id}:manual:${manualCommandId}`
            : `${active.id}:webhook:${webhook.deliveryId}`);
        const failedBefore = pending?.failedPosts ?? 0;
        yield* Ref.set(stuckFire, {
          ...NO_STUCK_FIRE,
          key: fireKey,
          startedAtIso,
          failedPosts: failedBefore,
        });
        const ids = occurrenceIds(fireKey);
        const commandId = CommandId.make(ids.commandId);
        const messageId = MessageId.make(ids.messageId);
        // Dispatch from the fresh row so prompt/model/binding edits made
        // after the poll read are honoured. A webhook prompt was rendered
        // from the row when the request arrived.
        let prompt = webhook?.prompt ?? active.prompt;
        if (active.brief) {
          const { year, month, day } = DateTime.toParts(startedAt);
          prompt =
            routineBriefHeader({
              title: active.title,
              brief: active.brief,
              date: { year, month, day },
            }) + prompt;
        }
        // A command routine wakes the thread only when its check passes; a
        // quiet check ends the run here, without any agent or provider.
        const check = active.check ?? null;
        const checked =
          check === null
            ? null
            : yield* Effect.exit(
                processRunner === undefined
                  ? Effect.fail("Command checks are not available on this host.")
                  : projects.get(active.projectId).pipe(
                      Effect.orElseSucceed(() => Option.none()),
                      Effect.flatMap((project) =>
                        runScheduledTaskCheck(
                          processRunner,
                          check,
                          Option.getOrUndefined(project)?.workspaceRoot ?? undefined,
                        ),
                      ),
                    ),
              );
        if (check !== null && checked?._tag === "Success" && checked.value.passed) {
          prompt = checkedPrompt(prompt, check, checked.value.output);
        }
        // Only a routine set to "Use a specific model" overrides the project's choice.
        const pinned = isModelPinned(active);
        // Each destination is routed on the model its dispatch below will
        // use: a new own thread on the routine's model; a bound thread on what
        // its next turn resolves to. A thread the fallback moved goes back once its
        // provider can take a turn; a provider that cannot take this run
        // moves it under the `switch` rule, and otherwise the occurrence
        // waits (see routineRoute). A snapshot that cannot be read fires as
        // before.
        // The model a prompt posted to `threadId` is sent with (see sendTo).
        const sendModel = (threadId: ThreadId) =>
          pinned
            ? Effect.succeed(active.modelSelection)
            : coordinators === undefined
              ? Effect.succeed(undefined)
              : coordinators.nextTurnModel(active.projectId, threadId);
        const providerDestination =
          active.threadId !== null
            ? sendModel(ThreadId.make(active.threadId)).pipe(
                Effect.map((modelSelection) => ({ threadId: active.threadId, modelSelection })),
              )
            : Effect.succeed({ threadId: null, modelSelection: active.modelSelection });
        const fallbackRule =
          serverSettings === undefined
            ? Effect.succeed(null)
            : serverSettings.getSettings.pipe(
                Effect.map(
                  (settings) => resolveProjectSettings(settings, active.projectId).settings,
                ),
                Effect.orElseSucceed(() => null),
              );
        const route =
          providerRegistry === undefined ||
          (checked !== null && (checked._tag === "Failure" || !checked.value.passed))
            ? null
            : yield* Effect.all([
                providerRegistry.getProviders,
                providerDestination,
                fallbackRule,
                projects.get(active.projectId).pipe(
                  Effect.map((project) => Option.getOrNull(project)),
                  Effect.orElseSucceed(() => null),
                ),
              ]).pipe(
                Effect.flatMap(([providers, destination, rule, project]) =>
                  routeRoutineFire({
                    task: active,
                    providers,
                    destination,
                    rule,
                    project: project as Parameters<typeof routeRoutineFire>[0]["project"],
                    nowMs: DateTime.toEpochMillis(startedAt),
                  }),
                ),
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.catch((cause) =>
                  Effect.logWarning("Could not check a routine's provider", {
                    taskId: active.id,
                    cause,
                  }).pipe(Effect.as(null)),
                ),
              );
        // Only a scheduled occurrence can wait; a run someone asked for now
        // reports why it did not run.
        const deferral = route?.type === "defer" && trigger === "scheduled" ? route : null;
        const providerSkip =
          route?.type === "defer" && deferral === null ? `Skipped: ${route.reason}` : null;
        // The model a moved fire dispatches on; undefined dispatches as before.
        const routedModel =
          route?.type === "fire" && route.note !== null ? route.modelSelection : undefined;
        if (route?.type === "fire" && route.note !== null)
          yield* Effect.logInfo("Scheduled task run moved to another provider", {
            taskId: active.id,
            note: route.note,
          });
        if (route?.type === "defer")
          yield* Effect.logWarning("Scheduled task run cannot start on its provider", {
            taskId: active.id,
            reason: route.reason,
            deferred: deferral !== null,
          });
        // The thread this fire posted to, for following its run.
        let dispatchedTo: ThreadId | null = null;
        const recordDispatch = (threadId: ThreadId) =>
          Effect.sync(() => {
            dispatchedTo = threadId;
          }).pipe(Effect.andThen(Ref.update(stuckFire, (fire) => ({ ...fire, posted: true }))));

        // Post the prompt into a thread of the routine's project, re-checking
        // the destination under the project lock.
        const sendTo = (threadId: ThreadId, text: string) =>
          admission.withLock(
            active.projectId,
            assertTaskAdmission({ ...active, threadId }).pipe(
              Effect.provideService(ProjectStore.ProjectStoreV2, projects),
              Effect.provideService(SqlClient.SqlClient, sql),
              // An unpinned run never moves its thread to another provider by
              // itself: the task's model is only a snapshot of what the thread
              // ran on when the task was made. A coordinator takes the model a
              // user message would get; any other thread keeps its own, unless
              // the route above moved this fire.
              Effect.andThen(
                routedModel === undefined ? sendModel(threadId) : Effect.succeed(routedModel),
              ),
              Effect.flatMap((modelSelection) =>
                threadManagement.sendToThread({
                  projectId: active.projectId,
                  commandId,
                  threadId,
                  messageId,
                  scheduledTaskId: active.id,
                  text,
                  attachments: [],
                  ...(modelSelection === undefined ? {} : { modelSelection }),
                  // Scheduled prompts must not interrupt tools in the bound thread.
                  mode: "queue",
                  createdBy: active.createdBy,
                  creationSource: active.creationSource,
                }),
              ),
              Effect.andThen(recordDispatch(threadId)),
            ),
          );

        // A routine with a thread of its own starts it, titled after the
        // routine, and binds it; a launch resumed after an interrupted run
        // gets this run's prompt as a follow-up.
        const launchOwnThreadUnchecked = (replacing: string | null) =>
          threadLaunch
            .launch({
              commandId: ownThreadLaunchCommandId(active, replacing),
              projectId: active.projectId,
              title: active.title,
              modelSelection: routedModel ?? active.modelSelection,
              runtimeMode: active.runtimeMode,
              interactionMode: active.interactionMode,
              workspaceStrategy: active.workspaceStrategy,
              initialMessage: {
                messageId,
                scheduledTaskId: active.id,
                text: prompt,
                attachments: [],
              },
              createdBy: active.createdBy,
              creationSource: active.creationSource,
            })
            .pipe(
              Effect.tap(({ threadId }) =>
                bindOwnThread({
                  taskId: active.id,
                  replacing,
                  threadId,
                  updatedAt: startedAtIso,
                }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
              ),
              Effect.tap(({ threadId }) => recordDispatch(threadId)),
              // Resumed by a later run: its prompt is not in the thread yet.
              Effect.flatMap(({ threadId, resumed, projection }) =>
                resumed && !projection.messages.some((message) => message.id === messageId)
                  ? sendTo(threadId, prompt)
                  : Effect.void,
              ),
            );

        // A pre-run check can outlive a project handoff. Recheck ownership at
        // dispatch, under the same reentrant lock used by bound-thread sends.
        const launchOwnThread = (replacing: string | null) =>
          admission.withLock(
            active.projectId,
            assertTaskAdmission(active).pipe(
              Effect.provideService(ProjectStore.ProjectStoreV2, projects),
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.andThen(launchOwnThreadUnchecked(replacing)),
            ),
          );

        // Effect.exit (not Effect.result) so defects and interruptions in the
        // dispatch are also captured and recorded as a failed run instead of
        // aborting before markCompleted.
        const result =
          checked !== null && checked._tag === "Failure"
            ? checked
            : route?.type === "defer" || (checked !== null && !checked.value.passed)
              ? Exit.void
              : active.threadId !== null
                ? yield* Effect.exit(sendTo(ThreadId.make(active.threadId), prompt))
                : // No live thread yet: start the routine's own (see asOwnThreadRoutine),
                  // replacing whatever thread the stored row still names.
                  yield* Effect.exit(launchOwnThread(stored?.threadId ?? null));

        const completedAt = yield* localNow;
        const runSucceeded = result._tag === "Success" && route?.type !== "defer";
        const lastRunStatus = runSucceeded ? ("succeeded" as const) : ("failed" as const);
        // Re-read the task so the next run is computed from the schedule as it
        // is *now* (the user may have edited or deleted it while we ran).
        const current = yield* findTask(task.id);
        const scheduleSource = current ?? task;
        const failedPosts = (pending?.failedPosts ?? 0) + (result._tag === "Failure" ? 1 : 0);
        const once = onceFireOutcome({
          trigger,
          fired: active.schedule,
          current: scheduleSource,
          deferred: deferral !== null,
          dispatched: dispatchedTo !== null,
          failed: result._tag === "Failure",
          // A check that cannot run will not run on a retry either.
          final:
            result._tag === "Failure" && (result === checked || isFinalPostFailure(result.cause)),
          failedPosts,
          completedAtMs: DateTime.toEpochMillis(completedAt),
        });
        // A waiting occurrence comes back at its retry time, not the next one.
        const waitUntilMs = deferral?.untilMs ?? once.retryAtMs;
        const deferredUntil =
          waitUntilMs === null || !scheduleSource.enabled
            ? null
            : iso(DateTime.makeUnsafe(waitUntilMs));
        const failure = result._tag === "Success" ? null : errorMessage(result.cause);
        const lastRunError =
          deferral !== null
            ? `Deferred${deferredUntil === null ? "" : ` until ${deferredUntil}`}: ${deferral.reason}`
            : once.retryAtMs !== null
              ? `${deferredUntil === null ? "" : `Trying again at ${deferredUntil}: `}${failure}`
              : once.gaveUp
                ? `${failure} ${ONCE_TURNED_OFF}`
                : (providerSkip ?? failure);
        const completed: ScheduledTask = {
          ...scheduleSource,
          enabled: scheduleSource.enabled && !once.disable,
          updatedAt: iso(completedAt),
          lastRunAt: startedAtIso,
          nextRunAt:
            waitUntilMs !== null
              ? deferredUntil
              : nextRunAfter(scheduleSource, completedAt, once.fired),
          lastRunStatus,
          lastRunError,
          runCount: scheduleSource.runCount + (deferral === null ? 1 : 0),
        };
        if (current !== null) {
          // The occurrence is recorded first: a waiting one must be found by
          // the fire that retries it, and a dispatched one is followed to its
          // run's real outcome.
          const occurrence = firedOccurrence({
            fireKey,
            waiting: waitUntilMs !== null,
            dispatchedTo: runSucceeded ? dispatchedTo : null,
            messageId,
            dispatchedAt: startedAtIso,
            reason:
              waitUntilMs !== null ? lastRunError : route?.type === "fire" ? route.note : null,
            failedPosts,
          });
          // A waiting occurrence this fire ended without posting is over, so
          // a later fire does not pick up its fire key again.
          const closed =
            occurrence ??
            (pending === null
              ? null
              : { ...pending, state: "failed" as const, reason: lastRunError });
          if (closed !== null)
            yield* saveOccurrence(current, closed, startedAtIso).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.mapError((cause) =>
                taskError("Could not record schedule task run.", { taskId: task.id, cause }),
              ),
            );
          // startedAtIso in the guard ensures this writes only to the row this
          // run marked as running — a task deleted mid-run and recreated with
          // the same id (idempotent commandId replay) must not be stamped.
          yield* markCompleted({
            id: task.id,
            completedAtIso: completed.updatedAt,
            nextRunAtIso: completed.nextRunAt,
            status: lastRunStatus,
            error: lastRunError,
            startedAtIso,
            countRun: deferral === null,
            disable: once.disable,
          });
          yield* notifyChanged;
        }
        return completed;
      }).pipe(
        Effect.onError((cause) =>
          Effect.all([Ref.get(admitted), Ref.get(stuckFire)]).pipe(
            Effect.flatMap(([owned, fire]) =>
              owned
                ? releaseStuckRun(task, errorMessage(cause), trigger === "scheduled", fire)
                : Effect.void,
            ),
          ),
        ),
        Effect.ensuring(
          Ref.update(activeRuns, (active) => {
            const next = new Set(active);
            next.delete(task.id);
            return next;
          }),
        ),
      );
    });

    // A due fixed-time run that is long past its slot (server was off or
    // asleep) is skipped and re-aimed at its next occurrence, not fired late.
    const rescheduleMissedRun = Effect.fn("ScheduledTaskService.rescheduleMissedRun")(function* (
      task: ScheduledTask,
      now: DateTime.DateTime,
    ) {
      const next = nextRunAt(task, now);
      yield* Effect.logInfo("Skipping missed schedule task run", {
        taskId: task.id,
        missedRunAt: task.nextRunAt,
        rescheduledTo: next,
      });
      yield* sql`
        UPDATE scheduled_tasks
        SET next_run_at = ${next},
            updated_at = ${iso(now)}
        WHERE task_id = ${task.id}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not reschedule missed schedule task run.", { taskId: task.id, cause }),
        ),
      );
      yield* notifyChanged;
    });

    // A fire reports what its run came to, not that it was posted (see
    // followDispatchedOccurrences). Settled occurrences are pruned hourly.
    const prunedAt = yield* Ref.make(Number.NEGATIVE_INFINITY);
    const followDispatchedRuns = Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(yield* localNow);
      const prune = nowMs - (yield* Ref.get(prunedAt)) >= OCCURRENCE_PRUNE_EVERY_MS;
      if (prune) yield* Ref.set(prunedAt, nowMs);
      const changed = yield* followDispatchedOccurrences(nowMs, prune);
      if (changed) yield* notifyChanged;
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catch((cause) => Effect.logWarning("Could not follow scheduled task runs", { cause })),
    );

    const runDueTasks = Effect.fn("ScheduledTaskService.runDueTasks")(function* () {
      yield* followDispatchedRuns;
      const now = yield* localNow;
      const tasks = yield* listDueTasks(now).pipe(
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );
      const due = tasks.flatMap((task) =>
        task.nextRunAt === null ? [] : [{ task, dueAt: DateTime.makeUnsafe(task.nextRunAt) }],
      );
      const heldMsBetween = scheduler.heldMsBetween ?? (() => Effect.succeed(0));
      yield* Effect.forEach(
        due,
        ({ task, dueAt }) =>
          heldMsBetween(DateTime.toEpochMillis(dueAt), DateTime.toEpochMillis(now)).pipe(
            // A waiting occurrence is never missed: it fires late rather than not at all.
            Effect.flatMap((heldMs) =>
              isMissedFixedTimeRun(task.schedule, dueAt, now, heldMs)
                ? pendingOccurrence(task).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql),
                    Effect.orElseSucceed(() => null),
                    Effect.flatMap((waiting) =>
                      waiting === null
                        ? rescheduleMissedRun(task, now)
                        : runTask(task, "scheduled"),
                    ),
                  )
                : runTask(task, "scheduled"),
            ),
            Effect.catch((cause) =>
              Effect.logWarning("Scheduled task run failed", { taskId: task.id, cause }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    });

    // Recover from a crash or hard shutdown mid-run: rows stuck in 'running' would otherwise be
    // skipped by the due-task filter forever. The dispatch may already have gone out before the
    // crash, so next_run_at must advance and run_count must count the attempt — otherwise the
    // first poll after every restart re-fires the interrupted task (same rationale as
    // releaseStuckRun). Schedules are JSON, so this is per-row Effect work, not one UPDATE.
    // While an update's install gate (or hold) is live it waits: the update helper compares
    // these rows with its snapshot, and a row stuck in 'running' cannot run or re-fire
    // meanwhile (the due filter and markRunning both skip it). Only the rows stuck when
    // this server started are recovered, each only if it still shows that same run, so a
    // run that starts after the gate opens is never taken for an interrupted one.
    const stuckAtStart = (yield* selectAllRows().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not read interrupted schedule task runs", { cause }).pipe(
          Effect.as([]),
        ),
      ),
    )).filter((row) => row.last_run_status === "running");
    const recoverInterruptedRuns = Effect.gen(function* () {
      const stuck = stuckAtStart;
      if (stuck.length === 0) return;
      const now = yield* localNow;
      yield* Effect.forEach(
        stuck,
        (row) =>
          recoverInterruptedRow(row, now, DEFER_DEFAULT_MS).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          ),
        { concurrency: 1, discard: true },
      );
      yield* notifyChanged;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not reset interrupted schedule task runs", { cause }),
      ),
    );
    if (yield* updateHold.isHeld) {
      yield* updateHold.awaitReleased.pipe(
        Effect.andThen(recoverInterruptedRuns),
        Effect.forkScoped,
      );
    } else {
      yield* recoverInterruptedRuns;
    }

    yield* scheduler.register("scheduled-tasks", runDueTasks());

    const list: ScheduledTaskService["Service"]["list"] = () =>
      listRows().pipe(
        Effect.map((tasks) => ({ tasks })),
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );

    const subscribeList: ScheduledTaskService["Service"]["subscribeList"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before taking the snapshot so a change landing between
          // the two is buffered by the subscription rather than dropped.
          const subscription = yield* PubSub.subscribe(changesPubSub);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
          );
        }),
      );

    const upsert: ScheduledTaskService["Service"]["upsert"] = (input) =>
      Effect.gen(function* () {
        const now = yield* localNow;
        const uuid =
          input.commandId === undefined
            ? yield* crypto.randomUUIDv4.pipe(
                Effect.mapError((cause) =>
                  taskError("Could not generate schedule task id.", { cause }),
                ),
              )
            : null;
        const id =
          input.id ??
          ScheduledTaskId.make(
            input.commandId ? `scheduled-task:${input.commandId}` : `scheduled-task:${uuid}`,
          );
        // Look up by the *resolved* id so idempotent creates (commandId replays)
        // keep their run history, and so real load failures propagate instead
        // of silently resetting an existing row.
        const existingTask = yield* findTask(id);
        // Keep the existing next_run_at when the schedule itself is untouched:
        // editing a title or prompt must not postpone (or resurrect) a due
        // run — only schedule/enabled changes restart the clock.
        const schedule: ScheduledTask["schedule"] =
          input.schedule.type === "webhook"
            ? {
                type: "webhook",
                signature:
                  input.schedule.signature == null
                    ? null
                    : {
                        header: input.schedule.signature.header.toLowerCase(),
                        encoding: input.schedule.signature.encoding,
                        prefix: input.schedule.signature.prefix,
                      },
                maxDeliveryAgeMinutes: input.schedule.maxDeliveryAgeMinutes ?? null,
              }
            : input.schedule;
        const webhook =
          input.schedule.type === "webhook"
            ? yield* Effect.gen(function* () {
                const existing = existingTask === null ? null : yield* findWebhookCredentials(id);
                // Saving a webhook task keeps its URL; only rotate changes it.
                const token = existing?.token ?? (yield* newWebhookToken);
                const signature =
                  input.schedule.type === "webhook" ? input.schedule.signature : null;
                // A secretRef is a value the user entered for an agent; this
                // save consumes it, so it cannot be used again. A replay of a
                // save that already used it keeps the secret that save stored.
                const replay = input.commandId !== undefined && existing?.secret != null;
                const fromRef =
                  signature?.secretRef === undefined
                    ? undefined
                    : yield* secretRequests
                        .consume({ ref: signature.secretRef, projectId: input.projectId })
                        .pipe(
                          Effect.catch((error) =>
                            replay
                              ? Effect.succeed(undefined)
                              : Effect.fail(taskError(error.message, { taskId: id })),
                          ),
                        );
                // A ref, when given, is the only source: a plain secret sent
                // alongside it must not replace what a replayed save stored.
                const provided = signature?.secretRef === undefined ? signature?.secret : fromRef;
                const secret = signature == null ? null : (provided ?? existing?.secret ?? null);
                const secretChanged =
                  signature == null || provided !== undefined || existing === null;
                if (signature != null && secret === null) {
                  return yield* taskError("A webhook signature check needs a signing secret.", {
                    taskId: id,
                  });
                }
                return { token, secret, secretChanged };
              })
            : { token: null, secret: null, secretChanged: true };
        const scheduleUnchanged =
          existingTask !== null &&
          existingTask.enabled === input.enabled &&
          isSameSchedule(existingTask.schedule, schedule);
        // A one-time task turned on or off, or moved, is armed anew.
        const onceGeneration =
          existingTask === null
            ? 0
            : (yield* readOnceGeneration(existingTask).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.mapError((cause) =>
                  taskError("Could not load schedule task.", { taskId: id, cause }),
                ),
              )) + (schedule.type === "once" && !scheduleUnchanged ? 1 : 0);
        const saved: ScheduledTask = {
          id,
          title: input.title,
          prompt: input.prompt,
          enabled: input.enabled,
          schedule,
          projectId: input.projectId,
          // A form that leaves the thread out keeps an own thread bound.
          threadId:
            input.threadId === undefined && (input.ownThread ?? existingTask?.ownThread)
              ? (existingTask?.threadId ?? null)
              : (input.threadId ?? null),
          workspaceStrategy: input.workspaceStrategy,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          createdBy: existingTask?.createdBy ?? input.createdBy ?? "user",
          creationSource: input.creationSource ?? "web",
          createdAt: existingTask?.createdAt ?? iso(now),
          updatedAt: iso(now),
          nextRunAt: scheduleUnchanged
            ? existingTask.nextRunAt
            : nextRunAt({ enabled: input.enabled, schedule }, now),
          lastRunAt: existingTask?.lastRunAt ?? null,
          lastRunStatus: existingTask?.lastRunStatus ?? "never",
          lastRunError: existingTask?.lastRunError ?? null,
          runCount: existingTask?.runCount ?? 0,
          // A save that leaves these out (a client form that predates them)
          // keeps what the task has; null clears a check.
          ...((input.modelPinned ?? existingTask?.modelPinned) === undefined
            ? {}
            : { modelPinned: (input.modelPinned ?? existingTask?.modelPinned)! }),
          ...((input.check === undefined ? existingTask?.check : input.check)
            ? { check: (input.check === undefined ? existingTask?.check : input.check)! }
            : {}),
          ...((input.brief === undefined ? existingTask?.brief : input.brief)
            ? { brief: (input.brief === undefined ? existingTask?.brief : input.brief)! }
            : {}),
          ...((input.ownThread ?? existingTask?.ownThread) ? { ownThread: true } : {}),
        };
        // Saved as it will run: a routine left without a thread, or pointed at
        // the coordinator, gets a thread of its own.
        const task = yield* ownThreadRoutine(saved);
        yield* saveTask(task, input.requireExisting === true, webhook, onceGeneration);
        yield* notifyChanged;
        return { task: (yield* findTask(id)) ?? task };
      });

    const setEnabled: ScheduledTaskService["Service"]["setEnabled"] = (input) =>
      Effect.gen(function* () {
        const existing = yield* loadTask(input.id);
        if (existing.enabled === input.enabled) return { task: existing };
        const now = yield* localNow;
        const next = nextRunAt({ enabled: input.enabled, schedule: existing.schedule }, now);
        // A one-time task is armed anew, so it fires under a new key.
        const rearm = existing.schedule.type === "once" ? 1 : 0;
        // RETURNING so a task deleted between the load and this UPDATE is a
        // visible not-found error, not a false success.
        const updated = yield* sql<{ task_id: string }>`
          UPDATE scheduled_tasks
          SET enabled = ${input.enabled ? 1 : 0},
              next_run_at = ${next},
              run_policy_json = CASE WHEN ${rearm} = 1
                THEN json_set(COALESCE(run_policy_json, '{}'), '$.onceGeneration',
                  COALESCE(json_extract(run_policy_json, '$.onceGeneration'), 0) + 1)
                ELSE run_policy_json END,
              updated_at = ${iso(now)}
          WHERE task_id = ${input.id}
          RETURNING task_id
        `.pipe(
          Effect.mapError((cause) =>
            taskError("Could not update schedule task.", { taskId: input.id, cause }),
          ),
        );
        if (updated.length === 0) {
          return yield* taskError("Schedule task not found.", { taskId: input.id });
        }
        yield* notifyChanged;
        return {
          task: { ...existing, enabled: input.enabled, nextRunAt: next, updatedAt: iso(now) },
        };
      });

    const deleteTask: ScheduledTaskService["Service"]["delete"] = (input) =>
      deleteRow(input.id).pipe(
        Effect.andThen(webhooks.forget(input.id)),
        Effect.andThen(notifyChanged),
        Effect.as({ id: input.id }),
      );

    const runNow: ScheduledTaskService["Service"]["runNow"] = (input: ScheduledTaskRunNowInput) =>
      Effect.gen(function* () {
        const task = yield* loadTask(input.id).pipe(
          Effect.flatMap((loaded) =>
            ownThreadRoutine(loaded).pipe(
              Effect.flatMap(withLiveOwnThread),
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
          ),
        );
        if (task.schedule.type === "webhook") {
          // There is no request to render the prompt from.
          return yield* taskError("Webhook tasks run when their URL receives a request.", {
            taskId: input.id,
          });
        }
        yield* assertTaskAdmission(task).pipe(
          Effect.provideService(ProjectStore.ProjectStoreV2, projects),
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        // Before the receipt below: nothing is written while an update is in progress.
        yield* refuseWhileUpdating(task.id);
        if (input.commandId !== undefined) {
          const replay = yield* reserveRun(input.commandId, task, iso(yield* localNow)).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          if (replay !== null) return { task: replay };
        }
        const next = yield* runTask(task, "manual", undefined, input.commandId).pipe(
          Effect.mapError((cause) =>
            taskError("Could not run schedule task.", { taskId: input.id, cause }),
          ),
        );
        if (input.commandId !== undefined)
          yield* completeRun(input.commandId, task.id, next).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.mapError(
              (cause) =>
                new ScheduledTaskError({
                  message:
                    "Run dispatched but its receipt could not be saved. Check its thread before retrying.",
                  reason: "run_outcome_unknown",
                  taskId: input.id,
                  cause,
                }),
            ),
          );
        return { task: next };
      });

    const rotateWebhookToken: ScheduledTaskService["Service"]["rotateWebhookToken"] = (input) =>
      Effect.gen(function* () {
        const task = yield* loadTask(input.id);
        if (task.schedule.type !== "webhook") {
          return yield* taskError("Only webhook tasks have a URL token.", { taskId: input.id });
        }
        const token = yield* newWebhookToken;
        const now = yield* localNow;
        // Matching created_at keeps a rotation from landing on a task deleted
        // and recreated under the same id since it was loaded.
        const updated = yield* sql<{ task_id: string }>`
          UPDATE scheduled_tasks
          SET webhook_token = ${token}, updated_at = ${iso(now)}
          WHERE task_id = ${input.id} AND created_at = ${task.createdAt}
          RETURNING task_id
        `.pipe(
          Effect.mapError((cause) =>
            taskError("Could not rotate webhook token.", { taskId: input.id, cause }),
          ),
        );
        if (updated.length === 0) {
          return yield* taskError("Schedule task was deleted or replaced.", { taskId: input.id });
        }
        yield* notifyChanged;
        return { task: yield* loadTask(input.id) };
      });

    const webhooks = yield* makeWebhookTrigger({
      getRows,
      runTask: (task, webhook) => runTask(task, "webhook", webhook),
    });

    return ScheduledTaskService.of({
      list,
      subscribeList,
      upsert,
      setEnabled,
      delete: deleteTask,
      runNow,
      rotateWebhookToken,
      listWebhookDeliveries: webhooks.listWebhookDeliveries,
      getWebhookDelivery: webhooks.getWebhookDelivery,
      triggerWebhook: webhooks.triggerWebhook,
      recordTurnFailure,
    });
  }),
).pipe(Layer.provide(ProjectAdmission.layer));
