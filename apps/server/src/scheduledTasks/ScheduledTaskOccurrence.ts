import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import {
  CONTEXT_COMPACT_MESSAGE_PREFIX,
  CONTEXT_RETRY_MESSAGE_PREFIX,
} from "../orchestration-v2/ContextOverflowRecoveryWorker.ts";
import {
  LIMIT_FALLBACK_MESSAGE_PREFIX,
  PROVIDER_FALLBACK_MESSAGE_PREFIX,
} from "../orchestration-v2/providerOpenFailure.ts";
import { PROVIDER_RETRY_MESSAGE_PREFIX } from "../orchestration-v2/unopenableFallback.ts";
import type { ScheduledTask, ScheduledTaskSchedule } from "@specweave-studio/contracts";
import { isSameSchedule } from "./Schedule.ts";
import { DEFER_DEFAULT_MS } from "./ScheduledTaskProviderRoute.ts";

/**
 * One scheduled occurrence, kept in `scheduled_task_run_receipts` under
 * `scheduled-occurrence:<fire key>` so the same occurrence keeps its fire key
 * (and so its command and message ids) across deferrals, and its run is
 * followed to its real outcome.
 *
 * - `deferred`: nothing could take it; the task's next_run_at is its retry.
 * - `dispatched`: posted to `threadId` as `messageId`; `runId` once seen. A
 *   run that failed stays here while the server may still continue it.
 * - `succeeded` / `failed`: the run's outcome. `lost`: no run ever appeared,
 *   or it never started.
 */
export const ScheduledOccurrence = Schema.Struct({
  kind: Schema.Literal("scheduled-occurrence"),
  state: Schema.Literals(["deferred", "dispatched", "succeeded", "failed", "lost"]),
  fireKey: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  messageId: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(Schema.String),
  /** When it was dispatched; a run that never appears is given up on after a while. */
  dispatchedAt: Schema.NullOr(Schema.String),
  /** The route's note, or once its run failed, the failure the task reports. */
  reason: Schema.NullOr(Schema.String),
  /** Posts of it that failed so far; a one-time task gives up after a few. */
  failedPosts: Schema.optionalKey(Schema.Number),
});
export type ScheduledOccurrence = typeof ScheduledOccurrence.Type;

const OccurrenceJson = Schema.fromJsonString(ScheduledOccurrence);
const decodeOccurrence = Schema.decodeUnknownOption(OccurrenceJson);
const encodeOccurrence = Schema.encodeSync(OccurrenceJson);

const RECEIPT_PREFIX = "scheduled-occurrence:";
/**
 * Every receipt key under the prefix sorts below this one (";" follows ":"),
 * so `command_id >= RECEIPT_PREFIX AND command_id < RECEIPT_PREFIX_END` reads
 * the occurrences off the primary key, where a LIKE would scan the table.
 */
const RECEIPT_PREFIX_END = "scheduled-occurrence;";
/** A dispatched occurrence whose run has not appeared after this long is given up on. */
const LOST_AFTER_MS = 60 * 60_000;
/** A run still waiting to start this long after dispatch (a held queue) is given up on. */
export const UNSTARTED_GIVE_UP_MS = 6 * 60 * 60_000;
/**
 * A failed run is left failed once this old: the server's own continuations
 * (provider retry, limit return) answer a failure only within a day.
 */
const CONTINUATION_WAIT_MS = 24 * 60 * 60_000;
/** Runs are followed this long after dispatch, then left as they are. */
const FOLLOW_FOR_MS = 48 * 60 * 60_000;
/** The occurrences one poll follows, newest first. */
const FOLLOW_BATCH = 50;
/** A one-time task whose post keeps failing turns off after this many tries. */
export const ONCE_POST_ATTEMPTS = 3;

/** The ids an occurrence dispatches with, the same on every fire of it. */
export function occurrenceIds(fireKey: string) {
  return {
    commandId: `scheduled-task:${fireKey}`,
    messageId: `scheduled-task-message:${fireKey}`,
  };
}

/**
 * The fire key of a scheduled occurrence due at `nextRunAt`. A one-time task
 * has one occurrence per arming, so it is keyed by its time and arming
 * (`generation`, raised when it is turned back on or its time changes)
 * instead: a fire that backs off or waits keeps its key, and a re-armed task
 * posts anew instead of replaying its last fire. The first arming of a time
 * still ahead keys as it always has.
 */
export function scheduledFireKey(
  task: {
    readonly id: string;
    readonly createdAt: string;
    readonly nextRunAt: string | null;
    readonly schedule: ScheduledTaskSchedule;
  },
  generation: number,
): string {
  if (task.schedule.type !== "once")
    return `${task.id}:${task.createdAt}:${task.nextRunAt}:scheduled`;
  const atMs = Date.parse(task.schedule.at);
  const at = Number.isFinite(atMs)
    ? DateTime.formatIso(DateTime.makeUnsafe(atMs))
    : task.schedule.at;
  const arming = generation > 0 ? `:g${generation}` : "";
  return `${task.id}:${task.createdAt}:${at}${arming}:scheduled`;
}

/** The arming a one-time fire key was made under (see scheduledFireKey). */
export function fireKeyGeneration(fireKey: string): number {
  const match = /:g(\d+):scheduled$/.exec(fireKey);
  return match === null ? 0 : Number(match[1]);
}

/**
 * The task's occurrence waiting to be fired again, if any. A one-time task's
 * waiting occurrence from an earlier arming is closed instead: the task was
 * turned back on or moved since, so that fire is not the one now due.
 */
export const pendingOccurrence = Effect.fn("ScheduledTaskService.pendingOccurrence")(function* (
  task: {
    readonly id: string;
    readonly projectId: string;
    readonly createdAt: string;
    readonly schedule: ScheduledTaskSchedule;
  },
  generation = 0,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly result_json: string | null; readonly started_at: string }>`
    SELECT result_json, started_at FROM scheduled_task_run_receipts
    WHERE task_id = ${task.id} AND task_created_at = ${task.createdAt}
      AND command_id >= ${RECEIPT_PREFIX} AND command_id < ${RECEIPT_PREFIX_END}
      AND json_extract(result_json, '$.state') = 'deferred'
    ORDER BY started_at DESC
    LIMIT 1
  `;
  const decoded = decodeOccurrence(rows[0]?.result_json ?? "");
  if (decoded._tag === "None") return null;
  const pending = decoded.value;
  if (task.schedule.type !== "once" || fireKeyGeneration(pending.fireKey) === generation)
    return pending;
  yield* saveOccurrence(
    task,
    { ...pending, state: "failed", reason: "Replaced: the task was armed again." },
    rows[0]!.started_at,
  );
  return null;
});

/**
 * What a fire leaves to come back to: an occurrence waiting to fire again
 * under the same key, one posted to `dispatchedTo` whose run is followed, or
 * nothing.
 */
export function firedOccurrence(input: {
  readonly fireKey: string;
  readonly waiting: boolean;
  readonly dispatchedTo: string | null;
  readonly messageId: string;
  readonly dispatchedAt: string;
  readonly reason: string | null;
  readonly failedPosts: number;
}): ScheduledOccurrence | null {
  const base = { kind: "scheduled-occurrence", fireKey: input.fireKey, runId: null } as const;
  if (input.waiting)
    return {
      ...base,
      state: "deferred",
      threadId: null,
      messageId: null,
      dispatchedAt: null,
      reason: input.reason,
      ...(input.failedPosts > 0 ? { failedPosts: input.failedPosts } : {}),
    };
  if (input.dispatchedTo === null) return null;
  return {
    ...base,
    state: "dispatched",
    threadId: input.dispatchedTo,
    messageId: input.messageId,
    dispatchedAt: input.dispatchedAt,
    reason: input.reason,
  };
}

/** Records an occurrence's state, creating its receipt on first use. */
export const saveOccurrence = Effect.fn("ScheduledTaskService.saveOccurrence")(function* (
  task: { readonly id: string; readonly projectId: string; readonly createdAt: string },
  occurrence: ScheduledOccurrence,
  at: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const json = encodeOccurrence(occurrence);
  yield* sql`
    INSERT INTO scheduled_task_run_receipts (command_id, project_id, task_id, task_created_at, started_at, result_json)
    VALUES (${`${RECEIPT_PREFIX}${occurrence.fireKey}`}, ${task.projectId}, ${task.id}, ${task.createdAt}, ${at}, ${json})
    ON CONFLICT(command_id) DO UPDATE SET result_json = excluded.result_json, started_at = excluded.started_at
    WHERE scheduled_task_run_receipts.task_id = excluded.task_id
      AND scheduled_task_run_receipts.task_created_at = excluded.task_created_at
  `;
});

interface FollowedRun {
  readonly run_id: string;
  readonly ordinal: number;
  readonly status: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly user_message_id: string | null;
}

const TERMINAL_FAILED = new Set(["failed", "interrupted", "cancelled", "rolled_back"]);

/**
 * Server continuations that carry on a stopped run's work, each naming the
 * run it continues last: `<prefix><thread>:[...:]<run>`.
 */
const CONTINUATION_PREFIXES = [
  LIMIT_FALLBACK_MESSAGE_PREFIX,
  PROVIDER_FALLBACK_MESSAGE_PREFIX,
  PROVIDER_RETRY_MESSAGE_PREFIX,
  "limit-return:",
  CONTEXT_RETRY_MESSAGE_PREFIX,
] as const;
/** Usage-limit recovery names the stopped run inside: `limit-resume:<thread>:<run>:<reset>:<request>`. */
const LIMIT_RESUME_PREFIX = "limit-resume:";

const isFallbackMove = (threadId: string, messageId: string) =>
  [LIMIT_FALLBACK_MESSAGE_PREFIX, PROVIDER_FALLBACK_MESSAGE_PREFIX].some((prefix) =>
    messageId.startsWith(`${prefix}${threadId}:`),
  );

/**
 * Whether `messageId` is a server continuation of `runId` on `threadId`.
 * `/compact` before a context retry is one too, as a step on the way, not
 * the work itself.
 */
function continuationOf(threadId: string, messageId: string, runId: string) {
  if (messageId.startsWith(`${LIMIT_RESUME_PREFIX}${threadId}:${runId}:`)) return "work";
  if (!messageId.endsWith(`:${runId}`)) return null;
  if (messageId.startsWith(`${CONTEXT_COMPACT_MESSAGE_PREFIX}${threadId}:`)) return "step";
  return CONTINUATION_PREFIXES.some((prefix) => messageId.startsWith(`${prefix}${threadId}:`))
    ? "work"
    : null;
}

/**
 * What a followed occurrence's run came to. A run the limit or provider
 * fallback, the provider retry, the way back, limit recovery or context
 * recovery continued is followed through the continuation, since that is
 * where the scheduled work went on.
 */
export type FollowOutcome =
  | {
      readonly type: "pending";
      readonly runId: string | null;
      readonly started: boolean;
      /** The scheduled run or a continuation of its work has started. */
      readonly workStarted: boolean;
    }
  | { readonly type: "lost" }
  | { readonly type: "succeeded"; readonly runId: string }
  | {
      readonly type: "failed";
      readonly runId: string;
      readonly message: string;
      readonly workStarted: boolean;
      /**
       * Nothing will continue it any more: the thread ran something else
       * since, or the failure is too old for a continuation.
       */
      readonly settled: boolean;
    };

export const followOccurrence = Effect.fn("ScheduledTaskService.followOccurrence")(function* (
  occurrence: ScheduledOccurrence,
  nowMs: number,
) {
  const sql = yield* SqlClient.SqlClient;
  if (occurrence.threadId === null || occurrence.messageId === null)
    return { type: "lost" } as FollowOutcome;
  const threadId = occurrence.threadId;
  const columns = sql`run.run_id, run.ordinal, run.status, run.completed_at,
    json_extract(run.payload_json, '$.startedAt') AS started_at,
    COALESCE(
      json_extract(run.payload_json, '$.startMessageId'),
      json_extract(run.payload_json, '$.userMessageId')
    ) AS user_message_id`;
  const [first] = yield* sql<FollowedRun>`
    SELECT ${columns} FROM orchestration_v2_projection_runs run
    WHERE run.thread_id = ${threadId}
      AND ${occurrence.messageId} IN (
        json_extract(run.payload_json, '$.userMessageId'),
        json_extract(run.payload_json, '$.startMessageId')
      )
    LIMIT 1
  `;
  if (first === undefined) {
    const dispatchedMs = Date.parse(occurrence.dispatchedAt ?? "");
    return (
      Number.isFinite(dispatchedMs) && nowMs - dispatchedMs > LOST_AFTER_MS
        ? { type: "lost" }
        : { type: "pending", runId: null, started: false, workStarted: false }
    ) as FollowOutcome;
  }
  // Only a run that ended badly is followed into what came after it.
  let run: FollowedRun = first;
  let movedOn = false;
  let workStarted = first.started_at !== null;
  if (TERMINAL_FAILED.has(first.status)) {
    const later = yield* sql<FollowedRun>`
      SELECT ${columns} FROM orchestration_v2_projection_runs run
      WHERE run.thread_id = ${threadId} AND run.ordinal > ${first.ordinal}
      ORDER BY run.ordinal ASC
      LIMIT 100
    `;
    const chain = new Set([first.run_id]);
    const others: Array<FollowedRun> = [];
    let latest = first;
    for (const next of later) {
      const messageId = next.user_message_id ?? "";
      const kind =
        [...chain].reduce<"work" | "step" | null>(
          (found, runId) => found ?? continuationOf(threadId, messageId, runId),
          null,
        ) ??
        // A fallback move is sent only for the thread's latest run, but may
        // name an older stop it answers (a limit stop that put the thread
        // where the chain failed): with nothing else run or failed since the
        // chain, it carries the chain on.
        (isFallbackMove(threadId, messageId) &&
        !others.some(
          (other) =>
            other.ordinal > latest.ordinal &&
            (other.started_at !== null || other.status === "failed"),
        )
          ? "work"
          : null);
      if (kind === null) {
        others.push(next);
        continue;
      }
      chain.add(next.run_id);
      latest = next;
      if (kind === "work") {
        run = next;
        workStarted ||= next.started_at !== null;
      }
    }
    // A run of anything else that started after the last of the work means
    // the thread went on without it: no continuation will come.
    movedOn = others.some((other) => other.ordinal > run.ordinal && other.started_at !== null);
  }
  if (!TERMINAL_FAILED.has(run.status))
    return (
      run.status === "completed"
        ? { type: "succeeded", runId: run.run_id }
        : { type: "pending", runId: run.run_id, started: run.started_at !== null, workStarted }
    ) as FollowOutcome;
  const [failure] = yield* sql<{ readonly message: string | null }>`
    SELECT json_extract(item.payload_json, '$.failure.message') AS message
    FROM orchestration_v2_projection_turn_items item
    WHERE item.run_id = ${run.run_id} AND item.type = 'error'
    ORDER BY item.ordinal DESC LIMIT 1
  `;
  const message =
    run.status === "failed"
      ? (failure?.message ?? "The run failed.")
      : `The run ended ${run.status === "rolled_back" ? "rolled back" : run.status}.`;
  const failedMs = Date.parse(run.completed_at ?? "");
  return {
    type: "failed",
    runId: run.run_id,
    message,
    workStarted,
    settled: movedOn || (Number.isFinite(failedMs) && nowMs - failedMs > CONTINUATION_WAIT_MS),
  } as FollowOutcome;
});

/**
 * Occurrences whose run is still being followed, newest first, so one that
 * never settles (a run held in its queue) cannot keep newer ones from being
 * followed.
 */
export const dispatchedOccurrences = Effect.fn("ScheduledTaskService.dispatchedOccurrences")(
  function* (nowMs: number) {
    const sql = yield* SqlClient.SqlClient;
    const since = DateTime.formatIso(DateTime.makeUnsafe(nowMs - FOLLOW_FOR_MS));
    const rows = yield* sql<{
      readonly task_id: string;
      readonly project_id: string;
      readonly task_created_at: string;
      readonly started_at: string;
      readonly result_json: string | null;
    }>`
      SELECT receipt.task_id, receipt.project_id, receipt.task_created_at, receipt.started_at,
             receipt.result_json
      FROM scheduled_task_run_receipts receipt
      JOIN scheduled_tasks task
        ON task.task_id = receipt.task_id AND task.created_at = receipt.task_created_at
      WHERE receipt.command_id >= ${RECEIPT_PREFIX} AND receipt.command_id < ${RECEIPT_PREFIX_END}
        AND json_extract(receipt.result_json, '$.state') = 'dispatched'
        AND receipt.started_at >= ${since}
      ORDER BY receipt.started_at DESC
      LIMIT ${FOLLOW_BATCH}
    `;
    return rows.flatMap((row) => {
      const decoded = decodeOccurrence(row.result_json ?? "");
      return decoded._tag === "Some"
        ? [
            {
              task: { id: row.task_id, projectId: row.project_id, createdAt: row.task_created_at },
              startedAt: row.started_at,
              occurrence: decoded.value,
            },
          ]
        : [];
    });
  },
);

/**
 * Deletes occurrences that settled (succeeded, failed, lost) and are out of
 * the follow window: every fire writes one, so they would otherwise grow
 * without end. A one-time task's last reported run is kept, since
 * retireUnfollowedOnce reads whether it succeeded. Waiting and dispatched
 * occurrences stay.
 */
export const pruneOccurrences = Effect.fn("ScheduledTaskService.pruneOccurrences")(function* (
  nowMs: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const since = DateTime.formatIso(DateTime.makeUnsafe(nowMs - FOLLOW_FOR_MS));
  yield* sql`
    DELETE FROM scheduled_task_run_receipts
    WHERE command_id >= ${RECEIPT_PREFIX} AND command_id < ${RECEIPT_PREFIX_END}
      AND started_at < ${since}
      AND json_extract(result_json, '$.state') IN ('succeeded', 'failed', 'lost')
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_tasks task
        WHERE task.task_id = scheduled_task_run_receipts.task_id
          AND task.created_at = scheduled_task_run_receipts.task_created_at
          AND task.last_run_at IS scheduled_task_run_receipts.started_at
          AND json_extract(task.schedule_json, '$.type') = 'once')
  `;
});

/** How often settled occurrences are pruned (see pruneOccurrences). */
export const OCCURRENCE_PRUNE_EVERY_MS = 60 * 60_000;

/**
 * What a fire means for a one-time task (`current`, read after the fire).
 * The fire of its own slot takes the slot (`fired`), unless it waited for
 * its provider or failed to post: a failed one tries again later under the
 * same fire key, since there is no later occurrence to wait for, up to
 * ONCE_POST_ATTEMPTS posts or until a failure no retry can change (`final`).
 * A task posted somewhere turns off once its run starts (retireFiredOnce);
 * one whose quiet check ended the run, or that gave up, turns off now.
 */
export function onceFireOutcome(input: {
  readonly trigger: "scheduled" | "manual" | "webhook";
  readonly fired: ScheduledTaskSchedule;
  readonly current: Pick<ScheduledTask, "schedule">;
  readonly deferred: boolean;
  readonly dispatched: boolean;
  readonly failed: boolean;
  /** No retry under the same fire key can succeed. */
  readonly final: boolean;
  /** Failed posts of this occurrence, this one included. */
  readonly failedPosts: number;
  readonly completedAtMs: number;
}): {
  readonly fired: boolean;
  readonly retryAtMs: number | null;
  readonly disable: boolean;
  readonly gaveUp: boolean;
} {
  const ownSlot =
    input.current.schedule.type === "once" &&
    input.trigger === "scheduled" &&
    !input.deferred &&
    isSameSchedule(input.fired, input.current.schedule);
  const gaveUp =
    ownSlot && input.failed && (input.final || input.failedPosts >= ONCE_POST_ATTEMPTS);
  const retry = ownSlot && input.failed && !gaveUp;
  return {
    fired: ownSlot && !retry,
    retryAtMs: retry ? input.completedAtMs + DEFER_DEFAULT_MS : null,
    disable: ownSlot && !retry && (!input.dispatched || gaveUp),
    gaveUp,
  };
}

/**
 * Turns off a one-time task whose fired occurrence is over: its run started,
 * or it never will. Only while it still waits on that fire (no next run): one
 * edited to a new time, or turned back on, stays on. `failure` reports why on
 * the task, while the run dispatched at `lastRunAt` is still its latest.
 */
export const retireFiredOnce = Effect.fn("ScheduledTaskService.retireFiredOnce")(function* (
  task: { readonly id: string; readonly createdAt: string },
  nowIso: string,
  failure: { readonly lastRunAt: string | null; readonly reason: string } | null = null,
) {
  const sql = yield* SqlClient.SqlClient;
  const report =
    failure === null
      ? sql``
      : sql`, last_run_status = CASE WHEN last_run_at IS ${failure.lastRunAt}
            THEN 'failed' ELSE last_run_status END,
          last_run_error = CASE WHEN last_run_at IS ${failure.lastRunAt}
            THEN ${failure.reason} ELSE last_run_error END`;
  const rows = yield* sql<{ readonly task_id: string }>`
    UPDATE scheduled_tasks
    SET enabled = 0, updated_at = ${nowIso}${report}
    WHERE task_id = ${task.id} AND created_at = ${task.createdAt}
      AND enabled = 1 AND next_run_at IS NULL
      AND json_extract(schedule_json, '$.type') = 'once'
    RETURNING task_id
  `;
  return rows.length > 0;
});

/** How far a fire got before it failed outside its own handling (see stuckOnceFire). */
export interface StuckFire {
  readonly key: string | null;
  readonly startedAtIso: string | null;
  /** Earlier failed or stuck posts of the occurrence. */
  readonly failedPosts: number;
  readonly posted: boolean;
}
export const NO_STUCK_FIRE: StuckFire = {
  key: null,
  startedAtIso: null,
  failedPosts: 0,
  posted: false,
};

/**
 * Whether a one-time task's own fire that failed outside its own handling (a
 * restart, an interruption, a database error) ends its slot: once its post
 * went out, or after ONCE_POST_ATTEMPTS such tries. Otherwise the try is
 * counted on the occurrence the next fire picks up under the same fire key
 * (pendingOccurrence), so that fire posts the same message, once.
 */
export const stuckOnceFire = Effect.fn("ScheduledTaskService.stuckOnceFire")(function* (
  task: { readonly id: string; readonly projectId: string; readonly createdAt: string },
  fire: StuckFire,
  reason: string,
) {
  const failedPosts = fire.failedPosts + 1;
  if (fire.posted || failedPosts >= ONCE_POST_ATTEMPTS) return true;
  if (fire.key !== null && fire.startedAtIso !== null)
    yield* saveOccurrence(
      task,
      {
        kind: "scheduled-occurrence",
        state: "deferred",
        fireKey: fire.key,
        threadId: null,
        messageId: null,
        runId: null,
        dispatchedAt: null,
        reason,
        failedPosts,
      },
      fire.startedAtIso,
    ).pipe(Effect.ignore);
  return false;
});

/** Appended to the error of a one-time task turned off without a run to show for it. */
export const ONCE_TURNED_OFF = "Turned off; turn it on to try again.";

/**
 * Turns off one-time tasks that are still on with nothing left to run (no
 * next run) and no run being followed: their occurrence was lost, never
 * recorded, or dropped out of the follow window, so nothing else would end
 * them. Unless the last run was seen to succeed, the task reports that it did
 * not run, so a one-time task never sits on, silent, with nothing to come.
 */
export const retireUnfollowedOnce = Effect.fn("ScheduledTaskService.retireUnfollowedOnce")(
  function* (nowMs: number) {
    const sql = yield* SqlClient.SqlClient;
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const since = DateTime.formatIso(DateTime.makeUnsafe(nowMs - FOLLOW_FOR_MS));
    const occurrence = (state: string, also: Statement.Fragment) => sql`EXISTS (
      SELECT 1 FROM scheduled_task_run_receipts receipt
      WHERE receipt.task_id = scheduled_tasks.task_id
        AND receipt.task_created_at = scheduled_tasks.created_at
        AND receipt.command_id >= ${RECEIPT_PREFIX} AND receipt.command_id < ${RECEIPT_PREFIX_END}
        AND json_extract(receipt.result_json, '$.state') = ${state} AND ${also})`;
    // The last run's own occurrence came to a run that succeeded.
    const ran = sql`(last_run_status = 'succeeded' AND ${occurrence(
      "succeeded",
      sql`receipt.started_at IS scheduled_tasks.last_run_at`,
    )})`;
    const rows = yield* sql<{ readonly task_id: string }>`
      UPDATE scheduled_tasks
      SET enabled = 0, updated_at = ${nowIso},
          last_run_error = CASE
            WHEN ${ran} THEN last_run_error
            WHEN last_run_status = 'failed' AND last_run_error IS NOT NULL
              THEN last_run_error || ' ' || ${ONCE_TURNED_OFF}
            ELSE ${`It did not run: no run of it was seen to start. ${ONCE_TURNED_OFF}`}
          END,
          last_run_status = CASE WHEN ${ran} THEN last_run_status ELSE 'failed' END
      WHERE enabled = 1 AND next_run_at IS NULL AND last_run_status <> 'running'
        AND json_extract(schedule_json, '$.type') = 'once'
        AND NOT ${occurrence("dispatched", sql`receipt.started_at >= ${since}`)}
      RETURNING task_id
    `;
    return rows.length > 0;
  },
);

/** Command errors a post under the same command id can only get again. */
const FINAL_POST_ERRORS = new Set([
  "OrchestratorCommandPreviouslyRejectedError",
  "OrchestratorCommandRejectedError",
  "OrchestratorCommandIdConflictError",
]);

/** Whether a failed post can only fail the same way when tried again under its fire key. */
export function isFinalPostFailure(cause: Cause.Cause<unknown>): boolean {
  const error = Cause.squash(cause);
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    FINAL_POST_ERRORS.has(String(error._tag))
  );
}
