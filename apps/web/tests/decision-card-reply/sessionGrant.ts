// The fixture browser operates its synthetic thread; every other session export is the real one.
export * from "../../src/state/session";
export function readEnvironmentScope(): boolean {
  return true;
}
