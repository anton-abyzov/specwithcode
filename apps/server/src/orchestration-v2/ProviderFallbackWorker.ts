import { stringifyJson } from "../json.ts";
import {
  CommandId,
  isProviderAvailable,
  type ManualCodexCreditIntent,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  ThreadId,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import {
  canTakeTurn,
  FALLBACK_USAGE_MAX_AGE_MS,
  isApiCreditExhaustedMessage,
  isClaudeApiKeyProvider,
  isDirectClaudeApiKeyProvider,
  isPerTokenProvider,
  limitRestartRequest,
  limitStopWaitsForReset,
  provenFallbackSelection,
  providerUsedPercent,
  type ProviderFallbackRule,
  reportsNoUsage,
  resolveApiCreditSelection,
  resolveProviderFallback,
  shouldSwitchBeforeTurn,
} from "@specweave-studio/shared/providerFallback";
import { windowAppliesToModel } from "@specweave-studio/shared/usageWindows";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ProviderInstances from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { projectCompatibleProviders } from "../project/ProjectProviderCompatibility.ts";
import * as Projects from "../project/ProjectService.ts";
import { SIMULATED_USAGE_LIMIT_MESSAGE, simulatedUsageLimitInstances } from "./ProviderFailure.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { recoverySnoozeBlocks } from "./usageLimitRecovery.ts";

/** The shell snapshot is not free; the scheduler ticks every five seconds. */
export const PROVIDER_FALLBACK_SWEEP_INTERVAL_MS = 30_000;

export const PROVIDER_FALLBACK_CONTINUE_TEXT = "Continue where you left off.";

type FallbackThread = Pick<
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
      | "latestRunCompletedAt"
      | "activityRunStatus"
      | "pendingBackgroundTasks"
      | "snoozedUntil"
      | "limitRecovery"
      | "worktreePath"
      | "runtimeMode"
      | "interactionMode"
    >
  >;

/** A stop with no reset time counts as a live limit for one session window. */
export const LIMIT_STOP_MAX_AGE_MS = 5 * 60 * 60_000;

/** With no reset time to wait for, an idle thread leaves API credits after this long. */
export const API_CREDIT_IDLE_RETURN_MS = 15 * 60_000;

/** A failed way back is retried this many times, each under its own command id, then rests. */
const API_CREDIT_RETURN_ATTEMPTS = 5;
const API_CREDIT_RETURN_COOLDOWN_MS = 30 * 60_000;

/** A usage read that failed is tried again on this many sweeps before the stop is left alone. */
const LIMIT_READ_ATTEMPTS = 3;

const epochMs = (at: DateTime.Utc | null | undefined): number =>
  at == null ? Number.NaN : DateTime.toEpochMillis(at);

/**
 * Whether a usage-limit stop still describes the account: its reset time is
 * ahead, or, when the provider named none, the run stopped within one
 * session window. An old stop says nothing about usage now.
 */
export function limitStopIsCurrent(thread: FallbackThread, nowMs: number): boolean {
  const resetMs = Date.parse(thread.usageLimitResetAt ?? "");
  if (Number.isFinite(resetMs)) return resetMs > nowMs;
  const stoppedMs = epochMs(thread.latestRunCompletedAt);
  return Number.isFinite(stoppedMs) && nowMs - stoppedMs < LIMIT_STOP_MAX_AGE_MS;
}

/** The stop came from `STUDIO_SIMULATE_USAGE_LIMIT`, whether or not it is still set. */
const simulatedStop = (thread: FallbackThread): boolean =>
  thread.lastError === SIMULATED_USAGE_LIMIT_MESSAGE;

/** The process environment the sweep reads `STUDIO_SIMULATE_USAGE_LIMIT` from. */
export const ProviderFallbackEnv = Context.Reference<Readonly<Record<string, string | undefined>>>(
  "@specweave-studio/server/orchestration-v2/ProviderFallbackWorker/Env",
  { defaultValue: () => process.env },
);

/** The window the switch belongs to, so a thread moves once per usage window. */
function usageWindowKey(
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

/**
 * What the `switch` rule does for one thread, or null. A turn that stopped on
 * the usage limit continues on the fallback (a manual continuation, so the
 * handoff carries the stopped run). An idle thread whose provider has reached
 * the threshold moves to the fallback before its next turn. Never mid-turn.
 */
export function providerFallbackCommand(
  thread: FallbackThread,
  providers: ReadonlyArray<ServerProvider>,
  rule: ProviderFallbackRule,
  nowMs: number,
  /** The project coordinator's working model (see provenFallbackSelection). */
  proven: ModelSelection | null = null,
  /** Providers reporting no usage whose threads stopped on a limit (see `unreportedLimitStops`). */
  limited?: ReadonlySet<string>,
): OrchestrationV2ServerCommand | null {
  if (rule.providerLimitAction !== "switch") return null;
  if (thread.activeRunId !== null || thread.pendingRuntimeRequest !== null) return null;
  if (thread.settledOverride === "settled" || thread.latestRunId === null) return null;
  const current = providers.find((provider) => provider.instanceId === thread.providerInstanceId);
  if (thread.status === "failed" && thread.lastErrorClass === "usage_limit") {
    if (waitsForReset(thread, rule, nowMs)) return null;
    const target = resolveProviderFallback({
      providers,
      currentInstanceId: thread.providerInstanceId,
      currentModel: thread.modelSelection.model,
      rule,
      nowMs,
      belowPercent: rule.providerLimitSwitchAtPercent ?? 100,
      anyReady: true,
      proven,
      ...(limited === undefined ? {} : { limitedInstanceIds: limited }),
    });
    if (target === null) return null;
    const identity = `${thread.id}:${thread.latestRunId}`;
    return {
      type: "message.dispatch",
      commandId: CommandId.make(`limit-fallback:${identity}`),
      messageId: MessageId.make(`${LIMIT_FALLBACK_MESSAGE_PREFIX}${identity}`),
      threadId: thread.id,
      manualContinuationOfRunId: thread.latestRunId,
      modelSelection: target,
      text: PROVIDER_FALLBACK_CONTINUE_TEXT,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    };
  }
  if (
    !shouldSwitchBeforeTurn({
      provider: current,
      model: thread.modelSelection.model,
      rule,
      nowMs,
    })
  )
    return null;
  const target = resolveProviderFallback({
    providers,
    currentInstanceId: thread.providerInstanceId,
    currentModel: thread.modelSelection.model,
    rule,
    nowMs,
    belowPercent: rule.providerLimitSwitchAtPercent,
    anyReady: true,
    proven,
    ...(limited === undefined ? {} : { limitedInstanceIds: limited }),
  });
  if (target === null) return null;
  return {
    type: "thread.model-selection.set",
    commandId: CommandId.make(
      `limit-preswitch:${thread.id}:${thread.providerInstanceId}:${usageWindowKey(current, nowMs, thread.modelSelection.model)}`,
    ),
    threadId: thread.id,
    modelSelection: target,
  };
}

/**
 * The stop resets within the project's wait: nothing switches, redeems or
 * spends, and the resume at the reset continues on the same provider.
 */
function waitsForReset(thread: FallbackThread, rule: ProviderFallbackRule, nowMs: number): boolean {
  return limitStopWaitsForReset({
    resetAt: thread.usageLimitResetAt,
    waitUnderMinutes: rule.providerLimitWaitUnderMinutes,
    nowMs,
  });
}

/** A turn that stopped on the limit, with nothing else going on in the thread. */
function stoppedOnLimit(
  thread: FallbackThread,
): thread is FallbackThread & { latestRunId: string } {
  return (
    thread.status === "failed" &&
    thread.lastErrorClass === "usage_limit" &&
    thread.activeRunId === null &&
    thread.pendingRuntimeRequest === null &&
    thread.settledOverride !== "settled" &&
    thread.latestRunId !== null
  );
}

/**
 * Providers that report no usage (GitHub Copilot) but have a thread stopped
 * on their limit, each held until that stop's reset, or for as long as an
 * unknown reset counts as current. Nothing else tells the sweep they are
 * full, so without this a thread moved off one would be moved back onto it.
 * Folds the threads seen now into `held` and drops holds that ended.
 */
export function unreportedLimitStops(
  held: ReadonlyMap<string, number>,
  threads: ReadonlyArray<FallbackThread>,
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
): ReadonlyMap<string, number> {
  const next = new Map(held);
  for (const thread of threads) {
    if (!stoppedOnLimit(thread) || !limitStopIsCurrent(thread, nowMs)) continue;
    const provider = providers.find((entry) => entry.instanceId === thread.providerInstanceId);
    if (provider === undefined || !reportsNoUsage(provider)) continue;
    const resetMs = Date.parse(thread.usageLimitResetAt ?? "");
    const until = Number.isFinite(resetMs)
      ? resetMs
      : epochMs(thread.latestRunCompletedAt) + LIMIT_STOP_MAX_AGE_MS;
    next.set(provider.instanceId, Math.max(next.get(provider.instanceId) ?? 0, until));
  }
  for (const [instanceId, until] of next) if (until <= nowMs) next.delete(instanceId);
  return next;
}

/** The message id prefix of a continuation the API-credit rule sent; the way back reads it. */
const API_CREDIT_MESSAGE_PREFIX = "limit-api:";

/**
 * Continue the stopped run on the provider it stopped on, or, for `api`, on
 * the model selection the caller sets.
 */
function sameProviderContinuation(
  thread: FallbackThread & { latestRunId: string },
  kind: "reset" | "credits" | "api",
  intent?: ManualCodexCreditIntent,
): Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }> {
  const identity = `limit-${kind}:${thread.id}:${thread.latestRunId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(identity),
    messageId: MessageId.make(identity),
    threadId: thread.id,
    manualContinuationOfRunId: thread.latestRunId,
    modelSelection: thread.modelSelection,
    text: PROVIDER_FALLBACK_CONTINUE_TEXT,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
    ...(intent === undefined ? {} : { manualCodexCreditIntent: intent }),
  };
}

const CODEX_POOL = /^codex:sha256:[a-f0-9]{64}$/;
const POSITIVE_BALANCE = /^\d{1,24}(?:\.\d{1,24})?$/;

/**
 * What a project rule does with a turn that stopped on the usage limit,
 * before (or instead of) a provider switch:
 *
 * 1. `redeem-reset`: the account has a banked reset and the rule redeems
 *    them. The sweep claims one and, if it reset the limit, continues on
 *    the same provider.
 * 2. `spend-credits`: a Codex account with paid credits and the rule allows
 *    spending them. The continuation carries a one-run credit intent; the
 *    adapter re-reads the account before the turn and refuses if anything
 *    changed, as it does for a human credit submission.
 * 3. `api-credits`: a Claude subscription thread, a Claude instance with
 *    its own Anthropic API key that lists the thread's model, and the rule
 *    allows API credits. The stop must be current (see `limitStopIsCurrent`)
 *    and the thread not snoozed, other than by "Snooze limited threads". The
 *    sweep re-reads the subscription and,
 *    if it is at its limit, continues the stopped run on the API-key
 *    instance, which resumes the same session. A thread on an API-key
 *    instance whose account ran out of credits (`rotate`) moves on to the
 *    next API-key instance the same way; the API's refusal is the proof
 *    there, since a key has no usage read.
 * 4. `switch`: the existing fallback, under the `switch` rule.
 *
 * Nothing happens under `wait`, nor while the stop resets within the
 * project's wait (`providerLimitWaitUnderMinutes`): the thread waits for the
 * reset and the recovery worker resumes it. `resetAttempted` skips step 1 once this run
 * tried it, so a reset that did not clear the limit falls through; the
 * sweep also sets it while usage limits are simulated. `apiCreditsAttempted`
 * does the same for step 3. `simulated` skips steps 2 and 3 as well, and a
 * stop that carries the simulated-limit message skips all three: a
 * simulated stop never redeems or spends anything.
 */
export function providerLimitStep(
  thread: FallbackThread,
  providers: ReadonlyArray<ServerProvider>,
  rule: ProviderFallbackRule & { readonly snoozeLimitedThreads?: boolean },
  nowMs: number,
  options: {
    readonly resetAttempted: boolean;
    readonly apiCreditsAttempted?: boolean;
    readonly simulated?: boolean;
    /** The project coordinator's working model, a fallback with no usage read needed. */
    readonly proven?: ModelSelection | null;
    /** Providers reporting no usage that a current stop shows are limited. */
    readonly limited?: ReadonlySet<string>;
  },
):
  | {
      readonly type: "redeem-reset";
      readonly instanceId: ProviderInstanceId;
      readonly continuation: OrchestrationV2ServerCommand;
    }
  | { readonly type: "spend-credits"; readonly command: OrchestrationV2ServerCommand }
  | {
      readonly type: "api-credits";
      readonly instanceId: ProviderInstanceId;
      readonly rotate: boolean;
      readonly command: OrchestrationV2ServerCommand;
    }
  | { readonly type: "switch"; readonly command: OrchestrationV2ServerCommand }
  | null {
  if (rule.providerLimitAction === "wait" || !stoppedOnLimit(thread)) return null;
  if (waitsForReset(thread, rule, nowMs)) return null;
  const current = providers.find((provider) => provider.instanceId === thread.providerInstanceId);
  const limits = current?.usageLimits;
  const simulated = options.simulated === true || simulatedStop(thread);
  if (
    rule.providerLimitRedeemResets === true &&
    !options.resetAttempted &&
    !simulatedStop(thread) &&
    current !== undefined &&
    (limits?.resetCredits?.availableCount ?? 0) > 0
  ) {
    return {
      type: "redeem-reset",
      instanceId: current.instanceId,
      continuation: sameProviderContinuation(thread, "reset"),
    };
  }
  if (
    rule.providerLimitSpendCredits === true &&
    !simulated &&
    current?.driver === "codex" &&
    limits !== undefined &&
    !limits.unavailable &&
    limits.spendControlReached !== true &&
    (limits.rateLimitReachedType == null || limits.rateLimitReachedType === "rate_limit_reached") &&
    limits.credits?.hasCredits === true &&
    (limits.credits.unlimited ||
      (typeof limits.credits.balance === "string" &&
        POSITIVE_BALANCE.test(limits.credits.balance) &&
        /[1-9]/.test(limits.credits.balance))) &&
    CODEX_POOL.test(limits.quotaPoolId ?? "")
  ) {
    return {
      type: "spend-credits",
      command: sameProviderContinuation(thread, "credits", {
        type: "project-rule-existing-credits",
        instanceId: current.instanceId,
        model: thread.modelSelection.model,
        expectedQuotaPoolId: limits.quotaPoolId!,
        observedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      }),
    };
  }
  const rotate =
    isDirectClaudeApiKeyProvider(current) && isApiCreditExhaustedMessage(thread.lastError);
  const apiCredits =
    rule.providerLimitUseApiCredits === true &&
    !simulated &&
    options.apiCreditsAttempted !== true &&
    current !== undefined &&
    limitStopIsCurrent(thread, nowMs) &&
    // A snooze holds. The one "Snooze limited threads" sets on every stop
    // looks the same as a person's "Snooze until reset", so it is set aside
    // only where that setting is on: it does not outrank this rule.
    !recoverySnoozeBlocks(
      { snoozedUntil: thread.snoozedUntil ?? null, limitRecovery: thread.limitRecovery ?? null },
      nowMs,
      rule.snoozeLimitedThreads === true,
    )
      ? resolveApiCreditSelection({ providers, current: thread.modelSelection, rotate })
      : null;
  if (apiCredits !== null && current !== undefined) {
    return {
      type: "api-credits",
      instanceId: current.instanceId,
      rotate,
      command: { ...sameProviderContinuation(thread, "api"), modelSelection: apiCredits },
    };
  }
  const command = providerFallbackCommand(
    thread,
    providers,
    rule,
    nowMs,
    options.proven ?? null,
    options.limited,
  );
  return command === null ? null : { type: "switch", command };
}

/** The subscription run the API-credit rule continued, and the run that continued it. */
export interface ApiCreditOrigin {
  readonly stoppedRunId: OrchestrationV2Run["id"];
  readonly continuedByRunId: OrchestrationV2Run["id"];
  readonly modelSelection: ModelSelection;
  /** When the stopped run's limit resets, if the provider said. */
  readonly resetAt: string | null;
}

/**
 * Where a thread running on an API-key instance came from, when the
 * API-credit rule put it there and it has run nowhere else since. Null for a
 * thread a person moved there, which stays where they put it.
 */
export function apiCreditOrigin(
  thread: Pick<FallbackThread, "id" | "providerInstanceId">,
  runs: ReadonlyArray<
    Pick<
      OrchestrationV2Run,
      "id" | "ordinal" | "providerInstanceId" | "modelSelection" | "userMessageId"
    >
  >,
  messagePrefix: string = API_CREDIT_MESSAGE_PREFIX,
  depth = 0,
): ApiCreditOrigin | null {
  const prefix = `${messagePrefix}${thread.id}:`;
  const latestFirst = runs.toSorted((a, b) => b.ordinal - a.ordinal);
  for (const run of latestFirst) {
    if (run.providerInstanceId !== thread.providerInstanceId) return null;
    if (!run.userMessageId.startsWith(prefix)) continue;
    // A continuation that itself stopped and was continued again leads back
    // through each one to the subscription run the first of them continued.
    let stopped = runs.find((candidate) => candidate.id === run.userMessageId.slice(prefix.length));
    const seen = new Set<string>();
    while (
      stopped !== undefined &&
      stopped.providerInstanceId === thread.providerInstanceId &&
      stopped.userMessageId.startsWith(prefix) &&
      !seen.has(stopped.id)
    ) {
      seen.add(stopped.id);
      const earlier = stopped.userMessageId.slice(prefix.length);
      stopped = runs.find((candidate) => candidate.id === earlier);
    }
    if (stopped === undefined || stopped.providerInstanceId === thread.providerInstanceId)
      return null;
    // The stopped run can itself be on an API account the rule moved the
    // thread to before that account ran out of credits: the way back leads
    // on to the subscription that one came from.
    const ordinal = stopped.ordinal;
    const earlier =
      messagePrefix === API_CREDIT_MESSAGE_PREFIX && depth < 8
        ? apiCreditOrigin(
            { id: thread.id, providerInstanceId: stopped.providerInstanceId },
            runs.filter((candidate) => candidate.ordinal <= ordinal),
            messagePrefix,
            depth + 1,
          )
        : null;
    return earlier !== null
      ? { ...earlier, continuedByRunId: run.id }
      : {
          stoppedRunId: stopped.id,
          continuedByRunId: run.id,
          modelSelection: stopped.modelSelection,
          resetAt: null,
        };
  }
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

/** Background work the provider session hosts; a pull request watch is Studio's own. */
const hostsBackgroundWork = (thread: FallbackThread): boolean =>
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
  if (thread.activeRunId !== null || thread.pendingRuntimeRequest !== null) return null;
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

/** The message id prefix of the continuation the `switch` rule sent on a usage-limit stop. */
export const LIMIT_FALLBACK_MESSAGE_PREFIX = "limit-fallback:";

/**
 * The way back from a `switch` fallback. The fallback covers the runs the
 * limit stopped, not the thread from then on: once the provider it stopped
 * on reads as having room again (or its reset has passed), the idle thread
 * goes back to the model it ran before the limit.
 */
export function limitFallbackReturnCommand(
  thread: FallbackThread,
  origin: ApiCreditOrigin,
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
  attempt = 0,
): Extract<OrchestrationV2ServerCommand, { type: "thread.model-selection.set" }> | null {
  if (thread.activeRunId !== null || thread.pendingRuntimeRequest !== null) return null;
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
  return {
    type: "thread.model-selection.set",
    commandId: CommandId.make(
      `limit-return:${thread.id}:${origin.continuedByRunId}${attempt === 0 ? "" : `:${attempt}`}`,
    ),
    threadId: thread.id,
    modelSelection: origin.modelSelection,
  };
}

function anyLimitRule(settings: ServerSettingsValue): boolean {
  const active = (rule: {
    readonly providerLimitAction?: string;
    readonly providerLimitRedeemResets?: boolean;
    readonly providerLimitSpendCredits?: boolean;
    readonly providerLimitUseApiCredits?: boolean;
  }) =>
    rule.providerLimitAction === "switch" ||
    rule.providerLimitRedeemResets === true ||
    rule.providerLimitSpendCredits === true ||
    rule.providerLimitUseApiCredits === true;
  return active(settings) || Object.values(settings.projectSettingsOverrides).some(active);
}

export const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const instances = yield* ProviderInstances.ProviderInstanceRegistry;
  const projects = yield* Projects.ProjectService;
  const env = yield* ProviderFallbackEnv;
  const lastRunAt = yield* Ref.make(0);
  // A user who switches back keeps their choice: each command is sent once.
  const sent = yield* Ref.make(new Set<string>());
  const markSent = (id: string) => Ref.update(sent, (current) => new Set(current).add(id));
  const skipReset = (thread: FallbackThread, instanceId: ProviderInstanceId, reason: string) =>
    Effect.logInfo("orchestration-v2.provider-fallback.reset-skipped", {
      threadId: thread.id,
      instanceId,
      reason,
    }).pipe(Effect.as(false));
  // What the account reports now, read once per instance and sweep. The
  // published limits will not do: they keep a denial, under its old time,
  // through a read that still shows the limit and through one that failed
  // alike. So the driver is asked for the read itself, and only one taken in
  // this sweep counts. A driver without that (Codex, whose reads replace
  // what was published) is refreshed past its cache instead.
  type Reads = Map<ProviderInstanceId, ServerProvider | undefined>;
  const freshRead = Effect.fn("ProviderFallbackWorker.freshRead")(function* (
    instanceId: ProviderInstanceId,
    nowMs: number,
    reads: Reads,
  ) {
    if (reads.has(instanceId)) return reads.get(instanceId);
    const read = yield* Effect.gen(function* () {
      const instance = yield* instances.getInstance(instanceId);
      const own = instance?.readUsageLimitsNow;
      const probed = own === undefined ? undefined : yield* own;
      if (own === undefined) yield* instance?.invalidateCaches ?? Effect.void;
      // The driver's own read is not published again: one account read per sweep is enough.
      const published = (
        own === undefined
          ? yield* registry.refreshInstance(instanceId)
          : yield* registry.getProviders
      ).find((provider) => provider.instanceId === instanceId);
      const limits = own === undefined ? published?.usageLimits : probed;
      return published !== undefined &&
        limits !== undefined &&
        limits.unavailable === undefined &&
        Date.parse(limits.checkedAt) >= nowMs - 1_000
        ? { ...published, usageLimits: limits }
        : undefined;
    }).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
    reads.set(instanceId, read);
    return read;
  });
  // A banked reset is gone once redeemed, so the claim is made only against
  // a fresh usage read that shows the account at its limit, and only once per
  // limit window: a stopped run is not proof of a limit, and a retry of the
  // same window must not burn a second reset.
  const redeemReset = Effect.fn("ProviderFallbackWorker.redeemReset")(function* (
    thread: FallbackThread,
    instanceId: ProviderInstanceId,
    nowMs: number,
    reads: Reads,
  ) {
    const fresh = yield* freshRead(instanceId, nowMs, reads);
    if (fresh === undefined)
      return yield* skipReset(thread, instanceId, "unread").pipe(Effect.as("unread" as const));
    const window = reachedLimitWindow(fresh, nowMs, thread.modelSelection.model);
    if (window === null) return yield* skipReset(thread, instanceId, "not-limited");
    // The step is only taken for an account that showed a banked reset, so a
    // read without the count is one whose reset lookup failed, not an answer.
    const banked = fresh.usageLimits?.resetCredits;
    if (banked === undefined)
      return yield* skipReset(thread, instanceId, "resets-unread").pipe(
        Effect.as("unread" as const),
      );
    if (banked.availableCount < 1) return yield* skipReset(thread, instanceId, "no-banked-reset");
    const windowKey = `limit-reset-window:${instanceId}:${window}`;
    if ((yield* Ref.get(sent)).has(windowKey))
      return yield* skipReset(thread, instanceId, "window-claimed");
    const instance = yield* instances.getInstance(instanceId);
    if (instance?.consumeResetCredit === undefined || !instance.enabled)
      return yield* skipReset(thread, instanceId, "no-reset-support");
    yield* markSent(windowKey);
    // Whatever the claim does, this sweep's read no longer describes the account.
    reads.delete(instanceId);
    const outcome = yield* instance.consumeResetCredit().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration-v2.provider-fallback.reset-failed", {
          threadId: thread.id,
          instanceId,
          cause,
        }).pipe(Effect.as("failed" as const)),
      ),
    );
    yield* Effect.logInfo("orchestration-v2.provider-fallback.reset-redeemed", {
      threadId: thread.id,
      instanceId,
      window,
      outcome,
    });
    return outcome === "reset" || outcome === "nothingToReset";
  });
  // API credits cost money per turn, so the move is made only against a fresh
  // usage read that shows the subscription at its limit, like a reset.
  const confirmLimit = Effect.fn("ProviderFallbackWorker.confirmLimit")(function* (
    thread: FallbackThread,
    instanceId: ProviderInstanceId,
    nowMs: number,
    reads: Reads,
  ) {
    const fresh = yield* freshRead(instanceId, nowMs, reads);
    const outcome =
      fresh === undefined
        ? "unread"
        : reachedLimitWindow(fresh, nowMs, thread.modelSelection.model) !== null
          ? "limited"
          : "not-limited";
    if (outcome !== "limited")
      yield* Effect.logInfo("orchestration-v2.provider-fallback.api-credits-skipped", {
        threadId: thread.id,
        instanceId,
        reason: outcome,
      });
    return outcome;
  });
  const readAttempts = yield* Ref.make(new Map<string, number>());
  const unreadAgain = (key: string) =>
    Ref.updateAndGet(readAttempts, (current) =>
      new Map(current).set(key, (current.get(key) ?? 0) + 1),
    ).pipe(Effect.map((attempts) => attempts.get(key) ?? 0));
  // The sweep works from one snapshot and a usage read takes seconds, so a
  // step that costs something is checked against the thread as it is now:
  // snoozed, settled, moved or resumed since, and it no longer applies.
  const stillApplies = Effect.fn("ProviderFallbackWorker.stillApplies")(function* (
    thread: FallbackThread,
    step: NonNullable<ReturnType<typeof providerLimitStep>>,
    again: (current: FallbackThread) => ReturnType<typeof providerLimitStep>,
  ) {
    const current = yield* projections
      .getThreadShell(thread.id)
      .pipe(Effect.orElseSucceed(() => null));
    const next = current === null ? null : again(current);
    const command = (of: NonNullable<typeof next>) =>
      of.type === "redeem-reset" ? of.continuation : of.command;
    if (
      next !== null &&
      next.type === step.type &&
      stringifyJson(command(next)) === stringifyJson(command(step))
    )
      return true;
    yield* Effect.logInfo("orchestration-v2.provider-fallback.step-outdated", {
      threadId: thread.id,
      step: step.type,
    });
    return false;
  });
  // Runs are read once per thread, latest run and instance; the rest repeats each sweep.
  const origins = yield* Ref.make(new Map<string, ApiCreditOrigin | null>());
  const returnTries = yield* Ref.make(
    new Map<
      string,
      { readonly next: number; readonly failures: number; readonly lastFailureAt: number }
    >(),
  );
  const apiCreditReturn = Effect.fn("ProviderFallbackWorker.apiCreditReturn")(function* (
    thread: FallbackThread,
    providers: ReadonlyArray<ServerProvider>,
    nowMs: number,
    ruleOn: boolean,
  ) {
    if (thread.latestRunId === null) return null;
    // On an API-key instance the API-credit rule put it there; anywhere else,
    // the `switch` rule may have.
    const apiCredits = isClaudeApiKeyProvider(
      providers.find((provider) => provider.instanceId === thread.providerInstanceId),
    );
    const returnCommand = (current: FallbackThread, found: ApiCreditOrigin, attempt: number) =>
      apiCredits
        ? apiCreditReturnCommand(current, found, providers, nowMs, { ruleOn, attempt })
        : limitFallbackReturnCommand(current, found, providers, nowMs, attempt);
    const key = `${thread.id}:${thread.latestRunId}:${thread.providerInstanceId}`;
    let origin = (yield* Ref.get(origins)).get(key);
    if (origin === undefined) {
      const records = yield* projections
        .getThreadRecords(thread.id, ["runs"])
        .pipe(Effect.orElseSucceed(() => null));
      if (records === null) return null;
      const found = apiCreditOrigin(
        thread,
        records.runs,
        apiCredits ? API_CREDIT_MESSAGE_PREFIX : LIMIT_FALLBACK_MESSAGE_PREFIX,
      );
      if (found === null) origin = null;
      else {
        const stopped = yield* projections
          .getThreadRecords(thread.id, ["turnItems"], { turnItemRunIds: [found.stoppedRunId] })
          .pipe(Effect.orElseSucceed(() => null));
        if (stopped === null) return null;
        origin = { ...found, resetAt: limitResetAt(found.stoppedRunId, stopped.turnItems) };
      }
      const cached = origin;
      yield* Ref.update(origins, (current) => new Map(current).set(key, cached));
    }
    if (origin === null) return null;
    const attemptKey = `${thread.id}:${origin.continuedByRunId}`;
    if ((yield* Ref.get(sent)).has(`limit-api-returned:${attemptKey}`)) return null;
    const tries = (yield* Ref.get(returnTries)).get(attemptKey) ?? {
      next: 0,
      failures: 0,
      lastFailureAt: 0,
    };
    if (
      tries.failures >= API_CREDIT_RETURN_ATTEMPTS &&
      nowMs - tries.lastFailureAt < API_CREDIT_RETURN_COOLDOWN_MS
    )
      return null;
    const command = returnCommand(thread, origin, tries.next);
    if (command === null) return null;
    // Checked against the thread as it is now: a turn may have started since the snapshot.
    const current = yield* projections
      .getThreadShell(thread.id)
      .pipe(Effect.orElseSucceed(() => null));
    if (
      current === null ||
      current.latestRunId !== thread.latestRunId ||
      current.providerInstanceId !== thread.providerInstanceId ||
      returnCommand(current, origin, tries.next) === null
    )
      return null;
    // A queued message keeps the instance it was queued on and would pull the
    // thread straight back, so the thread goes back after the queue has run.
    const queued = yield* projections.getThreadRecords(thread.id, ["runs"]).pipe(
      Effect.map((records) =>
        records.runs.some(
          (run) => run.status === "queued" && run.providerInstanceId === thread.providerInstanceId,
        ),
      ),
      Effect.orElseSucceed(() => true),
    );
    if (queued) return null;
    return { command, attemptKey, tries };
  });
  // A replayed id the orchestrator already rejected says nothing new, so it
  // only moves on to the next id; anything else counts toward the rest.
  const returnFailed = (
    attemptKey: string,
    tries: { next: number; failures: number; lastFailureAt: number },
    cause: Cause.Cause<unknown>,
    nowMs: number,
  ) => {
    const error = Cause.squash(cause);
    const replay =
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "OrchestratorCommandPreviouslyRejectedError";
    const rested = nowMs - tries.lastFailureAt >= API_CREDIT_RETURN_COOLDOWN_MS;
    return Ref.update(returnTries, (current) =>
      new Map(current).set(
        attemptKey,
        replay
          ? { ...tries, next: tries.next + 1 }
          : {
              next: tries.next + 1,
              failures: (rested ? 0 : tries.failures) + 1,
              lastFailureAt: nowMs,
            },
      ),
    );
  };
  // A fallback needs a recent usage read of the provider it moves to, and an
  // idle host stops reading providers nobody uses. A current stop the
  // `switch` rule would move, but that finds no target, reads the signed-in
  // providers it could move to; without this the thread waits for the reset
  // with another provider sitting free. Each provider at most once per read
  // lifetime, so a stop nothing can take costs one read, not one per sweep.
  const targetReads = yield* Ref.make(new Map<ProviderInstanceId, number>());
  const unreportedStops = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const refreshStaleTargets = Effect.fn("ProviderFallbackWorker.refreshStaleTargets")(function* (
    thread: FallbackThread,
    candidates: ReadonlyArray<ServerProvider>,
    rule: ProviderFallbackRule,
    nowMs: number,
  ) {
    if (
      rule.providerLimitAction !== "switch" ||
      !stoppedOnLimit(thread) ||
      waitsForReset(thread, rule, nowMs) ||
      !limitStopIsCurrent(thread, nowMs)
    )
      return false;
    const readAt = yield* Ref.get(targetReads);
    const stale = candidates.filter((provider) => {
      if (
        provider.instanceId === thread.providerInstanceId ||
        !canTakeTurn(provider) ||
        provider.auth.status !== "authenticated" ||
        isPerTokenProvider(provider) ||
        provider.usageLimits?.unavailable !== undefined ||
        reportsNoUsage(provider) ||
        nowMs - (readAt.get(provider.instanceId) ?? -Infinity) < FALLBACK_USAGE_MAX_AGE_MS
      )
        return false;
      const limits = provider.usageLimits;
      const observedAt = Date.parse(limits?.nativeAllowanceObservedAt ?? limits?.checkedAt ?? "");
      return !Number.isFinite(observedAt) || nowMs - observedAt > FALLBACK_USAGE_MAX_AGE_MS;
    });
    if (stale.length === 0) return false;
    yield* Ref.update(targetReads, (current) => {
      const next = new Map(current);
      for (const provider of stale) next.set(provider.instanceId, nowMs);
      return next;
    });
    yield* Effect.forEach(
      stale,
      (provider) =>
        registry.refreshInstance(provider.instanceId).pipe(
          Effect.timeoutOption("60 seconds"),
          Effect.catchCause(() => Effect.void),
        ),
      { concurrency: "unbounded", discard: true },
    );
    yield* Effect.logInfo("orchestration-v2.provider-fallback.targets-read", {
      threadId: thread.id,
      instanceIds: stale.map((provider) => provider.instanceId),
    });
    return true;
  });
  return Effect.fn("ProviderFallbackWorker.sweep")(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (now - (yield* Ref.get(lastRunAt)) < PROVIDER_FALLBACK_SWEEP_INTERVAL_MS) return;
    yield* Ref.set(lastRunAt, now);
    const preferences = yield* settings.getSettings;
    let providers = yield* registry.getProviders;
    // The way back does not depend on a rule: a thread the rule moved must
    // not keep spending after the rule is turned off.
    if (!anyLimitRule(preferences) && !providers.some(isClaudeApiKeyProvider)) return;
    // Simulated limits test the banner and the switch; they never redeem or spend.
    const simulated = simulatedUsageLimitInstances(env).length > 0;
    const snapshot = yield* projections.getShellSnapshot({ unsettledOnly: true });
    const held = unreportedLimitStops(
      yield* Ref.get(unreportedStops),
      snapshot.threads,
      providers,
      now,
    );
    yield* Ref.set(unreportedStops, held);
    const limited: ReadonlySet<string> = new Set(held.keys());
    const reads: Reads = new Map();
    // Many threads share a project: read each one once per sweep, not per thread.
    const projectsById = new Map<string, Effect.Success<ReturnType<typeof projects.getById>>>();
    // A stopped worker may continue where its coordinator runs (see provenFallbackSelection).
    const coordinators = new Map<string, OrchestrationV2ThreadShell | null>();
    const coordinatorOf = (coordinatorThreadId: string | null | undefined) =>
      Effect.gen(function* () {
        if (!coordinatorThreadId) return null;
        const cached = coordinators.get(coordinatorThreadId);
        if (cached !== undefined) return cached;
        const shell =
          snapshot.threads.find((candidate) => candidate.id === coordinatorThreadId) ??
          (yield* projections
            .getThreadShell(ThreadId.make(coordinatorThreadId))
            .pipe(Effect.orElseSucceed(() => null)));
        coordinators.set(coordinatorThreadId, shell);
        return shell;
      });
    for (const thread of snapshot.threads) {
      let found = projectsById.get(thread.projectId);
      if (found === undefined) {
        found = yield* projects
          .getById(thread.projectId)
          .pipe(Effect.catchCause(() => Effect.succeedNone));
        projectsById.set(thread.projectId, found);
      }
      // Unknown project grants cannot authorize an automatic provider switch.
      if (Option.isNone(found)) continue;
      const project = found.value;
      const providersFor = (current: FallbackThread) =>
        projectCompatibleProviders({
          project,
          providers,
          cwd: current.worktreePath ?? project?.workspaceRoot,
          ...(current.runtimeMode === undefined || current.interactionMode === undefined
            ? {}
            : {
                runtimePolicy: {
                  runtimeMode: current.runtimeMode,
                  interactionMode: current.interactionMode,
                },
              }),
        });
      const resolved = resolveProjectSettings(preferences, thread.projectId).settings;
      const resetKey = `limit-reset-attempt:${thread.id}:${thread.latestRunId}`;
      const apiAttemptKey = `limit-api-attempt:${thread.id}:${thread.latestRunId}`;
      const coordinator = yield* coordinatorOf(project.workspaceSettings?.coordinatorThreadId);
      const options = {
        resetAttempted: simulated || (yield* Ref.get(sent)).has(resetKey),
        apiCreditsAttempted: simulated || (yield* Ref.get(sent)).has(apiAttemptKey),
        simulated,
        proven: provenFallbackSelection(thread, coordinator),
        limited,
      };
      const stepFor = (current: FallbackThread) =>
        providerLimitStep(current, providersFor(current), resolved, now, options);
      let step = stepFor(thread);
      if (
        step === null &&
        (yield* refreshStaleTargets(thread, providersFor(thread), resolved, now))
      ) {
        providers = yield* registry.getProviders;
        step = stepFor(thread);
      }
      if (step === null) {
        // Nothing to continue: a thread the rule moved to API credits goes back
        // to its subscription. Sent once: after that, where the thread runs is
        // the person's choice again.
        const back = yield* apiCreditReturn(
          thread,
          providersFor(thread),
          now,
          resolved.providerLimitUseApiCredits === true,
        );
        if (back === null) continue;
        yield* threads.dispatch(back.command).pipe(
          Effect.tap(() => markSent(`limit-api-returned:${back.attemptKey}`)),
          Effect.tap(() =>
            Effect.logInfo("orchestration-v2.provider-fallback.api-credits-returned", {
              threadId: thread.id,
              from: thread.providerInstanceId,
              to: back.command.modelSelection.instanceId,
            }),
          ),
          Effect.catchCause((cause) =>
            returnFailed(back.attemptKey, back.tries, cause, now).pipe(
              Effect.andThen(
                Effect.logWarning("orchestration-v2.provider-fallback.dispatch-failed", {
                  threadId: thread.id,
                  cause,
                }),
              ),
            ),
          ),
        );
        continue;
      }
      if (step.type === "redeem-reset") {
        if (!(yield* stillApplies(thread, step, stepFor))) continue;
        const redeemed = yield* redeemReset(thread, step.instanceId, now, reads);
        // A usage read that failed is tried again next sweep, a few times,
        // before the stop moves on to a step that costs more.
        if (redeemed !== "unread" || (yield* unreadAgain(resetKey)) >= LIMIT_READ_ATTEMPTS)
          yield* markSent(resetKey);
        if (redeemed !== true) continue;
      }
      if (step.type === "spend-credits" && !(yield* stillApplies(thread, step, stepFor))) continue;
      if (step.type === "api-credits") {
        // The stop must be the subscription's own: a thread moved here after
        // it stopped somewhere else proves nothing about this account.
        const stopped = yield* projections.getThreadRecords(thread.id, ["runs"]).pipe(
          Effect.map((records) => records.runs.find((run) => run.id === thread.latestRunId)),
          Effect.orElseSucceed(() => undefined),
        );
        if (stopped?.providerInstanceId !== thread.providerInstanceId) {
          yield* markSent(apiAttemptKey);
          yield* Effect.logInfo("orchestration-v2.provider-fallback.api-credits-skipped", {
            threadId: thread.id,
            instanceId: step.instanceId,
            reason: "stopped-elsewhere",
          });
          continue;
        }
        // An API key has no usage read: its own "credit balance too low" is the proof.
        const read = step.rotate
          ? ("limited" as const)
          : yield* confirmLimit(thread, step.instanceId, now, reads);
        if (read === "unread") {
          if ((yield* unreadAgain(apiAttemptKey)) >= LIMIT_READ_ATTEMPTS)
            yield* markSent(apiAttemptKey);
          continue;
        }
        yield* markSent(apiAttemptKey);
        if (read !== "limited" || !(yield* stillApplies(thread, step, stepFor))) continue;
      }
      let command = step.type === "redeem-reset" ? step.continuation : step.command;
      if ((yield* Ref.get(sent)).has(command.commandId)) continue;
      if (command.type === "message.dispatch" && command.manualContinuationOfRunId !== undefined) {
        // A thread the provider never answered resends its request instead of
        // continuing nothing (see limitRestartRequest).
        const records = yield* projections
          .getThreadRecords(thread.id, ["runs", "providerThreads", "turnItems"], {
            turnItemRunIds: [command.manualContinuationOfRunId],
          })
          .pipe(Effect.catch(() => Effect.succeed(null)));
        const restart =
          records === null
            ? null
            : limitRestartRequest({
                threadId: thread.id,
                runId: command.manualContinuationOfRunId,
                runs: records.runs,
                providerThreads: records.providerThreads,
                turnItems: records.turnItems,
              });
        if (restart !== null)
          command = { ...command, text: restart.text, attachments: restart.attachments };
      }
      yield* markSent(command.commandId);
      yield* threads.dispatch(command).pipe(
        Effect.tap(() =>
          Effect.logInfo("orchestration-v2.provider-fallback.dispatched", {
            threadId: thread.id,
            step: step.type,
            command: command.type,
            from: thread.providerInstanceId,
            to: "modelSelection" in command ? command.modelSelection?.instanceId : undefined,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.provider-fallback.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("provider-fallback", sweep());
  }),
);
