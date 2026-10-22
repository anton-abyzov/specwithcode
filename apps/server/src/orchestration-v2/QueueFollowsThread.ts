import type {
  ChatAttachment,
  ModelSelection,
  OrchestrationMessageContext,
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@specweave-studio/contracts";
import { modelSelectionsEqual } from "@specweave-studio/shared/model";

import { API_CREDIT_MESSAGE_PREFIX, queuedRunsPinnedTo } from "./limitFallbackReturn.ts";
import {
  LIMIT_FALLBACK_MESSAGE_PREFIX,
  PROVIDER_FALLBACK_MESSAGE_PREFIX,
} from "./providerOpenFailure.ts";
import { PROVIDER_RETRY_MESSAGE_PREFIX } from "./unopenableFallback.ts";

/**
 * Id prefixes of the server's own continuations that move a stopped thread to
 * another provider or resume it: the provider fallback (`limit-fallback:`,
 * `provider-fallback:`), the move to API credits (`limit-api:`), the way back
 * (`limit-return:`), the ready-provider retry (`provider-retry:`) and
 * usage-limit recovery (`limit-resume:`).
 */
export const SERVER_CONTINUATION_ID_PREFIXES = [
  LIMIT_FALLBACK_MESSAGE_PREFIX,
  PROVIDER_FALLBACK_MESSAGE_PREFIX,
  API_CREDIT_MESSAGE_PREFIX,
  "limit-return:",
  PROVIDER_RETRY_MESSAGE_PREFIX,
  "limit-resume:",
] as const;

/** A native /compact or /logout turn: provider maintenance, not agent work. */
export function isNativeMaintenanceCommand(message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
}): boolean {
  return (
    message.attachments.length === 0 &&
    ["/compact", "/logout"].includes(message.text.trim().toLowerCase())
  );
}

/**
 * A server continuation decides for a stopped thread the way a human send
 * would: it releases the held queue, and the automatic deliveries held behind
 * the failure drain after it on the thread's new provider.
 */
export function isServerContinuation(
  command: Partial<
    Pick<
      Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
      "commandId" | "messageId" | "creationSource"
    >
  >,
): boolean {
  return (
    command.creationSource === "server" &&
    SERVER_CONTINUATION_ID_PREFIXES.some(
      (prefix) =>
        command.commandId?.startsWith(prefix) === true ||
        command.messageId?.startsWith(prefix) === true,
    )
  );
}

/**
 * Server-created background-task notifications and delegated completions carry
 * no model of their own: they are queued on the thread's selection at the time
 * and start on the thread's selection now. Pinned to the instance they were
 * queued on, they would switch a thread the fallback moved back to a provider
 * that is limited or cannot open. A user's queued message keeps its model.
 */
export function followsThreadSelection(
  message: Pick<
    OrchestrationV2ConversationMessage,
    "createdBy" | "creationSource" | "notification" | "delegatedCompletion"
  >,
): boolean {
  return (
    message.createdBy === "agent" &&
    message.creationSource === "server" &&
    (message.notification !== undefined || message.delegatedCompletion !== undefined)
  );
}

/** The selection a queued run starts on: the thread's for a delivery that follows it. */
export function queuedRunStartSelection(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "messages">,
  run: Pick<OrchestrationV2Run, "modelSelection" | "userMessageId">,
): ModelSelection {
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  return message !== undefined && followsThreadSelection(message)
    ? projection.thread.modelSelection
    : run.modelSelection;
}

/**
 * Provider-buffered wakes (a provider's own background task finished) queued
 * on an instance other than the one a server continuation moves the thread to.
 * Their buffered output belongs to that provider, which is limited or cannot
 * open, so they are delivered as server text instead, and then follow the
 * thread like any server-created notification.
 */
export function wakesLeftOnAnotherInstance(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  target: ModelSelection,
): ReadonlyArray<{
  readonly run: OrchestrationV2Run;
  readonly message: OrchestrationV2ConversationMessage;
}> {
  return projection.runs.flatMap((run) => {
    if (run.status !== "queued" || run.providerInstanceId === target.instanceId) return [];
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    return message !== undefined &&
      message.createdBy === "agent" &&
      message.creationSource === "provider" &&
      message.notification !== undefined
      ? [{ run, message }]
      : [];
  });
}

/**
 * Queued runs that took the thread's selection when they were sent, left on it
 * when a server continuation moves the thread to `target`. A send carries the
 * model the composer showed, which is the thread's own, so a run whose model
 * equals the thread's selection before the move is treated as inherited and
 * goes with the thread. A run on any other model was picked for that message
 * and keeps it. Provider-buffered wakes are converted instead, deliveries that
 * follow the thread need no change, and a native /compact or /logout stays
 * with the provider it maintains. Held runs are included.
 */
export function inheritedRunsLeftOnPreviousSelection(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages"> & {
    readonly thread: Pick<OrchestrationV2AppThread, "modelSelection">;
  },
  target: ModelSelection,
): ReadonlyArray<{
  readonly run: OrchestrationV2Run;
  readonly message: OrchestrationV2ConversationMessage;
}> {
  const previous = projection.thread.modelSelection;
  if (modelSelectionsEqual(previous, target)) return [];
  return projection.runs.flatMap((run) => {
    if (run.status !== "queued" || !modelSelectionsEqual(run.modelSelection, previous)) return [];
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    return message !== undefined &&
      message.creationSource !== "provider" &&
      !followsThreadSelection(message) &&
      !isNativeMaintenanceCommand(message)
      ? [{ run, message }]
      : [];
  });
}

/**
 * Queued runs that hold the way back to `target` off `instanceId`: those that
 * would start there (`queuedRunsPinnedTo`) and that the way back leaves where
 * they are. Deliveries that follow the thread, and sends that took the
 * thread's selection, held or not (`inheritedRunsLeftOnPreviousSelection`),
 * go home with it, so only a send a person put on the fallback waits.
 */
export function queuedRunsHoldingWayBack(
  projection: Parameters<typeof inheritedRunsLeftOnPreviousSelection>[0],
  instanceId: OrchestrationV2Run["providerInstanceId"],
  target: ModelSelection,
): ReadonlyArray<OrchestrationV2Run> {
  const moved = new Set(
    inheritedRunsLeftOnPreviousSelection(projection, target).map(({ run }) => run.id),
  );
  return queuedRunsPinnedTo(projection.runs, instanceId).filter((run) => {
    if (moved.has(run.id)) return false;
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    return message === undefined || !followsThreadSelection(message);
  });
}
