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
  MAX_LANE_MODELS,
  type ModelSelection,
  type ModelTrack,
  type ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describeModel, isSameModel } from "./modelIdentity.ts";
import { newerOfFamily } from "./modelTiers.ts";
import {
  isFreePlanProvider,
  isFreeTrackModel,
  providerHomeFamily,
  providersForModel,
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

export function sourceHold(provider: ServerProvider): SourceHold | null {
  if (isPerTokenProvider(provider) || isGeminiSpendProvider(provider)) return "per-token";
  return isUnknownBillingAgent(provider) ? "unknown-billing" : null;
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
): { readonly order: ReadonlyArray<ProviderInstanceId> } | { readonly refused: SourceMoveRefusal } {
  const moving = rows[from];
  const target = rows[to];
  if (moving === undefined || target === undefined || from === to)
    return { order: automaticOrder(rows) };
  if (moving.hold !== null) return { refused: "held-source" };
  if (target.hold !== null) return { refused: "into-held" };
  const next = [...rows];
  next.splice(to, 0, ...next.splice(from, 1));
  return { order: automaticOrder(next) };
}

const automaticOrder = (rows: ReadonlyArray<SourceRow>) =>
  rows.filter((row) => row.hold === null).map((row) => row.provider.instanceId);

export interface TrackSource {
  readonly provider: ServerProvider;
  /** The model as this source spells it. */
  readonly slug: string;
  readonly status: SourceStatus;
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
  const sourcesOf = (slug: string, free: boolean, named?: ProviderInstanceId) => {
    const all = providersForModel({
      providers: input.providers,
      model: { slug },
      order: input.sourceOrder ?? undefined,
      preferFree: free,
    }).filter(({ provider }) => provider.instanceId === named || sourceHold(provider) === null);
    return [
      ...all.filter(({ provider }) => provider.instanceId === named),
      ...all.filter(({ provider }) => provider.instanceId !== named),
    ].map(({ provider, slug: served }) => ({
      provider,
      slug: served,
      status: sourceStatus(provider, input.nowMs, served),
    }));
  };
  if (input.saved.length > 0) {
    return input.saved.map((selection) => {
      const provider = input.providers.find((entry) => entry.instanceId === selection.instanceId);
      const names = describeModel(provider, selection.model);
      const free = input.track === "daily" && isFreeTrackModel(names);
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
        follows: newer ?? null,
        sources: sourcesOf(selection.model, free, selection.instanceId),
      };
    });
  }
  return DEFAULT_MODEL_TRACKS[input.track].map((entry) => {
    const free = entry.free === true;
    const sources = sourcesOf(entry.model, free);
    const first = sources[0];
    return {
      selection:
        first === undefined ? null : { instanceId: first.provider.instanceId, model: first.slug },
      model: entry.model,
      name:
        first === undefined
          ? entry.name
          : (describeModel(first.provider, first.slug).name ?? entry.name),
      builtIn: true,
      free,
      follows: first === undefined ? null : (newerOfFamily(first.provider, first.slug) ?? null),
      sources,
    };
  });
}

export type TrackEntryRefusal = "duplicate" | "full" | "free-in-hard-track";

/** Why `model` cannot join `track`, or null when it can. */
export function trackEntryRefusal(input: {
  readonly track: ModelTrack;
  readonly model: { readonly slug: string; readonly name?: string };
  readonly existing: ReadonlyArray<ModelSelection>;
  readonly providers: ReadonlyArray<ServerProvider>;
}): TrackEntryRefusal | null {
  const names = (selection: ModelSelection) =>
    describeModel(
      input.providers.find((entry) => entry.instanceId === selection.instanceId),
      selection.model,
    );
  if (input.existing.some((entry) => isSameModel(names(entry), input.model))) return "duplicate";
  if (input.existing.length >= MAX_LANE_MODELS) return "full";
  if (input.track !== "daily" && isFreeTrackModel(input.model)) return "free-in-hard-track";
  return null;
}

/** The single family every Review row belongs to, when a review could not cross families. */
export function singleReviewFamily(rows: ReadonlyArray<TrackRow>): ModelFamily | null {
  const families = new Set(rows.map((row) => modelFamily({ slug: row.model, name: row.name })));
  const [only] = [...families];
  return families.size === 1 && only !== undefined && only !== "other" ? only : null;
}
