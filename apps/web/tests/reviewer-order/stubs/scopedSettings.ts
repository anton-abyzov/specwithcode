import { fixtureStore, useFixtureSettings } from "./store";

export const useScopedSettings = () => useFixtureSettings() as never;
export const useScopedSettingsMixed = () => false;
export const useUpdateScopedSettings = () => (patch: Record<string, unknown>) => {
  const current = fixtureStore.get();
  const next: Record<string, unknown> = { ...current };
  for (const [key, change] of Object.entries(patch))
    next[key] =
      change && typeof change === "object" && !Array.isArray(change)
        ? { ...(current[key] as object), ...change }
        : change;
  fixtureStore.set(next);
};
