import type { ProviderInstanceId } from "@specweave-studio/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { compareModelVersions, modelFamily } from "@specweave-studio/shared/modelTiers";

export interface ModelSlugItem {
  readonly slug: string;
}

export interface ProviderModelItem extends ModelSlugItem {
  readonly instanceId: ProviderInstanceId;
}

export function providerModelKey(instanceId: ProviderInstanceId, slug: string): string {
  return `${instanceId}:${slug}`;
}

function rankByValue(values: ReadonlyArray<string>): ReadonlyMap<string, number> {
  return new Map(Arr.map(values, (value, index) => [value, index] as const));
}

function toSet(
  values: ReadonlySet<string> | ReadonlyArray<string> | undefined,
): ReadonlySet<string> {
  return values instanceof Set ? values : new Set(values ?? []);
}

function byOptionalRank<T>(rank: (item: T) => number | undefined): Order.Order<T> {
  return Order.mapInput(Order.Number, (item: T) => rank(item) ?? Number.POSITIVE_INFINITY);
}

function byTrueFirst<T>(predicate: (item: T) => boolean): Order.Order<T> {
  return Order.mapInput(Order.flip(Order.Boolean), predicate);
}

/**
 * A release missing from the saved order goes just above the highest-placed
 * older release of its family, so Fable 5.2 appears above a ranked Fable 5.1.
 */
function newerAboveOlder<T extends ModelSlugItem>(
  ranks: ReadonlyMap<string, number>,
  models: ReadonlyArray<T>,
): ReadonlyMap<string, number> {
  const next = new Map(ranks);
  for (const model of models) {
    if (ranks.has(model.slug)) continue;
    const family = modelFamily(model.slug);
    if (!family) continue;
    let best: number | undefined;
    for (const [slug, rank] of ranks) {
      const other = modelFamily(slug);
      if (!other || other.stem !== family.stem) continue;
      if (compareModelVersions(family.version, other.version) <= 0) continue;
      if (best === undefined || rank < best) best = rank;
    }
    // Several new releases of one family tie here; the provider order below puts the newest first.
    if (best !== undefined) next.set(model.slug, best - 0.5);
  }
  return next;
}

/** The provider's order, with each family's releases newest first in the family's places. */
function newestFirstWithinFamily<T extends ModelSlugItem>(
  models: ReadonlyArray<T>,
): ReadonlyMap<string, number> {
  const slots = new Map<string, number[]>();
  const members = new Map<string, T[]>();
  models.forEach((model, index) => {
    const stem = modelFamily(model.slug)?.stem;
    if (stem === undefined) return;
    slots.set(stem, [...(slots.get(stem) ?? []), index]);
    members.set(stem, [...(members.get(stem) ?? []), model]);
  });
  const ranks = new Map(Arr.map(models, (model, index) => [model.slug, index] as const));
  for (const [stem, group] of members) {
    const sorted = [...group].sort((a, b) =>
      compareModelVersions(modelFamily(b.slug)!.version, modelFamily(a.slug)!.version),
    );
    sorted.forEach((model, at) => ranks.set(model.slug, slots.get(stem)![at]!));
  }
  return ranks;
}

export function sortModelsForProviderInstance<T extends ModelSlugItem>(
  models: ReadonlyArray<T>,
  options?: {
    readonly modelOrder?: ReadonlyArray<string>;
    readonly favoriteModels?: ReadonlySet<string> | ReadonlyArray<string>;
    readonly groupFavorites?: boolean;
  },
): T[] {
  const modelOrder = options?.modelOrder ?? [];
  const favoriteModels = withNewerReleases(
    toSet(options?.favoriteModels),
    Arr.map(models, (model) => ({ instanceId: "" as ProviderInstanceId, slug: model.slug })),
    (slug) => slug,
  );
  const orderBySlug = newerAboveOlder(rankByValue(modelOrder), models);
  const originalOrder = newestFirstWithinFamily(models);
  const orders: Array<Order.Order<T>> = [
    ...(options?.groupFavorites === true
      ? [byTrueFirst<T>((model) => favoriteModels.has(model.slug))]
      : []),
    byOptionalRank((model) => orderBySlug.get(model.slug)),
    byOptionalRank((model) => originalOrder.get(model.slug)),
  ];

  return Arr.sort(models, Order.combineAll(orders));
}

/**
 * A starred model's newer releases on the same provider sort with it, so a
 * star on Fable 5.1 does not keep it above Fable 5.2. Their stars are unchanged.
 */
function withNewerReleases<T extends ProviderModelItem>(
  favorites: ReadonlySet<string>,
  items: ReadonlyArray<T>,
  keyOf: (slug: string, instanceId: ProviderInstanceId) => string = (slug, instanceId) =>
    providerModelKey(instanceId, slug),
): ReadonlySet<string> {
  if (favorites.size === 0) return favorites;
  const starred = items.filter((item) => favorites.has(keyOf(item.slug, item.instanceId)));
  const next = new Set(favorites);
  for (const item of items) {
    const family = modelFamily(item.slug);
    if (!family) continue;
    const olderStarred = starred.some((other) => {
      const otherFamily = modelFamily(other.slug);
      return (
        other.instanceId === item.instanceId &&
        otherFamily?.stem === family.stem &&
        compareModelVersions(family.version, otherFamily.version) > 0
      );
    });
    if (olderStarred) next.add(keyOf(item.slug, item.instanceId));
  }
  return next;
}

export function sortProviderModelItems<T extends ProviderModelItem>(
  items: ReadonlyArray<T>,
  options?: {
    readonly favoriteModelKeys?: ReadonlySet<string> | ReadonlyArray<string>;
    readonly groupFavorites?: boolean;
    readonly instanceOrder?: ReadonlyArray<ProviderInstanceId>;
  },
): T[] {
  const favoriteModelKeys = withNewerReleases(toSet(options?.favoriteModelKeys), items);
  const instanceOrder = new Map(
    Arr.map(options?.instanceOrder ?? [], (instanceId, index) => [instanceId, index] as const),
  );
  const originalOrder = rankByValue(
    Arr.map(items, (item) => providerModelKey(item.instanceId, item.slug)),
  );
  const orders: Array<Order.Order<T>> = [
    ...(options?.groupFavorites === true
      ? [
          byTrueFirst<T>((item) =>
            favoriteModelKeys.has(providerModelKey(item.instanceId, item.slug)),
          ),
        ]
      : []),
    byOptionalRank((item) => instanceOrder.get(item.instanceId)),
    byOptionalRank((item) => originalOrder.get(providerModelKey(item.instanceId, item.slug))),
  ];

  return Arr.sort(items, Order.combineAll(orders));
}
