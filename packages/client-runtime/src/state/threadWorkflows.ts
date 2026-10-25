import type {
  ChatAttachment,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ThreadProjection,
} from "@specweave-studio/contracts";
import { copySorted } from "@specweave-studio/shared/Array";
import {
  latestExecutedRun,
  usageLimitBlockedRun,
} from "@specweave-studio/shared/orchestrationV2ThreadError";

type Projection = OrchestrationV2ThreadProjection;
type Run = Projection["runs"][number];
type Message = Projection["messages"][number];
type ProviderSession = Projection["providerSessions"][number];

const ACTIVE_RUN_STATUSES = new Set<Run["status"]>(["preparing", "starting", "running", "waiting"]);
const MERGE_BACK_RUN_STATUSES = new Set<Run["status"]>(["waiting", "completed"]);
const MERGE_BACK_BLOCKING_RUN_STATUSES = new Set<Run["status"]>([
  "preparing",
  "starting",
  "running",
]);

/*
 * Who decides whether a message queues, steers or starts
 * ------------------------------------------------------
 * The server decides, never the drawer. When a message arrives:
 * - The thread is idle: it starts a new turn at once.
 * - A turn is running and its provider can take a message mid-turn (a running
 *   provider turn on a live session that supports steering): a person's send,
 *   or an agent's `studio_thread_send` in `auto` mode, is steered into it.
 * - Otherwise (the turn is still starting, saving its checkpoint, between
 *   provider turns, or its provider cannot steer) the message is queued and
 *   starts as the next turn. Coordinator, scheduled, Telegram and worker sends
 *   always queue, as do automatic deliveries (a delegated task's result, a
 *   monitor or worker notification).
 * The queue drains one message per turn, automatic deliveries first, and only
 * while nothing holds it: Stop holds it until the person resumes, a failure
 * the next message would repeat holds it, and a usage limit keeps it until
 * the limit resets or the person continues. Steer now asks the server to move
 * a queued message into the running turn; the row stays queued until the
 * provider accepts it and comes back if the steer fails.
 */

export interface QueuedThreadRun {
  readonly run: Run;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  /** Editing replaces this message's content, so its id and context travel with the row. */
  readonly messageId: Message["id"];
  readonly context?: Message["context"];
  /** Another agent's thread that sent this message; absent when the user typed it here. */
  readonly senderThreadId?: Message["senderThreadId"];
  readonly createdBy?: Message["createdBy"];
  /** A notification's own one-line summary (a worker report, a scheduled run). */
  readonly summary?: string;
  /**
   * A delegated task's result or a notification the server delivers by itself:
   * shown read-only, never edited, steered, removed or moved.
   */
  readonly automatic?: boolean;
  /** Steer now was accepted by the server and the provider has not taken it yet. */
  readonly steering?: boolean;
}

/** Why the queue is not draining right now. */
export type ThreadQueueWaitReason =
  /** A turn is running; the queue starts after it. */
  | "turn"
  /** A person's Stop holds the queue until they resume it. */
  | "stopped"
  /** The last turn failed in a way the next message would repeat. */
  | "failure"
  /** The provider's usage limit stopped the thread. */
  | "usage_limit"
  /** A server restart holds the queue until its own continuation runs. */
  | "restart"
  /** Nothing blocks it: the next message is about to start. */
  | "starting";

export interface ThreadQueueWorkflowState {
  readonly activeRun: Run | null;
  readonly queuedRuns: ReadonlyArray<QueuedThreadRun>;
  readonly isHeld: boolean;
  readonly canReorder: boolean;
  readonly canPromoteToSteer: boolean;
  /** Why the queue waits. Absent from older callers' fixtures. */
  readonly waitReason?: ThreadQueueWaitReason;
  /** Why Steer now is unavailable, in words for its tooltip; null when it is available. */
  readonly steerUnavailableReason?: string | null;
}

export function resolveActiveThreadRun(projection: Pick<Projection, "runs">): Run | null {
  return projection.runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? null;
}

/**
 * A successfully finished provider turn remains in `waiting` while its
 * checkpoint is captured. Keep that newest turn available for merge-back
 * instead of falling through to an older fully checkpointed run.
 */
export function resolveLatestMergeBackRun(projection: Projection): Run | null {
  const latestProviderFinishedRun = projection.runs.reduce<Run | null>(
    (latest, run) =>
      MERGE_BACK_RUN_STATUSES.has(run.status) && (latest === null || run.ordinal > latest.ordinal)
        ? run
        : latest,
    null,
  );
  if (latestProviderFinishedRun === null) return null;

  const hasNewerActiveRun = projection.runs.some(
    (run) =>
      run.ordinal > latestProviderFinishedRun.ordinal &&
      MERGE_BACK_BLOCKING_RUN_STATUSES.has(run.status),
  );
  return hasNewerActiveRun ? null : latestProviderFinishedRun;
}

function resolveThreadProviderSession(projection: Projection): ProviderSession | null {
  const activeRun = resolveActiveThreadRun(projection);
  const providerThreadId = activeRun?.providerThreadId ?? projection.thread.activeProviderThreadId;
  const activeProviderThread =
    providerThreadId === null
      ? null
      : (projection.providerThreads.find((thread) => thread.id === providerThreadId) ?? null);
  const attachedProviderThread =
    activeProviderThread ??
    projection.providerThreads.find(
      (thread) => thread.appThreadId === projection.thread.id && thread.providerSessionId !== null,
    ) ??
    null;
  const sessionId = attachedProviderThread?.providerSessionId ?? null;
  if (sessionId !== null) {
    return projection.providerSessions.find((session) => session.id === sessionId) ?? null;
  }
  return (
    projection.providerSessions.findLast(
      (session) => session.status !== "stopped" && session.status !== "error",
    ) ?? null
  );
}

export function threadSupportsProviderHandoff(
  projection: Projection | null | undefined,
  options?: {
    /**
     * False when the thread's selected provider cannot start a turn here (not
     * installed, not prepared, failing, or turned off). Such a provider has no
     * session to keep, so an idle thread may always move to another one.
     */
    readonly selectedInstanceCanRun?: boolean;
  },
): boolean {
  if (projection == null) return false;
  if (options?.selectedInstanceCanRun === false && resolveActiveThreadRun(projection) === null) {
    return true;
  }
  const session = resolveThreadProviderSession(projection);
  if (session !== null) {
    return session.capabilities.sessions.supportsProviderSwitchingViaHandoff;
  }
  if (resolveActiveThreadRun(projection) !== null) return false;
  if (projection.thread.historyOrigin === "v1_import" || projection.runs.length === 0) return true;
  // A thread the provider never answered (every run stopped before a native
  // session existed) has nothing native to carry: it can start on another provider.
  if (
    projection.runs.every((run) => run.status !== "completed") &&
    !projection.providerThreads.some(
      (thread) => thread.appThreadId === projection.thread.id && thread.nativeThreadRef !== null,
    )
  )
    return true;

  // The selected instance never answered on this thread (its session failed to
  // open, e.g. an agent not prepared on this machine): there is nothing native on
  // it to keep, so the thread may move to another provider the way it moved here.
  const selectedInstanceId = projection.thread.modelSelection.instanceId;
  if (
    !projection.runs.some(
      (run) => run.providerInstanceId === selectedInstanceId && run.status === "completed",
    ) &&
    !projection.providerThreads.some(
      (thread) =>
        thread.appThreadId === projection.thread.id &&
        thread.providerInstanceId === selectedInstanceId &&
        thread.nativeThreadRef !== null,
    )
  )
    return true;

  // Detaching a stopped session removes it from the projection, but its native
  // provider thread remains available for the next turn's portable handoff.
  return projection.providerThreads.some(
    (thread) =>
      thread.id === projection.thread.activeProviderThreadId &&
      thread.appThreadId === projection.thread.id &&
      thread.providerInstanceId === projection.thread.modelSelection.instanceId &&
      thread.nativeThreadRef !== null,
  );
}

function isAutomaticDelivery(message: Message | undefined): boolean {
  return message?.delegatedCompletion !== undefined || message?.notification !== undefined;
}

/** Automatic completion/notification runs are not messages in the user's queue. */
export function getUserQueuedThreadRuns(
  projection: Pick<Projection, "runs" | "messages">,
): ReadonlyArray<Run> {
  const automaticCompletionMessageIds = new Set(
    projection.messages.filter(isAutomaticDelivery).map((message) => message.id),
  );
  return projection.runs.filter(
    (run) => run.status === "queued" && !automaticCompletionMessageIds.has(run.userMessageId),
  );
}

/**
 * A queued run whose message Steer now already moved into the running turn:
 * the server keeps the row until the provider accepts the steer, then removes
 * it. When the steer fails the turn ends and the row starts as usual.
 */
export function isQueuedRunSteering(
  projection: Pick<Projection, "runs">,
  run: Run,
  message: Pick<Message, "runId"> | undefined,
): boolean {
  if (message === undefined || message.runId === null || message.runId === run.id) return false;
  const target = projection.runs.find((candidate) => candidate.id === message.runId);
  return target !== undefined && ACTIVE_RUN_STATUSES.has(target.status);
}

function queueWaitReason(projection: Projection, activeRun: Run | null): ThreadQueueWaitReason {
  const turnItems = projection.turnItems ?? [];
  const sessionError =
    projection.providerSessions
      ?.filter((session) => session.providerInstanceId === projection.thread.providerInstanceId)
      .at(-1)?.lastError ?? null;
  if (activeRun === null && usageLimitBlockedRun(projection.runs, turnItems, sessionError) !== null)
    return "usage_limit";
  const held = projection.runs.filter((run) => run.status === "queued" && run.queueHeld === true);
  if (held.length > 0) {
    if (held.every((run) => run.queueHeldForRestart === true)) return "restart";
    if (usageLimitBlockedRun(projection.runs, turnItems, sessionError) !== null)
      return "usage_limit";
    return latestExecutedRun(projection.runs)?.status === "failed" ? "failure" : "stopped";
  }
  return activeRun === null ? "starting" : "turn";
}

function steerUnavailableReason(input: {
  readonly activeRun: Run | null;
  readonly hasRunningProviderTurn: boolean;
  readonly session: ProviderSession | null;
}): string | null {
  const { activeRun, session } = input;
  if (activeRun === null) return "No turn is running to steer into.";
  if (activeRun.status === "preparing" || activeRun.status === "starting")
    return "The turn is still starting. It can be steered once the provider is running it.";
  if (activeRun.status === "waiting")
    return "The turn has finished and is saving its checkpoint. This message starts next.";
  if (!input.hasRunningProviderTurn)
    return "No provider turn is running right now, so there is nothing to steer into.";
  if (session === null || session.status === "stopped" || session.status === "error")
    return "The provider session is not live, so it cannot take a message mid-turn.";
  const turns = session.capabilities.turns;
  if (!turns.supportsActiveSteering && !turns.supportsSteeringByInterruptRestart)
    return "This provider cannot take a message in the middle of a turn.";
  return null;
}

export function deriveThreadQueueWorkflowState(projection: Projection): ThreadQueueWorkflowState {
  const activeRun = resolveActiveThreadRun(projection);
  const session = resolveThreadProviderSession(projection);
  const capabilities = session?.capabilities.turns;
  const hasSteerableProviderTurn =
    activeRun?.status === "running" &&
    activeRun.activeAttemptId !== null &&
    projection.providerTurns.some(
      (turn) => turn.runAttemptId === activeRun.activeAttemptId && turn.status === "running",
    );
  const messagesById = new Map(projection.messages.map((message) => [message.id, message]));
  // The server's delivery order: delegated results first, then by position.
  const queuedRuns = copySorted(
    projection.runs.filter((run) => run.status === "queued"),
    (left, right) =>
      Number(messagesById.get(right.userMessageId)?.delegatedCompletion !== undefined) -
        Number(messagesById.get(left.userMessageId)?.delegatedCompletion !== undefined) ||
      (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
      left.ordinal - right.ordinal,
  ).map((run): QueuedThreadRun => {
    const message = messagesById.get(run.userMessageId);
    const automatic = isAutomaticDelivery(message);
    const steering = isQueuedRunSteering(projection, run, message);
    return {
      run,
      text: message?.text ?? "Queued message",
      attachments: message?.attachments ?? [],
      messageId: run.userMessageId,
      ...(message?.context ? { context: message.context } : {}),
      ...(message?.senderThreadId ? { senderThreadId: message.senderThreadId } : {}),
      ...(message ? { createdBy: message.createdBy } : {}),
      ...(message?.notification ? { summary: message.notification.summary } : {}),
      ...(automatic ? { automatic } : {}),
      ...(steering ? { steering } : {}),
    };
  });
  const unavailable = steerUnavailableReason({
    activeRun,
    hasRunningProviderTurn: hasSteerableProviderTurn,
    session,
  });

  return {
    activeRun,
    queuedRuns,
    isHeld: projection.runs.some((run) => run.status === "queued" && run.queueHeld === true),
    canReorder: capabilities?.supportsQueuedMessages === true,
    canPromoteToSteer: unavailable === null,
    waitReason: queueWaitReason(projection, activeRun),
    steerUnavailableReason: unavailable,
  };
}

export function canForkProjectedAssistantItem(input: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly capabilities?: OrchestrationV2ProviderCapabilities | undefined;
}): boolean {
  const item = input.projectedItem.item;
  if (item.type !== "assistant_message" || item.runId === null || item.status !== "completed") {
    return false;
  }
  if (input.capabilities === undefined) {
    // Historical and inherited rows may outlive their provider-session record.
    // Keep the portable server-side fallback available when capability evidence
    // is absent; a known incapable provider is rejected below.
    return true;
  }
  const capabilities = input.capabilities;
  const canForkNatively =
    capabilities.threads.canForkThread &&
    capabilities.threads.canForkFromTurn &&
    capabilities.identity.nativeThreadIds === "strong";
  return canForkNatively || capabilities.context.supportsFullThreadHandoff;
}

export function canDetachThreadProviderSession(projection: Projection): boolean {
  const session = resolveThreadProviderSession(projection);
  return session !== null && session.status !== "stopped" && session.status !== "error";
}
