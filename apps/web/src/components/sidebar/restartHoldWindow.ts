import type {
  DesktopUpdatePreferences,
  StudioServiceUpdateState,
} from "@specweave-studio/contracts";

/** "Restart when idle" waits this long for running work unless Settings says otherwise. */
export const DEFAULT_FORCE_INSTALL_AFTER_MINUTES = 2;

/** Choices offered in Settings, in minutes. */
export const FORCE_INSTALL_AFTER_OPTIONS = [1, 2, 5, 10, 30, 60] as const;

/** The saved wait, or the default on desktops from before it existed. */
export function forceInstallAfterMinutes(
  preferences: Pick<DesktopUpdatePreferences, "forceInstallAfterMinutes"> | null | undefined,
): number {
  const saved = preferences?.forceInstallAfterMinutes;
  return typeof saved === "number" && Number.isFinite(saved) && saved >= 0
    ? saved
    : DEFAULT_FORCE_INSTALL_AFTER_MINUTES;
}

export function forceInstallAfterLabel(minutes: number): string {
  if (minutes === 60) return "1 hour";
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/**
 * Whether a "Restart when idle" that started at `since` has waited long
 * enough: past the window the work is stopped for the update instead.
 */
export function holdWindowElapsed(since: number, now: number, minutes: number): boolean {
  return now - since >= minutes * 60_000;
}

/** "Restarts when idle, or in 1:45" for the sidebar button while it waits. */
export function describeHoldCountdown(since: number, now: number, minutes: number): string {
  const left = Math.max(0, Math.ceil((since + minutes * 60_000 - now) / 1000));
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return `Restarts when idle, or in ${clock}`;
}

/**
 * Whether this app runs its own service, which quits with it on an update
 * restart. A fleet-installed service (launchd) keeps running through it.
 */
export function servesLocally(serviceState: StudioServiceUpdateState | null): boolean {
  return serviceState === null || serviceState.status === "not-managed";
}
