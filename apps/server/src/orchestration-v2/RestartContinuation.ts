import { runRanAfter } from "@specweave-studio/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import {
  CommandId,
  isOrchestrationV2WorkActive,
  MessageId,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";

import * as ServerSettings from "../serverSettings.ts";
import {
  closedQuestionsPrompt,
  reopenCardRequestId,
  type ClosedQuestion,
} from "../serviceUpdate/ServiceUpdateClosedQuestions.ts";
import { isNativeMaintenanceCommand } from "./Orchestrator.ts";
import {
  cancelledForUpdate,
  personHoldsQueue,
  RESTART_CONTINUATION_MESSAGE_PREFIX,
  UPDATE_CONTINUATION_MESSAGE_PREFIX,
  UPDATE_REQUEUE_MESSAGE_PREFIX,
} from "./RestartQueueHold.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  continuationFailedBeforePrompt,
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
      candidate.status !== "queued" &&
      !cancelledForUpdate(candidate) &&
      (!latest || runRanAfter(candidate, latest))
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
  function* (input: {
    readonly threadId: ThreadId;
    readonly sourceRunId: RunId;
    /**
     * The questions and approvals a forced update closed on the source run
     * (`ServiceUpdateClosedQuestions`): the continuation tells the agent they
     * were closed and to ask again. Absent where the service keeps no record.
     */
    readonly closedQuestions?: (
      threadId: ThreadId,
      runId: RunId,
    ) => Effect.Effect<ReadonlyArray<ClosedQuestion>>;
  }) {
    const settings = yield* ServerSettings.ServerSettingsService;
    const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!enabled) return;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    // The id names why the run stopped, so the timeline can say "Resumed after update".
    const restartMessageId = MessageId.make(
      `${RESTART_CONTINUATION_MESSAGE_PREFIX}${input.sourceRunId}`,
    );
    const updateMessageId = MessageId.make(
      `${UPDATE_CONTINUATION_MESSAGE_PREFIX}${input.sourceRunId}`,
    );
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
    // A continuation the provider failed before taking its prompt starts again.
    if (
      !source ||
      (((source.status !== "cancelled" && source.status !== "interrupted") ||
        isRestartNoteSource(source, projection.providerTurns)) &&
        !continuationFailedBeforePrompt(source, projection.providerTurns, projection.attempts))
    )
      return;
    // A user submission after reconciliation takes precedence over an automatic
    // prompt. Queued runs never started and stay held behind this one, as did
    // the messages the update cancelled before it interrupted this run.
    if (
      projection.runs.some(
        (run) =>
          run.id !== source.id &&
          run.status !== "queued" &&
          !cancelledForUpdate(run) &&
          runRanAfter(run, source),
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
    // A parent's Stop reaches its open delegated tasks through an effect a restart can cut short.
    const { lineage } = projection.thread;
    if (lineage.relationshipToParent === "subagent" && lineage.parentThreadId !== null) {
      const parentRecords = yield* threads.getThreadRecords(lineage.parentThreadId, ["subagents"]);
      // A settled task no longer owns later work in its thread.
      const parentRunIds = parentRecords.subagents.flatMap((task) =>
        task.childThreadId === input.threadId &&
        task.result === null &&
        isOrchestrationV2WorkActive(task.status) &&
        task.runId !== null
          ? [task.runId]
          : [],
      );
      if (
        parentRunIds.length > 0 &&
        (yield* threads.getThreadRecords(lineage.parentThreadId, ["turnItems"], {
          turnItemTypes: ["run_interrupt_request"],
          turnItemRunIds: parentRunIds,
        })).turnItems.some(
          (item) => item.type === "run_interrupt_request" && item.cause !== "service_update",
        )
      )
        return;
    }
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
    // A question the update closed is asked again by the agent, before it goes on.
    // One already asked again as a card is not asked a second time: marked so,
    // or its card is there though the mark is not (written just before, or lost).
    let toAsk =
      input.closedQuestions === undefined
        ? []
        : (yield* input.closedQuestions(input.threadId, source.id)).filter(
            (entry) => entry.reopenedBy !== "card",
          );
    if (toAsk.length > 0) {
      const cards = yield* threads.getThreadRecords(input.threadId, ["runtimeRequests"]).pipe(
        Effect.map(
          (records) => new Set<string>(records.runtimeRequests.map((request) => request.id)),
        ),
        Effect.orElseSucceed(() => new Set<string>()),
      );
      toAsk = toAsk.filter((entry) => !cards.has(reopenCardRequestId(entry)));
    }
    const closed = closedQuestionsPrompt(toAsk);
    const continueText = closed === null ? CONTINUE_PROMPT : `${closed}\n\n${CONTINUE_PROMPT}`;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:restart-continuation:${input.sourceRunId}`),
      threadId: input.threadId,
      messageId,
      text:
        noteText === undefined
          ? continueText
          : note.settled && closed === null
            ? noteText
            : `${noteText}\n\n${continueText}`,
      attachments: [],
      modelSelection: source.modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      restartContinuationOfRunId: input.sourceRunId,
    });
    // Restart recovery holds the queue; a continued thread keeps its queue in
    // order and drains it after the continuation. A queue a person held (Stop,
    // or a failure) stays held for them.
    if (
      projection.runs.some((run) => run.status === "queued" && run.queueHeld === true) &&
      !personHoldsQueue(projection.runs)
    ) {
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
      const requeueId = (runId: RunId) =>
        MessageId.make(`${UPDATE_REQUEUE_MESSAGE_PREFIX}${runId}`);
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
    if (personHoldsQueue(current)) return;
    yield* threads.dispatch({
      type: "queue.resume",
      commandId: CommandId.make(`command:restart-queue-resume:${input.effectId}`),
      threadId: input.threadId,
    });
  },
);
