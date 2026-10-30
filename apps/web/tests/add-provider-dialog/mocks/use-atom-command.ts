// Fixture-only overrides; everything else comes from the real module.
export * from "../../../src/state/use-atom-command";
export const useAtomCommand = () => async () => ({ _tag: "Failure" });
