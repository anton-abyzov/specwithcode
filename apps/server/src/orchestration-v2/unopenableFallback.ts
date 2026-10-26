import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  orchestrationV2RunStartMessageId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { latestRootProviderFailure } from "@specweave-studio/shared/orchestrationV2ThreadError";
import {
  canTakeTurn,
  type ContextFitRequirement,
  type ProviderFallbackRule,
  resolveProviderFallback,
} from "@specweave-studio/shared/providerFallback";
import { isBlockingRuntimeRequest } from "./blockingRuntimeRequest.ts";
import { CONTEXT_COMPACT_MESSAGE_PREFIX } from "./contextRecoveryIds.ts";
import {
  apiCreditOrigin,
  epochMs,
  fallbackMove,
  isOpenFailure,
  LIMIT_FALLBACK_MESSAGE_PREFIX,
  LIMIT_STOP_MAX_AGE_MS,
  previousOpenFailure,
  PROVIDER_FALLBACK_MESSAGE_PREFIX,
} from "./providerOpenFailure.ts";

export const PROVIDER_FALLBACK_CONTINUE_TEXT = "Continue where you left off.";

export type FallbackThread = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "providerInstanceId"
  | "modelSelection"
  | "status"
  | "lastErrorClass"
  | "latestRunId"
  | "activeRunId"
  | "pendingRuntimeRequest"
  | "settledOverride"
> &
  Partial<
    Pick<
      OrchestrationV2ThreadShell,
      | "lastError"
      | "usageLimitResetAt"
      | "latestRunStartedAt"
      | "latestRunCompletedAt"
      | "activityRunStatus"
      | "pendingBackgroundTasks"
      | "snoozedUntil"
      | "limitRecovery"
      | "worktreePath"
      | "runtimeMode"
      | "interactionMode"
      | "updatedAt"
      | "modelIdentity"
    >
  >;

/** Nothing holds the thread: no turn running and no question that really waits. */
export const threadIsFree = (thread: FallbackThread): boolean =>
  thread.activeRunId === null && !isBlockingRuntimeRequest(thread, thread.latestRunId);

/** Fallback moves one stop may make after its first, each because the last target could not open. */
export const LIMIT_FALLBACK_MAX_HOPS = 3;

/** How long an instance that could not open stays out of fallbacks without a newer ready read. */
export const UNOPENABLE_HOLD_MS = 30 * 60_000;

/** The message id prefix of the one retry of a run whose provider could not open. */
export const PROVIDER_RETRY_MESSAGE_PREFIX = "provider-retry:";

/**
 * A provider-ready retry goes out only for a failure this recent: an older
 * failed thread is someone's to look at, not something to resend unasked.
 */
export const PROVIDER_RETRY_MAX_AGE_MS = 24 * 60 * 60_000;

/** The thread's latest run, which failed because its provider session never opened. */
export interface OpenFailure {
  readonly runId: OrchestrationV2Run["id"];
  readonly instanceId: ProviderInstanceId;
  readonly selection: ModelSelection;
  readonly failedAtMs: number;
  readonly userMessageId: string;
  readonly failure: OrchestrationV2ProviderFailure;
}

/**
 * A turn that failed because its provider could not open, where retrying
 * cannot help or clearly did not: the setup is broken (`provider_unavailable`:
 * not prepared, not installed, signed out), or the session would not open on a
 * fallback move or twice in a row. Under `switch` it is a stop like a usage
 * limit.
 */
export interface UnopenableStop extends OpenFailure {
  /**
   * The stop the fallback answers: the run a limit-fallback continuation
   * continued when the failed run was one, else the failed run itself.
   */
  readonly originRunId: OrchestrationV2Run["id"];
  /** Which move from that stop the next fallback is: 0 for the first. */
  readonly nextHop: number;
  /**
   * The stop was a usage limit, so its moves are `limit-fallback:` and the
   * way back may return to it; otherwise `provider-fallback:`, and never back.
   */
  readonly originIsLimit: boolean;
  /**
   * Why the thread must move: its provider could not open (the default), or
   * the conversation no longer fits it and recovery on it cannot help
   * (`contextOverflowStop`). A context stop never holds the instance for
   * other threads and moves only to a model whose window fits.
   */
  readonly cause?: "open" | "context";
  /** For a context stop: what the target must hold (`ContextFitRequirement`). */
  readonly contextFit?: ContextFitRequirement;
  /**
   * For a context stop: the request that overflowed, sent again whole on the
   * target. History handed over is capped, so "Continue where you left off"
   * would leave a large request out of what the target sees.
   */
  readonly request?: Pick<OrchestrationV2ConversationMessage, "text" | "attachments" | "context">;
}

type StopThread = Pick<
  FallbackThread,
  "id" | "status" | "lastErrorClass" | "latestRunId" | "latestRunCompletedAt"
>;

/**
 * Whether the thread's latest run failed to open its provider, read from the
 * run's own failure (see `isOpenFailure`).
 */
export function latestOpenFailure(
  thread: StopThread,
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): OpenFailure | null {
  if (thread.status !== "failed" || thread.lastErrorClass === "usage_limit") return null;
  const run = runs.find((candidate) => candidate.id === thread.latestRunId);
  if (run === undefined) return null;
  const failure = latestRootProviderFailure(run, turnItems);
  if (!isOpenFailure(failure)) return null;
  return {
    runId: run.id,
    instanceId: run.providerInstanceId,
    selection: run.modelSelection,
    failedAtMs: epochMs(run.completedAt ?? thread.latestRunCompletedAt),
    userMessageId: orchestrationV2RunStartMessageId(run),
    failure,
  };
}

/**
 * Whether deciding the stop needs the items of the run before the failed one
 * on its instance: an open failure that is neither a setup failure, a fallback
 * move nor a provider-ready retry moves the thread only when that earlier run
 * failed to open too. A retry is only ever sent for an open failure, so its own
 * failure is the repeat, however late it ran and wherever the thread was moved.
 */
export function needsPreviousRun(threadId: string, failed: OpenFailure): boolean {
  return (
    failed.failure.code !== ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE &&
    fallbackMove(threadId, failed.userMessageId) === null &&
    !failed.userMessageId.startsWith(`${PROVIDER_RETRY_MESSAGE_PREFIX}${threadId}:`)
  );
}

/**
 * The run whose chain a failed run continues: the run a provider-ready retry
 * retried (and so on, should one ever retry another), else the run itself.
 * A retry that fails again continues the stop it retried, with that stop's
 * origin and hop count, so retries and fallback moves can never restart
 * each other's chain.
 */
function chainRun(
  threadId: string,
  run: OrchestrationV2Run,
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run {
  const prefix = `${PROVIDER_RETRY_MESSAGE_PREFIX}${threadId}:`;
  const seen = new Set<string>();
  let current = run;
  while (orchestrationV2RunStartMessageId(current).startsWith(prefix) && !seen.has(current.id)) {
    seen.add(current.id);
    const retriedId = orchestrationV2RunStartMessageId(current).slice(prefix.length);
    const retried = runs.find((candidate) => candidate.id === retriedId);
    if (retried === undefined) break;
    current = retried;
  }
  return current;
}

/**
 * The latest run's open failure as a stop the fallback may move, and which
 * stop that answers, or null. A setup failure always is one. Any other open
 * failure is one only when retrying clearly did not help: the failed run was
 * itself a fallback move, or the run before it on the same instance also
 * failed to open within one session window. One failure on the thread's own
 * provider may be transient and never moves it. `turnItems` must hold the
 * failed run's items and, for that second case, the earlier run's.
 *
 * The stop answers the chain the failed run belongs to: a fallback move's
 * origin, a retried run's chain (see `chainRun`), or, for a turn on a
 * provider a usage-limit fallback put the thread on, that limit stop, so the
 * next move is still `limit-fallback:` and the way back still finds home.
 */
export function unopenableStop(
  thread: StopThread,
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): UnopenableStop | null {
  const failed = latestOpenFailure(thread, runs, turnItems);
  if (failed === null) return null;
  const run = runs.find((candidate) => candidate.id === failed.runId)!;
  if (
    needsPreviousRun(thread.id, failed) &&
    !previousOpenFailure(run, runs, turnItems, failed.failedAtMs)
  )
    return null;
  const chain = chainRun(thread.id, run, runs);
  const continued = fallbackMove(thread.id, orchestrationV2RunStartMessageId(chain));
  const origin =
    continued === null ? undefined : runs.find((candidate) => candidate.id === continued.runId);
  if (origin !== undefined && continued !== null)
    return {
      ...failed,
      originRunId: origin.id,
      nextHop: continued.hop + 1,
      originIsLimit: continued.fromLimit,
    };
  const limit = limitChainOnInstance(thread.id, failed.instanceId, run, runs);
  if (limit !== null) return { ...failed, ...limit, originIsLimit: true };
  return { ...failed, originRunId: chain.id, nextHop: 0, originIsLimit: false };
}

/**
 * The usage-limit stop a `switch` fallback answered by putting the thread on
 * `instanceId`, when it has run nowhere else since, and the hop after the
 * move that put it there. Null when no limit fallback put it there.
 */
export function limitChainOnInstance(
  threadId: StopThread["id"],
  instanceId: ProviderInstanceId,
  run: OrchestrationV2Run,
  runs: ReadonlyArray<OrchestrationV2Run>,
): { readonly originRunId: OrchestrationV2Run["id"]; readonly nextHop: number } | null {
  const found = apiCreditOrigin(
    { id: threadId, providerInstanceId: instanceId },
    runs.filter((candidate) => candidate.ordinal <= run.ordinal),
    LIMIT_FALLBACK_MESSAGE_PREFIX,
  );
  if (found === null) return null;
  const mover = runs.find((candidate) => candidate.id === found.continuedByRunId);
  const move =
    mover === undefined ? null : fallbackMove(threadId, orchestrationV2RunStartMessageId(mover));
  if (move === null) return null;
  return { originRunId: found.stoppedRunId, nextHop: move.hop + 1 };
}

/** The thread still sits on the failed run, with nothing else going on. */
export function openFailureIsIdle(thread: FallbackThread, failed: OpenFailure) {
  return (
    thread.status === "failed" &&
    thread.lastErrorClass !== "usage_limit" &&
    thread.latestRunId === failed.runId &&
    threadIsFree(thread) &&
    thread.settledOverride !== "settled"
  );
}

/**
 * An unopenable stop the rule may still act on: still the thread's latest
 * run with nothing else going on, still on the instance that failed (a thread
 * moved since is retried where it is instead, see `providerRetryCommand`),
 * recent, and within the hop cap, so a chain of providers that cannot open
 * ends instead of cycling.
 */
export function unopenableStopIsLive(thread: FallbackThread, stop: UnopenableStop, nowMs: number) {
  return (
    openFailureIsIdle(thread, stop) &&
    thread.providerInstanceId === stop.instanceId &&
    nowMs - stop.failedAtMs < LIMIT_STOP_MAX_AGE_MS &&
    stop.nextHop <= LIMIT_FALLBACK_MAX_HOPS
  );
}

/**
 * The `switch` rule's move for a thread whose provider could not open. It
 * answers the original stop: each hop has its own command id, and the
 * selections this stop already tried are skipped. There is no
 * `manualContinuationOfRunId`, since the orchestrator continues only an
 * interrupted or usage-limited run; the new provider picks up the thread's
 * history the way any provider change does.
 */
export function unopenableFallbackCommand(
  thread: FallbackThread,
  providers: ReadonlyArray<ServerProvider>,
  rule: ProviderFallbackRule,
  nowMs: number,
  stop: UnopenableStop,
  options: {
    readonly proven?: ModelSelection | null;
    readonly limited?: ReadonlySet<string> | undefined;
    readonly failed?: ReadonlySet<string> | undefined;
  } = {},
): Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }> | null {
  if (rule.providerLimitAction !== "switch" || !unopenableStopIsLive(thread, stop, nowMs))
    return null;
  const target = resolveProviderFallback({
    providers,
    currentInstanceId: thread.providerInstanceId,
    currentModel: thread.modelSelection.model,
    currentOptions: thread.modelSelection.options,
    rule,
    nowMs,
    belowPercent: rule.providerLimitSwitchAtPercent ?? 100,
    anyReady: true,
    proven: options.proven ?? null,
    // The instance that failed is out, whatever its snapshot still says.
    limitedInstanceIds: new Set([...(options.limited ?? []), stop.instanceId]),
    ...(options.failed === undefined ? {} : { excludedSelections: options.failed }),
    // An overflow says nothing about usage: home goes first when it has
    // room, and only a window that holds the thread is a target.
    ...(stop.cause === "context"
      ? { preferDefault: true, ...(stop.contextFit ? { contextFit: stop.contextFit } : {}) }
      : {}),
  });
  if (target === null) return null;
  // Only a usage-limit stop is `limit-fallback:`: the way back reads that
  // prefix, and must never return a thread to a provider that could not start.
  const prefix = stop.originIsLimit
    ? LIMIT_FALLBACK_MESSAGE_PREFIX
    : PROVIDER_FALLBACK_MESSAGE_PREFIX;
  const id = `${prefix}${thread.id}:${stop.nextHop === 0 ? "" : `hop-${stop.nextHop}:`}${stop.originRunId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(id),
    messageId: MessageId.make(id),
    threadId: thread.id,
    modelSelection: target,
    ...contextStopRequest(stop),
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

/**
 * What a move sends: a context stop resends the request that overflowed, as
 * the context recovery's retry does, since the history the target gets is
 * capped and may leave that request out; any other stop continues.
 */
function contextStopRequest(stop: UnopenableStop) {
  const request = stop.cause === "context" ? stop.request : undefined;
  if (
    request === undefined ||
    (request.text.trim().length === 0 && request.attachments.length === 0)
  )
    return { text: PROVIDER_FALLBACK_CONTINUE_TEXT, attachments: [] };
  return {
    text: request.text,
    attachments: request.attachments,
    ...(request.context === undefined ? {} : { context: request.context }),
  };
}

/**
 * Instances a thread recently failed to open on, each held from the failure
 * until a provider read taken after it shows the instance can take a turn,
 * or `UNOPENABLE_HOLD_MS` passes. Without this another thread stopped on a
 * limit would be routed onto the same broken provider. Folds the stops seen
 * now into `held` and drops holds that ended.
 */
export function unopenableHolds(
  held: ReadonlyMap<string, number>,
  stops: Iterable<UnopenableStop>,
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
): ReadonlyMap<string, number> {
  const next = new Map(held);
  for (const stop of stops)
    // A conversation too large for a model says nothing about the provider.
    if (stop.cause !== "context" && nowMs - stop.failedAtMs < UNOPENABLE_HOLD_MS)
      next.set(stop.instanceId, Math.max(next.get(stop.instanceId) ?? 0, stop.failedAtMs));
  for (const [instanceId, failedAt] of next) {
    const provider = providers.find((entry) => entry.instanceId === instanceId);
    const readAt = Date.parse(provider?.checkedAt ?? "");
    if (
      nowMs - failedAt >= UNOPENABLE_HOLD_MS ||
      (provider !== undefined && readAt > failedAt && canTakeTurn(provider))
    )
      next.delete(instanceId);
  }
  return next;
}

/**
 * One retry of a turn whose provider could not open, once it can: whatever
 * the limit rule, for a thread no fallback moved on (its own provider failed,
 * or a chain ran out of hops). It runs on the thread's selection. When that is
 * still the instance that failed, only a provider read taken after the
 * failure that shows it can take a turn counts; a thread moved since (by a
 * person, or the way back) needs only its provider ready. A retry that fails
 * again is never retried, and its failure continues the chain it retried
 * (see `unopenableStop`), so retries and the hop cap cannot feed each other.
 */
export function providerRetryCommand(
  thread: FallbackThread,
  failed: OpenFailure,
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
): Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }> | null {
  if (providerRetryGate(thread, failed, providers, nowMs) !== "send") return null;
  const id = `${PROVIDER_RETRY_MESSAGE_PREFIX}${thread.id}:${failed.runId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(id),
    messageId: MessageId.make(id),
    threadId: thread.id,
    modelSelection: thread.modelSelection,
    // A server /compact that could not open is retried as the /compact, so
    // the compaction happens before context recovery resends the request.
    text: failed.userMessageId.startsWith(`${CONTEXT_COMPACT_MESSAGE_PREFIX}${thread.id}:`)
      ? "/compact"
      : PROVIDER_FALLBACK_CONTINUE_TEXT,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

/**
 * Whether the retry can go out now (`send`), waits for a read of the instance
 * that failed (`read`: none since the failure, or the last could not take a
 * turn), or is not due.
 */
function providerRetryGate(
  thread: FallbackThread,
  failed: OpenFailure,
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
): "send" | "read" | null {
  if (!openFailureIsIdle(thread, failed)) return null;
  if (failed.userMessageId.startsWith(`${PROVIDER_RETRY_MESSAGE_PREFIX}${thread.id}:`)) return null;
  if (!(nowMs - failed.failedAtMs < PROVIDER_RETRY_MAX_AGE_MS)) return null;
  const selection = thread.modelSelection;
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  if (provider === undefined) return null;
  if (
    selection.instanceId === failed.instanceId &&
    (!(Date.parse(provider.checkedAt) > failed.failedAtMs) || !canTakeTurn(provider))
  )
    return "read";
  return canTakeTurn(provider) ? "send" : null;
}

/**
 * Whether the retry waits for a read of the failed instance that shows it can
 * take a turn. The registry reads providers only while a client is around, so
 * an unattended host (a scheduled run at night) would wait for good without
 * the sweep reading it itself.
 */
export const providerRetryAwaitsRead = (
  thread: FallbackThread,
  failed: OpenFailure,
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
): boolean => providerRetryGate(thread, failed, providers, nowMs) === "read";
