// Machine colors for the fixture: each machine its own hue, as the app deals them out,
// so screenshots show every place Settings names a machine in its color.
const COLORS = ["violet", "teal", "amber", "rose", "blue", "green", "orange", "slate"] as const;
type Color = (typeof COLORS)[number];

export const MACHINE_COLOR_IDS = COLORS;
export const MACHINE_COLOR_LABELS: Record<Color, string> = {
  violet: "Violet",
  teal: "Teal",
  amber: "Amber",
  rose: "Rose",
  blue: "Blue",
  green: "Green",
  orange: "Orange",
  slate: "Slate",
};

const MACHINES: Record<string, { name: string; color: Color; short: string; icon: string }> = {
  "env-m4": { name: "M4", color: "violet", short: "M4", icon: "laptop" },
  "env-m3": { name: "M3", color: "teal", short: "M3", icon: "desktop" },
  "env-windows": { name: "PRCTY-AABYZOV", color: "amber", short: "PA", icon: "desktop" },
  "env-m1": { name: "M1", color: "blue", short: "M1", icon: "mac-mini" },
  "env-m5": { name: "M5", color: "rose", short: "M5", icon: "laptop" },
  "env-dana": { name: "Dana's Mac", color: "green", short: "DM", icon: "laptop" },
  "env-phone": { name: "iPhone", color: "slate", short: "IP", icon: "server" },
};

const identityOf = (environmentId: string, label?: string | null) => {
  const known = MACHINES[environmentId] ?? {
    name: environmentId,
    color: "orange" as Color,
    short: environmentId.slice(0, 2).toUpperCase(),
    icon: "server",
  };
  return {
    environmentId,
    name: label?.trim() || known.name,
    color: known.color,
    icon: known.icon,
    short: known.short,
    derivedShort: known.short,
  };
};

export const machineColorProps = (identity: { color: Color } | null | undefined) =>
  identity ? { "data-machine-color": identity.color } : {};
export const useMachineIdentity = (environmentId: string | null | undefined, label?: string | null) =>
  environmentId ? identityOf(environmentId, label) : null;
export const useMachineIdentities = () => identityOf;
export const useKnownMachineIdentities = () => Object.keys(MACHINES).map((id) => identityOf(id));
export const useMachineColorWearers = () => {
  const wearers = new Map<Color, ReturnType<typeof identityOf>[]>();
  for (const id of Object.keys(MACHINES)) {
    const identity = identityOf(id);
    wearers.set(identity.color, [...(wearers.get(identity.color) ?? []), identity]);
  }
  return wearers;
};
export const useRenameMachine = () => ({
  lock: null,
  rename: () => true,
  saveIdentity: () => true,
});
export const useCustomMachineNickname = () => null;
export const renameMachineLockText = () => null;
