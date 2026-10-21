import type { StudioServiceUpdateState } from "@specweave-studio/contracts";

import { AGENT_SETTLED, hasPendingRequest, writtenAt } from "./serviceUpdateAgent";
import { agentOffersRelease, isOlderRelease } from "./sidebar/SidebarRestartToUpdate.logic";

/**
 * What a window keeps of "Update now" in its sessionStorage, so a reload
 * carries it on: the app's install that follows the service's, the release
 * the service's agent lacked, and the window's own install request. Storage
 * can be unavailable; the flow then remembers only what it holds itself.
 */

/** The app update that installs once the service runs `serviceVersion`. */
export interface AppFollowUp {
  readonly appVersion: string | null;
  readonly serviceVersion: string | null;
}

export interface SavedFollowUp extends AppFollowUp {
  /** When it was saved (ms). */
  readonly at: number;
}

/** The install request a window wrote, as the desktop reports it back while pending. */
export interface SavedOwnRequest {
  readonly version: string | null;
  /** ISO time the request's hold ends (`installOptions.holdUntil`). */
  readonly holdUntil: string;
  /** The work was stopped and held again once the agent had the release. */
  readonly holdAskedAgain: boolean;
  /** That stop held the work, or was refused (both false until it answered). */
  readonly held: boolean;
  readonly refusedAgain: boolean;
}

// Where a window keeps "then install the app" across a reload.
const FOLLOW_UP_KEY = "specwithcode.serviceUpdate.thenInstallApp";
// Where a window keeps, across a reload, the release the service's agent lacked.
const LACKED_RELEASE_KEY = "specwithcode.serviceUpdate.lackedRelease";
// Where a window keeps, across a reload, the install request it wrote.
const OWN_REQUEST_KEY = "specwithcode.serviceUpdate.ownRequest";
// A saved follow-up older than this belongs to an update long over.
const FOLLOW_UP_TTL_MS = 45 * 60_000;

function sessionStore(): Storage | null {
  try {
    return typeof window.sessionStorage === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function save(key: string, value: unknown): void {
  try {
    sessionStore()?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable; the window still remembers it.
  }
}

function forget(key: string): void {
  try {
    sessionStore()?.removeItem(key);
  } catch {
    // No storage: nothing was saved.
  }
}

function read(key: string): Record<string, unknown> | null {
  try {
    const text = sessionStore()?.getItem(key);
    if (!text) return null;
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Saves the follow-up as of now, or forgets it (null). */
export function saveFollowUp(next: AppFollowUp | null): void {
  if (next === null) forget(FOLLOW_UP_KEY);
  else save(FOLLOW_UP_KEY, { ...next, at: Date.now() });
}

/** Forgets the follow-up a reload would find; the window keeps its own. */
export function forgetSavedFollowUp(): void {
  forget(FOLLOW_UP_KEY);
}

export function readSavedFollowUp(): SavedFollowUp | null {
  const saved = read(FOLLOW_UP_KEY);
  if (saved === null || typeof saved.at !== "number") return null;
  if (Date.now() - saved.at > FOLLOW_UP_TTL_MS) return null;
  return {
    appVersion: text(saved.appVersion),
    serviceVersion: text(saved.serviceVersion),
    at: saved.at,
  };
}

/** The follow-up a reloaded window saved for the update to `serviceVersion`, if any. */
export function savedFollowUp(serviceVersion: string | null): AppFollowUp | null {
  const saved = readSavedFollowUp();
  if (saved === null || saved.serviceVersion !== serviceVersion) return null;
  return { appVersion: saved.appVersion, serviceVersion: saved.serviceVersion };
}

/**
 * The service finished the update a reloaded window saved a follow-up for
 * (installed after the press): only the app's install is left.
 */
export function finishedFollowUp(serviceState: StudioServiceUpdateState): AppFollowUp | null {
  const saved = readSavedFollowUp();
  if (saved === null || saved.serviceVersion === null) return null;
  if (serviceState.status !== "installed" && serviceState.status !== "up-to-date") return null;
  if (serviceState.installedVersion !== saved.serviceVersion) return null;
  const installedAt = Date.parse(serviceState.lastInstall?.at ?? "");
  if (!Number.isFinite(installedAt) || installedAt <= saved.at) return null;
  return { appVersion: saved.appVersion, serviceVersion: saved.serviceVersion };
}

/**
 * The agent answered the request a reload would install the app after, and
 * did not install that version: the saved install is forgotten, so one the
 * agent starts on its own later never installs (and quits) the app without a
 * press. A failure no window showed (it reloaded meanwhile) ends it this way,
 * and so does a request withdrawn (or lapsed) since: the desktop reports none
 * pending, the service holds nothing (`held` false), and the agent neither
 * installs nor fetches a release.
 */
export function forgetAnsweredFollowUp(
  serviceState: StudioServiceUpdateState,
  held?: boolean,
): void {
  const saved = readSavedFollowUp();
  if (saved === null) return;
  // Written before the request: not the agent's answer to it.
  const written = writtenAt(serviceState);
  if (written === null || written <= saved.at) return;
  if (serviceState.installedVersion === saved.serviceVersion) return;
  const settled = AGENT_SETTLED.has(serviceState.status) && !hasPendingRequest(serviceState);
  const withdrawn =
    held === false &&
    !hasPendingRequest(serviceState) &&
    serviceState.status !== "installing" &&
    serviceState.status !== "downloading";
  if (settled || withdrawn) forgetSavedFollowUp();
}

export function saveLackedRelease(version: string): void {
  save(LACKED_RELEASE_KEY, { version });
}

export function readSavedLackedRelease(): string | null {
  return text(read(LACKED_RELEASE_KEY)?.version);
}

export function forgetSavedLackedRelease(): void {
  forget(LACKED_RELEASE_KEY);
}

// The service version this window's request failed for want of: its agent did
// not have it. Kept (and saved for a reload) until a state offers it or shows
// the service on it, whatever happens to the failure itself.
let lackedRelease: string | null = null;

export function rememberLackedRelease(version: string | null): void {
  if (version === null) return;
  lackedRelease = version;
  saveLackedRelease(version);
}

export function readLackedRelease(): string | null {
  return lackedRelease ?? readSavedLackedRelease();
}

export function forgetLackedRelease(): void {
  lackedRelease = null;
  forgetSavedLackedRelease();
}

/** The agent no longer lacks the release this window's request failed for want of. */
export function forgetServedRelease(state: StudioServiceUpdateState): void {
  const version = readLackedRelease();
  if (version !== null && servesRelease(state, version)) forgetLackedRelease();
}

/** `state` offers `version` (or a newer release), or shows the service on it. */
export function servesRelease(state: StudioServiceUpdateState, version: string): boolean {
  return (
    agentOffersRelease(state, version) ||
    state.installedVersion === version ||
    isOlderRelease(version, state.installedVersion)
  );
}

export function saveOwnRequest(request: SavedOwnRequest): void {
  save(OWN_REQUEST_KEY, request);
}

export function readSavedOwnRequest(): SavedOwnRequest | null {
  const saved = read(OWN_REQUEST_KEY);
  const holdUntil = text(saved?.holdUntil);
  if (saved === null || holdUntil === null) return null;
  return {
    version: text(saved.version),
    holdUntil,
    holdAskedAgain: saved.holdAskedAgain === true,
    held: saved.held === true,
    refusedAgain: saved.refusedAgain === true,
  };
}

/**
 * The request this window saved before it reloaded, when the desktop reports
 * it pending: the desktop reports it back with the hold time this window gave it.
 */
export function savedOwnRequestFor(serviceState: StudioServiceUpdateState): SavedOwnRequest | null {
  const saved = readSavedOwnRequest();
  const pendingHoldTime = serviceState.pendingInstall?.holdUntil ?? "";
  if (saved === null || Date.parse(pendingHoldTime) !== Date.parse(saved.holdUntil)) return null;
  return saved;
}

export function forgetSavedOwnRequest(): void {
  forget(OWN_REQUEST_KEY);
}
