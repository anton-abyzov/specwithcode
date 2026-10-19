import {
  CommandId,
  type RunId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@specweave-studio/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as OrphanedRuns from "./OrphanedRuns.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RunLiveness from "./RunLiveness.ts";

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
 * the turn too and the next message starts cleanly. It also settles orphaned
 * runs: running, but with nothing in this process driving them any more (the
 * provider session ended, or nobody reads the provider's events).
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const liveness = yield* RunLiveness.RunLiveness;
  const settler = yield* OrphanedRuns.makeSettler;
  const crypto = yield* Crypto.Crypto;
  // Runs found orphaned by the previous sweep. A run is settled only when two
  // sweeps in a row find it orphaned, so one slow moment never ends a turn.
  const suspects = yield* Ref.make<ReadonlyMap<RunId, OrphanedRuns.OrphanedRunKind>>(new Map());

  const closeIfStale = Effect.fn("StaleRunWatchdog.closeIfStale")(function* (
    threadId: OrchestrationV2Run["threadId"],
    running: OrchestrationV2Run,
    now: DateTime.Utc,
  ) {
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

  /** Why the thread's running run is orphaned now, or null. */
  const orphanVerdict = Effect.fn("StaleRunWatchdog.orphanVerdict")(function* (
    threadId: OrchestrationV2Run["threadId"],
    running: OrchestrationV2Run,
    now: DateTime.Utc,
  ) {
    const projection = yield* projections.getThreadRecords(
      threadId,
      ["runs", "runtimeRequests", "turnItems", "subagents", "providerThreads"],
      { turnItemRunIds: [running.id] },
    );
    const run = OrphanedRuns.latestRunningRun(projection.runs);
    if (run === undefined || run.id !== running.id) return null;
    const providerSessionId = projection.providerThreads.find(
      (providerThread) => providerThread.id === run.providerThreadId,
    )?.providerSessionId;
    // A run with no recorded session cannot be shown to have lost it, so it
    // only counts as orphaned once nothing reads its events.
    const sessionLive =
      providerSessionId == null ||
      Option.isSome(
        yield* sessions.get(providerSessionId).pipe(Effect.orElseSucceed(() => Option.some(null))),
      );
    const ingesting = yield* liveness.isLive(run.id);
    const kind = OrphanedRuns.orphanedRunKind(projection, run, { ingesting, sessionLive }, now);
    return kind === null ? null : { run, kind, providerSessionId };
  });

  const sweepThread = Effect.fn("StaleRunWatchdog.sweepThread")(function* (
    threadId: OrchestrationV2Run["threadId"],
    previous: ReadonlyMap<RunId, OrphanedRuns.OrphanedRunKind>,
    suspected: Map<RunId, OrphanedRuns.OrphanedRunKind>,
  ) {
    const now = yield* DateTime.now;
    const shell = yield* projections.getThreadRecords(threadId, ["runs"]);
    if (shell.thread.deletedAt !== null) return false;
    const running = OrphanedRuns.latestRunningRun(shell.runs);
    if (running === undefined) return false;
    const quietMs =
      DateTime.toEpochMillis(now) -
      Math.max(
        DateTime.toEpochMillis(shell.thread.updatedAt),
        DateTime.toEpochMillis(running.startedAt ?? running.requestedAt),
      );
    if (quietMs >= Duration.toMillis(STALE_FINISHED_RUN_IDLE)) {
      if (yield* closeIfStale(threadId, running, now)) return true;
    }
    // Nothing can be orphaned before the shortest quiet period has passed.
    if (quietMs < Duration.toMillis(OrphanedRuns.ORPHANED_RUN_SESSION_ENDED_QUIET)) return false;
    const verdict = yield* orphanVerdict(threadId, running, now);
    if (verdict === null) return false;
    if (previous.get(verdict.run.id) !== verdict.kind) {
      suspected.set(verdict.run.id, verdict.kind);
      return false;
    }
    return yield* settler.settle({ threadId, runId: verdict.run.id, kind: verdict.kind });
  });

  const sweep = Effect.fn("StaleRunWatchdog.sweep")(function* () {
    const threadIds = yield* projections.getRecoveryThreadIds("runtime");
    const previous = yield* Ref.get(suspects);
    const suspected = new Map<RunId, OrphanedRuns.OrphanedRunKind>();
    let closed = 0;
    for (const threadId of threadIds) {
      const result = yield* sweepThread(threadId, previous, suspected).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Stale run watchdog skipped a thread", { threadId, cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
      if (result) closed += 1;
    }
    yield* Ref.set(suspects, suspected);
    return closed;
  });

  /**
   * A released session ends every turn it was running. A run left on it that
   * nothing in this process drives is settled at once instead of on a sweep.
   */
  const settleAfterRelease = Effect.fn("StaleRunWatchdog.settleAfterRelease")(function* (
    released: RunLiveness.ReleasedProviderSession,
  ) {
    let settled = 0;
    for (const threadId of released.threadIds) {
      const shell = yield* projections.getThreadRecords(threadId, ["runs"]);
      const running = OrphanedRuns.latestRunningRun(shell.runs);
      if (shell.thread.deletedAt !== null || running === undefined) continue;
      const projection = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === running.providerThreadId,
      );
      if (providerThread?.providerSessionId !== released.providerSessionId) continue;
      // A replacement session under the same id, or a fiber still settling
      // the run, owns it now.
      const reopened = yield* sessions
        .get(released.providerSessionId)
        .pipe(Effect.orElseSucceed(() => Option.some(null)));
      if (Option.isSome(reopened) || (yield* liveness.isLive(running.id))) continue;
      if (yield* settler.settle({ threadId, runId: running.id, kind: "session_ended" })) {
        settled += 1;
      }
    }
    return settled;
  });

  const start = (): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      yield* forkParked(
        sweep().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Stale run watchdog sweep failed", { cause }),
          ),
          Effect.repeat(Schedule.spaced("1 minute")),
          Effect.asVoid,
        ),
      );
      yield* forkParked(
        liveness.takeReleasedSession.pipe(
          Effect.flatMap(settleAfterRelease),
          Effect.catchCause((cause) =>
            Effect.logWarning("Stale run watchdog could not settle a released session's runs", {
              cause,
            }),
          ),
          Effect.forever,
        ),
      );
    });

  return { start, sweep, settleAfterRelease };
});
