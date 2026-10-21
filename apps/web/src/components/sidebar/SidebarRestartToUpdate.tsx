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
} from "../serviceUpdateCalls";
import {
  canInstallAppAlone,
  endFailedServiceUpdate,
  isServiceUpdateIdle,
  registerAppInstallAfterService,
  registerAppInstallNow,
  serviceLacksRelease,
  type ServiceUpdateStart,
  type StartServiceUpdateOptions,
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
  canPressUpdateAgain,
  describeInstallOutcome,
  getRestartToUpdateView,
  RESTART_WHEN_IDLE_NOTE,
  runningAppRelease,
  SERVICE_UPDATE_NOW_DESCRIPTION,
  serviceInstallTarget,
  serviceUpdateButtonLabel,
} from "./SidebarRestartToUpdate.logic";

// An accepted install quits the app; if it is still open after this long,
// say so instead of spinning forever.
const RESTART_WATCHDOG_MS = 60_000;
// While an update waits for running work to finish, check this often.
const IDLE_CHECK_MS = 15_000;

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

interface RestartOptions {
  /** The wait for idle came due: restart without asking again. */
  readonly confirmed?: boolean;
  /**
   * Install the app's update on its own, without the service's: as asked, or
   * ("lacking") only because the service's agent lacked the release, so the
   * service updates first after all once its agent offers it.
   */
  readonly appOnly?: boolean | "lacking";
  /** The press asks for the service itself (Settings' service row): never the app alone. */
  readonly forService?: boolean;
}

/**
 * Bottom-left sidebar button that appears once an update has downloaded in
 * the background. One click installs it. When the service on this Mac updates
 * too, it goes first, now instead of after the next quiet period, and the app
 * restarts into its new version once the service runs the new one.
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
  const [idleSince, setIdleSinceState] = useState<number | null>(null);
  // The same wait as last set, ahead of the render that shows it: a timer of a
  // wait already over restarts nothing.
  const idleSinceRef = useRef<number | null>(null);
  const setIdleSince = useCallback((next: number | null) => {
    idleSinceRef.current = next;
    setIdleSinceState(next);
  }, []);
  // That wait installs the app alone, as the press that started it did.
  const idleAppOnly = useRef<boolean | "lacking">(false);
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

  // Arms the check that the app really quit after an accepted install.
  const awaitRestart = useCallback(() => {
    if (watchdog.current !== null) window.clearTimeout(watchdog.current);
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
  }, []);

  // After "Update now" for both, the service is on its new version: the app
  // installs its own update and restarts. A refusal says why and leaves the
  // app open on its current version.
  const installAppAfterService = useCallback(
    async (appVersion: string | null) => {
      const bridge = window.desktopBridge;
      if (!bridge) return false;
      setPending(true);
      let restarting = false;
      try {
        let result = await installWhenUpdaterFree(bridge, appVersion, setFetching).finally(() =>
          setFetching(null),
        );
        // A newer release replaced the download while the service updated:
        // fetch it and install that, rather than leave the app behind.
        if (!result.accepted && result.reason === "no-download") {
          const latest = await ensureLatestAppUpdate(bridge, setFetching).finally(() =>
            setFetching(null),
          );
          if (latest.kind === "ready") {
            result = await installWhenUpdaterFree(bridge, latest.version, setFetching).finally(() =>
              setFetching(null),
            );
          }
        }
        restarting = result.accepted && !result.failed;
        const message = describeInstallOutcome(result, { downloadsInBackground });
        if (message) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "The service updated, but the app did not",
              description: message,
            }),
          );
        }
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "The service updated, but the app did not",
            description: errorText(error, "An unexpected error occurred."),
          }),
        );
      } finally {
        if (restarting) awaitRestart();
        else setPending(false);
      }
      return restarting;
    },
    [awaitRestart, downloadsInBackground],
  );

  useEffect(() => registerAppInstallAfterService(installAppAfterService), [installAppAfterService]);

  const restart = useCallback(
    async (options: RestartOptions = {}) => {
      const bridge = window.desktopBridge;
      const progress = service.progress;
      // A service update is under way: a press for the app's update (here, in
      // Settings or from the header pill) adds the app's install to it.
      const thenInstallApp = view?.app ? { appVersion: view.appVersion } : null;
      // The service's agent lacks the release, so asking it again fails the
      // same way (the toast's Try again still asks it), even once that failure
      // was closed or the window reloaded.
      const lacking =
        options.appOnly === "lacking" ||
        (options.appOnly !== true && thenInstallApp !== null && serviceLacksRelease(serviceState));
      // The app's update installs on its own, without the service's: as asked
      // (a wait for idle, a press whose service already runs its version), or
      // because the agent lacks the release. Never for a press that asks for
      // the service itself.
      let appOnly = options.forService !== true && (options.appOnly === true || lacking);
      // Asks the service; a press that could not reach it says so.
      const startService = async (
        input: StartServiceUpdateOptions,
      ): Promise<ServiceUpdateStart> => {
        try {
          return await startServiceUpdateNow(serviceState, input);
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: errorText(error, "An unexpected error occurred."),
            }),
          );
          return false;
        }
      };
      // A live service update is never cut into, not even for the app alone.
      const live = progress !== null && !canPressUpdateAgain(progress, Date.now());
      if (progress !== null && !live && !appOnly) {
        // A failed or lapsed attempt: try again, keeping the app's install.
        // The service already on its version leaves only the app's install.
        if ((await startServiceUpdateNow(serviceState, { thenInstallApp })) !== "app-only") return;
        appOnly = true;
      }
      if (live) {
        if (thenInstallApp === null) return;
        // The app installs once the service runs the new version, instead of
        // any wait for idle.
        const attached = await startServiceUpdateNow(serviceState, { thenInstallApp });
        if (attached) setIdleSince(null);
        // Too late to add it: the service is on its new version and this window reloads now.
        else if (progress.phase === "restarting") {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "The service update is finishing",
              description:
                "The SpecWithCode service is on its new version and this window reloads in a moment. Choose Restart to update again after that.",
            }),
          );
        }
        return;
      }
      if (!bridge || !view || pending || checkingWork || fetching || service.starting) return;
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
      // The service version Update now installs: the newest it is behind.
      const serviceTarget = () =>
        serviceInstallTarget(
          serviceState,
          appVersion,
          runningAppRelease(appState),
          appState?.availableVersion,
        ) ?? view.serviceVersion;
      if (!appOnly && view.service && bridge.installServiceUpdate) {
        // A wait for idle that came due hands over to the service update, which
        // asks for itself; a press ends the wait once that update starts.
        if (options.confirmed) setIdleSince(null);
        // The service first, the app after: an app relaunch while the agent
        // checks the service makes its install start over. The flow installs
        // the app once the service runs the new version.
        const started = await startService({
          targetVersion: serviceTarget(),
          thenInstallApp: view.app ? { appVersion } : null,
        });
        if (started === true) setIdleSince(null);
        // The service already runs that version: only the app's install is
        // left, asked about below as any app restart is.
        if (started !== "app-only") return;
        appOnly = true;
      }
      // A service update asks for itself before it stops work; an app restart
      // alone asks here, so running jobs are never cut off without a warning.
      if (view.app && (appOnly || !view.service) && !options.confirmed) {
        setCheckingWork(true);
        const choice = await confirmAppRestartForUpdate({
          version: appVersion,
          renderDetails: renderRunningWork,
        })
          .catch(() => "cancel" as const)
          .finally(() => setCheckingWork(false));
        // Kept as it was: a wait for idle, and the failure that sends presses here.
        if (choice === "cancel") return;
        if (choice === "idle") {
          // The wait installs the app alone too, for the same reason.
          idleAppOnly.current = appOnly && lacking ? "lacking" : appOnly;
          setIdleSince(Date.now());
          // The app's install goes ahead, once idle: a failed service update is over.
          endFailedServiceUpdate();
          return;
        }
      }
      // The service's agent found the release it lacked while the question was
      // open or the app waited for idle: the service updates first after all,
      // then the app, as a press now would. Not beside an update this window
      // follows: the app restarts beside that one, as chosen. Nor once the
      // service took the release on its own: only the app's install is left.
      const handover = appOnly && lacking ? serviceTarget() : null;
      if (
        handover !== null &&
        view.app &&
        bridge.installServiceUpdate &&
        !serviceLacksRelease() &&
        isServiceUpdateIdle()
      ) {
        if (options.confirmed) setIdleSince(null);
        const started = await startService({
          targetVersion: handover,
          thenInstallApp: { appVersion },
        });
        if (started === true) setIdleSince(null);
        if (started !== "app-only") return;
      }
      // A service update went live meanwhile (in another window, or from the
      // toast's Try again): the app's install follows it instead of cutting into it.
      if (appOnly && !canInstallAppAlone()) {
        if (await startServiceUpdateNow(serviceState, { thenInstallApp: { appVersion } })) {
          setIdleSince(null);
        }
        return;
      }
      setIdleSince(null);
      setPending(true);
      let restarting = false;
      try {
        if (view.app) {
          // A service this app started quits with it. Stopped here for the
          // update, its running work continues after the restart; killed by
          // the quit, it would end as cancelled. A service the app attached to
          // keeps running, so it is never drained or held for the restart.
          const drained = (await appOwnsLocalService(bridge)) && (await drainWorkForAppRestart());
          // A background check or download can hold the updater for a moment:
          // wait for it, showing what runs, instead of failing with "busy".
          const result = await installWhenUpdaterFree(bridge, appVersion, setFetching).finally(() =>
            setFetching(null),
          );
          restarting = result.accepted && !result.failed;
          // The app restarts on its own: a failed service update is over. A
          // refused install keeps it, so the next press installs the app alone again.
          if (restarting) endFailedServiceUpdate();
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
        // Stay on "Restarting…" while the app shuts down.
        if (restarting) awaitRestart();
        else setPending(false);
      }
    },
    [
      appState,
      awaitRestart,
      checkingWork,
      downloadsInBackground,
      fetching,
      pending,
      renderRunningWork,
      service,
      serviceState,
      setIdleSince,
      view,
    ],
  );

  // The sidebar update pill and Settings install a downloaded update through
  // this flow; false when there is nothing here for it to install. Settings'
  // service row asks for the service itself; any other press while a restart
  // waits for idle restarts now for that same install, as the button does.
  useEffect(
    () =>
      onRestartToUpdateRequest((request) => {
        if (request.requireService ? !view?.service : !view) return false;
        void restart(
          request.requireService
            ? { forService: true }
            : idleSince === null
              ? {}
              : { appOnly: idleAppOnly.current },
        );
        return true;
      }),
    [idleSince, restart, view],
  );

  // A press whose service is already on its version installs only the app.
  useEffect(() => registerAppInstallNow(() => restart({ appOnly: true })), [restart]);

  // The newest restart for the wait below, whose timers outlive many renders
  // (its clock alone renders every second).
  const restartRef = useRef(restart);
  useEffect(() => {
    restartRef.current = restart;
  });

  // Restart on its own once the work the user let finish is done, or once the
  // hold window has passed: then the work is stopped for the update and
  // continues after the restart, so an install never waits forever.
  useEffect(() => {
    if (idleSince === null || !view?.app) return;
    let active = true;
    let restarting: Promise<void> | null = null;
    const restartNow = () => {
      // One restart at a time, and none once the wait is over: the deadline and
      // a check can come due together, before the end of the wait is rendered.
      if (restarting !== null || idleSinceRef.current !== idleSince) return;
      restarting = restartRef
        .current({ confirmed: true, appOnly: idleAppOnly.current })
        .finally(() => {
          restarting = null;
        });
    };
    const check = () => {
      if (holdWindowElapsed(idleSince, Date.now(), holdMinutes)) {
        restartNow();
        return;
      }
      void isServiceWorkRunning().then((running) => {
        if (active && running === false) restartNow();
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
  }, [holdMinutes, idleSince, view?.app]);

  const progress = service.progress;
  // The button stays while a service update is under way, even once the agent no
  // longer lists it as waiting, so the click is never answered by nothing.
  // While the newest release downloads the old one is gone, but the click is still being answered.
  if (!view && !progress && !fetching) return null;
  const at = Date.now();
  const busy =
    pending ||
    checkingWork ||
    fetching !== null ||
    service.starting ||
    (progress !== null && !canPressUpdateAgain(progress, at));
  // The service's agent lacks the release, so a press restarts only the app:
  // the button says so, while the toast's Try again still asks the service.
  const appView =
    view?.app && serviceLacksRelease(serviceState)
      ? getRestartToUpdateView(appState, null, { installOnQuit })
      : null;
  const shown = appView ?? view;
  const followed = appView === null ? progress : null;
  const text =
    followed && !(pending && view?.app)
      ? serviceUpdateButtonLabel(followed, at)
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
                    : (shown?.label ?? "Restart to update");
  const description =
    idleSince !== null && view?.app
      ? `SpecWithCode restarts to install ${view.appVersion ?? "the update"} once running work finishes, or after ${forceInstallAfterLabel(holdMinutes)}: then the work is stopped for the update and continues after the restart. Click to restart now.`
      : (shown?.description ?? SERVICE_UPDATE_NOW_DESCRIPTION);

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
            // While a restart waits for idle, a click restarts now for that same install.
            onClick={() => void restart(idleSince === null ? {} : { appOnly: idleAppOnly.current })}
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
