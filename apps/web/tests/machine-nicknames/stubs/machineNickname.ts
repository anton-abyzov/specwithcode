// The nicknames a user set in Settings > Machines, keyed by environmentId.
const NICKNAMES: Record<string, string> = { "env-m1": "M1", "env-m4": "M4", "env-mini": "Mini 2" };
export const machineNickname = (environmentId: string, label?: string | null) =>
  NICKNAMES[environmentId] ?? label ?? environmentId;
export const useMachineNickname = machineNickname;
export const useMachineNicknames = () => machineNickname;
export const resolveMachineNickname = (_n: unknown, id: string, label?: string | null) =>
  machineNickname(id, label);
