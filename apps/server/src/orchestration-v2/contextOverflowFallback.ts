import type {
  ModelSelection,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ServerProvider,
} from "@specweave-studio/contracts";
import { latestRootProviderFailure } from "@specweave-studio/shared/orchestrationV2ThreadError";
import type { ContextFitRequirement } from "@specweave-studio/shared/providerFallback";
import { contextWindowTokens } from "@specweave-studio/shared/taskRouting";
import { attachmentTokenAllowance } from "./ContextHandoffBudget.ts";
import {
  contextRecoveryStep,
  isContextOverflowFailure,
  providerSupportsCompaction,
} from "./ContextOverflowRecoveryWorker.ts";
import { epochMs, fallbackMove } from "./providerOpenFailure.ts";
import { limitChainOnInstance, type UnopenableStop } from "./unopenableFallback.ts";

type StopThread = {
  readonly id: OrchestrationV2Run["threadId"];
  readonly status: string;
  readonly lastErrorClass?: string | null | undefined;
  readonly latestRunId: OrchestrationV2Run["id"] | null;
  readonly latestRunCompletedAt?: Parameters<typeof epochMs>[0];
};

/**
 * The context window of `selection` on this host, in tokens, or null: the
 * model's default `contextWindow` option when its provider lists one, else
 * the largest window a native session of the same model reported in this
 * thread. Codex and Gemini publish no option, but every turn reports it.
 */
export function contextWindowOf(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "providerThreadId" | "modelSelection">>,
  providerThreads: ReadonlyArray<Pick<OrchestrationV2ProviderThread, "id" | "contextUsage">>,
): number | null {
  const listed = contextWindowTokens(
    providers
      .find((provider) => provider.instanceId === selection.instanceId)
      ?.models.find((model) => model.slug === selection.model),
  );
  if (listed !== null) return listed;
  let observed: number | null = null;
  for (const run of runs) {
    if (
      run.modelSelection.instanceId !== selection.instanceId ||
      run.modelSelection.model !== selection.model
    )
      continue;
    const max = providerThreads.find((thread) => thread.id === run.providerThreadId)?.contextUsage
      ?.maxTokens;
    if (max != null && max > 0 && (observed === null || max > observed)) observed = max;
  }
  return observed;
}

/** Tokens of a request sent whole: its text in bytes, as the handoff budget counts it, plus attachments. */
function requestTokens(
  message: Pick<OrchestrationV2ConversationMessage, "text" | "attachments"> | undefined,
): number {
  if (message === undefined) return 0;
  return (
    Buffer.byteLength(JSON.stringify(message.text)) + attachmentTokenAllowance(message.attachments)
  );
}

/**
 * The thread's latest run failed because its conversation does not fit the
 * model, and recovery on that model cannot help: a provider handoff that did
 * not fit even a fresh native session, a compaction or resend that overflowed
 * again, or a provider that cannot compact. It is a stop like a provider that
 * could not open: the fallback moves the thread to the next model whose window
 * holds it (see `unopenableFallbackCommand`). Null for an overflow the
 * context recovery still owns, and for any other failure.
 *
 * The stop answers the chain the failed run belongs to, like
 * `unopenableStop`: a fallback move's origin and hop, a limit fallback that
 * put the thread on this instance, or the overflowed request itself.
 * `messages` must hold the user message of the failed run and of the run the
 * recovery answered; `providerThreads` the thread's native sessions.
 */
export function contextOverflowStop(
  thread: StopThread,
  input: {
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
    readonly providerThreads: ReadonlyArray<
      Pick<OrchestrationV2ProviderThread, "id" | "contextUsage">
    >;
    readonly providers: ReadonlyArray<ServerProvider>;
  },
): UnopenableStop | null {
  if (thread.status !== "failed" || thread.lastErrorClass === "usage_limit") return null;
  const run = input.runs.find((candidate) => candidate.id === thread.latestRunId);
  if (run === undefined) return null;
  const failure = latestRootProviderFailure(run, input.turnItems);
  if (failure === null || !isContextOverflowFailure(failure)) return null;
  const step = contextRecoveryStep(thread.id, run, failure);
  if (step === null) return null;
  // Compaction is the recovery's while the provider can compact.
  if (
    step.type === "compact" &&
    providerSupportsCompaction(input.providers, run.providerInstanceId) !== false
  )
    return null;
  if (step.type === "retry") return null;
  const answered = input.runs.find((candidate) => candidate.id === step.failedRunId) ?? run;
  const request = input.messages.find((message) => message.id === answered.userMessageId);
  const contextFit: ContextFitRequirement = {
    requestTokens: requestTokens(request),
    windowOf: (selection) =>
      contextWindowOf(selection, input.providers, input.runs, input.providerThreads),
  };
  const failed = {
    runId: run.id,
    instanceId: run.providerInstanceId,
    selection: run.modelSelection,
    failedAtMs: epochMs(run.completedAt ?? thread.latestRunCompletedAt),
    userMessageId: run.userMessageId,
    failure,
    cause: "context" as const,
    contextFit,
  };
  const continued =
    fallbackMove(thread.id, run.userMessageId) ?? fallbackMove(thread.id, answered.userMessageId);
  const origin =
    continued === null
      ? undefined
      : input.runs.find((candidate) => candidate.id === continued.runId);
  if (origin !== undefined && continued !== null)
    return {
      ...failed,
      originRunId: origin.id,
      nextHop: continued.hop + 1,
      originIsLimit: continued.fromLimit,
    };
  const limit = limitChainOnInstance(thread.id, run.providerInstanceId, run, input.runs);
  if (limit !== null) return { ...failed, ...limit, originIsLimit: true };
  return { ...failed, originRunId: answered.id, nextHop: 0, originIsLimit: false };
}
