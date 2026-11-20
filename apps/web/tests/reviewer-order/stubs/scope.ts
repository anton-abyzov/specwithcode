import { fixtureStore } from "./store";

export const useSettingsScope = () =>
  fixtureStore.scope === "project"
    ? { scope: { kind: "project", members: [] }, target: { environmentId: "m4", projectId: "fixture" } }
    : { scope: { kind: "environment" }, target: { environmentId: "m4" } };
export const useOptionalSettingsScope = () => null;
