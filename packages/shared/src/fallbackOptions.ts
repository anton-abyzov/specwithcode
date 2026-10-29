/**
 * Every model on this machine a limited thread could continue on, grouped by
 * model family, with why each one can or cannot take the thread now and what
 * kind of access backs it. Built from the same checks the automatic switch
 * makes (`providerFallback.ts`), so the view and the switch never disagree.
 *
 * Access is only what SpecWithCode can observe: a usage reading, a provider
 * that reports none, or billing per token. Credits held elsewhere (GitHub
 * Actions minutes, an X subscription, startup credits) are not model access
 * here and are never inferred.
 *
 * @module fallbackOptions
 */
import type {
  ModelSelection,
  ProviderInstanceId,
  ServerProvider,
} from "@specweave-studio/contracts";

import {
  canTakeTurn,
  type ExcludedFallbackModel,
  fallbackModelOrder,
  hasUsableFallbackCapacity,
  isExcludedFallbackModel,
  isGeminiSpendProvider,
  isPaidModelOn,
  isUnknownBillingAgent,
  normalizeModelKey,
  providerUsedPercent,
  reportsNoUsage,
  usageDeniesTurn,
  usageResetAt,
} from "./providerFallback.ts";

export type ModelFamily = "claude" | "openai" | "google" | "xai" | "meta" | "other";

export const MODEL_FAMILY_LABELS: Record<ModelFamily, string> = {
  claude: "Claude",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  meta: "Meta",
  other: "Other",
};

const FAMILY_ORDER: ReadonlyArray<ModelFamily> = [
  "claude",
  "openai",
  "google",
  "xai",
  "meta",
  "other",
];

const FAMILY_RULES: ReadonlyArray<readonly [RegExp, ModelFamily]> = [
  [/claude|opus|sonnet|haiku|fable/, "claude"],
  [/(?:^|[^a-z])(?:gpt|codex|o\d+)(?:$|[^a-z])/, "openai"],
  [/gemini|gemma|argon/, "google"],
  [/grok/, "xai"],
  [/llama|wonder|muse|(?:^|[^a-z])meta(?:$|[^a-z])/, "meta"],
];

/** The family a model belongs to, from its slug or name; never from the provider. */
export function modelFamily(model: {
  readonly slug: string;
  readonly name?: string | undefined;
}): ModelFamily {
  for (const spelling of [model.slug, model.name]) {
    if (spelling === undefined) continue;
    const key = spelling.toLowerCase();
    for (const [pattern, family] of FAMILY_RULES) if (pattern.test(key)) return family;
  }
  return "other";
}

/** Whether a limited thread may continue on this model now, or why not. */
export type FallbackOptionStatus =
  /** Takes the thread now. */
  | "ready"
  /** Installed and signed in, but its usage has not been read recently. */
  | "unverified"
  /** The thread already runs here. */
  | "current"
  /** The user keeps this model out of automatic fallback. */
  | "excluded"
  | "disabled"
  | "signed-out"
  /** Not installed, not prepared or not ready on this machine. */
  | "not-ready"
  /** Stopped on its limit with no usage reading to say otherwise. */
  | "limited"
  /** A usage window is at or past the switch threshold. */
  | "full"
  /** Billed per token: used only when named, or through the API-credit opt-in. */
  | "per-token"
  /** Gemini or Vertex bills a Cloud project: never an automatic fallback. */
  | "never-automatic"
  /** An agent whose billing is unknown: used only when the user names it. */
  | "named-only";

/** What backs the access, as far as SpecWithCode can see. */
export type FallbackOptionAccess =
  /** A usage reading from the provider: a subscription or plan with known room. */
  | "usage-read"
  /** Signed in, but the provider reports no usage (GitHub Copilot). */
  | "no-usage-reported"
  | "per-token"
  | "unknown";

export interface FallbackOption {
  readonly selection: ModelSelection;
  readonly provider: ServerProvider;
  readonly modelName: string;
  readonly family: ModelFamily;
  readonly status: FallbackOptionStatus;
  readonly access: FallbackOptionAccess;
  /** The fullest live window's use, when the provider reports one. */
  readonly usedPercent: number | null;
  /** When a full model's windows reset, if every one names a time. */
  readonly resetAt: number | null;
  /** Its place in the user's fallback order (0 first), or null. */
  readonly orderIndex: number | null;
  readonly excluded: boolean;
}

export interface FallbackOptionGroup {
  readonly family: ModelFamily;
  readonly label: string;
  readonly options: ReadonlyArray<FallbackOption>;
}

export function describeFallbackOptions(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  /** The thread's instance, when describing options for one thread. */
  readonly currentInstanceId?: ProviderInstanceId | null | undefined;
  /** The thread's model; without it every model on the current instance counts as current. */
  readonly currentModel?: string | null | undefined;
  readonly rule: {
    readonly providerLimitFallbackModels?: ReadonlyArray<ModelSelection> | undefined;
    readonly providerLimitFallbackModelSelection: ModelSelection | null;
    readonly providerLimitExcludedModels?: ReadonlyArray<ExcludedFallbackModel> | undefined;
  };
  readonly nowMs: number;
  readonly belowPercent?: number | null | undefined;
  readonly limitedInstanceIds?: ReadonlySet<string> | undefined;
}): ReadonlyArray<FallbackOptionGroup> {
  const order = fallbackModelOrder(input.rule);
  const threshold = input.belowPercent ?? 100;
  const options = input.providers.flatMap((provider) =>
    provider.models.map((model): FallbackOption => {
      const selection = { instanceId: provider.instanceId, model: model.slug };
      const excluded = isExcludedFallbackModel(
        input.rule.providerLimitExcludedModels,
        provider.instanceId,
        model.slug,
      );
      const usedPercent = providerUsedPercent(provider, input.nowMs, model.slug);
      const access: FallbackOptionAccess = isPaidModelOn(provider, model.slug)
        ? "per-token"
        : reportsNoUsage(provider)
          ? provider.auth.status === "authenticated"
            ? "no-usage-reported"
            : "unknown"
          : "usage-read";
      const orderIndex = order.findIndex(
        (entry) => entry.instanceId === provider.instanceId && entry.model === model.slug,
      );
      const status = optionStatus({
        provider,
        model: model.slug,
        excluded,
        namedInOrder: orderIndex !== -1,
        current:
          provider.instanceId === input.currentInstanceId &&
          (input.currentModel == null ||
            normalizeModelKey(input.currentModel) === normalizeModelKey(model.slug)),
        limited: input.limitedInstanceIds?.has(provider.instanceId) === true,
        usedPercent,
        threshold,
        nowMs: input.nowMs,
      });
      return {
        selection,
        provider,
        modelName: model.name || model.slug,
        family: modelFamily(model),
        status,
        access,
        usedPercent,
        resetAt:
          status === "full" ? usageResetAt(provider, threshold, input.nowMs, model.slug) : null,
        orderIndex: orderIndex === -1 ? null : orderIndex,
        excluded,
      };
    }),
  );
  return FAMILY_ORDER.flatMap((family) => {
    const inFamily = options.filter((option) => option.family === family);
    return inFamily.length === 0
      ? []
      : [{ family, label: MODEL_FAMILY_LABELS[family], options: inFamily }];
  });
}

function optionStatus(input: {
  readonly provider: ServerProvider;
  readonly model: string;
  readonly excluded: boolean;
  readonly namedInOrder: boolean;
  readonly current: boolean;
  readonly limited: boolean;
  readonly usedPercent: number | null;
  readonly threshold: number;
  readonly nowMs: number;
}): FallbackOptionStatus {
  const { provider, model } = input;
  if (input.current) return "current";
  if (input.excluded) return "excluded";
  if (!provider.enabled) return "disabled";
  if (provider.auth.status === "unauthenticated") return "signed-out";
  // A Gemini spend model the person named in their fallback order is their
  // spending choice and reports its real readiness; unnamed it never moves
  // a thread on its own.
  if (isGeminiSpendProvider(provider) && !input.namedInOrder) return "never-automatic";
  if (isPaidModelOn(provider, model)) return "per-token";
  if (isUnknownBillingAgent(provider, model)) return "named-only";
  if (input.limited) return "limited";
  if (usageDeniesTurn(provider)) return "full";
  if (!canTakeTurn(provider)) return "not-ready";
  if (reportsNoUsage(provider)) return "ready";
  if (input.usedPercent !== null && input.usedPercent >= input.threshold) return "full";
  if (!hasUsableFallbackCapacity(provider, input.nowMs, model)) return "unverified";
  return "ready";
}

/** An exclusion list with `model` toggled on every provider, kept unique and in order. */
export function toggleExcludedModel(
  excluded: ReadonlyArray<ExcludedFallbackModel>,
  model: string,
  instanceId?: ProviderInstanceId,
): ReadonlyArray<ExcludedFallbackModel> {
  const key = normalizeModelKey(model);
  const matches = (entry: ExcludedFallbackModel) =>
    normalizeModelKey(entry.model) === key &&
    (instanceId === undefined || entry.instanceId === undefined || entry.instanceId === instanceId);
  if (excluded.some(matches)) return excluded.filter((entry) => !matches(entry));
  return [...excluded, instanceId === undefined ? { model } : { model, instanceId }];
}
