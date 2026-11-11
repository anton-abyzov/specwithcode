// The real session module, with a connection whose HTTP origin is the fixture's own.
export * from "../../src/state/session";

export function usePreparedConnection() {
  return { _tag: "Some" as const, value: { httpBaseUrl: location.origin } };
}
