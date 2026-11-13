/**
 * Machines of this SpecWithCode Connect account that let this machine run
 * work on them and so joined its server's fleet, but have no Tailscale
 * address. Fleet pairing needs a tailnet address and the linked-project rule
 * needs a shared project, so without this a machine reachable over Connect
 * only stayed unsaved until someone pressed Connect. Connect is its only
 * route here, and the grant it gave is consent enough to save it.
 *
 * @module grantedAccountMachines
 */
import type { StudioFleetSnapshot } from "@specweave-studio/contracts/studioFleet";
import type { RelayClientEnvironmentRecord } from "@specweave-studio/contracts/relay";

import { fleetMachineHasTailnetAddress } from "./fleetAutoConnect";

/** Account machines in the fleet that this app should save with a Connect route now. */
export function grantedAccountMachinesToConnect(input: {
  readonly snapshot: StudioFleetSnapshot | null;
  readonly currentEnvironmentId: string | null;
  /** Every machine this app saved, connected or not. */
  readonly savedEnvironmentIds: ReadonlySet<string>;
  /** This account's machines, from the SpecWithCode Connect list. */
  readonly discovered: ReadonlyMap<string, { readonly environment: RelayClientEnvironmentRecord }>;
  /** Removed here, Connect route declined, in flight or out of attempts. */
  readonly skip: ReadonlySet<string>;
}): RelayClientEnvironmentRecord[] {
  const seen = new Set<string>();
  const machines: RelayClientEnvironmentRecord[] = [];
  for (const machine of input.snapshot?.machines ?? []) {
    const id = machine.environmentId;
    if (
      seen.has(id) ||
      id === input.currentEnvironmentId ||
      machine.status === "identity-mismatch" ||
      // A machine with a tailnet address is paired by the fleet instead.
      fleetMachineHasTailnetAddress(machine) ||
      input.savedEnvironmentIds.has(id) ||
      input.skip.has(id)
    )
      continue;
    seen.add(id);
    const found = input.discovered.get(id);
    if (found) machines.push(found.environment);
  }
  return machines;
}

/**
 * Fleet machines reachable over Connect only that the account list does not
 * show yet, such as a machine that signed in a moment ago: the list is read
 * again for them.
 */
export function grantedMachinesMissingFromAccount(input: {
  readonly snapshot: StudioFleetSnapshot | null;
  readonly currentEnvironmentId: string | null;
  readonly savedEnvironmentIds: ReadonlySet<string>;
  readonly discovered: ReadonlyMap<string, unknown>;
}): string[] {
  return (input.snapshot?.machines ?? [])
    .filter(
      (machine) =>
        machine.environmentId !== input.currentEnvironmentId &&
        machine.status !== "identity-mismatch" &&
        !fleetMachineHasTailnetAddress(machine) &&
        !input.savedEnvironmentIds.has(machine.environmentId) &&
        !input.discovered.has(machine.environmentId),
    )
    .map((machine) => machine.environmentId);
}

/*
 * Why the last automatic connection to a machine failed, by environment id.
 * The move dialog offers Connect by hand for these, with the reason.
 */
const failures = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

export function recordAccountAutoConnectFailure(environmentId: string, reason: string): void {
  if (failures.get(environmentId) === reason) return;
  failures.set(environmentId, reason);
  changed();
}

export function clearAccountAutoConnectFailure(environmentId: string): void {
  if (failures.delete(environmentId)) changed();
}

export function subscribeAccountAutoConnectFailures(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function accountAutoConnectFailuresVersion(): number {
  return version;
}

export function accountAutoConnectFailures(): ReadonlyMap<string, string> {
  return failures;
}
