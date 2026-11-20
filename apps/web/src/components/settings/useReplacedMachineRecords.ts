import type { StudioFleetSnapshot } from "@specweave-studio/contracts/studioFleet";
import { useMemo } from "react";

import type { EnvironmentId } from "@specweave-studio/contracts";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  useRelayEnvironmentDiscovery,
} from "../../state/environments";
import { useStudioFleet } from "../../studio/fleet";
import { type ConnectListedMachine, replacedMachineRecords } from "./machinesSettings.logic";

/**
 * Old records of machines that joined again, by id, mapped to the id each lives
 * on now (`replacedMachineRecords`). Empty until this machine's list and the
 * account's Connect list are both complete.
 */
export function useReplacedMachineRecords(
  fleet: StudioFleetSnapshot | null,
  primaryEnvironmentId: string | null,
): ReadonlyMap<string, string> {
  const { environments } = useEnvironments();
  const discovery = useRelayEnvironmentDiscovery();
  return useMemo(() => {
    const complete = !discovery.refreshing && !discovery.offline && discovery.error._tag === "None";
    const connect = complete
      ? new Map<string, ConnectListedMachine>(
          [...discovery.environments].map(([id, entry]) => [
            id,
            { label: entry.environment.label, online: entry.availability === "online" },
          ]),
        )
      : null;
    return replacedMachineRecords({
      saved: environments.map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.label,
        connected: environment.connection?.phase === "connected",
      })),
      fleet: fleet?.machines ?? null,
      connect,
      primaryEnvironmentId,
    });
  }, [environments, discovery, fleet, primaryEnvironmentId]);
}

/**
 * The same old records, read from this app's primary machine: what every role derivation
 * (Settings, the project menu, Send, the sidebar) passes to `copyRoles`, so a machine that
 * joined again never leads from its stale record anywhere.
 */
export function useRetiredMachineRecords(): ReadonlyMap<string, string> {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // The fleet atom needs an id; one that matches no environment reads as no fleet.
  const fleet = useStudioFleet(primaryEnvironmentId ?? ("" as EnvironmentId));
  return useReplacedMachineRecords(
    primaryEnvironmentId === null ? null : fleet.snapshot,
    primaryEnvironmentId,
  );
}
