/**
 * The advisor: which model reviews a running thread's work, and by which
 * route. A Claude thread advised by a stronger Claude model uses Claude's own
 * advisor (Anthropic reads the whole conversation inside the same request);
 * every other pair goes through the studio-code `advisor` tool, which sends a
 * budgeted brief to a child session. The order is walked by the fallback
 * system, so sign-in, usage, per-token billing and exclusions follow the same
 * rules as a reviewer or a limited thread's fallback.
 *
 * @module advisor
 */
import type {
  AdvisorSettings,
  ModelSelection,
  ProviderInstanceId,
  ProviderModelTier,
  ProviderModelTiers,
  ServerProvider,
  ThreadAdvisorMode,
} from "@specweave-studio/contracts";

import { reviewerChain, usageNeverRead } from "./adversarialReview.ts";
import { describeModel, isSameModel, sameModelOn } from "./modelIdentity.ts";
import { fallbackSelectionKey } from "./modelTiers.ts";
import { builtInTrackSelection, isHeldSource, providersForModel } from "./modelTracks.ts";
import {
  describeFallbackOrder,
  type ExcludedFallbackModel,
  type FallbackOrderUnavailable,
  isGeminiSpendProvider,
  isPerTokenProvider,
  isUnknownBillingAgent,
} from "./providerFallback.ts";

/** The first advisor of the built-in order. */
export const DEFAULT_ADVISOR_MODEL = {
  model: "claude-fable-5-2",
  name: "Claude Fable 5.2",
} as const;

// ── Is the advisor on for this thread ────────────────────────────────

export interface ThreadAdvisorState {
  readonly enabled: boolean;
  /** Whose choice it is: the thread's own, or the project and machine setting. */
  readonly source: "thread" | "settings";
}

/**
 * Whether a thread may consult: its own choice when it made one, else the
 * project's setting (already merged over the machine's).
 */
export function threadAdvisorState(
  mode: ThreadAdvisorMode | null | undefined,
  settings: Pick<AdvisorSettings, "enabled">,
): ThreadAdvisorState {
  if (mode === "on" || mode === "off") return { enabled: mode === "on", source: "thread" };
  return { enabled: settings.enabled, source: "settings" };
}

// ── The advisor order ────────────────────────────────────────────────

export interface AdvisorOrderInput {
  readonly providers: ReadonlyArray<ServerProvider>;
  /** The saved advisor model, tried first; null uses the built-in order alone. */
  readonly model: ModelSelection | null;
  /** The project's Review track: its saved reviewers, or empty for the built-in one. */
  readonly reviewers: ReadonlyArray<ModelSelection>;
  readonly tier: ProviderModelTier;
  readonly tiers?: ProviderModelTiers | undefined;
  /** The saved Sources order (`defaultModelProviders`): which source of a model is tried first. */
  readonly sourceOrder?: ReadonlyArray<ProviderInstanceId> | undefined;
}

/**
 * The advisor order: the saved model, then Claude Fable 5.2 on each source
 * billed by plan, then the Review track. Duplicates keep their first place.
 */
export function advisorOrder(input: AdvisorOrderInput): ReadonlyArray<ModelSelection> {
  // Never a source billed per token or with unknown billing: the built-in
  // entry is nobody's spending choice.
  const fable = providersForModel({
    providers: input.providers,
    model: { slug: DEFAULT_ADVISOR_MODEL.model },
    order: input.sourceOrder,
  })
    .filter(({ provider, slug }) => !isHeldSource(provider, slug))
    .map(({ provider, slug }) => builtInTrackSelection({}, provider, slug));
  const review = reviewerChain({
    providers: input.providers,
    reviewers: input.reviewers,
    tier: input.tier,
    tiers: input.tiers,
    sourceOrder: input.sourceOrder,
  });
  const seen = new Set<string>();
  return [...(input.model === null ? [] : [input.model]), ...fable, ...review].filter((entry) => {
    const key = fallbackSelectionKey(entry);
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

/** Why an entry of the advisor order was passed over. */
export type AdvisorSkipReason = FallbackOrderUnavailable | "same-model" | "unknown-billing";

export interface AdvisorSkip {
  readonly selection: ModelSelection;
  readonly reason: AdvisorSkipReason;
}

export interface AdvisorResolution {
  /** The model that advises, or null when no entry can. */
  readonly advisor: ModelSelection | null;
  /** Entries passed over before the advisor, in order, with why. */
  readonly skipped: ReadonlyArray<AdvisorSkip>;
}

/**
 * The first entry of the advisor order that can run now and is not the
 * thread's own model, on any source: a model does not advise itself. Only the
 * saved model counts as consent to Gemini spend or unknown billing; the
 * built-in order never picks either. As for reviewers, an entry whose usage
 * was never read keeps its place, and a stale reading yields to an entry with
 * known room.
 */
export function resolveAdvisor(
  input: AdvisorOrderInput & {
    /** The model the consulting thread runs on. */
    readonly thread: ModelSelection;
    readonly excludedModels?: ReadonlyArray<ExcludedFallbackModel> | undefined;
    readonly nowMs: number;
    readonly limitedInstanceIds?: ReadonlySet<string> | undefined;
  },
): AdvisorResolution {
  const providerOf = (selection: Pick<ModelSelection, "instanceId">) =>
    input.providers.find((provider) => provider.instanceId === selection.instanceId);
  const threadNames = describeModel(providerOf(input.thread), input.thread.model);
  const entries = describeFallbackOrder({
    providers: input.providers,
    currentInstanceId: input.thread.instanceId,
    currentModel: input.thread.model,
    rule: {
      providerLimitFallbackModels: advisorOrder(input),
      providerLimitFallbackModelSelection: null,
      providerLimitExcludedModels: input.excludedModels ?? [],
    },
    nowMs: input.nowMs,
    limitedInstanceIds: input.limitedInstanceIds,
  });
  const named = new Set(input.model === null ? [] : [fallbackSelectionKey(input.model)]);
  const skipped: AdvisorSkip[] = [];
  let unverified: ModelSelection | null = null;
  for (const entry of entries) {
    const provider = providerOf(entry.selection);
    const key = fallbackSelectionKey(entry.selection);
    const sameModel =
      entry.unavailable === "current" ||
      isSameModel(threadNames, describeModel(provider, entry.selection.model));
    const unnamedSpend = !named.has(key) && isGeminiSpendProvider(provider);
    const unconsented = !named.has(key) && isUnknownBillingAgent(provider, entry.selection.model);
    const reason: AdvisorSkipReason | null = sameModel
      ? "same-model"
      : unnamedSpend
        ? "per-token"
        : unconsented && (entry.unavailable === null || entry.unavailable === "unverified")
          ? "unknown-billing"
          : entry.unavailable;
    if (reason === null || (reason === "unverified" && usageNeverRead(provider)))
      return { advisor: entry.selection, skipped };
    if (reason === "unverified" && unverified === null) unverified = entry.selection;
    skipped.push({ selection: entry.selection, reason });
  }
  if (unverified !== null) {
    const target = fallbackSelectionKey(unverified);
    const index = skipped.findIndex((skip) => fallbackSelectionKey(skip.selection) === target);
    return { advisor: unverified, skipped: skipped.slice(0, index) };
  }
  return { advisor: null, skipped };
}

/** Short words for a skip reason, for refusals and notices. */
export const ADVISOR_SKIP_NOTES: Record<AdvisorSkipReason, string> = {
  "same-model": "the model this thread runs on",
  current: "the model this thread runs on",
  missing: "not offered by that provider",
  limited: "at its usage limit",
  "signed-out": "signed out",
  "per-token": "billed per token",
  full: "usage full",
  "too-small": "context too small",
  unverified: "usage unknown",
  "not-ready": "not ready on this machine",
  excluded: "kept out of automatic use",
  "unknown-billing": "billing unknown; save it as the advisor model to use it",
};

// ── Claude's own advisor ─────────────────────────────────────────────

/**
 * How strong Anthropic rates each Claude model as an advisor. Claude's own
 * advisor accepts a pair only when the advisor's rank is at least 2 and at
 * least the working model's. A model missing here is never paired.
 */
const CLAUDE_ADVISOR_RANKS: ReadonlyArray<readonly [slug: string, rank: number]> = [
  ["claude-haiku-4-5", 1],
  ["claude-sonnet-4-6", 2],
  ["claude-opus-4-6", 3],
  ["claude-sonnet-5", 4],
  ["claude-haiku-5-5", 4],
  ["claude-opus-4-7", 5],
  ["claude-opus-4-8", 5],
  ["claude-sonnet-5-5", 6],
  ["claude-opus-5", 7],
  ["claude-opus-5-5", 7],
  ["claude-fable-5", 8],
  ["claude-mythos-5", 8],
  ["claude-fable-5-1", 9],
  ["claude-mythos-5-1", 9],
  ["claude-fable-5-2", 10],
  ["claude-mythos-5-2", 10],
];
const CLAUDE_ADVISOR_RANK_BY_SLUG = new Map(CLAUDE_ADVISOR_RANKS);
const MIN_CLAUDE_ADVISOR_RANK = 2;

/** The slug without a context-window tag (`[1m]`) or a dated snapshot suffix. */
function canonicalClaudeSlug(slug: string): string {
  return slug
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/u, "")
    .replace(/-\d{8}$/u, "")
    .replace(/(\d)\.(\d)/gu, "$1-$2");
}

/** The advisor rank of a Claude model, or null when it has none known. */
export function claudeAdvisorRank(slug: string): number | null {
  return CLAUDE_ADVISOR_RANK_BY_SLUG.get(canonicalClaudeSlug(slug)) ?? null;
}

/** Whether Claude's own advisor accepts `advisor` for a thread on `thread`. */
export function claudeAdvisorPairAllowed(thread: string, advisor: string): boolean {
  const threadRank = claudeAdvisorRank(thread);
  const advisorRank = claudeAdvisorRank(advisor);
  if (threadRank === null || advisorRank === null) return false;
  // A model does not advise itself here, though Claude would allow it.
  if (canonicalClaudeSlug(thread) === canonicalClaudeSlug(advisor)) return false;
  return advisorRank >= MIN_CLAUDE_ADVISOR_RANK && advisorRank >= threadRank;
}

/**
 * The model Claude's own advisor would run for this thread, as the thread's
 * account spells it, or null when the pair must use the studio-code tool:
 * the thread is not on Claude Code signed in to a plan, the advisor is not a
 * Claude model that account lists, or the ranks do not allow the pair.
 */
export function claudeBuiltInAdvisorModel(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly thread: ModelSelection;
  /** The advisor `resolveAdvisor` picked. */
  readonly advisor: ModelSelection | null;
}): string | null {
  if (input.advisor === null) return null;
  const threadProvider = input.providers.find(
    (provider) => provider.instanceId === input.thread.instanceId,
  );
  if (threadProvider === undefined || threadProvider.driver !== "claudeAgent") return null;
  // An API key, a proxy token or Bedrock bills each advisor read per token.
  if (isPerTokenProvider(threadProvider)) return null;
  const advisorProvider = input.providers.find(
    (provider) => provider.instanceId === input.advisor!.instanceId,
  );
  if (advisorProvider?.driver !== "claudeAgent") return null;
  // The advisor runs on the thread's own account, under that account's name for it.
  const slug = sameModelOn(threadProvider, describeModel(advisorProvider, input.advisor.model));
  if (slug === undefined) return null;
  return claudeAdvisorPairAllowed(input.thread.model, slug) ? slug : null;
}

export type AdvisorRoute = "built-in" | "studio";

/**
 * Which route a Claude thread that may use Claude's own advisor takes for its
 * next turn. Claude's advisor reads the whole context again on every call, so
 * a thread past `limit` tokens moves to the budgeted brief, and comes back
 * only under half the limit so it does not flip at the edge. An unknown size
 * keeps the previous route.
 */
export function advisorRouteForContext(input: {
  readonly contextTokens: number | null | undefined;
  readonly limit: number;
  readonly previous: AdvisorRoute | null | undefined;
}): AdvisorRoute {
  const tokens = input.contextTokens;
  if (tokens === null || tokens === undefined) return input.previous ?? "built-in";
  if (input.previous === "studio") return tokens < input.limit / 2 ? "built-in" : "studio";
  return tokens < input.limit ? "built-in" : "studio";
}

/**
 * What a Claude session is told about its own advisor:
 * - `inherit`: nothing, so the person's own Claude setting applies.
 * - `disable`: the built-in advisor is switched off for the session.
 * - `model`: the built-in advisor runs on `model`.
 */
export type ClaudeSessionAdvisor =
  | { readonly kind: "inherit" }
  | { readonly kind: "disable" }
  | { readonly kind: "model"; readonly model: string };

/**
 * A Claude session never gets two advisors, and never one the thread turned
 * off. An advisor child and a thread that chose "off" have theirs switched
 * off whatever the person's Claude settings say. With the advisor off in
 * settings and no thread choice, nothing is passed. With it on, the session
 * gets Claude's own advisor when the pair and the context allow it, and has
 * it switched off otherwise, since the studio-code tool advises instead.
 */
export function claudeSessionAdvisor(input: {
  readonly advisorChild: boolean;
  readonly mode: ThreadAdvisorMode | null | undefined;
  readonly settings: Pick<AdvisorSettings, "enabled" | "claudeBuiltIn" | "builtInContextLimit">;
  /** From `claudeBuiltInAdvisorModel`; null when the pair must use the studio-code tool. */
  readonly builtInModel: string | null;
  readonly contextTokens: number | null | undefined;
  readonly previousRoute: AdvisorRoute | null | undefined;
}): ClaudeSessionAdvisor {
  if (input.advisorChild) return { kind: "disable" };
  const state = threadAdvisorState(input.mode, input.settings);
  if (!state.enabled) return state.source === "thread" ? { kind: "disable" } : { kind: "inherit" };
  if (!input.settings.claudeBuiltIn || input.builtInModel === null) return { kind: "disable" };
  const route = advisorRouteForContext({
    contextTokens: input.contextTokens,
    limit: input.settings.builtInContextLimit,
    previous: input.previousRoute,
  });
  return route === "built-in" ? { kind: "model", model: input.builtInModel } : { kind: "disable" };
}

// ── Guidance ─────────────────────────────────────────────────────────

/**
 * What a thread is told when its advisor is on. Written for any provider:
 * a Claude session with Claude's own advisor has a built-in `advisor` tool,
 * everything else has the studio-code one.
 */
export const ADVISOR_GUIDANCE = [
  "## Advisor",
  "A stronger model can review your work on request. If your tool list has a built-in `advisor` tool, use that; otherwise call the studio-code `advisor` tool. Neither needs arguments.",
  "- Ask once you have looked around and understand the task, before the substantive work begins.",
  "- Ask again before you report the work as done. Save your results first (write the files, commit), so nothing is lost while you wait.",
  "- Ask when you are stuck, or before you change approach.",
  "Treat the answer as a strong second opinion. Where it disagrees with something you checked yourself, name the evidence and settle the conflict, with one more consult if needed, instead of quietly switching. A short task with an obvious next step needs no consult. Consults are limited per run, so spend them where a wrong turn would cost the most.",
].join("\n");

/** The guidance paragraph, or null when the thread's advisor is off. */
export function advisorGuidance(input: {
  readonly mode: ThreadAdvisorMode | null | undefined;
  readonly settings: Pick<AdvisorSettings, "enabled">;
  /** An advisor child is never told to consult. */
  readonly advisorChild?: boolean | undefined;
}): string | null {
  if (input.advisorChild === true) return null;
  return threadAdvisorState(input.mode, input.settings).enabled ? ADVISOR_GUIDANCE : null;
}
