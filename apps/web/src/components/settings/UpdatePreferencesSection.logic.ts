import type {
  DesktopUpdatePreferences,
  StudioServiceUpdateState,
} from "@specweave-studio/contracts";

import { formatPauseTime } from "../serviceUpdateRunView";
import {
  isServiceErrorWithRelease,
  serviceRefusalText,
} from "../sidebar/SidebarRestartToUpdate.logic";

export type ServiceUpdateAction = "check" | "install" | "none";

/** An automatic service install pauses running work after this long unless Settings says otherwise. */
export const DEFAULT_PAUSE_WORK_AFTER_MINUTES = 10;

/** Choices offered in Settings, in minutes; none below 10, since the agent passes every 10 minutes. */
export const PAUSE_WORK_AFTER_OPTIONS = [10, 30, 60] as const;

/** The saved wait, or the default on desktops from before it existed. */
export function pauseWorkAfterMinutes(
  preferences: Pick<DesktopUpdatePreferences, "pauseWorkAfterMinutes"> | null | undefined,
): number {
  const saved = preferences?.pauseWorkAfterMinutes;
  return typeof saved === "number" && Number.isFinite(saved) && saved >= 1
    ? saved
    : DEFAULT_PAUSE_WORK_AFTER_MINUTES;
}

/** One line under "Studio service" saying where its update stands. */
export function describeServiceUpdate(state: StudioServiceUpdateState): string {
  const installed = state.installedVersion
    ? `Version ${state.installedVersion}`
    : "Version unknown";
  const next = state.downloadedVersion ?? state.availableVersion;
  if (runsPendingVersion(state)) return `${installed}. Up to date.`;
  switch (state.status) {
    case "not-managed":
      return "No SpecWithCode service installed by the fleet installer was found on this computer.";
    case "starting":
      return `${installed}. Checking for updates soon.`;
    case "disabled":
      return `${installed}. Automatic checks are off.`;
    case "up-to-date":
      return `${installed}. Up to date.`;
    case "available":
      return `${installed}. Version ${next ?? "?"} is available.`;
    case "downloading":
      return `${installed}. Downloading version ${next ?? "?"}.`;
    case "downloaded":
      return `${installed}. Version ${next ?? "?"} is ready to install.`;
    case "waiting-for-quiet":
      return state.automaticPauseAt
        ? `${installed}. Version ${next ?? "?"} installs at ${formatPauseAt(state.automaticPauseAt)}; running turns pause then and continue after the update.`
        : `${installed}. Version ${next ?? "?"} installs once running work finishes, or press Update now.`;
    case "installing":
      return `${installed}. Installing version ${next ?? "?"}.`;
    case "installed":
      return `${installed}. Updated.`;
    case "manual-required":
      return state.message ?? `${installed}. This update needs a manual install.`;
    case "error":
      return state.message !== null
        ? serviceRefusalText(state.message)
        : `${installed}. The last update check failed.`;
  }
}

/** The pause time in the person's locale, or the raw value when it does not parse. */
function formatPauseAt(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? formatPauseTime(ms) : value;
}

/** A stale available, downloaded or waiting state for the version the service already runs. */
function runsPendingVersion(state: StudioServiceUpdateState): boolean {
  if (
    state.status !== "available" &&
    state.status !== "downloaded" &&
    state.status !== "waiting-for-quiet"
  ) {
    return false;
  }
  const next = state.downloadedVersion ?? state.availableVersion;
  return next !== null && next === state.installedVersion;
}

export function resolveServiceUpdateAction(state: StudioServiceUpdateState): ServiceUpdateAction {
  if (state.status === "not-managed" || state.status === "installing") return "none";
  // No agent identity: a service the app cannot update (Linux), so nothing to check.
  if (state.status === "manual-required" && state.identity === null) return "none";
  if (runsPendingVersion(state)) return "check";
  if (
    state.status === "available" ||
    state.status === "downloaded" ||
    state.status === "waiting-for-quiet"
  ) {
    return "install";
  }
  // The last pass was refused for a fault Update now gets past, and the agent
  // has a newer release on disk: Update now installs it, and the refusal
  // stays shown beside it. Any other failure offers a check.
  if (isServiceErrorWithRelease(state)) return "install";
  return "check";
}
