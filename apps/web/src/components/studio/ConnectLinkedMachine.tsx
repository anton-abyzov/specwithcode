import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@specweave-studio/client-runtime/connection";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { setConnectRouteDeclined } from "../../cloud/connectRoutePlan";
import { environmentCatalog } from "../../connection/catalog";
import { useRelayEnvironmentDiscovery } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { setFleetEnvironmentSkipped } from "../../studio/fleetAutoConnect";
import { reopenJoinCodes } from "../devices/closedJoinCodes";
import { Button } from "../ui/button";

/**
 * Saves a machine this app's SpecWithCode Connect account lists, with a
 * Connect route: the one click of a linked machine this device never saved.
 * Resolves to null when it was saved, else the reason it was not.
 */
export function useConnectLinkedMachine(): (
  environmentId: string,
  label: string,
) => Promise<string | null> | null {
  const discovery = useRelayEnvironmentDiscovery();
  const register = useAtomCommand(environmentCatalog.register, { reportFailure: false });
  return (environmentId, label) => {
    const found = discovery.environments.get(environmentId)?.environment;
    if (!found) return null;
    return (async () => {
      // The owner asks for this machine: a join code card closed earlier shows again.
      reopenJoinCodes([found.environmentId]);
      // The name Connect lists for the machine, not the caller's fallback.
      const result = await register(
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({
            environmentId: found.environmentId,
            label: found.label,
          }),
        }),
      );
      if (result._tag === "Success") {
        // Connecting by hand undoes an earlier removal on this device.
        setFleetEnvironmentSkipped(environmentId as EnvironmentId, false);
        setConnectRouteDeclined(environmentId, false);
        return null;
      }
      const cause = squashAtomCommandFailure(result);
      return cause instanceof Error ? cause.message : `Could not connect to ${label}.`;
    })();
  };
}

/**
 * The way to a linked machine this device has never saved. When this app's
 * SpecWithCode Connect account lists the machine, one click saves it with a
 * Connect route; otherwise it says what is missing.
 */
export function ConnectLinkedMachine({
  environmentId,
  label,
}: {
  environmentId: string;
  label: string;
}) {
  const discovery = useRelayEnvironmentDiscovery();
  const connectLinked = useConnectLinkedMachine();
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  const found = discovery.environments.get(environmentId)?.environment;
  if (!found)
    return (
      <p className="mt-2 max-w-prose text-sm text-muted-foreground" data-linked-machine-missing="">
        {discovery.refreshing
          ? `Looking for ${label} in your SpecWithCode Connect machines...`
          : `This app does not reach ${label}. Sign it in to SpecWithCode Connect with the account ${label} is linked to, or add ${label} in `}
        {discovery.refreshing ? null : (
          <>
            <Link to="/settings/connections" className="underline underline-offset-2">
              Settings &gt; Machines
            </Link>
            .
          </>
        )}
      </p>
    );
  const connect = async () => {
    setState({ busy: true, error: null });
    const error = await connectLinked(environmentId, label);
    setState({ busy: false, error });
  };
  return (
    <div className="mt-2" data-linked-machine-connect={environmentId}>
      <Button size="sm" disabled={state.busy} onClick={() => void connect()}>
        {state.busy
          ? `Connecting to ${label}...`
          : `Connect to ${label} through SpecWithCode Connect`}
      </Button>
      {state.error ? (
        <p className="mt-2 text-sm text-destructive-foreground" role="alert">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
