/**
 * Hosts the app cannot reach right now, shared by every place that labels a
 * thread or picks a checkout. Without the provider (tests, embedding) every
 * host counts as reachable.
 *
 * @module unreachableHosts
 */
import type { MachineReachState } from "@specweave-studio/client-runtime/connection";
import { createContext, useContext, useEffect, type ReactNode } from "react";

import { recordMachinePhases } from "../lib/machineLastSeen";
import {
  useEnvironments,
  useMachineReachStates,
  useUnreachableEnvironmentIds,
  type MachineReachStates,
} from "../state/environments";

const NONE: ReadonlySet<string> = new Set();
const NO_STATES: MachineReachStates = new Map();
export const UnreachableHostsContext = createContext<ReadonlySet<string>>(NONE);
/** What each saved machine reads as now; a machine missing here reads as connected. */
export const MachineReachContext = createContext<MachineReachStates>(NO_STATES);

export function UnreachableHostsProvider({ children }: { children: ReactNode }) {
  const unreachable = useUnreachableEnvironmentIds();
  const states = useMachineReachStates();
  const { environments } = useEnvironments();
  // Mounted for the whole shell, so it sees every machine leave "connected".
  useEffect(() => recordMachinePhases(environments), [environments]);
  return (
    <UnreachableHostsContext.Provider value={unreachable}>
      <MachineReachContext.Provider value={states}>{children}</MachineReachContext.Provider>
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

export { hostReachOr } from "../lib/machineStatus";
