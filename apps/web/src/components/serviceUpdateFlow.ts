import type {
  ServiceUpdateBlocker,
  ServerPrepareServiceUpdateInput,
  ServerPrepareServiceUpdateResult,
  StudioServiceInstallOptions,
  StudioServiceUpdateState,
  StudioServiceUpdateStatus,
} from "@specweave-studio/contracts";
import { type ReactNode, useCallback, useEffect, useSyncExternalStore } from "react";

import { requestChoiceDialog, requestConfirmDialog } from "../confirmDialog";
import { ensureLocalApi } from "../localApi";
import { usePrimaryEnvironmentId } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  advanceServiceUpdateProgress,
  APP_RESTART_UNKNOWN,
  describeAppRestartWarning,
  canPressUpdateAgain,
  canRetryServiceUpdate,
  describeServiceUpdateStop,
  isForcedRequestLive,
  pendingHoldUntil,
  retryServiceUpdateProgress,
  serviceFailureKey,
  serviceUpdateToast,
  type ServiceUpdateProgress,
  startServiceUpdateProgress,
} from "./sidebar/SidebarRestartToUpdate.logic";
import { hiddenToastActionProps, stackedThreadToast, toastManager } from "./ui/toast";

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

export type PrepareServiceUpdate = (
  input: ServerPrepareServiceUpdateInput,
) => Promise<ServerPrepareServiceUpdateResult | null>;

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
/** Reads and checks answer within this, or count as no answer. */
export const QUICK_CALL_MS = 5_000;
/** Stopping work can take a while on a busy service; the install proceeds after this. */
export const STOP_WORK_TIMEOUT_MS = 90_000;
// Older desktops refresh the agent before they answer an install request.
const INSTALL_REQUEST_TIMEOUT_MS = 90_000;
/** How long the service holds new work back for the update. */
export const SERVICE_UPDATE_HOLD_MS = 15 * 60_000;
/** What the update agent says when an install request lapsed before it could start. */
export const SERVICE_REQUEST_EXPIRED =
  "The update request expired before it could start; choose Update now again.";
// A lapsed request is renewed this many times (about 40 minutes in all) before it fails.
const MAX_REQUEST_RENEWALS = 3;
// The toast's clock moves once a second while an update runs.
const CLOCK_TICK_MS = 1_000;
// Where a window keeps "then install the app" across a reload.
const FOLLOW_UP_KEY = "specwithcode.serviceUpdate.thenInstallApp";
// A saved follow-up older than this belongs to an update long over.
const FOLLOW_UP_TTL_MS = 45 * 60_000;

/** The app update that installs once the service runs `serviceVersion`. */
export interface AppFollowUp {
  readonly appVersion: string | null;
  readonly serviceVersion: string | null;
}

/** Installs the app's downloaded update; resolves true when the app is restarting. */
export type AppInstaller = (appVersion: string | null) => Promise<boolean>;

export interface ServiceUpdateFlowState {
  readonly progress: ServiceUpdateProgress | null;
  /** The wait has outlasted a normal stop; the toast turns into a warning. */
  readonly waitedLong: boolean;
  /** Looking at what runs, or asking before stopping it. */
  readonly starting: boolean;
}

class CallTimeout extends Error {
  constructor() {
    super("The call did not answer in time.");
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new CallTimeout()), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const IDLE: ServiceUpdateFlowState = { progress: null, waitedLong: false, starting: false };

let state: ServiceUpdateFlowState = IDLE;
const listeners = new Set<() => void>();
// The newest mounted component's way to reach the server.
const prepares: PrepareServiceUpdate[] = [];
// Each attempt (and each cancel) bumps this, so late answers of an older one are dropped.
let attempt = 0;
let installOptions: StudioServiceInstallOptions | undefined;
// The service reported held for this window's own request; once it no longer
// is, the update was cancelled elsewhere (or the hold ran out).
let holdSeen = false;
let lastRequest = 0;
let lastBlockerCheck = 0;
let waitingSince: number | null = null;
let lastAgentState: StudioServiceUpdateState | null = null;
let readBusy = false;
let checkBusy = false;
let requestBusy = false;
let cancelling = false;
// A withdrawal still being written; a new install request waits for it.
let withdrawal: Promise<unknown> | null = null;
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
// "Update now" for both: once the service runs the new version, the app installs.
let followUp: AppFollowUp | null = null;
let followUpStarted = false;
// The sidebar's way to install the app's update; null while it is not mounted.
let appInstaller: AppInstaller | null = null;
let clockTimer: number | null = null;
let forcedSeen = false;

function sessionStore(): Storage | null {
  try {
    return typeof window.sessionStorage === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function setFollowUp(next: AppFollowUp | null) {
  followUp = next;
  followUpStarted = false;
  const store = sessionStore();
  try {
    if (next === null) store?.removeItem(FOLLOW_UP_KEY);
    else store?.setItem(FOLLOW_UP_KEY, JSON.stringify({ ...next, at: Date.now() }));
  } catch {
    // Storage can be unavailable; this window still remembers it.
  }
}

/** The follow-up a reloaded window saved for the update to `serviceVersion`, if any. */
function savedFollowUp(serviceVersion: string | null): AppFollowUp | null {
  try {
    const text = sessionStore()?.getItem(FOLLOW_UP_KEY);
    if (!text) return null;
    const saved = JSON.parse(text) as Partial<AppFollowUp> & { readonly at?: unknown };
    if (typeof saved.at !== "number" || Date.now() - saved.at > FOLLOW_UP_TTL_MS) return null;
    if (saved.serviceVersion !== serviceVersion) return null;
    return {
      appVersion: typeof saved.appVersion === "string" ? saved.appVersion : null,
      serviceVersion: saved.serviceVersion ?? null,
    };
  } catch {
    return null;
  }
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
  state = { ...state, ...patch };
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
    renewals < MAX_REQUEST_RENEWALS
  ) {
    renewals += 1;
    void run({ ...previous, phase: "requesting", message: null });
    return;
  }
  setState({ progress: next });
  // The agent gave up on this install: let work start again now instead of
  // keeping the service held until someone closes the notice. Update now
  // holds it again.
  if (
    next?.phase === "failed" &&
    previous.phase !== "failed" &&
    lastAgentState?.status !== "installing"
  )
    void abandonFailedAttempt();
}

async function callPrepare(
  input: ServerPrepareServiceUpdateInput,
  timeoutMs: number,
  prepare: PrepareServiceUpdate | undefined = prepares.at(-1),
): Promise<ServerPrepareServiceUpdateResult | null> {
  if (!prepare) return null;
  // An older service without this call, one already restarting, or one too busy
  // to answer still installs: the update agent checks for itself before it does.
  return withTimeout(prepare(input), timeoutMs).catch(() => null);
}

async function readAgentState(): Promise<StudioServiceUpdateState | null> {
  const read = window.desktopBridge?.getServiceUpdateState;
  if (!read) return null;
  return withTimeout(read(), QUICK_CALL_MS).catch(() => null);
}

function sendInstallRequest(): Promise<StudioServiceUpdateState | null> {
  const install = window.desktopBridge?.installServiceUpdate;
  if (!install) return Promise.resolve(null);
  lastRequest = Date.now();
  // Older desktops ignore the options and ask for a normal install.
  return withTimeout(install(installOptions), INSTALL_REQUEST_TIMEOUT_MS);
}

// The agent may still act on an install request in these states.
const AGENT_WORKING: ReadonlySet<StudioServiceUpdateStatus> = new Set([
  "downloading",
  "downloaded",
  "waiting-for-quiet",
  "installing",
]);

// The agent will not install anything in these states: a hold left on the
// service has nothing to wait for.
const AGENT_SETTLED: ReadonlySet<StudioServiceUpdateStatus> = new Set([
  "not-managed",
  "disabled",
  "up-to-date",
  "installed",
  "manual-required",
  "error",
]);

/** The desktop reports an install request the agent has not finished. */
function hasPendingRequest(state: StudioServiceUpdateState): boolean {
  return state.pendingInstall !== undefined && state.pendingInstall !== null;
}

/**
 * Withdraws the install request. `withdrawn` is false when the desktop could
 * not save that, so the agent may still install. Older desktops cannot
 * withdraw at all; their agent installs at the next quiet moment as before.
 * `agent` is the agent's state after the withdrawal, when it could be read.
 */
async function withdrawRequest(): Promise<{
  readonly withdrawn: boolean;
  readonly agent: StudioServiceUpdateState | null;
}> {
  const cancel = window.desktopBridge?.cancelServiceUpdate;
  if (!cancel) return { withdrawn: true, agent: await readAgentState() };
  const pending = withTimeout(cancel(), QUICK_CALL_MS);
  const settled = pending.catch(() => null);
  withdrawal = settled;
  void settled.then(() => {
    if (withdrawal === settled) withdrawal = null;
  });
  try {
    return { withdrawn: true, agent: await pending };
  } catch {
    return { withdrawn: false, agent: await readAgentState() };
  }
}

function isWaitingPhase(progress: ServiceUpdateProgress | null): boolean {
  return progress?.phase === "requesting" || progress?.phase === "waiting";
}

// The agent has written nothing for a while: a pass that answered and went back
// to sleep (older agents), not one still retrying for this request.
function agentSilentSince(now: number): boolean {
  const written =
    typeof lastAgentState?.updatedAt === "string" ? Date.parse(lastAgentState.updatedAt) : NaN;
  return !Number.isFinite(written) || now - written >= REQUEST_AGAIN_MS;
}

/** Stops and holds the service's work, then asks the agent to install now. */
async function run(start: ServiceUpdateProgress): Promise<void> {
  attempt += 1;
  const current = attempt;
  waitingSince = null;
  dismissedPhase = null;
  holdSeen = false;
  // A retry times its install afresh.
  const { installingSince: _previousInstall, ...fresh } = start;
  setState({ progress: fresh, waitedLong: false });
  const prepared = await callPrepare(
    { stopWork: true, hold: true, reason: "install" },
    STOP_WORK_TIMEOUT_MS,
  );
  if (current !== attempt) return;
  holdSeen = prepared?.held === true;
  lastBlockerCheck = Date.now();
  // What the agent reports before this request is not its answer to it.
  const before = await readAgentState();
  if (current !== attempt) return;
  // A cancel written meanwhile must not land after this request.
  await withdrawal;
  if (current !== attempt) return;
  const requestedAt = Date.now();
  installOptions = {
    force: true,
    holdUntil: new Date(requestedAt + SERVICE_UPDATE_HOLD_MS).toISOString(),
    // The agent installs only the version shown here, and lets the request lapse after 10 minutes.
    ...(start.targetVersion !== null ? { version: start.targetVersion } : {}),
  };
  updateProgress((progress) => ({
    ...progress,
    phase: "requesting",
    blockers: prepared?.blockers ?? [],
    message: null,
    staleFailure: serviceFailureKey(before),
    requestedAt,
    holdUntil: requestedAt + SERVICE_UPDATE_HOLD_MS,
  }));
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
  if (readBusy) return;
  readBusy = true;
  const current = attempt;
  try {
    const next = await readAgentState();
    if (current !== attempt || next === null) return;
    lastAgentState = next;
    updateProgress((progress) => advanceServiceUpdateProgress(progress, next, Date.now()));
  } finally {
    readBusy = false;
  }
}

function checkBlockers(now: number) {
  if (!isWaitingPhase(state.progress) || checkBusy) return;
  if (now - lastBlockerCheck < BLOCKER_CHECK_MS) return;
  lastBlockerCheck = now;
  checkBusy = true;
  const current = attempt;
  void callPrepare({ stopWork: false }, QUICK_CALL_MS)
    .then((checked) => {
      // A cancel under way owns the attempt; nothing here may undo it.
      if (current !== attempt || cancelling || checked === null) return;
      if (installOptions !== undefined && checked.held === true) holdSeen = true;
      // An update ends with its hold: cancelled in another window, or settled.
      // One this window asked for ends so only once it was seen held, and
      // while it still waits (an install keeps the service held).
      const ownEnded = holdSeen && isWaitingPhase(state.progress);
      if (checked.held === false && (installOptions === undefined || ownEnded)) {
        attempt += 1;
        installOptions = undefined;
        holdSeen = false;
        setFollowUp(null);
        setState({ progress: null, waitedLong: false });
        return;
      }
      updateProgress((progress) => ({ ...progress, blockers: checked.blockers }));
      // Only this window's own request is asked again; one taken over keeps its own.
      if (installOptions === undefined) return;
      if (!isWaitingPhase(state.progress) || !checked.idle || requestBusy) return;
      const at = Date.now();
      // Nothing runs and the agent went quiet: ask again instead of waiting for its next pass.
      if (at - lastRequest < REQUEST_AGAIN_MS || !agentSilentSince(at)) return;
      requestBusy = true;
      void requestAgain(current).finally(() => {
        requestBusy = false;
      });
    })
    .finally(() => {
      checkBusy = false;
    });
}

/** Asks the agent again, after any withdrawal being written, as `run` does. */
async function requestAgain(current: number): Promise<void> {
  await withdrawal;
  if (current !== attempt || cancelling || installOptions === undefined) return;
  if (!isWaitingPhase(state.progress)) return;
  await sendInstallRequest().catch(() => null);
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
  // The app quits now; this window goes with it.
  if (restarting || current !== attempt) return;
  // The installer said why the app did not restart; the service is updated,
  // so the update ends here and the window stays as it is.
  setFollowUp(null);
  attempt += 1;
  installOptions = undefined;
  holdSeen = false;
  setState({ progress: null, waitedLong: false });
}

function dismissToast() {
  toastId = null;
  const progress = state.progress;
  if (progress === null) return;
  if (progress.phase === "failed") {
    // Done with this attempt: withdraw it and let work start again right away.
    attempt += 1;
    installOptions = undefined;
    holdSeen = false;
    setFollowUp(null);
    setState({ progress: null, waitedLong: false });
    void abandonFailedAttempt();
    return;
  }
  // The update goes on; the toast comes back when it moves on.
  dismissedPhase = progress.phase;
}

async function abandonFailedAttempt() {
  const current = attempt;
  const { agent } = await withdrawRequest();
  // An install the window stopped following (it timed out here) may still run;
  // the service stays held until it settles or the hold expires.
  if ((agent ?? lastAgentState)?.status === "installing") return;
  // A new attempt holds the service again.
  if (current !== attempt) return;
  await callPrepare({ stopWork: false, releaseHold: true }, QUICK_CALL_MS);
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
            children: view.action === "update-now" ? "Update now" : "Try again",
            onClick: () => void retryServiceUpdate(),
          },
    data: {
      hideCopyButton: view.type !== "error",
      onClose: dismissToast,
      ...(view.cancel
        ? {
            secondaryActionProps: {
              children: "Cancel update",
              onClick: () => void cancelServiceUpdate(),
            },
          }
        : {}),
    },
  });
  if (toastId === null) toastId = toastManager.add(options);
  else toastManager.update(toastId, options);
}

const STOP_UNKNOWN =
  "Stop running work and update now?\nRunning tasks will be interrupted and terminals closed. You can continue interrupted tasks after the update; one that just finished may lose its checkpoint.";

export interface StartServiceUpdateOptions {
  /** The service version to install; the agent's own release when omitted. */
  readonly targetVersion?: string | null;
  /** Once the service runs the new version, the app installs this update of its own. */
  readonly thenInstallApp?: { readonly appVersion: string | null } | null;
}

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
  const pending = serviceState?.pendingInstall ?? null;
  const holdUntil = pendingHoldUntil(serviceState);
  const now = Date.now();
  if (serviceState === null || pending === null || holdUntil === undefined || holdUntil <= now) {
    return false;
  }
  if (targetVersion !== null && pending.version !== null && pending.version !== targetVersion) {
    return false;
  }
  const requestedAt = Date.parse(pending.requestedAt);
  const base: ServiceUpdateProgress = {
    ...startServiceUpdateProgress(serviceState, pending.version ?? targetVersion),
    phase: "requesting",
    blockers,
    holdUntil,
    ...(Number.isFinite(requestedAt) ? { requestedAt, startedAt: requestedAt } : {}),
  };
  lastAgentState = serviceState;
  lastBlockerCheck = now;
  setState({
    progress: advanceServiceUpdateProgress(base, serviceState, now),
    waitedLong: false,
  });
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
): Promise<boolean> {
  const current = state.progress;
  if (state.starting || cancelling) return false;
  const thenApp = options.thenInstallApp ?? null;
  const target = options.targetVersion ?? current?.targetVersion ?? null;
  // Already under way: this press only adds the app's install to it.
  if (current !== null && !canPressUpdateAgain(current, Date.now())) {
    if (current.phase === "restarting" || current.phase === "failed") return false;
    if (thenApp !== null) setFollowUp({ ...thenApp, serviceVersion: current.targetVersion });
    return true;
  }
  if (!window.desktopBridge?.installServiceUpdate) return false;
  if (current === null && followPendingRequest(serviceState, target, [])) {
    if (thenApp !== null)
      setFollowUp({ ...thenApp, serviceVersion: state.progress?.targetVersion ?? target });
    return true;
  }
  setState({ starting: true });
  try {
    const checked = await callPrepare({ stopWork: false }, QUICK_CALL_MS);
    // A service that cannot say what runs may still be running something.
    const question = checked === null ? STOP_UNKNOWN : describeServiceUpdateStop(checked);
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
      ? retryServiceUpdateProgress(latest, lastAgentState)
      : startServiceUpdateProgress(serviceState, options.targetVersion);
  if (thenApp !== null) setFollowUp({ ...thenApp, serviceVersion: start.targetVersion });
  else if (latest === null) setFollowUp(null);
  await run({ ...start, startedAt: Date.now() });
  return true;
}

/**
 * Asks before an app restart installs an update while work runs. Resolves true
 * when the restart may go ahead: nothing runs, or the user chose to restart
 * anyway. Nothing runs and no question is asked when the service says so.
 */
export async function confirmAppRestartForUpdate(
  options: {
    readonly version?: string | null;
    /** The running work as the dialog shows it, under the summary. */
    readonly renderDetails?: (blockers: ReadonlyArray<ServiceUpdateBlocker>) => ReactNode;
  } = {},
): Promise<AppRestartChoice> {
  const checked = await callPrepare({ stopWork: false }, QUICK_CALL_MS);
  const listed = checked !== null && options.renderDetails !== undefined;
  const question =
    checked === null
      ? APP_RESTART_UNKNOWN
      : describeAppRestartWarning(checked, { version: options.version ?? null, listed });
  if (question === null) return "now";
  // Waiting is the default: the safe choice is the one Enter picks.
  const choice = requestChoiceDialog(question, {
    confirmLabel: "Restart when idle",
    alternateLabel: "Restart now",
    cancelLabel: "Cancel",
    ...(listed && checked !== null ? { details: options.renderDetails!(checked.blockers) } : {}),
  });
  if (choice === undefined) {
    const text =
      checked === null ? question : (describeAppRestartWarning(checked, options) ?? question);
    return (await ensureLocalApi().dialogs.confirm(text, { variant: "destructive" }))
      ? "now"
      : "cancel";
  }
  const picked = await choice;
  return picked === "confirm" ? "idle" : picked === "alternate" ? "now" : "cancel";
}

/** What the user chose before an update restart: now, once idle, or not at all. */
export type AppRestartChoice = "now" | "idle" | "cancel";

/**
 * Whether work still runs on the service: false when idle, null when the
 * service cannot say.
 */
export async function isServiceWorkRunning(): Promise<boolean | null> {
  const checked = await callPrepare({ stopWork: false }, QUICK_CALL_MS);
  if (checked === null) return null;
  return describeAppRestartWarning(checked) !== null;
}

/**
 * Before an app restart that takes the bundled service down with it: stops
 * running work for the update, as "Update now" does, and holds the service so
 * nothing new starts. Runs stopped this way carry the update as their cause,
 * so they continue after the restart instead of ending as cancelled. Resolves
 * true when the service answered.
 */
export async function drainWorkForAppRestart(): Promise<boolean> {
  // A short hold: should the service outlive the restart, it lets work start again soon.
  const prepared = await callPrepare(
    { stopWork: true, hold: true, reason: "app-restart" },
    STOP_WORK_TIMEOUT_MS,
  );
  return prepared !== null;
}

/** Lets work start again after a drained app restart did not happen. */
export async function releaseAppRestartDrain(): Promise<void> {
  await callPrepare({ stopWork: false, releaseHold: true, reason: "app-restart" }, QUICK_CALL_MS);
}

/** "Update now" again (or "Try again") for the update already under way. */
export function retryServiceUpdate(): Promise<boolean> {
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
  // Before the withdrawal goes out, so a check or request answered meanwhile
  // for the attempt being cancelled is dropped instead of asking again.
  attempt += 1;
  const current = attempt;
  try {
    const { withdrawn, agent } = await withdrawRequest();
    if (current !== attempt) return;
    if (agent !== null) {
      lastAgentState = agent;
      updateProgress((progress) => advanceServiceUpdateProgress(progress, agent, Date.now()));
    }
    // The agent started installing meanwhile; that cannot be withdrawn.
    if (state.progress !== null && !canRetryServiceUpdate(state.progress)) return;
    if (!withdrawn) {
      // The agent may still install, so the service stays held for it.
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
    attempt += 1;
    installOptions = undefined;
    holdSeen = false;
    setFollowUp(null);
    setState({ progress: null, waitedLong: false });
  } finally {
    cancelling = false;
  }
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
    // No answer: look again on the next state change.
    if (checked === null) return;
    // Not held (yet): another window may start an update later, so look again on
    // the next state change rather than once per window. An install the agent
    // runs on its own (at a quiet moment, or for the app's version after the app
    // updated) holds nothing, but is shown all the same.
    if (checked.held !== true) {
      if (serviceState.status === "installing") await followAgentInstall(serviceState, current);
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
      await withdrawRequest();
      if (current === attempt && state.progress === null) {
        await callPrepare({ stopWork: false, releaseHold: true }, QUICK_CALL_MS);
      }
      return;
    }
    // No request of this window's: nothing is asked again (`installOptions`
    // stays unset). A desktop that reports the pending request gives its time,
    // version and hold; without one every agent state counts.
    const pendingVersion = agent.pendingInstall?.version ?? null;
    if (!followPendingRequest(agent, pendingVersion, checked.blockers)) {
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
    // A window reloaded during "Update now" for both still installs the app after.
    const saved = savedFollowUp(readState().progress?.targetVersion ?? null);
    if (saved !== null && followUp === null) {
      followUp = saved;
      followUpStarted = false;
    }
  } finally {
    adopting = false;
  }
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
}

function registerPrepare(prepare: PrepareServiceUpdate): () => void {
  prepares.push(prepare);
  return () => {
    const index = prepares.lastIndexOf(prepare);
    if (index >= 0) prepares.splice(index, 1);
  };
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
    void adoptHeldUpdate(serviceState, prepare);
  }, [prepare, serviceState]);
  return useSyncExternalStore(subscribe, readState, readState);
}

export function resetServiceUpdateFlowForTests(): void {
  if (pollTimer !== null) window.clearInterval(pollTimer);
  if (reloadTimer !== null) window.clearTimeout(reloadTimer);
  state = IDLE;
  listeners.clear();
  prepares.length = 0;
  attempt += 1;
  installOptions = undefined;
  holdSeen = false;
  lastRequest = 0;
  lastBlockerCheck = 0;
  waitingSince = null;
  lastAgentState = null;
  renewals = 0;
  readBusy = false;
  checkBusy = false;
  requestBusy = false;
  cancelling = false;
  withdrawal = null;
  adoptChecked = false;
  adopting = false;
  pollTimer = null;
  reloadTimer = null;
  toastId = null;
  dismissedPhase = null;
  if (clockTimer !== null) window.clearInterval(clockTimer);
  clockTimer = null;
  forcedSeen = false;
  followUp = null;
  followUpStarted = false;
  appInstaller = null;
  try {
    sessionStore()?.removeItem(FOLLOW_UP_KEY);
  } catch {
    // No storage in this environment.
  }
}
