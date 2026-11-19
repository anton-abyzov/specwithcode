/**
 * A review thread keeps its reviewer lock across a handoff (1390 AC-40).
 *
 * A review is a thread whose routing names a reviewer family (the review
 * routing marker), or an older thread titled "Adversarial review: …" with no
 * routing. Its lock is the families it may run on, the model its policy pins
 * and the effort it runs at. The source sends the lock with every checkpoint;
 * the destination picks inside it and starts the continuation with the
 * marker, so its own limit fallback stays inside the lock too.
 *
 * A machine says it does this with the `handoffReviewLock` capability. One
 * that does not is never sent a review: the lock would be dropped on arrival.
 */
import {
  HandoffModeError,
  type ModelSelection,
  ProviderOptionSelections,
  type OrchestratorMcpMachine,
  type ProviderLimitMachineTarget,
  type ServerProvider,
  type TaskRoutingDecision,
} from "@specweave-studio/contracts";
import { isAdversarialReviewThreadTitle } from "@specweave-studio/shared/adversarialReview";
import { MODEL_FAMILY_LABELS } from "@specweave-studio/shared/fallbackOptions";
import { isPaidModel } from "@specweave-studio/shared/modelBilling";
import {
  familyOfModelId,
  lockedReviewerPick,
  type ReviewFamily,
  reviewEffortOver,
  sameReviewModel,
} from "@specweave-studio/shared/reviewPolicy";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const ReviewFamilyName = Schema.Literals(["claude", "openai", "google", "xai", "meta"]);
const modelId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

export const HandoffReviewLock = Schema.Struct({
  /** How the source knew this is a review: its routing marker, or only its title. */
  marker: Schema.Literals(["routing", "title"]),
  /** The model families the review may run on. Never empty. */
  families: Schema.Array(ReviewFamilyName).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  /** What the increment's review policy fixes beyond the family. */
  policy: Schema.Struct({ model: Schema.optional(modelId) }),
  /** The effort the review runs at, kept wherever it continues on the same model. */
  effort: Schema.optional(Schema.Struct({ model: modelId, options: ProviderOptionSelections })),
});
export type HandoffReviewLock = typeof HandoffReviewLock.Type;

/** What a `Review stays here` row is about. */
export type ReviewStays = "no_reviewer" | "update_needed";

/** The sentences a review that cannot move is shown with. The web app translates them. */
export const reviewStaysText = (stays: ReviewStays, machineLabel: string) =>
  stays === "no_reviewer"
    ? `Review stays here: no permitted reviewer on ${machineLabel}`
    : `Review stays here: update SpecWithCode on ${machineLabel}`;

/** Why a review told only by its title, on a model of no known family, moves nowhere. */
export const REVIEW_FAMILY_UNKNOWN =
  "Review stays here: its reviewer's model family is unknown, so another machine cannot keep it on that reviewer.";

type ReviewThread = {
  readonly title?: string | undefined;
  readonly modelSelection?: Pick<ModelSelection, "model" | "options"> | undefined;
  readonly routing?: Pick<TaskRoutingDecision, "reviewFamily" | "reviewModel"> | null | undefined;
};

export type SourceReviewLock =
  | { readonly kind: "none" }
  | { readonly kind: "lock"; readonly lock: HandoffReviewLock }
  /** A review by its title, on a model of no known family: nothing can be locked. */
  | { readonly kind: "unknown-family" };

/** The lock a thread carries, read from its routing marker, else from its title and model. */
export function sourceReviewLock(thread: ReviewThread): SourceReviewLock {
  const selection = thread.modelSelection;
  const effort =
    selection?.options === undefined || selection.options.length === 0
      ? {}
      : { effort: { model: selection.model, options: selection.options } };
  const family = thread.routing?.reviewFamily;
  if (family !== undefined) {
    const pinned = thread.routing?.reviewModel;
    return {
      kind: "lock",
      lock: {
        marker: "routing",
        families: [family],
        policy: pinned === undefined ? {} : { model: pinned },
        ...effort,
      },
    };
  }
  if (thread.title === undefined || !isAdversarialReviewThreadTitle(thread.title))
    return { kind: "none" };
  // The reviewer was picked outside the author's family, so its own family is the lock.
  const own = selection === undefined ? "other" : familyOfModelId(selection.model);
  if (own === "other") return { kind: "unknown-family" };
  return { kind: "lock", lock: { marker: "title", families: [own], policy: {}, ...effort } };
}

/**
 * The lock a checkpoint leaving this machine carries: null only for a thread
 * that is no review. A review that cannot be locked leaves for no machine,
 * this one included: a continuation of it would start as an ordinary thread.
 */
export const outgoingReviewLock = (
  thread: ReviewThread,
): Effect.Effect<HandoffReviewLock | null, HandoffModeError> => {
  const review = sourceReviewLock(thread);
  if (review.kind === "lock") return Effect.succeed(review.lock);
  if (review.kind === "none") return Effect.succeed(null);
  return Effect.fail(new HandoffModeError({ code: "invalid", message: REVIEW_FAMILY_UNKNOWN }));
};

/**
 * A takeover request for this thread, marked when the thread is a review so
 * it goes only to a machine that keeps the lock (see `reviewPath`).
 */
export const reviewTakeover = <R extends object>(
  thread: ReviewThread,
  request: R,
): R & { readonly review?: boolean } =>
  sourceReviewLock(thread).kind === "none" ? request : { ...request, review: true };

const reviewerLock = (lock: HandoffReviewLock) => ({
  families: lock.families,
  ...(lock.policy.model === undefined ? {} : { model: lock.policy.model }),
});

/**
 * The pick with its options. The review's effort is the rule on the model it
 * was set for: it wins over an effort asked for or saved there, and options
 * it does not name stay beside it. Another model keeps what was asked for it.
 */
const withEffort = (
  lock: HandoffReviewLock,
  pick: { readonly instanceId: ModelSelection["instanceId"]; readonly model: string },
  requested: ModelSelection | null,
): ModelSelection => {
  const asked =
    requested !== null && requested.instanceId === pick.instanceId && requested.model === pick.model
      ? requested.options
      : undefined;
  const options =
    lock.effort !== undefined && sameReviewModel(lock.effort.model, pick.model)
      ? reviewEffortOver(asked, lock.effort.options)
      : asked;
  return {
    instanceId: pick.instanceId,
    model: pick.model,
    ...(options === undefined ? {} : { options }),
  };
};

export type MachineReviewTarget =
  /** Ask this machine for this model; `proven` is false when the machine was not read. */
  | {
      readonly kind: "target";
      readonly target: ProviderLimitMachineTarget;
      readonly proven: boolean;
    }
  | { readonly kind: "stays"; readonly review: ReviewStays; readonly text: string };

/**
 * A machine target for a review thread: the model to ask that machine for,
 * or why the review stays. A machine that does not say it keeps the lock, or
 * offers no model the lock permits, is not a target.
 */
export function machineReviewTarget(input: {
  readonly lock: HandoffReviewLock;
  readonly target: ProviderLimitMachineTarget;
  readonly machine:
    | Pick<OrchestratorMcpMachine, "label" | "providers" | "handoffReviewLock">
    | undefined;
  readonly machineLabel: string;
  /** Whether this machine's own rules let work run on that model. */
  readonly allowed: (driverKind: string, model: string) => boolean;
  /** Whether that machine would take the thread on this model now (usage, account, exclusions). */
  readonly usable?: (target: ProviderLimitMachineTarget) => boolean;
}): MachineReviewTarget {
  const { lock, target, machine } = input;
  // Not read: the ordinary verdict says why (offline, not paired, not checked).
  if (machine?.providers === undefined) return { kind: "target", target, proven: false };
  const stays = (review: ReviewStays): MachineReviewTarget => ({
    kind: "stays",
    review,
    text: reviewStaysText(review, input.machineLabel),
  });
  if (machine.handoffReviewLock !== true) return stays("update_needed");
  const offered = machine.providers
    .filter((row) => row.available && row.allowedByGrant !== false)
    .map((row) => ({
      instanceId: row.providerInstanceId,
      models: row.models.filter(
        (model) => input.allowed(row.driverKind, model) && row.paidModels?.includes(model) !== true,
      ),
    }));
  // Another model than the saved one: its saved label no longer names it.
  const { modelLabel: _saved, ...rest } = target;
  const targetFor = (pick: (typeof offered)[number]["instanceId"], model: string) => {
    const same = pick === target.modelSelection.instanceId && model === target.modelSelection.model;
    const modelSelection = withEffort(lock, { instanceId: pick, model }, target.modelSelection);
    return same ? { ...target, modelSelection } : { ...rest, modelSelection };
  };
  // First a reviewer that machine would take now; else any permitted one, whose verdict says why not.
  const { usable } = input;
  const ready =
    usable === undefined
      ? []
      : offered.map((row) => ({
          instanceId: row.instanceId,
          models: row.models.filter((model) => usable(targetFor(row.instanceId, model))),
        }));
  const pick =
    lockedReviewerPick(reviewerLock(lock), target.modelSelection, ready) ??
    lockedReviewerPick(reviewerLock(lock), target.modelSelection, offered);
  if (pick === null) return stays("no_reviewer");
  return { kind: "target", target: targetFor(pick.instanceId, pick.model), proven: true };
}

/** The wait text when every machine's verdict is a review that stays, else null. */
export function describeReviewWait(
  verdicts: ReadonlyArray<{ readonly text: string; readonly review?: ReviewStays | undefined }>,
): string | null {
  if (verdicts.length === 0 || verdicts.some((verdict) => verdict.review === undefined))
    return null;
  return `${verdicts.map((verdict) => verdict.text).join(". ")}.`;
}

export type ArrivedReview =
  | { readonly kind: "unlocked" }
  | { readonly kind: "refused"; readonly message: string }
  | {
      readonly kind: "locked";
      readonly modelSelection: ModelSelection;
      /** The marker the continuation starts with, so its limit fallback keeps the lock. */
      readonly routing: TaskRoutingDecision;
      readonly notice: string | null;
    };

/**
 * What this machine continues an arriving thread on. `carried` is what the
 * source sent: a lock, null for a thread that is no review, or nothing at all
 * from a source older than the lock, whose review is then told by its title.
 */
export function arrivedReview(input: {
  readonly carried: HandoffReviewLock | null | undefined;
  readonly title: string;
  /** The model the thread ran on at the source. */
  readonly stored: ModelSelection;
  /** The model the source asked for, when it named one. */
  readonly requested: ModelSelection | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** Whether the source's grant lets it run on this sign-in. */
  readonly allowed: (instanceId: ModelSelection["instanceId"]) => boolean;
  readonly machineLabel: string;
  readonly sourceLabel: string;
  readonly now: string;
}): ArrivedReview {
  let lock = input.carried ?? null;
  if (lock === null) {
    // Told nothing, or told "no review": the title still says what the thread is.
    const told = sourceReviewLock({ title: input.title, modelSelection: input.stored });
    if (told.kind === "unknown-family") return { kind: "refused", message: REVIEW_FAMILY_UNKNOWN };
    if (told.kind === "none") return { kind: "unlocked" };
    lock = told.lock;
  }
  const wanted = input.requested ?? input.stored;
  const offered = input.providers
    .filter(
      (provider) =>
        provider.enabled &&
        provider.installed &&
        provider.auth.status !== "unauthenticated" &&
        input.allowed(provider.instanceId),
    )
    // Only a model the sign-in lists counts: one that lists nothing proves no reviewer.
    .map((provider) => ({
      instanceId: provider.instanceId,
      // The model asked for stays offered; nothing here picks a paid model by itself.
      models: provider.models
        .map((model) => model.slug)
        .filter(
          (slug) =>
            (provider.instanceId === wanted.instanceId && slug === wanted.model) ||
            !isPaidModel(provider, slug),
        ),
    }));
  const pick = lockedReviewerPick(reviewerLock(lock), wanted, offered);
  if (pick === null)
    return { kind: "refused", message: reviewStaysText("no_reviewer", input.machineLabel) };
  const modelSelection = withEffort(lock, pick, wanted);
  const family = familyOfModelId(pick.model) as ReviewFamily;
  const label = MODEL_FAMILY_LABELS[family];
  const moved = pick.instanceId !== wanted.instanceId || pick.model !== wanted.model;
  return {
    kind: "locked",
    modelSelection,
    routing: {
      taskClass: "review",
      confidence: "high",
      moved: false,
      tier: null,
      selection: modelSelection,
      baseline: modelSelection,
      escalation: null,
      billing: "unknown",
      reason: `Review handed off from ${input.sourceLabel}; it stays on ${label} models.`.slice(
        0,
        600,
      ),
      signals: [],
      reviewFamily: family,
      ...(lock.policy.model === undefined ? {} : { reviewModel: pick.model }),
      decidedAt: input.now,
    },
    notice: moved ? `A review keeps to ${label} models, so it continues on ${pick.model}.` : null,
  };
}

const NO_LONGER_A_REVIEW =
  "Review stays here: its last checkpoint no longer shows a review, so its reviewer cannot be kept. Hand it off again.";

/**
 * The decision for a takeover the source sent as a review: only a locked one
 * starts. A checkpoint that arrives as an ordinary thread (renamed at the
 * source since the move began) is refused, never started on the model asked for.
 */
export const sentAsReview = (
  request: { readonly review?: boolean | undefined },
  decision: ArrivedReview,
): ArrivedReview =>
  request.review === true && decision.kind === "unlocked"
    ? { kind: "refused", message: NO_LONGER_A_REVIEW }
    : decision;

/**
 * A later read of a thread whose move began as a review, or as none: the two
 * reads must agree, or the move stops before any takeover is sent.
 */
export const sameReview = <A extends { readonly shell: ReviewThread }, E, R>(
  first: ReviewThread,
  later: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | HandoffModeError, R> =>
  Effect.flatMap(later, (read) =>
    (sourceReviewLock(first).kind === "none") === (sourceReviewLock(read.shell).kind === "none")
      ? Effect.succeed(read)
      : Effect.fail(new HandoffModeError({ code: "invalid", message: NO_LONGER_A_REVIEW })),
  );
