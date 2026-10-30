import type {
  DesktopUpdateActionResult,
  DesktopUpdateState,
  ServerPrepareServiceUpdateResult,
  ServiceUpdateBlocker,
  StudioServiceUpdateState,
} from "@specweave-studio/contracts";

import { compareSemverVersions, parseSemver } from "@specweave-studio/shared/semver";

import { resolveDesktopUpdateButtonAction } from "../desktopUpdate.logic";
import {
  countPersonRequests,
  describePersonRequests,
  nameQuestionThreads,
  personRequestBlockers,
} from "../serviceUpdateRunView";
import { groupRunningWork, summarizeRunningWork } from "./restartRunningWork.logic";

export interface RestartToUpdateView {
  /** The app has a downloaded update that a restart installs. */
  readonly app: boolean;
  /** Downloaded app version the click installs; null when only the service updates. */
  readonly appVersion: string | null;
  /**
   * The service on this Mac updates too: its agent has a release waiting, or
   * the service runs an older release than the app installs.
   */
  readonly service: boolean;
  /** Service version the click installs; null when the service does not update. */
  readonly serviceVersion: string | null;
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

/**
 * The service update agent has the release on disk and only waits to install it,
 * including while it restarts a service that lost its database locks.
 */
export function isServiceUpdateReady(state: StudioServiceUpdateState | null): boolean {
  if (state?.status !== "downloaded" && state?.status !== "waiting-for-quiet") return false;
  // The service already runs that version: there is nothing to install.
  const version = serviceUpdateVersion(state);
  return version === null || version !== state.installedVersion;
}

function serviceUpdateVersion(state: StudioServiceUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

/** `older` is a release (never a dev or nightly build) before `newer`. */
export function isOlderRelease(older: string | null | undefined, newer: string | null): boolean {
  if (!older || !newer) return false;
  const left = parseSemver(older);
  const right = parseSemver(newer);
  if (left === null || right === null || left.prerelease.length > 0) return false;
  if (right.prerelease.length > 0) return false;
  return compareSemverVersions(older, newer) < 0;
}

// The agent takes an install request in these states, downloading the release first if needed.
const SERVICE_TAKES_REQUESTS: ReadonlySet<StudioServiceUpdateState["status"]> = new Set([
  "disabled",
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "waiting-for-quiet",
  "installed",
]);

/**
 * The refusals for a service on a deleted database log or without its SQLite
 * locks, as service_handles.py words them. Agents before 1085 end them with
 * "Restart SpecWithCode, then update", which nobody can do from the app: Cmd+Q
 * leaves the background service running. Their wording since says that Update
 * now (or Try again) restarts the service and updates, which update.py
 * (database_restart_refusal) does for an explicit request.
 */
export const DETACHED_DATABASE_REFUSAL =
  "The SpecWithCode service is using a database log that was deleted from disk. Press Update now: SpecWithCode saves that log, restarts its background service and then updates";
export const LOCKS_LOST_REFUSAL =
  "The SpecWithCode service lost its SQLite locks on its database. Press Update now: SpecWithCode restarts its background service and then updates";
const LEGACY_REFUSALS: ReadonlyArray<readonly [legacy: string, current: string]> = [
  [
    "The SpecWithCode service is using a database log that was deleted from disk. Restart SpecWithCode, then update",
    DETACHED_DATABASE_REFUSAL,
  ],
  [
    "The SpecWithCode service lost its SQLite locks on its database. Restart SpecWithCode, then update",
    LOCKS_LOST_REFUSAL,
  ],
];
const REFUSAL_PREFIX = "SpecWithCode cannot be updated right now: ";

/**
 * The agent's refusals that an Update now request gets past, exactly as
 * update_agent.py (refusal_reason) writes them, in both wordings: the service
 * lost its SQLite locks or its database log, and update.py
 * (database_restart_refusal) restarts it for an explicit request, then installs.
 */
const RESTART_NEEDED_REFUSALS: ReadonlySet<string> = new Set(
  LEGACY_REFUSALS.flatMap(([legacy, current]) => [
    `${REFUSAL_PREFIX}${legacy}`,
    `${REFUSAL_PREFIX}${current}`,
  ]),
);

/**
 * The agent's message as the person reads it: an older agent's "Restart
 * SpecWithCode, then update" for these refusals becomes the current wording,
 * which offers Update now instead. Any other message is returned unchanged.
 */
export function serviceRefusalText(message: string): string {
  for (const [legacy, current] of LEGACY_REFUSALS) {
    if (message.includes(legacy)) return message.replace(legacy, current);
  }
  return message;
}

/** What the update agent says when an install request lapsed before it could start. */
export const SERVICE_REQUEST_EXPIRED =
  "The update request expired before it could start; choose Update now again.";

/**
 * The error is the desktop's own: it could not start the update agent (or
 * save the request), and the agent has written nothing since. The desktop
 * this renderer ships with flags every state; one without the flag is none.
 */
export function isAgentStartFailure(state: StudioServiceUpdateState): boolean {
  return state.agentStartFailed === true;
}

/**
 * The agent's last pass was refused for a fault that an Update now request
 * gets past (see RESTART_NEEDED_REFUSALS), or let a request lapse before it
 * could start (its message says to choose Update now again), and the agent has
 * a release newer than the service runs verified on disk: "Update now"
 * installs it, with the agent's words shown beside it. Any other failure
 * offers only a check: one a forced request cannot get past (a failed check, a
 * rejected download, which the agent does not fetch again before its next
 * check, or the desktop's own failure to start the agent), and one with
 * nothing on disk to install.
 */
export function isServiceErrorWithRelease(
  state: StudioServiceUpdateState | null,
): state is StudioServiceUpdateState & { readonly message: string } {
  const message = state?.message ?? "";
  return (
    state?.status === "error" &&
    !isAgentStartFailure(state) &&
    (RESTART_NEEDED_REFUSALS.has(message) || message === SERVICE_REQUEST_EXPIRED) &&
    isOlderRelease(state.installedVersion, state.downloadedVersion)
  );
}

/**
 * The agent refused a request for a fault only a held request gets past
 * (update.py restarts the service for one), with the release on disk.
 */
export function isRestartRefusalWithRelease(state: StudioServiceUpdateState | null): boolean {
  return isServiceErrorWithRelease(state) && RESTART_NEEDED_REFUSALS.has(state.message);
}

function takesRequests(state: StudioServiceUpdateState): boolean {
  return SERVICE_TAKES_REQUESTS.has(state.status) || isServiceErrorWithRelease(state);
}

/**
 * The service on this Mac runs an older release than the app is about to
 * install, and its agent can take a request. "Update now" then updates both,
 * the service first, whether or not the agent has its half on disk yet.
 */
export function isServiceBehindApp(
  state: StudioServiceUpdateState | null,
  appVersion: string | null,
): boolean {
  return (
    state !== null && takesRequests(state) && isOlderRelease(state.installedVersion, appVersion)
  );
}

/**
 * The release the agent found for the service, on disk or not yet, when it
 * takes a request for it. Asking for an older version would only be refused
 * as superseded, after the work was stopped.
 */
function agentRelease(state: StudioServiceUpdateState | null): string | null {
  if (state === null) return null;
  if (isServiceUpdateReady(state)) return serviceUpdateVersion(state);
  const found = serviceUpdateVersion(state);
  return takesRequests(state) && isOlderRelease(state.installedVersion, found) ? found : null;
}

/**
 * The service version "Update now" installs: the newest of the agent's own
 * release and the app's versions (the downloaded update, the version running,
 * the release the app found) that the service is behind. Null when the service
 * has nothing to install.
 */
export function serviceInstallTarget(
  state: StudioServiceUpdateState | null,
  ...appVersions: ReadonlyArray<string | null | undefined>
): string | null {
  let target = agentRelease(state);
  for (const version of appVersions) {
    if (!version || !isServiceBehindApp(state, version)) continue;
    if (target === null || isOlderRelease(target, version)) target = version;
  }
  return target;
}

/**
 * The version the app runs, when it is a released one. A dev or unpackaged
 * build reports its plain package version, which may not be published yet:
 * the service is never asked to catch up with it.
 */
export function runningAppRelease(state: DesktopUpdateState | null): string | null {
  return state?.productionBuild === true ? state.currentVersion : null;
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
  // An Update now run is going on: no window offers to update until it ends.
  if (serviceState?.run && !serviceState.run.terminal) return null;
  const serviceRequestedVersion = options.serviceRequestedVersion ?? null;
  const app = appState !== null && isAppUpdateReady(appState);
  const appVersion = app ? appState.downloadedVersion : null;
  // The app already runs a newer release than the service (it updated on its
  // own, as on quit): the service catches up with one press too.
  const running = runningAppRelease(appState);
  const ready = serviceState !== null && isServiceUpdateReady(serviceState);
  const failedWithRelease = isServiceErrorWithRelease(serviceState);
  const behind =
    isServiceBehindApp(serviceState, appVersion) || isServiceBehindApp(serviceState, running);
  // The service installs the newest of the agent's release and the app's versions.
  const candidate = serviceInstallTarget(
    serviceState,
    appVersion,
    running,
    appState?.availableVersion,
  );
  // The agent reports "installing" a moment after the request; until then the
  // service half is already handled and must not be offered again.
  const service =
    serviceState !== null &&
    (ready || behind || failedWithRelease) &&
    (serviceRequestedVersion === null || candidate !== serviceRequestedVersion);
  if (!app && !service) return null;

  const serviceVersion = service ? candidate : null;
  const version = appVersion ?? serviceVersion;
  const installFailed = app && appState.errorContext === "install";
  const failure = installFailed ? appState.message?.trim() : undefined;
  // The agent's own words for the failure Update now gets past stay beside the action.
  const serviceFailure =
    service && isServiceErrorWithRelease(serviceState)
      ? serviceRefusalText(serviceState.message).replace(/\.?$/, ".")
      : null;
  // Nothing is on disk yet when only the running app is ahead: say what runs.
  const what =
    app || ready || !serviceState?.installedVersion
      ? `SpecWithCode ${version ?? "update"} is downloaded.`
      : `The SpecWithCode service on this Mac still runs ${serviceState.installedVersion}; this installs ${version ?? "the update"}.`;

  const parts = service
    ? [
        failure ? `The last install failed: ${failure}` : null,
        serviceFailure,
        what,
        SERVICE_UPDATE_NOW_DESCRIPTION,
        app ? "The service updates first, then the app restarts on its own." : null,
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
    serviceVersion,
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
    case "service-behind":
      return `SpecWithCode ${result.state.swapGate?.targetVersion ?? result.state.downloadedVersion ?? "the update"} installs after the SpecWithCode service on this Mac updates to it. You can keep working on the current version.`;
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
  /**
   * Version the service on this Mac runs now. The app bundle updates on its
   * own, so About can already show the target while the service waits.
   */
  readonly fromVersion?: string | null;
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
  /** When the agent first reported installing in this attempt (ms). */
  readonly installingSince?: number;
  /** Receipt already present before this window started following the install. */
  readonly previousInstallAt?: string | null;
  /** When "Update now" was pressed (ms), for the elapsed time the toast shows. */
  readonly startedAt?: number;
  /**
   * End of the forced request's hold (ms). Until then the agent keeps retrying
   * on its own and the work stays stopped, so "Update now" is not offered again.
   */
  readonly holdUntil?: number;
  /**
   * The agent answered that its feed does not offer the version asked for, so
   * asking the service again fails the same way until it does.
   */
  readonly unavailable?: boolean;
  /**
   * The service restarted under this window's request, and the window stops
   * and holds its work again: the toast says so until that stop answers, or
   * a look finds the work held when it did not.
   */
  readonly serviceRestarted?: boolean;
}

/** `progress` showing, or no longer showing, that the service restarted under it. */
export function markServiceRestarted(
  progress: ServiceUpdateProgress,
  restarted: boolean,
): ServiceUpdateProgress {
  if ((progress.serviceRestarted === true) === restarted) return progress;
  if (restarted) return { ...progress, serviceRestarted: true };
  const { serviceRestarted: _restarted, ...rest } = progress;
  return rest;
}

/** A failure that asking the service again repeats: its agent lacks the release. */
export function isReleaseUnavailableFailure(progress: ServiceUpdateProgress | null): boolean {
  return progress?.phase === "failed" && progress.unavailable === true;
}

// The agent has found a release in these states, on disk or not yet.
const AGENT_HAS_RELEASE: ReadonlySet<StudioServiceUpdateState["status"]> = new Set([
  "available",
  "downloading",
  "downloaded",
  "waiting-for-quiet",
]);

/**
 * The agent offers `version`, or a newer release, for the service to install,
 * so a request for it no longer fails for want of the release.
 */
export function agentOffersRelease(
  state: StudioServiceUpdateState | null,
  version: string | null,
): boolean {
  if (state === null) return false;
  if (!AGENT_HAS_RELEASE.has(state.status) && !isServiceErrorWithRelease(state)) return false;
  const offered = serviceUpdateVersion(state);
  return offered !== null && (offered === version || isOlderRelease(version, offered));
}

/** `progress` without the mark of a release the agent lacks. */
function withoutUnavailable(progress: ServiceUpdateProgress): ServiceUpdateProgress {
  if (progress.unavailable === undefined) return progress;
  const { unavailable: _unavailable, ...rest } = progress;
  return rest;
}

/** The state names `version`, or a newer release, as found or fetched. */
function namesRelease(state: StudioServiceUpdateState, version: string): boolean {
  return [state.downloadedVersion, state.availableVersion].some(
    (found) => typeof found === "string" && (found === version || isOlderRelease(version, found)),
  );
}

/**
 * How long an attempt ignores the failure the agent reported before it was
 * requested, when the agent's write time is unknown (older desktops).
 */
export const STALE_FAILURE_MS = 90_000;
/**
 * An install that has not finished in this long is reported, so it can be
 * retried: the update agent gives its install helper 40 minutes (APPLY_TIMEOUT
 * in update_agent.py), so a slow but healthy install is never reported early.
 */
export const INSTALL_TIMEOUT_MS = 45 * 60_000;

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
 * snapshot can outlast any fixed wait), nor is one the agent wrote in the
 * request's own millisecond. The desktop's own failure carries the request's
 * time, though, and older desktops do not flag it as theirs: only a state
 * flagged as the agent's is held to that. Without the write time (older
 * desktops) the state is compared with the one seen before the request, and
 * believed after STALE_FAILURE_MS, since the agent may simply have answered
 * the same again.
 */
export function isStaleServiceAnswer(
  progress: ServiceUpdateProgress,
  state: StudioServiceUpdateState,
  now?: number,
): boolean {
  const key = serviceFailureKey(state);
  if (key === null || progress.requestedAt === undefined) return false;
  const written = updatedAtMs(state);
  const agentsOwn = state.agentStartFailed === false;
  const stale =
    written !== null
      ? written < progress.requestedAt || (agentsOwn && written === progress.requestedAt)
      : key === (progress.staleFailure ?? null);
  if (!stale) return false;
  // A state known to be old (waiting or failed) never ends the attempt: the
  // agent has not run for this request yet, so it stays ignored.
  if (written !== null) return true;
  const waited = now === undefined ? 0 : now - progress.requestedAt;
  return waited < STALE_FAILURE_MS;
}

export function startServiceUpdateProgress(
  serviceState: StudioServiceUpdateState | null,
  targetVersion?: string | null,
): ServiceUpdateProgress {
  return {
    phase: "stopping",
    targetVersion: targetVersion ?? (serviceState ? serviceUpdateVersion(serviceState) : null),
    fromVersion: serviceState?.installedVersion ?? null,
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
    ...withoutUnavailable(progress),
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

/** The agent wrote `state` after this attempt was requested, so it answers it. */
function answersRequest(progress: ServiceUpdateProgress, state: StudioServiceUpdateState): boolean {
  const written = updatedAtMs(state);
  return written !== null && progress.requestedAt !== undefined && written >= progress.requestedAt;
}

/** The agent wrote `state` before this attempt was requested: it answers an earlier one. */
function writtenBeforeRequest(
  progress: ServiceUpdateProgress,
  state: StudioServiceUpdateState,
): boolean {
  const written = updatedAtMs(state);
  return written !== null && progress.requestedAt !== undefined && written < progress.requestedAt;
}

/**
 * The agent wrote `state` once the install was first seen, so it follows that
 * install. A state without its write time, or an older one (a reply read
 * before the install began), says nothing new.
 */
function writtenSinceInstallBegan(
  progress: ServiceUpdateProgress,
  state: StudioServiceUpdateState,
): boolean {
  const written = updatedAtMs(state);
  if (written === null) return false;
  return progress.installingSince === undefined || written >= progress.installingSince;
}

const SERVICE_STILL_BUSY: ReadonlySet<StudioServiceUpdateState["status"]> = new Set([
  "installing",
  "error",
  "manual-required",
]);

/** The progress after the update agent reports `state`. */
export function advanceServiceUpdateProgress(
  progress: ServiceUpdateProgress,
  state: StudioServiceUpdateState | null,
  now?: number,
): ServiceUpdateProgress {
  // A failed attempt stays failed: an answer already on its way when it failed
  // (a read of the agent, the reply to its request) does not take it up again.
  // Only a press asks anew.
  if (
    state === null ||
    progress.phase === "restarting" ||
    progress.phase === "stopping" ||
    progress.phase === "failed"
  ) {
    return progress;
  }
  const target = progress.targetVersion;
  const installed = target !== null && state.installedVersion === target;
  // Once the service runs the target, no state but a failure keeps it pending:
  // a late "waiting" or "downloaded" for the same version is not a new install.
  if (installed && !SERVICE_STILL_BUSY.has(state.status)) {
    return { ...progress, phase: "restarting", message: null };
  }
  if (state.installedVersion !== undefined && state.installedVersion !== progress.fromVersion) {
    progress = { ...progress, fromVersion: state.installedVersion };
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
      // Timed from when the agent wrote it, not from when this window read it:
      // a read answered late, after the agent already left the install for
      // another pass, must not hide what the agent wrote since.
      const since =
        progress.installingSince ??
        (now === undefined ? undefined : Math.min(now, updatedAtMs(state) ?? now));
      if (now !== undefined && since !== undefined && now - since >= INSTALL_TIMEOUT_MS) {
        return {
          ...progress,
          phase: "failed",
          message: `The install has not finished after ${INSTALL_TIMEOUT_MS / 60_000} minutes. See Settings > About for the receipt.`,
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
    case "disabled":
      // The agent left installing without the new version: the install was rolled back.
      if (progress.phase === "installing" && state.status !== "disabled") {
        return {
          ...progress,
          phase: "failed",
          message:
            state.message ??
            `The update was rolled back; SpecWithCode stayed on ${state.installedVersion ?? "its current version"}.`,
        };
      }
      // The agent ran for this request and found nothing to install: its feed
      // does not offer the version asked for, so waiting would never end. A
      // request still pending was not seen by that pass (it read the config
      // just before the request was written), nor was one whose release the
      // state names: the agent has it.
      if (
        state.status !== "available" &&
        answersRequest(progress, state) &&
        (state.pendingInstall ?? null) === null &&
        target !== null &&
        !namesRelease(state, target)
      ) {
        return {
          ...progress,
          phase: "failed",
          message: `SpecWithCode ${target} is not available to the service on this Mac yet.`,
          unavailable: true,
        };
      }
      return progress;
    case "downloading":
    case "downloaded": {
      // Written for an earlier request (a cancel's "Update cancelled", say):
      // not what the agent does for this one.
      if (writtenBeforeRequest(progress, state)) return progress;
      // Only a download under way gets words of its own; once it is fetched
      // the agent's own message, or none, replaces them.
      const message =
        state.status === "downloading"
          ? (state.message ?? (target !== null ? `Downloading SpecWithCode ${target}…` : null))
          : state.message;
      // The agent left the install for another pass that fetches or checks
      // again: nothing installs now, and the next install is timed on its own.
      if (progress.phase === "installing") {
        if (!writtenSinceInstallBegan(progress, state)) return progress;
        const { installingSince: _previous, ...rest } = progress;
        return { ...rest, phase: "requesting", message };
      }
      // The agent fetches the release for this request: say so instead of a check.
      return message === progress.message ? progress : { ...progress, message };
    }
    case "waiting-for-quiet": {
      // The agent went back to waiting (it retries after new work started),
      // so the next install is timed on its own.
      const { installingSince: _previous, ...rest } = progress;
      return { ...rest, phase: "waiting", message: state.message };
    }
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

/**
 * The agent is still acting on a forced request: the work is stopped and
 * held, and the agent retries on its own until the hold ends. Pressing again
 * would only stop the work again.
 */
export function isForcedRequestLive(progress: ServiceUpdateProgress, now: number): boolean {
  return (
    (progress.phase === "requesting" || progress.phase === "waiting") &&
    progress.holdUntil !== undefined &&
    now < progress.holdUntil
  );
}

/** "Update now" (or "Retry update") does something new for this update. */
export function canPressUpdateAgain(progress: ServiceUpdateProgress, now: number): boolean {
  return canRetryServiceUpdate(progress) && !isForcedRequestLive(progress, now);
}

/** The hold time of a pending forced request, from the agent's state (ms). */
export function pendingHoldUntil(state: StudioServiceUpdateState | null): number | undefined {
  const pending = state?.pendingInstall;
  if (!pending || pending.mode !== "force" || pending.holdUntil === null) return undefined;
  const until = Date.parse(pending.holdUntil);
  return Number.isFinite(until) ? until : undefined;
}

/** Minutes and seconds, such as 4:07 (hours only past one). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

export function serviceUpdateButtonLabel(progress: ServiceUpdateProgress, now?: number): string {
  switch (progress.phase) {
    case "stopping":
      return "Stopping tasks…";
    case "requesting":
    case "waiting":
      return now !== undefined && isForcedRequestLive(progress, now) ? "Updating…" : "Update now";
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
 * The confirm line for the questions and approvals a forced update closes
 * (0991): how many of each, that they are asked again after the update, and
 * in which threads. An older service sends no split, so it keeps the old line.
 */
function describeClosedQuestions(
  blockers: ReadonlyArray<ServiceUpdateBlocker>,
  total: number,
  options: { readonly withoutSplit?: boolean } = {},
): ReadonlyArray<string> {
  const requests = blockers.filter((blocker) => blocker.kind === "request" && blocker.count > 0);
  const split = requests.every(
    (blocker) => blocker.questions !== undefined || blocker.approvals !== undefined,
  );
  if (!split) {
    if (options.withoutSplit === false) return [];
    return [
      `${plural(total, "open question or approval", "open questions or approvals")} will be closed.`,
    ];
  }
  const counts = countPersonRequests(requests);
  const what = describePersonRequests(counts);
  const lines: Array<string> = [];
  if (what !== null) {
    // Only threads with a question or approval are named: those are asked again.
    const threads = nameQuestionThreads(personRequestBlockers(requests));
    lines.push(
      `${what} will be closed and asked again after the update${threads ? `, in ${threads}` : ""}.`,
    );
  }
  // What the app itself waits on (a tool call) is closed and not asked again.
  if (counts.other > 0)
    lines.push(
      `${plural(counts.other, "other open request", "other open requests")} will be closed.`,
    );
  return lines;
}

/**
 * The question asked before "Update now" stops work, one line per kind of
 * work it ends. Null when nothing runs, so the update starts without asking.
 */
export function describeServiceUpdateStop(
  check: Pick<ServerPrepareServiceUpdateResult, "blockers" | "openTerminals" | "folderCopies">,
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
  const copies = check.folderCopies ?? 0;
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
    ...(questions > 0 ? describeClosedQuestions(check.blockers, questions) : []),
    terminals > 0 ? `${plural(terminals, "terminal", "terminals")} will close.` : null,
    steps > 0 ? `${plural(steps, "agent step", "agent steps")} will be stopped.` : null,
    // An update stops no copy, but its restart can cut one off.
    copies > 0
      ? `${plural(copies, "folder copy", "folder copies")} to or from another machine ${copies === 1 ? "is" : "are"} in progress and may need Retry after the update.`
      : null,
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
  check: Pick<ServerPrepareServiceUpdateResult, "blockers" | "folderCopies">,
  options: {
    readonly version?: string | null;
    /** The dialog lists the work itself, so the text only summarizes it. */
    readonly listed?: boolean;
  } = {},
): string | null {
  const groups = groupRunningWork(check.blockers);
  // The app restart takes its bundled service down, and a folder copy it serves or pulls with it.
  const copies = check.folderCopies ?? 0;
  if (groups.length === 0 && copies === 0) return null;
  const version = options.version ? ` SpecWithCode ${options.version}` : " the update";
  // Restarting now drains the service as Update now does (0991): the questions
  // and approvals it closes are named, and said to be asked again. An older
  // service that does not split them adds no line.
  const questions = blockerCount(check.blockers, ["request"]);
  return [
    `Restart to install${version}?`,
    groups.length === 0
      ? null
      : `${summarizeRunningWork(groups)}. ${
          check.blockers.every((blocker) => blocker.continuesAfterRestart === true)
            ? "Restarting interrupts this work; it continues after the restart."
            : "Restarting interrupts this work."
        }`,
    copies > 0
      ? `${plural(copies, "folder copy", "folder copies")} to or from another machine ${copies === 1 ? "is" : "are"} in progress. Restarting cuts ${copies === 1 ? "it" : "them"} off, and ${copies === 1 ? "it" : "they"} may need Retry.`
      : null,
    ...(questions > 0
      ? describeClosedQuestions(check.blockers, questions, { withoutSplit: false })
      : []),
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

/** What the toast says while the work of a restarted service is held again. */
export const SERVICE_RESTARTED =
  "The SpecWithCode service restarted. Holding its work again, then installing…";

export interface ServiceUpdateToastView {
  readonly type: "loading" | "warning" | "success" | "error";
  readonly title: string;
  readonly description: string;
  /** Stop what still runs and install now (asked or waiting), or try again (failed). */
  readonly action: "update-now" | "retry" | null;
  /** Offer to withdraw the install request and let work start again. */
  readonly cancel: boolean;
}

export interface ServiceUpdateToastOptions {
  /** Now (ms), for the elapsed time and whether a forced request is still live. */
  readonly now?: number;
  /** The app installs its own update once the service is on the new version. */
  readonly appFollows?: boolean;
}

/**
 * The persistent toast for a service update, with the time since the press.
 * While a forced request is live it offers only "Cancel update": the agent
 * keeps retrying on its own. Otherwise, while the agent is asked or waits, it
 * also offers "Update now". `waitedLong` (the wait outlasted a normal stop)
 * turns a real wait into a warning.
 */
export function serviceUpdateToast(
  progress: ServiceUpdateProgress,
  waitedLong: boolean,
  options: ServiceUpdateToastOptions = {},
): ServiceUpdateToastView {
  const version = progress.targetVersion ? `SpecWithCode ${progress.targetVersion}` : "the update";
  const now = options.now;
  const elapsed =
    now !== undefined && progress.startedAt !== undefined
      ? formatElapsed(now - progress.startedAt)
      : null;
  const clock = elapsed === null ? "" : ` · ${elapsed}`;
  switch (progress.phase) {
    case "stopping":
      return {
        type: "loading",
        title: `Updating to ${version}${clock}`,
        description: "Stopping running tasks and cancelling queued messages…",
        action: null,
        cancel: false,
      };
    case "requesting":
    case "waiting": {
      const forced = now !== undefined && isForcedRequestLive(progress, now);
      const blockers = describeServiceUpdateBlockers(progress.blockers);
      const fallback =
        progress.phase === "requesting"
          ? forced
            ? "Checking that nothing is running, then installing…"
            : "Asking the update agent to install it…"
          : "Waiting for the last work to finish…";
      const running =
        progress.fromVersion && progress.fromVersion !== progress.targetVersion
          ? `The SpecWithCode service on this Mac still runs ${progress.fromVersion}. `
          : "";
      // The work listed was the restarted service's: until the stop that holds
      // the work again says what runs now, the restart is what the toast says.
      const restarted = progress.serviceRestarted === true ? SERVICE_RESTARTED : "";
      // A forced request with nothing left running is the agent's own check, not a wait.
      const warn = waitedLong && (!forced || progress.phase === "waiting" || blockers !== "");
      return {
        type: warn ? "warning" : "loading",
        title: warn
          ? `Waiting to install ${version}${clock}`
          : forced
            ? `Updating to ${version}${clock}`
            : `Preparing to install ${version}${clock}`,
        description:
          running +
          (restarted ||
            blockers ||
            (progress.message ? serviceRefusalText(progress.message) : null) ||
            fallback),
        action: forced ? null : "update-now",
        cancel: true,
      };
    }
    case "installing":
      return {
        type: "loading",
        title: `Installing ${version}${clock}`,
        description: "The service restarts on its own; this window reconnects when it is back.",
        action: null,
        cancel: false,
      };
    case "restarting": {
      const took = elapsed === null ? "" : ` in ${elapsed}`;
      const reported = progress.message
        ? `Installed successfully. The updater also reported: ${progress.message} `
        : "";
      return options.appFollows
        ? {
            type: "success",
            title: `Updated the service to ${version}${took}`,
            description: `${reported}Restarting the app to finish the update…`,
            action: null,
            cancel: false,
          }
        : {
            type: "success",
            title: `Updated to ${version}${took}`,
            description: `${reported}Reloading this window…`,
            action: null,
            cancel: false,
          };
    }
    case "failed":
      return {
        type: "error",
        title: `Could not install ${version}`,
        // An older agent's "Restart SpecWithCode, then update" reads as what Update now does.
        description:
          progress.message !== null
            ? serviceRefusalText(progress.message)
            : "See Settings > About for the update receipt.",
        action: "retry",
        cancel: false,
      };
  }
}
