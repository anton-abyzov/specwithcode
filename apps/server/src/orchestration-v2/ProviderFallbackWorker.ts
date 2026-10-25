import { stringifyJson } from "../json.ts";
import {
  CommandId,
  type ManualCodexCreditIntent,
  MessageId,
  projectExecutionIsFenced,
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
  fallbackSelectionKey,
  isClaudeApiKeyProvider,
  isApiCreditProvider,
  isDirectClaudeApiKeyProvider,
  isPerTokenProvider,
  limitRestartRequest,
  limitStopWaitsForReset,
  provenFallbackSelection,
  type ProviderFallbackRule,
  reportsNoUsage,
  resolveApiCreditSelection,
  resolveProviderFallback,
  shouldSwitchBeforeTurn,
} from "@specweave-studio/shared/providerFallback";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ProviderInstances from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { projectCompatibleProviders } from "../project/ProjectProviderCompatibility.ts";
import * as Projects from "../project/ProjectService.ts";
import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import { SIMULATED_USAGE_LIMIT_MESSAGE, simulatedUsageLimitInstances } from "./ProviderFailure.ts";
import { limitHandoffTrigger, MachineLimitHandoff } from "./MachineLimitHandoff.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS } from "./ShellSnapshotCache.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { recoverySnoozeBlocks } from "./usageLimitRecovery.ts";
import { withSimulatedUsage } from "../usage/providerUsageSummary.ts";
import * as TaskRoutingEscalationWorker from "./TaskRoutingEscalationWorker.ts";
import {
  isBlockingRuntimeRequest,
  pendingRequestDetailMemo,
  withPendingRequestDetail,
} from "./blockingRuntimeRequest.ts";
import {
  API_CREDIT_MESSAGE_PREFIX,
  API_CREDIT_RETURN_ATTEMPTS,
  API_CREDIT_RETURN_COOLDOWN_MS,
  type ApiCreditOrigin,
  apiCreditOrigin,
  apiCreditReturnCommand,
  limitFallbackReturnCommand,
  limitResetAt,
  queuedRunsPinnedTo,
  reachedLimitWindow,
  usageWindowKey,
} from "./limitFallbackReturn.ts";
import { queuedRunsHoldingWayBack } from "./QueueFollowsThread.ts";
import {
  epochMs,
  LIMIT_FALLBACK_MESSAGE_PREFIX,
  LIMIT_STOP_MAX_AGE_MS,
  previousRunOnInstance,
} from "./providerOpenFailure.ts";
import { UnopenableHolds, UsageLimitHolds } from "./UnopenableHolds.ts";
import { contextOverflowStop } from "./contextOverflowFallback.ts";
import { contextRecoveryStep, isContextOverflowFailure } from "./ContextOverflowRecoveryWorker.ts";
import { latestRootProviderFailure } from "@specweave-studio/shared/orchestrationV2ThreadError";
import { isClaudePlanLimitStop } from "../provider/claudeLimitReset.ts";
import {
  type FallbackThread,
  latestOpenFailure,
  needsPreviousRun,
  type OpenFailure,
  PROVIDER_FALLBACK_CONTINUE_TEXT,
  PROVIDER_RETRY_MESSAGE_PREFIX,
  providerRetryAwaitsRead,
  providerRetryCommand,
  threadIsFree,
  unopenableFallbackCommand,
  unopenableHolds,
  type UnopenableStop,
  unopenableStop,
  unopenableStopIsLive,
} from "./unopenableFallback.ts";

export {
  API_CREDIT_IDLE_RETURN_MS,
  type ApiCreditOrigin,
  apiCreditOrigin,
  apiCreditReturnCommand,
  limitFallbackReturnCommand,
  limitResetAt,
  reachedLimitWindow,
} from "./limitFallbackReturn.ts";
export {
  LIMIT_FALLBACK_MESSAGE_PREFIX,
  LIMIT_STOP_MAX_AGE_MS,
  PROVIDER_FALLBACK_MESSAGE_PREFIX,
} from "./providerOpenFailure.ts";
export {
  LIMIT_FALLBACK_MAX_HOPS,
  type OpenFailure,
  PROVIDER_FALLBACK_CONTINUE_TEXT,
  PROVIDER_RETRY_MESSAGE_PREFIX,
  providerRetryCommand,
  UNOPENABLE_HOLD_MS,
  type UnopenableStop,
  unopenableFallbackCommand,
  unopenableHolds,
  unopenableStop,
} from "./unopenableFallback.ts";

/** The shell snapshot is not free; the scheduler ticks every five seconds. */
export const PROVIDER_FALLBACK_SWEEP_INTERVAL_MS = 30_000;

/** A usage read that failed is tried again on this many sweeps before the stop is left alone. */
const LIMIT_READ_ATTEMPTS = 3;

/** The instance a provider-ready retry waits on is read by the sweep at most this often. */
const FAILED_INSTANCE_READ_INTERVAL_MS = 5 * 60_000;

/** A provider that reports no usage is read again before a fallback onto it, at most this often. */
const UNREPORTED_TARGET_CHECK_MAX_AGE_MS = 60_000;

/** No-usage fallbacks the way back passes on its way home, at most. */
const LIMIT_RETURN_MAX_NO_USAGE_HOPS = 4;

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
  /** Fallback order entries whose continuation of this stop failed to dispatch. */
  failed?: ReadonlySet<string>,
): OrchestrationV2ServerCommand | null {
  if (rule.providerLimitAction !== "switch") return null;
  if (!threadIsFree(thread)) return null;
  if (thread.settledOverride === "settled" || thread.latestRunId === null) return null;
  const current = providers.find((provider) => provider.instanceId === thread.providerInstanceId);
  if (thread.status === "failed" && thread.lastErrorClass === "usage_limit") {
    if (waitsForReset(thread, rule, nowMs)) return null;
    const target = resolveProviderFallback({
      providers,
      currentInstanceId: thread.providerInstanceId,
      currentModel: thread.modelSelection.model,
      currentOptions: thread.modelSelection.options,
      rule,
      nowMs,
      belowPercent: rule.providerLimitSwitchAtPercent ?? 100,
      anyReady: true,
      proven,
      ...(limited === undefined ? {} : { limitedInstanceIds: limited }),
      ...(failed === undefined ? {} : { excludedSelections: failed }),
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
    currentOptions: thread.modelSelection.options,
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
    threadIsFree(thread) &&
    thread.settledOverride !== "settled" &&
    thread.latestRunId !== null
  );
}

/** Capacity belongs to the run's account, even after the thread selection changes. */
export function usageHoldEvidence(
  thread: FallbackThread,
  run: Pick<
    OrchestrationV2Run,
    "id" | "providerInstanceId" | "modelSelection" | "status" | "startedAt" | "completedAt"
  >,
): FallbackThread | null {
  if (run.id !== thread.latestRunId) return null;
  return {
    ...thread,
    providerInstanceId: run.providerInstanceId,
    modelSelection: { ...run.modelSelection, instanceId: run.providerInstanceId },
    status: run.status,
    latestRunStartedAt: run.startedAt,
    latestRunCompletedAt: run.completedAt,
  };
}

/**
 * Providers that report no usage (GitHub Copilot) but have a thread stopped
 * on their limit, each held until that stop's reset, or for as long as an
 * unknown reset counts as current. Nothing else tells the sweep they are
 * full, so without this a thread moved off one would be moved back onto it.
 * Hold only the instance that actually failed. A provider's current settings
 * cannot identify the account used by a historical run, so neither matching
 * icons nor homes justify holding a sibling. It may fail once before its own
 * hold is learned. Folds the threads seen now into `held` and drops expired holds.
 *
 * `planLimitOutlived` names threads whose stop was their instance's Claude
 * plan limit while that instance now bills API credits (a Console sign-in
 * reports no usage, so it would otherwise read like Copilot). Such a stop
 * holds nothing, and releases a hold an earlier sweep took for it.
 */
export function unreportedLimitStops(
  held: ReadonlyMap<string, number>,
  threads: ReadonlyArray<FallbackThread>,
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
  planLimitOutlived: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, number> {
  const next = new Map(held);
  for (const thread of threads)
    if (planLimitOutlived.has(thread.id)) next.delete(thread.providerInstanceId);
  for (const thread of threads) {
    if (planLimitOutlived.has(thread.id)) continue;
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

/** The message id prefix of a `resume-api` continuation (`sameProviderContinuation` "billing"). */
const PLAN_LIMIT_RESUME_PREFIX = "limit-billing:";

/**
 * Drops the hold of an instance on which a run started and finished cleanly
 * after the stop that set it: the provider took work again (a raised budget, an
 * earlier reset than the notice named), so a hold that can last until the
 * 1st of next month no longer describes it. `since` maps each held instance
 * to its latest limit stop; both maps come back pruned to the holds kept.
 */
export function releaseRecoveredHolds(
  held: ReadonlyMap<string, number>,
  since: ReadonlyMap<string, number>,
  threads: ReadonlyArray<FallbackThread>,
  nowMs: number,
): { readonly held: ReadonlyMap<string, number>; readonly since: ReadonlyMap<string, number> } {
  const nextSince = new Map<string, number>();
  for (const instanceId of held.keys()) {
    let stop = since.get(instanceId) ?? Number.NEGATIVE_INFINITY;
    for (const thread of threads) {
      if (thread.providerInstanceId !== instanceId) continue;
      if (thread.status !== "failed" || thread.lastErrorClass !== "usage_limit") continue;
      const stoppedMs = epochMs(thread.latestRunCompletedAt);
      if (Number.isFinite(stoppedMs)) stop = Math.max(stop, stoppedMs);
    }
    // A hold learned without a stop time counts from now: only later work clears it.
    nextSince.set(instanceId, Number.isFinite(stop) ? stop : nowMs);
  }
  const nextHeld = new Map(held);
  for (const thread of threads) {
    if (thread.status !== "completed") continue;
    const stop = nextSince.get(thread.providerInstanceId);
    // A turn already running at the stop can end "completed" on the same
    // notice after doing work; only one started after the stop shows room.
    const startedMs = epochMs(thread.latestRunStartedAt);
    if (stop === undefined || !Number.isFinite(startedMs) || startedMs <= stop) continue;
    nextHeld.delete(thread.providerInstanceId);
    nextSince.delete(thread.providerInstanceId);
  }
  return { held: nextHeld, since: nextSince };
}

/**
 * Continue the stopped run on the provider it stopped on, or, for `api`, on
 * the model selection the caller sets. `billing` is the same instance after
 * its login moved to API credits; it never reads as an API-credit move, so
 * no way back to the subscription follows it.
 */
function sameProviderContinuation(
  thread: FallbackThread & { latestRunId: string },
  kind: "reset" | "credits" | "api" | "billing",
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
 * Before all of them, under any rule but `ask`, `resume-api`: the run stopped on a
 * Claude plan limit (`planLimitOutlived`) and its own instance now bills API
 * credits, since its CLI was signed in to the Claude Console after the stop.
 * The limit no longer binds that instance, so the run continues there on the
 * same model at once, with no switch, handoff or wait for the reset.
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
    /** Fallback order entries whose continuation of this stop failed to dispatch. */
    readonly failedTargets?: ReadonlySet<string> | undefined;
    /** The thread's latest run failed to open its provider (see `unopenableStop`). */
    readonly unopenable?: UnopenableStop | null | undefined;
    /** The latest run stopped on its own instance's Claude plan limit. */
    readonly planLimitOutlived?: boolean;
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
  | { readonly type: "resume-api"; readonly command: OrchestrationV2ServerCommand }
  | { readonly type: "switch"; readonly command: OrchestrationV2ServerCommand }
  | null {
  if (options.unopenable != null && thread.latestRunId === options.unopenable.runId) {
    // A provider that cannot open has no reset to wait for or redeem and no
    // credits to spend: the only step is another provider.
    const command = unopenableFallbackCommand(thread, providers, rule, nowMs, options.unopenable, {
      proven: options.proven ?? null,
      limited: options.limited,
      failed: options.failedTargets,
    });
    return command === null ? null : { type: "switch", command };
  }
  const current = providers.find((provider) => provider.instanceId === thread.providerInstanceId);
  if (
    options.planLimitOutlived === true &&
    // `ask` leaves the next step to the person, as it does for a switch.
    rule.providerLimitAction !== "ask" &&
    stoppedOnLimit(thread) &&
    !simulatedStop(thread) &&
    limitStopIsCurrent(thread, nowMs) &&
    isApiCreditProvider(current) &&
    current !== undefined &&
    canTakeTurn(current) &&
    !options.limited?.has(current.instanceId) &&
    !recoverySnoozeBlocks(
      { snoozedUntil: thread.snoozedUntil ?? null, limitRecovery: thread.limitRecovery ?? null },
      nowMs,
      rule.snoozeLimitedThreads === true,
    )
  )
    return { type: "resume-api", command: sameProviderContinuation(thread, "billing") };
  if (rule.providerLimitAction === "wait" || !stoppedOnLimit(thread)) return null;
  if (waitsForReset(thread, rule, nowMs)) return null;
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
    options.failedTargets,
  );
  return command === null ? null : { type: "switch", command };
}

/** Tries of one fallback step whose dispatch fails, and the wait that grows after each. */
export const FALLBACK_DISPATCH_ATTEMPTS = 3;
export const FALLBACK_DISPATCH_BACKOFF_MS = 60_000;

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
  const admission = yield* ProjectAdmission.ProjectAdmission;
  const env = yield* ProviderFallbackEnv;
  const machineHandoff = yield* MachineLimitHandoff;
  const lastRunAt = yield* Ref.make(0);
  // Set when a run fails: it may have stopped on a limit, and the next tick
  // sweeps at once on a fresh read. Without it each provider in the fallback
  // order cost up to a full interval of silence before the next was tried.
  const woken = yield* Ref.make(false);
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
    const consume = instance.consumeResetCredit;
    const redeem = Effect.gen(function* () {
      const outcome = yield* consume().pipe(
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
    return { windowKey, redeem };
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
  // A pending request holds a thread only when it really waits (see
  // isBlockingRuntimeRequest). The shell names its newest one alone, so a
  // thread with one is read for the rest, once per thread state.
  const requestDetails = pendingRequestDetailMemo<FallbackThread["pendingRuntimeRequest"]>();
  const withRequestDetail = <T extends FallbackThread>(thread: T) =>
    Effect.gen(function* () {
      const pending = thread.pendingRuntimeRequest;
      if (pending === null) return thread;
      let detailed = requestDetails.get(thread);
      if (detailed === undefined) {
        const records = yield* projections
          .getThreadRecords(thread.id, ["runtimeRequests", "nodes"])
          .pipe(Effect.orElseSucceed(() => null));
        if (records === null) return thread;
        detailed = isBlockingRuntimeRequest(records, thread.latestRunId)
          ? pending
          : withPendingRequestDetail(thread, records).pendingRuntimeRequest;
        requestDetails.set(thread, detailed);
      }
      return { ...thread, pendingRuntimeRequest: detailed } as T;
    });
  // Admission precedes the settings lock, matching project writes and message
  // dispatch. Native probes happen before this bounded decision/commit section.
  const withCurrentPolicy = <A, E, R>(
    thread: OrchestrationV2ThreadShell,
    use: (
      current: OrchestrationV2ThreadShell,
      rule: ServerSettingsValue,
      project: Option.Option.Value<Effect.Success<ReturnType<typeof projects.getById>>>,
    ) => Effect.Effect<A, E, R>,
  ) =>
    admission.withLock(
      thread.projectId,
      settings.withSettingsSnapshot((preferences) =>
        Effect.gen(function* () {
          const project = yield* projects
            .getById(thread.projectId)
            .pipe(Effect.catchCause(() => Effect.succeedNone));
          if (
            Option.isNone(project) ||
            project.value.deletedAt != null ||
            project.value.workspaceSettings?.paused ||
            project.value.workspaceSettings?.archived ||
            projectExecutionIsFenced(project.value.workspaceSettings, thread.projectId, thread.id)
          )
            return;
          const current = yield* projections
            .getThreadShell(thread.id)
            .pipe(Effect.orElseSucceed(() => null));
          if (
            current === null ||
            current.projectId !== thread.projectId ||
            current.archivedAt != null ||
            current.deletedAt != null
          )
            return;
          return yield* use(
            yield* withRequestDetail(current),
            resolveProjectSettings(preferences, current.projectId).settings,
            project.value,
          );
        }),
      ),
    );
  // Runs are read once per thread, latest run and instance; the rest repeats each sweep.
  const origins = yield* Ref.make(new Map<string, ApiCreditOrigin | null>());
  // Whether a stop was its own instance's Claude plan limit, read once per stopped run.
  const planStops = yield* Ref.make(new Map<string, boolean>());
  const planLimitOutlived = (thread: FallbackThread, providers: ReadonlyArray<ServerProvider>) =>
    Effect.gen(function* () {
      if (!stoppedOnLimit(thread)) return false;
      const current = providers.find((entry) => entry.instanceId === thread.providerInstanceId);
      // Only an instance billed to API credits is past a plan limit.
      if (!isApiCreditProvider(current)) return false;
      const key = `${thread.id}:${thread.latestRunId}:${thread.providerInstanceId}`;
      const known = (yield* Ref.get(planStops)).get(key);
      if (known !== undefined) return known;
      const read = yield* projections
        .getThreadRecords(thread.id, ["runs", "turnItems"], {
          turnItemRunIds: [thread.latestRunId],
          turnItemTypes: ["error", "assistant_message"],
        })
        .pipe(
          Effect.map(({ runs, turnItems }) => {
            const stopped = runs.find((run) => run.id === thread.latestRunId);
            // The stop must be this instance's own, not one a move carried
            // here, and not the stop of a resume this step already sent: one
            // try per stop, so a stale billing read cannot loop.
            if (
              stopped?.providerInstanceId !== thread.providerInstanceId ||
              String(stopped.userMessageId).startsWith(PLAN_LIMIT_RESUME_PREFIX)
            )
              return false;
            return isClaudePlanLimitStop(turnItems);
          }),
          Effect.option,
        );
      // A failed read is tried again on the next sweep, not remembered.
      if (Option.isNone(read)) return false;
      yield* Ref.update(planStops, (current) => new Map(current).set(key, read.value));
      return read.value;
    });
  const returnTries = yield* Ref.make(
    new Map<
      string,
      { readonly next: number; readonly failures: number; readonly lastFailureAt: number }
    >(),
  );
  // Whether this thread, as given, has a way back to send. Reads only the
  // thread's runs, once per latest run; never the current shell.
  const apiCreditReturnPlan = Effect.fn("ProviderFallbackWorker.apiCreditReturnPlan")(function* (
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
      let found = apiCreditOrigin(
        thread,
        records.runs,
        apiCredits ? API_CREDIT_MESSAGE_PREFIX : LIMIT_FALLBACK_MESSAGE_PREFIX,
      );
      const stoppedResetAt = (runId: OrchestrationV2Run["id"]) =>
        projections.getThreadRecords(thread.id, ["turnItems"], { turnItemRunIds: [runId] }).pipe(
          Effect.map(({ turnItems }) => limitResetAt(runId, turnItems)),
          Effect.orElseSucceed(() => undefined),
        );
      if (found === null) origin = null;
      else {
        let resetAt = yield* stoppedResetAt(found.stoppedRunId);
        if (resetAt === undefined) return null;
        // A fallback that reports no usage (Copilot) and stopped with no reset
        // never reads as having room, so the way back would never fire: it
        // leads on to where the thread ran before that fallback.
        const noUsageHome = (selection: ModelSelection) => {
          const home = providers.find((provider) => provider.instanceId === selection.instanceId);
          return home !== undefined && reportsNoUsage(home);
        };
        for (
          let hops = 0;
          !apiCredits &&
          hops < LIMIT_RETURN_MAX_NO_USAGE_HOPS &&
          resetAt === null &&
          noUsageHome(found.modelSelection);
          hops++
        ) {
          const via: ApiCreditOrigin = found;
          const stoppedOrdinal = records.runs.find((run) => run.id === via.stoppedRunId)?.ordinal;
          if (stoppedOrdinal === undefined) break;
          const earlier = apiCreditOrigin(
            { id: thread.id, providerInstanceId: via.modelSelection.instanceId },
            records.runs.filter((run) => run.ordinal <= stoppedOrdinal),
            LIMIT_FALLBACK_MESSAGE_PREFIX,
          );
          if (earlier === null) break;
          const earlierResetAt = yield* stoppedResetAt(earlier.stoppedRunId);
          if (earlierResetAt === undefined) return null;
          found = { ...earlier, continuedByRunId: via.continuedByRunId };
          resetAt = earlierResetAt;
        }
        origin = { ...found, resetAt };
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
    return { command, origin, attemptKey, tries, returnCommand };
  });
  const apiCreditReturn = Effect.fn("ProviderFallbackWorker.apiCreditReturn")(function* (
    thread: FallbackThread,
    providers: ReadonlyArray<ServerProvider>,
    nowMs: number,
    ruleOn: boolean,
  ) {
    const plan = yield* apiCreditReturnPlan(thread, providers, nowMs, ruleOn);
    if (plan === null) return null;
    const { origin, attemptKey, tries, returnCommand } = plan;
    // Checked against the thread as it is now: a turn may have started since the snapshot.
    const shell = yield* projections
      .getThreadShell(thread.id)
      .pipe(Effect.orElseSucceed(() => null));
    if (
      shell === null ||
      shell.latestRunId !== thread.latestRunId ||
      shell.providerInstanceId !== thread.providerInstanceId
    )
      return null;
    const current = yield* withRequestDetail(shell);
    const command = returnCommand(current, origin, tries.next);
    if (command === null) return null;
    // The queue that would pull the thread straight back runs first; the sends
    // the way back moves home, held or not, do not hold it.
    const records = yield* projections.getThreadRecords(thread.id, ["runs"]).pipe(Effect.option);
    if (Option.isNone(records)) return null;
    const pinned = queuedRunsPinnedTo(records.value.runs, thread.providerInstanceId);
    if (pinned.length > 0) {
      const { messages = [] } = yield* projections
        .getThreadRecords(thread.id, ["messages"], {
          messageIds: pinned.map((run) => run.userMessageId),
        })
        .pipe(Effect.orElseSucceed(() => ({ messages: [] })));
      const holding = queuedRunsHoldingWayBack(
        { thread: current, runs: pinned, messages },
        thread.providerInstanceId,
        origin.modelSelection,
      );
      if (holding.length > 0) return null;
    }
    return { command, attemptKey, tries };
  });
  // A thread the provider never answered resends its request instead of
  // continuing nothing (see limitRestartRequest).
  const withRestartRequest = <
    C extends Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>,
  >(
    threadId: ThreadId,
    runId: OrchestrationV2Run["id"],
    command: C,
  ) =>
    Effect.gen(function* () {
      const records = yield* projections
        .getThreadRecords(threadId, ["runs", "providerThreads", "turnItems"], {
          turnItemRunIds: [runId],
        })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const restart =
        records === null
          ? null
          : limitRestartRequest({
              threadId,
              runId,
              runs: records.runs,
              providerThreads: records.providerThreads,
              turnItems: records.turnItems,
            });
      return restart === null
        ? command
        : { ...command, text: restart.text, attachments: restart.attachments };
    });
  // Per stopped run, the fallback models whose continuation failed to
  // dispatch: the next try moves down the user's order instead of repeating one.
  const failedTargets = yield* Ref.make(new Map<string, ReadonlySet<string>>());
  const dispatchTries = yield* Ref.make(
    new Map<
      string,
      { readonly next: number; readonly failures: number; readonly lastFailureAt: number }
    >(),
  );
  // Frees a failed step for the next sweep under its next id. A replayed id
  // the orchestrator rejected before (a restart lost the count) only moves on.
  const dispatchFailed = (
    baseCommandId: string,
    freed: ReadonlyArray<string>,
    cause: Cause.Cause<unknown>,
    nowMs: number,
  ) =>
    Effect.gen(function* () {
      const error = Cause.squash(cause);
      const replay =
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        error._tag === "OrchestratorCommandPreviouslyRejectedError";
      const tries = (yield* Ref.get(dispatchTries)).get(baseCommandId) ?? {
        next: 0,
        failures: 0,
        lastFailureAt: 0,
      };
      const next = replay
        ? { ...tries, next: tries.next + 1 }
        : { next: tries.next + 1, failures: tries.failures + 1, lastFailureAt: nowMs };
      yield* Ref.update(dispatchTries, (current) => new Map(current).set(baseCommandId, next));
      if (next.failures < FALLBACK_DISPATCH_ATTEMPTS)
        yield* Ref.update(sent, (current) => {
          const without = new Set(current);
          without.delete(baseCommandId);
          for (const key of freed) without.delete(key);
          return without;
        });
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
  /** When each of those holds' latest limit stop happened (see `releaseRecoveredHolds`). */
  const unreportedStopsSince = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const refreshStaleTargets = Effect.fn("ProviderFallbackWorker.refreshStaleTargets")(function* (
    thread: FallbackThread,
    candidates: ReadonlyArray<ServerProvider>,
    rule: ProviderFallbackRule,
    nowMs: number,
    unopenable: UnopenableStop | null = null,
  ) {
    const stopped =
      unopenable !== null
        ? unopenableStopIsLive(thread, unopenable, nowMs)
        : stoppedOnLimit(thread) &&
          !waitsForReset(thread, rule, nowMs) &&
          limitStopIsCurrent(thread, nowMs);
    if (rule.providerLimitAction !== "switch" || !stopped) return false;
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
  // refreshStaleTargets skips providers that report no usage, so a cached
  // "ready" for one (an ACP agent whose registry moved past the prepared
  // version) would take every fallback. The target is read once more first.
  const unreportedChecks = yield* Ref.make(new Map<ProviderInstanceId, number>());
  const checkUnreportedTarget = Effect.fn("ProviderFallbackWorker.checkUnreportedTarget")(
    function* (
      command: OrchestrationV2ServerCommand,
      candidates: ReadonlyArray<ServerProvider>,
      nowMs: number,
    ) {
      const selection =
        command.type === "message.dispatch" || command.type === "thread.model-selection.set"
          ? command.modelSelection
          : undefined;
      if (selection === undefined || (yield* Ref.get(sent)).has(command.commandId)) return false;
      const target = candidates.find((provider) => provider.instanceId === selection.instanceId);
      if (target === undefined || !reportsNoUsage(target)) return false;
      const lastCheck = (yield* Ref.get(unreportedChecks)).get(target.instanceId) ?? -Infinity;
      if (
        nowMs - Date.parse(target.checkedAt) < UNREPORTED_TARGET_CHECK_MAX_AGE_MS ||
        nowMs - lastCheck < UNREPORTED_TARGET_CHECK_MAX_AGE_MS
      )
        return false;
      yield* Ref.update(unreportedChecks, (current) =>
        new Map(current).set(target.instanceId, nowMs),
      );
      yield* registry.refreshInstance(target.instanceId).pipe(
        Effect.timeoutOption("15 seconds"),
        Effect.catchCause(() => Effect.void),
      );
      yield* Effect.logInfo("orchestration-v2.provider-fallback.target-checked", {
        instanceId: target.instanceId,
      });
      return true;
    },
  );
  // A failed run's failure code is fixed once it settles: read once per run.
  // A context stop has no open failure behind it, so no provider-ready retry.
  type OpenFailureRead = {
    readonly failed: OpenFailure | null;
    readonly stop: UnopenableStop | null;
  };
  const unopenableReads = yield* Ref.make(new Map<string, OpenFailureRead | null>());
  const unopenableHeld = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  // An overflow that recovery on its model cannot fix moves like an open
  // failure, to a model whose window holds the thread (contextOverflowStop).
  const readContextStop = Effect.fn("ProviderFallbackWorker.readContextStop")(function* (
    thread: OrchestrationV2ThreadShell & { readonly latestRunId: OrchestrationV2Run["id"] },
    runs: ReadonlyArray<OrchestrationV2Run>,
    turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
    providers: ReadonlyArray<ServerProvider>,
  ) {
    const run = runs.find((candidate) => candidate.id === thread.latestRunId);
    if (run === undefined) return null;
    const failure = latestRootProviderFailure(run, turnItems);
    if (!isContextOverflowFailure(failure)) return null;
    const step = contextRecoveryStep(thread.id, run, failure);
    const answered = runs.find((candidate) => candidate.id === step?.failedRunId);
    const extra = yield* projections
      .getThreadRecords(thread.id, ["providerThreads", "messages"], {
        messageIds: [run.userMessageId, ...(answered ? [answered.userMessageId] : [])],
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (extra === null) return undefined;
    return contextOverflowStop(thread, {
      runs,
      turnItems,
      messages: extra.messages,
      providerThreads: extra.providerThreads,
      providers,
    });
  });
  const readOpenFailure = Effect.fn("ProviderFallbackWorker.readOpenFailure")(function* (
    thread: OrchestrationV2ThreadShell & { readonly latestRunId: OrchestrationV2Run["id"] },
    providers: ReadonlyArray<ServerProvider>,
  ) {
    const records = yield* projections
      .getThreadRecords(thread.id, ["runs", "turnItems"], {
        turnItemRunIds: [thread.latestRunId],
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (records === null) return undefined;
    // A session failure can clear the class; any other class is never an open failure.
    const failed =
      thread.lastErrorClass == null || thread.lastErrorClass === "provider_error"
        ? latestOpenFailure(thread, records.runs, records.turnItems)
        : null;
    if (failed === null) {
      const stop = yield* readContextStop(thread, records.runs, records.turnItems, providers);
      if (stop === undefined) return undefined;
      return stop === null ? null : { failed: null, stop };
    }
    let turnItems = records.turnItems;
    // Only a repeat on the same instance makes this failure a stop.
    const latest = records.runs.find((run) => run.id === failed.runId);
    const previous = latest === undefined ? undefined : previousRunOnInstance(latest, records.runs);
    if (needsPreviousRun(thread.id, failed) && previous?.status === "failed") {
      const earlier = yield* projections
        .getThreadRecords(thread.id, ["turnItems"], { turnItemRunIds: [previous.id] })
        .pipe(Effect.orElseSucceed(() => null));
      if (earlier === null) return undefined;
      turnItems = [...turnItems, ...earlier.turnItems];
    }
    return { failed, stop: unopenableStop(thread, records.runs, turnItems) };
  });
  const unopenableStops = Effect.fn("ProviderFallbackWorker.unopenableStops")(function* (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
    providers: ReadonlyArray<ServerProvider>,
  ) {
    const cached = yield* Ref.get(unopenableReads);
    const next = new Map<string, OpenFailureRead | null>();
    const stops = new Map<string, UnopenableStop>();
    const failures = new Map<string, OpenFailure>();
    for (const thread of shells) {
      // A session failure can clear the class, so only a usage limit rules a
      // thread out; an overflow may carry any other class.
      if (
        thread.status !== "failed" ||
        thread.latestRunId === null ||
        thread.activeRunId !== null ||
        thread.lastErrorClass === "usage_limit" ||
        // A subagent the provider spawned takes no messages, so no retry or
        // move can reach it (isProviderNativeSubagentThread).
        (thread.lineage?.relationshipToParent === "subagent" &&
          thread.creationSource === "provider")
      )
        continue;
      const key = `${thread.id}:${thread.latestRunId}`;
      let read = cached.get(key);
      if (read === undefined) {
        read = yield* readOpenFailure({ ...thread, latestRunId: thread.latestRunId }, providers);
        if (read === undefined) continue;
      }
      next.set(key, read);
      if (read === null) continue;
      if (read.failed !== null) failures.set(thread.id, read.failed);
      if (read.stop !== null) stops.set(thread.id, read.stop);
    }
    yield* Ref.set(unopenableReads, next);
    return { stops, failures };
  });
  // Provider reads follow client demand, so on an unattended host nothing
  // reads the instance a retry waits on after its failure: it is read here,
  // each instance at most once per interval.
  const failedReads = yield* Ref.make(new Map<ProviderInstanceId, number>());
  const readFailedInstance = Effect.fn("ProviderFallbackWorker.readFailedInstance")(function* (
    thread: FallbackThread,
    failed: OpenFailure,
    candidates: ReadonlyArray<ServerProvider>,
    nowMs: number,
  ) {
    if (!providerRetryAwaitsRead(thread, failed, candidates, nowMs)) return false;
    if ((yield* Ref.get(sent)).has(`${PROVIDER_RETRY_MESSAGE_PREFIX}${thread.id}:${failed.runId}`))
      return false;
    const lastRead = (yield* Ref.get(failedReads)).get(failed.instanceId) ?? -Infinity;
    if (nowMs - lastRead < FAILED_INSTANCE_READ_INTERVAL_MS) return false;
    yield* Ref.update(failedReads, (current) => new Map(current).set(failed.instanceId, nowMs));
    yield* registry.refreshInstance(failed.instanceId).pipe(
      Effect.timeoutOption("60 seconds"),
      Effect.catchCause(() => Effect.void),
    );
    yield* Effect.logInfo("orchestration-v2.provider-fallback.failed-provider-read", {
      threadId: thread.id,
      instanceId: failed.instanceId,
    });
    return true;
  });
  // Once per failed run: a thread whose provider could not open, that no
  // fallback moved on, runs again once its provider can (see providerRetryCommand).
  const providerRetry = Effect.fn("ProviderFallbackWorker.providerRetry")(function* (
    thread: OrchestrationV2ThreadShell,
    failed: OpenFailure,
    providersFor: (
      current: FallbackThread,
      project?: Option.Option.Value<Effect.Success<ReturnType<typeof projects.getById>>>,
    ) => ReadonlyArray<ServerProvider>,
    nowMs: number,
    reread: Effect.Effect<void>,
  ) {
    if (yield* readFailedInstance(thread, failed, providersFor(thread), nowMs)) yield* reread;
    const planned = providerRetryCommand(thread, failed, providersFor(thread), nowMs);
    if (planned === null || (yield* Ref.get(sent)).has(planned.commandId)) return;
    yield* withCurrentPolicy(thread, (current, _rule, currentProject) =>
      Effect.gen(function* () {
        const command = providerRetryCommand(
          current,
          failed,
          providersFor(current, currentProject),
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        if (command?.commandId !== planned.commandId) return;
        if ((yield* Ref.get(sent)).has(command.commandId)) return;
        // Sent once, whatever happens: the id is the run's, so a restart cannot repeat it either.
        yield* markSent(command.commandId);
        yield* threads.dispatch(yield* withRestartRequest(thread.id, failed.runId, command)).pipe(
          Effect.tap(() =>
            Effect.logInfo("orchestration-v2.provider-fallback.provider-retried", {
              threadId: thread.id,
              runId: failed.runId,
              to: command.modelSelection?.instanceId,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.provider-fallback.dispatch-failed", {
              threadId: thread.id,
              cause,
            }),
          ),
        );
      }),
    );
  });
  const holdRuns = new Map<string, OrchestrationV2Run>();
  const sweep = Effect.fn("ProviderFallbackWorker.sweep")(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const wake = yield* Ref.getAndSet(woken, false);
    if (!wake && now - (yield* Ref.get(lastRunAt)) < PROVIDER_FALLBACK_SWEEP_INTERVAL_MS) return;
    yield* Ref.set(lastRunAt, now);
    const preferences = yield* settings.getSettings;
    let providers = withSimulatedUsage(yield* registry.getProviders, now, env);
    // The way back does not depend on a rule: a thread the rule moved must
    // not keep spending after the rule is turned off. Nor does the retry of a
    // provider that could not open, which needs some provider ready.
    const retryOnly = !anyLimitRule(preferences) && !providers.some(isClaudeApiKeyProvider);
    if (retryOnly && !providers.some(canTakeTurn)) return;
    // Simulated limits test the banner and the switch; they never redeem or spend.
    const simulated = simulatedUsageLimitInstances(env).length > 0;
    // Only active threads are swept (`snapshot.threads`), so this shares the
    // other sweeps' active read.
    // A wake must see the failure that caused it; a cached snapshot may predate it.
    const snapshot = yield* projections.getShellSnapshot({
      location: "active",
      unsettledOnly: true,
      maxAgeMs: wake ? 0 : SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS,
    });
    requestDetails.retain(snapshot.threads.map((thread) => thread.id));
    const outlived = new Set<string>();
    for (const thread of snapshot.threads)
      if (yield* planLimitOutlived(thread, providers)) outlived.add(thread.id);
    const previousHolds = yield* Ref.get(unreportedStops);
    const holdThreads: FallbackThread[] = [];
    const retainedHoldRuns = new Set<string>();
    const hasLimitStops = snapshot.threads.some(
      (thread) => thread.status === "failed" && thread.lastErrorClass === "usage_limit",
    );
    for (const thread of snapshot.threads) {
      if (thread.latestRunId === null) continue;
      if (
        !(thread.status === "failed" && thread.lastErrorClass === "usage_limit") &&
        !(thread.status === "completed" && (previousHolds.size > 0 || hasLimitStops))
      )
        continue;
      retainedHoldRuns.add(thread.latestRunId);
      let run = holdRuns.get(thread.latestRunId);
      // Cache terminal runs only; their identity and timestamps no longer change.
      if (run === undefined) {
        run = yield* projections
          .getThreadRecords(thread.id, ["runs"], { runIds: [thread.latestRunId] })
          .pipe(
            Effect.map((records) => records.runs.find((entry) => entry.id === thread.latestRunId)),
            Effect.catchCause(() => Effect.succeed(undefined)),
          );
        if (run !== undefined && (run.status === "completed" || run.status === "failed"))
          holdRuns.set(run.id, run);
      }
      if (run === undefined) continue;
      const evidence = usageHoldEvidence(thread, run);
      if (evidence !== null) holdThreads.push(evidence);
    }
    for (const runId of holdRuns.keys()) if (!retainedHoldRuns.has(runId)) holdRuns.delete(runId);
    const outlivedHolds = new Set<string>();
    for (const thread of holdThreads)
      if (yield* planLimitOutlived(thread, providers)) outlivedHolds.add(thread.id);
    const { held, since: heldSince } = releaseRecoveredHolds(
      unreportedLimitStops(previousHolds, holdThreads, providers, now, outlivedHolds),
      yield* Ref.get(unreportedStopsSince),
      holdThreads,
      now,
    );
    yield* Ref.set(unreportedStops, held);
    yield* Ref.set(unreportedStopsSince, heldSince);
    const { stops: unopenable, failures: openFailures } = yield* unopenableStops(
      snapshot.threads,
      providers,
    );
    // The selection that could not open counts as tried for the stop it answered.
    yield* Ref.update(failedTargets, (current) => {
      const next = new Map(current);
      for (const [threadId, stop] of unopenable) {
        // Only stops the rule can still answer; older ones would grow the map for nothing.
        if (now - stop.failedAtMs >= LIMIT_STOP_MAX_AGE_MS) continue;
        const key = `${threadId}:${stop.originRunId}`;
        next.set(key, new Set([...(next.get(key) ?? []), fallbackSelectionKey(stop.selection)]));
      }
      return next;
    });
    const unopenableHeldNow = unopenableHolds(
      yield* Ref.get(unopenableHeld),
      unopenable.values(),
      providers,
      now,
    );
    yield* Ref.set(unopenableHeld, unopenableHeldNow);
    // Shared with the coordinator's turn selection and new workers' launch.
    yield* (yield* UnopenableHolds).set(unopenableHeldNow);
    yield* (yield* UsageLimitHolds).set(held);
    const limited: ReadonlySet<string> = new Set([...held.keys(), ...unopenableHeldNow.keys()]);
    const reads: Reads = new Map();
    const rereadProviders = Effect.map(registry.getProviders, (read) => {
      providers = withSimulatedUsage(read, now, env);
    });
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
    for (const listed of snapshot.threads) {
      const thread = yield* withRequestDetail(listed);
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
      const providersFor = (current: FallbackThread, currentProject = project) =>
        projectCompatibleProviders({
          project: currentProject,
          providers,
          cwd: current.worktreePath ?? currentProject.workspaceRoot,
          ...(current.runtimeMode === undefined || current.interactionMode === undefined
            ? {}
            : {
                runtimePolicy: {
                  runtimeMode: current.runtimeMode,
                  interactionMode: current.interactionMode,
                },
              }),
        });
      const openFailure = openFailures.get(thread.id);
      if (retryOnly) {
        if (openFailure !== undefined)
          yield* providerRetry(thread, openFailure, providersFor, now, rereadProviders);
        continue;
      }
      const resolved = resolveProjectSettings(preferences, thread.projectId).settings;
      const resetKey = `limit-reset-attempt:${thread.id}:${thread.latestRunId}`;
      const apiAttemptKey = `limit-api-attempt:${thread.id}:${thread.latestRunId}`;
      const coordinator = yield* coordinatorOf(project.workspaceSettings?.coordinatorThreadId);
      const failedOpen = unopenable.get(thread.id) ?? null;
      // A move after a target failed to open still answers the original stop.
      const stopKey = `${thread.id}:${failedOpen?.originRunId ?? thread.latestRunId}`;
      const options = {
        resetAttempted: simulated || (yield* Ref.get(sent)).has(resetKey),
        apiCreditsAttempted: simulated || (yield* Ref.get(sent)).has(apiAttemptKey),
        simulated,
        proven: provenFallbackSelection(thread, coordinator),
        limited,
        failedTargets: (yield* Ref.get(failedTargets)).get(stopKey),
        unopenable: failedOpen,
        planLimitOutlived: outlived.has(thread.id),
      };
      const stepFor = (current: FallbackThread) =>
        providerLimitStep(current, providersFor(current), resolved, now, options);
      const admitStep = <A, E, R>(
        expected: NonNullable<ReturnType<typeof providerLimitStep>>,
        commit: Effect.Effect<A, E, R>,
      ) =>
        withCurrentPolicy(thread, (current, rule, currentProject) =>
          Effect.gen(function* () {
            const next = providerLimitStep(
              current,
              providersFor(current, currentProject),
              rule,
              DateTime.toEpochMillis(yield* DateTime.now),
              options,
            );
            const commandOf = (step: NonNullable<typeof next>) => {
              const command = step.type === "redeem-reset" ? step.continuation : step.command;
              // Wall-clock movement alone does not change a credit authorization.
              return command.type === "message.dispatch" && command.manualCodexCreditIntent
                ? {
                    ...command,
                    manualCodexCreditIntent: {
                      ...command.manualCodexCreditIntent,
                      observedAt: "current",
                    },
                  }
                : command;
            };
            if (
              next === null ||
              next.type !== expected.type ||
              stringifyJson(commandOf(next)) !== stringifyJson(commandOf(expected))
            )
              return;
            return yield* commit;
          }),
        );
      let step = stepFor(thread);
      // A context stop reads stale providers before it moves, even when a
      // target is found: home with an old reading may have room again.
      if (
        (step === null || failedOpen?.cause === "context") &&
        (yield* refreshStaleTargets(thread, providersFor(thread), resolved, now, failedOpen))
      ) {
        providers = yield* registry.getProviders;
        step = stepFor(thread);
      }
      if (
        step?.type === "switch" &&
        (yield* checkUnreportedTarget(step.command, providersFor(thread), now))
      ) {
        providers = withSimulatedUsage(yield* registry.getProviders, now, env);
        step = stepFor(thread);
      }
      // Another machine whose provider has room goes first unless the
      // project puts this machine's fallback models first (0968).
      const triggerFor = (
        current: OrchestrationV2ThreadShell,
        own: ReadonlyArray<ServerProvider>,
        rule: ServerSettingsValue,
        localStep: string | null,
        at: number,
      ) => {
        const provider = own.find((entry) => entry.instanceId === current.providerInstanceId);
        const model = current.modelSelection?.model ?? null;
        return limitHandoffTrigger({
          thread: current,
          rule,
          nowMs: at,
          stopped: stoppedOnLimit(current) && !waitsForReset(current, rule, at),
          atThreshold: shouldSwitchBeforeTurn({ provider, model, rule, nowMs: at }),
          localStep,
          windowKey: usageWindowKey(provider, at, model),
        });
      };
      const trigger = triggerFor(thread, providersFor(thread), resolved, step?.type ?? null, now);
      const admitHandoff = withCurrentPolicy(thread, (current, rule, currentProject) =>
        Effect.map(DateTime.now, (clock) => {
          const at = DateTime.toEpochMillis(clock);
          const own = providersFor(current, currentProject);
          const local = providerLimitStep(current, own, rule, at, options)?.type ?? null;
          return triggerFor(current, own, rule, local, at)?.key === trigger?.key;
        }),
      ).pipe(
        Effect.map((admitted) => admitted === true),
        Effect.orElseSucceed(() => false),
      );
      if (
        trigger !== null &&
        (yield* machineHandoff.consider({
          thread,
          rule: resolved,
          trigger,
          providers: providersFor(thread),
          projectTitle: project.title,
          nowMs: now,
          admit: admitHandoff,
        })) === "handled"
      )
        continue;
      // Handing off, or continued elsewhere (persisted, so also after a restart).
      if (yield* machineHandoff.localTurnBlocked(thread.id)) continue;
      if (step === null) {
        // Most threads have no way back to send. Judged on the snapshot first,
        // so they cost no lock, settings read or shell re-read each sweep.
        // The rule-off answer is the looser one: it can only find more.
        if ((yield* apiCreditReturnPlan(thread, providersFor(thread), now, false)) === null) {
          // No way back: a provider that could not open runs the turn again once it can.
          if (openFailure !== undefined)
            yield* providerRetry(thread, openFailure, providersFor, now, rereadProviders);
          continue;
        }
        // Nothing to continue: a thread the rule moved to API credits goes back
        // to its subscription. Sent once: after that, where the thread runs is
        // the person's choice again.
        yield* withCurrentPolicy(thread, (current, rule, currentProject) =>
          Effect.gen(function* () {
            const back = yield* apiCreditReturn(
              current,
              providersFor(current, currentProject),
              now,
              rule.providerLimitUseApiCredits === true,
            );
            if (back === null) return;
            // Going home from a fallback whose turn failed continues that turn.
            const command =
              back.command.type === "message.dispatch" && current.latestRunId !== null
                ? yield* withRestartRequest(thread.id, current.latestRunId, back.command)
                : back.command;
            yield* threads.dispatch(command).pipe(
              Effect.tap(() => markSent(`limit-api-returned:${back.attemptKey}`)),
              Effect.tap(() =>
                Effect.logInfo("orchestration-v2.provider-fallback.api-credits-returned", {
                  threadId: thread.id,
                  from: thread.providerInstanceId,
                  to: back.command.modelSelection?.instanceId,
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
          }),
        );
        continue;
      }
      if (step.type === "redeem-reset") {
        const prepared = yield* redeemReset(thread, step.instanceId, now, reads);
        let redeemed: boolean | "unread" = false;
        if (typeof prepared === "object") {
          const redemption = yield* admitStep(
            step,
            Effect.gen(function* () {
              if ((yield* Ref.get(sent)).has(prepared.windowKey)) return;
              yield* markSent(prepared.windowKey);
              reads.delete(step.instanceId);
              // The current-policy claim is the authorization boundary. Start the
              // structured child now, release the locks, then await network work.
              return yield* Effect.forkChild(prepared.redeem, { startImmediately: true });
            }),
          );
          if (redemption === undefined) continue;
          redeemed = yield* Fiber.join(redemption);
        } else redeemed = prepared;
        if (redeemed !== "unread" || (yield* unreadAgain(resetKey)) >= LIMIT_READ_ATTEMPTS)
          yield* markSent(resetKey);
        if (redeemed !== true) continue;
      }
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
        if (read !== "limited") {
          yield* markSent(apiAttemptKey);
          continue;
        }
      }
      let command = step.type === "redeem-reset" ? step.continuation : step.command;
      // A dispatch that failed is tried again under a fresh id (the orchestrator
      // refuses a rejected id for good), a few times, further apart each time.
      // After that it rests, like the way back, then starts a fresh round,
      // instead of giving up until the server restarts.
      const baseCommandId = command.commandId;
      let tries = (yield* Ref.get(dispatchTries)).get(baseCommandId);
      if (tries !== undefined && tries.failures >= FALLBACK_DISPATCH_ATTEMPTS) {
        if (now - tries.lastFailureAt < API_CREDIT_RETURN_COOLDOWN_MS) continue;
        const rested = { ...tries, failures: 0 };
        tries = rested;
        yield* Ref.update(dispatchTries, (current) => new Map(current).set(baseCommandId, rested));
        yield* Ref.update(sent, (current) => {
          const without = new Set(current);
          without.delete(baseCommandId);
          return without;
        });
      }
      if ((yield* Ref.get(sent)).has(command.commandId)) continue;
      if (tries !== undefined) {
        if (now - tries.lastFailureAt < FALLBACK_DISPATCH_BACKOFF_MS * tries.failures) continue;
        if (tries.next > 0)
          command = {
            ...command,
            commandId: CommandId.make(`${baseCommandId}:retry-${tries.next}`),
          };
      }
      // A move off a provider that could not open continues its failed run too.
      const continuedRunId =
        command.type !== "message.dispatch"
          ? undefined
          : (command.manualContinuationOfRunId ??
            (step.type === "switch" ? failedOpen?.runId : undefined));
      if (command.type === "message.dispatch" && continuedRunId !== undefined)
        command = yield* withRestartRequest(thread.id, continuedRunId, command);
      yield* admitStep(
        step,
        Effect.gen(function* () {
          if ((yield* Ref.get(sent)).has(command.commandId)) return;
          if (step.type === "api-credits") yield* markSent(apiAttemptKey);
          yield* markSent(baseCommandId);
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
              Effect.gen(function* () {
                yield* Effect.logWarning("orchestration-v2.provider-fallback.dispatch-failed", {
                  threadId: thread.id,
                  cause,
                });
                if (
                  step.type === "switch" &&
                  command.type === "message.dispatch" &&
                  command.modelSelection !== undefined
                ) {
                  const target = fallbackSelectionKey(command.modelSelection);
                  yield* Ref.update(failedTargets, (current) =>
                    new Map(current).set(
                      stopKey,
                      new Set([...(current.get(stopKey) ?? []), target]),
                    ),
                  );
                }
                yield* dispatchFailed(
                  baseCommandId,
                  step.type === "api-credits"
                    ? [command.commandId, apiAttemptKey]
                    : [command.commandId],
                  cause,
                  now,
                );
              }),
            ),
          );
        }),
      );
    }
  });
  return Object.assign(sweep, { wake: Ref.set(woken, true) });
});

/** Wake the sweep for each run that fails from now on. */
export const wakeOnFailedRuns = (wake: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const afterSequence = yield* eventSink.latestSequence();
    yield* eventSink.stream({ afterSequence, eventType: "run.updated" }).pipe(
      Stream.filter(
        (stored) => stored.event.type === "run.updated" && stored.event.payload.status === "failed",
      ),
      Stream.runForEach(() => wake),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logWarning("orchestration-v2.provider-fallback.wake-stream-failed", { cause }),
    ),
  );

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    // Without the wake the sweep still runs on its interval.
    yield* Effect.forkScoped(wakeOnFailedRuns(sweep.wake));
    yield* scheduler.register("provider-fallback", sweep());
  }),
).pipe(
  Layer.provide(ProjectAdmission.layer),
  // Auto routing's escalation sweep needs the same services. It is wired here, not in
  // runtimeLayer.ts: one more import there trips TS2589 in ws.ts's handler layer.
  Layer.merge(TaskRoutingEscalationWorker.layer),
);
