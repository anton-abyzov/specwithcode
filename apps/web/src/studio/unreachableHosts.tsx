/**
 * Hosts the app cannot reach right now, shared by every place that labels a
 * thread or picks a checkout. Without the provider (tests, embedding) every
 * host counts as reachable.
 *
 * @module unreachableHosts
 */
import { createContext, useContext, useEffect, type ReactNode } from "react";

import { recordMachinePhases } from "../lib/machineLastSeen";
import { useEnvironments, useUnreachableEnvironmentIds } from "../state/environments";

const NONE: ReadonlySet<string> = new Set();
export const UnreachableHostsContext = createContext<ReadonlySet<string>>(NONE);

export function UnreachableHostsProvider({ children }: { children: ReactNode }) {
  const unreachable = useUnreachableEnvironmentIds();
  const { environments } = useEnvironments();
  // Mounted for the whole shell, so it sees every machine leave "connected".
  useEffect(() => recordMachinePhases(environments), [environments]);
  return (
    <UnreachableHostsContext.Provider value={unreachable}>
      {children}
    </UnreachableHostsContext.Provider>
  );
}

export function useUnreachableHosts(): ReadonlySet<string> {
  return useContext(UnreachableHostsContext);
}

export function useHostOffline(environmentId: string): boolean {
  return useContext(UnreachableHostsContext).has(environmentId);
}
