import { useAtomValue } from "@effect/atom-react";
import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@specweave-studio/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";

import { setConnectRouteDeclined } from "../../cloud/connectRoutePlan";
import { environmentCatalog } from "../../connection/catalog";
import { useClientSettings } from "../../hooks/useSettings";
import { useTx } from "../../i18n";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { useStudioFleet } from "../../studio/fleet";
import { setFleetEnvironmentSkipped } from "../../studio/fleetAutoConnect";
import {
  accountAutoConnectFailures,
  accountAutoConnectFailuresVersion,
  clearAccountAutoConnectFailure,
  subscribeAccountAutoConnectFailures,
} from "../../studio/grantedAccountMachines";
import {
  handoffAccountMachines,
  handoffFleetOnlyMachines,
} from "../../studio/handoffAccountMachines";
import { useMachineNicknames } from "../../studio/machineNickname";
import { Button } from "../ui/button";

// The fleet atom needs an id; one that matches no environment reads as no fleet.
const NO_ENVIRONMENT = "" as EnvironmentId;

/**
 * Under the move dialog's machine list. A machine of this SpecWithCode
 * Connect account that let this one run work on it joins the list on its own;
 * this only shows the exceptions: Connect by hand when that failed (with the
 * reason) or Connect automatically is off, account machines that have not
 * allowed this one yet, and machines only this app's server knows. Renders
 * nothing when every machine is listed.
 */
export function HandoffAccountMachines({
  sourceEnvironmentId,
}: {
  readonly sourceEnvironmentId: EnvironmentId;
}) {
  const tx = useTx();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const fleet = useStudioFleet(primaryEnvironmentId ?? NO_ENVIRONMENT);
  const fleetMachines = primaryEnvironmentId === null ? [] : (fleet.snapshot?.machines ?? []);
  const autoConnect = useClientSettings((settings) => settings.autoConnectPrivateMachines);
  // Read from the atom, not the environments hook, so callers mocking that module still render.
  const discovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  const name = useMachineNicknames();
  useSyncExternalStore(
    subscribeAccountAutoConnectFailures,
    accountAutoConnectFailuresVersion,
    accountAutoConnectFailuresVersion,
  );
  const register = useAtomCommand(environmentCatalog.register, { reportFailure: false });
  const refresh = useAtomCommand(relayEnvironmentDiscovery.refresh, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read when the dialog opens, so a machine that just signed in is found at once.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const savedEnvironmentIds = new Set<string>(environments.map((item) => item.environmentId));
  const { fallback, notAllowed } = handoffAccountMachines({
    discovered: discovery.environments.values(),
    savedEnvironmentIds,
    sourceEnvironmentId,
    fleet: fleetMachines,
    autoConnect,
    failures: accountAutoConnectFailures(),
    name,
  });
  const fleetOnly = discovery.refreshing
    ? []
    : handoffFleetOnlyMachines({
        fleet: fleetMachines,
        savedEnvironmentIds,
        sourceEnvironmentId,
        accountEnvironmentIds: new Set(discovery.environments.keys()),
        name,
      });
  if (fallback.length === 0 && notAllowed.length === 0 && fleetOnly.length === 0) return null;

  const connect = async (environmentId: string, label: string) => {
    const found = discovery.environments.get(environmentId)?.environment;
    if (!found || busy) return;
    setBusy(environmentId);
    setError(null);
    const result = await register(
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: found.environmentId,
          label: found.label,
        }),
      }),
    );
    setBusy(null);
    if (result._tag === "Success") {
      // Connecting by hand undoes an earlier removal on this device.
      setFleetEnvironmentSkipped(found.environmentId, false);
      setConnectRouteDeclined(found.environmentId, false);
      clearAccountAutoConnectFailure(found.environmentId);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    setError(
      cause instanceof Error && cause.message
        ? cause.message
        : tx(
            "Could not connect to {name}. Check that SpecWithCode is open there, then try again.",
            {
              name: label,
            },
          ),
    );
  };

  return (
    <div className="mt-2 space-y-2" data-slot="handoff-account-machines">
      {fallback.map((machine) => (
        <div
          key={machine.environmentId}
          data-account-machine={machine.environmentId}
          className="flex min-w-0 items-center gap-3 rounded-lg border border-dashed px-3 py-2 text-sm"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{machine.label}</span>
            <span className="block wrap-anywhere text-xs text-muted-foreground">
              {tx(machine.reason)}
            </span>
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void connect(machine.environmentId, machine.label)}
          >
            {busy === machine.environmentId ? tx("Connecting…") : tx("Connect")}
          </Button>
        </div>
      ))}
      {error ? (
        <p role="alert" className="wrap-anywhere text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {notAllowed.length > 0 ? (
        <p className="text-xs text-muted-foreground" data-slot="handoff-not-allowed-machines">
          {tx(
            "Not listed: {names}. To use one here, open Settings > Machines on it and allow this machine to run work there.",
            { names: notAllowed.map((machine) => machine.label).join(", ") },
          )}
        </p>
      ) : null}
      {fleetOnly.length > 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-slot="handoff-fleet-only-machines"
          role="status"
        >
          {tx(
            "Not listed: {names}. This app has no connection to them yet. Sign in to SpecWithCode Connect here with the same account, or connect them in",
            { names: fleetOnly.map((machine) => machine.label).join(", ") },
          )}{" "}
          <Link to="/settings/connections" className="underline underline-offset-2">
            {tx("Settings > Machines")}
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
