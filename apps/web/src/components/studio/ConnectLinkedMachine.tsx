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
import { Button } from "../ui/button";

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
  const register = useAtomCommand(environmentCatalog.register, { reportFailure: false });
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
              Settings &gt; Connections
            </Link>
            .
          </>
        )}
      </p>
    );
  const connect = async () => {
    setState({ busy: true, error: null });
    // The name Connect lists for the machine, not this page's fallback.
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
      setState({ busy: false, error: null });
      return;
    }
    const cause = squashAtomCommandFailure(result);
    setState({
      busy: false,
      error: cause instanceof Error ? cause.message : `Could not connect to ${label}.`,
    });
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
