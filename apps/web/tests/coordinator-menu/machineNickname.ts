/* Machine names without a fleet: this window's machine is M5, the coordinator shown linux-mini. */
export * from "../../src/studio/machineNickname";

const NAMES: Record<string, string> = { "this-mac": "M5", "linux-mini": "linux-mini" };
const nameOf = (environmentId: string, fallback?: string | null) =>
  NAMES[environmentId] ?? fallback ?? environmentId;

export function machineNickname(environmentId: string, fallback?: string | null) {
  return nameOf(environmentId, fallback);
}
export function useMachineNicknames() {
  return nameOf;
}
export function useMachineNickname(environmentId: string | null | undefined, fallback?: string | null) {
  return environmentId ? nameOf(environmentId, fallback) : (fallback ?? "");
}
