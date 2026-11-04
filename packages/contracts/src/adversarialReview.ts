/**
 * Cross-model adversarial review and per-provider model tiers: the settings
 * shapes only. The reviewer chain and tier lookups are
 * `@specweave-studio/shared/adversarialReview` and `@specweave-studio/shared/modelTiers`.
 *
 * @module adversarialReview
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CommandId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * How hard a model works: `regular` is the everyday model of a provider
 * (Claude Opus 5.5, Codex GPT-6.1 Sol); `frontier` is its strongest model,
 * used only when asked for or for work flagged complex.
 */
export const PROVIDER_MODEL_TIERS = ["regular", "frontier"] as const;
export const ProviderModelTier = Schema.Literals(PROVIDER_MODEL_TIERS);
export type ProviderModelTier = typeof ProviderModelTier.Type;

/** A provider's model slug for each tier; a missing tier uses the built-in default. */
export const ProviderTierModels = Schema.Struct({
  regular: Schema.optionalKey(TrimmedNonEmptyString),
  frontier: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProviderTierModels = typeof ProviderTierModels.Type;

/**
 * Tier models keyed by provider instance id or driver kind (`codex`,
 * `claudeAgent`, `muse`). An instance key wins over its driver's key.
 */
export const ProviderModelTiers = Schema.Record(TrimmedNonEmptyString, ProviderTierModels);
export type ProviderModelTiers = typeof ProviderModelTiers.Type;

/**
 * Built-in tier models per driver kind. Providers that serve other vendors'
 * models (GitHub Copilot, OpenCode) have no entry: they use the same model
 * another provider names, when they list it.
 */
export const DEFAULT_PROVIDER_MODEL_TIERS: Readonly<Record<string, Required<ProviderTierModels>>> =
  {
    claudeAgent: { regular: "claude-opus-5-5", frontier: "claude-fable-5-1" },
    codex: { regular: "gpt-6.1-sol", frontier: "gpt-6-astra" },
    muse: { regular: "muse-wonder-1.0", frontier: "muse-wonder-full-1.0" },
  };

/** At most this many reviewer models. */
export const MAX_REVIEWER_MODELS = 8;

export const ReviewerModelList = Schema.Array(ModelSelection).check(
  Schema.isMaxLength(MAX_REVIEWER_MODELS),
);
export type ReviewerModelList = typeof ReviewerModelList.Type;

/**
 * Adversarial review by a different model family than the one that did the
 * work. `reviewers` is tried in order like a fallback order; empty means
 * each provider's tier model, other families first.
 */
export const AdversarialReviewSettings = Schema.Struct({
  /** Start a review when a thread finishes and its increment has every task done. */
  autoOnFeatureComplete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  reviewers: ReviewerModelList.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Which tier model a reviewer chosen by provider runs on. */
  tier: ProviderModelTier.pipe(Schema.withDecodingDefault(Effect.succeed("regular" as const))),
});
export type AdversarialReviewSettings = typeof AdversarialReviewSettings.Type;

/**
 * A change to some fields of the review policy. Fields left out keep their
 * value on every target, so one edit across mixed projects changes only itself.
 */
export const AdversarialReviewSettingsPatch = Schema.Struct({
  autoOnFeatureComplete: Schema.optionalKey(Schema.Boolean),
  reviewers: Schema.optionalKey(ReviewerModelList),
  tier: Schema.optionalKey(ProviderModelTier),
});
export type AdversarialReviewSettingsPatch = typeof AdversarialReviewSettingsPatch.Type;

export const DEFAULT_ADVERSARIAL_REVIEW_SETTINGS: AdversarialReviewSettings = {
  autoOnFeatureComplete: false,
  reviewers: [],
  tier: "regular",
};

// ── Starting a review ────────────────────────────────────────────────

/** Why a reviewer entry was passed over (the fallback order's reasons, plus `same-family`). */
export const AdversarialReviewSkipReason = Schema.Literals([
  "same-family",
  "current",
  "missing",
  "limited",
  "signed-out",
  "per-token",
  "full",
  "too-small",
  "unverified",
  "not-ready",
  "excluded",
  "unknown-billing",
]);
export type AdversarialReviewSkipReason = typeof AdversarialReviewSkipReason.Type;

export const AdversarialReviewSkip = Schema.Struct({
  selection: ModelSelection,
  reason: AdversarialReviewSkipReason,
});
export type AdversarialReviewSkip = typeof AdversarialReviewSkip.Type;

export const StartAdversarialReviewInput = Schema.Struct({
  commandId: CommandId,
  /** The thread whose work is reviewed. */
  threadId: ThreadId,
  /** A reviewer the person picked; still refused when it is the author's model family. */
  reviewer: Schema.optional(ModelSelection),
  /** Overrides the project's review depth for this review. */
  tier: Schema.optional(ProviderModelTier),
});
export type StartAdversarialReviewInput = typeof StartAdversarialReviewInput.Type;

export const StartAdversarialReviewResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("started"),
    /** The review thread. */
    threadId: ThreadId,
    reviewer: ModelSelection,
    skipped: Schema.Array(AdversarialReviewSkip),
  }),
  Schema.Struct({
    status: Schema.Literal("no-reviewer"),
    skipped: Schema.Array(AdversarialReviewSkip),
  }),
]);
export type StartAdversarialReviewResult = typeof StartAdversarialReviewResult.Type;

export class AdversarialReviewError extends Schema.TaggedError<AdversarialReviewError>()(
  "AdversarialReviewError",
  {
    threadId: ThreadId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
