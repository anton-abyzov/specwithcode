/**
 * What the Models page shows and accepts: the Sources order (harnesses and
 * subscriptions, in the order a model is tried on them), each track's rows
 * with the sources that can run them, and the moves that cannot work, each
 * with its reason. Pure, so the page and its tests read one answer.
 *
 * @module modelTrackRules
 */
import {
  DEFAULT_MODEL_TRACKS,
  isPaidModelBilling,
  MAX_LANE_MODELS,
  providerModelBilling,
  type ModelRoute,
  type ModelRoutes,
  type ModelSelection,
  type ModelTrack,
  type ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { modelSelectionEffortValue } from "./effortLevel.ts";
import { describeModel, isSameModel } from "./modelIdentity.ts";
import { applyRoute, routeConsent, routeFor } from "./modelRoutes.ts";
import { newerOfFamily } from "./modelTiers.ts";
import {
  builtInTrackSelection,
  followsBuiltInFamily,
  TRACK_DEFAULT_EFFORT,
  isFreePlanProvider,
  isFreeTrackModel,
  makerInstanceId,
  providerHomeFamily,
  providersForModel,
  trackStartEffort,
  withTrackEffort,
} from "./modelTracks.ts";
import { type ModelFamily, modelFamily } from "./modelVendor.ts";
import {
  canTakeTurn,
  isGeminiSpendProvider,
  isPerTokenProvider,
  isUnknownBillingAgent,
  providerUsedPercent,
  usageResetAt,
} from "./providerFallback.ts";

export type SourceState =
  | "ready"
  | "limited"
  | "sign-in"
  | "not-installed"
  | "not-ready"
  /** Turned off on this machine; a saved Sources order can still name it. */
  | "off";

export interface SourceStatus {
  readonly state: SourceState;
  /** When a limited source has room again, when the provider says. */
  readonly until: number | null;
}

/** Whether `provider` can run `model` now, and what stands in the way when it cannot. */
export function sourceStatus(
  provider: ServerProvider,
  nowMs: number,
  model?: string | undefined,
): SourceStatus {
  if (!provider.enabled || provider.status === "disabled") return { state: "off", until: null };
  if (!provider.installed) return { state: "not-installed", until: null };
  if (provider.auth.status === "unauthenticated") return { state: "sign-in", until: null };
  const used = providerUsedPercent(provider, nowMs, model);
  if (used !== null && used >= 100)
    return { state: "limited", until: usageResetAt(provider, 100, nowMs, model) };
  if (!canTakeTurn(provider, model)) {
    const until = usageResetAt(provider, 100, nowMs, model);
    return until === null ? { state: "not-ready", until: null } : { state: "limited", until };
  }
  return { state: "ready", until: null };
}

/** Why a source is never picked on its own, or null when it may be. */
export type SourceHold = "per-token" | "unknown-billing";

export function sourceHold(
  provider: ServerProvider,
  /** The model as this source spells it: its own billing can hold a plan source. */
  slug?: string | undefined,
): SourceHold | null {
  const billing = providerModelBilling(provider, slug);
  if (
    isPerTokenProvider(provider) ||
    isGeminiSpendProvider(provider) ||
    isPaidModelBilling(billing)
  )
    return "per-token";
  return isUnknownBillingAgent(provider, slug) ? "unknown-billing" : null;
}

export interface SourceRow {
  readonly provider: ServerProvider;
  readonly status: SourceStatus;
  /** The vendor whose models this source is the own harness for; null for a reseller. */
  readonly home: ModelFamily | null;
  /** Set when the source is never picked automatically. */
  readonly hold: SourceHold | null;
  readonly free: boolean;
}

/**
 * The enabled sources in the order a model is tried on them: the saved order,
 * then harnesses, then other subscriptions. Sources that are never picked on
 * their own always come last, whatever was saved.
 */
export function describeSources(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly order?: ReadonlyArray<ProviderInstanceId> | null | undefined;
  readonly nowMs: number;
}): ReadonlyArray<SourceRow> {
  const saved = input.order ?? [];
  const rank = (provider: ServerProvider, listed: number) => {
    const at = saved.indexOf(provider.instanceId);
    return [
      sourceHold(provider) === null ? 0 : 1,
      at === -1 ? Number.MAX_SAFE_INTEGER : at,
      providerHomeFamily(provider) === null ? 1 : 0,
      listed,
    ];
  };
  return input.providers
    .map((provider, listed) => ({ provider, rank: rank(provider, listed) }))
    .filter((entry) => entry.provider.enabled)
    .sort((a, b) => {
      for (let i = 0; i < a.rank.length; i++) {
        const diff = a.rank[i]! - b.rank[i]!;
        if (diff !== 0) return diff;
      }
      return 0;
    })
    .map(({ provider }) => ({
      provider,
      status: sourceStatus(provider, input.nowMs),
      home: providerHomeFamily(provider),
      hold: sourceHold(provider),
      free: isFreePlanProvider(provider),
    }));
}

export type SourceMoveRefusal = "held-source" | "into-held";

/**
 * Moving the source at `from` to `to` in `rows`, or the reason it cannot
 * move: a source billed per token (or with unknown billing) stays below the
 * automatic ones, and an automatic one never goes below them.
 */
export function moveSource(
  rows: ReadonlyArray<SourceRow>,
  from: number,
  to: number,
  /** The order saved before the move: ids not shown now (a disabled source) keep a place. */
  saved: ReadonlyArray<ProviderInstanceId> = [],
): { readonly order: ReadonlyArray<ProviderInstanceId> } | { readonly refused: SourceMoveRefusal } {
  const moving = rows[from];
  const target = rows[to];
  if (moving === undefined || target === undefined || from === to)
    return { order: fullOrder(rows, saved) };
  if (moving.hold !== null) return { refused: "held-source" };
  if (target.hold !== null) return { refused: "into-held" };
  const next = [...rows];
  next.splice(to, 0, ...next.splice(from, 1));
  return { order: fullOrder(next, saved) };
}

/**
 * The order to save: the rows as shown (held ones are already last), then
 * every id saved before that has no row now. A held source the person named
 * keeps its name in the list, which is what lets the same model continue on it.
 */
function fullOrder(
  rows: ReadonlyArray<SourceRow>,
  saved: ReadonlyArray<ProviderInstanceId>,
): ReadonlyArray<ProviderInstanceId> {
  const shown = rows.map((row) => row.provider.instanceId);
  const named = new Set(saved);
  const kept = shown.filter((id, at) => rows[at]!.hold === null || named.has(id));
  return [...kept, ...saved.filter((id) => !shown.includes(id))];
}

export interface TrackSource {
  readonly provider: ServerProvider;
  /** The model as this source spells it. */
  readonly slug: string;
  readonly status: SourceStatus;
  /** Set when this source is billed per token or its billing is unknown. */
  readonly hold: SourceHold | null;
  /**
   * Whether the app starts work here by itself. False for a held source nobody
   * named, and for any held source in Review, which never reviews on one.
   */
  readonly used: boolean;
  /** A held source the model's route lists: work starts here only after the person allows it. */
  readonly ask: boolean;
}

export interface TrackRow {
  /** The stored entry, or null for a built-in row no source here lists. */
  readonly selection: ModelSelection | null;
  /** The model as its maker spells it. */
  readonly model: string;
  readonly name: string;
  readonly builtIn: boolean;
  /** Free tail: tried last, on a free plan first. */
  readonly free: boolean;
  /** A free model saved in Complex or Review, where it does not belong. */
  readonly misplaced: boolean;
  /** The newer release this entry runs on, when its source lists one. */
  readonly follows: string | null;
  /** Where the model runs, first tried first. Empty when nothing here lists it. */
  readonly sources: ReadonlyArray<TrackSource>;
  /**
   * The effort the entry starts at before a source lists its levels: a built-in
   * entry's own level (Medium unless it names one), a saved entry's saved one.
   */
  readonly effort: string | null;
  /** The model's saved route, or null for the automatic order. */
  readonly route: ModelRoute | null;
}

/**
 * A track's rows: the saved list, else the built-in order. A built-in model
 * that nothing here lists still shows, with no sources, so the page can say
 * what to install; a saved entry on a held source keeps that source first,
 * because the person named it.
 */
export function describeTrack(input: {
  readonly track: ModelTrack;
  readonly saved: ReadonlyArray<ModelSelection>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly sourceOrder?: ReadonlyArray<ProviderInstanceId> | null | undefined;
  readonly nowMs: number;
  /** Per-model routes (`modelRoutes`): reorder, drop or pin a model's sources. */
  readonly routes?: ModelRoutes | null | undefined;
}): ReadonlyArray<TrackRow> {
  // The order the resolvers walk: the entry's own source (for a built-in row,
  // the best one before room is read), then the others by the Sources order,
  // the maker's harness and, outside Review, the most room. Held sources come
  // last and are never started on unless the person named one.
  const sourcesOf = (
    slug: string,
    free: boolean,
    named: ProviderInstanceId | undefined,
    route: ModelRoute | null,
    family = named === undefined,
  ) => {
    const ranked = (withRoom: boolean) =>
      applyRoute(
        providersForModel({
          providers: input.providers,
          model: { slug },
          order: input.sourceOrder ?? undefined,
          preferFree: free,
          // A built-in row runs on whichever release of its family a source lists.
          family,
          ...(withRoom && input.track !== "review"
            ? {
                usedPercent: (provider: ServerProvider, served: string) =>
                  providerUsedPercent(provider, input.nowMs, served),
              }
            : {}),
        }),
        route,
      );
    const consent = (choice: ReturnType<typeof ranked>[number]) =>
      routeConsent(
        route,
        choice.provider.instanceId,
        sourceHold(choice.provider, choice.slug) !== null,
      );
    // A held source runs only when the route allows it, the person named it, or after asking.
    const runs = (choice: ReturnType<typeof ranked>[number]) =>
      consent(choice) !== "never" || choice.provider.instanceId === named;
    const open = (list: ReturnType<typeof ranked>) => list.filter(runs);
    const routed = route !== null && route.order.length > 0;
    const first = routed
      ? undefined
      : (named ??
        open(ranked(false))[0]?.provider.instanceId ??
        ranked(false)[0]?.provider.instanceId);
    const all = ranked(true);
    return [
      ...all.filter(({ provider }) => provider.instanceId === first),
      ...open(all).filter(({ provider }) => provider.instanceId !== first),
      ...all.filter((choice) => choice.provider.instanceId !== first && !runs(choice)),
    ].map((choice) => {
      const { provider, slug: served } = choice;
      const hold = sourceHold(provider, served);
      const said = consent(choice);
      return {
        provider,
        slug: served,
        status: sourceStatus(provider, input.nowMs, served),
        hold,
        used:
          said === "plan" ||
          said === "allowed" ||
          said === "ask" ||
          (provider.instanceId === named && input.track !== "review"),
        ask: said === "ask",
      };
    });
  };
  if (input.saved.length > 0) {
    return input.saved.map((selection) => {
      const provider = input.providers.find((entry) => entry.instanceId === selection.instanceId);
      const names = describeModel(provider, selection.model);
      const freeModel = isFreeTrackModel(names);
      const free = input.track === "daily" && freeModel;
      // Saved from a built-in row: it runs and reads like that row (`followsBuiltInFamily`).
      const family = followsBuiltInFamily(input.track, selection.model);
      const route = routeFor(input.routes, names);
      const sources = sourcesOf(selection.model, free, selection.instanceId, route, family);
      const first = family ? sources.find((source) => source.used) : undefined;
      const listedName =
        first === undefined ? undefined : describeModel(first.provider, first.slug).name;
      const builtInName = family
        ? DEFAULT_MODEL_TRACKS[input.track].find((entry) => entry.model === selection.model)?.name
        : undefined;
      const newer =
        first !== undefined
          ? newerOfFamily(first.provider, first.slug)
          : provider !== undefined &&
              provider.models.some((model) => model.slug === selection.model)
            ? newerOfFamily(provider, selection.model)
            : undefined;
      return {
        selection,
        model: selection.model,
        name:
          listedName !== undefined && listedName !== first?.slug
            ? listedName
            : (builtInName ?? names.name ?? selection.model),
        builtIn: false,
        free,
        misplaced: freeModel && input.track !== "daily",
        follows: newer ?? null,
        sources,
        effort:
          modelSelectionEffortValue(selection) ?? trackStartEffort(input.track, selection.model),
        route,
      };
    });
  }
  return DEFAULT_MODEL_TRACKS[input.track].map((entry) => {
    const free = entry.free === true;
    const route = routeFor(input.routes, { slug: entry.model });
    const sources = sourcesOf(entry.model, free, undefined, route);
    // A built-in row starts only on a source the app picks by itself.
    const first = sources.find((source) => source.used && !source.ask);
    const effort = entry.effort ?? TRACK_DEFAULT_EFFORT;
    // A source that names the model by its bare id reads worse than the built-in name.
    const listedName =
      first === undefined ? undefined : describeModel(first.provider, first.slug).name;
    return {
      selection:
        first === undefined ? null : builtInTrackSelection({ effort }, first.provider, first.slug),
      model: entry.model,
      name: listedName === undefined || listedName === first?.slug ? entry.name : listedName,
      builtIn: true,
      free,
      misplaced: false,
      follows: first === undefined ? null : (newerOfFamily(first.provider, first.slug) ?? null),
      sources,
      effort,
      route,
    };
  });
}

/**
 * A built-in track saved as the person's own list with one row changed, such
 * as its effort: every built-in entry as it is, by its maker's name
 * (`gpt-6.2-sol`, so it keeps following its newest release), at the level its
 * row shows; a model no source here lists is kept under its maker's own
 * harness. Only the row at `at` takes `selection`'s options.
 */
export function savedBuiltInTrack(input: {
  readonly rows: ReadonlyArray<TrackRow>;
  readonly at: number;
  readonly selection: ModelSelection;
}): ReadonlyArray<ModelSelection> {
  return input.rows.flatMap((row, index) => {
    const instanceId =
      row.selection?.instanceId ?? makerInstanceId({ slug: row.model, name: row.name });
    if (instanceId === null) return [];
    const options = index === input.at ? input.selection.options : row.selection?.options;
    return [{ instanceId, model: row.model, ...(options === undefined ? {} : { options }) }];
  });
}

export type TrackEntryRefusal =
  | "duplicate"
  | "full"
  | "free-in-hard-track"
  | "free-not-last"
  | SourceHold;

/** Why `model` cannot join `track`, or null when it can. */
export function trackEntryRefusal(input: {
  readonly track: ModelTrack;
  readonly model: { readonly slug: string; readonly name?: string };
  readonly existing: ReadonlyArray<ModelSelection>;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** The source picked for the new entry: one billed per token is never added to a track. */
  readonly instanceId?: ProviderInstanceId | undefined;
}): TrackEntryRefusal | null {
  const names = (selection: ModelSelection) =>
    describeModel(
      input.providers.find((entry) => entry.instanceId === selection.instanceId),
      selection.model,
    );
  if (input.existing.some((entry) => isSameModel(names(entry), input.model))) return "duplicate";
  if (input.existing.length >= MAX_LANE_MODELS) return "full";
  if (input.track !== "daily" && isFreeTrackModel(input.model)) return "free-in-hard-track";
  const source = input.providers.find((entry) => entry.instanceId === input.instanceId);
  return source === undefined ? null : sourceHold(source, input.model.slug);
}

/**
 * The track after moving the entry at `from` to `to`, or why it cannot move:
 * on Daily a free entry stays after every other one, so it is only used last.
 */
export function moveTrackEntry(input: {
  readonly track: ModelTrack;
  readonly entries: ReadonlyArray<ModelSelection>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly from: number;
  readonly to: number;
}):
  | { readonly entries: ReadonlyArray<ModelSelection> }
  | { readonly refused: Extract<TrackEntryRefusal, "free-not-last"> } {
  const next = [...input.entries];
  if (next[input.from] === undefined || next[input.to] === undefined) return { entries: next };
  next.splice(input.to, 0, ...next.splice(input.from, 1));
  if (input.track !== "daily") return { entries: next };
  const free = next.map((entry) =>
    isFreeTrackModel(
      describeModel(
        input.providers.find((provider) => provider.instanceId === entry.instanceId),
        entry.model,
      ),
    ),
  );
  const firstFree = free.indexOf(true);
  return firstFree !== -1 && free.slice(firstFree).includes(false)
    ? { refused: "free-not-last" }
    : { entries: next };
}

/**
 * An entry appended to a track in the place the rules give it: on Daily a
 * paid entry goes before the free tail.
 */
export function addTrackEntry(input: {
  readonly track: ModelTrack;
  readonly entries: ReadonlyArray<ModelSelection>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly entry: ModelSelection;
}): ReadonlyArray<ModelSelection> {
  // A new entry carries the level it starts at, so the list saves what it shows.
  const entry = withTrackEffort(
    input.entry,
    input.providers,
    trackStartEffort(input.track, input.entry.model),
  );
  if (input.track !== "daily") return [...input.entries, entry];
  const isFree = (entry: ModelSelection) =>
    isFreeTrackModel(
      describeModel(
        input.providers.find((provider) => provider.instanceId === entry.instanceId),
        entry.model,
      ),
    );
  if (isFree(entry)) return [...input.entries, entry];
  const tail = input.entries.findIndex(isFree);
  return tail === -1
    ? [...input.entries, entry]
    : [...input.entries.slice(0, tail), entry, ...input.entries.slice(tail)];
}

/** The single family every Review row belongs to, when a review could not cross families. */
export function singleReviewFamily(rows: ReadonlyArray<TrackRow>): ModelFamily | null {
  const families = new Set(rows.map((row) => modelFamily({ slug: row.model, name: row.name })));
  const [only] = [...families];
  return families.size === 1 && only !== undefined && only !== "other" ? only : null;
}
