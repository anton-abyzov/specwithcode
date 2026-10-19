import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import {
  CommandId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type RunId,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import type * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { makeProviderFailure, makeProviderFailureTurnItem } from "./ProviderFailure.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

/**
 * A running run whose provider session is gone and that nothing in this
 * process drives any more: settled once it has been still this long.
 */
export const ORPHANED_RUN_SESSION_ENDED_QUIET = Duration.minutes(2);

/**
 * A running run nothing reads provider events for while its session is still
 * open: the provider may be working unobserved, so it gets longer.
 */
export const ORPHANED_RUN_UNOBSERVED_QUIET = Duration.minutes(10);

/**
 * A running run on a closed session that waits on nothing (no open item,
 * request or subagent) is settled after this even when something still holds
 * it, since no event can arrive for it any more.
 */
export const ORPHANED_RUN_ENDED_SESSION_IDLE = Duration.minutes(5);

export type OrphanedRunKind = "session_ended" | "unobserved";

export const ORPHANED_RUN_MESSAGES: Record<OrphanedRunKind, string> = {
  session_ended:
    "The provider session ended before this turn finished, so it was closed. Send a message to continue.",
  unobserved:
    "Studio stopped receiving updates from the provider for this turn, so it was closed. Send a message to continue.",
};

export interface OrphanedRunLiveState {
  /** This process is still starting the run or reading its provider events. */
  readonly ingesting: boolean;
  /** The run's provider session is still open in this process. */
  readonly sessionLive: boolean;
}

export type OrphanedRunProjection = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "runtimeRequests" | "turnItems" | "subagents"
>;

const isOpen = (status: string) =>
  status === "pending" || status === "running" || status === "waiting";

/** The thread's running run, if any. */
export function latestRunningRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | undefined {
  return runs.findLast((run) => run.status === "running");
}

/**
 * Why `run` is orphaned, or null when it may still finish on its own. A run
 * this process still drives is left alone while its session is open, and a
 * run with recent activity (a streaming answer, a new item) is never settled.
 */
export function orphanedRunKind(
  projection: OrphanedRunProjection,
  run: OrchestrationV2Run,
  live: OrphanedRunLiveState,
  now: DateTime.Utc,
): OrphanedRunKind | null {
  if (run.status !== "running") return null;
  let lastActivityMs = Math.max(
    DateTime.toEpochMillis(projection.thread.updatedAt),
    DateTime.toEpochMillis(run.startedAt ?? run.requestedAt),
  );
  let openItem = false;
  for (const item of projection.turnItems) {
    if (item.runId !== run.id) continue;
    lastActivityMs = Math.max(lastActivityMs, DateTime.toEpochMillis(item.updatedAt));
    if (isOpen(item.status)) openItem = true;
  }
  const quietMs = DateTime.toEpochMillis(now) - lastActivityMs;
  if (!live.sessionLive) {
    if (!live.ingesting && quietMs >= Duration.toMillis(ORPHANED_RUN_SESSION_ENDED_QUIET)) {
      return "session_ended";
    }
    const waitsOnSomething =
      openItem ||
      projection.runtimeRequests.some((request) => request.status === "pending") ||
      projection.subagents.some((subagent) => subagent.runId === run.id && isOpen(subagent.status));
    return !waitsOnSomething && quietMs >= Duration.toMillis(ORPHANED_RUN_ENDED_SESSION_IDLE)
      ? "session_ended"
      : null;
  }
  if (live.ingesting) return null;
  return quietMs >= Duration.toMillis(ORPHANED_RUN_UNOBSERVED_QUIET) ? "unobserved" : null;
}

/** An app-owned delegated child settles itself and reports to its parent. */
const isAppOwnedDelegation = (task: {
  readonly origin: string;
  readonly childThreadId: ThreadId | null;
}) => task.origin === "app_owned" && task.childThreadId !== null;

/**
 * Settles orphaned runs the way a restart would, one run at a time: failed
 * with a provider error the person can act on, or, when the project continues
 * threads after a restart, cancelled with a continuation queued. Every write
 * is gated on the run still running the same attempt, so a turn that ends on
 * its own in the meantime wins.
 */
export const makeSettler = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const settle = Effect.fn("OrphanedRuns.settle")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly kind: OrphanedRunKind;
  }) {
    const projection = yield* projections.getRuntimeRecoveryProjection(input.threadId);
    const run = projection.runs.find((candidate) => candidate.id === input.runId);
    if (run === undefined || run.status !== "running" || run.activeAttemptId === null) {
      return false;
    }
    const attemptId = run.activeAttemptId;
    const attempt = projection.attempts.find((candidate) => candidate.id === attemptId);
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === run.providerThreadId,
    );
    const providerTurn = latestProviderTurnForAttempt(projection.providerTurns, attemptId);
    const serverSettings = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const continueRun =
      serverSettings !== null &&
      resolveProjectSettings(serverSettings, projection.thread.projectId).settings
        .continueThreadsAfterServerUpdate &&
      projection.thread.archivedAt === null &&
      projection.thread.deletedAt === null &&
      projection.thread.providerInstanceId === run.providerInstanceId;
    // A continuation only resumes a cancelled run, as after a restart.
    const status = continueRun ? "cancelled" : "failed";
    const now = yield* DateTime.now;
    const commandId = CommandId.make(`command:orphaned-run:${run.id}:${input.kind}`);
    const allocateEventId = () => ids.allocate.event({ threadId: input.threadId, commandId });
    const runNodeIds = new Set(
      projection.nodes.filter((node) => node.runId === run.id).map((node) => node.id),
    );
    const delegatedNodeIds = new Set<string>([
      ...projection.subagents.filter(isAppOwnedDelegation).map((subagent) => subagent.id),
      ...projection.turnItems.flatMap((item) =>
        item.type === "subagent" && isAppOwnedDelegation(item) ? [item.subagentId] : [],
      ),
    ]);
    const base = {
      threadId: input.threadId,
      runId: run.id,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
    };
    const events: Array<OrchestrationV2DomainEvent> = [];
    for (const request of projection.runtimeRequests) {
      if (
        request.status !== "pending" ||
        request.responseCapability.type === "message" ||
        !runNodeIds.has(request.nodeId)
      ) {
        continue;
      }
      events.push({
        id: yield* allocateEventId(),
        type: "runtime-request.updated",
        threadId: input.threadId,
        nodeId: request.nodeId,
        occurredAt: now,
        payload: {
          ...request,
          status: "expired",
          responseCapability: { type: "not_resumable", reason: ORPHANED_RUN_MESSAGES[input.kind] },
          resolvedAt: now,
        },
      });
    }
    for (const subagent of projection.subagents) {
      if (subagent.runId !== run.id || !isOpen(subagent.status) || isAppOwnedDelegation(subagent)) {
        continue;
      }
      events.push({
        ...base,
        id: yield* allocateEventId(),
        type: "subagent.updated",
        nodeId: subagent.id,
        driver: subagent.driver,
        providerInstanceId: subagent.providerInstanceId,
        payload: { ...subagent, status: "cancelled", completedAt: now, updatedAt: now },
      });
    }
    for (const message of projection.messages) {
      if (message.runId !== run.id || !message.streaming) continue;
      events.push({
        ...base,
        id: yield* allocateEventId(),
        type: "message.updated",
        ...(message.nodeId === null ? {} : { nodeId: message.nodeId }),
        payload: { ...message, streaming: false, updatedAt: now },
      });
    }
    let lastItemOrdinal = 0;
    for (const item of projection.turnItems) {
      if (item.runId !== run.id) continue;
      lastItemOrdinal = Math.max(lastItemOrdinal, item.ordinal);
      if (!isOpen(item.status) || (item.type === "subagent" && isAppOwnedDelegation(item))) {
        continue;
      }
      events.push({
        ...base,
        id: yield* allocateEventId(),
        type: "turn-item.updated",
        ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
        payload:
          item.type === "secret_request" && item.secretStatus === "pending"
            ? {
                ...item,
                status: "cancelled",
                secretStatus: "cancelled",
                completedAt: now,
                updatedAt: now,
              }
            : {
                ...item,
                status: "cancelled",
                completedAt: now,
                updatedAt: now,
                ...(item.type === "reasoning" || item.type === "assistant_message"
                  ? { streaming: false }
                  : {}),
              },
      });
    }
    if (providerTurn !== undefined && isOpen(providerTurn.status)) {
      events.push({
        ...base,
        id: yield* allocateEventId(),
        type: "provider-turn.updated",
        nodeId: providerTurn.nodeId,
        payload: { ...providerTurn, status, completedAt: now },
      });
    }
    if (attempt !== undefined && isOpen(attempt.status)) {
      events.push({
        ...base,
        id: yield* allocateEventId(),
        type: "run-attempt.updated",
        nodeId: attempt.rootNodeId,
        payload: { ...attempt, status, completedAt: now },
      });
    }
    if (status === "failed" && providerThread !== undefined) {
      const rootNodeId = attempt?.rootNodeId ?? run.rootNodeId;
      events.push({
        ...base,
        id: yield* allocateEventId(),
        type: "turn-item.updated",
        ...(rootNodeId === null ? {} : { nodeId: rootNodeId }),
        payload: makeProviderFailureTurnItem({
          idAllocator: ids,
          driver: providerThread.driver,
          threadId: input.threadId,
          runId: run.id,
          nodeId: rootNodeId,
          providerThreadId: providerThread.id,
          providerTurnId:
            providerTurn?.id ??
            attempt?.providerTurnId ??
            ids.derive.providerTurn({
              driver: providerThread.driver,
              nativeTurnId: `failed:${attemptId}`,
            }),
          itemOrdinal: lastItemOrdinal + 1,
          failure: makeProviderFailure({
            class: "provider_error",
            message: ORPHANED_RUN_MESSAGES[input.kind],
            code: `orphaned_run_${input.kind}`,
            retryable: true,
          }),
          occurredAt: now,
        }),
      });
    }
    events.push({
      ...base,
      id: yield* allocateEventId(),
      type: "run.updated",
      payload: { ...run, status, queuePosition: null, completedAt: now },
    });
    for (const node of projection.nodes) {
      if (node.runId !== run.id || !isOpen(node.status) || delegatedNodeIds.has(node.id)) continue;
      events.push({
        ...base,
        id: yield* allocateEventId(),
        type: "node.updated",
        nodeId: node.id,
        payload: { ...node, status, completedAt: now },
      });
    }
    if (providerThread !== undefined && providerThread.status === "active") {
      events.push({
        id: yield* allocateEventId(),
        type: "provider-thread.updated",
        threadId: input.threadId,
        driver: providerThread.driver,
        providerInstanceId: providerThread.providerInstanceId,
        occurredAt: now,
        payload: { ...providerThread, status: "idle", updatedAt: now },
      });
    }
    const effects: Array<EffectOutbox.PendingOrchestrationEffectV2> = continueRun
      ? [
          {
            id: `effect:orphaned-run-continuation:${run.id}`,
            commandId,
            threadId: input.threadId,
            request: { type: "provider-runtime.continue", sourceRunId: run.id },
          },
        ]
      : [];
    const result = yield* eventSink.writeIfRunCurrent({
      commandId,
      threadId: input.threadId,
      runId: run.id,
      activeAttemptId: attemptId,
      expectedStatus: "running",
      events,
      effects,
    });
    if (!result.committed) return false;
    yield* Effect.logWarning("Settled a running run nothing was driving", {
      threadId: input.threadId,
      runId: run.id,
      kind: input.kind,
      continued: continueRun,
    });
    // A provider still working on the turn would go on changing files with
    // nobody watching, and a continuation would start on a busy thread.
    if (
      input.kind === "unobserved" &&
      providerThread?.providerSessionId != null &&
      providerTurn !== undefined
    ) {
      const runtime = yield* sessions
        .get(providerThread.providerSessionId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(runtime)) {
        yield* runtime.value
          .interruptTurn({ providerThread, providerTurnId: providerTurn.id })
          .pipe(
            Effect.timeout("10 seconds"),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logInfo("Could not stop the provider turn of a settled run", {
                    runId: run.id,
                    cause: Cause.pretty(cause),
                  }),
            ),
          );
      }
    }
    return true;
  });

  return { settle };
});
