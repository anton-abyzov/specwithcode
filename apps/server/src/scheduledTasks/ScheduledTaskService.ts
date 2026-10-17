import {
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
  ScheduledTaskWebhookDeliveryId,
  type ScheduledTaskDeleteInput,
  type ScheduledTaskDeleteResult,
  type ScheduledTaskGetWebhookDeliveryInput,
  type ScheduledTaskGetWebhookDeliveryResult,
  type ScheduledTaskListWebhookDeliveriesInput,
  type ScheduledTaskListWebhookDeliveriesResult,
  type ScheduledTaskRotateWebhookTokenInput,
  type ScheduledTaskWebhookDeliveryOutcome,
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
import * as Duration from "effect/Duration";
import * as Metric from "effect/Metric";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectCoordinatorService } from "../project/ProjectCoordinatorService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { checkedPrompt, isModelPinned, runScheduledTaskCheck } from "./ScheduledTaskCheck.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import { isMissedFixedTimeRun, isSameSchedule } from "./Schedule.ts";
import { redactHeaders, redactQuery, renderWebhookPrompt } from "./webhookTemplate.ts";
import { constantTimeEquals, verifyWebhookSignature } from "./webhookVerification.ts";
import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import { assertTaskAdmission, suspendedProjectState } from "./ScheduledTaskAdmission.ts";
import { reserveRun, completeRun } from "./ScheduledTaskRunReceipt.ts";

import {
  decodeRow,
  encodeRunPolicyJson,
  decodeTaskId,
  errorMessage,
  iso,
  listDueTasks,
  nextRunAt,
  taskError,
  type ScheduledTaskRow,
  type WebhookDeliveryRow,
} from "./ScheduledTaskStorage.ts";
export { WEBHOOK_ROUTE_PREFIX, listDueTasks } from "./ScheduledTaskStorage.ts";
const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);
/** Deliveries kept per task; older ones are pruned on insert. */
const WEBHOOK_DELIVERY_RETENTION = 50;
/** Body text kept in the delivery log. Larger bodies are cut and flagged. */
const WEBHOOK_DELIVERY_LOG_BODY_LIMIT = 64 * 1024;
/** Rendered prompt text kept in the delivery log. */
const WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT = 64 * 1024;
/** Deliveries one task may hold at once, running or waiting their turn. */
const WEBHOOK_MAX_QUEUED_PER_TASK = 20;
/** Accepted deliveries per task per minute, enforced here as well as on the relay because the tunnel hostname is public too. */
const WEBHOOK_RATE_LIMIT_PER_MINUTE = 60;

export { relayHookBaseUrl } from "./ScheduledTaskStorage.ts";
import {
  ScheduledTaskWebhookOrigin,
  WebhookDeliverySkipped,
  type RateWindow,
} from "./ScheduledTaskTypes.ts";
export { ScheduledTaskWebhookOrigin } from "./ScheduledTaskTypes.ts";

import type {
  WebhookTriggerRequest,
  WebhookTriggerResult,
  WebhookDeliveryOutcome,
} from "./ScheduledTaskTypes.ts";
export type {
  WebhookTriggerRequest,
  WebhookTriggerResult,
  WebhookDeliveryOutcome,
} from "./ScheduledTaskTypes.ts";

const HeadersJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const MissingFieldsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeHeadersJson = Schema.decodeUnknownOption(HeadersJson);
const decodeMissingFieldsJson = Schema.decodeUnknownOption(MissingFieldsJson);
const encodeHeadersJson = Schema.encodeSync(HeadersJson);
const encodeMissingFieldsJson = Schema.encodeSync(MissingFieldsJson);

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
    const readWebhookOrigin = yield* ScheduledTaskWebhookOrigin;
    // Webhook deliveries for one task dispatch in arrival order rather than
    // being dropped while an earlier delivery is still dispatching.
    const webhookPermits = yield* Ref.make<ReadonlyMap<ScheduledTaskId, Semaphore.Semaphore>>(
      new Map(),
    );
    // Keyed by task id and creation time, so deliveries of a deleted task that
    // finish late release their own count, never a recreated task's.
    const webhookQueued = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const webhookRateWindows = yield* Ref.make<ReadonlyMap<ScheduledTaskId, RateWindow>>(new Map());
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
      return yield* Effect.forEach(rows, (row) => decodeRow(row, origin), { concurrency: 1 });
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
          ${encodeRunPolicyJson(task)}
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
    }) =>
      sql`
        UPDATE scheduled_tasks
        SET updated_at = ${input.completedAtIso},
            next_run_at = ${input.nextRunAtIso},
            last_run_status = ${input.status},
            last_run_error = ${input.error},
            run_count = run_count + 1
        WHERE task_id = ${input.id}
          AND last_run_status = 'running'
          AND last_run_at = ${input.startedAtIso}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not record schedule task run.", { taskId: input.id, cause }),
        ),
      );

    // Best-effort escape hatch: if anything fails between markRunning and
    // markCompleted, write a full terminal record so runDueTasks neither skips
    // the task forever (it filters out 'running' rows) nor re-fires it
    // immediately: the dispatch may already have gone out, so next_run_at must
    // advance and run_count must count the attempt.
    const releaseStuckRun = (task: ScheduledTask, message: string) =>
      Effect.gen(function* () {
        const now = yield* localNow;
        // Compute the next occurrence from the current row so a schedule
        // edited while the run was in flight is honoured; fall back to the
        // run's snapshot only if the re-read itself fails.
        const reread = yield* Effect.result(findTask(task.id));
        if (Result.isSuccess(reread) && reread.success === null) return; // deleted — nothing to release
        const source = Result.isSuccess(reread) && reread.success !== null ? reread.success : task;
        yield* sql`
          UPDATE scheduled_tasks
          SET last_run_status = 'failed',
              last_run_error = ${message},
              next_run_at = ${nextRunAt(source, now)},
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
    // and the first one says why, once per task.
    const suspendedTasks = yield* Ref.make<ReadonlySet<string>>(new Set());
    const deferSuspendedRun = Effect.fn("ScheduledTaskService.deferSuspendedRun")(function* (
      task: ScheduledTask,
      state: "archived" | "paused",
      now: DateTime.DateTime,
    ) {
      const next = nextRunAt(task, now);
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
      return yield* Effect.gen(function* () {
        const startedAt = yield* localNow;
        const startedAtIso = iso(startedAt);

        // The in-memory snapshot may be stale: re-read before touching run
        // state. The task may have been deleted, paused, or postponed since
        // the poll loaded it — none of those may fire.
        const active = yield* findTask(task.id);
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

        // A webhook run is keyed by its delivery so the same delivery can
        // never dispatch twice.
        const fireKey =
          webhook === undefined
            ? manualCommandId === undefined
              ? trigger === "scheduled"
                ? `${active.id}:${active.createdAt}:${active.nextRunAt}:scheduled`
                : `${active.id}:${yield* crypto.randomUUIDv4}:manual`
              : `${active.id}:manual:${manualCommandId}`
            : `${active.id}:webhook:${webhook.deliveryId}`;
        const commandId = CommandId.make(`scheduled-task:${fireKey}`);
        const messageId = MessageId.make(`scheduled-task-message:${fireKey}`);
        // Dispatch from the fresh row so prompt/model/binding edits made
        // after the poll read are honoured. A webhook prompt was rendered
        // from the row when the request arrived.
        let prompt = webhook?.prompt ?? active.prompt;
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
        // Agent routines follow their thread; a person's pinned model is used as chosen.
        const pinned = isModelPinned(active);

        // Effect.exit (not Effect.result) so defects and interruptions in the
        // dispatch are also captured and recorded as a failed run instead of
        // aborting before markCompleted.
        const result =
          checked !== null && checked._tag === "Failure"
            ? checked
            : checked !== null && !checked.value.passed
              ? Exit.void
              : active.threadId === null
                ? yield* Effect.exit(
                    threadLaunch.launch({
                      commandId,
                      projectId: active.projectId,
                      title: active.title,
                      modelSelection: pinned
                        ? active.modelSelection
                        : ((yield* (
                            coordinators?.nextTurnModel(active.projectId, null) ??
                              Effect.succeed(undefined)
                          )) ?? active.modelSelection),
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
                    }),
                  )
                : yield* Effect.exit(
                    admission.withLock(
                      active.projectId,
                      assertTaskAdmission(active).pipe(
                        Effect.provideService(ProjectStore.ProjectStoreV2, projects),
                        Effect.provideService(SqlClient.SqlClient, sql),
                        // An unpinned run never moves its thread to another
                        // provider: the task's model is only a snapshot of what the
                        // thread ran on when the task was made. A coordinator takes
                        // the model a user message would get; any other thread
                        // keeps its own.
                        Effect.andThen(
                          pinned
                            ? Effect.succeed(active.modelSelection)
                            : coordinators === undefined
                              ? Effect.succeed(undefined)
                              : coordinators.nextTurnModel(
                                  active.projectId,
                                  ThreadId.make(active.threadId),
                                ),
                        ),
                        Effect.flatMap((modelSelection) =>
                          threadManagement.sendToThread({
                            projectId: active.projectId,
                            commandId,
                            threadId: ThreadId.make(active.threadId!),
                            messageId,
                            scheduledTaskId: active.id,
                            text: prompt,
                            attachments: [],
                            ...(modelSelection === undefined ? {} : { modelSelection }),
                            // Scheduled prompts must not interrupt tools in the bound thread.
                            mode: "queue",
                            createdBy: active.createdBy,
                            creationSource: active.creationSource,
                          }),
                        ),
                      ),
                    ),
                  );

        const completedAt = yield* localNow;
        const runSucceeded = result._tag === "Success";
        const lastRunStatus = runSucceeded ? ("succeeded" as const) : ("failed" as const);
        const lastRunError = runSucceeded ? null : errorMessage(result.cause);
        // Re-read the task so the next run is computed from the schedule as it
        // is *now* (the user may have edited or deleted it while we ran).
        const current = yield* findTask(task.id);
        const scheduleSource = current ?? task;
        const completed: ScheduledTask = {
          ...scheduleSource,
          updatedAt: iso(completedAt),
          lastRunAt: startedAtIso,
          nextRunAt: nextRunAt(scheduleSource, completedAt),
          lastRunStatus,
          lastRunError,
          runCount: scheduleSource.runCount + 1,
        };
        if (current !== null) {
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
          });
          yield* notifyChanged;
        }
        return completed;
      }).pipe(
        Effect.onError((cause) =>
          Ref.get(admitted).pipe(
            Effect.flatMap((owned) =>
              owned ? releaseStuckRun(task, errorMessage(cause)) : Effect.void,
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

    const runDueTasks = Effect.fn("ScheduledTaskService.runDueTasks")(function* () {
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
            Effect.flatMap((heldMs) =>
              isMissedFixedTimeRun(task.schedule, dueAt, now, heldMs)
                ? rescheduleMissedRun(task, now)
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
    yield* Effect.gen(function* () {
      const rows = yield* selectAllRows();
      const stuck = rows.filter((row) => row.last_run_status === "running");
      if (stuck.length === 0) return;
      const now = yield* localNow;
      yield* Effect.forEach(
        stuck,
        (row) =>
          Effect.gen(function* () {
            const decoded = yield* Effect.result(decodeRow(row));
            if (Result.isSuccess(decoded)) {
              yield* sql`
                UPDATE scheduled_tasks
                SET last_run_status = 'failed',
                    last_run_error = 'Run was interrupted by a server restart.',
                    next_run_at = ${nextRunAt(decoded.success, now)},
                    updated_at = ${iso(now)},
                    run_count = run_count + 1
                WHERE task_id IS ${row.task_id} AND last_run_status = 'running'
              `;
              return;
            }
            // The schedule cannot be decoded, so the next occurrence cannot be computed — still
            // release the row from 'running' (the lenient poller skips it, so it cannot re-fire).
            yield* Effect.logWarning(
              "Recovering undecodable schedule task row without rescheduling",
              { taskId: row.task_id, cause: decoded.failure },
            );
            yield* sql`
              UPDATE scheduled_tasks
              SET last_run_status = 'failed',
                  last_run_error = 'Run was interrupted by a server restart.',
                  updated_at = ${iso(now)},
                  run_count = run_count + 1
              WHERE task_id IS ${row.task_id} AND last_run_status = 'running'
            `;
          }),
        { concurrency: 1, discard: true },
      );
      yield* notifyChanged;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not reset interrupted schedule task runs", { cause }),
      ),
    );

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
        const task: ScheduledTask = {
          id,
          title: input.title,
          prompt: input.prompt,
          enabled: input.enabled,
          schedule,
          projectId: input.projectId,
          threadId: input.threadId ?? null,
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
        };
        yield* saveTask(task, input.requireExisting === true, webhook);
        yield* notifyChanged;
        return { task: (yield* findTask(id)) ?? task };
      });

    const setEnabled: ScheduledTaskService["Service"]["setEnabled"] = (input) =>
      Effect.gen(function* () {
        const existing = yield* loadTask(input.id);
        if (existing.enabled === input.enabled) return { task: existing };
        const now = yield* localNow;
        const next = nextRunAt({ enabled: input.enabled, schedule: existing.schedule }, now);
        // RETURNING so a task deleted between the load and this UPDATE is a
        // visible not-found error, not a false success.
        const updated = yield* sql<{ task_id: string }>`
          UPDATE scheduled_tasks
          SET enabled = ${input.enabled ? 1 : 0},
              next_run_at = ${next},
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
        Effect.andThen(
          Effect.all([
            Ref.update(webhookRateWindows, (windows) => {
              const next = new Map(windows);
              next.delete(input.id);
              return next;
            }),
            Ref.update(webhookPermits, (permits) => {
              const next = new Map(permits);
              next.delete(input.id);
              return next;
            }),
          ]),
        ),
        Effect.andThen(notifyChanged),
        Effect.as({ id: input.id }),
      );

    const runNow: ScheduledTaskService["Service"]["runNow"] = (input: ScheduledTaskRunNowInput) =>
      Effect.gen(function* () {
        const task = yield* loadTask(input.id);
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

    const deliveryHeaders = (row: WebhookDeliveryRow): Readonly<Record<string, string>> =>
      Option.getOrElse(decodeHeadersJson(row.headers_json), () => ({}));
    const decodeDeliverySummary = (row: WebhookDeliveryRow) => ({
      id: ScheduledTaskWebhookDeliveryId.make(row.delivery_id),
      taskId: ScheduledTaskId.make(row.task_id),
      receivedAt: row.received_at,
      method: row.method,
      contentType: deliveryHeaders(row)["content-type"] ?? null,
      bodyBytes: row.body_bytes,
      outcome: row.outcome as ScheduledTaskWebhookDeliveryOutcome,
      signatureVerified: row.signature_verified === 1,
      missingFields: Option.getOrElse(decodeMissingFieldsJson(row.missing_fields_json), () => []),
      error: row.error,
    });

    const listWebhookDeliveries: ScheduledTaskService["Service"]["listWebhookDeliveries"] = (
      input,
    ) =>
      sql<WebhookDeliveryRow>`
        SELECT * FROM scheduled_task_webhook_deliveries
        WHERE task_id = ${input.id}
        ORDER BY received_at DESC, rowid DESC
      `.pipe(
        Effect.map((rows) => ({ deliveries: rows.map(decodeDeliverySummary) })),
        Effect.mapError((cause) =>
          taskError("Could not list webhook deliveries.", { taskId: input.id, cause }),
        ),
      );

    const getWebhookDelivery: ScheduledTaskService["Service"]["getWebhookDelivery"] = (input) =>
      Effect.gen(function* () {
        const rows = yield* sql<WebhookDeliveryRow>`
          SELECT * FROM scheduled_task_webhook_deliveries
          WHERE task_id = ${input.id} AND delivery_id = ${input.deliveryId}
        `.pipe(
          Effect.mapError((cause) =>
            taskError("Could not load webhook delivery.", { taskId: input.id, cause }),
          ),
        );
        const row = rows[0];
        if (row === undefined) {
          return yield* taskError("Webhook delivery not found.", { taskId: input.id });
        }
        return {
          delivery: {
            ...decodeDeliverySummary(row),
            query: row.query,
            headers: deliveryHeaders(row),
            body: row.body,
            bodyTruncated: row.body_truncated === 1,
            renderedPrompt: row.rendered_prompt,
          },
        };
      });

    const recordDelivery = (input: {
      readonly id: string;
      readonly taskId: ScheduledTaskId;
      readonly receivedAt: string;
      readonly request: WebhookTriggerRequest;
      readonly outcome: ScheduledTaskWebhookDeliveryOutcome;
      readonly signatureVerified: boolean;
      readonly missing: ReadonlyArray<string>;
      readonly renderedPrompt: string | null;
      readonly error?: string;
    }) => {
      const truncated = input.request.body.byteLength > WEBHOOK_DELIVERY_LOG_BODY_LIMIT;
      const loggedBody = truncated
        ? new TextDecoder().decode(input.request.body.subarray(0, WEBHOOK_DELIVERY_LOG_BODY_LIMIT))
        : input.request.bodyText;
      return sql
        .withTransaction(
          Effect.gen(function* () {
            // Conditional on the task existing, so a delivery racing a delete
            // cannot leave rows that a recreated task with the same id would show.
            yield* sql`
              INSERT INTO scheduled_task_webhook_deliveries (
                delivery_id, task_id, received_at, method, query, headers_json, body,
                body_bytes, body_truncated, outcome, signature_verified,
                missing_fields_json, rendered_prompt, error
              )
              SELECT
                ${input.id}, ${input.taskId}, ${input.receivedAt}, ${input.request.method},
                ${redactQuery(input.request.query)},
                ${encodeHeadersJson(redactHeaders(input.request.headers))},
                ${loggedBody},
                ${input.request.body.byteLength}, ${truncated ? 1 : 0}, ${input.outcome},
                ${input.signatureVerified ? 1 : 0}, ${encodeMissingFieldsJson(input.missing)},
                ${input.renderedPrompt?.slice(0, WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT) ?? null},
                ${input.error ?? null}
              WHERE EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${input.taskId})
              -- A held request retried after a rate limit reuses its relay
              -- delivery id; the newer attempt replaces the logged one.
              ON CONFLICT (delivery_id) DO UPDATE SET
                outcome = excluded.outcome,
                signature_verified = excluded.signature_verified,
                missing_fields_json = excluded.missing_fields_json,
                rendered_prompt = excluded.rendered_prompt,
                error = excluded.error
            `;
            yield* sql`
            DELETE FROM scheduled_task_webhook_deliveries
            WHERE task_id = ${input.taskId}
              AND delivery_id NOT IN (
                SELECT delivery_id FROM scheduled_task_webhook_deliveries
                WHERE task_id = ${input.taskId}
                -- rowid breaks timestamp ties in arrival order; delivery ids are random.
                ORDER BY received_at DESC, rowid DESC
                LIMIT ${WEBHOOK_DELIVERY_RETENTION}
              )
          `;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not record webhook delivery.", { taskId: input.taskId, cause }),
          ),
        );
    };

    const markDeliveryFailed = (deliveryId: string, message: string) =>
      sql`
        UPDATE scheduled_task_webhook_deliveries
        SET outcome = 'dispatch_failed', error = ${message}
        WHERE delivery_id = ${deliveryId}
      `.pipe(Effect.ignore);

    /**
     * Sliding one-minute window counting every request with a valid token,
     * including ones the signature check later rejects.
     */
    const takeRateSlot = (id: ScheduledTaskId, nowMs: number) =>
      Ref.modify(
        webhookRateWindows,
        (
          windows,
        ): readonly [
          "allowed" | "first_rejected" | "rejected",
          ReadonlyMap<ScheduledTaskId, RateWindow>,
        ] => {
          const current = windows.get(id);
          const recent = (current?.accepted ?? []).filter((at) => nowMs - at < 60_000);
          if (recent.length >= WEBHOOK_RATE_LIMIT_PER_MINUTE) {
            const first = current?.rejectedLogged !== true;
            return [
              first ? "first_rejected" : "rejected",
              new Map(windows).set(id, { accepted: recent, rejectedLogged: true }),
            ];
          }
          return [
            "allowed",
            new Map(windows).set(id, { accepted: [...recent, nowMs], rejectedLogged: false }),
          ];
        },
      );

    const webhookPermit = (id: ScheduledTaskId) =>
      Effect.gen(function* () {
        const existing = (yield* Ref.get(webhookPermits)).get(id);
        if (existing !== undefined) return existing;
        const created = yield* Semaphore.make(1);
        return yield* Ref.modify(webhookPermits, (permits) => {
          const raced = permits.get(id);
          return raced === undefined
            ? [created, new Map(permits).set(id, created)]
            : [raced, permits];
        });
      });

    // Detached from the request so the HTTP response does not wait for the
    // run; scoped to the service so shutdown interrupts it.
    const serviceScope = yield* Effect.scope;

    /**
     * Records one handled request on the span and in metrics. `outcome` is
     * finer than the result tag: it separates a full queue and an oversized
     * prompt from the rest, which is what an operator needs to act on.
     */
    const observeDelivery = (
      request: WebhookTriggerRequest,
      outcome: WebhookDeliveryOutcome,
      receivedAt: DateTime.DateTime | undefined,
      now: DateTime.DateTime | undefined,
    ) =>
      Effect.gen(function* () {
        const source = request.relayDeliveryId === undefined ? "direct" : "relay";
        yield* Effect.annotateCurrentSpan({
          "scheduled_task.webhook.outcome": outcome,
          "scheduled_task.webhook.source": source,
        });
        yield* Metrics.increment(Metrics.webhookDeliveriesTotal, { outcome, source });
        if (request.receivedAt !== undefined && receivedAt !== undefined && now !== undefined) {
          const heldMs = Math.max(
            0,
            DateTime.toEpochMillis(now) - DateTime.toEpochMillis(receivedAt),
          );
          yield* Effect.annotateCurrentSpan({ "scheduled_task.webhook.held_ms": heldMs });
          yield* Metric.update(Metrics.webhookHeldDelay, Duration.millis(heldMs));
        }
      });

    const triggerWebhook: ScheduledTaskService["Service"]["triggerWebhook"] = (request) =>
      triggerWebhookUnobserved(request).pipe(
        Effect.tapError(() => observeDelivery(request, "error", undefined, undefined)),
        Metrics.withMetrics({ timer: Metrics.webhookDeliveryDuration }),
        Effect.withSpan("ScheduledTaskService.triggerWebhook", {
          attributes: {
            "scheduled_task.webhook.method": request.method,
            "scheduled_task.webhook.body_bytes": request.body.byteLength,
            "scheduled_task.webhook.source":
              request.relayDeliveryId === undefined ? "direct" : "relay",
          },
        }),
      );

    const triggerWebhookUnobserved = (request: WebhookTriggerRequest) =>
      Effect.gen(function* () {
        const taskId = decodeTaskId(request.hookId);
        const notFound = observeDelivery(request, "not_found", undefined, undefined).pipe(
          Effect.as({ _tag: "not_found" as const }),
        );
        if (Option.isNone(taskId)) return yield* notFound;
        const rows = yield* getRows(taskId.value).pipe(
          Effect.mapError((cause) =>
            taskError("Could not load schedule task.", { taskId: taskId.value, cause }),
          ),
        );
        const row = rows[0];
        // A wrong token is indistinguishable from an unknown hook, so the URL
        // does not reveal which hooks exist.
        if (
          row === undefined ||
          row.webhook_token === null ||
          !constantTimeEquals(request.token, row.webhook_token)
        ) {
          return yield* notFound;
        }
        const task = yield* decodeRow(row);
        yield* Effect.annotateCurrentSpan({ "scheduled_task.id": task.id });
        const schedule = task.schedule;
        if (schedule.type !== "webhook") return yield* notFound;

        const now = yield* localNow;
        // Anyone can reach the tunnel directly and set the relay's header, so
        // a receive time is never later than now: a future one would pin the
        // delivery in the log and slip past the task's max age.
        const receivedAt =
          request.receivedAt === undefined
            ? now
            : DateTime.min(
                Option.getOrElse(DateTime.make(request.receivedAt), () => now),
                now,
              );
        const observe = (outcome: WebhookDeliveryOutcome) =>
          observeDelivery(request, outcome, receivedAt, now);
        const deliveryId = ScheduledTaskWebhookDeliveryId.make(
          request.relayDeliveryId === undefined
            ? `delivery:${yield* crypto.randomUUIDv4.pipe(
                Effect.mapError((cause) => taskError("Could not generate delivery id.", { cause })),
              )}`
            : `delivery:relay:${request.relayDeliveryId}`,
        );
        // A held request may already have reached this environment directly
        // before a timeout; it runs once. Claimed in its own table, kept longer
        // than the relay holds a request, because the delivery log is trimmed.
        // A rate-limited delivery stays held on the relay, so it must give up
        // its claim or the next pass would treat it as already delivered.
        const releaseClaim = <A>(result: A) =>
          request.relayDeliveryId === undefined
            ? Effect.succeed(result)
            : sql`
                DELETE FROM scheduled_task_webhook_relay_deliveries
                WHERE relay_delivery_id = ${request.relayDeliveryId}
              `.pipe(Effect.ignore, Effect.as(result));
        // From the claim until the run is forked nothing may interrupt: a
        // request dropped in between (the relay hangs up after its timeout)
        // would leave a claimed delivery that never runs, or a queue slot
        // that is never released. Everything in here is local and quick.
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (request.relayDeliveryId !== undefined) {
              const claimed = yield* sql<{ relay_delivery_id: string }>`
                INSERT INTO scheduled_task_webhook_relay_deliveries
                  (relay_delivery_id, task_id, seen_at)
                VALUES (${request.relayDeliveryId}, ${task.id}, ${iso(now)})
                ON CONFLICT (relay_delivery_id) DO NOTHING
                RETURNING relay_delivery_id
              `.pipe(
                Effect.mapError((cause) =>
                  taskError("Could not record webhook delivery.", { taskId: task.id, cause }),
                ),
              );
              if (claimed.length === 0) {
                // A held request this environment already ran: accepted, not run twice.
                yield* observe("duplicate");
                return { _tag: "accepted" as const, deliveryId, outcome: "duplicate" as const };
              }
              // Older claims can no longer be replayed by the relay.
              yield* sql`
                DELETE FROM scheduled_task_webhook_relay_deliveries
                WHERE seen_at < ${iso(DateTime.subtract(now, { hours: 48 }))}
              `.pipe(Effect.ignore);
            }
            const log = (
              outcome: ScheduledTaskWebhookDeliveryOutcome,
              details: {
                readonly signatureVerified?: boolean;
                readonly missing?: ReadonlyArray<string>;
                readonly renderedPrompt?: string;
                readonly error?: string;
              } = {},
            ) =>
              recordDelivery({
                id: deliveryId,
                taskId: task.id,
                receivedAt: iso(receivedAt),
                request,
                outcome,
                signatureVerified: details.signatureVerified ?? false,
                missing: details.missing ?? [],
                renderedPrompt: details.renderedPrompt ?? null,
                ...(details.error === undefined ? {} : { error: details.error }),
              });

            // Only the first rejected request in a window is logged, so a flood
            // cannot write rows or push the real deliveries out of the log.
            const slot = yield* takeRateSlot(task.id, DateTime.toEpochMillis(now));
            if (slot !== "allowed") {
              if (slot === "first_rejected") yield* log("rate_limited");
              yield* observe("rate_limited");
              return yield* releaseClaim({
                _tag: "rate_limited" as const,
                outcome: "rate_limited" as const,
              });
            }
            if (!task.enabled) {
              yield* log("disabled");
              yield* observe("disabled");
              return { _tag: "disabled" as const };
            }
            const signature = schedule.signature;
            if (signature !== null) {
              const verified =
                row.webhook_secret !== null &&
                verifyWebhookSignature({
                  signature,
                  secret: row.webhook_secret,
                  headers: request.headers,
                  body: request.body,
                });
              if (!verified) {
                yield* log("rejected_signature");
                yield* observe("rejected_signature");
                return { _tag: "rejected_signature" as const };
              }
            }
            const maxAgeMinutes = schedule.maxDeliveryAgeMinutes ?? null;
            if (
              maxAgeMinutes !== null &&
              DateTime.toEpochMillis(now) - DateTime.toEpochMillis(receivedAt) >
                maxAgeMinutes * 60_000
            ) {
              yield* log("expired", { signatureVerified: signature !== null });
              yield* observe("expired");
              return { _tag: "expired" as const };
            }

            const rendered = renderWebhookPrompt(task.prompt, request);
            // A provider refuses a turn this long, so it is not started. The
            // delivery is not retryable, so the claim is kept. Providers trim
            // the prompt before checking, so whitespace around it is free.
            if (rendered.prompt.trim().length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
              yield* log("dispatch_failed", {
                signatureVerified: signature !== null,
                missing: rendered.missing,
                renderedPrompt: rendered.prompt,
                error: "The filled-in prompt is too long.",
              });
              yield* observe("prompt_too_long");
              return { _tag: "accepted" as const, deliveryId, outcome: "prompt_too_long" as const };
            }
            // Bound the deliveries one task holds, so steady traffic to a stuck
            // task cannot pile up parked fibers. A refused request is not logged,
            // so it cannot push real deliveries out of the log.
            const queueKey = `${task.id}\u0000${task.createdAt}`;
            const queued = yield* Ref.modify(webhookQueued, (counts) => {
              const count = counts.get(queueKey) ?? 0;
              return count >= WEBHOOK_MAX_QUEUED_PER_TASK
                ? ([false, counts] as const)
                : ([true, new Map(counts).set(queueKey, count + 1)] as const);
            });
            if (!queued) {
              // The task is busy with WEBHOOK_MAX_QUEUED_PER_TASK deliveries already.
              yield* observe("queue_full");
              return yield* releaseClaim({
                _tag: "rate_limited" as const,
                outcome: "queue_full" as const,
              });
            }
            // Entries leave the map when their count reaches zero, so a deleted
            // task's key does not linger once its last delivery finishes.
            const release = Ref.update(webhookQueued, (counts) => {
              const next = new Map(counts);
              const count = (next.get(queueKey) ?? 1) - 1;
              if (count <= 0) next.delete(queueKey);
              else next.set(queueKey, count);
              return next;
            });
            yield* log("accepted", {
              signatureVerified: signature !== null,
              missing: rendered.missing,
              renderedPrompt: rendered.prompt,
            }).pipe(Effect.onError(() => release));
            yield* observe("accepted");
            const permit = yield* webhookPermit(task.id);
            const runOutcome = (outcome: "started" | "skipped" | "failed") =>
              Effect.all([
                Effect.annotateCurrentSpan({ "scheduled_task.webhook.run_outcome": outcome }),
                Metrics.increment(Metrics.webhookRunsTotal, { outcome }),
              ]);
            yield* runTask(task, "webhook", { deliveryId, prompt: rendered.prompt }).pipe(
              Effect.flatMap((completed) =>
                completed.lastRunStatus === "failed"
                  ? runOutcome("failed").pipe(
                      Effect.andThen(markDeliveryFailed(deliveryId, "The run failed to start.")),
                    )
                  : runOutcome("started"),
              ),
              Effect.catchTags({
                WebhookDeliverySkipped: (skipped) =>
                  runOutcome("skipped").pipe(
                    Effect.andThen(markDeliveryFailed(deliveryId, skipped.reason)),
                  ),
              }),
              // The log is readable over RPC, so it gets a fixed reason; the
              // cause, which can carry request data, stays in the server log.
              Effect.catchCause((cause) =>
                Effect.logWarning("Webhook dispatch failed", { taskId: task.id, cause }).pipe(
                  Effect.andThen(runOutcome("failed")),
                  Effect.andThen(markDeliveryFailed(deliveryId, "The run failed to start.")),
                ),
              ),
              permit.withPermits(1),
              // Its own trace: the request that triggered it has already been answered.
              Effect.withSpan("ScheduledTaskService.runWebhookDelivery", {
                root: true,
                attributes: {
                  "scheduled_task.id": task.id,
                  "scheduled_task.webhook.delivery_id": deliveryId,
                },
              }),
              Effect.ensuring(release),
              Effect.forkIn(serviceScope),
            );
            return { _tag: "accepted" as const, deliveryId, outcome: "accepted" as const };
          }),
        );
      });

    return ScheduledTaskService.of({
      list,
      subscribeList,
      upsert,
      setEnabled,
      delete: deleteTask,
      runNow,
      rotateWebhookToken,
      listWebhookDeliveries,
      getWebhookDelivery,
      triggerWebhook,
    });
  }),
).pipe(Layer.provide(ProjectAdmission.layer));
