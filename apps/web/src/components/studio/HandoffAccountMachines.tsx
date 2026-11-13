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
import { useEffect, useState } from "react";

import { setConnectRouteDeclined } from "../../cloud/connectRoutePlan";
import { environmentCatalog } from "../../connection/catalog";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  useRelayEnvironmentDiscovery,
} from "../../state/environments";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { useStudioFleet } from "../../studio/fleet";
import { setFleetEnvironmentSkipped } from "../../studio/fleetAutoConnect";
import {
  handoffAccountMachines,
  handoffFleetOnlyMachines,
} from "../../studio/handoffAccountMachines";
import { useMachineNicknames } from "../../studio/machineNickname";
import { Button } from "../ui/button";

/**
 * Under the move dialog's machine list: machines of this SpecWithCode Connect
 * account that this app has not saved, each with one button that saves it
 * with a Connect route. Once saved, the machine joins the list above. A
 * machine only this app's server knows is named with what is missing. Renders
 * nothing when every machine is already listed.
 */
export function HandoffAccountMachines({
  sourceEnvironmentId,
}: {
  readonly sourceEnvironmentId: EnvironmentId;
}) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const discovery = useRelayEnvironmentDiscovery();
  const name = useMachineNicknames();
  const register = useAtomCommand(environmentCatalog.register, { reportFailure: false });
  const refresh = useAtomCommand(relayEnvironmentDiscovery.refresh, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read when the dialog opens, so a machine that just signed in is offered at once.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const savedEnvironmentIds = new Set<string>(environments.map((item) => item.environmentId));
  const machines = handoffAccountMachines({
    discovered: discovery.environments.values(),
    savedEnvironmentIds,
    sourceEnvironmentId,
    name,
  });
  const fleetOnly =
    primaryEnvironmentId === null ? null : (
      <FleetOnlyMachines
        environmentId={primaryEnvironmentId}
        sourceEnvironmentId={sourceEnvironmentId}
        savedEnvironmentIds={savedEnvironmentIds}
        offeredEnvironmentIds={new Set(machines.map((machine) => machine.environmentId))}
        // Still reading the account's machines: one of them may be offered in a moment.
        waiting={discovery.refreshing}
      />
    );
  if (machines.length === 0) return fleetOnly;
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
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    setError(
      cause instanceof Error && cause.message
        ? cause.message
        : `Could not connect to ${label}. Check that SpecWithCode is open there, then try again.`,
    );
  };
  return (
    <div className="mt-2 space-y-2" data-slot="handoff-account-machines">
      <p className="text-xs text-muted-foreground">
        On your SpecWithCode Connect account, not connected in this app yet:
      </p>
      {machines.map((machine) => (
        <div
          key={machine.environmentId}
          data-account-machine={machine.environmentId}
          className="flex min-w-0 items-center gap-3 rounded-lg border border-dashed px-3 py-2 text-sm"
        >
          <span className="min-w-0 flex-1 truncate font-medium">{machine.label}</span>
          {machine.answering ? null : (
            <span className="shrink-0 text-xs text-muted-foreground">Not answering</span>
          )}
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void connect(machine.environmentId, machine.label)}
          >
            {busy === machine.environmentId ? "Connecting…" : "Connect"}
          </Button>
        </div>
      ))}
      {error ? (
        <p role="alert" className="wrap-anywhere text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {fleetOnly}
    </div>
  );
}

/** Machines this app's own server can reach but this app cannot: says how to connect them. */
function FleetOnlyMachines({
  environmentId,
  sourceEnvironmentId,
  savedEnvironmentIds,
  offeredEnvironmentIds,
  waiting,
}: {
  readonly environmentId: EnvironmentId;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly savedEnvironmentIds: ReadonlySet<string>;
  readonly offeredEnvironmentIds: ReadonlySet<string>;
  readonly waiting: boolean;
}) {
  const { snapshot } = useStudioFleet(environmentId);
  const name = useMachineNicknames();
  const machines = handoffFleetOnlyMachines({
    fleet: snapshot?.machines ?? [],
    savedEnvironmentIds,
    sourceEnvironmentId,
    offeredEnvironmentIds,
    name,
  });
  if (waiting || machines.length === 0) return null;
  const names = machines.map((machine) => machine.label).join(", ");
  return (
    <p
      className="mt-2 text-xs text-muted-foreground"
      data-slot="handoff-fleet-only-machines"
      role="status"
    >
      {`Not listed: ${names}. This app has no connection to ${machines.length === 1 ? "it" : "them"} yet. Sign in to SpecWithCode Connect in this app with the same account, or connect ${machines.length === 1 ? "it" : "them"} in `}
      <Link to="/settings/connections" className="underline underline-offset-2">
        Settings &gt; Machines
      </Link>
      .
    </p>
  );
}
