/**
 * Regular work stays on the Regular track. A limit stop on one model holds
 * back that model, not the whole account (Opus keeps running when only
 * Fable's weekly is spent), and a model the person named for regular work is
 * tried on any account that serves it before anything is guessed.
 *
 * @module regularTrack
 */
import {
  DEFAULT_MODEL_TRACKS,
  type ModelLanes,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { isSameModel } from "./modelIdentity.ts";
import { fallbackSelectionKey, modelFamily } from "./modelTiers.ts";
import {
  type ContextFitRequirement,
  type ExcludedFallbackModel,
  resolveSameModelElsewhere,
} from "./providerFallback.ts";
import { isLiveWindow, windowAppliesToModel, windowModelScope } from "./usageWindows.ts";

/**
 * Whether a usage-limit stop on `model` holds back every model of `provider`.
 * Only positive evidence scopes it to the model: a live spent window limited
 * to that model's family while no account-wide window is spent and no spend
 * control is reached. Without that evidence the stop is account-wide.
 */
export function limitStopIsAccountWide(
  provider: ServerProvider | undefined,
  model: string | null | undefined,
  nowMs: number,
): boolean {
  const limits = provider?.usageLimits;
  if (limits === undefined || limits.spendControlReached === true || !model) return true;
  const spent = limits.windows.filter(
    (window) => window.usedPercent >= 100 && isLiveWindow(window, nowMs),
  );
  if (spent.some((window) => windowModelScope(window) === null)) return true;
  return !spent.some((window) => windowAppliesToModel(window, model));
}

/**
 * Whether a denial the account reported spares `model`: every spent window is
 * scoped to other models (Fable's weekly while Opus runs) and no spend control
 * is reached. Such a denial says nothing about `model`'s room.
 */
export function denialSparesModel(
  provider: ServerProvider,
  model: string | null | undefined,
  nowMs: number,
): boolean {
  const limits = provider.usageLimits;
  if (limits === undefined || limits.spendControlReached === true || !model) return false;
  const spent = limits.windows.filter(
    (window) => window.usedPercent >= 100 && isLiveWindow(window, nowMs),
  );
  return (
    spent.length > 0 &&
    spent.every(
      (window) => windowModelScope(window) !== null && !windowAppliesToModel(window, model),
    )
  );
}

/**
 * A model of the person's own fallback list on another account that serves
 * it, when its own account cannot take the thread: Opus 5.5 on Copilot
 * Enterprise once the Claude account is spent. The person named the model,
 * so an account that reports no usage may take it ahead of a guess.
 */
export function namedModelElsewhere(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly order: ReadonlyArray<ModelSelection>;
  readonly currentInstanceId: ProviderInstanceId;
  /** The stopped model: never its own continuation on its own account. */
  readonly currentModel?: string | undefined;
  readonly nowMs: number;
  readonly belowPercent?: number | null | undefined;
  readonly limitedInstanceIds?: ReadonlySet<string> | undefined;
  readonly excludedSelections?: ReadonlySet<string> | undefined;
  readonly excludedModels?: ReadonlyArray<ExcludedFallbackModel> | undefined;
  readonly contextFit?: ContextFitRequirement | undefined;
  readonly sourceOrder?: ReadonlyArray<ProviderInstanceId> | undefined;
}): ModelSelection | null {
  // The stopped account still serves its other models (Opus after a Fable
  // stop); with the stopped model unknown, the whole account is out.
  const { currentInstanceId, currentModel } = input;
  const tried = new Set(input.excludedSelections);
  if (currentModel !== undefined)
    tried.add(fallbackSelectionKey({ instanceId: currentInstanceId, model: currentModel }));
  const providers =
    currentModel === undefined
      ? input.providers.filter((provider) => provider.instanceId !== currentInstanceId)
      : input.providers;
  for (const entry of input.order) {
    const elsewhere = resolveSameModelElsewhere({
      providers,
      current: entry,
      order: input.sourceOrder,
      nowMs: input.nowMs,
      belowPercent: input.belowPercent,
      limitedInstanceIds: input.limitedInstanceIds,
      excludedSelections: tried,
      excludedModels: input.excludedModels,
      contextFit: input.contextFit,
    });
    if (elsewhere !== null) return elsewhere;
  }
  return null;
}

/**
 * A model's line: its family stem without the version and without a size
 * variant, so `muse-wonder-1.0` and `muse-wonder-full-1.0` are both the Muse
 * Wonder line, while `claude-opus-5-5` and `claude-sonnet-5-5` stay apart.
 */
export function modelLine(slug: string): string {
  const key = slug
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/^.*\//, "")
    .replace(/[\s_]+/g, "-");
  const stem = modelFamily(key)?.stem ?? key.replace(/-?\d[\d.-]*/g, "-");
  return stem
    .split("-")
    .filter((part) => part.length > 0 && !LINE_VARIANTS.has(part))
    .join("-");
}

/** Words that name a size or build of one model line, not another line. */
const LINE_VARIANTS: ReadonlySet<string> = new Set(["full", "latest", "preview"]);

/** What `reviewOnlyModel` reads of the project settings. */
export interface RegularTrackRule {
  readonly adversarialReview?: { readonly reviewers?: ReadonlyArray<ModelSelection> } | undefined;
  readonly modelLanes?: ModelLanes | null | undefined;
  readonly providerLimitFallbackModels?: ReadonlyArray<ModelSelection> | undefined;
  readonly providerLimitFallbackModelSelection?: ModelSelection | null | undefined;
  readonly defaultModelSelection?: ModelSelection | null | undefined;
}

/**
 * Whether `model`'s line (`modelLine`) is on the Review track: the person's
 * reviewers, else the built-in Review order.
 */
function reviewTrackLine(
  rule: Pick<RegularTrackRule, "adversarialReview">,
): (selection: Pick<ModelSelection, "model">) => boolean {
  const reviewers = rule.adversarialReview?.reviewers ?? [];
  const reviewLines = new Set(
    (reviewers.length > 0
      ? reviewers.map((entry) => entry.model)
      : DEFAULT_MODEL_TRACKS.review.map((entry) => entry.model)
    ).map(modelLine),
  );
  return ({ model }) => reviewLines.has(modelLine(model));
}

/**
 * Whether `model` belongs only to the Review track, so regular work never
 * falls back to it. The Review track is the person's reviewers, else the
 * built-in Review order; a model is Review-only when its line (`modelLine`)
 * is on that track and the model itself is not on the Regular side: the
 * Daily and Complex tracks (the person's, else the built-in ones), their
 * fallback list, or the project's default model. The whole line is held
 * back because a provider's default can be a sibling of the reviewer (Muse
 * Wonder 1.0 next to the Muse Wonder Full reviewer). A model the person named
 * counts by its own identity; a built-in entry by its line, since it follows
 * the newest release (GPT-6.2 Sol for the GPT-6.1 Sol entry).
 */
export function reviewOnlyModel(
  rule: RegularTrackRule,
): (selection: Pick<ModelSelection, "model">) => boolean {
  const onReviewTrack = reviewTrackLine(rule);
  const builtInLines = new Set<string>();
  const lane = (saved: ReadonlyArray<ModelSelection> | undefined, track: "daily" | "complex") => {
    if (saved !== undefined && saved.length > 0) {
      // An entry saved from a built-in row follows its family, so it counts by its line too.
      for (const entry of saved)
        if (DEFAULT_MODEL_TRACKS[track].some((builtIn) => builtIn.model === entry.model))
          builtInLines.add(modelLine(entry.model));
      return saved.map((entry) => entry.model);
    }
    for (const entry of DEFAULT_MODEL_TRACKS[track]) builtInLines.add(modelLine(entry.model));
    return [];
  };
  const regular = [
    ...lane(rule.modelLanes?.routine, "daily"),
    ...lane(rule.modelLanes?.complex, "complex"),
    ...(rule.providerLimitFallbackModels ?? []).map((entry) => entry.model),
    ...[rule.providerLimitFallbackModelSelection, rule.defaultModelSelection].flatMap((entry) =>
      entry == null ? [] : [entry.model],
    ),
  ];
  return ({ model }) => {
    const line = modelLine(model);
    return (
      onReviewTrack({ model }) &&
      !builtInLines.has(line) &&
      !regular.some((named) => isSameModel({ slug: named }, { slug: model }))
    );
  };
}
