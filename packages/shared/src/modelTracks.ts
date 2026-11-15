/**
 * Model tracks: Daily, Complex and Review, the three ordered model lists.
 * A track names models; this module decides where each one runs. A model's
 * maker comes first (Claude models on a Claude subscription, GPT on Codex),
 * then every other provider that lists it, the one with the most room first.
 * A track the person never saved takes the built-in order
 * (`DEFAULT_MODEL_TRACKS`), fitted to the providers this machine has.
 *
 * @module modelTracks
 */
import {
  DEFAULT_MODEL_TRACKS,
  isPaidModelBilling,
  type ModelLane,
  type ModelLanes,
  type ModelSelection,
  type ModelTrack,
  type ProviderInstanceId,
  providerModelBilling,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { isSameModel, sameModelOn } from "./modelIdentity.ts";
import { type ModelFamily, modelFamily } from "./modelVendor.ts";

type TrackProvider = Pick<ServerProvider, "instanceId" | "driver" | "enabled" | "models"> &
  Partial<Pick<ServerProvider, "auth">>;
type ModelNames = { readonly slug: string; readonly name?: string };

/** The lane a track is stored in; Review lives in the adversarial review settings. */
export const TRACK_LANES: Readonly<Record<Exclude<ModelTrack, "review">, ModelLane>> = {
  daily: "routine",
  complex: "complex",
};

/** Drivers that are a vendor's own way to run its models. */
const DRIVER_HOME_FAMILY: Readonly<Record<string, ModelFamily>> = {
  claudeAgent: "claude",
  codex: "openai",
  muse: "meta",
  grok: "xai",
  antigravity: "google",
};

/**
 * The vendor whose models `provider` is the maker's own route to, or null for
 * a provider that resells other vendors' models (GitHub Copilot, Cursor,
 * Devin). An agent behind the shared ACP driver is read from its instance id.
 */
export function providerHomeFamily(
  provider: Pick<ServerProvider, "instanceId" | "driver">,
): ModelFamily | null {
  const byDriver = DRIVER_HOME_FAMILY[provider.driver];
  if (byDriver !== undefined) return byDriver;
  const id = provider.instanceId.toLowerCase();
  if (/gemini/.test(id)) return "google";
  if (/grok/.test(id)) return "xai";
  return null;
}

/** Whether `provider` is the maker's own route to `model`. */
export function isMakerOf(
  provider: Pick<ServerProvider, "instanceId" | "driver">,
  model: ModelNames,
): boolean {
  return providerHomeFamily(provider) === modelFamily(model);
}

/** Whether `provider` is signed in to a plan that costs nothing (ChatGPT Free, Copilot Free). */
export function isFreePlanProvider(provider: Partial<Pick<ServerProvider, "auth">>): boolean {
  return /\bfree\b/i.test(provider.auth?.label ?? "");
}

export interface ModelProviderChoice<P extends TrackProvider = TrackProvider> {
  readonly provider: P;
  /** The model as this provider spells it. */
  readonly slug: string;
}

/**
 * The enabled providers that list `model`, best first: the person's own
 * provider order, a free plan for a free entry, then the model's maker, then providers billed by plan
 * before ones billed per token, then the most room, then listed order.
 * `usedPercent` is the room reading; a provider it returns null for sorts
 * after every provider with a reading.
 */
export function providersForModel<P extends TrackProvider>(input: {
  readonly providers: ReadonlyArray<P>;
  readonly model: ModelNames;
  /** "Also served by": providers the person ranked for the same model. */
  readonly order?: ReadonlyArray<ProviderInstanceId> | undefined;
  readonly usedPercent?: ((provider: P, slug: string) => number | null) | undefined;
  /** A free-tail entry: an account on a free plan comes before the maker's paid one. */
  readonly preferFree?: boolean | undefined;
}): ReadonlyArray<ModelProviderChoice<P>> {
  const personRank = (instanceId: ProviderInstanceId) => {
    const index = input.order?.indexOf(instanceId) ?? -1;
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return input.providers
    .flatMap((provider, listed) => {
      if (!provider.enabled) return [];
      const slug = sameModelOn(provider, input.model);
      if (slug === undefined) return [];
      const used = input.usedPercent?.(provider, slug) ?? null;
      return [
        {
          choice: { provider, slug },
          rank: [
            personRank(provider.instanceId),
            input.preferFree === true && !isFreePlanProvider(provider) ? 1 : 0,
            isMakerOf(provider, input.model) ? 0 : 1,
            isPaidModelBilling(providerModelBilling(provider, slug)) ? 1 : 0,
            used ?? 101,
            listed,
          ] as const,
        },
      ];
    })
    .sort((a, b) => {
      for (let i = 0; i < a.rank.length; i++) {
        const diff = a.rank[i]! - b.rank[i]!;
        if (diff !== 0) return diff;
      }
      return 0;
    })
    .map((entry) => entry.choice);
}

/** Whether `model` is a built-in free entry: it closes Daily and never serves Complex or Review. */
export function isFreeTrackModel(model: ModelNames): boolean {
  return DEFAULT_MODEL_TRACKS.daily.some(
    (entry) => entry.free === true && isSameModel({ slug: entry.model }, model),
  );
}

/**
 * A built-in track fitted to this machine: each model on the best provider
 * that lists it (see `providersForModel`). A model nothing here lists is left
 * out, so the order never names something that cannot run.
 */
export function defaultTrackSelections(
  track: ModelTrack,
  providers: ReadonlyArray<TrackProvider>,
  /** The saved Sources order: a source the person ranked first wins over the maker's harness. */
  order?: ReadonlyArray<ProviderInstanceId> | null,
): ReadonlyArray<ModelSelection> {
  return DEFAULT_MODEL_TRACKS[track].flatMap((entry) => {
    const best = providersForModel({
      providers,
      model: { slug: entry.model },
      order: order ?? undefined,
      preferFree: entry.free,
    })[0];
    return best === undefined ? [] : [{ instanceId: best.provider.instanceId, model: best.slug }];
  });
}

export interface EffectiveModelLanes {
  readonly lanes: ModelLanes;
  /** Lanes whose order is the built-in one: the person saved nothing for them. */
  readonly builtIn: Readonly<Record<ModelLane, boolean>>;
}

/**
 * The Daily and Complex tracks as lanes: the saved list, else the built-in
 * order fitted to `providers`. Without providers a lane the person never
 * saved stays empty, as it reads on disk.
 */
export function effectiveModelLanes(
  lanes: ModelLanes | null | undefined,
  providers: ReadonlyArray<TrackProvider>,
  order?: ReadonlyArray<ProviderInstanceId> | null,
): EffectiveModelLanes {
  const saved = (lane: ModelLane) => lanes?.[lane] ?? [];
  const builtIn = {
    routine: saved("routine").length === 0,
    complex: saved("complex").length === 0,
  };
  return {
    lanes: {
      routine: builtIn.routine
        ? defaultTrackSelections("daily", providers, order)
        : saved("routine"),
      complex: builtIn.complex
        ? defaultTrackSelections("complex", providers, order)
        : saved("complex"),
    },
    builtIn,
  };
}

/** The lane the built-in tracks put `model` in, hardest first; null when neither names it. */
export function defaultLaneOfModel(
  model: ModelNames,
  covers: (entry: string, model: string) => boolean = (entry, slug) =>
    isSameModel({ slug: entry }, { slug }),
): ModelLane | null {
  for (const [lane, track] of [
    ["complex", "complex"],
    ["routine", "daily"],
  ] as const) {
    if (DEFAULT_MODEL_TRACKS[track].some((entry) => covers(entry.model, model.slug))) return lane;
  }
  return null;
}
