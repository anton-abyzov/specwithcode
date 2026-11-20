/* Fixture stand-in for the fleet's link readiness: every machine is connected, permitted and
   new enough, and is named by its id. The Fix dialog's guard and words stay the real ones. */
export * from "../../src/components/studio/useLinkMachines";

export function useLinkMachines() {
  return {
    label: (environmentId: string) => environmentId,
    state: () => "ready" as const,
    problem: () => null,
    connected: () => true,
    takeoverReady: () => true,
    startReady: () => true,
  };
}
