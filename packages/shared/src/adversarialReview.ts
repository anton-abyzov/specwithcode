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
  ModelSelection,
  ProviderModelTier,
  ProviderModelTiers,
  ServerProvider,
} from "@specweave-studio/contracts";
import { type ModelFamily, modelFamily } from "./fallbackOptions.ts";
import { describeModel, isSameModel, sameModelOn } from "./modelIdentity.ts";
import { fallbackSelectionKey, tierModelFor } from "./modelTiers.ts";
import {
  describeFallbackOrder,
  type ExcludedFallbackModel,
  type FallbackOrderUnavailable,
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
 * The default reviewer order: each enabled provider's tier model, grouped by
 * family in `REVIEWER_FAMILY_ORDER`, keeping provider order within a family.
 */
export function defaultReviewerChain(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly tier: ProviderModelTier;
  readonly tiers?: ProviderModelTiers | undefined;
}): ReadonlyArray<ModelSelection> {
  const picks = input.providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) => {
      const model = tierModelFor(provider, input.tier, input.tiers);
      return model === undefined ? [] : [{ instanceId: provider.instanceId, model }];
    });
  const rank = (selection: ModelSelection) =>
    REVIEWER_FAMILY_ORDER.indexOf(selectionFamily(input.providers, selection));
  return picks
    .map((selection, index) => ({ selection, index }))
    .sort((a, b) => rank(a.selection) - rank(b.selection) || a.index - b.index)
    .map((entry) => entry.selection);
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
}): ReadonlyArray<ReviewerOrderGroup> {
  const base = input.reviewers.length > 0 ? input.reviewers : defaultReviewerChain(input);
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
    for (const provider of input.providers) {
      if (provider.instanceId === entry.instanceId || !provider.enabled) continue;
      const slug = sameModelOn(provider, names);
      if (slug === undefined) continue;
      const alternate = { instanceId: provider.instanceId, model: slug };
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
    const status: ReviewerStepStatus =
      unconsented && (unavailable === null || unavailable === "unverified")
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
 * author's family. An entry with room wins; else the first whose usage is
 * unknown ("unverified"), which the fallback walker also lets a person pick.
 */
export function resolveReviewer(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly author: ModelSelection;
  readonly reviewers: ReadonlyArray<ModelSelection>;
  readonly tier: ProviderModelTier;
  readonly tiers?: ProviderModelTiers | undefined;
  readonly excludedModels?: ReadonlyArray<ExcludedFallbackModel> | undefined;
  readonly nowMs: number;
  readonly limitedInstanceIds?: ReadonlySet<string> | undefined;
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
  const named = new Set(input.reviewers.map(fallbackSelectionKey));
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
    // A harder reason from the fallback walker stays; unknown billing only
    // replaces "has room" and "usage unknown".
    const reason: ReviewerSkipReason | null = sameFamily
      ? "same-family"
      : unconsented && (entry.unavailable === null || entry.unavailable === "unverified")
        ? "unknown-billing"
        : entry.unavailable;
    if (reason === null) return { reviewer: entry.selection, skipped, authorFamily };
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
