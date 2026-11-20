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
  type ModelSelection,
  type ModelTrack,
  type ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describeModel, isSameModel } from "./modelIdentity.ts";
import { newerOfFamily } from "./modelTiers.ts";
import {
  builtInTrackSelection,
  isFreePlanProvider,
  isFreeTrackModel,
  providerHomeFamily,
  providersForModel,
} from "./modelTracks.ts";
import { type ModelFamily, modelFamily } from "./modelVendor.ts";
import {
  canTakeTurn,
  isGeminiSpendProvider,
  isPaidModelOn,
  isPerTokenProvider,
  isUnknownBillingAgent,
  providerUsedPercent,
  usageResetAt,
  type UsageUnknownReason,
  usageUnknownReason,
} from "./providerFallback.ts";

export type SourceState = "ready" | "limited" | "sign-in" | "not-installed" | "not-ready";

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
   * named. Review also excludes per-use sources other than explicitly named Gemini.
   */
  readonly used: boolean;
  /**
   * Review only: why a ready source's usage is unknown. A review prefers a
   * source with a fresh reading, so such a row can lose to a lower one, unless
   * its usage was never read, which keeps its place.
   */
  readonly usage: UsageUnknownReason | null;
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
}): ReadonlyArray<TrackRow> {
  // The order the resolvers walk: the entry's own source (for a built-in row,
  // the best one before room is read), then the others by the Sources order,
  // the maker's harness and, outside Review, the most room. Held sources come
  // last and are never started on unless the person named one.
  const sourcesOf = (slug: string, free: boolean, named?: ProviderInstanceId) => {
    const ranked = (withRoom: boolean) =>
      providersForModel({
        providers: input.providers,
        model: { slug },
        order: input.sourceOrder ?? undefined,
        preferFree: free,
        ...(withRoom && input.track !== "review"
          ? {
              usedPercent: (provider: ServerProvider, served: string) =>
                providerUsedPercent(provider, input.nowMs, served),
            }
          : {}),
      });
    const open = (list: ReturnType<typeof ranked>) =>
      list.filter((choice) => sourceHold(choice.provider, choice.slug) === null);
    const first =
      named ?? open(ranked(false))[0]?.provider.instanceId ?? ranked(false)[0]?.provider.instanceId;
    const all = ranked(true);
    return [
      ...all.filter(({ provider }) => provider.instanceId === first),
      ...open(all).filter(({ provider }) => provider.instanceId !== first),
      ...all.filter(
        (choice) =>
          choice.provider.instanceId !== first && sourceHold(choice.provider, choice.slug) !== null,
      ),
    ].map(({ provider, slug: served }) => {
      const hold = sourceHold(provider, served);
      return {
        provider,
        slug: served,
        status: sourceStatus(provider, input.nowMs, served),
        hold,
        used:
          hold === null ||
          (provider.instanceId === named &&
            (input.track !== "review" ||
              !isPaidModelOn(provider, served) ||
              isGeminiSpendProvider(provider))),
        usage: input.track === "review" ? usageUnknownReason(provider, input.nowMs, served) : null,
      };
    });
  };
  if (input.saved.length > 0) {
    return input.saved.map((selection) => {
      const provider = input.providers.find((entry) => entry.instanceId === selection.instanceId);
      const names = describeModel(provider, selection.model);
      const freeModel = isFreeTrackModel(names);
      const free = input.track === "daily" && freeModel;
      const newer =
        provider !== undefined && provider.models.some((model) => model.slug === selection.model)
          ? newerOfFamily(provider, selection.model)
          : undefined;
      return {
        selection,
        model: selection.model,
        name: names.name ?? selection.model,
        builtIn: false,
        free,
        misplaced: freeModel && input.track !== "daily",
        follows: newer ?? null,
        sources: sourcesOf(selection.model, free, selection.instanceId),
      };
    });
  }
  return DEFAULT_MODEL_TRACKS[input.track].map((entry) => {
    const free = entry.free === true;
    const sources = sourcesOf(entry.model, free);
    // A built-in row starts only on a source the app picks by itself.
    const first = sources.find((source) => source.used);
    return {
      selection:
        first === undefined ? null : builtInTrackSelection(entry, first.provider, first.slug),
      model: entry.model,
      name:
        first === undefined
          ? entry.name
          : (describeModel(first.provider, first.slug).name ?? entry.name),
      builtIn: true,
      free,
      misplaced: false,
      follows: first === undefined ? null : (newerOfFamily(first.provider, first.slug) ?? null),
      sources,
    };
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
  if (input.track !== "daily") return [...input.entries, input.entry];
  const isFree = (entry: ModelSelection) =>
    isFreeTrackModel(
      describeModel(
        input.providers.find((provider) => provider.instanceId === entry.instanceId),
        entry.model,
      ),
    );
  if (isFree(input.entry)) return [...input.entries, input.entry];
  const tail = input.entries.findIndex(isFree);
  return tail === -1
    ? [...input.entries, input.entry]
    : [...input.entries.slice(0, tail), input.entry, ...input.entries.slice(tail)];
}

/** The single family every Review row belongs to, when a review could not cross families. */
export function singleReviewFamily(rows: ReadonlyArray<TrackRow>): ModelFamily | null {
  const families = new Set(rows.map((row) => modelFamily({ slug: row.model, name: row.name })));
  const [only] = [...families];
  return families.size === 1 && only !== undefined && only !== "other" ? only : null;
}
