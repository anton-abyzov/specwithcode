import type {
  MessageId,
  ModelSelection,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2Actor,
  OrchestrationV2ConversationMessage,
  OrchestrationV2CreationSource,
  OrchestrationV2ProviderRef,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import { runRanAfter } from "@specweave-studio/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import { isOrchestrationV2WorkActive } from "@specweave-studio/contracts";

function trimmed(value: string | null | undefined): string | undefined {
  const result = value?.trim();
  return result && result.length > 0 ? result : undefined;
}

// Briefs often open with where to work ("Repo: /Users/...", "Branch: main."); a title names the work.
const CONTEXT_LEAD =
  /^(?:repo|repository|project|path|folder|directory|cwd|working directory|workspace|worktree|branch|context|model)\s*:/i;

function taskSummary(prompt: string): string {
  const sentences = prompt.trim().split(/(?<=[.!?])\s+|\n+/);
  return (
    sentences.find((sentence) => sentence.trim() && !CONTEXT_LEAD.test(sentence.trim())) ?? prompt
  );
}

export function subagentThreadTitle(input: {
  readonly parentTitle: string;
  readonly title?: string | null;
  readonly prompt: string;
  readonly ordinal: number;
}): string {
  const detail = trimmed(input.title) ?? trimmed(taskSummary(input.prompt));
  if (detail === undefined) {
    return `${input.parentTitle} subagent ${input.ordinal}`;
  }
  const clipped = detail.length > 72 ? `${detail.slice(0, 69)}...` : detail;
  return clipped;
}

export function makeSubagentChildThread(input: {
  readonly parentThread: OrchestrationV2AppThread;
  readonly childThreadId: ThreadId;
  readonly parentNodeId: NodeId;
  readonly activeProviderThreadId: ProviderThreadId | null;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection: ModelSelection;
  readonly title: string;
  readonly now: DateTime.Utc;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}): OrchestrationV2AppThread {
  // Delivery evidence judges the parent's request, not the child's.
  const {
    lifecycleReceipt: _lifecycleReceipt,
    lifecycleRevision: _lifecycleRevision,
    ...parentThread
  } = input.parentThread;
  return {
    ...parentThread,
    createdBy: input.createdBy,
    creationSource: input.creationSource,
    id: input.childThreadId,
    title: input.title,
    linkedPullRequest: null,
    pullRequests: [],
    historyOrigin: undefined,
    // The child picks its own model; it stands in for nothing its parent did.
    launchFallbackFrom: null,
    providerInstanceId: input.providerInstanceId,
    modelSelection: input.modelSelection,
    activeProviderThreadId: input.activeProviderThreadId,
    lineage: {
      parentThreadId: input.parentThread.id,
      relationshipToParent: "subagent",
      rootThreadId: input.parentThread.lineage.rootThreadId,
    },
    forkedFrom: {
      type: "node",
      nodeId: input.parentNodeId,
    },
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    // Pins, ordering and settle overrides are the person's choices for the
    // parent thread; a child starts unpinned and settles on its own.
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    autoSettleDisabledAt: null,
    // The child picks its own model, so no preswitch origin carries over.
    limitPreswitchFrom: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

export function makeSubagentConversationArtifacts(input: {
  readonly messageId: MessageId;
  readonly senderThreadId?: ThreadId;
  readonly turnItemId: TurnItemId;
  readonly threadId: ThreadId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId | null;
  readonly providerTurnId: ProviderTurnId | null;
  readonly nativeItemRef: OrchestrationV2ProviderRef | null;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly ordinal: number;
  readonly now: DateTime.Utc;
}): {
  readonly message: OrchestrationV2ConversationMessage;
  readonly turnItem: OrchestrationV2TurnItem;
} {
  const message: OrchestrationV2ConversationMessage = {
    createdBy: "agent",
    creationSource: "provider",
    id: input.messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: input.rootNodeId,
    role: input.role,
    ...(input.role === "user" && input.senderThreadId !== undefined
      ? { senderThreadId: input.senderThreadId }
      : {}),
    text: input.text,
    attachments: [],
    streaming: false,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const base = {
    id: input.turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: input.rootNodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: input.nativeItemRef,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: input.now,
    completedAt: input.now,
    updatedAt: input.now,
    messageId: input.messageId,
    text: input.text,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.role === "user"
      ? {
          ...base,
          createdBy: "agent",
          creationSource: "provider",
          type: "user_message",
          ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
          inputIntent: "turn_start",
          attachments: [],
        }
      : {
          ...base,
          type: "assistant_message",
          streaming: false,
        };
  return { message, turnItem };
}

export function subagentResultForRun(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems">,
  run: OrchestrationV2Run,
): {
  readonly text: string;
  readonly messageId: OrchestrationV2ConversationMessage["id"] | null;
  readonly turnItemId: OrchestrationV2TurnItem["id"] | null;
} {
  const message =
    projection.messages
      .filter(
        (candidate) =>
          candidate.runId === run.id &&
          candidate.role === "assistant" &&
          candidate.text.trim().length > 0,
      )
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
      )[0] ?? null;
  const turnItem =
    projection.turnItems
      .filter(
        (
          candidate,
        ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "assistant_message" }> =>
          candidate.runId === run.id &&
          candidate.type === "assistant_message" &&
          candidate.text.trim().length > 0,
      )
      .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null;
  const failure =
    run.status === "failed"
      ? projection.turnItems
          .filter((item) => item.runId === run.id && item.type === "error")
          .toSorted((left, right) => right.ordinal - left.ordinal)[0]
      : undefined;
  const text =
    (failure?.type === "error" ? failure.failure.message : undefined) ??
    message?.text ??
    turnItem?.text ??
    (run.status === "completed"
      ? "Child task completed without an assistant result."
      : `Child task ended with status ${run.status}.`);
  return {
    text,
    messageId: failure === undefined ? (message?.id ?? turnItem?.messageId ?? null) : null,
    turnItemId: failure?.id ?? turnItem?.id ?? null,
  };
}

/** A finished turn can still own live children or queued completion follow-ups. */
export function delegatedTaskProgress(projection: {
  readonly runs: OrchestrationV2ThreadProjection["runs"];
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "runId" | "notification">
  >;
  readonly subagents: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["subagents"][number], "status" | "completionDelivery">
  >;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["providerThreads"][number], "pendingBackgroundTasks">
  >;
}) {
  const terminal = (status: string) =>
    ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
  const monitorRuns = new Set(
    projection.messages
      .filter((message) => message.notification?.source.kind === "monitor")
      .map((message) => message.runId),
  );
  const workRuns = projection.runs.filter(
    (run) => !monitorRuns.has(run.id) && run.status !== "rolled_back",
  );
  const active = workRuns.some((run) => !terminal(run.status));
  const children =
    projection.subagents.some(
      (task) =>
        isOrchestrationV2WorkActive(task.status) ||
        // Publishing a child's result precedes scheduling its parent's wake.
        // The parent still owes that follow-up even between those transactions.
        task.completionDelivery?.state === "pending" ||
        task.completionDelivery?.state === "claimed",
    ) ||
    projection.providerThreads.some((thread) => (thread.pendingBackgroundTasks?.length ?? 0) > 0);
  const resultRun = workRuns
    .filter((run) => terminal(run.status) && (run.startedAt !== null || run.ordinal === 1))
    .toSorted((a, b) => (runRanAfter(a, b) ? -1 : runRanAfter(b, a) ? 1 : 0))[0];
  return {
    state:
      active || resultRun === undefined
        ? ("working" as const)
        : children
          ? ("waiting_for_children" as const)
          : ("result_available" as const),
    resultRun,
  };
}
