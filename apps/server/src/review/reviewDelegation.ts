/**
 * Which model takes a review handed out with `delegate_task` (`taskClass:
 * "review"` or `role: "review"`). With no model named, the reviewer comes from
 * the project's reviewer order (Settings > Adversarial review) walked by the
 * same rules as `resolveReviewer`: another family than the author, with room
 * to run. An increment's spec.md `## Review` narrows it to a family or model.
 * Nothing is substituted silently: when no reviewer of the required family can
 * run here, the delegation fails with each reason. A named model runs as asked,
 * with a warning when it is the author's family or not the policy's.
 *
 * @module reviewDelegation
 */
import type {
  ModelSelection,
  ProviderModelTier,
  ProviderModelTiers,
  ServerProvider,
} from "@specweave-studio/contracts";
import {
  REVIEWER_SKIP_NOTES,
  type ReviewerSkip,
  resolveReviewer,
  reviewerChain,
  selectionFamily,
} from "@specweave-studio/shared/adversarialReview";
import { MODEL_FAMILY_LABELS, type ModelFamily } from "@specweave-studio/shared/fallbackOptions";
import { describeModel, sameModelOn } from "@specweave-studio/shared/modelIdentity";
import type { ExcludedFallbackModel } from "@specweave-studio/shared/providerFallback";
import type { IncrementReviewPolicy } from "@specweave-studio/shared/reviewPolicy";

export interface ReviewDelegationInput {
  readonly providers: ReadonlyArray<ServerProvider>;
  /** The model whose work is reviewed: the calling thread's. */
  readonly author: ModelSelection;
  /** The caller's own pick, when it named a model. */
  readonly named: ModelSelection | null;
  readonly reviewers: ReadonlyArray<ModelSelection>;
  readonly tier: ProviderModelTier;
  readonly tiers?: ProviderModelTiers | undefined;
  readonly excludedModels?: ReadonlyArray<ExcludedFallbackModel> | undefined;
  readonly policy: IncrementReviewPolicy | null;
  readonly nowMs: number;
  readonly limitedInstanceIds?: ReadonlySet<string> | undefined;
}

export interface ReviewDelegationSkip {
  readonly selection: ModelSelection;
  readonly label: string;
  readonly reason: string;
}

export type ReviewDelegationDecision =
  | {
      readonly kind: "pick" | "named";
      readonly selection: ModelSelection;
      readonly label: string;
      readonly reviewerFamily: ModelFamily;
      readonly authorFamily: ModelFamily;
      readonly skipped: ReadonlyArray<ReviewDelegationSkip>;
      /** Set when the review is not what the policy or the cross-family rule asks for. */
      readonly warning: string | null;
    }
  | {
      readonly kind: "none";
      readonly authorFamily: ModelFamily;
      readonly skipped: ReadonlyArray<ReviewDelegationSkip>;
      readonly message: string;
    };

/** "GPT-6.1 Sol on codex": the model's own name and the provider instance serving it. */
export function reviewerLabel(
  providers: ReadonlyArray<ServerProvider>,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): string {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  const names = describeModel(provider, selection.model);
  const name =
    "name" in names && typeof names.name === "string" && names.name ? names.name : selection.model;
  return `${name} on ${provider?.displayName ?? selection.instanceId}`;
}

function familyLabel(family: ModelFamily | "cross-family"): string {
  return family === "cross-family" ? "another family" : MODEL_FAMILY_LABELS[family];
}

/** The policy's model on every enabled provider that serves it, in provider order. */
function policyModelSelections(
  providers: ReadonlyArray<ServerProvider>,
  model: string,
): ReadonlyArray<ModelSelection> {
  return providers.flatMap((provider) => {
    if (!provider.enabled) return [];
    const slug = sameModelOn(provider, { slug: model });
    return slug === undefined ? [] : [{ instanceId: provider.instanceId, model: slug }];
  });
}

export function reviewDelegationTarget(input: ReviewDelegationInput): ReviewDelegationDecision {
  const authorFamily = selectionFamily(input.providers, input.author);
  const policy = input.policy;
  const policyFamily = policy !== null && policy.family !== "cross-family" ? policy.family : null;
  const describeSkips = (skips: ReadonlyArray<ReviewerSkip>): ReadonlyArray<ReviewDelegationSkip> =>
    skips.map((skip) => ({
      selection: skip.selection,
      label: reviewerLabel(input.providers, skip.selection),
      reason: REVIEWER_SKIP_NOTES[skip.reason],
    }));

  if (input.named !== null) {
    const reviewerFamily = selectionFamily(input.providers, input.named);
    const label = reviewerLabel(input.providers, input.named);
    const warnings: string[] = [];
    if (authorFamily !== "other" && reviewerFamily === authorFamily)
      warnings.push(
        `${label} is the same family as the author (${familyLabel(authorFamily)}); this is not a cross-family review.`,
      );
    if (policyFamily !== null && reviewerFamily !== policyFamily)
      warnings.push(
        `The increment's review policy asks for ${familyLabel(policyFamily)}${policy?.model ? ` (${policy.model})` : ""}; this review will not satisfy it at closure.`,
      );
    return {
      kind: "named",
      selection: input.named,
      label,
      reviewerFamily,
      authorFamily,
      skipped: [],
      warning: warnings.length > 0 ? warnings.join(" ") : null,
    };
  }

  let order: ReadonlyArray<ModelSelection> = reviewerChain({
    providers: input.providers,
    reviewers: input.reviewers,
    tier: input.tier,
    tiers: input.tiers,
  });
  if (policy?.model !== undefined) {
    const pinned = policyModelSelections(input.providers, policy.model);
    order = pinned.length > 0 ? pinned : [];
  }
  if (policyFamily !== null)
    order = order.filter(
      (selection) => selectionFamily(input.providers, selection) === policyFamily,
    );

  const wanted =
    policy?.model !== undefined
      ? `${policy.model}${policyFamily === null ? "" : ` (${familyLabel(policyFamily)})`}`
      : policyFamily !== null
        ? `a ${familyLabel(policyFamily)} model`
        : `a model from another family than the author (${familyLabel(authorFamily)})`;
  const refuse = (skipped: ReadonlyArray<ReviewDelegationSkip>) => ({
    kind: "none" as const,
    authorFamily,
    skipped,
    message:
      `No reviewer can run here: the review needs ${wanted}` +
      (skipped.length > 0
        ? `, and ${skipped.map((skip) => `${skip.label} is ${skip.reason}`).join("; ")}.`
        : policy?.model !== undefined
          ? `, and no provider on this machine offers it.`
          : `, and none is set up on this machine (Settings > Adversarial review).`) +
      " Nothing was started. Pass a model in target to review anyway, or start the review on another machine that has one (machine).",
  });
  if (order.length === 0) return refuse([]);

  const resolution = resolveReviewer({
    providers: input.providers,
    author: input.author,
    reviewers: order,
    tier: input.tier,
    tiers: input.tiers,
    excludedModels: input.excludedModels,
    nowMs: input.nowMs,
    limitedInstanceIds: input.limitedInstanceIds,
  });
  const skipped = describeSkips(resolution.skipped);
  if (resolution.reviewer === null) return refuse(skipped);
  return {
    kind: "pick",
    selection: resolution.reviewer,
    label: reviewerLabel(input.providers, resolution.reviewer),
    reviewerFamily: selectionFamily(input.providers, resolution.reviewer),
    authorFamily,
    skipped,
    warning: null,
  };
}

/** The lines a reviewer's brief starts with: who it is, whose work it reads, how to record its verdict. */
export function reviewDelegationBrief(input: {
  readonly decision: Extract<ReviewDelegationDecision, { kind: "pick" | "named" }>;
  readonly authorLabel: string;
  readonly policy: IncrementReviewPolicy | null;
}): string {
  const { decision, policy } = input;
  const lines = [
    `You are ${decision.label} (${familyLabel(decision.reviewerFamily)}), reviewing work written by ${input.authorLabel} (${familyLabel(decision.authorFamily)}). Do not edit the code under review.`,
  ];
  if (policy !== null)
    lines.push(
      `The increment's review policy: ${policy.family === "cross-family" ? "another family than the author" : familyLabel(policy.family)}${policy.model ? ` (${policy.model})` : ""}, ${policy.depth ?? "standard"} depth${policy.required ? ", required to close" : ""}.`,
    );
  lines.push(
    `Write the report in the sw-review shape (second line \`Verdict: ship\` or \`Verdict: fix first\`), then record it from the reviewed repository: \`specweave review --record <report.md> --model ${decision.selection.model} --head <reviewed commit sha>\`. Report the reviewed commit in your answer.`,
  );
  return lines.join("\n");
}
