/**
 * Cross-model adversarial review: which model reviews work another model did.
 * The reviewer order is walked by the fallback system (`describeFallbackOrder`),
 * so sign-in, usage, per-token billing and exclusions follow the same rules
 * as a limited thread's fallback. On top of that a reviewer must belong to a
 * different model family than the author: Claude through GitHub Copilot is
 * still Claude.
 *
 * @module adversarialReview
 */
import type {
  AdversarialReviewSettings,
  ModelSelection,
  ProviderInstanceId,
  ProviderModelTier,
  ProviderModelTiers,
  ServerProvider,
  ThreadReviewMode,
} from "@specweave-studio/contracts";
import {
  defaultTrackSelections,
  providersForModel,
  trackAlternate,
  trackStartEffort,
  withTrackEffort,
} from "./modelTracks.ts";
import { type ModelFamily, modelFamily } from "./fallbackOptions.ts";
import { describeModel, isSameModel, sameModelOn } from "./modelIdentity.ts";
import { fallbackSelectionKey, tierModelFor } from "./modelTiers.ts";
import {
  describeFallbackOrder,
  type ExcludedFallbackModel,
  type FallbackOrderUnavailable,
  isGeminiSpendProvider,
  isUnknownBillingAgent,
} from "./providerFallback.ts";

/** Families a default reviewer chain tries first; the author's own family is always skipped. */
const REVIEWER_FAMILY_ORDER: ReadonlyArray<ModelFamily> = [
  "openai",
  "meta",
  "google",
  "xai",
  "other",
  "claude",
];

/** Why a reviewer entry was passed over. */
export type ReviewerSkipReason = FallbackOrderUnavailable | "same-family" | "unknown-billing";

export interface ReviewerSkip {
  readonly selection: ModelSelection;
  readonly reason: ReviewerSkipReason;
}

export interface ReviewerResolution {
  /** The model that reviews, or null when no entry can. */
  readonly reviewer: ModelSelection | null;
  /** Entries passed over before the reviewer, in order, with why. */
  readonly skipped: ReadonlyArray<ReviewerSkip>;
  /** The author's model family, as the review prompt names it. */
  readonly authorFamily: ModelFamily;
}

/** The family of a selection, from the model as the serving provider names it. */
export function selectionFamily(
  providers: ReadonlyArray<ServerProvider>,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): ModelFamily {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  return modelFamily(describeModel(provider, selection.model));
}

/**
 * The default reviewer order: the built-in Review track fitted to this
 * machine, then each enabled provider's tier model, grouped by family in
 * `REVIEWER_FAMILY_ORDER`, keeping provider order within a family.
 */
export function defaultReviewerChain(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly tier: ProviderModelTier;
  readonly tiers?: ProviderModelTiers | undefined;
  /** The saved Sources order (`defaultModelProviders`): which source of a model is tried first. */
  readonly sourceOrder?: ReadonlyArray<ProviderInstanceId> | undefined;
}): ReadonlyArray<ModelSelection> {
  const picks = input.providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) => {
      const model = tierModelFor(provider, input.tier, input.tiers);
      return model === undefined ? [] : [{ instanceId: provider.instanceId, model }];
    });
  const rank = (selection: ModelSelection) =>
    REVIEWER_FAMILY_ORDER.indexOf(selectionFamily(input.providers, selection));
  const byFamily = picks
    .map((selection, index) => ({ selection, index }))
    .sort((a, b) => rank(a.selection) - rank(b.selection) || a.index - b.index)
    .map((entry) => entry.selection);
  const seen = new Set<string>();
  // The track names everyday reviewers; a frontier review keeps each provider's frontier model.
  const track =
    input.tier === "regular"
      ? defaultTrackSelections("review", input.providers, input.sourceOrder)
      : [];
  return [...track, ...byFamily].filter((entry) => {
    const key = fallbackSelectionKey(entry);
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

/** One step of the reviewer order: a model, then the same model on other providers. */
export interface ReviewerOrderGroup {
  readonly primary: ModelSelection;
  /** The same model through other enabled providers, tried right after the primary. */
  readonly alternates: ReadonlyArray<ModelSelection>;
}

/**
 * The reviewer order as groups: each entry followed by the same model on every
 * other provider that serves it (Codex GPT-6.1 Sol, then Sol through GitHub
 * Copilot). A model the person listed keeps its own place: it is never taken
 * as an earlier entry's alternate. Duplicates keep their first place.
 */
export function reviewerOrderGroups(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly reviewers: ReadonlyArray<ModelSelection>;
  readonly tier: ProviderModelTier;
  readonly tiers?: ProviderModelTiers | undefined;
  /** The saved Sources order (`defaultModelProviders`): which source of a model is tried first. */
  readonly sourceOrder?: ReadonlyArray<ProviderInstanceId> | undefined;
}): ReadonlyArray<ReviewerOrderGroup> {
  // A listed reviewer without an effort runs at Medium, as the Models page shows it.
  const base =
    input.reviewers.length > 0
      ? input.reviewers.map((entry) =>
          withTrackEffort(entry, input.providers, trackStartEffort("review", entry.model)),
        )
      : defaultReviewerChain(input);
  // Only a person's own list pins places; the default order groups freely.
  const listed = new Set(input.reviewers.map(fallbackSelectionKey));
  const seen = new Set<string>();
  const claim = (selection: ModelSelection) => {
    const key = fallbackSelectionKey(selection);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const groups: ReviewerOrderGroup[] = [];
  for (const entry of base) {
    if (!claim(entry)) continue;
    const names = describeModel(
      input.providers.find((provider) => provider.instanceId === entry.instanceId),
      entry.model,
    );
    const alternates: ModelSelection[] = [];
    // The same ranking the Models page shows: the saved Sources order, then the maker's harness.
    for (const { provider, slug } of providersForModel({
      providers: input.providers,
      model: names,
      order: input.sourceOrder,
      // The built-in order stands for each model's whole family; a listed reviewer for itself.
      family: input.reviewers.length === 0,
    })) {
      if (provider.instanceId === entry.instanceId) continue;
      // The entry's effort goes with it, matched to the levels that source offers.
      const alternate = trackAlternate(
        entry,
        { instanceId: provider.instanceId, model: slug },
        input.providers,
      );
      if (listed.has(fallbackSelectionKey(alternate))) continue;
      if (claim(alternate)) alternates.push(alternate);
    }
    groups.push({ primary: entry, alternates });
  }
  return groups;
}

/** The reviewer order flattened: each group's primary, then its alternates. */
export function reviewerChain(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly reviewers: ReadonlyArray<ModelSelection>;
  readonly tier: ProviderModelTier;
  readonly tiers?: ProviderModelTiers | undefined;
  /** The saved Sources order (`defaultModelProviders`): which source of a model is tried first. */
  readonly sourceOrder?: ReadonlyArray<ProviderInstanceId> | undefined;
}): ReadonlyArray<ModelSelection> {
  return reviewerOrderGroups(input).flatMap((group) => [group.primary, ...group.alternates]);
}

/** Whether a reviewer step could review now, before the author's family is known. */
export type ReviewerStepStatus = Exclude<ReviewerSkipReason, "same-family" | "current"> | "ready";

export interface ReviewerOrderStep {
  readonly selection: ModelSelection;
  readonly family: ModelFamily;
  readonly status: ReviewerStepStatus;
  /** When a full entry's usage resets, if known. */
  readonly resetAt: number | null;
  /** An agent of unknown billing nobody listed: never picked until a person lists it. */
  readonly unconsented: boolean;
}

export interface ReviewerOrderView {
  /** True when no reviewer order is set and the default order applies. */
  readonly isDefault: boolean;
  readonly groups: ReadonlyArray<{
    readonly primary: ReviewerOrderStep;
    readonly alternates: ReadonlyArray<ReviewerOrderStep>;
  }>;
}

/** No thread runs here: settings describe the order before any author is known. */
const NO_AUTHOR_INSTANCE = "__reviewer-order__" as ModelSelection["instanceId"];

/**
 * The effective reviewer order with each step's status on this machine now,
 * by the same rules `resolveReviewer` walks (sign-in, usage, exclusions,
 * unknown billing). The author's family is skipped at review time, so it is
 * not a status here; each step names its family instead.
 */
export function describeReviewerOrder(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly reviewers: ReadonlyArray<ModelSelection>;
  readonly tier: ProviderModelTier;
  readonly tiers?: ProviderModelTiers | undefined;
  /** The saved Sources order (`defaultModelProviders`): which source of a model is tried first. */
  readonly sourceOrder?: ReadonlyArray<ProviderInstanceId> | undefined;
  readonly excludedModels?: ReadonlyArray<ExcludedFallbackModel> | undefined;
  readonly nowMs: number;
}): ReviewerOrderView {
  const groups = reviewerOrderGroups(input);
  const chain = groups.flatMap((group) => [group.primary, ...group.alternates]);
  const entries = describeFallbackOrder({
    providers: input.providers,
    currentInstanceId: NO_AUTHOR_INSTANCE,
    rule: {
      providerLimitFallbackModels: chain,
      providerLimitFallbackModelSelection: null,
      providerLimitExcludedModels: input.excludedModels ?? [],
    },
    nowMs: input.nowMs,
  });
  const byKey = new Map(entries.map((entry) => [fallbackSelectionKey(entry.selection), entry]));
  const named = new Set(input.reviewers.map(fallbackSelectionKey));
  const step = (selection: ModelSelection): ReviewerOrderStep => {
    const key = fallbackSelectionKey(selection);
    const entry = byKey.get(key);
    const provider = input.providers.find((item) => item.instanceId === selection.instanceId);
    const unavailable: FallbackOrderUnavailable | null =
      entry === undefined ? (provider === undefined ? "missing" : "not-ready") : entry.unavailable;
    const unconsented = !named.has(key) && isUnknownBillingAgent(provider, selection.model);
    // As `resolveReviewer` reads it: a Gemini or Vertex account nobody named never reviews.
    const unnamedSpend = !named.has(key) && isGeminiSpendProvider(provider);
    const status: ReviewerStepStatus =
      unnamedSpend && (unavailable === null || unavailable === "unverified")
        ? "per-token"
        : unconsented && (unavailable === null || unavailable === "unverified")
          ? "unknown-billing"
          : unavailable === null || unavailable === "current"
            ? "ready"
            : unavailable;
    return {
      selection,
      family: selectionFamily(input.providers, selection),
      status,
      resetAt: entry?.resetAt ?? null,
      unconsented,
    };
  };
  return {
    isDefault: input.reviewers.length === 0,
    groups: groups.map((group) => ({
      primary: step(group.primary),
      alternates: group.alternates.map(step),
    })),
  };
}

/**
 * The first entry of the reviewer order that can run now and is not in the
 * author's family. An entry whose usage was never read keeps its place: the
 * order is the person's ranking, and a later model with known room never jumps
 * ahead of it (Muse reports no percent, so it lost to GPT-6.1 Sol). A stale or
 * denied reading ("unverified") still yields to an entry with room.
 */
export function resolveReviewer(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly author: ModelSelection;
  readonly reviewers: ReadonlyArray<ModelSelection>;
  readonly tier: ProviderModelTier;
  readonly tiers?: ProviderModelTiers | undefined;
  /** The saved Sources order (`defaultModelProviders`): which source of a model is tried first. */
  readonly sourceOrder?: ReadonlyArray<ProviderInstanceId> | undefined;
  readonly excludedModels?: ReadonlyArray<ExcludedFallbackModel> | undefined;
  readonly nowMs: number;
  readonly limitedInstanceIds?: ReadonlySet<string> | undefined;
  /**
   * The models a person chose, when `reviewers` is an order already expanded
   * from them (review delegation). Only these are consent to unknown billing
   * or Gemini spend; without it, `reviewers` is the person's own list.
   */
  readonly consented?: ReadonlyArray<ModelSelection> | undefined;
}): ReviewerResolution {
  const authorFamily = selectionFamily(input.providers, input.author);
  const chain = reviewerChain(input);
  const entries = describeFallbackOrder({
    providers: input.providers,
    currentInstanceId: input.author.instanceId,
    rule: {
      providerLimitFallbackModels: chain,
      providerLimitFallbackModelSelection: null,
      providerLimitExcludedModels: input.excludedModels ?? [],
    },
    nowMs: input.nowMs,
    limitedInstanceIds: input.limitedInstanceIds,
  });
  const skipped: ReviewerSkip[] = [];
  let unverified: ModelSelection | null = null;
  const providerOf = (selection: ModelSelection) =>
    input.providers.find((provider) => provider.instanceId === selection.instanceId);
  const authorNames = describeModel(providerOf(input.author), input.author.model);
  // Only models a person put in the reviewer order count as consented to;
  // the default order and Copilot-style expansions never pick an agent whose
  // billing is unknown.
  const named = new Set((input.consented ?? input.reviewers).map(fallbackSelectionKey));
  for (const entry of entries) {
    const provider = providerOf(entry.selection);
    // The family check comes first: a same-family entry is never a reviewer,
    // whatever its availability. An author of no known family is matched by
    // model instead, so it never reviews its own work.
    const sameFamily =
      authorFamily === "other"
        ? isSameModel(authorNames, describeModel(provider, entry.selection.model))
        : selectionFamily(input.providers, entry.selection) === authorFamily;
    const unconsented =
      !named.has(fallbackSelectionKey(entry.selection)) &&
      isUnknownBillingAgent(provider, entry.selection.model);
    // Naming a Gemini or Vertex model is consent to its spend; the default
    // order, the built-in Review track included, never is.
    const unnamedSpend =
      !named.has(fallbackSelectionKey(entry.selection)) && isGeminiSpendProvider(provider);
    // A harder reason from the fallback walker stays; unknown billing only
    // replaces "has room" and "usage unknown".
    const reason: ReviewerSkipReason | null = sameFamily
      ? "same-family"
      : unnamedSpend
        ? "per-token"
        : unconsented && (entry.unavailable === null || entry.unavailable === "unverified")
          ? "unknown-billing"
          : entry.unavailable;
    // Usage never read here keeps the entry's place; a stale reading or one a
    // later denial overtook does not, since the account may be at its limit.
    if (reason === null || (reason === "unverified" && usageNeverRead(provider)))
      return { reviewer: entry.selection, skipped, authorFamily };
    if (reason === "unverified" && unverified === null) unverified = entry.selection;
    skipped.push({ selection: entry.selection, reason });
  }
  if (unverified !== null) {
    const index = skipped.findIndex(
      (skip) => fallbackSelectionKey(skip.selection) === fallbackSelectionKey(unverified),
    );
    return { reviewer: unverified, skipped: skipped.slice(0, index), authorFamily };
  }
  return { reviewer: null, skipped, authorFamily };
}

/**
 * Whether this account's usage has never been read: its only reading is a
 * failed or unsupported probe, with no windows and no limit denial seen.
 * Muse reports this way; it says nothing about the account being full.
 */
export function usageNeverRead(provider: ServerProvider | undefined): boolean {
  const limits = provider?.usageLimits;
  return (
    limits !== undefined &&
    limits.unavailable !== undefined &&
    limits.windows.length === 0 &&
    limits.nativeDenialObservedAt === undefined
  );
}

/** Short words for a skip reason, for notices. */
export const REVIEWER_SKIP_NOTES: Record<ReviewerSkipReason, string> = {
  "same-family": "same model family as the work",
  current: "the model that did the work",
  missing: "not offered by that provider",
  limited: "at its usage limit",
  "signed-out": "signed out",
  "per-token": "billed per token",
  full: "usage full",
  "too-small": "context too small",
  unverified: "usage unknown",
  "not-ready": "not ready on this machine",
  excluded: "kept out of automatic use",
  "unknown-billing": "billing unknown; add it to the reviewer order to use it",
};

// ── Is review on for this thread ─────────────────────────────────────

/**
 * Every review thread's title starts with this. It is how a review thread is
 * told apart later (the thread record has no kind): the reactor never reviews
 * a review, and a review thread has no review choice of its own.
 */
export const ADVERSARIAL_REVIEW_TITLE_PREFIX = "Adversarial review:";

/** Whether a thread is an adversarial review thread, by its title. */
export function isAdversarialReviewThreadTitle(title: string): boolean {
  return title.startsWith(ADVERSARIAL_REVIEW_TITLE_PREFIX);
}

export interface ThreadReviewState {
  readonly enabled: boolean;
  /** Whose choice it is: the thread's own, or the project and machine setting. */
  readonly source: "thread" | "settings";
}

/**
 * Whether a finished feature on this thread gets an automatic review: the
 * thread's own choice when it made one, else the project's setting (already
 * merged over the machine's). The same rule as `threadAdvisorState`.
 */
export function threadReviewState(
  mode: ThreadReviewMode | null | undefined,
  settings: Pick<AdversarialReviewSettings, "autoOnFeatureComplete">,
): ThreadReviewState {
  if (mode === "on" || mode === "off") return { enabled: mode === "on", source: "thread" };
  return { enabled: settings.autoOnFeatureComplete, source: "settings" };
}
