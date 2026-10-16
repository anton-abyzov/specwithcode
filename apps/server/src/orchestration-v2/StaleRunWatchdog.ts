import {
  CommandId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@specweave-studio/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * How long a turn may stay "running" after its final answer with no provider
 * activity. Long enough for a quiet background build to report, short enough
 * that a provider which never ended its turn does not show Working for hours.
 */
export const STALE_FINISHED_RUN_IDLE = Duration.minutes(30);

const NONTERMINAL = new Set(["pending", "running", "waiting"]);

export const STALE_FINISHED_RUN_REASON =
  "Closed automatically: the turn had posted its final answer and its provider sent nothing for 30 minutes.";

/**
 * The running run a provider finished but never ended: its latest item is a
 * completed assistant message, nothing has changed since for `idle`, and it
 * waits on no one (no pending request, no running subagent). Background tool
 * items still shown running do not count: they are what a provider that lost
 * a task's end leaves behind. Null when the thread has no such run.
 */
export function staleFinishedRun(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "runtimeRequests" | "turnItems" | "subagents"
  >,
  now: DateTime.Utc,
  idle: Duration.Duration = STALE_FINISHED_RUN_IDLE,
): OrchestrationV2Run | null {
  const cutoff = DateTime.toEpochMillis(now) - Duration.toMillis(idle);
  if (DateTime.toEpochMillis(projection.thread.updatedAt) > cutoff) return null;
  const run = projection.runs.findLast((candidate) => candidate.status === "running");
  if (run === undefined) return null;
  if (projection.runtimeRequests.some((request) => request.status === "pending")) return null;
  if (
    projection.subagents.some(
      (subagent) => subagent.runId === run.id && NONTERMINAL.has(subagent.status),
    )
  ) {
    return null;
  }
  let latest: OrchestrationV2TurnItem | undefined;
  for (const item of projection.turnItems) {
    if (item.runId !== run.id) continue;
    if (item.type === "subagent" && NONTERMINAL.has(item.status)) return null;
    if (
      latest === undefined ||
      DateTime.toEpochMillis(item.updatedAt) >= DateTime.toEpochMillis(latest.updatedAt)
    ) {
      latest = item;
    }
  }
  if (
    latest === undefined ||
    latest.type !== "assistant_message" ||
    latest.status !== "completed" ||
    latest.streaming ||
    DateTime.toEpochMillis(latest.updatedAt) > cutoff
  ) {
    return null;
  }
  return run;
}

/**
 * Ends runs whose provider finished the turn but never reported it, across
 * every provider. It interrupts them the way Stop does, so the provider drops
 * the turn too and the next message starts cleanly.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const crypto = yield* Crypto.Crypto;

  const closeIfStale = Effect.fn("StaleRunWatchdog.closeIfStale")(function* (
    threadId: OrchestrationV2Run["threadId"],
  ) {
    const now = yield* DateTime.now;
    const shell = yield* projections.getThreadRecords(threadId, ["runs"]);
    if (shell.thread.deletedAt !== null) return false;
    const cutoff = DateTime.toEpochMillis(now) - Duration.toMillis(STALE_FINISHED_RUN_IDLE);
    if (DateTime.toEpochMillis(shell.thread.updatedAt) > cutoff) return false;
    const running = shell.runs.findLast((run) => run.status === "running");
    if (running === undefined) return false;
    const projection = yield* projections.getThreadRecords(
      threadId,
      ["runs", "runtimeRequests", "turnItems", "subagents"],
      { turnItemRunIds: [running.id] },
    );
    const run = staleFinishedRun(projection, now);
    if (run === null) return false;
    const uuid = yield* crypto.randomUUIDv4;
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make(`server:stale-run-watchdog:${run.id}:${uuid}`),
      threadId,
      runId: run.id,
      reason: STALE_FINISHED_RUN_REASON,
    });
    yield* Effect.logInfo("Closed a finished run its provider never ended", {
      threadId,
      runId: run.id,
    });
    return true;
  });

  const sweep = Effect.fn("StaleRunWatchdog.sweep")(function* () {
    const threadIds = yield* projections.getRecoveryThreadIds("runtime");
    let closed = 0;
    for (const threadId of threadIds) {
      const result = yield* closeIfStale(threadId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Stale run watchdog skipped a thread", { threadId, cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
      if (result) closed += 1;
    }
    return closed;
  });

  const start = (): Effect.Effect<void, never, Scope.Scope> =>
    forkParked(
      sweep().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Stale run watchdog sweep failed", { cause }),
        ),
        Effect.repeat(Schedule.spaced("1 minute")),
        Effect.asVoid,
      ),
    );

  return { start, sweep };
});
