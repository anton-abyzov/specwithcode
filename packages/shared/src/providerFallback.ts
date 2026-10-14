/**
 * Which provider a thread continues on when its own runs out, shared by the
 * limit banner and the server's automatic switch so both pick the same one.
 *
 * @module providerFallback
 */
import {
  type ChatAttachment,
  isProviderAvailable,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ProviderLimitAction,
  type ServerProvider,
  type ThreadId,
} from "@specweave-studio/contracts";

export interface ProviderFallbackRule {
  readonly providerLimitAction: ProviderLimitAction;
  readonly providerLimitFallbackModelSelection: ModelSelection | null;
  readonly providerLimitSwitchAtPercent: number | null;
  /**
   * Minutes: a reset this close is waited for instead of switching,
   * redeeming or spending. Absent or `0` never waits.
   */
  readonly providerLimitWaitUnderMinutes?: number;
  /** Redeem one of the account's banked resets before falling back. */
  readonly providerLimitRedeemResets?: boolean;
  /** Continue a limited Codex turn on the account's paid credits before falling back. */
  readonly providerLimitSpendCredits?: boolean;
  /** Continue a limited Claude subscription turn on a Claude API-key instance before falling back. */
  readonly providerLimitUseApiCredits?: boolean;
  /** The project's default model: the way back when the thread already runs on the fallback. */
  readonly defaultModelSelection: ModelSelection | null;
}

/** The fullest usage window that has not reset yet, or null when the provider reports none. */
export function providerUsedPercent(provider: ServerProvider, nowMs: number): number | null {
  let top: number | null = null;
  for (const window of provider.usageLimits?.windows ?? []) {
    const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    if (Number.isFinite(resetsAt) && resetsAt <= nowMs) continue;
    top = top === null ? window.usedPercent : Math.max(top, window.usedPercent);
  }
  return top;
}

/** Match native admission's denial signals; window percentages cannot override them. */
function usageDeniesTurn(provider: ServerProvider): boolean {
  const limits = provider.usageLimits;
  return (
    limits?.ordinaryUsageAllowed === false ||
    limits?.spendControlReached === true ||
    (!!limits?.rateLimitReachedType && limits.ordinaryUsageAllowed !== true)
  );
}

/** Signed in, enabled and ready: it can take the next turn now. */
export function canTakeTurn(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    isProviderAvailable(provider) &&
    provider.status === "ready" &&
    provider.auth.status !== "unauthenticated" &&
    !usageDeniesTurn(provider)
  );
}

/**
 * A Claude instance whose turns are billed per token instead of to a
 * subscription: its own environment holds an Anthropic API key, it signs in
 * with a token for another endpoint, or it runs on Amazon Bedrock. Nothing
 * picks one by itself.
 */
export function isClaudeApiKeyProvider(provider: ServerProvider | undefined): boolean {
  return (
    provider?.driver === "claudeAgent" &&
    (provider.auth.type === "apiKey" ||
      provider.auth.type === "bedrock" ||
      provider.auth.apiKeyBilling === true)
  );
}

/**
 * A Claude instance whose own environment holds an Anthropic API key and no
 * custom endpoint. Only this kind takes a limited turn on API credits: a
 * proxy or router token is billed somewhere else.
 */
export function isDirectClaudeApiKeyProvider(provider: ServerProvider | undefined): boolean {
  return provider?.driver === "claudeAgent" && provider.auth.apiKeyBilling === true;
}

/**
 * Any instance whose turns are billed per token: a Claude API-key, proxy or
 * Bedrock instance, or another driver signed in with an API key (Codex on
 * an OpenAI key). Nothing picks one by itself.
 */
export function isPerTokenProvider(provider: ServerProvider | undefined): boolean {
  return (
    isClaudeApiKeyProvider(provider) ||
    provider?.auth.type === "apiKey" ||
    provider?.auth.type === "api_key" ||
    provider?.auth.type === "bedrock" ||
    provider?.auth.apiKeyBilling === true
  );
}

/** Suggestions need a recent successful observation, not merely an installed CLI. */
export const FALLBACK_USAGE_MAX_AGE_MS = 5 * 60_000;
export function hasUsableFallbackCapacity(provider: ServerProvider, nowMs: number): boolean {
  const limits = provider.usageLimits;
  if (
    !canTakeTurn(provider) ||
    provider.auth.status !== "authenticated" ||
    !limits ||
    limits.unavailable
  )
    return false;
  const observedAt = Date.parse(limits.nativeAllowanceObservedAt ?? limits.checkedAt);
  if (
    !Number.isFinite(observedAt) ||
    observedAt > nowMs ||
    nowMs - observedAt > FALLBACK_USAGE_MAX_AGE_MS
  )
    return false;
  const deniedAt = Date.parse(limits.nativeDenialObservedAt ?? "");
  if (Number.isFinite(deniedAt) && deniedAt >= observedAt) return false;
  if (
    limits.windows.some(
      (window) =>
        !Number.isFinite(window.usedPercent) ||
        window.usedPercent < 0 ||
        (window.usedPercent >= 100 &&
          window.resetsAt !== undefined &&
          Date.parse(window.resetsAt) <= nowMs),
    )
  )
    return false;
  const used = providerUsedPercent(provider, nowMs);
  // A reset passing is not evidence of renewed allowance. Refresh first.
  return used !== null && Number.isFinite(used) && used >= 0 && used < 100;
}

function defaultModel(provider: ServerProvider): string | undefined {
  return (
    provider.models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    provider.models.find((model) => !model.isCustom)?.slug ??
    undefined
  );
}

/**
 * Where a limited Claude subscription thread continues on API credits: the
 * first other Claude instance with its own Anthropic API key that can take a
 * turn and lists the thread's model. The model never changes, so the price
 * of the continuation is the one the thread was already running at. Null
 * when the thread is not on a Claude subscription or no such instance is
 * ready.
 */
export function resolveApiCreditSelection(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection;
}): ModelSelection | null {
  const current = input.providers.find(
    (provider) => provider.instanceId === input.current.instanceId,
  );
  if (current?.driver !== "claudeAgent" || isClaudeApiKeyProvider(current)) return null;
  for (const provider of input.providers) {
    if (provider.instanceId === current.instanceId) continue;
    if (!isDirectClaudeApiKeyProvider(provider) || !canTakeTurn(provider)) continue;
    if (provider.models.some((model) => model.slug === input.current.model))
      return { ...input.current, instanceId: provider.instanceId };
  }
  return null;
}

/**
 * The model to continue on instead of `currentInstanceId`: the project's
 * fallback, else its default model (so a thread already on the fallback can
 * go back), else, with `anyReady`, the cheapest other provider that can take
 * a turn. A candidate at or past `belowPercent` is skipped so two full
 * providers never trade a thread back and forth.
 *
 * `anyReady` prefers, in order: another instance of the same driver that
 * lists `currentModel` (another account on the same model, where a Claude
 * transcript is copied across instead of summarised), then any instance of
 * the same driver, then the one with the most verified headroom left, then list order. It never picks an instance billed per token
 * (`isPerTokenProvider`), since its turns cost money: one is used only when
 * the rule or the project's default model names it, or through
 * `resolveApiCreditSelection` when the rule allows API credits.
 */
export function resolveProviderFallback(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly currentInstanceId: ProviderInstanceId;
  /** The model the thread runs on, kept when another account of its driver lists it. */
  readonly currentModel?: string | undefined;
  readonly rule: Pick<
    ProviderFallbackRule,
    "providerLimitFallbackModelSelection" | "defaultModelSelection"
  >;
  readonly nowMs: number;
  readonly belowPercent?: number | null;
  readonly anyReady?: boolean;
  /** Instances known to be limited whatever their usage read says (a current limit stop). */
  readonly limitedInstanceIds?: ReadonlySet<string>;
}): ModelSelection | null {
  const usable = (provider: ServerProvider | undefined): provider is ServerProvider => {
    if (provider === undefined || provider.instanceId === input.currentInstanceId) return false;
    if (
      input.limitedInstanceIds?.has(provider.instanceId) ||
      !hasUsableFallbackCapacity(provider, input.nowMs)
    )
      return false;
    const used = providerUsedPercent(provider, input.nowMs);
    return used !== null && (input.belowPercent == null || used < input.belowPercent);
  };
  for (const selection of [
    input.rule.providerLimitFallbackModelSelection,
    input.rule.defaultModelSelection,
  ]) {
    if (selection === null) continue;
    const provider = input.providers.find((entry) => entry.instanceId === selection.instanceId);
    if (
      usable(provider) &&
      provider.models.some((model) => model.slug === selection.model && !model.isCustom)
    )
      return selection;
  }
  if (!input.anyReady) return null;
  const driver = input.providers.find(
    (provider) => provider.instanceId === input.currentInstanceId,
  )?.driver;
  const sameModel = (provider: ServerProvider) =>
    provider.driver === driver &&
    input.currentModel !== undefined &&
    provider.models.some((model) => model.slug === input.currentModel && !model.isCustom);
  // Lower is cheaper: the same model elsewhere, the same driver, then headroom.
  const rank = (provider: ServerProvider): [number, number] => [
    sameModel(provider) ? 0 : provider.driver === driver ? 1 : 2,
    providerUsedPercent(provider, input.nowMs) ?? 101,
  ];
  const candidates = input.providers
    .filter((provider) => usable(provider) && !isPerTokenProvider(provider))
    .map((provider, order) => ({ provider, order, rank: rank(provider) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.order - b.order);
  for (const { provider } of candidates) {
    const model = sameModel(provider) ? input.currentModel : defaultModel(provider);
    if (model !== undefined) return { instanceId: provider.instanceId, model };
  }
  return null;
}

/** How long past a waited-for reset the thread may still be stopped before the rule acts after all. */
export const LIMIT_WAIT_GRACE_MS = 10 * 60_000;

const waitMs = (minutes: number | undefined): number =>
  minutes === undefined || !Number.isFinite(minutes) || minutes <= 0 ? 0 : minutes * 60_000;

/**
 * When the provider's windows at or past `threshold` all reset, if every one
 * names a reset time, else null. A window with no reset time could be the
 * weekly one, so it never counts as close.
 */
export function usageResetAt(
  provider: ServerProvider | undefined,
  threshold: number,
  nowMs: number,
): number | null {
  let latest: number | null = null;
  for (const window of provider?.usageLimits?.windows ?? []) {
    const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    if (Number.isFinite(resetsAt) && resetsAt <= nowMs) continue;
    if (window.usedPercent < threshold) continue;
    if (!Number.isFinite(resetsAt)) return null;
    latest = latest === null ? resetsAt : Math.max(latest, resetsAt);
  }
  return latest;
}

/**
 * Whether a full provider is better waited for than left: every window at or
 * past the threshold resets within the rule's wait. Studio then neither
 * switches early nor shows the switch suggestion.
 */
export function usageResetsSoon(input: {
  readonly provider: ServerProvider | undefined;
  readonly threshold: number;
  readonly waitUnderMinutes: number | undefined;
  readonly nowMs: number;
}): boolean {
  const wait = waitMs(input.waitUnderMinutes);
  if (wait === 0) return false;
  const resetAt = usageResetAt(input.provider, input.threshold, input.nowMs);
  return resetAt !== null && resetAt - input.nowMs <= wait;
}

/**
 * Whether a turn that stopped on the limit waits for its reset instead of
 * redeeming, spending or switching: the reset is within the rule's wait, or
 * passed less than `LIMIT_WAIT_GRACE_MS` ago (the resume at the reset still
 * gets its chance). An unknown reset never waits.
 */
export function limitStopWaitsForReset(input: {
  readonly resetAt: string | null | undefined;
  readonly waitUnderMinutes: number | undefined;
  readonly nowMs: number;
}): boolean {
  const wait = waitMs(input.waitUnderMinutes);
  const resetMs = Date.parse(input.resetAt ?? "");
  if (wait === 0 || !Number.isFinite(resetMs)) return false;
  return resetMs - input.nowMs <= wait && input.nowMs - resetMs < LIMIT_WAIT_GRACE_MS;
}

/**
 * Whether the next turn should start on the fallback: the rule is `switch`,
 * a threshold is set, the current provider's fullest window has reached it,
 * and that usage does not reset within the rule's wait.
 */
export function shouldSwitchBeforeTurn(input: {
  readonly provider: ServerProvider | undefined;
  readonly rule: Pick<
    ProviderFallbackRule,
    "providerLimitAction" | "providerLimitSwitchAtPercent" | "providerLimitWaitUnderMinutes"
  >;
  readonly nowMs: number;
}): boolean {
  if (input.rule.providerLimitAction !== "switch") return false;
  return usageAtThreshold(input);
}

/**
 * Whether the provider has reached the threshold with a reset too far off to
 * wait for, whatever the rule: under `ask` this is when the thread suggests
 * moving on before the limit stops it.
 */
export function usageAtThreshold(input: {
  readonly provider: ServerProvider | undefined;
  readonly rule: Pick<
    ProviderFallbackRule,
    "providerLimitSwitchAtPercent" | "providerLimitWaitUnderMinutes"
  >;
  readonly nowMs: number;
}): boolean {
  const threshold = input.rule.providerLimitSwitchAtPercent;
  if (threshold === null || input.provider === undefined) return false;
  const used = providerUsedPercent(input.provider, input.nowMs);
  if (used === null || used < threshold) return false;
  return !usageResetsSoon({
    provider: input.provider,
    threshold,
    waitUnderMinutes: input.rule.providerLimitWaitUnderMinutes,
    nowMs: input.nowMs,
  });
}

export interface LimitRestartRequest {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

/**
 * What a limited thread sends on the fallback when it has nothing to
 * continue: a thread whose provider never answered (the limit hit its first
 * message, so no native session exists) resends that message instead of
 * "Continue where you left off", which would reach the new provider with no
 * request behind it. Null when the thread has native history to hand over.
 */
export function limitRestartRequest(input: {
  readonly threadId: ThreadId;
  readonly runId: OrchestrationV2Run["id"];
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "status">>;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "appThreadId" | "nativeThreadRef">
  >;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): LimitRestartRequest | null {
  if (
    input.providerThreads.some(
      (thread) => thread.appThreadId === input.threadId && thread.nativeThreadRef !== null,
    ) ||
    input.runs.some((run) => run.status === "completed")
  )
    return null;
  let request: Extract<OrchestrationV2TurnItem, { type: "user_message" }> | null = null;
  for (const item of input.turnItems) {
    if (item.type !== "user_message" || item.runId !== input.runId) continue;
    if (request === null || item.ordinal < request.ordinal) request = item;
  }
  return request === null || request.text.trim().length === 0
    ? null
    : { text: request.text, attachments: request.attachments };
}

export type CoordinatorTurnSelectionReason =
  | "saved"
  | "saved-resets-soon"
  | "staying-on-fallback"
  | "fallback"
  | "rule-steps-first"
  | "no-fallback";

/** How long a failed run on the saved model keeps a coordinator off it without a newer usage read. */
export const COORDINATOR_LIMIT_STOP_MAX_AGE_MS = 5 * 60 * 60_000;

/**
 * The model a project coordinator's next turn runs on. Each message to the
 * coordinator names the project's saved model, which would pull a coordinator
 * the limit rule moved off a full provider straight back to it: the turn
 * stops on the limit, the rule moves it again, and every message pays for a
 * new handoff and an uncached first turn on both sides.
 *
 * So the saved model wins only while its provider has room (below the
 * project's threshold, ordinary usage allowed, no current limit stop, and no
 * failed run there since its last usage read) or resets within the project's
 * wait. Otherwise a coordinator already running elsewhere stays there, under
 * any rule, since a person or the rule moved it, unless that costs money per
 * token without the rule's consent. Under `switch` one still on the full
 * provider moves to the cheapest fallback with headroom, after the rule's
 * redeem and credit steps. Once the saved provider has room again the next
 * message goes back to it: one handoff back, not one per message.
 */
export function resolveCoordinatorTurnSelection(input: {
  readonly saved: ModelSelection;
  readonly thread: ModelSelection | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly rule: ProviderFallbackRule;
  readonly nowMs: number;
  /** Instances a current limit stop or the usage simulation marks as limited. */
  readonly limitedInstanceIds?: ReadonlySet<string>;
  /**
   * When the coordinator's last run on the saved instance failed, if it now
   * runs elsewhere. The saved provider counts as full until a usage read
   * taken after that shows its windows, so a stale or failed read never
   * pulls the coordinator back into the limit.
   */
  readonly savedStoppedAtMs?: number | null;
}): { readonly selection: ModelSelection; readonly reason: CoordinatorTurnSelectionReason } {
  const threshold = input.rule.providerLimitSwitchAtPercent ?? 100;
  const limited = input.limitedInstanceIds ?? new Set<string>();
  const full = (provider: ServerProvider | undefined): boolean => {
    if (provider === undefined) return false;
    if (limited.has(provider.instanceId)) return true;
    if (usageDeniesTurn(provider)) return true;
    const used = providerUsedPercent(provider, input.nowMs);
    return used !== null && used >= threshold;
  };
  const savedProvider = input.providers.find(
    (provider) => provider.instanceId === input.saved.instanceId,
  );
  const stoppedAt = input.savedStoppedAtMs ?? null;
  const readAt = Date.parse(savedProvider?.usageLimits?.checkedAt ?? "");
  const readSinceStop =
    savedProvider !== undefined &&
    Number.isFinite(readAt) &&
    stoppedAt !== null &&
    readAt > stoppedAt &&
    savedProvider.usageLimits?.unavailable === undefined &&
    providerUsedPercent(savedProvider, input.nowMs) !== null;
  const stoppedRecently =
    stoppedAt !== null &&
    input.nowMs - stoppedAt < COORDINATOR_LIMIT_STOP_MAX_AGE_MS &&
    !readSinceStop;
  if (!stoppedRecently && !full(savedProvider)) return { selection: input.saved, reason: "saved" };
  if (
    !stoppedRecently &&
    !limited.has(input.saved.instanceId) &&
    usageResetsSoon({
      provider: savedProvider,
      threshold,
      waitUnderMinutes: input.rule.providerLimitWaitUnderMinutes,
      nowMs: input.nowMs,
    })
  )
    return { selection: input.saved, reason: "saved-resets-soon" };
  const thread = input.thread;
  if (thread !== null && thread.instanceId !== input.saved.instanceId) {
    const current = input.providers.find((provider) => provider.instanceId === thread.instanceId);
    // Never keeps paying per token unless the rule allows API credits.
    const paid = isPerTokenProvider(current) && input.rule.providerLimitUseApiCredits !== true;
    if (current !== undefined && !paid && canTakeTurn(current) && !full(current))
      return { selection: thread, reason: "staying-on-fallback" };
  }
  if (input.rule.providerLimitAction !== "switch")
    return { selection: input.saved, reason: "no-fallback" };
  // Redeeming a banked reset or spending credits keeps the saved model: the
  // limit sweep runs those steps on the stop before it switches.
  if (
    input.rule.providerLimitRedeemResets === true ||
    input.rule.providerLimitSpendCredits === true
  )
    return { selection: input.saved, reason: "rule-steps-first" };
  const target = resolveProviderFallback({
    providers: input.providers,
    currentInstanceId: input.saved.instanceId,
    currentModel: input.saved.model,
    rule: input.rule,
    nowMs: input.nowMs,
    belowPercent: threshold,
    anyReady: true,
    limitedInstanceIds: limited,
  });
  return target === null
    ? { selection: input.saved, reason: "no-fallback" }
    : { selection: target, reason: "fallback" };
}
