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
  findEffortDescriptor,
  modelSelectionEffortValue,
  resolveEffort,
  withEffortSelection,
} from "./effortLevel.ts";
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
import {
  isGeminiSpendProvider,
  isPerTokenProvider,
  isUnknownBillingAgent,
  providerUsedPercent,
} from "./providerFallback.ts";
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

/** A source the app never starts work on by itself: billed per token, or billing unknown. */
export function isHeldSource(provider: ServerProvider, slug?: string | undefined): boolean {
  // The model's own billing counts too: a plan source can list one model it bills per use.
  const billing = providerModelBilling(provider, slug);
  if (billing === "unknown" || isPaidModelBilling(billing)) return true;
  // A provider described without its sign-in (a bare list of models) says nothing about billing.
  if ((provider as Partial<ServerProvider>).auth === undefined) return false;
  return (
    isPerTokenProvider(provider) ||
    isGeminiSpendProvider(provider) ||
    isUnknownBillingAgent(provider)
  );
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
    // Never a source billed per token or with unknown billing: a built-in
    // entry is nobody's spending choice, whatever a saved Sources order ranks first.
    const best = providersForModel({
      providers,
      model: { slug: entry.model },
      order: order ?? undefined,
      preferFree: entry.free,
    }).find(
      ({ provider, slug }) =>
        !isHeldSource(provider as Partial<ServerProvider> as ServerProvider, slug),
    );
    return best === undefined
      ? []
      : [
          builtInTrackSelection(
            { effort: entry.effort ?? TRACK_DEFAULT_EFFORT },
            best.provider,
            best.slug,
          ),
        ];
  });
}

/**
 * A built-in entry on one source: its effort at the nearest level that source
 * offers, none when the model has no effort setting. The Models page and the
 * resolvers build rows with this, so saving a built-in list keeps the effort.
 */
export function builtInTrackSelection(
  entry: { readonly effort?: string | undefined },
  provider: Pick<TrackProvider, "instanceId" | "models">,
  slug: string,
): ModelSelection {
  const selection = { instanceId: provider.instanceId, model: slug };
  const descriptors = provider.models.find((model) => model.slug === slug)?.capabilities
    ?.optionDescriptors;
  const effort = entry.effort === undefined ? null : resolveEffort(entry.effort, descriptors);
  return effort === null || !effort.ok
    ? selection
    : { ...selection, options: withEffortSelection(undefined, effort) };
}

/** The effort a track entry starts at when nobody picked one; Muse Wonder Full reviews at Extra High. */
export const TRACK_DEFAULT_EFFORT = "medium";

/**
 * The effort `selection` runs at as a track entry: its saved level, else
 * `fallback` (Medium) matched to the nearest level its model offers. Null for
 * a model its source lists with no effort setting, or a source that no longer
 * lists it. The Models page shows this level and every launch uses it.
 */
export function trackEntryEffort(
  selection: Pick<ModelSelection, "instanceId" | "model" | "options">,
  providers: ReadonlyArray<Pick<TrackProvider, "instanceId" | "models">>,
  fallback: string = TRACK_DEFAULT_EFFORT,
): { readonly optionId: string; readonly value: string; readonly saved: boolean } | null {
  const descriptors = providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((model) => model.slug === selection.model)?.capabilities?.optionDescriptors;
  const descriptor = findEffortDescriptor(descriptors);
  if (descriptor === undefined) return null;
  const saved = selection.options?.find((option) => option.id === descriptor.id)?.value;
  if (typeof saved === "string") return { optionId: descriptor.id, value: saved, saved: true };
  const resolved = resolveEffort(fallback, descriptors);
  return resolved.ok ? { optionId: resolved.optionId, value: resolved.value, saved: false } : null;
}

/** A track entry with the effort it runs at written into its options (see `trackEntryEffort`). */
export function withTrackEffort<S extends ModelSelection>(
  selection: S,
  providers: ReadonlyArray<Pick<TrackProvider, "instanceId" | "models">>,
  fallback?: string,
): S {
  const effort = trackEntryEffort(selection, providers, fallback);
  return effort === null || effort.saved
    ? selection
    : { ...selection, options: withEffortSelection(selection.options, effort) };
}

/**
 * The same model on another source: the options go along when the source
 * runs the same harness, else the entry's effort is matched to the nearest
 * level that source offers. An entry with no effort sends none.
 */
export function trackAlternate(
  entry: ModelSelection,
  alternate: { readonly instanceId: ProviderInstanceId; readonly model: string },
  providers: ReadonlyArray<Pick<TrackProvider, "instanceId" | "models" | "driver">>,
): ModelSelection {
  const driverOf = (instanceId: ProviderInstanceId) =>
    providers.find((source) => source.instanceId === instanceId)?.driver;
  if (entry.options === undefined) return { ...alternate };
  if (driverOf(entry.instanceId) === driverOf(alternate.instanceId))
    return { ...alternate, options: entry.options };
  const effort = modelSelectionEffortValue(entry);
  return effort === undefined
    ? { ...alternate }
    : withTrackEffort({ ...alternate }, providers, effort);
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
  // A saved entry without an effort runs at Medium, as the Models page shows it.
  const saved = (lane: ModelLane) =>
    (lanes?.[lane] ?? []).map((entry) => withTrackEffort(entry, providers));
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

/**
 * The tracks a new thread or worker walks: every entry followed by the other
 * accounts that run the same model, in the saved Sources order, so a model is
 * passed over only when no account can run it. An added account is never one
 * billed per token or with unknown billing; an entry the person saved keeps
 * its own account first, whatever it bills.
 */
export function launchTrackLanes(
  lanes: ModelLanes | null | undefined,
  providers: ReadonlyArray<ServerProvider>,
  order?: ReadonlyArray<ProviderInstanceId> | null,
  /** With a time, accounts nobody ranked go by room, as the Models page lists them. */
  nowMs?: number,
): ModelLanes {
  const fitted = effectiveModelLanes(lanes, providers, order).lanes;
  const expand = (entries: ReadonlyArray<ModelSelection>): ReadonlyArray<ModelSelection> => {
    const seen = new Set<string>();
    const out: ModelSelection[] = [];
    const push = (selection: ModelSelection) => {
      const key = `${selection.instanceId}\u0000${selection.model}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(selection);
    };
    for (const entry of entries) {
      push(entry);
      for (const { provider, slug } of providersForModel({
        providers,
        model: { slug: entry.model },
        order: order ?? undefined,
        preferFree: isFreeTrackModel({ slug: entry.model }),
        ...(nowMs === undefined
          ? {}
          : {
              usedPercent: (source: TrackProvider, served: string) =>
                providerUsedPercent(source as ServerProvider, nowMs, served),
            }),
      })) {
        if (provider.instanceId === entry.instanceId) continue;
        if (isHeldSource(provider as ServerProvider, slug)) continue;
        push(trackAlternate(entry, { instanceId: provider.instanceId, model: slug }, providers));
      }
    }
    return out;
  };
  return { routine: expand(fitted.routine), complex: expand(fitted.complex) };
}

/**
 * The model a new draft shows before anyone picks one: in a project on Tracks
 * the first Daily entry this machine can name, else the project's one model.
 * Sending the draft unpicked lets the server choose from the tracks.
 */
export function projectDraftModelSelection(
  settings: {
    readonly threadModelMode?: "tracks" | "model" | undefined;
    readonly defaultModelSelection: ModelSelection | null;
    readonly modelLanes?: ModelLanes | null | undefined;
    readonly defaultModelProviders?: ReadonlyArray<ProviderInstanceId> | null | undefined;
  },
  providers: ReadonlyArray<TrackProvider>,
): ModelSelection | null {
  if (settings.threadModelMode !== "tracks") return settings.defaultModelSelection;
  return (
    effectiveModelLanes(settings.modelLanes, providers, settings.defaultModelProviders).lanes
      .routine[0] ?? settings.defaultModelSelection
  );
}
