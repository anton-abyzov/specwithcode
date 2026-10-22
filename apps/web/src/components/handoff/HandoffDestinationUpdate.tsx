import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, HandoffPreflightResult } from "@specweave-studio/contracts";

import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "../../versionSkew";
import { ServerUpdateAction, ServerUpdateProgress } from "../ServerUpdateAction";
import { versionFailureNamesDestination } from "./HandoffResults";

/**
 * Update for the destination when its version check says to update it first,
 * shown once per dialog. Press "Check again" once it has restarted.
 */
export function HandoffDestinationUpdate(props: {
  environmentId: EnvironmentId | null;
  label: string;
  results: readonly HandoffPreflightResult[];
}) {
  if (props.environmentId === null || !versionFailureNamesDestination(props.results)) return null;
  return <DestinationUpdateRow environmentId={props.environmentId} label={props.label} />;
}

function DestinationUpdateRow({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const config = useServerConfigs().get(environmentId) ?? null;
  const state = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const mismatch = resolveServerConfigVersionMismatch(config);
  if (mismatch === null && state.status === "idle") return null;
  return (
    <div className="flex flex-col gap-1" data-testid="handoff-destination-update">
      {state.status !== "running" && mismatch !== null ? (
        <div className="flex items-center gap-2">
          <ServerUpdateAction
            environmentId={environmentId}
            serverLabel={`${label} server`}
            selfUpdate={resolveServerSelfUpdateCapability(config)}
            installation={config?.environment.capabilities.serverInstallation}
            desktopAppUpdate={supportsDesktopAppUpdate(config)}
            threadContinuation={supportsServerUpdateThreadContinuation(config)}
            targetVersion={mismatch.clientVersion}
            label={state.status === "failed" ? `Retry updating ${label}` : `Update ${label}`}
          />
        </div>
      ) : null}
      {state.status !== "idle" ? <ServerUpdateProgress state={state} /> : null}
    </div>
  );
}
