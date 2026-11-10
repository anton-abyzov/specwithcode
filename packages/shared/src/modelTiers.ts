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
  providerModelBilling,
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
  // An exact entry wins over a newer release an older entry follows.
  for (const covers of [
    (entry: string) => isSameModel({ slug: entry }, { slug: model }),
    (entry: string) => laneEntryCovers(entry, model),
  ]) {
    for (const lane of ["complex", "routine"] as const) {
      if ((lanes[lane] ?? []).some((entry) => covers(entry.model))) return lane;
    }
  }
  return null;
}

/**
 * Whether a tier entry stands for `model`: the same model, or a newer release
 * of its family, which the tier follows (see `followNewestReleases`).
 */
function laneEntryCovers(entry: string, model: string): boolean {
  if (isSameModel({ slug: entry }, { slug: model })) return true;
  const [a, b] = [modelFamily(model), modelFamily(entry)];
  return (
    a !== null && b !== null && a.stem === b.stem && compareModelVersions(a.version, b.version) > 0
  );
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
  const ranked = followNewestReleases(
    [...(lanes[first] ?? []), ...(lanes[first === "complex" ? "routine" : "complex"] ?? [])],
    providers,
  );
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
 * A slug's family (name stem) and release version: `claude-fable-5-2` is
 * `claude-fable` 5.2. Slugs without a trailing version (`gpt-6-astra`) and
 * dated snapshots (`claude-haiku-4-5-20251001`) have none.
 */
export function modelFamily(
  slug: string,
): { readonly stem: string; readonly version: ReadonlyArray<number> } | null {
  const match = VERSIONED_SLUG.exec(slug);
  return match ? { stem: match[1]!, version: match[2]!.split(/[.-]/).map(Number) } : null;
}

/** Positive when release `a` is newer than `b`. */
export function compareModelVersions(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The newest model `provider` lists of the same family as `slug` (same name
 * stem, numeric version after it). Slugs without a trailing version
 * (`gpt-6-astra`) and dated snapshots never match.
 */
export function newestOfFamily(
  provider: Pick<ServerProvider, "models">,
  slug: string,
): string | undefined {
  const base = modelFamily(slug);
  if (!base) return undefined;
  let best: { slug: string; version: ReadonlyArray<number> } | undefined;
  for (const model of provider.models) {
    if (model.isCustom) continue;
    const family = modelFamily(model.slug);
    if (!family || family.stem !== base.stem) continue;
    if (!best || compareModelVersions(family.version, best.version) > 0)
      best = { slug: model.slug, version: family.version };
  }
  return best?.slug;
}

/**
 * The newest listed release of `slug`'s family when it is newer than `slug`
 * and billed the same way, else undefined: choosing a model never consents to
 * a release that costs money or reports unknown billing.
 */
export function newerOfFamily(
  provider: Pick<ServerProvider, "models">,
  slug: string,
): string | undefined {
  const newest = newestOfFamily(provider, slug);
  const [a, b] = [newest && modelFamily(newest), modelFamily(slug)];
  if (!a || !b || compareModelVersions(a.version, b.version) <= 0) return undefined;
  return providerModelBilling(provider, newest) === providerModelBilling(provider, slug)
    ? newest
    : undefined;
}

/**
 * Tier entries led by the newest release of their family that the same
 * provider lists (Fable 5.2, then the chosen Fable 5.1, once 5.2 is
 * offered), without duplicates. An entry the provider does not list, or that
 * is already the newest, stays as written.
 */
export function followNewestReleases(
  entries: ReadonlyArray<ModelSelection>,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "models">>,
): ReadonlyArray<ModelSelection> {
  const seen = new Set<string>();
  const out: ModelSelection[] = [];
  for (const entry of entries) {
    const provider = providers.find((candidate) => candidate.instanceId === entry.instanceId);
    const newer =
      provider && provider.models.some((model) => model.slug === entry.model)
        ? newerOfFamily(provider, entry.model)
        : undefined;
    // The newer release leads; the person's own choice stays right behind it.
    for (const next of newer === undefined ? [entry] : [{ ...entry, model: newer }, entry]) {
      const key = fallbackSelectionKey(next);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(next);
    }
  }
  return out;
}

/**
 * The fallback chain as the person wrote it, without other providers'
 * copies: the explicit order, or the tiers with each entry following its
 * family's newest listed release.
 */
export function namedFallbackOrder(
  rule: FallbackOrderRule & TierFallbackInput,
  currentModel: string | undefined,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "models">>,
): { readonly order: ReadonlyArray<ModelSelection>; readonly fromTiers: boolean } {
  const chain = effectiveFallbackOrder(rule, currentModel);
  return chain.fromTiers
    ? { ...chain, order: followNewestReleases(chain.order, providers) }
    : chain;
}

/** Drivers whose tier models a provider without its own entry borrows, in order. */
const TIER_DRIVER_ORDER = ["codex", "claudeAgent", "muse"] as const;
