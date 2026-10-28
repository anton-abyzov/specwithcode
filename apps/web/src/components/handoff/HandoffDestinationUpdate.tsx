import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, HandoffPreflightResult } from "@specweave-studio/contracts";
import type { ServerUpdateState } from "@specweave-studio/client-runtime/state/server";
import { useEffect, useRef } from "react";

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

/** True when an update that was running has just finished without failing. */
export function updateFinished(
  previous: ServerUpdateState["status"] | null,
  next: ServerUpdateState["status"],
): boolean {
  return previous === "running" && next === "idle";
}

/**
 * Update for the destination when its version check says to update it first,
 * shown once per dialog. `onUpdated` fires once the update finishes, so the
 * dialog checks again by itself.
 */
export function HandoffDestinationUpdate(props: {
  environmentId: EnvironmentId | null;
  label: string;
  results: readonly HandoffPreflightResult[];
  onUpdated?: () => void;
}) {
  if (props.environmentId === null || !versionFailureNamesDestination(props.results)) return null;
  return (
    <DestinationUpdateRow
      environmentId={props.environmentId}
      label={props.label}
      {...(props.onUpdated ? { onUpdated: props.onUpdated } : {})}
    />
  );
}

function DestinationUpdateRow({
  environmentId,
  label,
  onUpdated,
}: {
  environmentId: EnvironmentId;
  label: string;
  onUpdated?: () => void;
}) {
  const config = useServerConfigs().get(environmentId) ?? null;
  const state = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const mismatch = resolveServerConfigVersionMismatch(config);
  const previous = useRef<ServerUpdateState["status"] | null>(null);
  const notify = useRef(onUpdated);
  useEffect(() => {
    notify.current = onUpdated;
  });
  useEffect(() => {
    const finished = updateFinished(previous.current, state.status);
    previous.current = state.status;
    if (finished) notify.current?.();
  }, [state.status]);
  if (mismatch === null && state.status === "idle") return null;
  return (
    <div className="flex flex-col gap-1" data-testid="handoff-destination-update">
      {state.status === "idle" ? (
        <p className="text-xs text-muted-foreground">{`${label} needs an update first.`}</p>
      ) : null}
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
