import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import { useClientSettings } from "../../hooks/useSettings";
import { useTx } from "../../i18n";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { usePrimaryFleetSnapshot, useStudioFleet } from "../../studio/fleet";
import { readSkippedFleetEnvironments } from "../../studio/fleetAutoConnect";
import {
  requestAccountMachineConnect,
  useAccountAutoConnectStates,
} from "../../studio/grantedAccountMachines";
import {
  handoffAccountMachines,
  handoffFleetOnlyMachines,
} from "../../studio/handoffAccountMachines";
import {
  fleetAutoConnectSettled,
  useFleetAutoConnectSettledVersion,
} from "../../studio/machineChecking";
import { useMachineNicknames } from "../../studio/machineNickname";
import { Button } from "../ui/button";

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
  const autoConnect = useClientSettings((settings) => settings.autoConnectPrivateMachines);
  const { environments } = useEnvironments();
  // Saving happens in this app, so its own server's fleet says what is being
  // saved; which machines can take the work is the source machine's fleet,
  // as in the dialog's list.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const fleetSnapshot = usePrimaryFleetSnapshot(primaryEnvironmentId);
  const sourceFleet = useStudioFleet(sourceEnvironmentId).snapshot;
  // Read from the atom, not the environments hook, so callers mocking that module still render.
  const discovery = useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  const states = useAccountAutoConnectStates();
  // A tailnet machine whose pairing just finished without saving it is offered at once.
  useFleetAutoConnectSettledVersion();
  const name = useMachineNicknames();
  const savedEnvironmentIds = new Set<string>(environments.map((item) => item.environmentId));
  const removedHere = readSkippedFleetEnvironments();
  const fleetStatusById = new Map<string, string>(
    (fleetSnapshot?.machines ?? []).map((machine) => [machine.environmentId, machine.status]),
  );
  // A tailnet machine's automatic pairing is over, or will never run (Connect
  // automatically off, removed here): Connect over SpecWithCode Connect is
  // offered then. One still booting may yet pair over Tailscale, so it waits.
  const pairingDone = (environmentId: string) =>
    fleetStatusById.get(environmentId) !== "identity-mismatch" &&
    (fleetAutoConnectSettled(environmentId) ||
      !autoConnect ||
      removedHere.has(environmentId as EnvironmentId));
  const sourceLabel =
    environments.find((item) => item.environmentId === sourceEnvironmentId)?.label ??
    sourceEnvironmentId;
  const fleetMachines = fleetSnapshot?.machines ?? null;
  const sourceMachines = sourceFleet?.machines ?? null;
  const { fallback, notAllowed: accountOnly } = handoffAccountMachines({
    discovered: discovery.environments.values(),
    savedEnvironmentIds,
    sourceEnvironmentId,
    fleet: fleetMachines,
    sourceFleet: sourceMachines,
    states,
    fleetPairingSettled: pairingDone,
    name,
  });
  // Named only once the list is current, and only machines answering now.
  const notAllowed = discovery.refreshing ? [] : accountOnly.filter((machine) => machine.answering);
  // Settings > Machines lists this app's own fleet, so the notice that points
  // there is given for a project on this app's own machine only.
  const fleetOnly =
    discovery.refreshing ||
    // Unread, the list cannot say which machines are on the account.
    discovery.error._tag === "Some" ||
    discovery.offline ||
    fleetMachines === null ||
    sourceEnvironmentId !== primaryEnvironmentId
      ? []
      : handoffFleetOnlyMachines({
          fleet: fleetMachines,
          savedEnvironmentIds,
          sourceEnvironmentId,
          // Also those whose state is published while the list cannot be read.
          accountEnvironmentIds: new Set([...discovery.environments.keys(), ...states.keys()]),
          removed: removedHere,
          fleetPairingSettled: pairingDone,
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
              {machine.detail ? ` (${machine.detail})` : null}
            </span>
          </span>
          {!machine.canConnect ? null : (
            <Button
              size="xs"
              variant="outline"
              onClick={() => requestAccountMachineConnect([machine.environmentId])}
            >
              {tx("Connect")}
            </Button>
          )}
        </div>
      ))}
      {notAllowed.length > 0 ? (
        <p className="text-xs text-muted-foreground" data-slot="handoff-not-allowed-machines">
          {sourceEnvironmentId === primaryEnvironmentId
            ? tx(
                "Not listed: {names}. To use one here, open Settings > Machines on it and allow this machine to run work there.",
                { names: notAllowed.map((machine) => machine.label).join(", ") },
              )
            : tx(
                "Not listed: {names}. To use one here, open Settings > Machines on it and allow {machine} to run work there.",
                {
                  names: notAllowed.map((machine) => machine.label).join(", "),
                  machine: name(sourceEnvironmentId, sourceLabel),
                },
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
          <Link to="/settings/machines" className="underline underline-offset-2">
            {tx("Settings > Machines")}
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
