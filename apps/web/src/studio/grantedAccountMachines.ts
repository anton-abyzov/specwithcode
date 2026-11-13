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
import { useSyncExternalStore } from "react";
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
  /** Left out: removed here, Connect route declined, in flight or out of attempts. */
  readonly skip?: ReadonlySet<string>;
  /** Asked for by hand: included even with a tailnet address, whose pairing may have failed. */
  readonly requested?: ReadonlySet<string>;
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
      (fleetMachineHasTailnetAddress(machine) && !input.requested?.has(id)) ||
      input.savedEnvironmentIds.has(id) ||
      input.skip?.has(id)
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

/**
 * Where saving each such machine stands, published by the reconciler so the
 * move dialog, Settings > Machines and the checking state all read one answer.
 * A machine absent from the map is saved, not a candidate, or not tried yet.
 */
export type AccountAutoConnectState =
  | { readonly phase: "connecting" }
  /** The last automatic or requested save failed; Connect by hand retries. */
  | { readonly phase: "failed"; readonly reason: string }
  /** Not tried on purpose: removed here, Connect automatically off, or Connect unreachable. */
  | { readonly phase: "held"; readonly reason: string };

export const AUTO_CONNECT_OFF_REASON = "Connect automatically is off.";
export const REMOVED_HERE_REASON = "Removed from this app.";
export const CONNECT_UNREACHABLE_REASON = "SpecWithCode Connect cannot be reached right now.";
export const CONNECT_NO_ANSWER_REASON = "SpecWithCode Connect did not answer for it.";

let states: ReadonlyMap<string, AccountAutoConnectState> = new Map();
const listeners = new Set<() => void>();
let version = 0;

function sameStates(
  a: ReadonlyMap<string, AccountAutoConnectState>,
  b: ReadonlyMap<string, AccountAutoConnectState>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, state] of a) {
    const other = b.get(id);
    if (!other || other.phase !== state.phase) return false;
    if ("reason" in state && "reason" in other && state.reason !== other.reason) return false;
  }
  return true;
}

/** Replaces every machine's state; called by the reconciler after each pass. */
export function publishAccountAutoConnectStates(
  next: ReadonlyMap<string, AccountAutoConnectState>,
): void {
  if (sameStates(states, next)) return;
  states = new Map(next);
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeAccountAutoConnectStates(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function accountAutoConnectStates(): ReadonlyMap<string, AccountAutoConnectState> {
  return states;
}

const connectRequestListeners = new Set<(environmentIds: ReadonlyArray<string>) => void>();

/**
 * Connect by hand for account machines that allowed this one: saves them over
 * SpecWithCode Connect now, also while Connect automatically is off, and
 * lifts an earlier removal here. Reads no list again, so other machine lists
 * stay put.
 */
export function requestAccountMachineConnect(environmentIds: ReadonlyArray<string>): void {
  for (const listener of connectRequestListeners) listener(environmentIds);
}

export function onAccountMachineConnectRequest(
  listener: (environmentIds: ReadonlyArray<string>) => void,
): () => void {
  connectRequestListeners.add(listener);
  return () => {
    connectRequestListeners.delete(listener);
  };
}

/** Whether Connect by hand can do anything now: not while Connect itself is unreachable. */
export function accountConnectCanRetry(state: AccountAutoConnectState | undefined): boolean {
  if (state === undefined) return true;
  if (state.phase === "connecting") return false;
  return !(state.phase === "held" && state.reason === CONNECT_UNREACHABLE_REASON);
}

/** {@link accountAutoConnectStates}, re-rendering when the reconciler publishes. */
export function useAccountAutoConnectStates(): ReadonlyMap<string, AccountAutoConnectState> {
  return useSyncExternalStore(
    subscribeAccountAutoConnectStates,
    accountAutoConnectStates,
    accountAutoConnectStates,
  );
}
