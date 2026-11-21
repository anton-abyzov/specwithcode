/**
 * The phone's By machine section: which machines to ask, what each is called
 * and the colour it wears. The split and the estimate come from the same
 * shared logic the desktop Machines tab uses.
 */
import type {
  MachineColorId,
  MachineNicknames,
  ServerProvider,
  UsageSummary,
} from "@specweave-studio/contracts";
import { assignMachineColors } from "@specweave-studio/shared/machineNicknames";
import { usageAccountKey } from "@specweave-studio/shared/usageAccountKey";
import {
  type ShareMachineInput,
  type ShareReport,
  shareMachineInput,
} from "@specweave-studio/shared/usageMachineShare";

/** The machine palette, as the desktop draws it (`[data-machine-color]`). */
export const MACHINE_COLOR_HEX: Record<MachineColorId, string> = {
  violet: "#7357e6",
  teal: "#0e8177",
  amber: "#a8650a",
  rose: "#cc3a66",
  blue: "#2f6fd6",
  green: "#2f8040",
  orange: "#c2561a",
  slate: "#5d6878",
};

export interface ByMachinePresentation {
  readonly entry: { readonly target: { readonly label: string } };
  readonly connection: { readonly phase: string };
  readonly serverConfig: {
    readonly providers?: readonly ServerProvider[] | undefined;
    readonly environment: { readonly capabilities: { readonly usageMachineReport?: boolean } };
    readonly settings?: { readonly machineNicknames?: MachineNicknames } | undefined;
  } | null;
}

/** Nicknames as any connected machine holds them; they are synced across the fleet. */
export function fleetNicknames(
  presentations: ReadonlyMap<string, ByMachinePresentation>,
): MachineNicknames {
  let merged: MachineNicknames = {};
  for (const presentation of presentations.values()) {
    const nicknames = presentation.serverConfig?.settings?.machineNicknames;
    if (nicknames !== undefined) merged = { ...nicknames, ...merged };
  }
  return merged;
}

export interface ByMachineIdentity {
  readonly name: string;
  readonly color: string;
}

/** Each machine's name and colour: its nickname and chosen colour when it has them. */
export function machineIdentities(
  presentations: ReadonlyMap<string, ByMachinePresentation>,
): (machineId: string) => ByMachineIdentity {
  const nicknames = fleetNicknames(presentations);
  const colors = assignMachineColors(presentations.keys(), nicknames);
  return (machineId) => ({
    name:
      nicknames[machineId]?.name.trim() ||
      presentations.get(machineId)?.entry.target.label ||
      "Machine",
    color: MACHINE_COLOR_HEX[colors.get(machineId) ?? "slate"],
  });
}

/** The machines the section merges, in a stable order. */
export function byMachineInputs(input: {
  readonly presentations: ReadonlyMap<string, ByMachinePresentation>;
  readonly selected: ReadonlySet<string> | null;
  readonly permitted: ReadonlySet<string>;
  readonly answers: ReadonlyMap<string, ShareReport | "failed"> | null;
  readonly summaries: ReadonlyMap<string, UsageSummary | null>;
}): readonly ShareMachineInput[] {
  const identityOf = machineIdentities(input.presentations);
  const machineIds = [...input.presentations.keys()].filter(
    (machineId) => input.selected === null || input.selected.has(machineId),
  );
  machineIds.sort();
  return machineIds.map((machineId) => {
    const presentation = input.presentations.get(machineId);
    return shareMachineInput({
      machineId,
      name: identityOf(machineId).name,
      connected: presentation?.connection.phase === "connected",
      canReport: presentation?.serverConfig?.environment.capabilities.usageMachineReport === true,
      permitted: input.permitted.has(machineId),
      heldAccountKeys: (presentation?.serverConfig?.providers ?? [])
        .filter((provider) => provider.auth.status === "authenticated")
        .map((provider) => usageAccountKey(provider)),
      answer: input.answers?.get(machineId) ?? null,
      // The phone keeps no reports between visits.
      kept: null,
      summary: input.summaries.get(machineId) ?? null,
    });
  });
}

/** Which machines can be asked now, as a key that changes when one joins or leaves. */
export function askableMachines(
  presentations: ReadonlyMap<string, ByMachinePresentation>,
  selected: ReadonlySet<string> | null,
  permitted: ReadonlySet<string>,
): readonly string[] {
  const ids = [...presentations.keys()].filter((machineId) => {
    const presentation = presentations.get(machineId);
    return (
      (selected === null || selected.has(machineId)) &&
      permitted.has(machineId) &&
      presentation?.connection.phase === "connected" &&
      presentation.serverConfig?.environment.capabilities.usageMachineReport === true
    );
  });
  ids.sort();
  return ids;
}
