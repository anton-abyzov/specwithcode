import type { DesktopUpdateState } from "@specweave-studio/contracts";
import { useState } from "react";

import { isElectron } from "../../env";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { useStudioServiceUpdateState } from "../../state/serviceUpdate";
import {
  getDesktopUpdateActionError,
  getDesktopUpdateDownloadedVersion,
  resolveDesktopUpdateButtonAction,
} from "../desktopUpdate.logic";
import { liveServiceUpdateRun } from "../serviceUpdateRunView";
import { requestRestartToUpdate } from "../sidebar/restartToUpdateRequests";
import { isAppUpdateReady } from "../sidebar/SidebarRestartToUpdate.logic";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/**
 * Setup covers the sidebar, where the update controls live, and off macOS the
 * window shows no menu with Check for Updates. So a newer build is offered
 * here too: an old install can update before anything is chosen.
 */
export function FirstRunUpdateNotice() {
  return isElectron ? <FirstRunUpdateNoticeContent /> : null;
}

export type FirstRunUpdateView =
  | { readonly kind: "download"; readonly version: string | null }
  | { readonly kind: "downloading"; readonly percent: number | null }
  | {
      readonly kind: "install";
      readonly version: string | null;
      /** A check (background, or the one a restart starts) is still running. */
      readonly checking: boolean;
    };

/** What setup offers for the app's own update; null when there is nothing to do. */
export function firstRunUpdateView(
  state: DesktopUpdateState | null,
  serviceRunLive: boolean,
): FirstRunUpdateView | null {
  // While an Update now run goes on, its own toast shows the progress.
  if (state === null || serviceRunLive) return null;
  if (state.status === "downloading") {
    return { kind: "downloading", percent: state.downloadPercent };
  }
  // A check keeps the download, so the offer stays put as in the sidebar.
  if (isAppUpdateReady(state)) {
    return {
      kind: "install",
      version: getDesktopUpdateDownloadedVersion(state),
      checking: state.status === "checking",
    };
  }
  if (resolveDesktopUpdateButtonAction(state) === "download")
    return { kind: "download", version: state.availableVersion };
  return null;
}

function FirstRunUpdateNoticeContent() {
  const state = useDesktopUpdateState();
  const serviceRunLive = liveServiceUpdateRun(useStudioServiceUpdateState()) !== null;
  const [downloading, setDownloading] = useState(false);
  const view = firstRunUpdateView(state, serviceRunLive);
  if (view === null) return null;

  const download = () => {
    const bridge = window.desktopBridge;
    if (!bridge || downloading) return;
    setDownloading(true);
    void bridge
      .downloadUpdate()
      .then((result) => {
        const error = getDesktopUpdateActionError(result);
        if (error) {
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: error,
          });
        }
      })
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not start update download",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      )
      .finally(() => setDownloading(false));
  };

  const install = () => {
    // The sidebar's Restart to update control, mounted under setup, installs
    // the same way as from the app; without it the update waits for a quit.
    if (!requestRestartToUpdate()) {
      toastManager.add({
        type: "info",
        title: "Update downloaded",
        description: "Quit and reopen SpecWithCode to install it.",
      });
    }
  };

  return (
    <FirstRunUpdateNoticeView
      view={view}
      downloading={downloading}
      onDownload={download}
      onInstall={install}
    />
  );
}

/** The notice itself, for a view already worked out. */
export function FirstRunUpdateNoticeView({
  view,
  downloading,
  onDownload,
  onInstall,
}: {
  readonly view: FirstRunUpdateView;
  readonly downloading: boolean;
  readonly onDownload: () => void;
  readonly onInstall: () => void;
}) {
  const product = (version: string | null) =>
    version ? `SpecWithCode ${version}` : "A newer SpecWithCode";
  const message =
    view.kind === "download"
      ? `${product(view.version)} is available. Update before you set up.`
      : view.kind === "downloading"
        ? `Downloading the update${view.percent === null ? "…" : ` (${Math.floor(view.percent)}%)…`}`
        : `${product(view.version)} is ready to install.`;

  return (
    <div
      role="status"
      aria-label="App update"
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg bg-muted/60 px-3 py-2 text-sm"
    >
      <span className="min-w-0 text-muted-foreground">{message}</span>
      {view.kind === "download" ? (
        <Button size="xs" variant="outline" disabled={downloading} onClick={onDownload}>
          Download update
        </Button>
      ) : view.kind === "install" ? (
        <Button size="xs" disabled={view.checking} aria-busy={view.checking} onClick={onInstall}>
          {view.checking ? "Checking…" : "Restart to update"}
        </Button>
      ) : null}
    </div>
  );
}
