import type { ProviderDriverKind, ProviderInstanceId } from "@specweave-studio/contracts";
import type { ModelSearchCapability } from "@specweave-studio/shared/modelSearchIntents";
import { tierOfModel } from "@specweave-studio/shared/modelTiers";
import { useEffect, useMemo, useState } from "react";

import { usePrimarySettings } from "~/hooks/useSettings";
import { providerModelKey } from "../../modelOrdering";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { modelSearchFacts, searchModelPicker } from "./modelPickerSearch";
import { modelSearchSignInOffers, type ModelSearchSignInOffer } from "./ModelPickerSearchNotes";
import { modelSearchGroupLabel, modelSearchIdentity } from "./modelSearchGroups";

type SearchItem = {
  readonly slug: string;
  readonly name: string;
  readonly shortName?: string;
  readonly subProvider?: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly accountLabel?: string;
  readonly badge?: "new";
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly instanceDisplayName: string;
};

export interface ModelPickerSearchState<T> {
  readonly matches: T[];
  /** Nothing matched directly; `matches` are within a typo of a name. */
  readonly closest: boolean;
  readonly capabilities: ReadonlyArray<ModelSearchCapability>;
  /** Providers that list nothing here but are known to offer what was searched for. */
  readonly signInOffers: ReadonlyArray<ModelSearchSignInOffer>;
  readonly signInInstanceIds: ReadonlySet<ProviderInstanceId>;
  /** The best direct match as its heading names it, for the sign-in sentence. */
  readonly bestMatchName: string | null;
}

const compareVersions = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
};

/** The keys of the models that are the newest version of their family among those listed. */
function latestModelKeys(models: ReadonlyArray<SearchItem>): ReadonlySet<string> {
  const newest = new Map<string, ReadonlyArray<number>>();
  const identities = models.map((model) => modelSearchIdentity(model));
  for (const identity of identities) {
    const best = newest.get(identity.family);
    if (!best || compareVersions(identity.version, best) > 0) {
      newest.set(identity.family, identity.version);
    }
  }
  const keys = new Set<string>();
  models.forEach((model, index) => {
    const identity = identities[index]!;
    if (compareVersions(identity.version, newest.get(identity.family) ?? []) === 0) {
      keys.add(providerModelKey(model.instanceId, model.slug));
    }
  });
  return keys;
}

/**
 * The picker's search: the matches for a query (or null while nothing is typed), the
 * capability filters it named, and the signed-out providers known to have the model.
 */
export function useModelPickerSearch<T extends SearchItem>(input: {
  readonly models: ReadonlyArray<T>;
  /** Empty while not searching. */
  readonly query: string;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly entryByInstanceId: ReadonlyMap<ProviderInstanceId, ProviderInstanceEntry>;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** False for models the picker's lock leaves out. */
  readonly accepts: (model: T) => boolean;
}): ModelPickerSearchState<T> | null {
  const { models, query, favoriteKeys, entryByInstanceId, instanceEntries, accepts } = input;
  const lanes = usePrimarySettings((settings) => settings.modelLanes);
  const latest = useMemo(() => latestModelKeys(models), [models]);
  return useMemo(() => {
    if (query.trim().length === 0) return null;
    const keyOf = (model: T) => providerModelKey(model.instanceId, model.slug);
    const result = searchModelPicker(
      models.filter(accepts),
      query,
      (model) => favoriteKeys.has(keyOf(model)),
      (model) => {
        const entry = entryByInstanceId.get(model.instanceId);
        return modelSearchFacts(
          model,
          entry?.models.find((item) => item.slug === model.slug),
          {
            isLatest: latest.has(keyOf(model)),
            inHardestTier: tierOfModel(lanes, model.slug) === "complex",
            subscription: entry?.snapshot.auth.type === "subscription",
          },
        );
      },
    );
    const signInOffers = modelSearchSignInOffers(instanceEntries, query);
    const best = result.closest ? undefined : result.matches[0];
    return {
      ...result,
      signInOffers,
      signInInstanceIds: new Set(signInOffers.map((offer) => offer.entry.instanceId)),
      bestMatchName: best
        ? modelSearchGroupLabel({ identity: modelSearchIdentity(best), items: [best], key: "" })
        : null,
    };
    // `accepts` follows the picker's lock, which never changes while it is open.
  }, [entryByInstanceId, favoriteKeys, instanceEntries, lanes, latest, models, query]);
}

/**
 * True while the command (or control) key is held, so the picker can show the ⌘N
 * shortcuts and the stars it otherwise keeps for hover and focus.
 */
export function useCommandKeyHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => setHeld(event.metaKey || event.ctrlKey);
    const clear = () => setHeld(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", clear);
    };
  }, []);
  return held;
}
