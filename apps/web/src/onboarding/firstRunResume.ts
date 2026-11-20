import type { FirstRunResumeMarker } from "@specweave-studio/contracts";

/** A marker older than this is ignored: setup was left, not reopened for a permission. */
export const FIRST_RUN_RESUME_MAX_AGE_MS = 10 * 60_000;

/**
 * Notes, before Quit & Reopen from first-run's Access step, which machines are
 * being set up, so setup reopens on Access for the same ones. Resolves once
 * the desktop app has written it; a build without the call resolves at once.
 */
export async function saveFirstRunResume(
  environmentId: string,
  setupIds: readonly string[],
  now = Date.now(),
  filesIds: readonly string[] = [],
): Promise<void> {
  await window.desktopBridge?.saveFirstRunResume?.({
    step: "access",
    environmentId,
    setupIds: [...setupIds],
    ...(filesIds.length > 0 ? { filesIds: [...filesIds] } : {}),
    at: now,
  });
}

/** Claims the marker once per launch; every later call, in any window, gets null. */
export async function takeFirstRunResume(): Promise<FirstRunResumeMarker | null> {
  try {
    return (await window.desktopBridge?.takeFirstRunResume?.()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether setup reopens on Access: a fresh marker, for this machine, whose
 * machines are all still listed, while setup is not finished.
 */
export function firstRunResumeApplies(
  marker: FirstRunResumeMarker | null,
  {
    now,
    primaryEnvironmentId,
    listedIds,
    finished,
  }: {
    readonly now: number;
    readonly primaryEnvironmentId: string | null;
    readonly listedIds: readonly string[];
    readonly finished: boolean;
  },
): marker is FirstRunResumeMarker {
  if (marker === null || finished || marker.step !== "access") return false;
  const age = now - marker.at;
  if (age < 0 || age > FIRST_RUN_RESUME_MAX_AGE_MS) return false;
  if (marker.environmentId !== primaryEnvironmentId) return false;
  return marker.setupIds.length > 0 && marker.setupIds.every((id) => listedIds.includes(id));
}
