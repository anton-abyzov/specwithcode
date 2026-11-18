/**
 * Hosts the app cannot reach right now, shared by every place that labels a
 * thread or picks a checkout. Without the provider (tests, embedding) every
 * host counts as reachable.
 *
 * @module unreachableHosts
 */
import type { MachineReachState } from "@specweave-studio/client-runtime/connection";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";

import { recordMachinePhases } from "../lib/machineLastSeen";
import {
  fleetReachableEnvironmentIds,
  hostDownNote,
  identityMismatchedEnvironmentIds,
  type HostDownNote,
} from "../lib/machineStatus";
import {
  useEnvironments,
  useMachineReachStates,
  usePrimaryEnvironmentId,
  useUnreachableEnvironmentIds,
  type MachineReachStates,
} from "../state/environments";
import { usePrimaryFleetSnapshot } from "./fleet";

const NONE: ReadonlySet<string> = new Set();
const NO_STATES: MachineReachStates = new Map();
const NO_NOTES: ReadonlyMap<string, HostDownNote> = new Map();
export const UnreachableHostsContext = createContext<ReadonlySet<string>>(NONE);
/** What each saved machine reads as now; a machine missing here reads as connected. */
export const MachineReachContext = createContext<MachineReachStates>(NO_STATES);
/**
 * Saved machines whose address the primary fleet says now answers as a
 * different SpecWithCode. Empty without the fleet (a viewer that cannot read
 * it), so every word stays as the reach state alone says.
 */
export const IdentityMismatchContext = createContext<ReadonlySet<string>>(NONE);
/**
 * Why each saved machine would be out of reach beyond its reach state: this
 * window needs a SpecWithCode Connect sign-in for it, or this machine's server
 * still reaches it. Words use a note only while the machine is down.
 */
export const HostDownNoteContext = createContext<ReadonlyMap<string, HostDownNote>>(NO_NOTES);

export function UnreachableHostsProvider({ children }: { children: ReactNode }) {
  const unreachable = useUnreachableEnvironmentIds();
  const states = useMachineReachStates();
  const { environments, presentationById } = useEnvironments();
  // The same list the shell already reads for automatic connects; kept stable between reads.
  const fleet = usePrimaryFleetSnapshot(usePrimaryEnvironmentId());
  const mismatched = useMemo(() => identityMismatchedEnvironmentIds(fleet), [fleet]);
  const notes = useMemo(() => {
    const reachable = fleetReachableEnvironmentIds(fleet);
    const next = new Map<string, HostDownNote>();
    for (const [environmentId, presentation] of presentationById) {
      const note = hostDownNote({
        connectSignInRequired: presentation.connection.connectSignInRequired,
        reachableFromMachine: reachable.has(environmentId),
      });
      if (note !== null) next.set(environmentId, note);
    }
    return next.size === 0 ? NO_NOTES : next;
  }, [fleet, presentationById]);
  // Mounted for the whole shell, so it sees every machine leave "connected".
  useEffect(() => recordMachinePhases(environments), [environments]);
  return (
    <UnreachableHostsContext.Provider value={unreachable}>
      <MachineReachContext.Provider value={states}>
        <IdentityMismatchContext.Provider value={mismatched}>
          <HostDownNoteContext.Provider value={notes}>{children}</HostDownNoteContext.Provider>
        </IdentityMismatchContext.Provider>
      </MachineReachContext.Provider>
    </UnreachableHostsContext.Provider>
  );
}

export function useUnreachableHosts(): ReadonlySet<string> {
  return useContext(UnreachableHostsContext);
}

export function useHostOffline(environmentId: string): boolean {
  return useContext(UnreachableHostsContext).has(environmentId);
}

/** What each saved machine reads as now (`machineReach`), for wording. */
export function useHostReachStates(): MachineReachStates {
  return useContext(MachineReachContext);
}

/** What one machine reads as now, or undefined when the app has not judged it. */
export function useHostReach(
  environmentId: string | null | undefined,
): MachineReachState | undefined {
  const states = useContext(MachineReachContext);
  return environmentId ? states.get(environmentId) : undefined;
}

/** Saved machines whose address now answers as a different SpecWithCode. */
export function useIdentityMismatchedHosts(): ReadonlySet<string> {
  return useContext(IdentityMismatchContext);
}

/** Whether the fleet says this machine's address now answers as a different SpecWithCode. */
export function useHostIdentityMismatch(environmentId: string | null | undefined): boolean {
  const mismatched = useContext(IdentityMismatchContext);
  return environmentId ? mismatched.has(environmentId) : false;
}

/** Why each saved machine would be out of reach beyond its reach state. */
export function useHostDownNotes(): ReadonlyMap<string, HostDownNote> {
  return useContext(HostDownNoteContext);
}

/** Why one machine would be out of reach beyond its reach state, or null. */
export function useHostDownNote(environmentId: string | null | undefined): HostDownNote | null {
  const notes = useContext(HostDownNoteContext);
  return environmentId ? (notes.get(environmentId) ?? null) : null;
}

export { hostReachOr } from "../lib/machineStatus";
