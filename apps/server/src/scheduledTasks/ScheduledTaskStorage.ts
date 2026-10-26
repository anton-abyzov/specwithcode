import {
  ScheduledTask,
  ScheduledTaskBrief,
  ScheduledTaskCheck,
  ScheduledTaskId,
  ScheduledTaskError,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { nextScheduledRunAt } from "./Schedule.ts";

export const WEBHOOK_ROUTE_PREFIX = "/api/hooks";

const decodeTask = Schema.decodeUnknownEffect(ScheduledTask);
export const decodeTaskId = Schema.decodeUnknownOption(ScheduledTaskId);
const decodeScheduleJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.schedule),
);
const decodeWorkspaceStrategyJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.workspaceStrategy),
);
const decodeModelSelectionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.modelSelection),
);
export interface ScheduledTaskRow {
  readonly task_id: string;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: number;
  readonly schedule_json: string;
  readonly project_id: string;
  readonly thread_id: string | null;
  readonly workspace_strategy_json: string;
  readonly model_selection_json: string;
  readonly runtime_mode: string;
  readonly interaction_mode: string;
  readonly created_by: string;
  readonly creation_source: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly next_run_at: string | null;
  readonly last_run_at: string | null;
  readonly last_run_status: string;
  readonly last_run_error: string | null;
  readonly run_count: number;
  readonly webhook_token: string | null;
  readonly webhook_secret: string | null;
  readonly run_policy_json?: string | null;
}

export interface WebhookDeliveryRow {
  readonly delivery_id: string;
  readonly task_id: string;
  readonly received_at: string;
  readonly method: string;
  readonly query: string;
  readonly headers_json: string;
  readonly body: string;
  readonly body_bytes: number;
  readonly body_truncated: number;
  readonly outcome: string;
  readonly signature_verified: number;
  readonly missing_fields_json: string;
  readonly rendered_prompt: string | null;
  readonly error: string | null;
}

export function taskError(message: string, input?: { taskId?: ScheduledTaskId; cause?: unknown }) {
  return new ScheduledTaskError({
    message,
    ...(input?.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

export function iso(value: DateTime.DateTime): string {
  return DateTime.formatIso(DateTime.toUtc(value));
}

export function nextRunAt(
  task: Pick<ScheduledTask, "enabled" | "schedule">,
  from: DateTime.DateTime,
): string | null {
  if (!task.enabled) return null;
  // A stored interval can decode yet overflow the representable DateTime
  // range; an unrepresentable occurrence means the task has no next run.
  try {
    const next = nextScheduledRunAt(task.schedule, from);
    return next !== null && Number.isFinite(DateTime.toEpochMillis(next)) ? iso(next) : null;
  } catch {
    return null;
  }
}

/**
 * next_run_at after a run of `task`, read as it is now. A one-time schedule
 * keeps its slot until the scheduled fire of that same slot takes it
 * (`fired`), so a manual run, a restart or a stuck run never re-arms or drops
 * it; every other schedule moves on to its next occurrence.
 */
export function nextRunAfter(
  task: Pick<ScheduledTask, "enabled" | "schedule" | "nextRunAt">,
  from: DateTime.DateTime,
  fired: boolean,
): string | null {
  if (task.schedule.type !== "once") return nextRunAt(task, from);
  return fired || !task.enabled ? null : task.nextRunAt;
}

/**
 * next_run_at after a run that never finished (stuck, or cut off by a
 * restart). A one-time task keeps its slot, but a slot already due comes back
 * after `backoffMs`: firing it again at once would only loop on whatever
 * stopped the run.
 */
export function nextRunAfterStuck(
  task: Pick<ScheduledTask, "enabled" | "schedule" | "nextRunAt">,
  from: DateTime.DateTime,
  backoffMs: number,
): string | null {
  const next = nextRunAfter(task, from, false);
  if (task.schedule.type !== "once" || next === null) return next;
  const retryAt = DateTime.add(from, { milliseconds: backoffMs });
  return Date.parse(next) >= DateTime.toEpochMillis(retryAt) ? next : iso(retryAt);
}

export function errorMessage(error: unknown): string {
  if (Cause.isCause(error)) return Cause.pretty(error);
  if (error instanceof Error) return error.message;
  return String(error);
}

function webhookPath(taskId: string, token: string): string {
  return `${WEBHOOK_ROUTE_PREFIX}/${encodeURIComponent(taskId)}/${token}`;
}

function webhookEndpoint(
  row: Pick<ScheduledTaskRow, "task_id" | "webhook_token" | "webhook_secret">,
  origin: { readonly relayHookBaseUrl: string | null } | null,
): ScheduledTask["webhook"] {
  if (row.webhook_token === null) return undefined;
  const base = origin?.relayHookBaseUrl ?? null;
  return {
    path: webhookPath(row.task_id, row.webhook_token),
    url: base === null ? null : `${base}/${encodeURIComponent(row.task_id)}/${row.webhook_token}`,
    hasSecret: row.webhook_secret !== null,
  };
}

// Routine settings that need no column of their own share this JSON column;
// older hosts ignore keys they do not know.
const ScheduledTaskRunPolicy = Schema.Struct({
  modelPinned: Schema.optional(Schema.Boolean),
  check: Schema.optional(Schema.NullOr(ScheduledTaskCheck)),
  brief: Schema.optional(Schema.NullOr(ScheduledTaskBrief)),
  ownThread: Schema.optional(Schema.Boolean),
  /**
   * A one-time task's arming, raised each time it is turned on or its time
   * changes, so each arming fires under its own key (see scheduledFireKey).
   */
  onceGeneration: Schema.optional(Schema.Int),
  /**
   * When the run of a one-shot the host turned off succeeded: a one-time
   * task, or a stopAfterPass watch. Turning it back on or saving it clears
   * this; see ScheduledTaskExpiry.
   */
  finishedAt: Schema.optional(Schema.String),
});
const decodeRunPolicy = Schema.decodeUnknownEffect(Schema.fromJsonString(ScheduledTaskRunPolicy));
const decodeRunPolicyJson = (json: string | null) =>
  json === null ? Effect.succeed({} as typeof ScheduledTaskRunPolicy.Type) : decodeRunPolicy(json);

/** The run policy column: null when the task sets none of it. */
export const encodeRunPolicyJson = (
  task: {
    readonly modelPinned?: boolean | undefined;
    readonly check?: ScheduledTaskCheck | null | undefined;
    readonly brief?: ScheduledTaskBrief | null | undefined;
    readonly ownThread?: boolean | undefined;
  },
  onceGeneration = 0,
): string | null =>
  task.modelPinned === undefined &&
  !task.check &&
  !task.brief &&
  !task.ownThread &&
  onceGeneration === 0
    ? null
    : JSON.stringify({
        ...(task.modelPinned === undefined ? {} : { modelPinned: task.modelPinned }),
        ...(task.check ? { check: task.check } : {}),
        ...(task.brief ? { brief: task.brief } : {}),
        ...(task.ownThread ? { ownThread: true } : {}),
        ...(onceGeneration === 0 ? {} : { onceGeneration }),
      });

/** A task's one-time arming (see ScheduledTaskRunPolicy); 0 when never re-armed. */
export const readOnceGeneration = Effect.fn("ScheduledTaskService.readOnceGeneration")(
  function* (task: { readonly id: string; readonly createdAt: string }) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly generation: number | null }>`
    SELECT json_extract(run_policy_json, '$.onceGeneration') AS generation
    FROM scheduled_tasks
    WHERE task_id = ${task.id} AND created_at = ${task.createdAt}
  `;
    const generation = rows[0]?.generation;
    return typeof generation === "number" && Number.isInteger(generation) && generation > 0
      ? generation
      : 0;
  },
);

export const decodeRow = (
  row: ScheduledTaskRow,
  origin: { readonly relayHookBaseUrl: string | null } | null = null,
) =>
  Effect.gen(function* () {
    const schedule = yield* decodeScheduleJson(row.schedule_json);
    const webhook = schedule.type === "webhook" ? webhookEndpoint(row, origin) : undefined;
    const workspaceStrategy = yield* decodeWorkspaceStrategyJson(row.workspace_strategy_json);
    const modelSelection = yield* decodeModelSelectionJson(row.model_selection_json);
    const policy = yield* decodeRunPolicyJson(row.run_policy_json ?? null);
    return yield* decodeTask({
      // The stored id decodes through the task schema so a corrupt value fails
      // as a typed parse error, not a `ScheduledTaskId.make` defect.
      id: row.task_id,
      title: row.title,
      prompt: row.prompt,
      enabled: row.enabled === 1,
      schedule,
      projectId: row.project_id,
      threadId: row.thread_id,
      workspaceStrategy,
      modelSelection,
      runtimeMode: row.runtime_mode,
      interactionMode: row.interaction_mode,
      createdBy: row.created_by,
      creationSource: row.creation_source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      lastRunStatus: row.last_run_status,
      lastRunError: row.last_run_error,
      runCount: row.run_count,
      ...(webhook === undefined ? {} : { webhook }),
      ...(policy.modelPinned === undefined ? {} : { modelPinned: policy.modelPinned }),
      ...(policy.check ? { check: policy.check } : {}),
      ...(policy.brief ? { brief: policy.brief } : {}),
      ...(policy.ownThread ? { ownThread: true } : {}),
    });
  }).pipe(
    Effect.mapError((cause) => {
      // The typed diagnostic can only carry an id that itself decodes; a
      // corrupt stored id is omitted rather than re-thrown as a defect.
      const taskId = decodeTaskId(row.task_id);
      return taskError("Could not decode schedule task row.", {
        ...(Option.isSome(taskId) ? { taskId: taskId.value } : {}),
        cause,
      });
    }),
  );

/**
 * Releases a row a restart left 'running'. The dispatch may already have gone
 * out, so the run counts and the task moves past it; a one-time task's due
 * slot backs off instead (nextRunAfterStuck).
 */
export const recoverInterruptedRow = Effect.fn("ScheduledTaskService.recoverInterruptedRow")(
  function* (row: ScheduledTaskRow, now: DateTime.DateTime, backoffMs: number) {
    const sql = yield* SqlClient.SqlClient;
    const decoded = yield* Effect.result(decodeRow(row));
    if (Result.isFailure(decoded))
      // The schedule cannot be decoded, so the next occurrence cannot be computed — still
      // release the row from 'running' (the lenient poller skips it, so it cannot re-fire).
      yield* Effect.logWarning("Recovering undecodable schedule task row without rescheduling", {
        taskId: row.task_id,
        cause: decoded.failure,
      });
    const next = Result.isSuccess(decoded)
      ? sql`, next_run_at = ${nextRunAfterStuck(decoded.success, now, backoffMs)}`
      : sql``;
    yield* sql`
      UPDATE scheduled_tasks
      SET last_run_status = 'failed',
          last_run_error = 'Run was interrupted by a server restart.',
          updated_at = ${iso(now)},
          run_count = run_count + 1${next}
      WHERE task_id IS ${row.task_id} AND last_run_status = 'running'
        AND last_run_at IS ${row.last_run_at} AND run_count = ${row.run_count}
    `;
  },
);

/** Select poll candidates before decoding their schedules or other JSON payloads. */
export const listDueTasks = Effect.fn("ScheduledTaskService.listDueTasks")(function* (
  now: DateTime.DateTime,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ScheduledTaskRow>`
    SELECT * FROM scheduled_tasks
    WHERE enabled = 1 AND next_run_at IS NOT NULL
      AND next_run_at <= ${iso(now)} AND last_run_status <> 'running'
    ORDER BY next_run_at ASC, task_id ASC
  `;
  const tasks: ScheduledTask[] = [];
  for (const row of rows) {
    const decoded = yield* Effect.result(decodeRow(row));
    if (Result.isSuccess(decoded)) {
      const task = decoded.success;
      // next_run_at is a freeform string at the schema level; a stored value
      // that cannot parse as a DateTime would defect the poll below, so the
      // row is skipped here like any other corrupt row.
      if (task.nextRunAt === null || Option.isSome(DateTime.make(task.nextRunAt))) {
        tasks.push(task);
      } else {
        yield* Effect.logWarning("Skipping schedule task row with invalid next_run_at", {
          taskId: row.task_id,
        });
      }
    } else {
      yield* Effect.logWarning("Skipping undecodable schedule task row", {
        taskId: row.task_id,
        cause: decoded.failure,
      });
    }
  }
  return tasks;
});

const ENDPOINT_KEY = /^[0-9a-f]{16}$/;

/**
 * The relay's hook URL prefix for this environment. The relay finds the
 * environment by its managed tunnel's key (the tunnel name's last segment),
 * so the URL never reveals the environment id.
 */
export function relayHookBaseUrl(input: {
  readonly relayUrl: string;
  readonly tunnelName: string | undefined;
}): string | null {
  const endpointKey = input.tunnelName?.split("-").at(-1);
  const relayUrl = input.relayUrl.replace(/\/+$/, "");
  if (relayUrl === "" || endpointKey === undefined || !ENDPOINT_KEY.test(endpointKey)) {
    return null;
  }
  return `${relayUrl}/v1/hooks/${endpointKey}`;
}
