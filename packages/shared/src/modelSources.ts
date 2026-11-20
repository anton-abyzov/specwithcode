/**
 * The Sources list a person manages on the Models page: which sources are
 * listed, adding and removing one, the sources that could be added, and the
 * source a track model is waiting for. The list is the global
 * `defaultModelProviders` order; removing a source only takes it out of that
 * order, it never turns the source off or deletes it. A source that is not
 * listed is still tried, after every listed one.
 *
 * @module modelSources
 */
import type { ProviderInstanceId, ServerProvider } from "@specweave-studio/contracts";
import { sameModelOn } from "./modelIdentity.ts";
import { type SourceRow, describeSources, sourceHold, sourceStatus } from "./modelTrackRules.ts";
import { isFreePlanProvider, providerHomeFamily } from "./modelTracks.ts";
import { modelFamily } from "./modelVendor.ts";

function sourceRow(provider: ServerProvider, nowMs: number): SourceRow {
  return {
    provider,
    status: sourceStatus(provider, nowMs),
    home: providerHomeFamily(provider),
    hold: sourceHold(provider),
    free: isFreePlanProvider(provider),
  };
}

/** A provider this machine says it cannot run at all is never offered as a source. */
const offerable = (provider: ServerProvider) => provider.availability !== "unavailable";

/**
 * The sources the Sources card lists. With nothing saved, the built-in order:
 * every source that is on and picked automatically, which is exactly what the
 * first edit saves. Once an order is saved, the sources it names, on or off,
 * with the ones never picked on their own last. Saved ids this machine does
 * not have stay saved but are not listed.
 */
export function listedSources(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly order?: ReadonlyArray<ProviderInstanceId> | null | undefined;
  readonly nowMs: number;
}): ReadonlyArray<SourceRow> {
  const order = input.order ?? [];
  if (order.length === 0)
    return describeSources({ providers: input.providers, nowMs: input.nowMs }).filter(
      (row) => row.hold === null,
    );
  const rows = order.flatMap((id) => {
    const provider = input.providers.find((entry) => entry.instanceId === id);
    return provider === undefined || !offerable(provider) ? [] : [sourceRow(provider, input.nowMs)];
  });
  return [...rows.filter((row) => row.hold === null), ...rows.filter((row) => row.hold !== null)];
}

/** The order the card stands for: its rows, then saved ids this machine does not have. */
function currentOrder(
  rows: ReadonlyArray<SourceRow>,
  order: ReadonlyArray<ProviderInstanceId>,
): ReadonlyArray<ProviderInstanceId> {
  const shown = rows.map((row) => row.provider.instanceId);
  return [...shown, ...order.filter((id) => !shown.includes(id))];
}

/**
 * The order with `provider` added: a source picked automatically goes after
 * the last listed one of its kind, a source billed per use or with unknown
 * billing goes to the end, where naming it only lets a thread continue on it.
 */
export function addSource(input: {
  readonly rows: ReadonlyArray<SourceRow>;
  readonly order: ReadonlyArray<ProviderInstanceId>;
  readonly provider: ServerProvider;
}): ReadonlyArray<ProviderInstanceId> {
  const base = currentOrder(input.rows, input.order);
  const id = input.provider.instanceId;
  if (base.includes(id)) return base;
  if (sourceHold(input.provider) !== null) return [...base, id];
  const at = input.rows.filter((row) => row.hold === null).length;
  return [...base.slice(0, at), id, ...base.slice(at)];
}

export type SourceRemoveRefusal = "last-source";

/**
 * The order without `instanceId`. The last listed source cannot go: an empty
 * order means the built-in one, which would list every source again.
 */
export function removeSource(input: {
  readonly rows: ReadonlyArray<SourceRow>;
  readonly order: ReadonlyArray<ProviderInstanceId>;
  readonly instanceId: ProviderInstanceId;
}):
  | { readonly order: ReadonlyArray<ProviderInstanceId> }
  | { readonly refused: SourceRemoveRefusal } {
  if (input.rows.every((row) => row.provider.instanceId === input.instanceId))
    return { refused: "last-source" };
  return {
    order: currentOrder(input.rows, input.order).filter((id) => id !== input.instanceId),
  };
}

/** How close a source is to running work: ready first, then what one step fixes. */
function readiness(row: SourceRow): number {
  if (row.status.state === "off") return 4;
  switch (row.status.state) {
    case "ready":
    case "limited":
      return 0;
    case "sign-in":
      return 1;
    case "not-installed":
      return 2;
    default:
      return 3;
  }
}

/**
 * The sources that could be added: every source this machine has that is not
 * listed, ready ones first, then the ones a sign-in, an install or turning on
 * makes ready. Sources picked automatically come before held ones, and a
 * model's own harness before a reseller.
 */
export function sourceCandidates(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly order?: ReadonlyArray<ProviderInstanceId> | null | undefined;
  readonly nowMs: number;
}): ReadonlyArray<SourceRow> {
  const listed = new Set(listedSources(input).map((row) => row.provider.instanceId));
  return input.providers
    .flatMap((provider, at) =>
      listed.has(provider.instanceId) || !offerable(provider)
        ? []
        : [{ row: sourceRow(provider, input.nowMs), at }],
    )
    .sort(
      (a, b) =>
        readiness(a.row) - readiness(b.row) ||
        Number(a.row.hold !== null) - Number(b.row.hold !== null) ||
        Number(a.row.home === null) - Number(b.row.home === null) ||
        a.at - b.at,
    )
    .map(({ row }) => row);
}

/**
 * The source a track model is waiting for when no source that is on lists it:
 * the source a saved entry names, else one that lists the model but is off,
 * else the maker's own harness while it is not ready. Null when this machine
 * has none of these.
 */
export function missingTrackSource(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly model: string;
  readonly nowMs: number;
  /** The source a saved entry names: it is the one the entry waits for. */
  readonly pinned?: ProviderInstanceId | null | undefined;
}): SourceRow | null {
  const family = modelFamily({ slug: input.model });
  const ranked = input.providers
    .flatMap((provider, at) => {
      if (!offerable(provider)) return [];
      const pinned = provider.instanceId === input.pinned;
      const lists = sameModelOn(provider, { slug: input.model }) !== undefined;
      const maker = family !== "other" && providerHomeFamily(provider) === family;
      if (!pinned && !lists && !maker) return [];
      // A ready harness that does not list the model is not what it waits for.
      const state = sourceStatus(provider, input.nowMs).state;
      if (!pinned && !lists && (state === "ready" || state === "limited")) return [];
      return [{ provider, at, lists, maker, pinned }];
    })
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        Number(b.lists) - Number(a.lists) ||
        Number(b.maker) - Number(a.maker) ||
        Number(b.provider.enabled) - Number(a.provider.enabled) ||
        a.at - b.at,
    );
  const best = ranked[0];
  return best === undefined ? null : sourceRow(best.provider, input.nowMs);
}
