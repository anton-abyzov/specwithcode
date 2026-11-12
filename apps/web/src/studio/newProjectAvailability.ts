/**
 * Why New project cannot offer something on a machine, in words a person can
 * act on: a machine that cannot be chosen, and the GitHub option.
 */
import type { SourceControlDiscoveryResult } from "@specweave-studio/contracts";

/**
 * Why a machine in the Machine row cannot be chosen, or null when it can.
 * Checked in order: connection, access, then what its server supports.
 */
export function projectMachineUnavailableReason(input: {
  /** The connection can create projects now. */
  readonly online: boolean;
  /** Its connection status in words, such as "Offline" or "Connecting…". */
  readonly status: string;
  /** This device may run orchestration there (not a read-only connection). */
  readonly canOperate: boolean;
  /** Its server answers projects.createNew (it advertises a projects folder). */
  readonly supportsCreate: boolean;
}): string | null {
  if (!input.canOperate) return "Read-only access: this device may not create projects there.";
  if (!input.online) return `${input.status.replace(/[.…\s]*$/, "")}: it cannot be used right now.`;
  if (!input.supportsCreate) return "Needs a newer SpecWithCode to create projects.";
  return null;
}

/**
 * Why the "Create private repository on GitHub" row is off for this machine,
 * with the fix, or null when it can be offered. `pending` is true while the
 * machine is still being asked.
 */
export function newProjectGitHubUnavailableReason(input: {
  readonly discovery: SourceControlDiscoveryResult | null;
  readonly pending: boolean;
  readonly machine: string;
}): string | null {
  const github =
    input.discovery?.sourceControlProviders.find((provider) => provider.kind === "github") ?? null;
  if (github === null) {
    return input.pending
      ? `Checking GitHub on ${input.machine}…`
      : `GitHub status on ${input.machine} is unknown. Open Settings > Source Control and rescan.`;
  }
  if (github.status !== "available") {
    return `The GitHub CLI is not installed on ${input.machine}. Install it, then sign in: gh auth login`;
  }
  if (github.auth.status === "unauthenticated") {
    return `Sign in to GitHub on ${input.machine}: gh auth login`;
  }
  return null;
}

/** Said in the GitHub row when the chosen folder is used as it is. */
export const EXISTING_FOLDER_PUBLISH_NOTE =
  "Publishing applies to new repositories only. This folder keeps its own remotes; publish it from the Git menu.";
