/* Machine identities without a fleet: the viewed machine is teal, this Mac blue. */
export * from "../../src/studio/machineIdentity";

export function useMachineIdentity(
  environmentId: string | null | undefined,
  label?: string | null,
) {
  if (!environmentId) return null;
  const name = label ?? window.__fixtureMachine ?? environmentId;
  return {
    environmentId,
    name,
    color: environmentId === "this-mac" ? "blue" : "teal",
    icon: "linux",
    short: [...name].slice(0, 2).join("").toUpperCase(),
    derivedShort: [...name].slice(0, 2).join("").toUpperCase(),
  } as never;
}
