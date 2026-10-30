// Fixture-only overrides; everything else comes from the real module.
export * from "../../../src/state/session";
export const useEnvironmentScope = () => true;
export const readEnvironmentScope = () => false;
