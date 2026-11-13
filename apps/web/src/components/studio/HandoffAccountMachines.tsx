import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";

import { requestConnectRoutes } from "../../cloud/connectRoutePlan";
import { useTx } from "../../i18n";
import { useEnvironments } from "../../state/environments";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAccountAutoConnectStates } from "../../studio/grantedAccountMachines";
import {
  handoffAccountMachines,
  handoffFleetOnlyMachines,
} from "../../studio/handoffAccountMachines";
import { fleetAutoConnectSettled } from "../../studio/machineChecking";
import { useMachineNicknames } from "../../studio/machineNickname";
import { usePrimaryFleet } from "../settings/usePrimaryFleet";
import { Button } from "../ui/button";

/** The account list is read again when a dialog opens, at most this often. */
const REFRESH_EVERY_MS = 30_000;
let lastRefreshAt = 0;

/**
 * Under the move dialog's machine list. A machine of this SpecWithCode
 * Connect account that let this one run work on it joins the list on its own;
 * this only shows the exceptions: one being saved right now, Connect by hand
 * when that failed or is held (with the reason), account machines that have
 * not allowed this one yet, and machines only this app's server knows.
 * Renders nothing when every machine is listed.
 */
export function HandoffAccountMachines({
  sourceEnvironmentId,
}: {
  readonly sourceEnvironmentId: EnvironmentId;
}) {
  const tx = useTx();
  const { environments } = useEnvironments();
  const fleet = usePrimaryFleet();
  // Read from the atom, not the environments hook, so callers mocking that module still render.
  const discovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  const states = useAccountAutoConnectStates();
  const name = useMachineNicknames();
  const refresh = useAtomCommand(relayEnvironmentDiscovery.refresh, { reportFailure: false });
  // So a machine that just signed in is found at once, without a probe on every remount.
  useEffect(() => {
    const now = Date.now();
    if (now - lastRefreshAt < REFRESH_EVERY_MS) return;
    lastRefreshAt = now;
    void refresh();
  }, [refresh]);
  const savedEnvironmentIds = new Set<string>(environments.map((item) => item.environmentId));
  const fleetMachines = fleet.snapshot?.machines ?? null;
  const { fallback, notAllowed } = handoffAccountMachines({
    discovered: discovery.environments.values(),
    savedEnvironmentIds,
    sourceEnvironmentId,
    fleet: fleetMachines,
    states,
    fleetPairingSettled: fleetAutoConnectSettled,
    name,
  });
  const fleetOnly =
    discovery.refreshing || fleetMachines === null
      ? []
      : handoffFleetOnlyMachines({
          fleet: fleetMachines,
          savedEnvironmentIds,
          sourceEnvironmentId,
          accountEnvironmentIds: new Set(discovery.environments.keys()),
          name,
        });
  if (fallback.length === 0 && notAllowed.length === 0 && fleetOnly.length === 0) return null;

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
          {machine.connecting ? null : (
            <Button
              size="xs"
              variant="outline"
              onClick={() => requestConnectRoutes([machine.environmentId])}
            >
              {tx("Connect")}
            </Button>
          )}
        </div>
      ))}
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
