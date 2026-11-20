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
  isPaidModelBilling,
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
import {
  defaultLaneOfModel,
  effectiveModelLanes,
  isFreeTrackModel,
  providersForModel,
} from "./modelTracks.ts";

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
  if (model === undefined) return null;
  // An exact entry wins over a newer release an older entry follows.
  for (const covers of [
    (entry: string) => isSameModel({ slug: entry }, { slug: model }),
    (entry: string) => laneEntryCovers(entry, model),
  ]) {
    for (const lane of ["complex", "routine"] as const) {
      if ((lanes?.[lane] ?? []).some((entry) => covers(entry.model))) return lane;
    }
  }
  // A track the person never saved ranks the built-in models, each standing
  // for every release of its family (the GPT-6.2 Sol entry runs GPT-6.1 Sol
  // where that is what a source lists).
  const builtIn = defaultLaneOfModel({ slug: model }, (entry, slug) => {
    if (laneEntryCovers(entry, slug)) return true;
    const [a, b] = [modelFamily(slug), modelFamily(entry)];
    return a !== null && b !== null && a.stem === b.stem;
  });
  return builtIn !== null && (lanes?.[builtIn] ?? []).length === 0 ? builtIn : null;
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
  readonly threadModelMode?: "tracks" | "model" | undefined;
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
  options: TierChainOptions = {},
): ReadonlyArray<ModelSelection> {
  return tierFallbackChain(input, currentModel, providers, options).order;
}

export interface TierChainOptions {
  readonly lane?: ModelLane | undefined;
  /** Add each ranked model on the other providers that serve it (default true). */
  readonly expand?: boolean;
  /** A room reading per provider and model: more room goes first among equals. */
  readonly usedPercent?: (provider: ServerProvider, slug: string) => number | null;
}

/** The tier chain, with the keys of the entries that come from a built-in track. */
function tierFallbackChain(
  input: TierFallbackInput,
  currentModel: string | undefined,
  providers: ReadonlyArray<ServerProvider>,
  options: TierChainOptions,
): { readonly order: ReadonlyArray<ModelSelection>; readonly builtIn: ReadonlySet<string> } {
  const saved = input.modelLanes;
  const { lanes, builtIn: builtInLane } = effectiveModelLanes(
    saved,
    providers,
    input.defaultModelProviders,
  );
  const first =
    options.lane ??
    tierOfModel(saved, currentModel) ??
    tierOfModel(saved, input.defaultModelSelection?.model) ??
    "routine";
  const other = first === "complex" ? "routine" : "complex";
  // Hard work never continues on a free model: the wait for a reset costs less.
  const rest =
    input.threadModelMode === "tracks"
      ? []
      : first === "complex"
      ? lanes[other].filter((entry) => !isFreeTrackModel({ slug: entry.model }))
      : lanes[other];
  const ranked = [
    ...followNewestReleases(lanes[first], providers).map((entry) => ({
      entry,
      builtIn: builtInLane[first],
    })),
    ...followNewestReleases(rest, providers).map((entry) => ({
      entry,
      builtIn: builtInLane[other],
    })),
  ];
  const seen = new Set<string>();
  const order: ModelSelection[] = [];
  const builtIn = new Set<string>();
  const push = (selection: ModelSelection, fromBuiltIn: boolean) => {
    const key = fallbackSelectionKey(selection);
    if (seen.has(key)) return;
    seen.add(key);
    order.push(selection);
    if (fromBuiltIn) builtIn.add(key);
  };
  // The thread's own model on another provider keeps its work where it is
  // before any change of model; then the ranking from the top.
  const own =
    currentModel !== undefined && tierOfModel(saved, currentModel) !== null
      ? ranked.filter(({ entry }) => isSameModel({ slug: entry.model }, { slug: currentModel }))
      : [];
  for (const { entry, builtIn: fromBuiltIn } of [...own, ...ranked]) {
    push(entry, fromBuiltIn);
    if (options.expand === false) continue;
    // The same model elsewhere: its maker first, then the most room.
    for (const { provider, slug } of providersForModel({
      providers,
      model: { slug: entry.model },
      order: input.defaultModelProviders,
      preferFree: isFreeTrackModel({ slug: entry.model }),
      usedPercent: options.usedPercent as Parameters<typeof providersForModel>[0]["usedPercent"],
    })) {
      if (provider.instanceId !== entry.instanceId)
        push({ instanceId: provider.instanceId, model: slug }, fromBuiltIn);
    }
  }
  return { order, builtIn };
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
  options: TierChainOptions = {},
): FallbackChain {
  const explicit = rule.threadModelMode === "tracks" ? [] : fallbackModelOrder(rule);
  if (explicit.length > 0) return { order: explicit, fromTiers: false, builtIn: NO_KEYS };
  return { ...tierFallbackChain(rule, currentModel, providers, options), fromTiers: true };
}

const NO_KEYS: ReadonlySet<string> = new Set();

export interface FallbackChain {
  readonly order: ReadonlyArray<ModelSelection>;
  /** The chain is the model tracks, not a fallback order the person wrote. */
  readonly fromTiers: boolean;
  /**
   * Entries (`fallbackSelectionKey`) that come from a built-in track. The
   * person named none of them, so none may spend money or outrank a provider
   * with a verified usage reading.
   */
  readonly builtIn: ReadonlySet<string>;
}

/** Whether the person wrote any of the chain: a saved order or a saved track. */
export function chainNamedByPerson(chain: FallbackChain): boolean {
  return chain.order.some((entry) => !chain.builtIn.has(fallbackSelectionKey(entry)));
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
      const newer = newestPlanBilled(provider, builtIn);
      if (newer !== undefined) return newer;
    }
    const own = chosen ?? builtIn;
    if (own !== undefined) {
      // A built-in default the provider lists in another release only still names that release.
      const slug =
        sameModelOn(provider, { slug: own }) ??
        (chosen === undefined ? newestOfFamily(provider, own) : undefined);
      if (slug !== undefined) return slug;
      continue;
    }
    for (const driver of TIER_DRIVER_ORDER) {
      const person = tiers?.[driver]?.[wanted];
      const named = person ?? DEFAULT_PROVIDER_MODEL_TIERS[driver]?.[wanted];
      const slug =
        named === undefined
          ? undefined
          : ((person === undefined ? newestPlanBilled(provider, named) : undefined) ??
            sameModelOn(provider, { slug: named }) ??
            (person === undefined ? newestOfFamily(provider, named) : undefined));
      if (slug !== undefined) return slug;
    }
  }
  return undefined;
}

/**
 * The newest listed release of `slug`'s family, unless it is billed per use
 * or its billing is unknown: a built-in default never starts a worker on
 * something that may cost money.
 */
function newestPlanBilled(
  provider: Pick<ServerProvider, "models">,
  slug: string,
): string | undefined {
  const base = modelFamily(slug);
  if (!base) return undefined;
  // Newest first, past any release billed per use: GPT-6.1 Sol on a plan
  // before GPT-6.2 Sol billed per token.
  return provider.models
    .flatMap((model) => {
      const family = model.isCustom ? null : modelFamily(model.slug);
      if (!family || family.stem !== base.stem) return [];
      const billing = providerModelBilling(provider, model.slug);
      return billing === "unknown" || isPaidModelBilling(billing)
        ? []
        : [{ slug: model.slug, version: family.version }];
    })
    .sort((a, b) => compareModelVersions(b.version, a.version))[0]?.slug;
}

const VERSIONED_SLUG = /^(.*[a-z])-(\d{1,3}(?:[.-]\d{1,3})*)$/;

/**
 * Names that follow the version in a slug and name the model line, not a
 * variant: `gpt-6.1-sol` is the Sol line at 6.1. Each is its own family, so
 * Sol never follows into Astra. A word not listed here (`mini`, `preview`)
 * leaves the slug without a family.
 */
export const MODEL_CODENAMES: ReadonlyArray<string> = ["sol", "astra", "luna", "carbon", "neon"];

const CODENAME_SLUG = new RegExp(
  `^(.*[a-z])-(\\d{1,3}(?:[.-]\\d{1,3})*)-(${MODEL_CODENAMES.join("|")})$`,
);

/**
 * A slug's family (name stem) and release version: `claude-fable-5-2` is
 * `claude-fable` 5.2 and `gpt-6.1-sol` is `gpt-sol` 6.1. Other slugs without
 * a trailing version and dated snapshots (`claude-haiku-4-5-20251001`) have
 * none.
 */
export function modelFamily(
  slug: string,
): { readonly stem: string; readonly version: ReadonlyArray<number> } | null {
  const versions = (text: string) => text.split(/[.-]/).map(Number);
  const match = VERSIONED_SLUG.exec(slug);
  if (match) return { stem: match[1]!, version: versions(match[2]!) };
  const named = CODENAME_SLUG.exec(slug);
  return named ? { stem: `${named[1]!}-${named[3]!}`, version: versions(named[2]!) } : null;
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
 * The release that replaces `slug` on `provider`: the successor the model
 * manifest names, else the newest listed release of its family when that is
 * newer. Only one billed the same way, else undefined: choosing a model never consents to
 * a release that costs money or reports unknown billing.
 */
export function newerOfFamily(
  provider: Pick<ServerProvider, "models">,
  slug: string,
): string | undefined {
  const billing = providerModelBilling(provider, slug);
  // Billing nobody proved is never "the same".
  const sameBilling = (other: string) =>
    billing !== "unknown" && providerModelBilling(provider, other) === billing;
  // A successor the model manifest names leads: a new line with a new name
  // has no family in common with the one it replaces. One walk, each model
  // once, so a manifest that names two models as each other's successor ends.
  let at = slug;
  const visited = new Set([slug]);
  for (;;) {
    const next = provider.models.find(
      (model) => !model.isCustom && model.succeeds === at && !visited.has(model.slug),
    );
    if (next === undefined || !sameBilling(next.slug)) break;
    visited.add(next.slug);
    at = next.slug;
  }
  // Then the newest release of the family the walk ended in.
  const newest = newestOfFamily(provider, at);
  const [a, b] = [newest && modelFamily(newest), modelFamily(at)];
  if (newest && a && b && compareModelVersions(a.version, b.version) > 0 && sameBilling(newest))
    return newest;
  return at === slug ? undefined : at;
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
  providers: ReadonlyArray<ServerProvider>,
): FallbackChain {
  return effectiveFallbackOrder(rule, currentModel, providers, { expand: false });
}

/** Drivers whose tier models a provider without its own entry borrows, in order. */
const TIER_DRIVER_ORDER = ["codex", "claudeAgent", "muse"] as const;
