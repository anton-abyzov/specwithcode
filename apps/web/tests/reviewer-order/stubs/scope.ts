import { fixtureStore } from "./store";

export const useSettingsScope = () => ({
  scope: { kind: fixtureStore.scope === "project" ? "project" : "environment" },
  target: { environmentId: "m4" },
});
export const useOptionalSettingsScope = () => null;
