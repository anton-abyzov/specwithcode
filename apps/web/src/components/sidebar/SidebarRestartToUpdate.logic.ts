import type {
  DesktopUpdateActionResult,
  DesktopUpdateState,
  ServiceUpdateBlocker,
  StudioServiceUpdateState,
} from "@specweave-studio/contracts";

import { resolveDesktopUpdateButtonAction } from "../desktopUpdate.logic";

export interface RestartToUpdateView {
  /** The app has a downloaded update that a restart installs. */
  readonly app: boolean;
  /** Downloaded app version the click installs; null when only the service updates. */
  readonly appVersion: string | null;
  /** The Studio service has a downloaded update waiting to be installed. */
  readonly service: boolean;
  readonly label: string;
  readonly description: string;
}

export interface RestartToUpdateOptions {
  /** Service version this window already asked the agent to install. */
  readonly serviceRequestedVersion?: string | null;
  /** The app also installs a downloaded update when it quits. */
  readonly installOnQuit?: boolean;
}

/**
 * The app has a downloaded update. A background check keeps the download
 * (status "checking"), so the button stays put instead of blinking out every
 * hour; an install requested then waits for the check to finish.
 */
export function isAppUpdateReady(state: DesktopUpdateState | null): boolean {
  if (state === null || state.downloadedVersion === null) return false;
  return state.status === "checking" || resolveDesktopUpdateButtonAction(state) === "install";
}

/** The service update agent has the release on disk and only waits to install it. */
export function isServiceUpdateReady(state: StudioServiceUpdateState | null): boolean {
  return state?.status === "downloaded" || state?.status === "waiting-for-quiet";
}

function serviceUpdateVersion(state: StudioServiceUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

/**
 * Updates download in the background; once one is on disk the sidebar shows a
 * single "Restart to update" button. Returns null while nothing is ready.
 */
export function getRestartToUpdateView(
  appState: DesktopUpdateState | null,
  serviceState: StudioServiceUpdateState | null,
  options: RestartToUpdateOptions = {},
): RestartToUpdateView | null {
  const serviceRequestedVersion = options.serviceRequestedVersion ?? null;
  const app = appState !== null && isAppUpdateReady(appState);
  // The agent reports "installing" a moment after the request; until then the
  // service half is already handled and must not be offered again.
  const service =
    serviceState !== null &&
    isServiceUpdateReady(serviceState) &&
    (serviceRequestedVersion === null ||
      serviceUpdateVersion(serviceState) !== serviceRequestedVersion);
  if (!app && !service) return null;

  const appVersion = app ? appState.downloadedVersion : null;
  const serviceVersion = service ? serviceUpdateVersion(serviceState) : null;
  const version = appVersion ?? serviceVersion;
  const installFailed = app && appState.errorContext === "install";
  const failure = installFailed ? appState.message?.trim() : undefined;

  const parts = [
    failure ? `The last install failed: ${failure}` : null,
    `SpecWithCode ${version ?? "update"} is downloaded.`,
    app
      ? service
        ? "Restarts the app and the SpecWithCode service to install it."
        : "Restarts the app to install it."
      : "Restarts the SpecWithCode service to install it.",
    service
      ? "Running tasks are stopped and queued messages cancelled first."
      : "Any running task is interrupted.",
    app && options.installOnQuit ? "Or keep working: it installs the next time you quit." : null,
  ];

  return {
    app,
    appVersion,
    service,
    label: installFailed ? "Retry update" : "Restart to update",
    description: parts.filter(Boolean).join(" "),
  };
}

/**
 * What to tell the user after an app install request returns. Null means say
 * nothing: an accepted install is quitting the app right now.
 */
export function describeInstallOutcome(
  result: Pick<DesktopUpdateActionResult, "accepted" | "failed" | "reason" | "state">,
  options: { readonly downloadsInBackground?: boolean } = {},
): string | null {
  if (result.accepted) {
    if (!result.failed) return null;
    return result.state.message?.trim() || "The update did not install. SpecWithCode stayed open.";
  }
  switch (result.reason) {
    case "quitting":
      return "SpecWithCode is already quitting to install the update. If it stays open, quit and reopen SpecWithCode.";
    case "no-download":
      return result.state.status === "downloading" || options.downloadsInBackground
        ? "A newer release replaced this download. SpecWithCode is fetching it now."
        : "A newer release replaced this download. Download it from Settings > About.";
    case "disabled":
      return "Updates are off in this build.";
    default:
      return "Another update step is still running. Try again in a moment.";
  }
}

// ---------------------------------------------------------------------------
// Service update progress, from the click to the restarted service.
// ---------------------------------------------------------------------------

/**
 * Where a requested service update is: stopping this host's work, asking the
 * update agent, waiting for what is still running, installing, restarting into
 * the new version (done), or failed.
 */
export type ServiceUpdatePhase =
  | "stopping"
  | "requesting"
  | "waiting"
  | "installing"
  | "restarting"
  | "failed";

export interface ServiceUpdateProgress {
  readonly phase: ServiceUpdatePhase;
  /** Version the click installs. */
  readonly targetVersion: string | null;
  /** What the server still reports as running, from the last check. */
  readonly blockers: ReadonlyArray<ServiceUpdateBlocker>;
  /** The update agent's own words while it waits or after it failed. */
  readonly message: string | null;
  /**
   * The failure the agent still reported when this attempt was requested. The
   * agent rewrites its state only when it runs, so until then that old failure
   * is not this attempt's answer.
   */
  readonly staleFailure?: string | null;
  /** When this attempt was requested (ms), to stop ignoring an old failure eventually. */
  readonly requestedAt?: number;
  /** When the agent first reported installing (ms). */
  readonly installingSince?: number;
}

/** How long an attempt ignores the failure the agent reported before it was requested. */
export const STALE_FAILURE_MS = 90_000;
/** An install that has not finished in this long is reported, so it can be retried. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** Identifies a failed (or other-version) agent state, so an old one is not taken as new. */
export function serviceFailureKey(state: StudioServiceUpdateState | null): string | null {
  if (state === null) return null;
  if (
    state.status !== "error" &&
    state.status !== "manual-required" &&
    state.status !== "installed"
  ) {
    return null;
  }
  return JSON.stringify([
    state.status,
    state.message,
    state.installedVersion,
    state.lastInstall?.at ?? null,
  ]);
}

export function startServiceUpdateProgress(
  serviceState: StudioServiceUpdateState | null,
): ServiceUpdateProgress {
  return {
    phase: "stopping",
    targetVersion: serviceState ? serviceUpdateVersion(serviceState) : null,
    blockers: [],
    message: null,
  };
}

/** The progress after the update agent reports `state`. */
export function advanceServiceUpdateProgress(
  progress: ServiceUpdateProgress,
  state: StudioServiceUpdateState | null,
  now?: number,
): ServiceUpdateProgress {
  if (state === null || progress.phase === "restarting" || progress.phase === "stopping") {
    return progress;
  }
  const target = progress.targetVersion;
  const installed = target !== null && state.installedVersion === target;
  if (installed && (state.status === "installed" || state.status === "up-to-date")) {
    return { ...progress, phase: "restarting", message: null };
  }
  const failure = serviceFailureKey(state);
  if (failure !== null && failure === (progress.staleFailure ?? null)) {
    // Still the previous attempt's answer: the agent has not run for this one yet.
    const waited =
      now !== undefined && progress.requestedAt !== undefined ? now - progress.requestedAt : 0;
    if (waited < STALE_FAILURE_MS) return progress;
  }
  switch (state.status) {
    case "installing": {
      const since = progress.installingSince ?? now;
      if (now !== undefined && since !== undefined && now - since >= INSTALL_TIMEOUT_MS) {
        return {
          ...progress,
          phase: "failed",
          message:
            "The install has not finished after 10 minutes. See Settings > About for the receipt.",
        };
      }
      return {
        ...progress,
        phase: "installing",
        message: state.message,
        ...(since === undefined ? {} : { installingSince: since }),
      };
    }
    case "up-to-date":
    case "available":
      // The agent left installing without the new version: the install was rolled back.
      return progress.phase === "installing"
        ? {
            ...progress,
            phase: "failed",
            message:
              state.message ??
              `The update was rolled back; SpecWithCode stayed on ${state.installedVersion ?? "its current version"}.`,
          }
        : progress;
    case "waiting-for-quiet":
      return { ...progress, phase: "waiting", message: state.message };
    case "error":
    case "manual-required":
      return {
        ...progress,
        phase: "failed",
        message:
          state.message ?? "The update did not install. See Settings > About for the receipt.",
      };
    case "installed":
      return {
        ...progress,
        phase: "failed",
        message: `SpecWithCode stayed on ${state.installedVersion ?? "its current version"}.`,
      };
    default:
      // The agent has not picked the request up yet; it runs within seconds.
      return progress;
  }
}

/** The button can be clicked again: to stop what still runs, or to retry. */
export function canRetryServiceUpdate(progress: ServiceUpdateProgress): boolean {
  return progress.phase === "waiting" || progress.phase === "failed";
}

export function serviceUpdateButtonLabel(progress: ServiceUpdateProgress): string {
  switch (progress.phase) {
    case "stopping":
      return "Stopping tasks…";
    case "requesting":
      return "Starting update…";
    case "waiting":
      return progress.blockers.length > 0 ? "Stop and update" : "Waiting to update…";
    case "installing":
      return "Installing…";
    case "restarting":
      return "Restarting…";
    case "failed":
      return "Retry update";
  }
}

const BLOCKER_NOUNS: Record<ServiceUpdateBlocker["kind"], readonly [string, string]> = {
  run: ["running task", "running tasks"],
  queued: ["queued message", "queued messages"],
  request: ["approval or question waiting for you", "approvals or questions waiting for you"],
  effect: ["provider step finishing", "provider steps finishing"],
  session: ["agent process still working", "agent processes still working"],
};

function blockerText(blocker: ServiceUpdateBlocker): string {
  const [one, many] = BLOCKER_NOUNS[blocker.kind];
  const what = `${blocker.count} ${blocker.count === 1 ? one : many}`;
  if (blocker.threadTitle === null) return what;
  const where = blocker.projectTitle
    ? `“${blocker.threadTitle}” (${blocker.projectTitle})`
    : `“${blocker.threadTitle}”`;
  return `${what} in ${where}`;
}

/** One line naming what still keeps the update from installing. */
export function describeServiceUpdateBlockers(
  blockers: ReadonlyArray<ServiceUpdateBlocker>,
  limit = 3,
): string {
  if (blockers.length === 0) return "";
  const shown = blockers.slice(0, limit).map(blockerText);
  const rest = blockers.length - shown.length;
  return `Still running: ${shown.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}.`;
}

export interface ServiceUpdateToastView {
  readonly type: "loading" | "warning" | "success" | "error";
  readonly title: string;
  readonly description: string;
  /** Offer to stop what still runs (waiting) or to try again (failed). */
  readonly action: "stop" | "retry" | null;
}

/**
 * The persistent toast for a service update. `waitedLong` is true once the
 * wait has outlasted the time a stop normally takes, so the toast names what
 * is left instead of a spinner that never ends.
 */
export function serviceUpdateToast(
  progress: ServiceUpdateProgress,
  waitedLong: boolean,
): ServiceUpdateToastView {
  const version = progress.targetVersion ? `SpecWithCode ${progress.targetVersion}` : "the update";
  switch (progress.phase) {
    case "stopping":
      return {
        type: "loading",
        title: `Preparing to install ${version}`,
        description: "Stopping running tasks and cancelling queued messages…",
        action: null,
      };
    case "requesting":
      return {
        type: "loading",
        title: `Preparing to install ${version}`,
        description: "Asking the update agent to install it…",
        action: null,
      };
    case "waiting": {
      const blockers = describeServiceUpdateBlockers(progress.blockers);
      if (!waitedLong) {
        return {
          type: "loading",
          title: `Preparing to install ${version}`,
          description: blockers || "Waiting for the last work to finish…",
          action: null,
        };
      }
      return {
        type: "warning",
        title: `Waiting to install ${version}`,
        description:
          blockers ||
          progress.message ||
          "Something on this computer is still working. It installs as soon as that ends.",
        action: blockers ? "stop" : "retry",
      };
    }
    case "installing":
      return {
        type: "loading",
        title: `Installing ${version}`,
        description: "The service restarts on its own; this window reconnects when it is back.",
        action: null,
      };
    case "restarting":
      return {
        type: "success",
        title: `Updated to ${version}`,
        description: "Reloading this window…",
        action: null,
      };
    case "failed":
      return {
        type: "error",
        title: `Could not install ${version}`,
        description: progress.message ?? "See Settings > About for the update receipt.",
        action: "retry",
      };
  }
}
