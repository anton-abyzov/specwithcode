import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { markFinishedOneShot } from "./ScheduledTaskExpiry.ts";
import {
  dispatchedOccurrences,
  followOccurrence,
  pruneOccurrences,
  retireFiredOnce,
  retireUnfollowedOnce,
  saveOccurrence,
  type ScheduledOccurrence,
  UNSTARTED_GIVE_UP_MS,
} from "./ScheduledTaskOccurrence.ts";

/**
 * A fire reports what its run came to, not that it was posted: each poll
 * follows the dispatched occurrences' runs. A run that failed is followed
 * into the server's continuation of it (provider fallback or retry, limit
 * recovery or way back, context recovery), so a continuation that
 * finishes the work turns the task back to succeeded. The scheduler
 * sends nothing again itself: those continuations already answer a run
 * that failed, each once. One-time tasks turn off here once their run has
 * started or never will. With `prune`, settled occurrences out of the
 * follow window are deleted first. Returns whether any task changed.
 */
export const followDispatchedOccurrences = Effect.fn(
  "ScheduledTaskService.followDispatchedOccurrences",
)(function* (nowMs: number, prune = false) {
  const sql = yield* SqlClient.SqlClient;
  const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
  if (prune) yield* pruneOccurrences(nowMs);
  const followed = yield* dispatchedOccurrences(nowMs);
  let changed = yield* retireUnfollowedOnce(nowMs);
  for (const { task, occurrence } of followed) {
    const outcome = yield* followOccurrence(occurrence, nowMs);
    // A one-time task turns off once its run has started, not when it is
    // posted, or once it is clear its run never will.
    if (
      outcome.type === "succeeded" ||
      (outcome.type !== "lost" && outcome.workStarted) ||
      (outcome.type === "failed" && outcome.settled)
    )
      if (yield* retireFiredOnce(task, nowIso)) changed = true;
    const save = (next: ScheduledOccurrence) =>
      saveOccurrence(task, next, occurrence.dispatchedAt ?? nowIso);
    const lost = (reason: string, runId = occurrence.runId) =>
      save({ ...occurrence, state: "lost", runId, reason }).pipe(
        Effect.andThen(
          retireFiredOnce(task, nowIso, { lastRunAt: occurrence.dispatchedAt, reason }),
        ),
        Effect.map((retired) => {
          changed ||= retired;
        }),
      );
    // Only while this occurrence is still the task's latest run.
    const latest = sql`task_id = ${task.id} AND created_at = ${task.createdAt}
      AND last_run_at IS ${occurrence.dispatchedAt}`;
    if (outcome.type === "pending") {
      const dispatchedMs = Date.parse(occurrence.dispatchedAt ?? "");
      if (
        !outcome.started &&
        outcome.runId !== null &&
        Number.isFinite(dispatchedMs) &&
        nowMs - dispatchedMs > UNSTARTED_GIVE_UP_MS
      ) {
        yield* lost("Its run had not started 6 hours after it was sent.", outcome.runId);
        continue;
      }
      if (outcome.runId !== null && outcome.runId !== occurrence.runId)
        yield* save({ ...occurrence, runId: outcome.runId });
      continue;
    }
    if (outcome.type === "lost") {
      yield* lost("No run was started.");
      continue;
    }
    if (outcome.type === "succeeded") {
      // Undo only the failure this occurrence reported itself.
      if (occurrence.reason !== null) {
        const restored = yield* sql<{ task_id: string }>`
          UPDATE scheduled_tasks
          SET last_run_status = 'succeeded', last_run_error = NULL, updated_at = ${nowIso}
          WHERE ${latest} AND last_run_status = 'failed' AND last_run_error = ${occurrence.reason}
          RETURNING task_id
        `;
        changed ||= restored.length > 0;
      }
      yield* save({ ...occurrence, state: "succeeded", runId: outcome.runId });
      if (yield* markFinishedOneShot(latest, nowIso)) changed = true;
      continue;
    }
    const reported = occurrence.runId === outcome.runId && occurrence.reason === outcome.message;
    if (!reported) {
      const updated = yield* sql<{ task_id: string }>`
        UPDATE scheduled_tasks
        SET last_run_status = 'failed', last_run_error = ${outcome.message},
            updated_at = ${nowIso}
        WHERE ${latest}
          AND (last_run_status = 'succeeded'
            OR (last_run_status = 'failed' AND last_run_error IS ${occurrence.reason}))
        RETURNING task_id
      `;
      changed ||= updated.length > 0;
    }
    if (!reported || outcome.settled)
      yield* save({
        ...occurrence,
        state: outcome.settled ? "failed" : "dispatched",
        runId: outcome.runId,
        reason: outcome.message,
      });
  }
  return changed;
});
