import { RotateCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { useStudioServiceUpdateState } from "../../state/serviceUpdate";
import { showDesktopUpdateDownloadedToast } from "../desktopUpdate.toast";
import {
  retryServiceUpdate,
  startServiceUpdateNow,
  useServiceUpdateFlow,
} from "../serviceUpdateFlow";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  canRetryServiceUpdate,
  describeInstallOutcome,
  getRestartToUpdateView,
  SERVICE_UPDATE_NOW_DESCRIPTION,
  serviceUpdateButtonLabel,
} from "./SidebarRestartToUpdate.logic";

// An accepted install quits the app; if it is still open after this long,
// say so instead of spinning forever.
const RESTART_WATCHDOG_MS = 60_000;

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/**
 * Bottom-left sidebar button that appears once an update has downloaded in
 * the background. One click installs it: the app restarts into the new
 * version, and a waiting Studio service update is installed now instead of
 * after the next quiet period.
 */
export function SidebarRestartToUpdate() {
  return isElectron ? <SidebarRestartToUpdateButton /> : null;
}

function SidebarRestartToUpdateButton() {
  const appState = useDesktopUpdateState();
  const serviceState = useStudioServiceUpdateState();
  const service = useServiceUpdateFlow(serviceState);
  const [pending, setPending] = useState(false);
  const [installOnQuit, setInstallOnQuit] = useState(false);
  const [downloadsInBackground, setDownloadsInBackground] = useState(false);
  const watchdog = useRef<number | null>(null);
  const view = getRestartToUpdateView(appState, serviceState, { installOnQuit });
  const readyVersion = view?.app && appState?.status === "downloaded" ? view.appVersion : null;

  useEffect(() => {
    let active = true;
    void window.desktopBridge
      ?.getUpdatePreferences?.()
      .then((preferences) => {
        if (active) {
          const allowed = preferences.automaticUpdatesAllowed !== false;
          setInstallOnQuit(preferences.installAutomatically && allowed);
          setDownloadsInBackground(preferences.downloadAutomatically && allowed);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // Point at the button once per downloaded version (the toast dedupes across
  // windows), shown in the window the user is in rather than a background one.
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !readyVersion || !appState) return;
    const show = () => showDesktopUpdateDownloadedToast(bridge, appState);
    if (document.hasFocus()) {
      show();
      return;
    }
    window.addEventListener("focus", show, { once: true });
    return () => window.removeEventListener("focus", show);
  }, [appState, readyVersion]);

  useEffect(
    () => () => {
      if (watchdog.current !== null) window.clearTimeout(watchdog.current);
    },
    [],
  );

  const restart = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (service.progress && canRetryServiceUpdate(service.progress)) {
      void retryServiceUpdate();
      return;
    }
    if (!bridge || !view || pending || service.progress || service.starting) return;
    setPending(true);
    let restarting = false;
    try {
      if (view.service && bridge.installServiceUpdate) {
        // The service is asked first: the desktop kicks the agent before it
        // answers, so the app restart that follows cannot drop the request.
        const started = await startServiceUpdateNow(serviceState);
        // The user chose to keep their work running: nothing restarts.
        if (!started) return;
      }
      if (view.app) {
        const result = await bridge.installUpdate(
          view.appVersion ? { expectedVersion: view.appVersion } : undefined,
        );
        restarting = result.accepted && !result.failed;
        const message = describeInstallOutcome(result, { downloadsInBackground });
        if (message) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: message,
            }),
          );
        }
      }
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not install update",
          description: errorText(error, "An unexpected error occurred."),
        }),
      );
    } finally {
      if (restarting) {
        // Stay on "Restarting…" while the app shuts down.
        watchdog.current = window.setTimeout(() => {
          watchdog.current = null;
          setPending(false);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Studio did not restart",
              description: "Quit and reopen SpecWithCode to finish the update.",
            }),
          );
        }, RESTART_WATCHDOG_MS);
      } else {
        setPending(false);
      }
    }
  }, [downloadsInBackground, pending, service, serviceState, view]);

  const progress = service.progress;
  // The button stays while a service update is under way, even once the agent no
  // longer lists it as waiting, so the click is never answered by nothing.
  if (!view && !progress) return null;
  const busy =
    pending || service.starting || (progress !== null && !canRetryServiceUpdate(progress));
  const text =
    progress && !(pending && view?.app)
      ? serviceUpdateButtonLabel(progress)
      : service.starting || (pending && view?.service && !view.app)
        ? (view?.label ?? "Update now")
        : pending
          ? "Restarting…"
          : (view?.label ?? "Restart to update");
  const description = view?.description ?? SERVICE_UPDATE_NOW_DESCRIPTION;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-testid="sidebar-restart-to-update"
            aria-label={`${text}. ${description}`}
            aria-busy={busy || undefined}
            disabled={busy}
            className={cn(
              "inline-flex min-h-7 shrink-0 items-center gap-1.5 self-start rounded-lg bg-primary px-2.5 py-1 text-2xs leading-4 font-medium text-primary-foreground outline-hidden ring-ring transition-colors focus-visible:ring-2",
              busy ? "cursor-progress opacity-80" : "cursor-pointer hover:bg-primary/90",
            )}
            onClick={() => void restart()}
          >
            {busy ? (
              <Spinner size="sm" className="shrink-0" />
            ) : (
              <RotateCwIcon aria-hidden className="size-3.5 shrink-0" />
            )}
            <span>{text}</span>
          </button>
        }
      />
      <TooltipPopup side="top" align="start">
        {description}
      </TooltipPopup>
    </Tooltip>
  );
}
