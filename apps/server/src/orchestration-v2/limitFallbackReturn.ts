import {
  CommandId,
  isProviderAvailable,
  MessageId,
  type OrchestrationV2LimitPreswitchOrigin,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
  type ServerProvider,
} from "@specweave-studio/contracts";
import {
  isClaudeApiKeyProvider,
  type ProviderFallbackRule,
  providerUsedPercent,
  usageAtThreshold,
  usageDeniesTurn,
} from "@specweave-studio/shared/providerFallback";
import { preswitchReturnBlock } from "@specweave-studio/shared/preswitchReturn";
import { LIMIT_PRESWITCH_COMMAND_PREFIX } from "@specweave-studio/shared/threadModelIdentity";
import { windowAppliesToModel } from "@specweave-studio/shared/usageWindows";
import { type ApiCreditOrigin, epochMs, LIMIT_STOP_MAX_AGE_MS } from "./providerOpenFailure.ts";
import {
  type FallbackThread,
  PROVIDER_FALLBACK_CONTINUE_TEXT,
  threadIsFree,
} from "./unopenableFallback.ts";

export {
  API_CREDIT_MESSAGE_PREFIX,
  type ApiCreditOrigin,
  apiCreditOrigin,
} from "./providerOpenFailure.ts";

/** The way back from a usage pre-switch: `limit-preswitch-return:<pre-switch key>[:attempt]`. */
export const LIMIT_PRESWITCH_RETURN_PREFIX = "limit-preswitch-return:";

/**
 * The way back's own model switch: from API credits (`limit-api-return:`),
 * from a `switch` fallback (`limit-return:`) and from a usage pre-switch
 * (`limit-preswitch-return:`). It moves the thread with no turn of its own,
 * so the orchestrator moves the queued sends that took the fallback's model
 * along with it.
 */
export function isLimitWayBack(commandId: string): boolean {
  return (
    commandId.startsWith("limit-api-return:") ||
    commandId.startsWith("limit-return:") ||
    commandId.startsWith(LIMIT_PRESWITCH_RETURN_PREFIX)
  );
}

/**
 * A model switch the server makes on its own: the way back, or the usage
 * pre-switch (`limit-preswitch:`) before an idle thread's next turn. These
 * commands carry no creation source, so the id tells them from a pick.
 */
export function isServerSelectionMove(commandId: string): boolean {
  return isLimitWayBack(commandId) || commandId.startsWith("limit-preswitch:");
}

/** With no reset time to wait for, an idle thread leaves API credits after this long. */
export const API_CREDIT_IDLE_RETURN_MS = 15 * 60_000;

/** A failed way back is retried this many times, each under its own command id, then rests. */
export const API_CREDIT_RETURN_ATTEMPTS = 5;
export const API_CREDIT_RETURN_COOLDOWN_MS = 30 * 60_000;

/** The window the switch belongs to, so a thread moves once per usage window. */
export function usageWindowKey(
  provider: ServerProvider | undefined,
  nowMs: number,
  model?: string | null,
): string {
  const used = provider === undefined ? null : providerUsedPercent(provider, nowMs, model);
  const window = provider?.usageLimits?.windows.find(
    (w) => w.usedPercent === used && windowAppliesToModel(w, model),
  );
  return window?.resetsAt ?? "open";
}

/**
 * The real limit window the account is in right now, keyed by its reset
 * time, or null when the account's own usage read shows no limit. A thread
 * can stop with `usage_limit` for other reasons (a simulated stop, a window
 * that has since reset), so anything that costs the account checks this on a
 * fresh read, never the thread's error class.
 */
export function reachedLimitWindow(
  provider: ServerProvider | undefined,
  nowMs: number,
  /** The model the thread runs on: a spent model-scoped window limits only its own models. */
  model?: string | null,
): string | null {
  const limits = provider?.usageLimits;
  if (limits === undefined || limits.unavailable !== undefined) return null;
  const live = limits.windows.filter((window) => {
    const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    return !(Number.isFinite(resetsAt) && resetsAt <= nowMs);
  });
  const full = live.filter(
    (window) => window.usedPercent >= 100 && windowAppliesToModel(window, model),
  );
  if (full.length > 0) {
    const resets = full
      .map((window) => window.resetsAt)
      .filter((at): at is string => at !== undefined);
    return resets.length === 0 ? "open" : resets.sort()[0]!;
  }
  if (limits.ordinaryUsageAllowed === false) return usageWindowKey(provider, nowMs, model);
  return null;
}

/** The latest reset time a stopped run's usage-limit failure named, or null. */
export function limitResetAt(
  runId: OrchestrationV2Run["id"],
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): string | null {
  let latest: string | null = null;
  for (const item of turnItems) {
    if (item.type !== "error" || item.runId !== runId || item.failure.class !== "usage_limit")
      continue;
    const resetAt = item.failure.resetAt ?? null;
    if (resetAt === null || !Number.isFinite(Date.parse(resetAt))) continue;
    if (latest === null || Date.parse(resetAt) > Date.parse(latest)) latest = resetAt;
  }
  return latest;
}

/**
 * Queued runs that would start on `instanceId` and pull a thread the way back
 * moved off it straight back: queued there, or re-pointed there by a server
 * continuation. A held queue waits for a person, so it does not hold the way
 * back: the way back moves held sends that took the fallback's model home
 * with the thread (`isLimitWayBack`), and a held send a person put on that
 * model keeps it. The caller also leaves out deliveries that follow the
 * thread (`followsThreadSelection`), which go back with it.
 */
export function queuedRunsPinnedTo(
  runs: ReadonlyArray<OrchestrationV2Run>,
  instanceId: OrchestrationV2Run["providerInstanceId"],
): ReadonlyArray<OrchestrationV2Run> {
  return runs.filter(
    (run) =>
      run.status === "queued" &&
      run.queueHeld !== true &&
      (run.providerInstanceId === instanceId || run.modelSelection.instanceId === instanceId),
  );
}

/** Background work the provider session hosts; a pull request watch is Studio's own. */
export const hostsBackgroundWork = (thread: FallbackThread): boolean =>
  (thread.pendingBackgroundTasks ?? []).some(
    (task) => !task.taskId.startsWith("pull-request-watch:"),
  );

/**
 * The way back from API credits: an idle thread the rule moved to an API-key
 * instance returns to its subscription before its next turn. It goes back as
 * soon as the rule is off for its project; with the rule on, once the limit
 * that stopped it has reset, or the subscription's own usage read shows no
 * limit. A stop that named no reset time goes back after
 * `API_CREDIT_IDLE_RETURN_MS` idle instead, since the usage read is only
 * taken while someone is looking at it. Never while the thread is working
 * or its session still hosts background work, which a move would orphan.
 * `attempt` numbers the command, because a rejected command id stays
 * rejected.
 */
export function apiCreditReturnCommand(
  thread: FallbackThread,
  origin: ApiCreditOrigin,
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
  options: { readonly ruleOn: boolean; readonly attempt?: number } = { ruleOn: true },
): Extract<OrchestrationV2ServerCommand, { type: "thread.model-selection.set" }> | null {
  if (!threadIsFree(thread)) return null;
  if (thread.settledOverride === "settled") return null;
  if (thread.activityRunStatus != null || hostsBackgroundWork(thread)) return null;
  if (
    !isClaudeApiKeyProvider(
      providers.find((provider) => provider.instanceId === thread.providerInstanceId),
    )
  )
    return null;
  const subscription = providers.find(
    (provider) => provider.instanceId === origin.modelSelection.instanceId,
  );
  // A stale denial of ordinary usage must not strand the thread, so this
  // does not ask `canTakeTurn`; a turn that still hits the limit stops there.
  if (
    subscription === undefined ||
    subscription.driver !== "claudeAgent" ||
    isClaudeApiKeyProvider(subscription) ||
    !subscription.enabled ||
    !subscription.installed ||
    !isProviderAvailable(subscription) ||
    subscription.auth.status === "unauthenticated"
  )
    return null;
  const limits = subscription.usageLimits;
  const readShowsNoLimit =
    limits !== undefined &&
    limits.unavailable === undefined &&
    limits.windows.length > 0 &&
    reachedLimitWindow(subscription, nowMs, origin.modelSelection.model) === null;
  const resetMs = Date.parse(origin.resetAt ?? "");
  const waitedOut = Number.isFinite(resetMs)
    ? resetMs <= nowMs
    : nowMs - epochMs(thread.latestRunCompletedAt) >= API_CREDIT_IDLE_RETURN_MS;
  if (options.ruleOn && !readShowsNoLimit && !waitedOut) return null;
  const attempt = options.attempt ?? 0;
  return {
    type: "thread.model-selection.set",
    commandId: CommandId.make(
      `limit-api-return:${thread.id}:${origin.continuedByRunId}${attempt === 0 ? "" : `:${attempt}`}`,
    ),
    threadId: thread.id,
    modelSelection: origin.modelSelection,
  };
}

/**
 * The way back from a `switch` fallback. The fallback covers the runs the
 * limit stopped, not the thread from then on: once the provider it stopped
 * on reads as having room again (or its reset has passed), the idle thread
 * goes back to the model it ran before the limit. A thread whose latest run
 * on the fallback failed, for whatever reason (a provider that could not
 * open, its own usage limit, an error mid-turn), still has its turn to
 * finish, and nothing else resumes it: it goes back with a continuation,
 * `limit-return:<thread>:<failed run>`. A failure of the fallback move itself
 * answers this stop however long the reset took; a later turn's failure only
 * while it is recent or came before the reset. A thread whose latest run
 * completed only changes model.
 */
export function limitFallbackReturnCommand(
  thread: FallbackThread,
  origin: ApiCreditOrigin,
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
  attempt = 0,
): Extract<
  OrchestrationV2ServerCommand,
  { type: "thread.model-selection.set" | "message.dispatch" }
> | null {
  if (!threadIsFree(thread)) return null;
  if (thread.settledOverride === "settled") return null;
  if (thread.activityRunStatus != null || hostsBackgroundWork(thread)) return null;
  const home = providers.find(
    (provider) => provider.instanceId === origin.modelSelection.instanceId,
  );
  if (
    home === undefined ||
    !home.enabled ||
    !home.installed ||
    !isProviderAvailable(home) ||
    home.auth.status === "unauthenticated"
  )
    return null;
  const limits = home.usageLimits;
  const readShowsNoLimit =
    limits !== undefined &&
    limits.unavailable === undefined &&
    limits.windows.length > 0 &&
    reachedLimitWindow(home, nowMs, origin.modelSelection.model) === null;
  const resetMs = Date.parse(origin.resetAt ?? "");
  if (!readShowsNoLimit && !(Number.isFinite(resetMs) && resetMs <= nowMs)) return null;
  const suffix = attempt === 0 ? "" : `:${attempt}`;
  const failedAtMs = epochMs(thread.latestRunCompletedAt);
  if (
    thread.status === "failed" &&
    thread.latestRunId !== null &&
    (thread.latestRunId === origin.continuedByRunId ||
      nowMs - failedAtMs < LIMIT_STOP_MAX_AGE_MS ||
      (Number.isFinite(resetMs) && failedAtMs < resetMs))
  ) {
    // The orchestrator continues only an interrupted or usage-limited latest
    // run, so anything else is a plain turn; the sweep resends a request
    // never answered.
    const id = `limit-return:${thread.id}:${thread.latestRunId}`;
    return {
      type: "message.dispatch",
      commandId: CommandId.make(`${id}${suffix}`),
      messageId: MessageId.make(id),
      threadId: thread.id,
      ...(thread.lastErrorClass === "usage_limit"
        ? { manualContinuationOfRunId: thread.latestRunId }
        : {}),
      modelSelection: origin.modelSelection,
      text: PROVIDER_FALLBACK_CONTINUE_TEXT,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    };
  }
  return {
    type: "thread.model-selection.set",
    commandId: CommandId.make(`limit-return:${thread.id}:${origin.continuedByRunId}${suffix}`),
    threadId: thread.id,
    modelSelection: origin.modelSelection,
  };
}

export {
  PRESWITCH_RETURN_BLOCK_REASON,
  type PreswitchReturnBlock,
  preswitchReturnBlock,
} from "@specweave-studio/shared/preswitchReturn";

/**
 * The way back from a usage pre-switch (`limit-preswitch:`): the server moved
 * the idle thread off a provider that reached the switch threshold before its
 * next turn, so no stopped run marks the move. Once the original reads below
 * the threshold (below its limit when the rule is no longer `switch`), or the
 * window it moved in has reset, the idle thread goes back with no turn of its
 * own, under `limit-preswitch-return:`, and the queued sends that took the
 * fallback's model go with it. Never while the thread works, waits on a
 * person, hosts background work or holds a failed turn, and never to an
 * origin `preswitchReturnBlock` rules out. A pick after the move clears the
 * origin at write time, so it is never reversed. `attempt` numbers the
 * command, because a rejected command id stays rejected.
 */
export function preswitchReturnCommand(
  thread: FallbackThread,
  origin: OrchestrationV2LimitPreswitchOrigin,
  providers: ReadonlyArray<ServerProvider>,
  rule: Pick<
    ProviderFallbackRule,
    | "providerLimitAction"
    | "providerLimitSwitchAtPercent"
    | "providerLimitWaitUnderMinutes"
    | "providerLimitExcludedModels"
  >,
  nowMs: number,
  attempt = 0,
): Extract<OrchestrationV2ServerCommand, { type: "thread.model-selection.set" }> | null {
  if (!threadIsFree(thread)) return null;
  if (thread.settledOverride === "settled" || thread.status === "failed") return null;
  if (thread.activityRunStatus != null || hostsBackgroundWork(thread)) return null;
  if (!origin.commandId.startsWith(LIMIT_PRESWITCH_COMMAND_PREFIX)) return null;
  if (
    thread.modelSelection.instanceId === origin.modelSelection.instanceId &&
    thread.modelSelection.model === origin.modelSelection.model
  )
    return null;
  if (preswitchReturnBlock(origin, providers, rule) !== null) return null;
  const home = providers.find(
    (provider) => provider.instanceId === origin.modelSelection.instanceId,
  );
  if (
    home === undefined ||
    !home.enabled ||
    !home.installed ||
    !isProviderAvailable(home) ||
    home.auth.status === "unauthenticated"
  )
    return null;
  const model = origin.modelSelection.model;
  const limits = home.usageLimits;
  const read =
    limits !== undefined &&
    limits.unavailable === undefined &&
    limits.windows.length > 0 &&
    providerUsedPercent(home, nowMs, model) !== null;
  // A live reading decides: below the threshold goes back, at it stays, so
  // the next turn does not move straight off again. With no live window (the
  // one it moved in has reset and nothing has read the account since), the
  // reset passing is enough; a stale denial must not strand the thread.
  if (read) {
    if (
      usageDeniesTurn(home) ||
      reachedLimitWindow(home, nowMs, model) !== null ||
      (rule.providerLimitAction === "switch" &&
        usageAtThreshold({ provider: home, model, rule, nowMs }))
    )
      return null;
  } else {
    const resetMs = Date.parse(origin.resetAt ?? "");
    if (!(Number.isFinite(resetMs) && resetMs <= nowMs)) return null;
  }
  const key = origin.commandId.slice(LIMIT_PRESWITCH_COMMAND_PREFIX.length);
  return {
    type: "thread.model-selection.set",
    commandId: CommandId.make(
      `${LIMIT_PRESWITCH_RETURN_PREFIX}${key}${attempt === 0 ? "" : `:${attempt}`}`,
    ),
    threadId: thread.id,
    modelSelection: origin.modelSelection,
  };
}
