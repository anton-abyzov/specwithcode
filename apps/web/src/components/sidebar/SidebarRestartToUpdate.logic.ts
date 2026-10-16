import type {
  DesktopUpdateActionResult,
  DesktopUpdateState,
  ServerPrepareServiceUpdateResult,
  ServiceUpdateBlocker,
  StudioServiceUpdateState,
} from "@specweave-studio/contracts";

import { resolveDesktopUpdateButtonAction } from "../desktopUpdate.logic";
import { groupRunningWork, summarizeRunningWork } from "./restartRunningWork.logic";

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

/** What "Update now" does, shown wherever it is offered. */
export const SERVICE_UPDATE_NOW_DESCRIPTION =
  "Stops running work, closes terminals and restarts SpecWithCode. You can continue interrupted tasks afterwards.";

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

  const parts = service
    ? [
        failure ? `The last install failed: ${failure}` : null,
        `SpecWithCode ${version ?? "update"} is downloaded.`,
        SERVICE_UPDATE_NOW_DESCRIPTION,
        app ? "The app restarts too." : null,
      ]
    : [
        failure ? `The last install failed: ${failure}` : null,
        `SpecWithCode ${version ?? "update"} is downloaded.`,
        "Restarts the app to install it.",
        "If work is still running you are asked first, and can let it finish.",
        options.installOnQuit ? "Or keep working: it installs the next time you quit." : null,
      ];

  return {
    app,
    appVersion,
    service,
    // A waiting service update installs now, without waiting for work to finish.
    label: service ? "Update now" : installFailed ? "Retry update" : "Restart to update",
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
      return result.state.status === "downloading"
        ? `SpecWithCode is still downloading ${result.state.availableVersion ?? "the update"}${result.state.downloadPercent === null ? "" : ` (${Math.round(result.state.downloadPercent)}%)`}. Restart to update once it finishes.`
        : result.state.status === "checking"
          ? "SpecWithCode is still checking for updates. Restart to update once the check finishes."
          : "The updater stayed busy for 2 minutes. It frees itself within 30 minutes; quit and reopen SpecWithCode to install sooner.";
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
  /**
   * When this attempt was requested (ms). An agent state written before it is
   * an answer to an earlier request, and an old failure is ignored for a while.
   */
  readonly requestedAt?: number;
  /** When the agent first reported installing (ms). */
  readonly installingSince?: number;
  /** Receipt already present before this window started following the install. */
  readonly previousInstallAt?: string | null;
}

/**
 * How long an attempt ignores the failure the agent reported before it was
 * requested, when the agent's write time is unknown (older desktops).
 */
export const STALE_FAILURE_MS = 90_000;
/** An install that has not finished in this long is reported, so it can be retried. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Identifies an agent state that answers a request (waiting, failed or another
 * version), so an old one is not taken as the answer to a new request.
 */
export function serviceFailureKey(state: StudioServiceUpdateState | null): string | null {
  if (state === null) return null;
  if (
    state.status !== "error" &&
    state.status !== "manual-required" &&
    state.status !== "installed" &&
    state.status !== "waiting-for-quiet"
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

function updatedAtMs(state: StudioServiceUpdateState): number | null {
  if (typeof state.updatedAt !== "string") return null;
  const at = Date.parse(state.updatedAt);
  return Number.isFinite(at) ? at : null;
}

/**
 * The agent rewrites its state only when it runs, and the state read straight
 * after a request is usually the one it wrote for an earlier request. With the
 * agent's write time that is exact: a waiting or failed state written before
 * this request is not its answer, however long the agent takes (its first
 * snapshot can outlast any fixed wait). Without it (older desktops) the state
 * is compared with the one seen before the request, and believed after
 * STALE_FAILURE_MS, since the agent may simply have answered the same again.
 */
export function isStaleServiceAnswer(
  progress: ServiceUpdateProgress,
  state: StudioServiceUpdateState,
  now?: number,
): boolean {
  const key = serviceFailureKey(state);
  if (key === null || progress.requestedAt === undefined) return false;
  const written = updatedAtMs(state);
  const stale =
    written !== null ? written < progress.requestedAt : key === (progress.staleFailure ?? null);
  if (!stale) return false;
  // A state known to be old (waiting or failed) never ends the attempt: the
  // agent has not run for this request yet, so it stays ignored.
  if (written !== null) return true;
  const waited = now === undefined ? 0 : now - progress.requestedAt;
  return waited < STALE_FAILURE_MS;
}

export function startServiceUpdateProgress(
  serviceState: StudioServiceUpdateState | null,
): ServiceUpdateProgress {
  return {
    phase: "stopping",
    targetVersion: serviceState ? serviceUpdateVersion(serviceState) : null,
    previousInstallAt: serviceState?.lastInstall?.at ?? null,
    blockers: [],
    message: null,
  };
}

/**
 * Where "Update now" again starts from. An install request is tied to the
 * version it names, so after a failure the retry asks for the version the agent
 * offers now: a newer release found meanwhile fails the request for the older
 * one, and its message tells the user to choose Update now again.
 */
export function retryServiceUpdateProgress(
  progress: ServiceUpdateProgress,
  agent: StudioServiceUpdateState | null,
): ServiceUpdateProgress {
  const offered =
    progress.phase === "failed" && agent !== null ? serviceUpdateVersion(agent) : null;
  return {
    ...progress,
    phase: "stopping",
    message: null,
    blockers: [],
    targetVersion: offered ?? progress.targetVersion,
  };
}

/** A later discovery error cannot undo an installation the agent verified. */
function hasCompletedRequestedInstall(
  progress: ServiceUpdateProgress,
  state: StudioServiceUpdateState,
  now?: number,
): boolean {
  const receipt = state.lastInstall;
  if (
    progress.targetVersion === null ||
    state.installedVersion !== progress.targetVersion ||
    receipt?.version !== progress.targetVersion ||
    receipt.result !== "updated"
  )
    return false;

  const installedAt = Date.parse(receipt.at);
  if (!Number.isFinite(installedAt) || (now !== undefined && installedAt > now)) return false;
  // A receipt cannot come from after the agent state that contains it.
  if (state.updatedAt != null) {
    const written = updatedAtMs(state);
    if (written === null || installedAt > written) return false;
  }
  if (progress.requestedAt !== undefined) {
    return Number.isFinite(progress.requestedAt) && installedAt >= progress.requestedAt;
  }
  // Adopted holds have no local request time: require a receipt not present
  // when we began following the update, never an unrelated historical success.
  return progress.previousInstallAt !== undefined && receipt.at !== progress.previousInstallAt;
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
  if (
    (state.status === "error" || state.status === "manual-required") &&
    hasCompletedRequestedInstall(progress, state, now)
  ) {
    return { ...progress, phase: "restarting", message: state.message };
  }
  // Still the previous attempt's answer: the agent has not run for this one yet.
  if (isStaleServiceAnswer(progress, state, now)) return progress;
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

/**
 * The button can be clicked again: "Update now" stops what still runs and asks
 * again while the agent is asked or waits, and a failed attempt can be retried.
 */
export function canRetryServiceUpdate(progress: ServiceUpdateProgress): boolean {
  return (
    progress.phase === "requesting" || progress.phase === "waiting" || progress.phase === "failed"
  );
}

export function serviceUpdateButtonLabel(progress: ServiceUpdateProgress): string {
  switch (progress.phase) {
    case "stopping":
      return "Stopping tasks…";
    case "requesting":
    case "waiting":
      return "Update now";
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

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function blockerCount(
  blockers: ReadonlyArray<ServiceUpdateBlocker>,
  kinds: ReadonlyArray<ServiceUpdateBlocker["kind"]>,
): number {
  return blockers.reduce(
    (total, blocker) => (kinds.includes(blocker.kind) ? total + blocker.count : total),
    0,
  );
}

/**
 * The question asked before "Update now" stops work, one line per kind of
 * work it ends. Null when nothing runs, so the update starts without asking.
 */
export function describeServiceUpdateStop(
  check: Pick<ServerPrepareServiceUpdateResult, "blockers" | "openTerminals">,
): string | null {
  // A project that continues threads after restarts gets its work back on its own.
  const continuing = check.blockers.filter((blocker) => blocker.continuesAfterRestart === true);
  const stopping = check.blockers.filter((blocker) => blocker.continuesAfterRestart !== true);
  const tasks = blockerCount(stopping, ["run"]);
  const queued = blockerCount(stopping, ["queued"]);
  const continuedTasks = blockerCount(continuing, ["run"]);
  const requeued = blockerCount(continuing, ["queued"]);
  const questions = blockerCount(check.blockers, ["request"]);
  const steps = blockerCount(check.blockers, ["effect", "session"]);
  const terminals = check.openTerminals ?? 0;
  const lines = [
    tasks > 0
      ? `${plural(tasks, "task", "tasks")} will be interrupted. You can continue ${tasks === 1 ? "it" : "them"} after the update.`
      : null,
    continuedTasks > 0
      ? `${plural(continuedTasks, "task", "tasks")} will be interrupted and continue after the update.`
      : null,
    queued > 0 ? `${plural(queued, "queued message", "queued messages")} will be cancelled.` : null,
    requeued > 0
      ? `${plural(requeued, "queued message", "queued messages")} will wait and send after the update.`
      : null,
    questions > 0
      ? `${plural(questions, "open question or approval", "open questions or approvals")} will be closed.`
      : null,
    terminals > 0 ? `${plural(terminals, "terminal", "terminals")} will close.` : null,
    steps > 0 ? `${plural(steps, "agent step", "agent steps")} will be stopped.` : null,
  ].filter((line): line is string => line !== null);
  if (lines.length === 0) return null;
  return ["Stop running work and update now?", ...lines].join("\n");
}

/**
 * The warning shown before an app restart installs an update while work still
 * runs: how much runs, where, and that it will be cut off. Null when nothing
 * runs, so the restart goes ahead without asking.
 */
export function describeAppRestartWarning(
  check: Pick<ServerPrepareServiceUpdateResult, "blockers">,
  options: {
    readonly version?: string | null;
    /** The dialog lists the work itself, so the text only summarizes it. */
    readonly listed?: boolean;
  } = {},
): string | null {
  const groups = groupRunningWork(check.blockers);
  if (groups.length === 0) return null;
  const version = options.version ? ` SpecWithCode ${options.version}` : " the update";
  return [
    `Restart to install${version}?`,
    `${summarizeRunningWork(groups)}. ${
      check.blockers.every((blocker) => blocker.continuesAfterRestart === true)
        ? "Restarting interrupts this work; it continues after the restart."
        : "Restarting interrupts this work."
    }`,
    options.listed ? null : describeServiceUpdateBlockers(check.blockers),
    options.listed ? null : RESTART_WHEN_IDLE_NOTE,
  ]
    .filter((line): line is string => line !== null && line !== "")
    .join("\n");
}

/** Under the restart warning: what "Restart when idle" does. */
export const RESTART_WHEN_IDLE_NOTE =
  "Restart when idle lets it finish first: SpecWithCode restarts once nothing runs, or after the wait set in Settings, and the stopped work continues after the restart.";

/** What the restart warning asks when the service cannot say what runs. */
export const APP_RESTART_UNKNOWN =
  "Restart to install the update now?\nSpecWithCode could not check for running work. Any running task is interrupted.";

export interface ServiceUpdateToastView {
  readonly type: "loading" | "warning" | "success" | "error";
  readonly title: string;
  readonly description: string;
  /** Stop what still runs and install now (asked or waiting), or try again (failed). */
  readonly action: "update-now" | "retry" | null;
  /** Offer to withdraw the install request and let work start again. */
  readonly cancel: boolean;
}

/**
 * The persistent toast for a service update. While the agent is asked or
 * waits it always offers "Update now" and "Cancel update"; `waitedLong` (the
 * wait outlasted a normal stop) only turns it into a warning.
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
        cancel: false,
      };
    case "requesting":
    case "waiting": {
      const blockers = describeServiceUpdateBlockers(progress.blockers);
      const fallback =
        progress.phase === "requesting"
          ? "Asking the update agent to install it…"
          : "Waiting for the last work to finish…";
      return {
        type: waitedLong ? "warning" : "loading",
        title: waitedLong ? `Waiting to install ${version}` : `Preparing to install ${version}`,
        description: blockers || progress.message || fallback,
        action: "update-now",
        cancel: true,
      };
    }
    case "installing":
      return {
        type: "loading",
        title: `Installing ${version}`,
        description: "The service restarts on its own; this window reconnects when it is back.",
        action: null,
        cancel: false,
      };
    case "restarting":
      return {
        type: "success",
        title: `Updated to ${version}`,
        description: progress.message
          ? `Installed successfully. The updater also reported: ${progress.message} Reloading this window…`
          : "Reloading this window…",
        action: null,
        cancel: false,
      };
    case "failed":
      return {
        type: "error",
        title: `Could not install ${version}`,
        description: progress.message ?? "See Settings > About for the update receipt.",
        action: "retry",
        cancel: false,
      };
  }
}
