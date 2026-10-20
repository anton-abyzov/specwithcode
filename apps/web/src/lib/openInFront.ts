/**
 * Where a link opens so the reader sees it. The viewer overlay sits in front of
 * the app, so a file or pull request the app would show in its side panel
 * would land behind it; while the overlay is open those open in the overlay
 * instead, in the viewer's place with Back to it.
 */
import type { ScopedThreadRef } from "@specweave-studio/contracts";

import { useRightPanelStore } from "../rightPanelStore";
import {
  useViewerOverlayStore,
  type ViewerFileTarget,
  type ViewerPullRequestTarget,
} from "../viewerOverlayStore";

/** True while the viewer overlay is in front of the app. */
export function viewerOverlayInFront(): boolean {
  return useViewerOverlayStore.getState().active !== null;
}

/** Opens a file in the overlay when it is in front, else in the thread's side panel. */
export function openFileInFront(target: ViewerFileTarget): void {
  const overlay = useViewerOverlayStore.getState();
  if (overlay.active !== null) {
    overlay.showLinked({ kind: "file", file: target });
    return;
  }
  useRightPanelStore.getState().openFile(target.threadRef, target.path, target.line);
}

/**
 * Opens a pull request in the overlay when it is in front. Returns false when
 * the overlay is not open, so the caller opens it where it always has.
 */
export function openPullRequestInFront(target: ViewerPullRequestTarget): boolean {
  const overlay = useViewerOverlayStore.getState();
  if (overlay.active === null) return false;
  overlay.showLinked({ kind: "pull-request", pullRequest: target });
  return true;
}

/**
 * Closes the overlay so what opens next in the app (the in-app browser, a
 * panel the reader asked for) is in front instead of behind it.
 */
export function stepOutOfViewerOverlay(): void {
  const overlay = useViewerOverlayStore.getState();
  if (overlay.active !== null) overlay.close(overlay.active.key);
}

/** Moves a pull request from the overlay to the thread's side panel, which it reveals. */
export function openPullRequestInPanel(panel: NonNullable<ViewerPullRequestTarget["panel"]>): void {
  stepOutOfViewerOverlay();
  useRightPanelStore.getState().openPullRequest(panel.ref as ScopedThreadRef, panel.target);
}
