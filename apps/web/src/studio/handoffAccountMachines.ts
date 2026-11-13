/**
 * Machines of this SpecWithCode Connect account that the move dialog cannot
 * list yet, and what to do about each. A machine that let this one run work
 * on it is saved on its own (see grantedAccountMachines); only when that
 * fails, or Connect automatically is off, is Connect offered by hand, with
 * the reason. A machine that has not allowed this one yet is named with where
 * to allow it.
 *
 * @module handoffAccountMachines
 */
import { fleetMachineHasTailnetAddress } from "./fleetAutoConnect";

export interface HandoffAccountMachine {
  readonly environmentId: string;
  readonly label: string;
  /** False when SpecWithCode Connect says the machine is not answering now. */
  readonly answering: boolean;
}

export interface HandoffConnectFallback extends HandoffAccountMachine {
  /** Why it was not connected on its own. */
  readonly reason: string;
}

interface Discovered {
  readonly environment: { readonly environmentId: string; readonly label: string };
  readonly availability: string;
}

interface FleetEntry {
  readonly environmentId: string;
  readonly label: string;
  readonly url: string;
}

export const AUTO_CONNECT_OFF_REASON = "Connect automatically is off.";
export const NOT_ANSWERING_REASON = "Not answering over SpecWithCode Connect.";

export function handoffAccountMachines(input: {
  readonly discovered: Iterable<Discovered>;
  /** Every machine this app saved, connected or not. */
  readonly savedEnvironmentIds: ReadonlySet<string>;
  /** The machine the project is on. */
  readonly sourceEnvironmentId: string;
  /** The machines this app's server fleet lists: those that allowed this one to run work. */
  readonly fleet: ReadonlyArray<FleetEntry>;
  readonly autoConnect: boolean;
  /** Why the last automatic connection failed, by machine. */
  readonly failures: ReadonlyMap<string, string>;
  readonly name?: (environmentId: string, label: string) => string;
}): {
  /** Connect by hand, with the reason it did not happen on its own. */
  readonly fallback: HandoffConnectFallback[];
  /** On the account, not in the fleet: the machine has not allowed this one yet. */
  readonly notAllowed: HandoffAccountMachine[];
} {
  const fleetById = new Map(input.fleet.map((machine) => [machine.environmentId, machine]));
  const fallback: HandoffConnectFallback[] = [];
  const notAllowed: HandoffAccountMachine[] = [];
  for (const { environment, availability } of input.discovered) {
    const id = environment.environmentId;
    if (id === input.sourceEnvironmentId || input.savedEnvironmentIds.has(id)) continue;
    const machine = {
      environmentId: id,
      label: input.name?.(id, environment.label) ?? environment.label,
      answering: availability !== "offline" && availability !== "error",
    };
    const inFleet = fleetById.get(id);
    if (!inFleet) {
      notAllowed.push(machine);
      continue;
    }
    const failure = input.failures.get(id);
    if (failure !== undefined) fallback.push({ ...machine, reason: failure });
    else if (!input.autoConnect) fallback.push({ ...machine, reason: AUTO_CONNECT_OFF_REASON });
    // A machine with a tailnet address is paired by the fleet, and one without
    // is being saved over Connect right now: neither needs a button unless it
    // is not answering.
    else if (!fleetMachineHasTailnetAddress(inFleet) && !machine.answering)
      fallback.push({ ...machine, reason: NOT_ANSWERING_REASON });
  }
  const byLabel = (a: HandoffAccountMachine, b: HandoffAccountMachine) =>
    a.label.localeCompare(b.label);
  return { fallback: fallback.toSorted(byLabel), notAllowed: notAllowed.toSorted(byLabel) };
}

/**
 * Machines a server's fleet lists that this app neither saved nor can reach
 * through the account: named with what is missing, so the list never looks
 * complete while one of the user's machines is absent from it.
 */
export function handoffFleetOnlyMachines(input: {
  readonly fleet: ReadonlyArray<{ readonly environmentId: string; readonly label: string }>;
  readonly savedEnvironmentIds: ReadonlySet<string>;
  readonly sourceEnvironmentId: string;
  /** Machines on this app's Connect account, handled above. */
  readonly accountEnvironmentIds: ReadonlySet<string>;
  readonly name?: (environmentId: string, label: string) => string;
}): Array<{ readonly environmentId: string; readonly label: string }> {
  const seen = new Set<string>();
  return input.fleet
    .filter((machine) => {
      const id = machine.environmentId;
      if (
        id === input.sourceEnvironmentId ||
        input.savedEnvironmentIds.has(id) ||
        input.accountEnvironmentIds.has(id) ||
        seen.has(id)
      )
        return false;
      seen.add(id);
      return true;
    })
    .map((machine) => ({
      environmentId: machine.environmentId,
      label: input.name?.(machine.environmentId, machine.label) ?? machine.label,
    }));
}
