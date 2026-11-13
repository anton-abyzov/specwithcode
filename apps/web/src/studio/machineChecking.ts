import { AuthAccessWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import type { StudioFleetSnapshot } from "@specweave-studio/contracts/studioFleet";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentScope } from "../state/session";
import { useStudioFleet } from "./fleet";
import {
  fleetMachinesToAutoConnect,
  readSkippedFleetEnvironments,
  rejectedSavedEnvironments,
  savedRouteOrigins,
} from "./fleetAutoConnect";
import { useAccountAutoConnectStates } from "./grantedAccountMachines";

/*
 * Machines whose first automatic pairing has finished, won or lost, since the
 * page loaded. Until then a reachable private machine the browser has not
 * saved yet is still being checked, not "not connected".
 */
const settledAutoConnects = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

/** Called by the automatic pairing once its attempt on a machine has finished. */
export function markFleetAutoConnectSettled(environmentId: string): void {
  if (settledAutoConnects.has(environmentId)) return;
  settledAutoConnects.add(environmentId);
  version += 1;
  for (const listener of listeners) listener();
}

/** Whether the automatic fleet pairing has finished with this machine since the page loaded. */
export function fleetAutoConnectSettled(environmentId: string): boolean {
  return settledAutoConnects.has(environmentId);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What decides whether a machine is still being checked. */
export interface MachineCheckInput {
  /** The browser's saved machine list has loaded. */
  readonly catalogReady: boolean;
  /** The machine's connection phase here; null when this browser has not saved it. */
  readonly phase: string | null;
  /** This browser pairs with the primary server's private machines on its own. */
  readonly autoConnect: boolean;
  /** The primary server's private machine list has not answered yet. */
  readonly fleetPending: boolean;
  /** The automatic pairing will still try this machine. */
  readonly autoConnectWillTry: boolean;
}

/**
 * Whether the app is still finding out if it can reach a machine: its saved
 * list has not loaded, its first connection attempt is running, or it is a
 * private machine the automatic pairing has not tried yet. While this holds,
 * nothing may tell the person to connect it.
 */
export function machineStillChecking(input: MachineCheckInput): boolean {
  if (!input.catalogReady) return true;
  if (input.phase !== null) return input.phase === "connecting";
  if (!input.autoConnect) return false;
  return input.fleetPending || input.autoConnectWillTry;
}

// The fleet atom needs an id; one that matches no environment reads as no fleet.
const NO_ENVIRONMENT = "" as EnvironmentId;
const NO_MACHINES: ReadonlySet<string> = new Set();

/** {@link machineStillChecking} for any machine, from this browser's live state. */
export function useMachineStillChecking(): (environmentId: string) => boolean {
  const { isReady, environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const autoConnect = useClientSettings((settings) => settings.autoConnectPrivateMachines);
  const fleet = useStudioFleet(primaryEnvironmentId ?? NO_ENVIRONMENT);
  const snapshot: StudioFleetSnapshot | null =
    primaryEnvironmentId === null ? null : fleet.snapshot;
  const canPair = useEnvironmentScope(
    primaryEnvironmentId,
    snapshot?.connectPermission ?? AuthAccessWriteScope,
  );
  // Connect-only machines that allowed this one, while they are being saved over Connect.
  const accountStates = useAccountAutoConnectStates();
  const settled = useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  const willTry = useMemo(() => {
    // Nothing to wait for unless automatic pairing could run on a listed machine.
    if (!autoConnect || primaryEnvironmentId === null || !canPair || !snapshot?.machines.length)
      return NO_MACHINES;
    // Re-read after each settled attempt; the attempts themselves live in the module.
    void settled;
    const machines = fleetMachinesToAutoConnect({
      snapshot,
      currentEnvironmentId: primaryEnvironmentId,
      savedEnvironmentIds: new Set(environments.map((environment) => environment.environmentId)),
      savedRouteOrigins: savedRouteOrigins(
        environments.map((environment) => environment.entry),
        rejectedSavedEnvironments(environments),
      ),
      skippedEnvironmentIds: readSkippedFleetEnvironments(),
      attemptedEnvironmentIds: settledAutoConnects,
    });
    return new Set(machines.map((machine) => machine.environmentId));
  }, [autoConnect, canPair, environments, primaryEnvironmentId, settled, snapshot]);
  const phases = useMemo(
    () =>
      new Map(
        environments.map((environment) => [
          environment.environmentId as string,
          environment.connection?.phase ?? null,
        ]),
      ),
    [environments],
  );
  const fleetPending =
    primaryEnvironmentId !== null && canPair && snapshot === null && fleet.loading;
  return useCallback(
    (environmentId: string) => {
      const savingOverConnect = accountStates.get(environmentId)?.phase === "connecting";
      return machineStillChecking({
        catalogReady: isReady,
        phase: phases.get(environmentId) ?? null,
        autoConnect: autoConnect || savingOverConnect,
        fleetPending,
        autoConnectWillTry: willTry.has(environmentId) || savingOverConnect,
      });
    },
    [accountStates, autoConnect, fleetPending, isReady, phases, willTry],
  );
}
