/**
 * What each machine reads as from this device, judged in one place so every
 * surface agrees: connected, catching up, reconnecting, not answering, offline
 * and so on (`machineReach`). The judgement depends on time (a drop reads as
 * reconnecting for its first minute), so it lives in an atom that is judged
 * again when a machine's grace ends, not in each component's render.
 *
 * @module machineReach
 */
import { useAtomValue } from "@effect/atom-react";
import {
  CONNECTION_WARNING_GRACE_MS,
  isMachineReachDown,
  machineReach,
  type EnvironmentPresentation,
  type MachineReachState,
} from "@specweave-studio/client-runtime/connection";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { isThisMachineTarget } from "../connection/desktopLocal";
import { environmentPresentations } from "./presentation";
import { environmentShell } from "./shell";

/**
 * What a machine reads as from this device (`machineReach`), with this machine
 * judged as local. This machine is never offline: its server shares this
 * device, so a slow or dropped answer means the app is busy (a stalled event
 * loop, a full disk) and catches up on its own. It is down only once the
 * connection has stopped for good ("error") or this build cannot talk to it
 * ("unsupported").
 */
export function environmentReachState(
  environment: Pick<EnvironmentPresentation, "entry" | "connection">,
  now: number,
  listSyncing = false,
): MachineReachState {
  const state = machineReach(environment.connection, now, { listSyncing }).state;
  if (!isThisMachineTarget(environment.entry)) return state;
  return state === "connected" || state === "stopped" ? state : "catching-up";
}

/**
 * Hosts that cannot be reached now: not answering, offline, without a network,
 * stopped or turned off. A host inside its reconnect grace, or on its first
 * attempts, is not one yet, so a short drop or a page load does not flash
 * every remote host as offline.
 */
export function isEnvironmentUnreachable(state: MachineReachState): boolean {
  return isMachineReachDown(state);
}

/** The ids of {@link isEnvironmentUnreachable} environments, this machine judged as local. */
export function unreachableEnvironmentIds(
  environments: ReadonlyArray<
    Pick<EnvironmentPresentation, "entry" | "connection"> & {
      readonly environmentId: EnvironmentId;
    }
  >,
  now: number,
): ReadonlyArray<EnvironmentId> {
  return environments
    .filter((environment) => isEnvironmentUnreachable(environmentReachState(environment, now)))
    .map((environment) => environment.environmentId);
}

export type MachineReachStates = ReadonlyMap<string, MachineReachState>;

const NONE: MachineReachStates = new Map();

function sameStates(left: MachineReachStates, right: MachineReachStates): boolean {
  if (left.size !== right.size) return false;
  for (const [id, state] of left) if (right.get(id) !== state) return false;
  return true;
}

// When each connected machine's thread list started resyncing. A resync that
// ends within the warning grace (most do, in under a second) is never shown.
// The app runs one atom registry, so this memo is per page.
const syncingSince = new Map<EnvironmentId, number>();
let previous: MachineReachStates = NONE;

/**
 * Every saved machine's reach state. The presentation atom publishes again when
 * a machine's reconnect grace ends, which judges it again here.
 */
export const machineReachStatesAtom = Atom.make((get) => {
  const now = Date.now();
  const next = new Map<string, MachineReachState>();
  let recheckIn: number | null = null;
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    let listSyncing = false;
    if (presentation.connection.phase === "connected") {
      if (get(environmentShell.stateValueAtom(environmentId)).status === "live") {
        syncingSince.delete(environmentId);
      } else {
        const since = syncingSince.get(environmentId) ?? now;
        syncingSince.set(environmentId, since);
        const shownAt = since + CONNECTION_WARNING_GRACE_MS;
        listSyncing = now >= shownAt;
        if (!listSyncing) recheckIn = Math.min(recheckIn ?? Infinity, shownAt - now);
      }
    } else {
      syncingSince.delete(environmentId);
    }
    next.set(environmentId, environmentReachState(presentation, now, listSyncing));
  }
  // A removed machine leaves no memo behind.
  for (const environmentId of syncingSince.keys()) {
    if (!next.has(environmentId)) syncingSince.delete(environmentId);
  }
  if (recheckIn !== null) {
    const timer = setTimeout(() => get.refreshSelf(), recheckIn);
    get.addFinalizer(() => clearTimeout(timer));
  }
  if (sameStates(previous, next)) return previous;
  previous = next;
  return previous;
}).pipe(Atom.withLabel("web-machine-reach-states"));

/** Every saved machine's reach state, by environment id. */
export function useMachineReachStates(): MachineReachStates {
  return useAtomValue(machineReachStatesAtom);
}

/** The ids of machines that cannot be reached now (see `isEnvironmentUnreachable`). */
export function useUnreachableEnvironmentIds(): ReadonlySet<string> {
  const states = useMachineReachStates();
  return useMemo(
    () =>
      new Set([...states].filter(([, state]) => isEnvironmentUnreachable(state)).map(([id]) => id)),
    [states],
  );
}
