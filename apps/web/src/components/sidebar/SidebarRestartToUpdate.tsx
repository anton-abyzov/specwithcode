import { useNavigate } from "@tanstack/react-router";
import type { ServiceUpdateBlocker } from "@specweave-studio/contracts";
import { RotateCwIcon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { respondToConfirmDialog } from "../../confirmDialog";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { useStudioServiceUpdateState } from "../../state/serviceUpdate";
import {
  confirmAppRestartForUpdate,
  drainWorkForAppRestart,
  isServiceWorkRunning,
  releaseAppRestartDrain,
  retryServiceUpdate,
  startServiceUpdateNow,
  useServiceUpdateFlow,
} from "../serviceUpdateFlow";
import { getDesktopUpdateReleaseUrl } from "../desktopUpdate.logic";
import { openDesktopUpdateReleaseNotes } from "../desktopUpdate.toast";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ensureLatestAppUpdate,
  installWhenUpdaterFree,
  type LatestUpdateProgress,
} from "./latestAppUpdate";
import {
  appOwnsLocalService,
  DEFAULT_FORCE_INSTALL_AFTER_MINUTES,
  describeHoldCountdown,
  forceInstallAfterLabel,
  forceInstallAfterMinutes,
  holdWindowElapsed,
} from "./restartHoldWindow";
import { RestartRunningWorkList } from "./RestartRunningWorkList";
import { onRestartToUpdateRequest } from "./restartToUpdateRequests";
import {
  canRetryServiceUpdate,
  describeInstallOutcome,
  getRestartToUpdateView,
  RESTART_WHEN_IDLE_NOTE,
  SERVICE_UPDATE_NOW_DESCRIPTION,
  serviceUpdateButtonLabel,
} from "./SidebarRestartToUpdate.logic";

// An accepted install quits the app; if it is still open after this long,
// say so instead of spinning forever.
const RESTART_WATCHDOG_MS = 60_000;
// While an update waits for running work to finish, check this often.
const IDLE_CHECK_MS = 15_000;

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
  // The user chose to let running work finish: restart once nothing runs, or
  // once the hold window from Settings has passed, whichever comes first.
  const [idleSince, setIdleSince] = useState<number | null>(null);
  const [holdMinutes, setHoldMinutes] = useState(DEFAULT_FORCE_INSTALL_AFTER_MINUTES);
  const [now, setNow] = useState(() => Date.now());
  const [checkingWork, setCheckingWork] = useState(false);
  // Fetching the newest release before the restart, so no version is installed twice.
  const [fetching, setFetching] = useState<LatestUpdateProgress | null>(null);
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const watchdog = useRef<number | null>(null);
  const view = getRestartToUpdateView(appState, serviceState, { installOnQuit });

  useEffect(() => {
    let active = true;
    void window.desktopBridge
      ?.getUpdatePreferences?.()
      .then((preferences) => {
        if (active) {
          const allowed = preferences.automaticUpdatesAllowed !== false;
          setInstallOnQuit(preferences.installAutomatically && allowed);
          setDownloadsInBackground(preferences.downloadAutomatically && allowed);
          setHoldMinutes(forceInstallAfterMinutes(preferences));
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(
    () => () => {
      if (watchdog.current !== null) window.clearTimeout(watchdog.current);
    },
    [],
  );

  // The dialog's list: a thread row opens that thread and closes the dialog.
  const renderRunningWork = useCallback(
    (blockers: ReadonlyArray<ServiceUpdateBlocker>) => (
      <div className="space-y-3">
        <RestartRunningWorkList
          blockers={blockers}
          onOpenThread={
            environmentId === null
              ? undefined
              : (threadId) => {
                  respondToConfirmDialog("cancel");
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId },
                  });
                }
          }
        />
        <p className="text-xs text-muted-foreground">{RESTART_WHEN_IDLE_NOTE}</p>
      </div>
    ),
    [environmentId, navigate],
  );

  const restart = useCallback(
    async (options: { readonly confirmed?: boolean } = {}) => {
      const bridge = window.desktopBridge;
      if (service.progress && canRetryServiceUpdate(service.progress)) {
        void retryServiceUpdate();
        return;
      }
      if (
        !bridge ||
        !view ||
        pending ||
        checkingWork ||
        fetching ||
        service.progress ||
        service.starting
      )
        return;
      // Install the newest release, never one a newer release has replaced:
      // ask the feed again and fetch what it offers before anything restarts.
      let appVersion = view.appVersion;
      if (view.app) {
        const latest = await ensureLatestAppUpdate(bridge, setFetching).finally(() =>
          setFetching(null),
        );
        if (latest.kind === "failed") {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not get the newest update",
              description: latest.message,
            }),
          );
          return;
        }
        appVersion = latest.version;
      }
      // A service update asks for itself before it stops work; an app restart
      // alone asks here, so running jobs are never cut off without a warning.
      if (view.app && !view.service && !options.confirmed) {
        setCheckingWork(true);
        const choice = await confirmAppRestartForUpdate({
          version: appVersion,
          renderDetails: renderRunningWork,
        })
          .catch(() => "cancel" as const)
          .finally(() => setCheckingWork(false));
        if (choice !== "now") {
          setIdleSince(choice === "idle" ? Date.now() : null);
          return;
        }
      }
      setIdleSince(null);
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
          // A service this app started quits with it. Stopped here for the
          // update, its running work continues after the restart; killed by
          // the quit, it would end as cancelled. A service the app attached to
          // keeps running, so it is never drained or held for the restart.
          const drained =
            !view.service &&
            (await appOwnsLocalService(bridge)) &&
            (await drainWorkForAppRestart());
          // A background check or download can hold the updater for a moment:
          // wait for it, showing what runs, instead of failing with "busy".
          const result = await installWhenUpdaterFree(bridge, appVersion, setFetching).finally(() =>
            setFetching(null),
          );
          restarting = result.accepted && !result.failed;
          if (drained && !restarting) void releaseAppRestartDrain();
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
                title: "SpecWithCode did not restart",
                description: "Quit and reopen SpecWithCode to finish the update.",
              }),
            );
          }, RESTART_WATCHDOG_MS);
        } else {
          setPending(false);
        }
      }
    },
    [
      checkingWork,
      downloadsInBackground,
      fetching,
      pending,
      renderRunningWork,
      service,
      serviceState,
      view,
    ],
  );

  // The sidebar update button installs a downloaded update through this flow.
  useEffect(() => onRestartToUpdateRequest(() => void restart()), [restart]);

  // Restart on its own once the work the user let finish is done, or once the
  // hold window has passed: then the work is stopped for the update and
  // continues after the restart, so an install never waits forever.
  useEffect(() => {
    if (idleSince === null || !view?.app) return;
    let active = true;
    const check = () => {
      if (holdWindowElapsed(idleSince, Date.now(), holdMinutes)) {
        void restart({ confirmed: true });
        return;
      }
      void isServiceWorkRunning().then((running) => {
        if (active && running === false) void restart({ confirmed: true });
      });
    };
    const timer = window.setInterval(check, IDLE_CHECK_MS);
    const deadline = window.setTimeout(
      check,
      Math.max(0, idleSince + holdMinutes * 60_000 - Date.now()),
    );
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.clearInterval(tick);
      window.clearTimeout(deadline);
    };
  }, [holdMinutes, idleSince, restart, view?.app]);

  const progress = service.progress;
  // The button stays while a service update is under way, even once the agent no
  // longer lists it as waiting, so the click is never answered by nothing.
  // While the newest release downloads the old one is gone, but the click is still being answered.
  if (!view && !progress && !fetching) return null;
  const busy =
    pending ||
    checkingWork ||
    fetching !== null ||
    service.starting ||
    (progress !== null && !canRetryServiceUpdate(progress));
  const text =
    progress && !(pending && view?.app)
      ? serviceUpdateButtonLabel(progress)
      : service.starting || (pending && view?.service && !view.app)
        ? (view?.label ?? "Update now")
        : fetching?.phase === "checking"
          ? "Checking for a newer version…"
          : fetching?.phase === "downloading"
            ? `Downloading ${fetching.version}${fetching.percent === null ? "…" : ` ${Math.round(fetching.percent)}%`}`
            : fetching?.phase === "waiting"
              ? `Finishing update step${fetching.percent === null ? "…" : ` ${Math.round(fetching.percent)}%`}`
              : checkingWork
                ? "Checking running work…"
                : pending
                  ? "Restarting…"
                  : idleSince !== null && view?.app
                    ? describeHoldCountdown(idleSince, now, holdMinutes)
                    : (view?.label ?? "Restart to update");
  const description =
    idleSince !== null && view?.app
      ? `SpecWithCode restarts to install ${view.appVersion ?? "the update"} once running work finishes, or after ${forceInstallAfterLabel(holdMinutes)}: then the work is stopped for the update and continues after the restart. Click to restart now.`
      : (view?.description ?? SERVICE_UPDATE_NOW_DESCRIPTION);

  const releaseUrl = view?.app ? getDesktopUpdateReleaseUrl(view.appVersion) : null;
  const notes = view?.app
    ? (appState?.releaseNotes.find((note) => note.version === view.appVersion) ??
      appState?.releaseNotes[0])
    : undefined;

  const button = (
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
      <TooltipPopup side="top" align="start" className="max-w-72">
        <p>{description}</p>
        {notes && notes.items.length > 0 ? (
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-muted-foreground">
            {notes.items.slice(0, 4).map((item) => (
              <li key={item}>{item}</li>
            ))}
            {notes.totalItems > 4 ? <li>and {notes.totalItems - 4} more</li> : null}
          </ul>
        ) : null}
      </TooltipPopup>
    </Tooltip>
  );
  if (!releaseUrl) return button;
  return (
    <div className="flex items-center gap-1 self-start">
      {button}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`What's new in ${view?.appVersion ?? "this update"}`}
              className="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2"
              onClick={() => void openDesktopUpdateReleaseNotes(window.desktopBridge, releaseUrl)}
            >
              <SparklesIcon aria-hidden className="size-3.5" />
            </button>
          }
        />
        <TooltipPopup side="top">What&apos;s new</TooltipPopup>
      </Tooltip>
    </div>
  );
}
