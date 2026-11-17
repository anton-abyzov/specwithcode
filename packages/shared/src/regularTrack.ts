/**
 * Regular work stays on the Regular track. A limit stop on one model holds
 * back that model, not the whole account (Opus keeps running when only
 * Fable's weekly is spent), and a model the person named for regular work is
 * tried on any account that serves it before anything is guessed.
 *
 * @module regularTrack
 */
import type {
  ModelSelection,
  ProviderInstanceId,
  ServerProvider,
} from "@specweave-studio/contracts";
import { fallbackSelectionKey } from "./modelTiers.ts";
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
