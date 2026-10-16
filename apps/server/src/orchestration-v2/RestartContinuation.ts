import { runRanAfter } from "@specweave-studio/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";

import * as ServerSettings from "../serverSettings.ts";
import { isNativeMaintenanceCommand } from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  isRestartNoteSource,
  restartCancelledBackgroundWorkNote,
  restartContinuationNote,
} from "./RestartBackgroundNote.ts";

const CONTINUE_PROMPT = "Continue where you left off.";

/**
 * Resume only an unfinished root turn. Leftover background work is cleaned up
 * separately and reported on the next user turn; it must not wake a settled run.
 */
export function restartContinuationRun(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    "thread" | "runs" | "providerThreads" | "providerSessions" | "providerTurns"
  >,
): OrchestrationV2Run | undefined {
  if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) return;
  // Queued runs never started; recovery holds them behind the cut run.
  const run = projection.runs.reduce<OrchestrationV2Run | undefined>(
    (latest, candidate) =>
      candidate.status !== "queued" && (!latest || runRanAfter(candidate, latest))
        ? candidate
        : latest,
    undefined,
  );
  if (!run) return;
  const preparedContinuation =
    run.status === "starting" && run.restartContinuationOfRunId !== undefined;
  if (run.status !== "running" && !preparedContinuation) return;
  const liveTurnRequired = !preparedContinuation;
  if (projection.thread.providerInstanceId !== run.providerInstanceId) return;
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === run.providerThreadId,
  );
  if (
    !providerThread ||
    providerThread.appThreadId !== projection.thread.id ||
    providerThread.ownerNodeId !== null ||
    providerThread.providerInstanceId !== run.providerInstanceId ||
    providerThread.nativeThreadRef?.nativeId == null ||
    providerThread.nativeThreadRef.strength !== "strong" ||
    providerThread.nativeThreadRef.driver !== providerThread.driver ||
    (liveTurnRequired && providerThread.status !== "active") ||
    providerThread.status === "closed" ||
    providerThread.status === "archived"
  )
    return;
  const session = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread.providerSessionId,
  );
  // Most adapters keep a live session "ready" through its turns, so only a
  // stopped or failed session rules out a live turn.
  if (
    session === undefined ||
    session.providerInstanceId !== run.providerInstanceId ||
    session.driver !== providerThread.driver ||
    (liveTurnRequired && (session.status === "stopped" || session.status === "error"))
  )
    return;
  if (
    liveTurnRequired &&
    !projection.providerTurns.some(
      (turn) =>
        turn.providerThreadId === providerThread.id &&
        turn.runAttemptId === run.activeAttemptId &&
        turn.status === "running",
    )
  )
    return;
  return run;
}

export const continueRestartedRun = Effect.fn("RestartContinuation.continueRestartedRun")(
  function* (input: { readonly threadId: ThreadId; readonly sourceRunId: RunId }) {
    const settings = yield* ServerSettings.ServerSettingsService;
    const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!enabled) return;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    // The id names why the run stopped, so the timeline can say "Resumed after update".
    const restartMessageId = MessageId.make(`message:restart-continuation:${input.sourceRunId}`);
    const updateMessageId = MessageId.make(`message:update-continuation:${input.sourceRunId}`);
    const projection = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "runs", "providerTurns", "attempts"],
      { messageIds: [restartMessageId, updateMessageId] },
    );
    if (
      !resolveProjectSettings(enabled, projection.thread.projectId).settings
        .continueThreadsAfterServerUpdate
    )
      return;
    if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) return;

    if (
      projection.messages.some(
        (message) => message.id === restartMessageId || message.id === updateMessageId,
      )
    )
      return;
    const source = projection.runs.find((run) => run.id === input.sourceRunId);
    // Pending effects from older versions may target settled background work,
    // including waiting runs that reconciliation subsequently cancelled.
    // A restart cancels a running turn; a service update interrupts it first.
    if (
      !source ||
      (source.status !== "cancelled" && source.status !== "interrupted") ||
      isRestartNoteSource(source, projection.providerTurns)
    )
      return;
    // A user submission after reconciliation takes precedence over an automatic
    // prompt. Queued runs never started and stay held behind this one.
    if (
      projection.runs.some(
        (run) => run.id !== source.id && run.status !== "queued" && runRanAfter(run, source),
      )
    )
      return;
    if (projection.thread.providerInstanceId !== source.providerInstanceId) return;
    const sourceRecords = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "turnItems"],
      {
        messageIds: [source.userMessageId],
        turnItemRunIds: [source.id],
        turnItemTypes: ["run_interrupt_request"],
      },
    );
    const interrupts = sourceRecords.turnItems.flatMap((item) =>
      item.runId === source.id && item.type === "run_interrupt_request" ? [item] : [],
    );
    // Someone (the user, an agent, a coordinator) asked this run to stop. Only a
    // stop for a service update continues; it is the only one an interrupted run may have.
    if (
      interrupts.some((item) => item.cause !== "service_update") ||
      (source.status === "interrupted" && interrupts.length === 0)
    )
      return;
    const sourceMessage = sourceRecords.messages.find(
      (message) => message.id === source.userMessageId,
    );
    if (sourceMessage !== undefined && isNativeMaintenanceCommand(sourceMessage)) return;
    const note = restartContinuationNote(
      source,
      projection.runs,
      projection.providerTurns,
      projection.attempts,
    );
    const noteText =
      note.work.length === 0 ? undefined : restartCancelledBackgroundWorkNote(note.work);
    // Only a stop for a service update leaves a continued run interrupted.
    const messageId = source.status === "interrupted" ? updateMessageId : restartMessageId;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:restart-continuation:${input.sourceRunId}`),
      threadId: input.threadId,
      messageId,
      text:
        noteText === undefined
          ? CONTINUE_PROMPT
          : note.settled
            ? noteText
            : `${noteText}\n\n${CONTINUE_PROMPT}`,
      attachments: [],
      modelSelection: source.modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      restartContinuationOfRunId: input.sourceRunId,
    });
    // Restart recovery and the update stop hold the queue; a continued thread
    // keeps its queue in order and drains it after the continuation.
    if (projection.runs.some((run) => run.status === "queued" && run.queueHeld === true)) {
      yield* threads
        .dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`command:restart-queue-resume:${input.sourceRunId}`),
          threadId: input.threadId,
        })
        .pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("Failed to resume a queue after a restart continuation", {
                threadId: input.threadId,
                cause,
              }),
          ),
        );
    }
  },
  // A delegated child this declined to continue still owes its parent a
  // result. Once a continuation run exists this is a no-op; that run settles it.
  (effect, input) =>
    effect.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          yield* threads.recoverDelegatedTask(input.threadId, input.sourceRunId);
        }),
      ),
    ),
);

/**
 * After a restart, a thread keeps its queue. Messages a service update had to
 * cancel (its helper installs only when no run is queued) are queued again in
 * their order, and with `releaseHeld` a queue recovery held while it was only
 * waiting (its last run had finished) starts again.
 */
export const resumeQueueAfterRestart = Effect.fn("RestartContinuation.resumeQueueAfterRestart")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly effectId: string;
    readonly releaseHeld: boolean;
  }) {
    const settings = yield* ServerSettings.ServerSettingsService;
    const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!enabled) return;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const { thread, runs } = yield* threads.getThreadRecords(input.threadId, ["runs"]);
    if (
      !resolveProjectSettings(enabled, thread.projectId).settings.continueThreadsAfterServerUpdate
    )
      return;
    if (thread.archivedAt !== null || thread.deletedAt !== null) return;
    const cancelled = runs
      .filter((run) => run.status === "cancelled" && run.cancelledForUpdate === true)
      .toSorted((left, right) => left.ordinal - right.ordinal);
    if (cancelled.length > 0) {
      const requeueId = (runId: RunId) => MessageId.make(`message:update-requeue:${runId}`);
      const { messages } = yield* threads.getThreadRecords(input.threadId, ["messages"], {
        messageIds: cancelled.flatMap((run) => [run.userMessageId, requeueId(run.id)]),
      });
      for (const run of cancelled) {
        if (messages.some((message) => message.id === requeueId(run.id))) continue;
        const original = messages.find((message) => message.id === run.userMessageId);
        // Wakes and delegated results have their own delivery; resending would repeat them.
        if (
          original === undefined ||
          original.notification !== undefined ||
          original.delegatedCompletion !== undefined
        )
          continue;
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`command:update-requeue:${run.id}`),
          threadId: input.threadId,
          messageId: requeueId(run.id),
          text: original.text,
          ...(original.context === undefined ? {} : { context: original.context }),
          attachments: original.attachments,
          modelSelection: run.modelSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: original.createdBy,
          creationSource: original.creationSource,
          ...(original.senderThreadId === undefined
            ? {}
            : { senderThreadId: original.senderThreadId }),
        });
      }
    }
    if (!input.releaseHeld) return;
    const { runs: current } = yield* threads.getThreadRecords(input.threadId, ["runs"]);
    if (!current.some((run) => run.status === "queued" && run.queueHeld === true)) return;
    yield* threads.dispatch({
      type: "queue.resume",
      commandId: CommandId.make(`command:restart-queue-resume:${input.effectId}`),
      threadId: input.threadId,
    });
  },
);
