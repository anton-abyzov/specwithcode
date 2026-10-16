import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerConfig } from "@specweave-studio/contracts";
import { useState } from "react";

import { useServerConfigs } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import {
  buildVersionMismatchDismissalKey,
  dismissServerUpdateFailure,
  dismissVersionMismatch,
  isServerUpdateFailureDismissed,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "../../versionSkew";
import {
  ComposerServerUpdateIcon,
  ComposerServerUpdateStatus,
} from "../chat/ComposerServerUpdateStatus";
import { ServerUpdateAction } from "../ServerUpdateAction";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Server updates, shown once for the whole app in the sidebar footer rather
 * than above every thread's composer: one compact row per server that runs an
 * older version, with its progress while it updates.
 */
export function SidebarServerUpdate() {
  const configs = useServerConfigs();
  const { environments } = useEnvironments();
  const many = configs.size > 1;
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  return (
    <>
      {[...configs].map(([environmentId, config]) => (
        <SidebarServerUpdateRow
          key={environmentId}
          environmentId={environmentId}
          config={config}
          serverLabel={
            many ? `${labels.get(environmentId) ?? config.environment.label} server` : "server"
          }
        />
      ))}
    </>
  );
}

function SidebarServerUpdateRow({
  environmentId,
  config,
  serverLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly config: ServerConfig;
  readonly serverLabel: string;
}) {
  const state = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [dismissedState, setDismissedState] = useState<typeof state | null>(null);
  const mismatch = resolveServerConfigVersionMismatch(config);
  const selfUpdate = resolveServerSelfUpdateCapability(config);
  const desktopAppUpdate = supportsDesktopAppUpdate(config);
  const dismissKey = mismatch ? buildVersionMismatchDismissalKey(environmentId, mismatch) : null;
  // The desktop app updates a server it manages itself (Restart to update).
  const actionable =
    mismatch !== null &&
    selfUpdate !== null &&
    (selfUpdate !== "desktop-managed" || desktopAppUpdate);

  if (state.status === "idle") {
    if (!actionable || dismissKey === dismissed || isVersionMismatchDismissed(dismissKey))
      return null;
  } else if (
    state.status === "failed" &&
    (state === dismissedState || isServerUpdateFailureDismissed(state))
  ) {
    return null;
  }

  return (
    <div
      data-testid="sidebar-server-update"
      className="flex min-h-7 items-center gap-1.5 rounded-lg px-2 text-2xs leading-4 text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      <ComposerServerUpdateIcon status={state.status} />
      <span className="min-w-0 flex-1 truncate">
        {state.status === "idle" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button type="button" className="max-w-full cursor-help truncate text-left">
                  {serverLabel === "server" ? "Server update" : `${serverLabel} update`}
                </button>
              }
            />
            <TooltipPopup side="top">
              {serverLabel} {mismatch?.serverVersion} <span aria-hidden="true">→</span>{" "}
              {mismatch?.clientVersion}
            </TooltipPopup>
          </Tooltip>
        ) : (
          <ComposerServerUpdateStatus state={state} serverLabel={serverLabel} />
        )}
      </span>
      {state.status !== "running" && actionable && mismatch ? (
        <ServerUpdateAction
          environmentId={environmentId}
          serverLabel={serverLabel}
          selfUpdate={selfUpdate}
          installation={config.environment.capabilities.serverInstallation}
          desktopAppUpdate={desktopAppUpdate}
          threadContinuation={supportsServerUpdateThreadContinuation(config)}
          targetVersion={mismatch.clientVersion}
          label={state.status === "failed" ? "Retry" : "Update"}
          variant="ghost"
        />
      ) : null}
      {state.status !== "running" ? (
        <button
          type="button"
          aria-label="Dismiss update notice"
          className="cursor-pointer rounded-sm px-1 hover:text-foreground"
          onClick={() => {
            if (state.status === "failed") {
              dismissServerUpdateFailure(state);
              setDismissedState(state);
            }
            dismissVersionMismatch(dismissKey);
            setDismissed(dismissKey);
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
