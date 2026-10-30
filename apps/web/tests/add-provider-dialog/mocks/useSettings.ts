// Fixture-only overrides; everything else comes from the real module.
export * from "../../../src/hooks/useSettings";
export const useEnvironmentSettings = () => ({ providerInstances: {}, providers: {} });
export const usePersistEnvironmentProviderInstanceMutation = () => async () => ({
  _tag: "Failure",
});
