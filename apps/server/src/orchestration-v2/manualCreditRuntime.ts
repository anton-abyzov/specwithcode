import {
  manualCreditBindingMatches,
  manualCreditDispatchAllowed,
  ProviderSetupError,
  type ManualCodexCreditIntent,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

/** A credit intent grants no standing permission; Capacity checks the fresh native pool. */
export function creditAdmissionOptions(
  intent: ManualCodexCreditIntent | undefined,
  selection: ModelSelection,
  driver: string,
  now: number,
) {
  if (intent === undefined) return Effect.succeed(undefined);
  if (driver !== "codex" || !manualCreditBindingMatches(intent, selection, now)) {
    return Effect.fail(
      new ProviderSetupError({
        instanceId: selection.instanceId,
        operation: "session",
        detail:
          "This credit submission is stale or its provider/model changed. Submit again explicitly.",
      }),
    );
  }
  return Effect.succeed({
    allowCredits: true as const,
    expectedQuotaPoolId: intent.expectedQuotaPoolId,
  });
}

/** Checks canonical persisted provenance, not just a user-labelled adapter message. */
export function manualCreditRunAllowed(input: {
  readonly run: OrchestrationV2Run;
  readonly attempt: OrchestrationV2RunAttempt;
  readonly message: OrchestrationV2ConversationMessage;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: number;
  readonly phase: "open" | "turn";
}): boolean {
  const { run, attempt, message, providerThread, now, phase } = input;
  const intent = run.manualCodexCreditIntent;
  return (
    intent !== undefined &&
    manualCreditBindingMatches(intent, run.modelSelection, now) &&
    providerThread.driver === "codex" &&
    providerThread.goal?.status !== "active" &&
    providerThread.ownerNodeId === null &&
    providerThread.id === run.providerThreadId &&
    providerThread.providerInstanceId === intent.instanceId &&
    run.providerInstanceId === intent.instanceId &&
    run.activeAttemptId === attempt.id &&
    attempt.runId === run.id &&
    attempt.providerThreadId === providerThread.id &&
    attempt.providerInstanceId === intent.instanceId &&
    attempt.reason === "initial" &&
    attempt.attemptOrdinal === 1 &&
    attempt.providerTurnId === null &&
    run.status === (phase === "open" ? "starting" : "running") &&
    attempt.status === (phase === "open" ? "pending" : "running") &&
    (phase !== "open" || (run.startedAt === null && attempt.startedAt === null)) &&
    !run.queueHeld &&
    run.queuePosition == null &&
    run.workStartedAt === undefined &&
    message.id === run.userMessageId &&
    message.threadId === run.threadId &&
    message.role === "user" &&
    message.delegatedCompletion === undefined &&
    !/^\s*\/(?:goal|compact)(?:\s|$)/i.test(message.text) &&
    manualCreditDispatchAllowed({
      ...message,
      manualCodexCreditIntent: intent,
      dispatchMode: "start_immediately",
      restartContinuationOfRunId: run.restartContinuationOfRunId,
      delegatedCompletion: run.delegatedCompletion,
      sourcePlanRef: run.sourcePlanRef,
    })
  );
}
