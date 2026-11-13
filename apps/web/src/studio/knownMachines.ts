/**
 * Every machine a fleet list has named this session, connected or not, with the
 * computer name that list gives it. Machine colors are dealt out over the
 * machines known here (`assignMachineColors`), and a fleet machine this device
 * has never connected to is known only from such a list. Counting it everywhere
 * keeps two machines from drawing the same default color, keeps a machine's
 * color the same in Settings, the sidebar and the composer, and lets a color
 * picker name it as its card does.
 *
 * Machines are only added: one removed mid-session keeps its place until reload,
 * so no other machine's color shifts under the user. A changed name is updated.
 */
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";

const NONE: ReadonlyMap<string, string> = new Map();

export const fleetMachinesAtom = Atom.make<ReadonlyMap<string, string>>(NONE).pipe(
  Atom.keepAlive,
  Atom.withLabel("fleet-machines"),
);

/** Adds the machines a fleet list names; writes only when one is new or renamed. */
export function noteFleetMachines(
  machines: Iterable<{ readonly environmentId: string; readonly label: string }>,
): void {
  const known = appAtomRegistry.get(fleetMachinesAtom);
  const changed = [...machines].filter(
    (machine) => machine.environmentId !== "" && known.get(machine.environmentId) !== machine.label,
  );
  if (changed.length === 0) return;
  const next = new Map(known);
  for (const machine of changed) next.set(machine.environmentId, machine.label);
  appAtomRegistry.set(fleetMachinesAtom, next);
}
