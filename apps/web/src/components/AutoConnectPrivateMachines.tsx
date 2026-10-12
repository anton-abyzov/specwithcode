import type { EnvironmentId } from "@specweave-studio/contracts";
import { AuthAccessWriteScope } from "@specweave-studio/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { connectPairing } from "../connection/onboarding";
import { useClientSettings } from "../hooks/useSettings";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { pairStudioFleet, useStudioFleet } from "../studio/fleet";
import {
  fleetAttemptsAwaitingRetry,
  fleetMachinesAwaitingReach,
  fleetMachinesToAutoConnect,
  readSkippedFleetEnvironments,
} from "../studio/fleetAutoConnect";

/** How often to look again while a configured machine is still offline, e.g. booting. */
const OFFLINE_RECHECK_MS = 60_000;

/**
 * Pairs this browser with the private machines listed on its server, so a
 * cleared browser, a new browser or a different address does not leave M1 and
 * M3 waiting for a click. Uses the same scoped pairing as Connect machine and
 * runs only for a session that could press that button itself.
 */
export function AutoConnectPrivateMachines() {
  const enabled = useClientSettings((settings) => settings.autoConnectPrivateMachines);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (!enabled || primaryEnvironmentId === null) return null;
  return <AutoConnectFleet environmentId={primaryEnvironmentId} />;
}

function AutoConnectFleet({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { snapshot, loading, refresh } = useStudioFleet(environmentId);
  const canPair = useEnvironmentScope(
    environmentId,
    snapshot?.connectPermission ?? AuthAccessWriteScope,
  );
  const { isReady, environments } = useEnvironments();
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  // When each machine was last tried. A failure, such as the server restarting
  // for an update, is tried again after a minute instead of waiting for a reload.
  const attempted = useRef(new Map<string, number>());
  const running = useRef(false);
  const [failedAt, setFailedAt] = useState(0);

  const savedEnvironmentIds = useMemo(
    () => new Set<string>(environments.map((environment) => environment.environmentId)),
    [environments],
  );

  useEffect(() => {
    if (!isReady || !canPair || running.current) return;
    const machines = fleetMachinesToAutoConnect({
      snapshot,
      currentEnvironmentId: environmentId,
      savedEnvironmentIds,
      skippedEnvironmentIds: readSkippedFleetEnvironments(),
      attemptedEnvironmentIds: fleetAttemptsAwaitingRetry(attempted.current, Date.now()),
    });
    if (machines.length === 0) return;
    running.current = true;
    void (async () => {
      let failed = false;
      try {
        // One at a time: each pairing writes the shared browser catalog.
        for (const machine of machines) {
          attempted.current.set(machine.environmentId, Date.now());
          try {
            const credential = await pairStudioFleet(environmentId, machine.id);
            const result = await connect({
              host: credential.host,
              pairingCode: credential.pairingCode,
              expectedEnvironmentId: credential.environmentId,
            });
            if (result._tag === "Failure") throw new Error("Pairing was not saved.");
          } catch {
            // Connect machine stays available in Settings > Connections meanwhile.
            attempted.current.set(machine.environmentId, Date.now());
            failed = true;
          }
        }
      } finally {
        running.current = false;
        if (failed) setFailedAt(Date.now());
      }
    })();
  }, [canPair, connect, environmentId, isReady, savedEnvironmentIds, snapshot]);

  const unsaved = {
    snapshot,
    currentEnvironmentId: environmentId,
    savedEnvironmentIds,
    skippedEnvironmentIds: readSkippedFleetEnvironments(),
  };
  const awaiting =
    isReady &&
    canPair &&
    (fleetMachinesAwaitingReach(unsaved).length > 0 ||
      (failedAt > 0 &&
        fleetMachinesToAutoConnect({ ...unsaved, attemptedEnvironmentIds: new Set() }).length > 0));

  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  const observedAt = snapshot?.observedAt;
  useEffect(() => {
    if (!awaiting || loading) return;
    const timer = window.setTimeout(() => refreshRef.current(), OFFLINE_RECHECK_MS);
    return () => window.clearTimeout(timer);
  }, [awaiting, failedAt, loading, observedAt]);

  return null;
}
