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

/**
 * Machines removed from this device this session ("Remove old record"). A fleet
 * list's entry keeps its place for colors until reload, but a removed machine
 * must stop holding a name or chip letters at once.
 */
export const removedMachinesAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.keepAlive,
  Atom.withLabel("removed-machines"),
);

export function noteMachineRemoved(environmentId: string, removed: boolean): void {
  const current = appAtomRegistry.get(removedMachinesAtom);
  if (current.has(environmentId) === removed) return;
  const next = new Set(current);
  if (removed) next.add(environmentId);
  else next.delete(environmentId);
  appAtomRegistry.set(removedMachinesAtom, next);
}

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
