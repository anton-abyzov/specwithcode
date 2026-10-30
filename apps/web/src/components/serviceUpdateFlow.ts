import {
  DESKTOP_INSTALL_APPLY_MS,
  type StudioServiceInstallOptions,
  type StudioServiceUpdateState,
} from "@specweave-studio/contracts";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { requestConfirmDialog } from "../confirmDialog";
import { usePrimaryEnvironmentId } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { markRestartStep } from "./restartTrace";
import {
  AGENT_SETTLED,
  AGENT_UNSETTLED_ON_VERSION,
  AGENT_WORKING,
  agentSilentFor,
  hasPendingRequest,
  isPendingRequestLive,
  isWaitingPhase,
  newerRequestPending,
  newestWritten,
  pendingRequestProgress,
  refusedAfterWithdrawal,
  withdrawnAfterRequest,
  writtenAt,
} from "./serviceUpdateAgent";
import {
  CallTimeout,
  callPrepare,
  forgetPreparesForTests,
  forgetWithdrawalForTests,
  pendingWithdrawal,
  type PrepareServiceUpdate,
  QUICK_CALL_MS,
  readAgentState,
  registerPrepare,
  STOP_WORK_TIMEOUT_MS,
  withdrawRequest,
  withTimeout,
} from "./serviceUpdateCalls";
import { startServiceUpdateRun } from "./serviceUpdateRunFlow";
import { liveServiceUpdateRun } from "./serviceUpdateRunView";
import {
  type AppFollowUp,
  finishedFollowUp,
  forgetAnsweredFollowUp,
  forgetLackedRelease,
  forgetSavedFollowUp,
  forgetSavedOwnRequest,
  forgetServedRelease,
  readLackedRelease,
  rememberLackedRelease,
  type SavedOwnRequest,
  saveFollowUp,
  savedFollowUp,
  savedOwnRequestFor,
  saveOwnRequest,
  servesRelease,
} from "./serviceUpdateMemory";
import {
  askAgain,
  bindReholdFlow,
  hold,
  holdEnded,
  holdOnceAgentHasRelease,
  holdRestartedService,
  refusedBeforeHeld,
  releaseStrayHold,
  resetHold,
  resetHoldForTests,
} from "./serviceUpdateRehold";
import {
  advanceServiceUpdateProgress,
  agentOffersRelease,
  canPressUpdateAgain,
  canRetryServiceUpdate,
  describeServiceUpdateStop,
  isForcedRequestLive,
  isReleaseUnavailableFailure,
  isRestartRefusalWithRelease,
  markServiceRestarted,
  retryServiceUpdateProgress,
  serviceFailureKey,
  SERVICE_REQUEST_EXPIRED,
  serviceUpdateToast,
  type ServiceUpdateProgress,
  startServiceUpdateProgress,
} from "./sidebar/SidebarRestartToUpdate.logic";
import { serviceUpdateToastOptions } from "./serviceUpdateToast";
import { stackedThreadToast, toastManager } from "./ui/toast";

export type { AppFollowUp } from "./serviceUpdateMemory";
export { SERVICE_HOLD_ENDED } from "./serviceUpdateRehold";
export { SERVICE_REQUEST_EXPIRED } from "./sidebar/SidebarRestartToUpdate.logic";

/**
 * "Update now" for the Studio service, shared by the sidebar button and
 * Settings. One update runs per window, so its state, polling and toast live
 * here rather than in either component.
 *
 * The flow: look at what runs (quickly), ask before stopping it, stop and hold
 * the service's work, then ask the update agent to install with `force`, so it
 * retries until the held service is quiet instead of waiting for quiet on its
 * own schedule. The agent's own checks still decide when it is safe.
 *
 * When the app has an update too, it installs only once the service runs the
 * new version: an app relaunch inside the agent's checks changes the rows the
 * install guards and makes it start over. A press while a forced request is
 * live follows it instead of stopping the work again.
 */

// While a service update runs, read the update agent's state this often.
const SERVICE_POLL_MS = 2_000;
// Re-check what still runs this often while the install waits for it.
const BLOCKER_CHECK_MS = 10_000;
// Ask the agent again at most this often, and only once it has been silent this long.
const REQUEST_AGAIN_MS = 30_000;
// After this long waiting, the toast turns into a warning.
const WAIT_NOTICE_MS = 20_000;
// Reload into the new version this long after the service reports it installed.
const RELOAD_DELAY_MS = 1_500;
// Older desktops refresh the agent before they answer an install request.
const INSTALL_REQUEST_TIMEOUT_MS = 90_000;
/** How long the service holds new work back for the update. */
export const SERVICE_UPDATE_HOLD_MS = 15 * 60_000;
// A lapsed request is renewed this many times (about 40 minutes in all) before it fails.
const MAX_REQUEST_RENEWALS = 3;
// The toast's clock moves once a second while an update runs.
const CLOCK_TICK_MS = 1_000;
// The app quits once its install is accepted. Still here when the desktop
// takes the install back, the update ends so the button can be pressed again.
// The sidebar's own check, armed before this one, says so first.
const APP_RESTART_TIMEOUT_MS = DESKTOP_INSTALL_APPLY_MS;
// A reloaded window that got no answer from the service looks again this often,
// this many times, while the agent may still be acting on a request.
const ADOPT_RETRY_MS = 5_000;
const MAX_ADOPT_RETRIES = 36;

/** Installs the app's downloaded update; resolves true when the app is restarting. */
export type AppInstaller = (appVersion: string | null) => Promise<boolean>;

/**
 * Installs the app's update on its own, as its Restart to update does: it asks
 * before cutting off running work and drains the service it started.
 */
export type AppInstallNow = () => Promise<void>;

export interface ServiceUpdateFlowState {
  readonly progress: ServiceUpdateProgress | null;
  /** The wait has outlasted a normal stop; the toast turns into a warning. */
  readonly waitedLong: boolean;
  /** Looking at what runs, or asking before stopping it. */
  readonly starting: boolean;
}

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const IDLE: ServiceUpdateFlowState = { progress: null, waitedLong: false, starting: false };

let state: ServiceUpdateFlowState = IDLE;
const listeners = new Set<() => void>();
// Each attempt (and each cancel) bumps this, so late answers of an older one are dropped.
let attempt = 0;
// The attempt whose first stop drains before its request is written: what the
// agent writes meanwhile answers an earlier request (a renewal's, that lapsed).
let drainingAttempt: number | null = null;
let installOptions: StudioServiceInstallOptions | undefined;
let lastRequest = 0;
let lastBlockerCheck = 0;
let waitingSince: number | null = null;
let lastAgentState: StudioServiceUpdateState | null = null;
let readBusy = false;
let checkBusy = false;
let cancelling = false;
// Whether this window has looked for an update hold it did not start.
let adoptChecked = false;
let adopting = false;
let pollTimer: number | null = null;
let reloadTimer: number | null = null;
let toastId: string | null = null;
// The phase whose toast the user closed; it shows again once the phase moves on.
let dismissedPhase: ServiceUpdateProgress["phase"] | null = null;
// Times this window renewed its install request after the agent let it lapse.
let renewals = 0;
// The attempt whose Cancel the desktop could not save: the person meant to end
// it, so a lapse of its request is shown instead of renewed.
let cancelNotSavedFor: number | null = null;
// The failed attempt's request was withdrawn and the work let go when it
// failed, or left to the window that pressed: closing its toast only ends it.
let failureDealtWith = false;
// "Update now" for both: once the service runs the new version, the app installs.
let followUp: AppFollowUp | null = null;
let followUpStarted = false;
// The sidebar's way to install the app's update; null while it is not mounted.
let appInstaller: AppInstaller | null = null;
// The sidebar's way to install the app's update on its own, as its Restart to
// update does; null while it is not mounted.
let appInstallNow: AppInstallNow | null = null;
let clockTimer: number | null = null;
let forcedSeen = false;
// The app accepted its install after the service update; it should quit now.
let appRestartTimer: number | null = null;
// Adoption that got no answer looks again on its own (see adoptHeldUpdate).
let adoptRetryTimer: number | null = null;
let adoptRetries = 0;
let adoptInput: {
  readonly serviceState: StudioServiceUpdateState | null;
  readonly prepare: PrepareServiceUpdate;
} | null = null;

function setFollowUp(next: AppFollowUp | null) {
  followUp = next;
  followUpStarted = false;
  saveFollowUp(next);
}

/** Restores the saved follow-up for the update this window now follows. */
function restoreSavedFollowUp() {
  const saved = savedFollowUp(state.progress?.targetVersion ?? null);
  if (saved !== null && followUp === null) {
    followUp = saved;
    followUpStarted = false;
  }
}

/** Saves this window's request, as now asked for, so a reload can take it up again. */
function rememberOwnRequest() {
  if (installOptions?.holdUntil === undefined) return;
  const { holdUntil, version = null } = installOptions;
  // Once the work was held again for the agent's release, what that stop answered.
  saveOwnRequest({
    version,
    holdUntil,
    refused: hold.refused,
    holdAskedAgain: hold.askedAgain,
    held: hold.askedAgain && hold.seen,
    refusedAgain: hold.refusedAgain,
    askedUnderHoldAt: hold.askedUnderHoldAt,
  });
}

/**
 * Asking the service for its update again would fail for want of the release:
 * this window's last request failed that way (its toast may be closed since, or
 * the window reloaded), and no state seen since offers the release or shows
 * the service on it. A press for the app's update then restarts only the app;
 * the failure's Try again still asks the service. Never while this window
 * shows another update.
 */
export function serviceLacksRelease(serviceState: StudioServiceUpdateState | null = null): boolean {
  const progress = state.progress;
  if (isReleaseUnavailableFailure(progress)) return true;
  if (progress !== null) return false;
  const version = readLackedRelease();
  return version !== null && (serviceState === null || !servesRelease(serviceState, version));
}

/** No service update is under way, shown or about to start in this window. */
export function isServiceUpdateIdle(): boolean {
  return state.progress === null && !state.starting;
}

/** Ends this window's update: nothing is followed or asked for any more. */
function endAttempt() {
  setFollowUp(null);
  forgetSavedOwnRequest();
  attempt += 1;
  installOptions = undefined;
  hold.seen = false;
  failureDealtWith = false;
  setState({ progress: null, waitedLong: false });
}

/**
 * The sidebar registers how the app installs its own update; the flow calls
 * it once the service runs the version the press asked for.
 */
export function registerAppInstallAfterService(installer: AppInstaller): () => void {
  appInstaller = installer;
  return () => {
    if (appInstaller === installer) appInstaller = null;
  };
}

/** The sidebar registers how the app's update installs without the service's. */
export function registerAppInstallNow(install: AppInstallNow): () => void {
  appInstallNow = install;
  return () => {
    if (appInstallNow === install) appInstallNow = null;
  };
}

/**
 * Ends a failed attempt when a press installs the app on its own instead. The
 * failure already withdrew the request and let work start again, so only its
 * toast closes.
 */
export function endFailedServiceUpdate(): void {
  if (state.progress?.phase === "failed" && !state.starting) endAttempt();
}

/**
 * The app's update may install on its own: no service update is under way
 * that its restart would cut into (none, or one that failed or lapsed).
 */
export function canInstallAppAlone(): boolean {
  return state.progress === null || canPressUpdateAgain(state.progress, Date.now());
}

function readState(): ServiceUpdateFlowState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setState(patch: Partial<ServiceUpdateFlowState>) {
  const failed = patch.progress?.phase === "failed" && state.progress?.phase !== "failed";
  state = { ...state, ...patch };
  // A failed attempt installs nothing until it is pressed again: a reload must
  // not find the app's install and run it once the agent installs on its own.
  // This window keeps it for Try again, which saves it anew.
  if (failed) forgetSavedFollowUp();
  // The agent lacks the release: presses restart only the app until it has
  // it, even once this failure is closed or the window reloads.
  if (failed && patch.progress?.unavailable === true) {
    rememberLackedRelease(patch.progress.targetVersion);
  }
  syncTimers();
  syncToast();
  for (const listener of listeners) listener();
}

function updateProgress(
  change: (progress: ServiceUpdateProgress) => ServiceUpdateProgress | null,
): void {
  if (state.progress === null) return;
  const previous = state.progress;
  const next = change(previous);
  if (next === previous) return;
  // The agent let this window's request lapse while it still waited for work
  // to wind down (a service too old to hold itself only quiets slowly): ask
  // again instead of failing, while the person is still following it.
  if (
    next?.phase === "failed" &&
    next.message === SERVICE_REQUEST_EXPIRED &&
    (previous.phase === "waiting" || previous.phase === "requesting") &&
    installOptions !== undefined &&
    !cancelling &&
    cancelNotSavedFor !== attempt &&
    renewals < MAX_REQUEST_RENEWALS
  ) {
    renewals += 1;
    void run({ ...previous, phase: "requesting", message: null });
    return;
  }
  // A window that only follows the request does not fail with it when the
  // agent let it lapse: the window that pressed renews it, and a renewal
  // already written is followed instead.
  const lapsedForFollower =
    next?.phase === "failed" &&
    next.message === SERVICE_REQUEST_EXPIRED &&
    isWaitingPhase(previous) &&
    installOptions === undefined;
  if (lapsedForFollower && !cancelling && lastAgentState !== null) {
    if (followRenewal(lastAgentState, previous)) return;
  }
  // Refused before this window held the work for it: it holds it and asks again.
  if (
    next?.phase === "failed" &&
    isWaitingPhase(previous) &&
    next.message === lastAgentState?.message &&
    refusedBeforeHeld(lastAgentState)
  ) {
    return;
  }
  // A window that only follows the request leaves such a refusal to the
  // window that asked, while the request is pending: see followsPastRefusal.
  if (
    next?.phase === "failed" &&
    installOptions === undefined &&
    followsPastRefusal(lastAgentState)
  ) {
    return;
  }
  // A Cancel under way owns the attempt: it ends it, or when it could not
  // withdraw the request, the next read shows the agent's answer. Shown now,
  // a failure would flash its error and withdraw the request a second time.
  if (next?.phase === "failed" && cancelling) return;
  setState({ progress: next });
  if (next?.phase !== "failed" || previous.phase === "failed") return;
  // Withdrawing the request or letting the work go would undo the renewal,
  // also once the toast is closed.
  if (lapsedForFollower) failureDealtWith = true;
  // The agent gave up on this install: let work start again now instead of
  // keeping the service held until someone closes the notice. Update now
  // holds it again.
  else if (lastAgentState?.status !== "installing") void abandonFailedAttempt(next);
}

/**
 * The agent refused a request for a fault only a held request gets past, and
 * the desktop still reports it pending: the window that asked holds the work
 * for it and asks again (see refusedBeforeHeld), so a window that only
 * follows it keeps following. The refusal ends the request only once that
 * window gives up on it (it withdraws it) or its hold runs out.
 */
function followsPastRefusal(agent: StudioServiceUpdateState | null): boolean {
  return isRestartRefusalWithRelease(agent) && isPendingRequestLive(agent);
}

/**
 * This window only follows the request the agent let lapse: it follows the
 * renewal the window that pressed wrote, or a newer press, while that one's
 * hold lasts. False when there is none.
 */
function followRenewal(agent: StudioServiceUpdateState, lapsed: ServiceUpdateProgress): boolean {
  if (!isPendingRequestLive(agent) || !newerRequestPending(agent, lapsed)) return false;
  attempt += 1;
  hold.seen = false;
  failureDealtWith = false;
  if (!followPendingRequest(agent, null, lapsed.blockers)) return false;
  // A failure shown meanwhile forgot the app's install for a reload: the
  // renewal installs it after all.
  if (followUp !== null) saveFollowUp(followUp);
  return true;
}

function sendInstallRequest(): Promise<StudioServiceUpdateState | null> {
  const install = window.desktopBridge?.installServiceUpdate;
  if (!install) return Promise.resolve(null);
  lastRequest = Date.now();
  // Older desktops ignore the options and ask for a normal install.
  return withTimeout(install(installOptions), INSTALL_REQUEST_TIMEOUT_MS);
}

bindReholdFlow({
  attempt: () => attempt,
  progress: () => state.progress,
  asks: () => installOptions !== undefined,
  cancelling: () => cancelling,
  lastAgent: () => lastAgentState,
  sawAgent: (agent) => {
    lastAgentState = agent;
  },
  updateProgress,
  endAttempt,
  rememberOwnRequest,
  sendInstallRequest,
});

/**
 * The newest state of the agent this window has, by when the agent wrote it:
 * the one the caller sees, the one published to this window, or this window's
 * own last read.
 */
function newestWrittenAgentState(
  serviceState: StudioServiceUpdateState | null,
): StudioServiceUpdateState | null {
  return newestWritten([serviceState, adoptInput?.serviceState ?? null, lastAgentState]);
}

/** Stops and holds the service's work, then asks the agent to install now. */
async function run(start: ServiceUpdateProgress): Promise<void> {
  attempt += 1;
  const current = attempt;
  drainingAttempt = current;
  waitingSince = null;
  dismissedPhase = null;
  resetHold();
  failureDealtWith = false;
  // Asked anew, the agent's answer to this request says again whether it lacks the release.
  forgetLackedRelease();
  // A retry times its install afresh, on a service not restarted for it yet.
  const { installingSince: _previousInstall, serviceRestarted: _restarted, ...fresh } = start;
  setState({ progress: fresh, waitedLong: false });
  // The person waits on it, so the service bounds this drain tighter.
  const prepared = await callPrepare(
    { stopWork: true, hold: true, reason: "install", interactive: true },
    STOP_WORK_TIMEOUT_MS,
  );
  // Ended while the work stopped (a renewal's Cancel): its hold serves nothing.
  if (current !== attempt) {
    void releaseStrayHold(prepared);
    return;
  }
  // Without an answer the stop may have held the work: a look that finds
  // nothing held then holds it again (see holdRestartedService).
  hold.seen = prepared?.held !== false;
  hold.refused = prepared?.held === false;
  hold.pressUnanswered = prepared === null;
  lastBlockerCheck = Date.now();
  // What the agent reports before this request is not its answer to it.
  const before = await readAgentState();
  if (current !== attempt) return;
  // A cancel written meanwhile must not land after this request.
  await pendingWithdrawal();
  if (current !== attempt) return;
  const requestedAt = Date.now();
  // A renewal or retry asks anew, maybe for another version: a reload keeps
  // the app's install, saved as of this request, so only the agent's answer
  // to it (see forgetAnsweredFollowUp) can tell the reload it is over.
  if (followUp !== null) setFollowUp({ ...followUp, serviceVersion: start.targetVersion });
  installOptions = {
    force: true,
    holdUntil: new Date(requestedAt + SERVICE_UPDATE_HOLD_MS).toISOString(),
    // The agent installs only the version shown here, and lets the request lapse after 10 minutes.
    ...(start.targetVersion !== null ? { version: start.targetVersion } : {}),
  };
  rememberOwnRequest();
  updateProgress((progress) => ({
    ...progress,
    phase: "requesting",
    blockers: prepared?.blockers ?? [],
    message: null,
    staleFailure: serviceFailureKey(before),
    requestedAt,
    holdUntil: requestedAt + SERVICE_UPDATE_HOLD_MS,
  }));
  drainingAttempt = null;
  try {
    const next = await sendInstallRequest();
    if (current !== attempt) return;
    if (next !== null) lastAgentState = next;
    updateProgress((progress) => advanceServiceUpdateProgress(progress, next, Date.now()));
  } catch (error) {
    if (current !== attempt) return;
    // A slow desktop is still handling the request; keep following the agent.
    if (error instanceof CallTimeout) return;
    updateProgress((progress) => ({
      ...progress,
      phase: "failed",
      message: errorText(error, "The update agent did not answer."),
    }));
  }
}

function onPollInterval() {
  const progress = state.progress;
  if (progress === null) return;
  const now = Date.now();
  // Wall time, so a slow read or check never holds the notice back.
  if (isWaitingPhase(progress)) {
    waitingSince ??= now;
    if (!state.waitedLong && now - waitingSince >= WAIT_NOTICE_MS) setState({ waitedLong: true });
  } else {
    waitingSince = null;
  }
  void followAgent();
  checkBlockers(now);
}

async function followAgent() {
  if (readBusy || drainingAttempt === attempt) return;
  readBusy = true;
  const current = attempt;
  try {
    const next = await readAgentState();
    if (current !== attempt || next === null) return;
    lastAgentState = next;
    forgetServedRelease(next);
    // The desktop reports the request the agent installs for, until it is
    // cancelled (in another window, once the install began) or for an install
    // the agent runs on its own: the app's install follows neither, as only a
    // press asks for it (see cancelledTooLate).
    if (next.status === "installing" && !hasPendingRequest(next)) setFollowUp(null);
    // Cancelled in another window before the agent's pass refused it: quietly.
    if (!cancelling && refusedAfterWithdrawal(next, state.progress, Date.now())) {
      endAttempt();
      return;
    }
    updateProgress((progress) => advanceServiceUpdateProgress(progress, next, Date.now()));
    // Renewed on this answer: it answered the request that lapsed, not the renewal.
    if (current !== attempt) return;
    // Cancelled in another window: nothing more is asked for it, quietly.
    if (withdrawnElsewhere(next)) endAttempt();
    else holdOnceAgentHasRelease(next, current);
  } finally {
    readBusy = false;
  }
}

/**
 * Another window withdrew the request this window waits on (its own or one it
 * follows): in a state the agent wrote after the request, the desktop reports
 * none pending. Not once the request's hold ran out: it lapsed then, and the
 * toast says so.
 */
function withdrawnElsewhere(agent: StudioServiceUpdateState): boolean {
  return !cancelling && withdrawnAfterRequest(agent, state.progress, Date.now());
}

function checkBlockers(now: number) {
  if (!isWaitingPhase(state.progress) || checkBusy) return;
  if (drainingAttempt === attempt || hold.reholding === attempt) return;
  if (now - lastBlockerCheck < BLOCKER_CHECK_MS) return;
  lastBlockerCheck = now;
  checkBusy = true;
  const current = attempt;
  void callPrepare({ stopWork: false }, QUICK_CALL_MS)
    .then((checked) => {
      // A cancel under way owns the attempt; nothing here may undo it.
      if (current !== attempt || cancelling || checked === null) return;
      if (checked.held === true) {
        hold.seen = true;
        hold.pressUnanswered = false;
      }
      // An update ends with its hold: cancelled in another window, or settled.
      // It ends so once it was seen held, while it still waits (an install
      // keeps the service held). One this window only follows ends too once
      // the desktop no longer reports it: its hold may have been refused.
      const followedGone = installOptions === undefined && !isPendingRequestLive(lastAgentState);
      const ended = isWaitingPhase(state.progress) && (hold.seen || followedGone);
      if (checked.held === false && ended) {
        // This window's own hold ran out before the install began, rather than
        // being cancelled elsewhere: say so, and keep the app's install for a retry.
        const holdUntil = state.progress?.holdUntil;
        if (installOptions !== undefined && holdUntil !== undefined && Date.now() >= holdUntil) {
          holdEnded();
          return;
        }
        // Cancelled elsewhere, or the service restarted: the agent's state tells which.
        void holdRestartedService(current);
        return;
      }
      updateProgress((progress) => ({
        // Held again: the restart the toast told of is behind it.
        ...(checked.held === true ? markServiceRestarted(progress, false) : progress),
        blockers: checked.blockers,
      }));
      // Only this window's own request is asked again; one taken over keeps its own.
      if (installOptions === undefined) return;
      // Blockers, not `idle`: a folder copy makes the service not idle, yet a forced
      // install ignores copies, so one must not stop the window asking a silent agent.
      if (
        !isWaitingPhase(state.progress) ||
        checked.blockers.length > 0 ||
        hold.requestInFlight !== null
      ) {
        return;
      }
      const at = Date.now();
      // Nothing runs and the agent went quiet: ask again instead of waiting for its next pass.
      if (
        at - lastRequest < REQUEST_AGAIN_MS ||
        !agentSilentFor(lastAgentState, at, REQUEST_AGAIN_MS)
      ) {
        return;
      }
      askAgain(current);
    })
    .finally(() => {
      checkBusy = false;
    });
}

function syncTimers() {
  const phase = state.progress?.phase ?? null;
  const following =
    phase === "requesting" ||
    phase === "waiting" ||
    phase === "installing" ||
    phase === "restarting";
  if (following && pollTimer === null && window.desktopBridge?.getServiceUpdateState) {
    pollTimer = window.setInterval(onPollInterval, SERVICE_POLL_MS);
  } else if (!following && pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  // Once the service is back on the new version, the app installs its own
  // update when the press asked for it; otherwise the window reloads.
  if (phase === "restarting" && followUp !== null && appInstaller !== null) {
    if (!followUpStarted) {
      followUpStarted = true;
      void installAppAfterService(followUp, appInstaller);
    }
  } else if (phase === "restarting" && reloadTimer === null) {
    reloadTimer = window.setTimeout(() => window.location?.reload?.(), RELOAD_DELAY_MS);
  } else if (phase !== "restarting" && reloadTimer !== null) {
    window.clearTimeout(reloadTimer);
    reloadTimer = null;
  }
  // The clock stops once the service is updated: the toast then says how long it took.
  const ticking =
    (phase === "stopping" ||
      phase === "requesting" ||
      phase === "waiting" ||
      phase === "installing") &&
    state.progress?.startedAt !== undefined;
  if (ticking && clockTimer === null) {
    clockTimer = window.setInterval(onClockTick, CLOCK_TICK_MS);
  } else if (!ticking && clockTimer !== null) {
    window.clearInterval(clockTimer);
    clockTimer = null;
  }
}

// Moves the toast's clock, and lets the button offer "Update now" again once
// a forced request's hold has ended.
function onClockTick() {
  const progress = state.progress;
  if (progress === null) return;
  const forced = isForcedRequestLive(progress, Date.now());
  if (forced !== forcedSeen) {
    forcedSeen = forced;
    for (const listener of listeners) listener();
  }
  if (typeof document !== "undefined" && document.hidden) return;
  syncToast();
}

async function installAppAfterService(next: AppFollowUp, install: AppInstaller): Promise<void> {
  const current = attempt;
  const restarting = await install(next.appVersion).catch(() => false);
  if (current !== attempt) return;
  if (restarting) {
    // The app quits now; this window goes with it. A quit that was vetoed or
    // failed leaves it open: the update then ends, so the button works again.
    if (appRestartTimer !== null) window.clearTimeout(appRestartTimer);
    appRestartTimer = window.setTimeout(() => {
      appRestartTimer = null;
      if (current === attempt) endAttempt();
    }, APP_RESTART_TIMEOUT_MS);
    return;
  }
  // The installer said why the app did not restart; the service is updated,
  // so the update ends here and the window stays as it is.
  endAttempt();
}

function dismissToast() {
  toastId = null;
  const progress = state.progress;
  if (progress === null) return;
  if (progress.phase === "failed") {
    // Done with this attempt. Its request was withdrawn and the work let go
    // when it failed (or left to the window that pressed): only its toast
    // closes, and another window's update since goes on. Otherwise (it failed
    // while the agent installed, or that is still being written) now.
    const dealtWith = failureDealtWith;
    endAttempt();
    if (!dealtWith) void abandonFailedAttempt(progress);
    return;
  }
  // The update goes on; the toast comes back when it moves on.
  dismissedPhase = progress.phase;
}

/**
 * Withdraws a failed attempt's request and lets work start again, unless the
 * desktop now reports a newer request pending (another window pressed since,
 * or the window that pressed renewed it): that one is not this attempt's.
 */
async function abandonFailedAttempt(failed: ServiceUpdateProgress) {
  const current = attempt;
  const before = await readAgentState();
  // Ended meanwhile: a new attempt, or an app restart's drain, owns the
  // request and the hold now (a closed toast withdraws them itself).
  if (current !== attempt) return;
  if (before === null || !newerRequestPending(before, failed)) {
    const { agent } = await withdrawRequest();
    // An install the window stopped following (it timed out here) may still
    // run; the service stays held until it settles or the hold expires.
    if ((agent ?? lastAgentState)?.status === "installing") return;
    if (current !== attempt) return;
    await callPrepare({ stopWork: false, releaseHold: true }, QUICK_CALL_MS);
  }
  // Closing the toast of the failure still shown now only ends it.
  if (current === attempt && state.progress === failed) failureDealtWith = true;
}

// One persistent toast follows the update from the click to the reload.
function syncToast() {
  const progress = state.progress;
  if (progress === null) {
    if (toastId !== null) toastManager.close(toastId);
    toastId = null;
    dismissedPhase = null;
    return;
  }
  if (dismissedPhase !== null) {
    if (dismissedPhase === progress.phase) return;
    dismissedPhase = null;
  }
  const view = serviceUpdateToast(progress, state.waitedLong, {
    now: Date.now(),
    appFollows: followUp !== null && appInstaller !== null,
  });
  const options = serviceUpdateToastOptions(view, {
    retry: () => void retryServiceUpdate(),
    cancel: () => void cancelServiceUpdate(),
    close: dismissToast,
  });
  if (toastId === null) toastId = toastManager.add(options);
  else toastManager.update(toastId, options);
}

const STOP_UNKNOWN =
  "Stop running work and update now?\nRunning tasks will be interrupted and terminals closed. You can continue interrupted tasks after the update; one that just finished may lose its checkpoint.";

export interface StartServiceUpdateOptions {
  /** The service version to install; the agent's own release when omitted. */
  readonly targetVersion?: string | null;
  /**
   * Once the service runs the new version, the app installs this update of its
   * own. A service already on that version resolves the press "app-only".
   */
  readonly thenInstallApp?: { readonly appVersion: string | null } | null;
}

/**
 * What a press of "Update now" did: true when an update started or the press
 * joined one under way, false when nothing started, and "app-only" when the
 * service already runs the version asked for, so only the app's install that
 * the press named (`thenInstallApp`) is left, for its caller to do.
 */
export type ServiceUpdateStart = boolean | "app-only";

/**
 * Follows a forced request already written (by another window, or before the
 * app restarted) instead of stopping the work and asking again. False when
 * there is none for this version.
 */
function followPendingRequest(
  serviceState: StudioServiceUpdateState | null,
  targetVersion: string | null,
  blockers: ServiceUpdateProgress["blockers"],
): boolean {
  const now = Date.now();
  const found = pendingRequestProgress(serviceState, targetVersion, blockers, now);
  // A refusal the request still gets past is followed, not shown (see followsPastRefusal).
  const progress =
    found?.phase === "failed" && followsPastRefusal(serviceState)
      ? { ...found, phase: "requesting" as const, message: null }
      : found;
  if (serviceState === null || progress === null) return false;
  lastAgentState = serviceState;
  lastBlockerCheck = now;
  setState({ progress, waitedLong: false });
  return true;
}

/**
 * "Update now": looks at what runs, asks before stopping it, then stops and
 * holds the service's work and asks the agent to install. With
 * `thenInstallApp`, the app installs its own update once the service runs the
 * new version. A press while the agent already acts on a forced request
 * follows it instead. Resolves false when nothing started: the user kept
 * their work, or the update cannot start now.
 */
export async function startServiceUpdateNow(
  serviceState: StudioServiceUpdateState | null,
  options: StartServiceUpdateOptions = {},
): Promise<ServiceUpdateStart> {
  const current = state.progress;
  if (state.starting || cancelling) return false;
  // An Update now run is going on (0988): every window follows it, none asks again.
  if (liveServiceUpdateRun(serviceState) !== null) return true;
  const thenApp = options.thenInstallApp ?? null;
  const target = options.targetVersion ?? current?.targetVersion ?? null;
  // Already under way: this press only adds the app's install to it.
  if (current !== null && !canPressUpdateAgain(current, Date.now())) {
    // The app's install already follows this update: nothing to add.
    if (current.phase === "restarting" && thenApp !== null && followUp !== null) return true;
    if (current.phase === "restarting" || current.phase === "failed") return false;
    if (thenApp !== null) setFollowUp({ ...thenApp, serviceVersion: current.targetVersion });
    return true;
  }
  if (!window.desktopBridge?.installServiceUpdate) return false;
  // The service already runs the version this press asks for (its agent
  // installed it on its own): nothing is stopped or asked of the agent. Only
  // the app's install is left, with the warning any app restart gives;
  // without one the update is over. Both versions come from the newest state.
  const written = newestWrittenAgentState(serviceState);
  const wanted =
    current !== null
      ? retryServiceUpdateProgress(current, written ?? lastAgentState).targetVersion
      : startServiceUpdateProgress(serviceState, options.targetVersion).targetVersion;
  const running = (written ?? serviceState ?? adoptInput?.serviceState ?? lastAgentState)
    ?.installedVersion;
  if (wanted !== null && running === wanted) {
    const app = thenApp ?? followUp;
    if (current !== null) endAttempt();
    // The press named the app's install: its caller restarts the app itself,
    // rather than through a restart it registered before this press began.
    if (thenApp !== null) return "app-only";
    if (app !== null && appInstallNow !== null) await appInstallNow();
    return true;
  }
  if (current === null && followPendingRequest(serviceState, target, [])) {
    if (thenApp !== null)
      setFollowUp({ ...thenApp, serviceVersion: state.progress?.targetVersion ?? target });
    return true;
  }
  setState({ starting: true });
  try {
    const lookAt = Date.now();
    const checked = await callPrepare({ stopWork: false }, QUICK_CALL_MS);
    // A service that cannot say what runs may still be running something.
    const question = checked === null ? STOP_UNKNOWN : describeServiceUpdateStop(checked);
    markRestartStep("quick-look", {
      startedAt: lookAt,
      detail: question === null ? "nothing runs" : "asks to stop work",
    });
    if (question !== null) {
      // No themed host mounted (undefined) means proceed: the click was the request.
      const confirmed =
        (await requestConfirmDialog(question, {
          variant: "destructive",
          confirmLabel: "Stop and update now",
          cancelLabel: "Cancel",
        })) ?? true;
      if (!confirmed) return false;
    }
  } finally {
    setState({ starting: false });
  }
  // Something else may have started or finished the update while the user decided.
  const latest = state.progress;
  if (latest !== null && !canPressUpdateAgain(latest, Date.now())) return false;
  // A click starts afresh: the renewals of an earlier request do not count.
  renewals = 0;
  const start =
    latest !== null
      ? retryServiceUpdateProgress(latest, newestWrittenAgentState(serviceState) ?? lastAgentState)
      : startServiceUpdateProgress(serviceState, options.targetVersion);
  // One durable run when the desktop and its agent support it; the desktop
  // then installs the app after the service, with or without this window.
  const viaRun = await startServiceUpdateRun({
    targetVersion: start.targetVersion,
    appTargetVersion: thenApp?.appVersion ?? null,
  });
  if (viaRun !== "legacy") return true;
  if (thenApp !== null) setFollowUp({ ...thenApp, serviceVersion: start.targetVersion });
  else if (latest === null) setFollowUp(null);
  await run({ ...start, startedAt: Date.now() });
  return true;
}

/** "Update now" again (or "Try again") for the update already under way. */
export function retryServiceUpdate(): Promise<ServiceUpdateStart> {
  return startServiceUpdateNow(null);
}

/**
 * Withdraws the install request: the agent stops retrying, the service lets
 * work start again, and the toast goes away. The request is withdrawn before
 * the hold is released, so an install that has already started keeps the
 * service quiet and is followed to the end instead.
 */
export async function cancelServiceUpdate(): Promise<void> {
  if (cancelling || !isWaitingPhase(state.progress)) return;
  cancelling = true;
  // A renewal still stopping the work has written no request yet.
  const draining = drainingAttempt === attempt;
  // Before the withdrawal goes out, so a check or request answered meanwhile
  // for the attempt being cancelled is dropped instead of asking again.
  attempt += 1;
  const current = attempt;
  try {
    const { withdrawn, agent } = await withdrawRequest();
    if (current !== attempt) return;
    const progress = state.progress;
    const answered =
      agent === null || draining || progress === null
        ? progress
        : advanceServiceUpdateProgress(progress, agent, Date.now());
    if (agent !== null) lastAgentState = agent;
    // The agent started installing meanwhile; that cannot be withdrawn. Said
    // before the window follows that install, which may already be done.
    if (answered !== null && !canRetryServiceUpdate(answered)) cancelledTooLate();
    if (answered !== progress) updateProgress(() => answered);
    if (state.progress !== null && !canRetryServiceUpdate(state.progress)) return;
    if (!withdrawn) {
      // The agent may still install, so the service stays held for it.
      cancelNotSavedFor = current;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not cancel the update",
          description: "The update could not be cancelled. Try again in a moment.",
        }),
      );
      return;
    }
    await callPrepare({ stopWork: false, releaseHold: true }, QUICK_CALL_MS);
    if (current !== attempt) return;
    endAttempt();
  } finally {
    cancelling = false;
  }
}

/**
 * A Cancel the agent's install came before: the service's install goes on and
 * is followed to its end, but the app's own install no longer follows it,
 * since the person cancelled. The app's Restart to update stays for a later
 * press.
 */
function cancelledTooLate(): void {
  const appFollowed = followUp !== null;
  setFollowUp(null);
  toastManager.add(
    stackedThreadToast({
      type: "warning",
      title: "Could not cancel the update",
      description: `SpecWithCode had already started installing the service update; it cannot be cancelled.${appFollowed ? " The app will not restart." : ""}`,
    }),
  );
}

/**
 * After a reload, an app restart or in another window, the service may still
 * be held for an update this window did not start, refusing new work. While
 * the agent may still install it, show it here with "Cancel update"; when the
 * agent is idle or failed, release the hold, since nothing else will. An
 * app restart that drained a service it did not take down leaves such a hold
 * with the agent idle, so the agent's state alone never skips the look.
 */
async function adoptHeldUpdate(
  serviceState: StudioServiceUpdateState | null,
  prepare: PrepareServiceUpdate,
): Promise<void> {
  adoptInput = { serviceState, prepare };
  if (serviceState !== null) {
    forgetServedRelease(serviceState);
    forgetAnsweredFollowUp(serviceState);
    // A failed attempt overtaken by the agent is over; look afresh, as a reload would.
    if (endOvertakenFailure(serviceState)) adoptChecked = false;
  }
  if (adoptChecked || adopting) return;
  // "available" or "starting": the agent may be about to take up another
  // window's request; look again once it says more. A request the desktop
  // reports as pending is followed whatever the agent last wrote.
  if (
    serviceState === null ||
    (!hasPendingRequest(serviceState) &&
      !AGENT_WORKING.has(serviceState.status) &&
      !AGENT_SETTLED.has(serviceState.status))
  )
    return;
  if (state.progress !== null || state.starting) return;
  adopting = true;
  const current = attempt;
  try {
    const checked = await callPrepare({ stopWork: false }, QUICK_CALL_MS, prepare);
    // The window reloaded while the service updated, and the update is done:
    // only the app's install, which the press asked for, is left.
    if (
      current === attempt &&
      state.progress === null &&
      !state.starting &&
      resumeFinishedFollowUp(serviceState)
    )
      return;
    // No answer (the service may be restarting into the new version): look
    // again shortly while the agent may still act on a request, since the
    // desktop publishes nothing new until the install ends.
    if (checked === null) {
      scheduleAdoptRetry(serviceState);
      return;
    }
    adoptRetries = 0;
    // Not held (yet): another window may start an update later, so look again on
    // the next state change rather than once per window. An install the agent
    // runs on its own (at a quiet moment, or for the app's version after the app
    // updated) holds nothing, but is shown all the same.
    if (checked.held !== true) {
      // A request a reload would install the app after may have been
      // withdrawn meanwhile, in another window: then an install the agent
      // starts on its own later is no longer that press's.
      forgetAnsweredFollowUp(serviceState, checked.held);
      if (serviceState.status === "installing") await followAgentInstall(serviceState, current);
      else resumeOwnRequest(serviceState, checked.blockers);
      return;
    }
    // A drain before an app restart (this window's or another's) is not an
    // update to follow or release: the app is about to quit, and the service
    // ends the hold itself soon when no install request follows.
    if (checked.holdReason === "app-restart") return;
    adoptChecked = true;
    const agent = (await readAgentState()) ?? serviceState;
    if (current !== attempt || state.progress !== null || state.starting) return;
    // The agent has not run for a request just written: its old "up to date"
    // is not a reason to withdraw it.
    if (!hasPendingRequest(agent) && !AGENT_WORKING.has(agent.status)) {
      // Not yet settled either: decide on a later state change.
      if (!AGENT_SETTLED.has(agent.status)) {
        adoptChecked = false;
        return;
      }
      // That update is over: an install the agent starts on its own later
      // does not install the app a press before the reload asked for.
      forgetSavedFollowUp();
      await withdrawRequest();
      if (current === attempt && state.progress === null) {
        await callPrepare({ stopWork: false, releaseHold: true }, QUICK_CALL_MS);
      }
      return;
    }
    // The pending request gives its time, version and hold; without a live
    // one, the agent's own state is followed.
    const pendingVersion = agent.pendingInstall?.version ?? null;
    let own: SavedOwnRequest | null = null;
    if (followPendingRequest(agent, pendingVersion, checked.blockers)) {
      // The window that pressed reloaded: the request is its own again, so a
      // lapse renews it and a hold that runs out says so. Another window's
      // request is only followed: nothing is asked again for it.
      own = savedOwnRequestFor(agent);
      if (own !== null) takeUpOwnRequest(own);
    } else {
      const now = Date.now();
      lastAgentState = agent;
      lastBlockerCheck = now;
      const base: ServiceUpdateProgress = {
        ...startServiceUpdateProgress(agent),
        phase: "requesting",
        blockers: checked.blockers,
      };
      setState({ progress: advanceServiceUpdateProgress(base, agent, now), waitedLong: false });
    }
    // Seen held: it ends once the hold does (see checkBlockers).
    hold.seen = true;
    if (own?.refused === true) resumeHeldOwnRequest(own, current);
    // A window reloaded during "Update now" for both still installs the app after.
    restoreSavedFollowUp();
  } finally {
    adopting = false;
  }
}

/**
 * The window that pressed Update now reloaded while the service holds the
 * work for its request, after the press's own hold was refused: the agent's
 * refusal of the request written before any hold is not its answer (see
 * refusedBeforeHeld). Unless that was done before the reload, the request is
 * written again under this hold, as holdOnceAgentHasRelease does once its
 * stop holds the work. A second stop that was refused leaves the refusal
 * standing, as it did before the reload.
 */
function resumeHeldOwnRequest(saved: SavedOwnRequest, current: number): void {
  hold.refused = true;
  hold.askedAgain = true;
  hold.refusedAgain = saved.refusedAgain;
  hold.askedUnderHoldAt = saved.askedUnderHoldAt;
  if (!saved.refusedAgain && saved.askedUnderHoldAt === null) askAgain(current);
}

/**
 * The window that pressed Update now reloaded while its request is pending
 * and the work not held (the service refused: its agent lacked the release
 * then). It takes the request up again as its own, as the desktop reports it
 * back, so it still holds the work once the agent has the release.
 */
function resumeOwnRequest(
  serviceState: StudioServiceUpdateState,
  blockers: ServiceUpdateProgress["blockers"],
): void {
  // A press made while the window looked at the service goes its own way.
  if (state.progress !== null || state.starting) return;
  const saved = savedOwnRequestFor(serviceState);
  if (saved === null) return;
  if (!followPendingRequest(serviceState, saved.version, blockers)) return;
  takeUpOwnRequest(saved);
  // Nothing holds the work now: it is held once the agent has the release
  // (see holdOnceAgentHasRelease), unless that was asked already.
  hold.refused = true;
  hold.askedAgain = saved.holdAskedAgain;
  // Held for it before the reload and not now: the service restarted, and the
  // next look holds the work again (see holdRestartedService). Refused then,
  // the agent's refusal of the request stands, as it did before the reload.
  hold.seen = saved.held;
  hold.refusedAgain = saved.refusedAgain;
  restoreSavedFollowUp();
}

/** This window asks for `saved` again as it did before it reloaded. */
function takeUpOwnRequest(saved: SavedOwnRequest): void {
  const { version, holdUntil } = saved;
  installOptions = { force: true, holdUntil, ...(version !== null ? { version } : {}) };
}

/**
 * This window's attempt failed, and since then the agent started installing on
 * its own, the service came to run the version asked for, or the agent found
 * the release it lacked. The attempt ends, so that install is followed like
 * any other, or the update is offered again; the app's install never runs
 * without a press. A request this window only followed, that lapsed, gives way
 * to its renewal instead, which the window follows (false then: nothing to
 * look at afresh).
 */
function endOvertakenFailure(serviceState: StudioServiceUpdateState): boolean {
  const progress = state.progress;
  if (progress?.phase !== "failed" || state.starting) return false;
  // A state older than the one the failure came from says nothing new.
  const published = writtenAt(serviceState);
  const seen = lastAgentState === null ? null : writtenAt(lastAgentState);
  if (published !== null && seen !== null && published < seen) return false;
  // This window only followed the request the agent let lapse: the window
  // that pressed renewed it since, and this one follows the renewal.
  const lapsed = progress.message === SERVICE_REQUEST_EXPIRED && installOptions === undefined;
  if (lapsed && followRenewal(serviceState, progress)) return false;
  // An install the window gave up on (it timed out) is not a new one.
  const installing =
    serviceState.status === "installing" && lastAgentState?.status !== "installing";
  const installed =
    progress.targetVersion !== null &&
    serviceState.installedVersion === progress.targetVersion &&
    !AGENT_UNSETTLED_ON_VERSION.has(serviceState.status);
  // Asked again now, the service's agent no longer fails for want of the release.
  const found =
    progress.unavailable === true && agentOffersRelease(serviceState, progress.targetVersion);
  if (!installing && !installed && !found) return false;
  endAttempt();
  return true;
}

function scheduleAdoptRetry(serviceState: StudioServiceUpdateState) {
  const inFlight = hasPendingRequest(serviceState) || AGENT_WORKING.has(serviceState.status);
  if (!inFlight || adoptRetryTimer !== null || adoptRetries >= MAX_ADOPT_RETRIES) return;
  adoptRetries += 1;
  adoptRetryTimer = window.setTimeout(() => {
    adoptRetryTimer = null;
    if (adoptInput !== null) void adoptHeldUpdate(adoptInput.serviceState, adoptInput.prepare);
  }, ADOPT_RETRY_MS);
}

/** Installs the app for a press whose service update finished while the window reloaded. */
function resumeFinishedFollowUp(serviceState: StudioServiceUpdateState): boolean {
  const finished = finishedFollowUp(serviceState);
  // Without the sidebar's installer the window would only reload, again and again.
  if (finished === null || appInstaller === null) return false;
  adoptChecked = true;
  lastAgentState = serviceState;
  followUp = finished;
  followUpStarted = false;
  setState({
    progress: {
      ...startServiceUpdateProgress(serviceState, finished.serviceVersion),
      phase: "restarting",
    },
    waitedLong: false,
  });
  return true;
}

/** Shows an install the agent started on its own until the service is back. */
async function followAgentInstall(
  serviceState: StudioServiceUpdateState,
  current: number,
): Promise<void> {
  const agent = (await readAgentState()) ?? serviceState;
  if (current !== attempt || state.progress !== null || state.starting) return;
  if (agent.status !== "installing") return;
  adoptChecked = true;
  const now = Date.now();
  lastAgentState = agent;
  lastBlockerCheck = now;
  // The agent writes "installing" as it starts the install: time it from there.
  const since = typeof agent.updatedAt === "string" ? Date.parse(agent.updatedAt) : Number.NaN;
  const base: ServiceUpdateProgress = {
    ...startServiceUpdateProgress(agent, agent.pendingInstall?.version ?? null),
    phase: "requesting",
    ...(Number.isFinite(since) && since <= now ? { startedAt: since } : {}),
  };
  setState({ progress: advanceServiceUpdateProgress(base, agent, now), waitedLong: false });
  restoreSavedFollowUp();
}

/**
 * The shared service update, plus this component's way to reach the server.
 * `serviceState` is the agent's state as this component sees it; with it, the
 * window takes over an update hold it did not start (see `adoptHeldUpdate`).
 */
export function useServiceUpdateFlow(
  serviceState: StudioServiceUpdateState | null = null,
): ServiceUpdateFlowState {
  const environmentId = usePrimaryEnvironmentId();
  const prepareCommand = useAtomCommand(serverEnvironment.prepareServiceUpdate, {
    reportFailure: false,
    reportDefect: false,
  });
  const prepare = useCallback<PrepareServiceUpdate>(
    async (input) => {
      if (environmentId === null) return null;
      const result = await prepareCommand({ environmentId, input }).catch(() => null);
      return result?._tag === "Success" ? result.value : null;
    },
    [environmentId, prepareCommand],
  );
  useEffect(() => registerPrepare(prepare), [prepare]);
  useEffect(() => {
    // A hold an Update now run made is the run's: windows follow the run instead.
    if (liveServiceUpdateRun(serviceState) !== null) return;
    void adoptHeldUpdate(serviceState, prepare);
  }, [prepare, serviceState]);
  return useSyncExternalStore(subscribe, readState, readState);
}

export function resetServiceUpdateFlowForTests(): void {
  if (pollTimer !== null) window.clearInterval(pollTimer);
  if (reloadTimer !== null) window.clearTimeout(reloadTimer);
  state = IDLE;
  listeners.clear();
  forgetPreparesForTests();
  attempt += 1;
  drainingAttempt = null;
  installOptions = undefined;
  lastRequest = 0;
  lastBlockerCheck = 0;
  waitingSince = null;
  lastAgentState = null;
  renewals = 0;
  cancelNotSavedFor = null;
  failureDealtWith = false;
  readBusy = false;
  checkBusy = false;
  cancelling = false;
  forgetWithdrawalForTests();
  adoptChecked = false;
  adopting = false;
  pollTimer = null;
  reloadTimer = null;
  toastId = null;
  dismissedPhase = null;
  if (clockTimer !== null) window.clearInterval(clockTimer);
  clockTimer = null;
  forcedSeen = false;
  if (appRestartTimer !== null) window.clearTimeout(appRestartTimer);
  appRestartTimer = null;
  resetHoldForTests();
  forgetSavedOwnRequest();
  if (adoptRetryTimer !== null) window.clearTimeout(adoptRetryTimer);
  adoptRetryTimer = null;
  adoptRetries = 0;
  adoptInput = null;
  followUp = null;
  followUpStarted = false;
  appInstaller = null;
  appInstallNow = null;
  forgetSavedFollowUp();
  forgetLackedRelease();
}
