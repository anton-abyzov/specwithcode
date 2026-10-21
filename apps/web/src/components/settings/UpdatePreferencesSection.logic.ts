import type { StudioServiceUpdateState } from "@specweave-studio/contracts";

import { isServiceErrorWithRelease } from "../sidebar/SidebarRestartToUpdate.logic";

export type ServiceUpdateAction = "check" | "install" | "none";

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
      return `${installed}. Version ${next ?? "?"} installs once no session has worked for a while.`;
    case "installing":
      return `${installed}. Installing version ${next ?? "?"}.`;
    case "installed":
      return `${installed}. Updated.`;
    case "manual-required":
      return state.message ?? `${installed}. This update needs a manual install.`;
    case "error":
      return state.message ?? `${installed}. The last update check failed.`;
  }
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
