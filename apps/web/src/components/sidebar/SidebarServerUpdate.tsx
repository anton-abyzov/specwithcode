import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerConfig } from "@specweave-studio/contracts";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { describeServerUpdate, serverUpdateRowText } from "../../serverUpdateWording";
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
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  return (
    <>
      {[...configs].map(([environmentId, config]) => {
        // Every row names its machine: a lone "Server" read as some other machine's, not this
        // one's own background service.
        const machine = labels.get(environmentId) ?? config.environment.label ?? null;
        return (
          <SidebarServerUpdateRow
            key={environmentId}
            environmentId={environmentId}
            config={config}
            machine={machine}
            serverLabel={machine === null ? "server" : `${machine} server`}
          />
        );
      })}
    </>
  );
}

function SidebarServerUpdateRow({
  environmentId,
  config,
  machine,
  serverLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly config: ServerConfig;
  readonly machine: string | null;
  readonly serverLabel: string;
}) {
  const state = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const continueThreadsAfterServerUpdate = useEnvironmentSettings(
    environmentId,
    (settings) => settings.continueThreadsAfterServerUpdate,
  );
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [dismissedState, setDismissedState] = useState<typeof state | null>(null);
  const mismatch = resolveServerConfigVersionMismatch(config);
  const selfUpdate = resolveServerSelfUpdateCapability(config);
  const desktopAppUpdate = supportsDesktopAppUpdate(config);
  const threadContinuation = supportsServerUpdateThreadContinuation(config);
  // What Update changes there, said on the idle row and its hover.
  const wording =
    mismatch !== null && selfUpdate !== null
      ? {
          machine,
          serverVersion: mismatch.serverVersion,
          clientVersion: mismatch.clientVersion,
          selfUpdate,
          threadContinuation,
          continueThreadsAfterServerUpdate,
        }
      : null;
  const rowText = wording === null ? null : serverUpdateRowText(wording);
  const description = wording === null ? undefined : describeServerUpdate(wording);
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
      {state.status !== "idle" ? (
        <>
          <ComposerServerUpdateIcon status={state.status} />
          <span className="min-w-0 flex-1 truncate">
            <ComposerServerUpdateStatus state={state} serverLabel={serverLabel} />
          </span>
        </>
      ) : rowText === null ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              // Two 14px lines, as tall as the one-line running and failed rows:
              // the icon and the machine, then "1.0.20 → 1.0.25" from under the
              // icon, so the version Update installs gets the icon's width too.
              // The versions line is reversed so that, short of room, the current
              // version wraps onto a second flex line that is clipped away whole;
              // only then does the target truncate, with an ellipsis. Screen
              // readers hear the label, which says "to"; the description is read
              // once, on Update. The negative margin gives the focus ring room
              // without moving the text.
              <button
                type="button"
                aria-label={rowText.label}
                className="-mx-0.5 grid min-w-0 flex-1 cursor-help grid-cols-[auto_minmax(0,1fr)] gap-x-1.5 rounded-sm px-0.5 text-left leading-3.5 outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ComposerServerUpdateIcon status={state.status} />
                <span data-testid="sidebar-server-update-name" className="truncate">
                  {rowText.name}
                </span>{" "}
                <span
                  data-testid="sidebar-server-update-versions"
                  className="col-span-2 flex h-3.5 flex-row-reverse flex-wrap justify-end gap-x-1 overflow-hidden whitespace-nowrap"
                >
                  <span data-testid="sidebar-server-update-current" className="order-1">
                    {rowText.serverVersion}
                  </span>{" "}
                  <span data-testid="sidebar-server-update-target" className="min-w-0 truncate">
                    → {rowText.clientVersion}
                  </span>
                </span>
              </button>
            }
          />
          <TooltipPopup side="top">{description}</TooltipPopup>
        </Tooltip>
      )}
      {state.status !== "running" && actionable && mismatch ? (
        <ServerUpdateAction
          environmentId={environmentId}
          serverLabel={serverLabel}
          selfUpdate={selfUpdate}
          installation={config.environment.capabilities.serverInstallation}
          desktopAppUpdate={desktopAppUpdate}
          threadContinuation={threadContinuation}
          targetVersion={mismatch.clientVersion}
          label={state.status === "failed" ? "Retry" : "Update"}
          variant="ghost"
          description={state.status === "idle" ? description : undefined}
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
