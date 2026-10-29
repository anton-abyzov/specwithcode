/**
 * Which provider a thread continues on when its own runs out, shared by the
 * limit banner and the server's automatic switch so both pick the same one.
 *
 * @module providerFallback
 */
import {
  type ChatAttachment,
  isGitHubCopilotIcon,
  isPaidModelBilling,
  isProviderAvailable,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ProviderLimitAction,
  providerModelBilling,
  type ServerProvider,
  type ThreadId,
} from "@specweave-studio/contracts";
import { describeModel, sameModelOn } from "./modelIdentity.ts";
import { effectiveUsedPercent, isLiveWindow, windowAppliesToModel } from "./usageWindows.ts";

export interface ProviderFallbackRule {
  readonly providerLimitAction: ProviderLimitAction;
  readonly providerLimitFallbackModelSelection: ModelSelection | null;
  /** The models to continue on, best first; empty uses the single model above. */
  readonly providerLimitFallbackModels?: ReadonlyArray<ModelSelection> | undefined;
  /** A non-empty order is the whole chain: nothing past it takes the thread. */
  readonly providerLimitFallbackListOnly?: boolean | undefined;
  /** Models never continued on automatically (see `isExcludedFallbackModel`). */
  readonly providerLimitExcludedModels?: ReadonlyArray<ExcludedFallbackModel> | undefined;
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
  /**
   * Other providers serving the default model, in the order to try them
   * before any other model (see `resolveSameModelElsewhere`). Absent or empty
   * tries every provider that lists it.
   */
  readonly defaultModelProviders?: ReadonlyArray<ProviderInstanceId> | undefined;
}

/** A model the user keeps out of automatic limit continuation. */
export interface ExcludedFallbackModel {
  readonly model: string;
  /** Only on this instance; absent excludes the model on every provider. */
  readonly instanceId?: ProviderInstanceId;
}

/**
 * A model slug in the form every provider spells alike: lowercase, with
 * `.`, `_` and spaces read as `-`, so Copilot's `claude-opus-5.5` and
 * Claude's `claude-opus-5-5`, or `grok-4.7` and `grok-4-7`, are one model.
 */
export function normalizeModelKey(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/[\s._]+/g, "-")
    .replace(/-+/g, "-");
}

/** Whether the user excluded `model` on `instanceId` from automatic fallback. */
export function isExcludedFallbackModel(
  excluded: ReadonlyArray<ExcludedFallbackModel> | undefined,
  instanceId: ProviderInstanceId,
  model: string | undefined,
): boolean {
  if (model === undefined || excluded === undefined || excluded.length === 0) return false;
  const key = normalizeModelKey(model);
  return excluded.some(
    (entry) =>
      normalizeModelKey(entry.model) === key &&
      (entry.instanceId === undefined || entry.instanceId === instanceId),
  );
}

/**
 * The fullest usage window that has not reset yet and applies to `model`, or
 * null when the provider reports none. A model-scoped window (Claude's Fable
 * weekly) counts only for its own models: without a model, only the
 * account-wide windows do, so a spent Fable weekly never makes Opus "full".
 */
export function providerUsedPercent(
  provider: ServerProvider,
  nowMs: number,
  model?: string | null,
): number | null {
  return effectiveUsedPercent(provider.usageLimits?.windows ?? [], nowMs, model);
}

/** Match native admission's denial signals; window percentages cannot override them. */
export function usageDeniesTurn(provider: ServerProvider): boolean {
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
 * A Claude instance billed to Anthropic API credits: its own environment
 * holds an Anthropic API key and no custom endpoint, or its CLI is signed in
 * to the Claude Console. Only this kind takes a limited turn on API credits:
 * a proxy or router token is billed somewhere else.
 */
export function isDirectClaudeApiKeyProvider(provider: ServerProvider | undefined): boolean {
  return provider?.driver === "claudeAgent" && provider.auth.apiKeyBilling === true;
}

/**
 * The Gemini CLI, including a second instance (`acpRegistry_gemini_2`) and a
 * Vertex sign-in under any name. Those turns bill a Google Cloud project.
 * A Google account login is not a flat-rate seat, so nothing may move a
 * thread here on its own. Antigravity's plan login is separate, but its
 * Gemini API-key and Agent Platform sign-ins also bill a Cloud project.
 */
export function isGeminiSpendProvider(provider: ServerProvider | undefined): boolean {
  if (provider === undefined) return false;
  if (/gemini|vertex/i.test(provider.instanceId)) return true;
  if (/gemini|vertex/i.test(provider.displayName ?? "")) return true;
  return /gemini|vertex|agent[-_ ]platform/i.test(provider.auth.type ?? "");
}

/**
 * Any instance whose turns are billed per token: a Claude API-key, proxy or
 * Bedrock instance, another driver signed in with an API key (Codex on an
 * OpenAI key), or Gemini / Vertex. Nothing picks one by itself. Gemini stays
 * out even when a fallback order or the project default names it.
 */
export function isPerTokenProvider(provider: ServerProvider | undefined): boolean {
  return (
    isClaudeApiKeyProvider(provider) ||
    isGeminiSpendProvider(provider) ||
    provider?.auth.type === "apiKey" ||
    provider?.auth.type === "api_key" ||
    provider?.auth.type === "bedrock" ||
    provider?.auth.apiKeyBilling === true
  );
}

/**
 * `isPerTokenProvider`, or `model` is served through a paid router or keyed
 * API (OpenRouter on Pi). The same check as `isPaidModel` in modelBilling.ts,
 * which cannot be imported here without a cycle.
 */
export function isPaidModelOn(
  provider: ServerProvider | undefined,
  model: string | undefined,
): boolean {
  return isPerTokenProvider(provider) || isPaidModelBilling(providerModelBilling(provider, model));
}

/** Suggestions need a recent successful observation, not merely an installed CLI. */
export const FALLBACK_USAGE_MAX_AGE_MS = 5 * 60_000;
export function hasUsableFallbackCapacity(
  provider: ServerProvider,
  nowMs: number,
  model?: string | null,
): boolean {
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
  const used = providerUsedPercent(provider, nowMs, model);
  // A reset passing is not evidence of renewed allowance. Refresh first.
  return used !== null && Number.isFinite(used) && used >= 0 && used < 100;
}

/**
 * Tokens a target's window keeps free for tools, instructions and the work
 * after a handoff: a quarter of the window, at least 16k. The server's
 * handoff budget (ContextHandoffBudget) holds back the same amount.
 */
export function contextHandoffReserve(window: number): number {
  return Math.max(16_000, Math.ceil(window / 4));
}

/**
 * Room a handoff must still find in the target's window after the request and
 * the reserve: the coverage note and at least the latest exchange.
 */
export const CONTEXT_FIT_MIN_HANDOFF_TOKENS = 4_096;

/**
 * What a target must hold to take a thread over. History moved to another
 * provider is compacted to a capped handoff (the coverage note plus the items
 * that fit, the rest stays readable through thread_read), so what has to fit
 * is the request that is never truncated, the reserve and that handoff.
 */
export interface ContextFitRequirement {
  /** The request sent whole: its text in bytes plus attachment allowances. */
  readonly requestTokens: number;
  /** A candidate's context window in tokens, or null when nothing reports it. */
  readonly windowOf: (selection: ModelSelection) => number | null;
}

/**
 * Whether a request and a compacted handoff fit a window, next to what a
 * reused native session already holds. An unknown window fits: refusing
 * every model that does not publish its size would refuse most of them.
 */
export function contextFits(
  window: number | null | undefined,
  requestTokens: number,
  nativeUsedTokens = 0,
): boolean {
  if (window == null || !Number.isFinite(window) || window <= 0) return true;
  return (
    window -
      Math.max(0, nativeUsedTokens) -
      Math.max(0, requestTokens) -
      contextHandoffReserve(window) >=
    CONTEXT_FIT_MIN_HANDOFF_TOKENS
  );
}

function fitsContext(fit: ContextFitRequirement | undefined, selection: ModelSelection): boolean {
  return fit === undefined || contextFits(fit.windowOf(selection), fit.requestTokens);
}

/**
 * A provider that reports no usage at all: GitHub Copilot and the other
 * agents behind ACP. Its room can only be learned by trying it, so it counts
 * as having room while it can take a turn and nothing marks it limited.
 */
export function reportsNoUsage(provider: ServerProvider): boolean {
  return provider.usageLimits === undefined;
}

/** A Cursor instance signed in with a Cursor API key (`api-key`). */
function isCursorApiKeyProvider(provider: ServerProvider): boolean {
  return provider.driver === "cursor" && /api[-_ ]?key/i.test(provider.auth.type ?? "");
}

/**
 * A target whose billing the app cannot establish, so nothing moves a thread
 * there on its own; only a fallback order, project default or provider order
 * that names it does. Two kinds: an ACP agent other than verified GitHub
 * Copilot (without usage telemetry, and missing branding is not evidence of
 * free capacity), identified by the registry icon the server derives from
 * the agent id, never the editable name; and, given `model`, a model its
 * provider itself reports as `unknown` billing (Pi or OpenCode on an
 * `anthropic` id that may be a Claude Max login or an API key). A Cursor API
 * key counts too while it reports no usage: it draws on the Cursor plan, so
 * it stays an ordinary candidate (not per-token), but only a plan usage read
 * shows that plan has room.
 */
export function isUnknownBillingAgent(
  provider: ServerProvider | undefined,
  model?: string | undefined,
): boolean {
  if (provider === undefined) return false;
  if (model !== undefined && providerModelBilling(provider, model) === "unknown") return true;
  if (isCursorApiKeyProvider(provider) && reportsNoUsage(provider)) return true;
  return (
    provider.driver === "acpRegistry" &&
    reportsNoUsage(provider) &&
    !isGitHubCopilotIcon(null, provider.iconUrl)
  );
}

/**
 * Whether the person named this instance anywhere in the rule: the fallback
 * order, the legacy fallback model, the project default or its provider
 * order. That is the consent an unknown-billing agent needs.
 */
function ruleNamesInstance(
  rule: Pick<
    ProviderFallbackRule,
    | "providerLimitFallbackModelSelection"
    | "providerLimitFallbackModels"
    | "defaultModelSelection"
    | "defaultModelProviders"
  >,
  instanceId: ProviderInstanceId,
): boolean {
  return (
    rule.providerLimitFallbackModelSelection?.instanceId === instanceId ||
    rule.defaultModelSelection?.instanceId === instanceId ||
    (rule.providerLimitFallbackModels ?? []).some((entry) => entry.instanceId === instanceId) ||
    (rule.defaultModelProviders ?? []).includes(instanceId)
  );
}

/**
 * Whether a thread may start or continue on `provider` with `model`:
 * verified room below `belowPercent`, or a provider that reports no usage
 * and can take a turn. Null when it has neither, is in `limited`, or is
 * billed per token (never picked by itself).
 */
function roomOn(
  provider: ServerProvider,
  model: string,
  input: {
    readonly nowMs: number;
    readonly belowPercent?: number | null | undefined;
    readonly limited?: ReadonlySet<string> | undefined;
    /** The person named this provider, so an unknown-billing agent may take the thread. */
    readonly named?: boolean;
  },
): "verified" | "unreported" | null {
  if (input.limited?.has(provider.instanceId) || isPaidModelOn(provider, model)) return null;
  if (input.named !== true && isUnknownBillingAgent(provider, model)) return null;
  if (reportsNoUsage(provider)) return canTakeTurn(provider) ? "unreported" : null;
  if (!hasUsableFallbackCapacity(provider, input.nowMs, model)) return null;
  const used = providerUsedPercent(provider, input.nowMs, model);
  return used !== null && (input.belowPercent == null || used < input.belowPercent)
    ? "verified"
    : null;
}

/**
 * The same model on another provider with room: Opus 5.5 on GitHub Copilot
 * when the Claude subscription is spent. Providers named in `order` come
 * first, in that order; then another account of the same driver; then
 * verified room before a provider that reports none; then list order.
 * Effort and other options carry over only within one driver, since each
 * driver spells its own. Null when no other provider lists the model or has
 * room for it.
 */
export function resolveSameModelElsewhere(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection;
  readonly order?: ReadonlyArray<ProviderInstanceId> | undefined;
  readonly nowMs: number;
  readonly belowPercent?: number | null | undefined;
  readonly limitedInstanceIds?: ReadonlySet<string> | undefined;
  /** Selections already tried for this stop (`fallbackSelectionKey`), skipped. */
  readonly excludedSelections?: ReadonlySet<string> | undefined;
  /** Models the user keeps out of automatic fallback, skipped. */
  readonly excludedModels?: ReadonlyArray<ExcludedFallbackModel> | undefined;
  /** Only candidates whose window holds the thread (see `contextFits`). */
  readonly contextFit?: ContextFitRequirement | undefined;
  /** Skip providers that report no usage: only verified room counts. */
  readonly verifiedOnly?: boolean | undefined;
}): ModelSelection | null {
  const currentProvider = input.providers.find(
    (provider) => provider.instanceId === input.current.instanceId,
  );
  const model = describeModel(currentProvider, input.current.model);
  const order = input.order ?? [];
  const listed = (provider: ServerProvider) => {
    const index = order.indexOf(provider.instanceId);
    return index === -1 ? order.length : index;
  };
  const candidates = input.providers.flatMap((provider, position) => {
    if (provider.instanceId === input.current.instanceId) return [];
    const slug = sameModelOn(provider, model);
    if (slug === undefined) return [];
    const key = fallbackSelectionKey({ instanceId: provider.instanceId, model: slug });
    if (input.excludedSelections?.has(key)) return [];
    if (isExcludedFallbackModel(input.excludedModels, provider.instanceId, slug)) return [];
    if (!fitsContext(input.contextFit, { instanceId: provider.instanceId, model: slug })) return [];
    const room = roomOn(provider, slug, {
      nowMs: input.nowMs,
      belowPercent: input.belowPercent,
      limited: input.limitedInstanceIds,
      named: order.includes(provider.instanceId),
    });
    if (room === null || (input.verifiedOnly === true && room === "unreported")) return [];
    const rank = [
      listed(provider),
      provider.driver === currentProvider?.driver ? 0 : 1,
      room === "verified" ? 0 : 1,
      position,
    ];
    return [{ provider, slug, rank }];
  });
  candidates.sort((a, b) => {
    for (let i = 0; i < a.rank.length; i++) {
      const diff = a.rank.at(i)! - b.rank.at(i)!;
      if (diff !== 0) return diff;
    }
    return 0;
  });
  const best = candidates[0];
  if (best === undefined) return null;
  return {
    instanceId: best.provider.instanceId,
    model: best.slug,
    ...(best.provider.driver === currentProvider?.driver && input.current.options !== undefined
      ? { options: input.current.options }
      : {}),
  };
}

function defaultModel(provider: ServerProvider): string | undefined {
  return (
    provider.models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    provider.models.find((model) => !model.isCustom)?.slug ??
    undefined
  );
}

/**
 * The API refused a turn because the key's account has no credits left:
 * Anthropic's "Your credit balance is too low to access the Anthropic API"
 * and Claude Code's "Credit balance too low · Add funds". Another API
 * account can take the turn; this one cannot until someone adds funds.
 */
export function isApiCreditExhaustedMessage(text: string | null | undefined): boolean {
  return typeof text === "string" && /credit balance (?:is )?too low/i.test(text);
}

/**
 * An instance that bills an API account's own credits for the driver's
 * models, so a person can move a limited subscription thread there: a Claude
 * instance on Anthropic API credits (`isDirectClaudeApiKeyProvider`), a
 * Grok instance on an xAI API key, or Codex signed in with an OpenAI API
 * key. Proxies, routers and Bedrock are billed elsewhere and do not count.
 */
export function isApiCreditProvider(provider: ServerProvider | undefined): boolean {
  if (provider === undefined) return false;
  if (provider.driver === "claudeAgent") return isDirectClaudeApiKeyProvider(provider);
  if (provider.driver === "grok") return provider.auth.type === "api_key";
  if (provider.driver === "codex") return provider.auth.type === "apiKey";
  return false;
}

/**
 * Every instance a limited thread can continue on with API credits, in
 * list order: another instance of its driver that bills an API account
 * (`isApiCreditProvider`), can take a turn and lists the thread's model.
 * The model never changes, so the continuation costs what the thread was
 * already running at. From an API-key instance this is the other API
 * accounts, for when one runs out of credits. Empty for a driver without
 * API accounts.
 */
export function resolveApiCreditSelections(input: {
  readonly excludedModels?: ReadonlyArray<ExcludedFallbackModel> | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection;
}): ReadonlyArray<ModelSelection> {
  const current = input.providers.find(
    (provider) => provider.instanceId === input.current.instanceId,
  );
  if (current === undefined) return [];
  // A proxy or Bedrock thread is already billed per token somewhere else.
  if (isPerTokenProvider(current) && !isApiCreditProvider(current)) return [];
  const selections: ModelSelection[] = [];
  for (const provider of input.providers) {
    if (provider.instanceId === current.instanceId || provider.driver !== current.driver) continue;
    if (!isApiCreditProvider(provider) || !canTakeTurn(provider)) continue;
    if (isExcludedFallbackModel(input.excludedModels, provider.instanceId, input.current.model))
      continue;
    if (provider.models.some((model) => model.slug === input.current.model))
      selections.push({ ...input.current, instanceId: provider.instanceId });
  }
  return selections;
}

/**
 * Where the API-credit rule continues a limited Claude thread: the first
 * other Claude instance with its own Anthropic API key that can take a turn
 * and lists the thread's model. The model never changes, so the price of the
 * continuation is the one the thread was already running at. From a Claude
 * subscription by default; with `rotate`, from an API-key instance whose
 * account ran out of credits to the next account. Null when there is no
 * such instance, or the thread is on neither.
 */
export function resolveApiCreditSelection(input: {
  readonly excludedModels?: ReadonlyArray<ExcludedFallbackModel> | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection;
  readonly rotate?: boolean;
}): ModelSelection | null {
  const current = input.providers.find(
    (provider) => provider.instanceId === input.current.instanceId,
  );
  if (current?.driver !== "claudeAgent") return null;
  if (
    input.rotate === true ? !isDirectClaudeApiKeyProvider(current) : isClaudeApiKeyProvider(current)
  )
    return null;
  return resolveApiCreditSelections(input)[0] ?? null;
}

/**
 * The model to continue on instead of `currentInstanceId`: the user's
 * fallback order, else the project's default model (so a thread already on a
 * fallback goes back), else the same model on another provider with room
 * (`resolveSameModelElsewhere`), else, with `anyReady`, the cheapest other
 * provider that can take a turn. A legacy single fallback keeps its old
 * place: the same model elsewhere, then that fallback, then the default. A
 * default billed per token comes only after verified room. A candidate at or past `belowPercent` is skipped so
 * two full providers never trade a thread back and forth. A provider that
 * reports no usage (GitHub Copilot) counts as having room unless
 * `limitedInstanceIds` names it, and comes after providers with verified
 * room.
 *
 * `anyReady` prefers, in order: another instance of the same driver that
 * lists `currentModel` (another account on the same model, where a Claude
 * transcript is copied across instead of summarised), then any instance of
 * the same driver, then the one with the most verified headroom left, then list order. It never picks an instance billed per token
 * (`isPerTokenProvider`), since its turns cost money: one is used only when
 * the project's default model names it, or through
 * `resolveApiCreditSelection` when the rule allows API credits.
 */
/** The user's fallback order: the list, else the legacy single model, else nothing. */
export function fallbackModelOrder(
  rule: Pick<
    ProviderFallbackRule,
    "providerLimitFallbackModels" | "providerLimitFallbackModelSelection"
  >,
): ReadonlyArray<ModelSelection> {
  if (rule.providerLimitFallbackModels && rule.providerLimitFallbackModels.length > 0)
    return rule.providerLimitFallbackModels;
  return rule.providerLimitFallbackModelSelection ? [rule.providerLimitFallbackModelSelection] : [];
}

/** A fallback order entry's identity, for sets of entries already tried. */
export function fallbackSelectionKey(selection: ModelSelection): string {
  return `${selection.instanceId}\u0000${selection.model}`;
}

/** Why an entry of the fallback order cannot take the thread now. */
export type FallbackOrderUnavailable =
  | "current"
  | "missing"
  | "limited"
  | "signed-out"
  | "per-token"
  | "full"
  /** Its context window cannot hold the thread's request and handoff. */
  | "too-small"
  /** Installed but its usage is unknown: the user may still choose it. */
  | "unverified"
  /** Not installed, not prepared or not ready on this machine: nothing can run on it. */
  | "not-ready"
  /** The user keeps this model out of automatic fallback; a manual pick may still use it. */
  | "excluded";

export interface FallbackOrderEntry {
  readonly selection: ModelSelection;
  readonly provider: ServerProvider | undefined;
  /** Null when the entry can take the thread now. */
  readonly unavailable: FallbackOrderUnavailable | null;
  /** When a full entry's windows reset, if every one names a time. */
  readonly resetAt: number | null;
}

/**
 * Each entry of the user's fallback order with whether it can take a thread
 * running on `currentInstanceId` now, in order. The thread's own instance and
 * limited instances are skipped, so one order serves Claude to Codex and back.
 */
export function describeFallbackOrder(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly currentInstanceId: ProviderInstanceId;
  readonly rule: Pick<
    ProviderFallbackRule,
    | "providerLimitFallbackModels"
    | "providerLimitFallbackModelSelection"
    | "providerLimitExcludedModels"
  >;
  readonly nowMs: number;
  readonly belowPercent?: number | null | undefined;
  readonly limitedInstanceIds?: ReadonlySet<string> | undefined;
  readonly contextFit?: ContextFitRequirement | undefined;
}): ReadonlyArray<FallbackOrderEntry> {
  return fallbackModelOrder(input.rule).map((selection) => {
    const provider = input.providers.find((entry) => entry.instanceId === selection.instanceId);
    const entry = (
      unavailable: FallbackOrderUnavailable | null,
      resetAt: number | null = null,
    ) => ({
      selection,
      provider,
      unavailable,
      resetAt,
    });
    if (selection.instanceId === input.currentInstanceId) return entry("current");
    if (
      provider === undefined ||
      !provider.models.some((model) => model.slug === selection.model && !model.isCustom)
    )
      return entry("missing");
    if (!fitsContext(input.contextFit, selection)) return entry("too-small");
    if (input.limitedInstanceIds?.has(provider.instanceId)) return entry("limited");
    if (isPaidModelOn(provider, selection.model)) return entry("per-token");
    if (!canTakeTurn(provider)) {
      if (provider.auth.status === "unauthenticated") return entry("signed-out");
      if (usageDeniesTurn(provider)) return entry("full");
      // An ACP agent that was never prepared here (or any instance that is not
      // ready) can't open a session; offering it only leads to a failed turn.
      return entry("not-ready");
    }
    // After the hard checks: an excluded entry stays a manual choice, so it
    // must still be one that can open a turn here.
    if (
      isExcludedFallbackModel(
        input.rule.providerLimitExcludedModels,
        selection.instanceId,
        selection.model,
      )
    )
      return entry("excluded");
    if (reportsNoUsage(provider)) return entry(null);
    const used = providerUsedPercent(provider, input.nowMs, selection.model);
    const threshold = input.belowPercent ?? 100;
    if (used !== null && used >= threshold)
      return entry("full", usageResetAt(provider, threshold, input.nowMs, selection.model));
    if (!hasUsableFallbackCapacity(provider, input.nowMs, selection.model))
      return entry("unverified");
    return entry(null);
  });
}

type ResolveProviderFallbackInput = Parameters<typeof resolveProviderFallbackPass>[0];

/**
 * Verified room wins over a guess: every step runs first with providers
 * that report no usage (GitHub Copilot and the other ACP agents) left out,
 * except where the user named them (the fallback order, the legacy fallback
 * model, and the project default when a context overflow sends the thread
 * home), and the coordinator's own model, which a recent turn proved (see
 * `provenFallbackSelection`). Only when nothing with a fresh usage read below the threshold can
 * take the thread does a no-usage provider get it. A no-usage provider has
 * no read to show it spent, so preferring it sent a coordinator from a full
 * Codex onto an exhausted Copilot while Claude Code had room.
 */
export function resolveProviderFallback(
  input: ResolveProviderFallbackInput,
): ModelSelection | null {
  return (
    resolveProviderFallbackPass({ ...input, verifiedOnly: true }) ??
    resolveProviderFallbackPass({ ...input, verifiedOnly: false })
  );
}

function resolveProviderFallbackPass(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly currentInstanceId: ProviderInstanceId;
  /** The model the thread runs on, kept when another account of its driver lists it. */
  readonly currentModel?: string | undefined;
  /** The thread's options on `currentModel` (effort); kept by a same-driver same-model fallback. */
  readonly currentOptions?: ModelSelection["options"] | undefined;
  readonly rule: Pick<
    ProviderFallbackRule,
    | "providerLimitFallbackModelSelection"
    | "providerLimitFallbackModels"
    | "providerLimitFallbackListOnly"
    | "providerLimitExcludedModels"
    | "defaultModelSelection"
    | "defaultModelProviders"
  >;
  readonly nowMs: number;
  readonly belowPercent?: number | null;
  readonly anyReady?: boolean;
  /** Instances known to be limited whatever their usage read says (a current limit stop). */
  readonly limitedInstanceIds?: ReadonlySet<string>;
  /**
   * A model working right now without a usage read behind it: the project
   * coordinator's own (see `provenFallbackSelection`). Tried after the rule's
   * fallback and the project default, before any other ready provider.
   */
  readonly proven?: ModelSelection | null;
  /** Fallback order entries already tried for this stop (`fallbackSelectionKey`), skipped. */
  readonly excludedSelections?: ReadonlySet<string>;
  /**
   * Every step skips a target whose window cannot hold the thread's request
   * and its compacted handoff (see `contextFits`).
   */
  readonly contextFit?: ContextFitRequirement | undefined;
  /**
   * Try the project's default model first, before the fallback order: the
   * thread goes home once home has room. Used after a context overflow,
   * which says nothing about home's usage.
   */
  readonly preferDefault?: boolean;
  /** Internal: leave out providers that report no usage unless the user named them. */
  readonly verifiedOnly?: boolean;
}): ModelSelection | null {
  const verifiedOnly = input.verifiedOnly === true;
  // Every step below skips what this stop already tried, not only the user's order,
  // and every target whose window cannot hold the thread.
  const excluded = (instanceId: ProviderInstanceId, model: string | undefined) =>
    model !== undefined &&
    ((input.excludedSelections?.has(fallbackSelectionKey({ instanceId, model })) ?? false) ||
      isExcludedFallbackModel(input.rule.providerLimitExcludedModels, instanceId, model) ||
      !fitsContext(input.contextFit, { instanceId, model }));
  const usable = (
    provider: ServerProvider | undefined,
    model: string | undefined,
    allowUnreported = !verifiedOnly,
  ): provider is ServerProvider => {
    if (provider === undefined || provider.instanceId === input.currentInstanceId) return false;
    if (input.limitedInstanceIds?.has(provider.instanceId)) return false;
    // Gemini and Vertex bill a Cloud project even when a read shows room
    // or the project default names them. Other API keys that report usage
    // can still be that default; one that reports none needs the API-credit
    // rule, never a guess. A model billed per token by its router or API never is.
    if (
      isGeminiSpendProvider(provider) ||
      isPaidModelBilling(providerModelBilling(provider, model))
    )
      return false;
    if (reportsNoUsage(provider))
      return allowUnreported && canTakeTurn(provider) && !isPerTokenProvider(provider);
    if (!hasUsableFallbackCapacity(provider, input.nowMs, model)) return false;
    const used = providerUsedPercent(provider, input.nowMs, model);
    return used !== null && (input.belowPercent == null || used < input.belowPercent);
  };
  const firstAvailable = () =>
    describeFallbackOrder({
      providers: input.providers,
      currentInstanceId: input.currentInstanceId,
      rule: input.rule,
      nowMs: input.nowMs,
      belowPercent: input.belowPercent,
      limitedInstanceIds: input.limitedInstanceIds,
      contextFit: input.contextFit,
    }).find(
      (entry) =>
        entry.unavailable === null &&
        !input.excludedSelections?.has(fallbackSelectionKey(entry.selection)),
    )?.selection;
  const home = (allowUnreported = !verifiedOnly) => {
    const selection = input.rule.defaultModelSelection;
    if (selection === null) return null;
    const provider = input.providers.find((entry) => entry.instanceId === selection.instanceId);
    return usable(provider, selection.model, allowUnreported) &&
      !excluded(provider.instanceId, selection.model) &&
      provider.models.some((model) => model.slug === selection.model && !model.isCustom)
      ? selection
      : null;
  };
  // Going home after a context overflow is the user's own choice, like the
  // fallback order: a home that reports no usage is not held back for
  // verified room elsewhere.
  if (input.preferDefault === true) {
    const back = home(true);
    if (back !== null) return back;
  }
  // A fallback order the user set comes first: it is the strongest statement
  // of intent. The legacy single model keeps its old place, after the same
  // model elsewhere and ahead of the project default.
  // "Only these models" makes even the legacy single model the whole chain.
  const listOnly =
    input.rule.providerLimitFallbackListOnly === true && fallbackModelOrder(input.rule).length > 0;
  const explicitOrder = (input.rule.providerLimitFallbackModels?.length ?? 0) > 0 || listOnly;
  const legacyOnly = !explicitOrder && fallbackModelOrder(input.rule).length > 0;
  if (explicitOrder) {
    const ordered = firstAvailable();
    if (ordered !== undefined) return ordered;
    // The user said this list is the whole chain: past it the thread waits.
    if (listOnly) return null;
  }
  const same =
    input.currentModel === undefined
      ? null
      : resolveSameModelElsewhere({
          providers: input.providers,
          current: {
            instanceId: input.currentInstanceId,
            model: input.currentModel,
            ...(input.currentOptions === undefined ? {} : { options: input.currentOptions }),
          },
          order: input.rule.defaultModelProviders,
          nowMs: input.nowMs,
          belowPercent: input.belowPercent,
          limitedInstanceIds: input.limitedInstanceIds,
          excludedSelections: input.excludedSelections,
          excludedModels: input.rule.providerLimitExcludedModels,
          contextFit: input.contextFit,
          verifiedOnly,
        });
  const sameTarget =
    same === null
      ? undefined
      : input.providers.find((entry) => entry.instanceId === same.instanceId);
  // The same model on an account whose usage read shows room keeps the
  // transcript and the model, so it goes first.
  if (same !== null && sameTarget !== undefined && !reportsNoUsage(sameTarget)) return same;
  // The way home: a thread on a fallback whose own fallback stopped goes back
  // to the project's default model when that has room, before trying the
  // same model on a provider without a usage read (a second Copilot account
  // that may share the first one's quota).
  if (!legacyOnly) {
    const back = home();
    if (back !== null) return back;
  }
  // A default billed per token (a Claude CLI signed in to the Console) counts
  // too: the user named that instance, so its spend is theirs to choose. It
  // never shows a usage read, so free room the reads verify still comes
  // first; it only outranks a provider that reports no usage either. Gemini
  // and Vertex stay out here too.
  const homeSelection = input.rule.defaultModelSelection;
  const homeProvider =
    homeSelection === null
      ? undefined
      : input.providers.find((entry) => entry.instanceId === homeSelection.instanceId);
  const perTokenHome =
    homeSelection !== null &&
    homeProvider !== undefined &&
    isPerTokenProvider(homeProvider) &&
    !isGeminiSpendProvider(homeProvider) &&
    homeSelection.instanceId !== input.currentInstanceId &&
    !input.limitedInstanceIds?.has(homeSelection.instanceId) &&
    !excluded(homeSelection.instanceId, homeSelection.model) &&
    homeProvider.models.some((model) => model.slug === homeSelection.model && !model.isCustom) &&
    canTakeTurn(homeProvider)
      ? homeSelection
      : null;
  if (same !== null && perTokenHome === null) return same;
  if (legacyOnly) {
    const legacy = firstAvailable();
    if (legacy !== undefined) return legacy;
    const back = home();
    if (back !== null) return back;
  }
  const proven = input.proven ?? null;
  if (
    proven !== null &&
    proven.instanceId !== input.currentInstanceId &&
    !excluded(proven.instanceId, proven.model)
  ) {
    const provider = input.providers.find((entry) => entry.instanceId === proven.instanceId);
    const used =
      provider === undefined ? null : providerUsedPercent(provider, input.nowMs, proven.model);
    if (
      provider !== undefined &&
      !input.limitedInstanceIds?.has(provider.instanceId) &&
      canTakeTurn(provider) &&
      !isPaidModelOn(provider, proven.model) &&
      !isUnknownBillingAgent(provider, proven.model) &&
      (perTokenHome === null || !reportsNoUsage(provider)) &&
      (used === null || used < (input.belowPercent ?? 100))
    ) {
      // The same model through the same driver takes the thread's options too.
      const currentDriver = input.providers.find(
        (entry) => entry.instanceId === input.currentInstanceId,
      )?.driver;
      return {
        instanceId: proven.instanceId,
        model: proven.model,
        ...(provider.driver === currentDriver &&
        proven.model === input.currentModel &&
        input.currentOptions !== undefined
          ? { options: input.currentOptions }
          : {}),
      };
    }
  }
  if (!input.anyReady) return perTokenHome;
  const driver = input.providers.find(
    (provider) => provider.instanceId === input.currentInstanceId,
  )?.driver;
  const sameModel = (provider: ServerProvider) =>
    provider.driver === driver &&
    input.currentModel !== undefined &&
    // Only the user's exclusion moves on to another model of this account; one
    // this stop already tried there rules the whole account out below.
    !isExcludedFallbackModel(
      input.rule.providerLimitExcludedModels,
      provider.instanceId,
      input.currentModel,
    ) &&
    provider.models.some((model) => model.slug === input.currentModel && !model.isCustom);
  // Lower is cheaper: the same model elsewhere, the same driver, then headroom.
  // Its default model, or, when the user excluded that one, its first listed
  // model still allowed: excluding GPT-6.1 Sol must not rule out Codex.
  const candidateModel = (provider: ServerProvider) => {
    if (sameModel(provider)) return input.currentModel;
    const preferred = defaultModel(provider);
    const allowed = (slug: string | undefined) =>
      !isExcludedFallbackModel(input.rule.providerLimitExcludedModels, provider.instanceId, slug);
    if (preferred === undefined || allowed(preferred)) return preferred;
    return provider.models.find((model) => !model.isCustom && allowed(model.slug))?.slug;
  };
  const rank = (provider: ServerProvider): [number, number] => [
    sameModel(provider) ? 0 : provider.driver === driver ? 1 : 2,
    providerUsedPercent(provider, input.nowMs, candidateModel(provider)) ?? 101,
  ];
  const candidates = input.providers
    .filter(
      (provider) =>
        usable(provider, candidateModel(provider)) &&
        (perTokenHome === null || !reportsNoUsage(provider)) &&
        !isPaidModelOn(provider, candidateModel(provider)) &&
        !isUnknownBillingAgent(provider, candidateModel(provider)) &&
        !excluded(provider.instanceId, candidateModel(provider)),
    )
    .map((provider, order) => ({ provider, order, rank: rank(provider) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.order - b.order);
  for (const { provider } of candidates) {
    const model = candidateModel(provider);
    // The same model through the same driver takes the thread's options too.
    if (model !== undefined)
      return {
        instanceId: provider.instanceId,
        model,
        ...(sameModel(provider) && input.currentOptions !== undefined
          ? { options: input.currentOptions }
          : {}),
      };
  }
  return perTokenHome;
}

/**
 * The project coordinator's model as a fallback for one of its threads, or
 * null. The coordinator ran on it moments ago, which is better evidence of
 * room than a usage read some providers never give (Copilot and the other
 * agents that report no usage would otherwise never count as a fallback).
 * Null when the coordinator is the thread itself, already runs where the
 * thread does, or its own latest turn stopped on the limit.
 */
export function provenFallbackSelection(
  thread: { readonly id: ThreadId; readonly providerInstanceId: ProviderInstanceId },
  coordinator:
    | {
        readonly id: ThreadId;
        readonly providerInstanceId: ProviderInstanceId;
        readonly modelSelection: ModelSelection;
        readonly status: string;
        readonly lastErrorClass?: string | null | undefined;
      }
    | null
    | undefined,
): ModelSelection | null {
  if (!coordinator || coordinator.id === thread.id) return null;
  if (coordinator.providerInstanceId === thread.providerInstanceId) return null;
  if (coordinator.status === "failed" && coordinator.lastErrorClass === "usage_limit") return null;
  return coordinator.modelSelection;
}

export type WorkerLaunchSelectionReason =
  | "preferred"
  | "preferred-resets-soon"
  | "waits-for-reset"
  | "same-model"
  | "coordinator"
  | "fallback"
  | "no-room";

/**
 * The model a project worker starts on when the coordinator names none. The
 * project's recommended model (or the host default) wins while its provider
 * has room. A new thread has nothing to hand over, so starting it on a
 * provider that is out of room only produces a stop: then it starts on the
 * same model from another provider (the project's `defaultModelProviders`
 * order first), else on the model the coordinator itself runs on, which is
 * working right now, else on the cheapest other provider with room. The `wait` rule and a reset
 * within the project's wait keep the preferred model, as they do for a
 * stopped turn. A provider billed per token is never picked here.
 */
export function resolveWorkerLaunchSelection(input: {
  readonly preferred: ModelSelection;
  /** The coordinator's current model; it is calling, so a turn on it is running now. */
  readonly coordinator: ModelSelection | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly rule: ProviderFallbackRule;
  readonly nowMs: number;
  readonly limitedInstanceIds?: ReadonlySet<string>;
}): { readonly selection: ModelSelection; readonly reason: WorkerLaunchSelectionReason } {
  const threshold = input.rule.providerLimitSwitchAtPercent ?? 100;
  const limited = input.limitedInstanceIds ?? new Set<string>();
  const preferred = input.preferred;
  const preferredProvider = input.providers.find(
    (provider) => provider.instanceId === preferred.instanceId,
  );
  const full = (provider: ServerProvider | undefined, model: string): boolean => {
    if (provider === undefined) return false;
    if (limited.has(provider.instanceId) || usageDeniesTurn(provider)) return true;
    const used = providerUsedPercent(provider, input.nowMs, model);
    return used !== null && used >= threshold;
  };
  if (!full(preferredProvider, preferred.model))
    return { selection: preferred, reason: "preferred" };
  if (input.rule.providerLimitAction === "wait")
    return { selection: preferred, reason: "waits-for-reset" };
  if (
    !limited.has(preferred.instanceId) &&
    usageResetsSoon({
      provider: preferredProvider,
      threshold,
      waitUnderMinutes: input.rule.providerLimitWaitUnderMinutes,
      nowMs: input.nowMs,
      model: preferred.model,
    })
  )
    return { selection: preferred, reason: "preferred-resets-soon" };
  const same = resolveSameModelElsewhere({
    providers: input.providers,
    current: preferred,
    order: input.rule.defaultModelProviders,
    nowMs: input.nowMs,
    belowPercent: threshold,
    limitedInstanceIds: limited,
    // A provider that reports no usage only gets the worker once nothing
    // with verified room does (see resolveProviderFallback).
    verifiedOnly: true,
    excludedModels: input.rule.providerLimitExcludedModels,
  });
  if (same !== null) return { selection: same, reason: "same-model" };
  const coordinator = input.coordinator;
  if (coordinator !== null && coordinator.instanceId !== preferred.instanceId) {
    const provider = input.providers.find((entry) => entry.instanceId === coordinator.instanceId);
    if (
      provider !== undefined &&
      canTakeTurn(provider) &&
      !isPaidModelOn(provider, coordinator.model) &&
      !isUnknownBillingAgent(provider, coordinator.model) &&
      !full(provider, coordinator.model) &&
      !isExcludedFallbackModel(
        input.rule.providerLimitExcludedModels,
        coordinator.instanceId,
        coordinator.model,
      )
    )
      return {
        selection: {
          instanceId: coordinator.instanceId,
          model: coordinator.model,
          // The same model through the same driver takes the worker's options too.
          ...(provider.driver === preferredProvider?.driver &&
          coordinator.model === preferred.model &&
          preferred.options !== undefined
            ? { options: preferred.options }
            : {}),
        },
        reason: "coordinator",
      };
  }
  const target = resolveProviderFallback({
    providers: input.providers,
    currentInstanceId: preferred.instanceId,
    currentModel: preferred.model,
    currentOptions: preferred.options,
    rule: {
      providerLimitFallbackModelSelection: input.rule.providerLimitFallbackModelSelection,
      providerLimitFallbackModels: input.rule.providerLimitFallbackModels,
      providerLimitFallbackListOnly: input.rule.providerLimitFallbackListOnly,
      providerLimitExcludedModels: input.rule.providerLimitExcludedModels,
      defaultModelSelection: null,
      defaultModelProviders: input.rule.defaultModelProviders,
    },
    nowMs: input.nowMs,
    belowPercent: threshold,
    anyReady: true,
    limitedInstanceIds: limited,
  });
  if (target === null) return { selection: preferred, reason: "no-room" };
  const targetProvider = input.providers.find(
    (provider) => provider.instanceId === target.instanceId,
  );
  // The unreported-capacity pass may keep the same driver and model. Classify its final
  // choice without moving that account ahead of verified free capacity.
  const keepsModel =
    targetProvider !== undefined &&
    targetProvider.driver === preferredProvider?.driver &&
    sameModelOn(targetProvider, describeModel(preferredProvider, preferred.model)) === target.model;
  return { selection: target, reason: keepsModel ? "same-model" : "fallback" };
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
  model?: string | null,
): number | null {
  let latest: number | null = null;
  for (const window of provider?.usageLimits?.windows ?? []) {
    const resetsAt = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    if (!isLiveWindow(window, nowMs) || !windowAppliesToModel(window, model)) continue;
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
  readonly model?: string | null | undefined;
}): boolean {
  const wait = waitMs(input.waitUnderMinutes);
  if (wait === 0) return false;
  const resetAt = usageResetAt(input.provider, input.threshold, input.nowMs, input.model);
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
  /** The model the turn runs on: model-scoped windows count only for it. */
  readonly model?: string | null | undefined;
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
  /** The model the turn runs on: model-scoped windows count only for it. */
  readonly model?: string | null | undefined;
  readonly rule: Pick<
    ProviderFallbackRule,
    "providerLimitSwitchAtPercent" | "providerLimitWaitUnderMinutes"
  >;
  readonly nowMs: number;
}): boolean {
  const threshold = input.rule.providerLimitSwitchAtPercent;
  if (threshold === null || input.provider === undefined) return false;
  const used = providerUsedPercent(input.provider, input.nowMs, input.model);
  if (used === null || used < threshold) return false;
  return !usageResetsSoon({
    provider: input.provider,
    threshold,
    waitUnderMinutes: input.rule.providerLimitWaitUnderMinutes,
    nowMs: input.nowMs,
    model: input.model,
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
  /**
   * The stop behind `savedStoppedAtMs` was a subscription plan limit (Claude's
   * "You've hit your session limit"). Once the saved instance bills API
   * credits instead (its CLI signed in to the Claude Console), that limit no
   * longer applies and the coordinator goes back to it.
   */
  readonly savedStopWasPlanLimit?: boolean;
}): { readonly selection: ModelSelection; readonly reason: CoordinatorTurnSelectionReason } {
  const threshold = input.rule.providerLimitSwitchAtPercent ?? 100;
  const limited = input.limitedInstanceIds ?? new Set<string>();
  const full = (provider: ServerProvider | undefined, model: string): boolean => {
    if (provider === undefined) return false;
    if (limited.has(provider.instanceId)) return true;
    if (usageDeniesTurn(provider)) return true;
    const used = providerUsedPercent(provider, input.nowMs, model);
    return used !== null && used >= threshold;
  };
  const savedProvider = input.providers.find(
    (provider) => provider.instanceId === input.saved.instanceId,
  );
  const planLimitOutlived =
    input.savedStopWasPlanLimit === true && isApiCreditProvider(savedProvider);
  const stoppedAt = planLimitOutlived ? null : (input.savedStoppedAtMs ?? null);
  const readAt = Date.parse(savedProvider?.usageLimits?.checkedAt ?? "");
  const readSinceStop =
    savedProvider !== undefined &&
    Number.isFinite(readAt) &&
    stoppedAt !== null &&
    readAt > stoppedAt &&
    savedProvider.usageLimits?.unavailable === undefined &&
    providerUsedPercent(savedProvider, input.nowMs, input.saved.model) !== null;
  const stoppedRecently =
    stoppedAt !== null &&
    input.nowMs - stoppedAt < COORDINATOR_LIMIT_STOP_MAX_AGE_MS &&
    !readSinceStop;
  if (!stoppedRecently && !full(savedProvider, input.saved.model))
    return { selection: input.saved, reason: "saved" };
  if (
    !stoppedRecently &&
    !limited.has(input.saved.instanceId) &&
    usageResetsSoon({
      provider: savedProvider,
      threshold,
      waitUnderMinutes: input.rule.providerLimitWaitUnderMinutes,
      nowMs: input.nowMs,
      model: input.saved.model,
    })
  )
    return { selection: input.saved, reason: "saved-resets-soon" };
  const thread = input.thread;
  if (thread !== null && thread.instanceId !== input.saved.instanceId) {
    const current = input.providers.find((provider) => provider.instanceId === thread.instanceId);
    // Gemini/Vertex never continue as an automatic fallback, including one
    // selected before this guard, nor does a model a paid router or API bills.
    // API-credit consent applies to other providers. An unknown-billing agent
    // (Devin) stays only when the person named it, as it may only be picked.
    const paid =
      isGeminiSpendProvider(current) ||
      isPaidModelBilling(providerModelBilling(current, thread.model)) ||
      (isPerTokenProvider(current) && input.rule.providerLimitUseApiCredits !== true) ||
      (isUnknownBillingAgent(current, thread.model) &&
        !ruleNamesInstance(input.rule, thread.instanceId));
    if (
      current !== undefined &&
      !paid &&
      canTakeTurn(current) &&
      !full(current, thread.model) &&
      !isExcludedFallbackModel(
        input.rule.providerLimitExcludedModels,
        thread.instanceId,
        thread.model,
      )
    )
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
    currentOptions: input.saved.options,
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

/**
 * Whether a coordinator that runs on another model than its saved one is
 * there because the saved provider has no room: the same test its next turn
 * makes. A coordinator moved for any other reason (a scheduled run, a turn
 * whose limit has since reset) returns to the saved model with its next
 * message, so nothing should say its limit was reached.
 */
export function coordinatorOnLimitFallback(input: {
  readonly saved: ModelSelection;
  readonly thread: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly rule: ProviderFallbackRule;
  readonly nowMs: number;
  readonly limitedInstanceIds?: ReadonlySet<string>;
}): boolean {
  if (input.thread.instanceId === input.saved.instanceId) return false;
  const { reason } = resolveCoordinatorTurnSelection(input);
  return reason !== "saved" && reason !== "saved-resets-soon";
}

/** Why the coordinator runs off its saved model, for the line that says so. */
export interface CoordinatorFallbackReason {
  /** `weekly limit reached`, `session at 96% used`, `returned a usage limit`. */
  readonly text: string;
  /** When the saved model gets room again, if the reading says. */
  readonly resetsAt: number | null;
}

/**
 * The reason behind a limit fallback, read from the same windows the switch
 * used: a spent window that applies to the saved model, one past the rule's
 * threshold, a usage-limit response, or the provider refusing new usage.
 */
export function coordinatorFallbackReason(input: {
  readonly saved: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly rule: ProviderFallbackRule;
  readonly nowMs: number;
  readonly limitedInstanceIds?: ReadonlySet<string>;
}): CoordinatorFallbackReason {
  const provider = input.providers.find((entry) => entry.instanceId === input.saved.instanceId);
  const threshold = input.rule.providerLimitSwitchAtPercent ?? 100;
  const windows = (provider?.usageLimits?.windows ?? []).filter(
    (window) =>
      isLiveWindow(window, input.nowMs) && windowAppliesToModel(window, input.saved.model),
  );
  const resetOf = (window: (typeof windows)[number]) => {
    const at = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    return Number.isFinite(at) ? at : null;
  };
  const lower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);
  // The spent window that resets last is the one that keeps the model out.
  const spent = windows
    .filter((window) => window.usedPercent >= 100)
    .sort((a, b) => (resetOf(b) ?? Infinity) - (resetOf(a) ?? Infinity))[0];
  if (spent) return { text: `${lower(spent.label)} limit reached`, resetsAt: resetOf(spent) };
  if (input.limitedInstanceIds?.has(input.saved.instanceId))
    return {
      text: "returned a usage limit",
      resetsAt: usageResetAt(provider, threshold, input.nowMs, input.saved.model),
    };
  const fullest = windows
    .filter((window) => window.usedPercent >= threshold)
    .sort((a, b) => b.usedPercent - a.usedPercent)[0];
  if (fullest)
    return {
      text: `${lower(fullest.label)} at ${Math.round(fullest.usedPercent)}% used`,
      resetsAt: resetOf(fullest),
    };
  if (provider && usageDeniesTurn(provider)) return { text: "refuses new usage", resetsAt: null };
  return { text: "has no room", resetsAt: null };
}
