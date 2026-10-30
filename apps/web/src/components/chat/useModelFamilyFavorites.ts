import type { ProviderInstanceId } from "@specweave-studio/contracts";
import { useCallback, useMemo } from "react";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { newestModelInFamily } from "../../modelFamilyFollow";
import { modelSearchIdentity } from "./modelSearchGroups";
import type { ModelEsque } from "./providerIconUtils";

const NO_FAMILIES: ReadonlyArray<string> = [];
const NO_FOLLOW: Readonly<Partial<Record<ProviderInstanceId, string>>> = {};

/**
 * Whole model families starred in the picker ("Claude Opus"), and which family each
 * provider's new chats follow to its newest version. Picking a starred family's newest
 * version follows it; picking anything else on that provider stops following.
 */
export function useModelFamilyFavorites(
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
) {
  const families = useClientSettings((s) => s.favoriteModelFamilies ?? NO_FAMILIES);
  const follow = useClientSettings((s) => s.modelFollowLatest ?? NO_FOLLOW);
  const updateSettings = useUpdateClientSettings();
  const familySet = useMemo(() => new Set(families), [families]);

  const toggleFamily = useCallback(
    (family: string) => {
      if (!familySet.has(family)) {
        updateSettings({ favoriteModelFamilies: [...families, family] });
        return;
      }
      // An unstarred family no longer moves new chats to its newer versions.
      const kept = Object.entries(follow).filter(([, followed]) => followed !== family);
      updateSettings({
        favoriteModelFamilies: families.filter((candidate) => candidate !== family),
        ...(kept.length === Object.keys(follow).length
          ? {}
          : { modelFollowLatest: Object.fromEntries(kept) }),
      });
    },
    [families, familySet, follow, updateSettings],
  );

  const notePicked = useCallback(
    (instanceId: ProviderInstanceId, slug: string) => {
      const options = modelOptionsByInstance.get(instanceId) ?? [];
      const picked = options.find((option) => option.slug === slug);
      const family = picked ? modelSearchIdentity(picked).family : null;
      const newest = family && familySet.has(family) ? newestModelInFamily(options, family) : null;
      const next = newest?.slug === slug ? family : null;
      if ((follow[instanceId] ?? null) === next) return;
      const { [instanceId]: _previous, ...rest } = follow;
      updateSettings({ modelFollowLatest: next ? { ...rest, [instanceId]: next } : rest });
    },
    [familySet, follow, modelOptionsByInstance, updateSettings],
  );

  const isFamilyFavorite = useCallback(
    (model: { readonly slug: string; readonly name: string }) =>
      familySet.size > 0 && familySet.has(modelSearchIdentity(model).family),
    [familySet],
  );

  return useMemo(
    () => ({ familySet, toggleFamily, notePicked, isFamilyFavorite }),
    [familySet, isFamilyFavorite, notePicked, toggleFamily],
  );
}
