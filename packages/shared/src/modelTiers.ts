/**
 * Model tiers: the person's ranked models for everyday work and for the
 * hardest work (the `routine` and `complex` model lanes). A new worker starts
 * on the first ready model of its tier (see `modelLanes`); when no explicit
 * fallback order is set, the same ranking is also where a limited thread
 * continues: down its own tier, each model on any other provider that serves
 * it, then down the other tier.
 *
 * @module modelTiers
 */
import {
  DEFAULT_PROVIDER_MODEL_TIERS,
  type ModelLane,
  type ModelLanes,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderModelTier,
  type ProviderModelTiers,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { isSameModel, sameModelOn } from "./modelIdentity.ts";

export const MODEL_TIER_LABELS: Record<ModelLane, string> = {
  routine: "Everyday work",
  complex: "Hardest work",
};

interface FallbackOrderRule {
  /** The models to continue on, best first; empty uses the single model below. */
  readonly providerLimitFallbackModels?: ReadonlyArray<ModelSelection> | undefined;
  readonly providerLimitFallbackModelSelection: ModelSelection | null;
}

/** The user's explicit fallback order: the list, else the legacy single model, else nothing. */
export function fallbackModelOrder(rule: FallbackOrderRule): ReadonlyArray<ModelSelection> {
  if (rule.providerLimitFallbackModels && rule.providerLimitFallbackModels.length > 0)
    return rule.providerLimitFallbackModels;
  return rule.providerLimitFallbackModelSelection ? [rule.providerLimitFallbackModelSelection] : [];
}

/** A fallback order entry's identity, for sets of entries already tried. */
export function fallbackSelectionKey(selection: Pick<ModelSelection, "instanceId" | "model">) {
  return `${selection.instanceId}\u0000${selection.model}`;
}

/** The tier whose ranking holds `model` (under any provider's spelling), hardest first. */
export function tierOfModel(
  lanes: ModelLanes | null | undefined,
  model: string | undefined,
): ModelLane | null {
  if (lanes == null || model === undefined) return null;
  for (const lane of ["complex", "routine"] as const) {
    if ((lanes[lane] ?? []).some((entry) => isSameModel({ slug: entry.model }, { slug: model })))
      return lane;
  }
  return null;
}

/** Whether a tier itself ranks a model on `instanceId` (not just its expansion elsewhere). */
export function tierNamesInstance(
  input: { readonly modelLanes?: ModelLanes | null | undefined },
  instanceId: ProviderInstanceId,
): boolean {
  const lanes = input.modelLanes;
  return [...(lanes?.complex ?? []), ...(lanes?.routine ?? [])].some(
    (entry) => entry.instanceId === instanceId,
  );
}

export interface TierFallbackInput {
  readonly modelLanes?: ModelLanes | null | undefined;
  /** The project's recommended model: its tier goes first when the thread's own model has none. */
  readonly defaultModelSelection?: ModelSelection | null | undefined;
  /** "Also served by": the providers to try first for a tier model on another provider. */
  readonly defaultModelProviders?: ReadonlyArray<ProviderInstanceId> | undefined;
}

/**
 * The limit fallback chain the tiers give a thread on `currentModel`: its own
 * tier (else the recommended model's, else everyday work), then the other
 * one. The thread's own model leads when a tier lists it. Each ranked model is followed by the same model on the other providers
 * that serve it, so a ranking names models and the providers only decide
 * where each runs. Empty when no tier lists a model.
 */
export function tierFallbackOrder(
  input: TierFallbackInput,
  currentModel: string | undefined,
  providers: ReadonlyArray<ServerProvider> = [],
): ReadonlyArray<ModelSelection> {
  const lanes = input.modelLanes;
  if (lanes == null) return [];
  const first =
    tierOfModel(lanes, currentModel) ??
    tierOfModel(lanes, input.defaultModelSelection?.model) ??
    "routine";
  const ranked = [
    ...(lanes[first] ?? []),
    ...(lanes[first === "complex" ? "routine" : "complex"] ?? []),
  ];
  const providerRank = (instanceId: ProviderInstanceId) => {
    const index = input.defaultModelProviders?.indexOf(instanceId) ?? -1;
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const elsewhere = providers
    .filter((provider) => provider.enabled)
    .sort((a, b) => providerRank(a.instanceId) - providerRank(b.instanceId));
  const seen = new Set<string>();
  const order: ModelSelection[] = [];
  const push = (selection: ModelSelection) => {
    const key = fallbackSelectionKey(selection);
    if (seen.has(key)) return;
    seen.add(key);
    order.push(selection);
  };
  // The thread's own model on another provider keeps its work where it is
  // before any change of model; then the ranking from the top.
  const own =
    currentModel !== undefined && tierOfModel(lanes, currentModel) !== null
      ? ranked.filter((entry) => isSameModel({ slug: entry.model }, { slug: currentModel }))
      : [];
  for (const entry of [...own, ...ranked]) {
    push(entry);
    for (const provider of elsewhere) {
      if (provider.instanceId === entry.instanceId) continue;
      const slug = sameModelOn(provider, { slug: entry.model });
      if (slug !== undefined) push({ instanceId: provider.instanceId, model: slug });
    }
  }
  return order;
}

/**
 * The chain a limited thread follows: the explicit fallback order when the
 * user set one, else the model tiers. `fromTiers` marks a chain the user did
 * not write as a fallback list, so nothing on it may spend money.
 */
export function effectiveFallbackOrder(
  rule: FallbackOrderRule & TierFallbackInput,
  currentModel: string | undefined,
  providers: ReadonlyArray<ServerProvider> = [],
): { readonly order: ReadonlyArray<ModelSelection>; readonly fromTiers: boolean } {
  const explicit = fallbackModelOrder(rule);
  if (explicit.length > 0) return { order: explicit, fromTiers: false };
  return { order: tierFallbackOrder(rule, currentModel, providers), fromTiers: true };
}

/**
 * The model `provider` runs for `tier`: the person's choice for that
 * instance, else for its driver, else the built-in default
 * (`DEFAULT_PROVIDER_MODEL_TIERS`). A provider with no entry of its own
 * (GitHub Copilot, OpenCode) uses the first tier model another driver names
 * that it serves. Only a model the provider lists is returned; frontier
 * falls back to regular, and undefined means neither is served.
 */
export function tierModelFor(
  provider: Pick<ServerProvider, "instanceId" | "driver" | "models">,
  tier: ProviderModelTier,
  tiers: ProviderModelTiers | undefined = undefined,
): string | undefined {
  const order: ReadonlyArray<ProviderModelTier> =
    tier === "frontier" ? ["frontier", "regular"] : ["regular"];
  for (const wanted of order) {
    const chosen = tiers?.[provider.instanceId]?.[wanted] ?? tiers?.[provider.driver]?.[wanted];
    const builtIn = DEFAULT_PROVIDER_MODEL_TIERS[provider.driver]?.[wanted];
    // A built-in default follows its family to the newest release the provider
    // lists (newer or older than the literal), so a new model takes the tier
    // without a code change; a person's choice stays exact.
    if (chosen === undefined && builtIn !== undefined) {
      const newer = newestOfFamily(provider, builtIn);
      if (newer !== undefined) return newer;
    }
    const own = chosen ?? builtIn;
    if (own !== undefined) {
      const slug = sameModelOn(provider, { slug: own });
      if (slug !== undefined) return slug;
      continue;
    }
    for (const driver of TIER_DRIVER_ORDER) {
      const person = tiers?.[driver]?.[wanted];
      const named = person ?? DEFAULT_PROVIDER_MODEL_TIERS[driver]?.[wanted];
      const slug =
        named === undefined
          ? undefined
          : ((person === undefined ? newestOfFamily(provider, named) : undefined) ??
            sameModelOn(provider, { slug: named }));
      if (slug !== undefined) return slug;
    }
  }
  return undefined;
}

const VERSIONED_SLUG = /^(.*[a-z])-(\d{1,3}(?:[.-]\d{1,3})*)$/;

/**
 * The newest model `provider` lists of the same family as `slug` (same name
 * stem, numeric version after it). Slugs without a trailing version
 * (`gpt-6-astra`) and dated snapshots never match.
 */
export function newestOfFamily(
  provider: Pick<ServerProvider, "models">,
  slug: string,
): string | undefined {
  const base = VERSIONED_SLUG.exec(slug);
  if (!base) return undefined;
  const version = (value: string) => value.split(/[.-]/).map(Number);
  const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const diff = (a[i] ?? 0) - (b[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  };
  let best: { slug: string; version: number[] } | undefined;
  for (const model of provider.models) {
    if (model.isCustom) continue;
    const match = VERSIONED_SLUG.exec(model.slug);
    if (!match || match[1] !== base[1]) continue;
    const candidate = version(match[2]!);
    if (!best || compare(candidate, best.version) > 0)
      best = { slug: model.slug, version: candidate };
  }
  return best?.slug;
}

/** Drivers whose tier models a provider without its own entry borrows, in order. */
const TIER_DRIVER_ORDER = ["codex", "claudeAgent", "muse"] as const;
