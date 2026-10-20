import { AuthAccessWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import type { StudioFleetMachine } from "@specweave-studio/contracts/studioFleet";
import { useCallback, useMemo } from "react";

import { connectPairing } from "../../connection/onboarding";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { pairStudioFleet, useStudioFleet } from "../../studio/fleet";
import { savedRouteOrigins, setFleetEnvironmentSkipped } from "../../studio/fleetAutoConnect";
import { unseenFleetMachines } from "./machinesSettings.logic";

// The fleet atom needs an id; one that matches no environment reads as no fleet.
const NO_ENVIRONMENT = "" as EnvironmentId;

/**
 * The primary server's private machines, which of them this app cannot see,
 * and Connect for those: the same scoped pairing as Settings > Connections >
 * Connect machine.
 */
export function usePrimaryFleet() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const fleet = useStudioFleet(primaryEnvironmentId ?? NO_ENVIRONMENT);
  const snapshot = primaryEnvironmentId === null ? null : fleet.snapshot;
  const canPair = useEnvironmentScope(
    primaryEnvironmentId,
    snapshot?.connectPermission ?? AuthAccessWriteScope,
  );
  const { environments } = useEnvironments();
  const savedOrigins = useMemo(
    () => savedRouteOrigins(environments.map((environment) => environment.entry)),
    [environments],
  );
  const unseen = useMemo(
    () =>
      unseenFleetMachines({
        fleet: snapshot,
        primaryEnvironmentId,
        savedEnvironmentIds: new Set(environments.map((environment) => environment.environmentId)),
        savedOrigins,
      }),
    [environments, primaryEnvironmentId, savedOrigins, snapshot],
  );
  const pair = useAtomCommand(connectPairing, { reportFailure: false });
  const connect = useCallback(
    async (machine: StudioFleetMachine) => {
      if (primaryEnvironmentId === null) throw new Error("This app has no machine of its own.");
      const credential = await pairStudioFleet(primaryEnvironmentId, machine.id);
      const result = await pair({
        host: credential.host,
        pairingCode: credential.pairingCode,
        expectedEnvironmentId: credential.environmentId,
      });
      if (result._tag === "Failure")
        throw new Error(
          `The app could not connect to ${machine.label}. Check Tailscale and retry. That server must allow this app's origin.`,
        );
      // Connecting by hand undoes an earlier removal, as Connect machine does.
      setFleetEnvironmentSkipped(machine.environmentId, false);
    },
    [pair, primaryEnvironmentId],
  );
  return {
    primaryEnvironmentId,
    snapshot,
    loading: fleet.loading,
    failed: fleet.failed,
    refresh: fleet.refresh,
    canPair,
    savedOrigins,
    unseen,
    connect,
  };
}
