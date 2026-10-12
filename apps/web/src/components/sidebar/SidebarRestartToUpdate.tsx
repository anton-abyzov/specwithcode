import type {
  ServerPrepareServiceUpdateResult,
  StudioServiceUpdateState,
} from "@specweave-studio/contracts";
import { RotateCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useStudioServiceUpdateState } from "../../state/serviceUpdate";
import { useAtomCommand } from "../../state/use-atom-command";
import { showDesktopUpdateDownloadedToast } from "../desktopUpdate.toast";
import { Spinner } from "../ui/spinner";
import { hiddenToastActionProps, stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  advanceServiceUpdateProgress,
  canRetryServiceUpdate,
  describeInstallOutcome,
  getRestartToUpdateView,
  serviceUpdateButtonLabel,
  serviceFailureKey,
  serviceUpdateToast,
  type ServiceUpdateProgress,
  startServiceUpdateProgress,
} from "./SidebarRestartToUpdate.logic";

// An accepted install quits the app; if it is still open after this long,
// say so instead of spinning forever.
const RESTART_WATCHDOG_MS = 60_000;

// While a service update runs, read the update agent's state this often.
const SERVICE_POLL_MS = 2_000;
// Re-check what still runs this often while the install waits for it.
const BLOCKER_CHECK_MS = 10_000;
// Ask the agent again at most this often once nothing runs any more.
const REQUEST_AGAIN_MS = 30_000;
// After this long waiting, the toast names what is left and offers to stop it.
const WAIT_NOTICE_MS = 20_000;
// Reload into the new version this long after the service reports it installed.
const RELOAD_DELAY_MS = 1_500;

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

type PrepareServiceUpdate = (stopWork: boolean) => Promise<ServerPrepareServiceUpdateResult | null>;

/**
 * The service half of "Restart to update": stops this host's work through the
 * server, asks the update agent to install, then follows the agent until the
 * service is back on the new version, naming whatever it still waits for.
 */
function useServiceUpdateProgress(prepare: PrepareServiceUpdate) {
  const [progress, setProgress] = useState<ServiceUpdateProgress | null>(null);
  const [waitedLong, setWaitedLong] = useState(false);
  const toastId = useRef<string | null>(null);
  const lastRequest = useRef(0);
  const lastBlockerCheck = useRef(0);
  const waitingSince = useRef<number | null>(null);
  const progressRef = useRef<ServiceUpdateProgress | null>(null);
  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  const request = useCallback(async (): Promise<StudioServiceUpdateState | null> => {
    const bridge = window.desktopBridge;
    if (!bridge?.installServiceUpdate) return null;
    lastRequest.current = Date.now();
    return bridge.installServiceUpdate();
  }, []);

  /** Stop what runs (or only look), then ask the agent to install. */
  const run = useCallback(
    async (start: ServiceUpdateProgress) => {
      setProgress(start);
      setWaitedLong(false);
      waitingSince.current = null;
      const prepared = await prepare(true);
      lastBlockerCheck.current = Date.now();
      const blockers = prepared?.blockers ?? [];
      // A failure the agent reported before this attempt is not its answer.
      const before = await window.desktopBridge?.getServiceUpdateState?.().catch(() => null);
      const staleFailure = serviceFailureKey(before ?? null);
      const requestedAt = Date.now();
      setProgress((current) =>
        current
          ? { ...current, phase: "requesting", blockers, staleFailure, requestedAt }
          : current,
      );
      try {
        const next = await request();
        setProgress((current) =>
          current ? advanceServiceUpdateProgress(current, next, Date.now()) : current,
        );
        return next;
      } catch (error) {
        setProgress((current) =>
          current
            ? {
                ...current,
                phase: "failed",
                message: errorText(error, "The update agent did not answer."),
              }
            : current,
        );
        return null;
      }
    },
    [prepare, request],
  );

  // Follow the agent while the update is under way.
  const phase = progress?.phase ?? null;
  const active =
    phase === "requesting" ||
    phase === "waiting" ||
    phase === "installing" ||
    phase === "restarting";
  useEffect(() => {
    if (!active) return;
    const bridge = window.desktopBridge;
    if (!bridge?.getServiceUpdateState) return;
    let cancelled = false;
    let busy = false;
    const tick = async () => {
      if (busy || cancelled) return;
      busy = true;
      try {
        const state = await bridge.getServiceUpdateState!().catch(() => null);
        if (cancelled) return;
        const previous = progressRef.current;
        const current = previous ? advanceServiceUpdateProgress(previous, state, Date.now()) : null;
        if (current !== previous) {
          progressRef.current = current;
          setProgress(current);
        }
        const waiting =
          current !== null && (current.phase === "waiting" || current.phase === "requesting");
        if (!waiting) {
          waitingSince.current = null;
          return;
        }
        const now = Date.now();
        waitingSince.current ??= now;
        if (now - waitingSince.current >= WAIT_NOTICE_MS) setWaitedLong(true);
        if (now - lastBlockerCheck.current < BLOCKER_CHECK_MS) return;
        lastBlockerCheck.current = now;
        const checked = await prepare(false);
        if (cancelled || checked === null) return;
        setProgress((latest) => (latest ? { ...latest, blockers: checked.blockers } : latest));
        const latest = progressRef.current;
        if (latest === null || (latest.phase !== "waiting" && latest.phase !== "requesting"))
          return;
        // Nothing runs any more: ask again instead of waiting for the agent's next pass.
        if (checked.idle && now - lastRequest.current >= REQUEST_AGAIN_MS) {
          await request().catch(() => null);
        }
      } finally {
        busy = false;
      }
    };
    const timer = window.setInterval(() => void tick(), SERVICE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, prepare, request]);

  // Reload into the new version once the service is back on it.
  useEffect(() => {
    if (phase !== "restarting") return;
    const timer = window.setTimeout(() => window.location?.reload?.(), RELOAD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const retry = useCallback(() => {
    const current = progressRef.current;
    if (!current || !canRetryServiceUpdate(current)) return;
    void run({ ...current, phase: "stopping", message: null });
  }, [run]);

  const dismiss = useCallback(() => {
    toastId.current = null;
    setProgress((current) => (current && canRetryServiceUpdate(current) ? null : current));
  }, []);

  // One persistent toast follows the update from the click to the reload.
  useEffect(() => {
    if (!progress) {
      if (toastId.current !== null) toastManager.close(toastId.current);
      toastId.current = null;
      return;
    }
    const view = serviceUpdateToast(progress, waitedLong);
    const options = stackedThreadToast({
      type: view.type,
      title: view.title,
      description: view.description,
      timeout: 0,
      priority: view.type === "error" || view.type === "warning" ? "high" : "low",
      actionProps:
        view.action === null
          ? hiddenToastActionProps
          : {
              children: view.action === "stop" ? "Stop them and update" : "Try again",
              onClick: retry,
            },
      data: { hideCopyButton: view.type !== "error", onClose: dismiss },
    });
    if (toastId.current === null) toastId.current = toastManager.add(options);
    else toastManager.update(toastId.current, options);
  }, [dismiss, progress, retry, waitedLong]);

  useEffect(
    () => () => {
      if (toastId.current !== null) toastManager.close(toastId.current);
    },
    [],
  );

  return { progress, run, retry };
}

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
  const environmentId = usePrimaryEnvironmentId();
  const prepareCommand = useAtomCommand(serverEnvironment.prepareServiceUpdate, {
    reportFailure: false,
    reportDefect: false,
  });
  const prepare = useCallback<PrepareServiceUpdate>(
    async (stopWork) => {
      if (environmentId === null) return null;
      // An older service without this call, or one already restarting, still installs:
      // the update agent checks for itself before it does.
      const result = await prepareCommand({ environmentId, input: { stopWork } }).catch(() => null);
      return result?._tag === "Success" ? result.value : null;
    },
    [environmentId, prepareCommand],
  );
  const service = useServiceUpdateProgress(prepare);
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
      service.retry();
      return;
    }
    if (!bridge || !view || pending || service.progress) return;
    setPending(true);
    let restarting = false;
    try {
      if (view.service && bridge.installServiceUpdate) {
        // A service that cannot start its install must not keep the app on the old version.
        await service.run(startServiceUpdateProgress(serviceState));
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
  const busy = pending || (progress !== null && !canRetryServiceUpdate(progress));
  const text =
    progress && !(pending && view?.app)
      ? serviceUpdateButtonLabel(progress)
      : pending
        ? "Restarting…"
        : (view?.label ?? "Restart to update");
  const description = view?.description ?? "Installing the SpecWithCode service update.";

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
