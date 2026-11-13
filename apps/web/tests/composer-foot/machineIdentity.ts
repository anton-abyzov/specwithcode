/* Machine identities without a fleet: m4 is rose (a laptop), linux-mini blue. */
export * from "../../src/studio/machineIdentity";

const MACHINES: Record<string, { name: string; color: string; icon: string; short: string }> = {
  "env-m4": { name: "m4", color: "rose", icon: "laptop", short: "M4" },
  "env-lm": { name: "linux-mini", color: "blue", icon: "linux", short: "LM" },
};

export function useMachineIdentity(environmentId: string | null | undefined) {
  if (!environmentId) return null;
  const machine = MACHINES[environmentId];
  if (!machine) return null;
  return { environmentId, ...machine, derivedShort: machine.short } as never;
}
