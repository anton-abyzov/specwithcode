/* Machine identities without a fleet: Laptop A is rose (a laptop), Build B blue. */
export * from "../../src/studio/machineIdentity";

const MACHINES: Record<string, { name: string; color: string; icon: string; short: string }> = {
  "env-laptop-a": { name: "Laptop A", color: "rose", icon: "laptop", short: "LA" },
  "env-build-b": { name: "Build B", color: "blue", icon: "linux", short: "BB" },
};

export function useMachineIdentity(environmentId: string | null | undefined) {
  if (!environmentId) return null;
  const machine = MACHINES[environmentId];
  if (!machine) return null;
  return { environmentId, ...machine, derivedShort: machine.short } as never;
}
