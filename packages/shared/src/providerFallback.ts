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

/** Signed in, enabled and ready: it can take the next turn now. */
export function canTakeTurn(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    isProviderAvailable(provider) &&
    provider.status === "ready" &&
    provider.auth.status !== "unauthenticated" &&
    provider.usageLimits?.ordinaryUsageAllowed !== false
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

function defaultModel(provider: ServerProvider): string | undefined {
  return (
    provider.models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    provider.models.find((model) => !model.isCustom)?.slug ??
    provider.models[0]?.slug
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
  const current = input.providers.find((provider) => provider.instanceId === input.current.instanceId);
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
 * go back), else, with `anyReady`, the first other provider that can take a
 * turn, on its default model. A candidate at or past `belowPercent` is
 * skipped so two full providers never trade a thread back and forth.
 * `anyReady` never picks a Claude instance billed per token, since its turns
 * cost money: one is used only when the rule or the project's default model
 * names it, or through `resolveApiCreditSelection` when the rule allows API
 * credits.
 */
export function resolveProviderFallback(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly currentInstanceId: ProviderInstanceId;
  readonly rule: Pick<ProviderFallbackRule, "providerLimitFallbackModelSelection" | "defaultModelSelection">;
  readonly nowMs: number;
  readonly belowPercent?: number | null;
  readonly anyReady?: boolean;
}): ModelSelection | null {
  const usable = (provider: ServerProvider | undefined): provider is ServerProvider => {
    if (provider === undefined || provider.instanceId === input.currentInstanceId) return false;
    if (!canTakeTurn(provider)) return false;
    const used = providerUsedPercent(provider, input.nowMs);
    return input.belowPercent == null || used === null || used < input.belowPercent;
  };
  for (const selection of [
    input.rule.providerLimitFallbackModelSelection,
    input.rule.defaultModelSelection,
  ]) {
    if (selection === null) continue;
    if (usable(input.providers.find((provider) => provider.instanceId === selection.instanceId)))
      return selection;
  }
  if (!input.anyReady) return null;
  for (const provider of input.providers) {
    if (!usable(provider)) continue;
    if (isClaudeApiKeyProvider(provider)) continue;
    const model = defaultModel(provider);
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
  readonly rule: Pick<ProviderFallbackRule, "providerLimitSwitchAtPercent" | "providerLimitWaitUnderMinutes">;
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
