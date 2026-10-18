import type { DesktopBridge, DesktopUpdateState } from "@specweave-studio/contracts";
import { ArrowRightIcon } from "lucide-react";
import { useEffect } from "react";

import {
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateReleaseUrl,
} from "./desktopUpdate.logic";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import { toastManager } from "./ui/toast";

type DesktopUpdateShell = Pick<DesktopBridge, "openExternal">;

export async function openDesktopUpdateReleaseNotes(
  shell: DesktopUpdateShell | undefined,
  releaseUrl: string,
): Promise<void> {
  try {
    if (shell && (await shell.openExternal(releaseUrl))) return;
  } catch {
    // Surface rejected IPC calls through the same user-visible fallback.
  }
  toastManager.add({ type: "error", title: "Unable to open release notes" });
}

function ReleaseNotesLink({
  shell,
  releaseUrl,
}: {
  shell: DesktopUpdateShell;
  releaseUrl: string;
}) {
  return (
    <button
      className="ml-2 inline cursor-pointer text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
      onClick={() => {
        void openDesktopUpdateReleaseNotes(shell, releaseUrl);
      }}
      type="button"
    >
      Read more
      <ArrowRightIcon
        aria-hidden
        className="ml-1 inline size-3 -rotate-45 align-[-0.125em]"
        strokeWidth={2.25}
      />
    </button>
  );
}

const ANNOUNCED_VERSION_KEY = "studio:desktop-update-announced-version";
let announcedVersionFallback: string | null = null;

/**
 * Records that the toast for `version` was shown. Returns false when it was
 * already shown, in this window or an earlier session.
 */
function claimDownloadedAnnouncement(version: string | null): boolean {
  if (version === null) return true;
  let previous = announcedVersionFallback;
  try {
    previous = window.localStorage.getItem(ANNOUNCED_VERSION_KEY) ?? previous;
  } catch {
    // Storage can be unavailable; the in-memory copy still dedupes this window.
  }
  if (previous === version) return false;
  announcedVersionFallback = version;
  try {
    window.localStorage.setItem(ANNOUNCED_VERSION_KEY, version);
  } catch {
    // See above.
  }
  return true;
}

export function __resetDesktopUpdateAnnouncementForTests(): void {
  announcedVersionFallback = null;
  try {
    window.localStorage.removeItem(ANNOUNCED_VERSION_KEY);
  } catch {
    // No storage in this environment.
  }
}

/** Shows "Update downloaded" once per version, however many places ask. */
export function showDesktopUpdateDownloadedToast(
  shell: DesktopUpdateShell,
  state: DesktopUpdateState,
): void {
  const version = getDesktopUpdateDownloadedVersion(state);
  if (!claimDownloadedAnnouncement(version)) return;
  const releaseUrl = getDesktopUpdateReleaseUrl(version);
  toastManager.add({
    type: "success",
    title: "Update downloaded",
    description: (
      <>
        Click Restart to update at the bottom left to install it.
        {releaseUrl ? <ReleaseNotesLink releaseUrl={releaseUrl} shell={shell} /> : null}
      </>
    ),
  });
}

/**
 * Toasts "Update downloaded" when `state` reports a finished download,
 * however it got there: a background download, a click in Settings or the
 * sidebar. Once per version (see showDesktopUpdateDownloadedToast).
 */
export function announceDesktopUpdateDownloaded(
  shell: DesktopUpdateShell | undefined,
  state: DesktopUpdateState | null,
): void {
  if (!shell || state === null || state.status !== "downloaded") return;
  showDesktopUpdateDownloadedToast(shell, state);
}

/** Mount once per window: shows the downloaded toast when the state turns downloaded. */
export function useDesktopUpdateDownloadedToast(state: DesktopUpdateState | null): void {
  useEffect(() => {
    announceDesktopUpdateDownloaded(
      typeof window === "undefined" ? undefined : window.desktopBridge,
      state,
    );
  }, [state]);
}

/** Renders nothing; announces a finished app download once per version. */
export function DesktopUpdateDownloadedToast(): null {
  useDesktopUpdateDownloadedToast(useDesktopUpdateState());
  return null;
}
