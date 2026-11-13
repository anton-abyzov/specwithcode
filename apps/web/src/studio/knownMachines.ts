/**
 * Every machine a fleet list has named this session, connected or not. Machine
 * colors are dealt out over the machines known here (`assignMachineColors`), and a
 * fleet machine this device has never connected to is known only from such a list.
 * Counting it everywhere keeps two machines from drawing the same default color,
 * and keeps a machine's color the same in Settings, the sidebar and the composer.
 *
 * Ids are only added: a machine removed mid-session keeps its place until reload,
 * so no other machine's color shifts under the user.
 */
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";

const NONE: ReadonlySet<string> = new Set();

export const fleetMachineIdsAtom = Atom.make<ReadonlySet<string>>(NONE).pipe(
  Atom.keepAlive,
  Atom.withLabel("fleet-machine-ids"),
);

/** Adds the machines a fleet list names; writes only when one is new. */
export function noteFleetMachines(environmentIds: Iterable<string>): void {
  const known = appAtomRegistry.get(fleetMachineIdsAtom);
  const added = [...new Set(environmentIds)].filter((id) => id !== "" && !known.has(id));
  if (added.length === 0) return;
  appAtomRegistry.set(fleetMachineIdsAtom, new Set([...known, ...added]));
}
