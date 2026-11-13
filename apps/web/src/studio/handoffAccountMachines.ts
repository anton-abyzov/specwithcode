/**
 * Machines of this SpecWithCode Connect account that the move dialog cannot
 * list yet, and what to do about each. A machine that let this one run work
 * on it is saved on its own (see grantedAccountMachines); while that runs it
 * says so, and when it fails or is held (Connect automatically off, removed
 * here) Connect is offered by hand, with the reason. A machine that has not
 * allowed this one yet is named with where to allow it.
 *
 * @module handoffAccountMachines
 */
import { fleetMachineHasTailnetAddress } from "./fleetAutoConnect";
import type { AccountAutoConnectState } from "./grantedAccountMachines";

export interface HandoffAccountMachine {
  readonly environmentId: string;
  readonly label: string;
  /** False when SpecWithCode Connect says the machine is not answering now. */
  readonly answering: boolean;
}

export interface HandoffConnectFallback extends HandoffAccountMachine {
  /** Why it is not in the list yet. */
  readonly reason: string;
  /** Being saved over SpecWithCode Connect now: Connect waits. */
  readonly connecting: boolean;
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

export const CONNECTING_REASON = "Connecting over SpecWithCode Connect…";
export const NOT_CONNECTED_REASON = "Not connected to this app yet.";

export function handoffAccountMachines(input: {
  readonly discovered: Iterable<Discovered>;
  /** Every machine this app saved, connected or not. */
  readonly savedEnvironmentIds: ReadonlySet<string>;
  /** The machine the project is on. */
  readonly sourceEnvironmentId: string;
  /**
   * The machines this app's server fleet lists: those that allowed this one
   * to run work. Null until it has loaded, when nothing is said yet.
   */
  readonly fleet: ReadonlyArray<FleetEntry> | null;
  /** Where saving each Connect-only machine stands, from the reconciler. */
  readonly states: ReadonlyMap<string, AccountAutoConnectState>;
  /** Tailnet machines whose automatic fleet pairing has finished. */
  readonly fleetPairingSettled: (environmentId: string) => boolean;
  readonly name?: (environmentId: string, label: string) => string;
}): {
  /** Shown with Connect and the reason it is not listed yet. */
  readonly fallback: HandoffConnectFallback[];
  /** On the account, not in the fleet: the machine has not allowed this one yet. */
  readonly notAllowed: HandoffAccountMachine[];
} {
  const fallback: HandoffConnectFallback[] = [];
  const notAllowed: HandoffAccountMachine[] = [];
  if (input.fleet === null) return { fallback, notAllowed };
  const fleetById = new Map(input.fleet.map((machine) => [machine.environmentId, machine]));
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
    const state = input.states.get(id);
    if (state?.phase === "connecting")
      fallback.push({ ...machine, reason: CONNECTING_REASON, connecting: true });
    else if (state) fallback.push({ ...machine, reason: state.reason, connecting: false });
    // A tailnet machine is paired by the fleet; once that has finished without
    // saving it, Connect over SpecWithCode Connect is the way left.
    else if (fleetMachineHasTailnetAddress(inFleet) && input.fleetPairingSettled(id))
      fallback.push({ ...machine, reason: NOT_CONNECTED_REASON, connecting: false });
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
  readonly fleet: ReadonlyArray<{
    readonly environmentId: string;
    readonly label: string;
    readonly url?: string;
    readonly status?: string;
  }>;
  /** Removed here on purpose: not reported as missing. */
  readonly removed?: ReadonlySet<string>;
  /** Tailnet machines whose automatic pairing has finished; until then they may still join. */
  readonly fleetPairingSettled?: (environmentId: string) => boolean;
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
        input.removed?.has(id) ||
        machine.status === "identity-mismatch" ||
        (machine.url !== undefined &&
          fleetMachineHasTailnetAddress({ url: machine.url }) &&
          input.fleetPairingSettled?.(id) === false) ||
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
