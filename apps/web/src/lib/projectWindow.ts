import type { DesktopOpenProjectWindowInput } from "@specweave-studio/contracts";

import { toastManager } from "../components/ui/toast";

// The desktop shell rejects a longer window title.
const PROJECT_WINDOW_TITLE_MAX_LENGTH = 256;

/**
 * Whether this client can open a project in its own window. False in the
 * browser and on desktop builds that predate project windows, where every
 * entry point for the action stays hidden.
 */
export function canOpenProjectWindow(): boolean {
  return (
    typeof window !== "undefined" && typeof window.desktopBridge?.openProjectWindow === "function"
  );
}

/**
 * The project this window was opened for, or null in the main window, in the
 * browser and on desktop builds that predate project windows.
 */
export function ownProjectWindowKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.desktopBridge?.getWindowProjectKey?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether to offer opening this project in its own window. Not offered from
 * inside that project's own window, where it would only focus the window the
 * user is already in.
 */
export function canOpenProjectWindowFor(projectKey: string | null | undefined): boolean {
  if (!canOpenProjectWindow()) return false;
  return projectKey == null || ownProjectWindowKey() !== projectKey;
}

/**
 * Opens the project in its own window, or brings that window forward when the
 * project already has one.
 */
export async function openProjectWindow(input: {
  readonly projectKey: string;
  readonly title?: string | undefined;
}): Promise<void> {
  if (!canOpenProjectWindow()) return;
  const request: DesktopOpenProjectWindowInput = {
    projectKey: input.projectKey,
    ...(input.title ? { title: input.title.slice(0, PROJECT_WINDOW_TITLE_MAX_LENGTH) } : {}),
  };
  try {
    await window.desktopBridge?.openProjectWindow?.(request);
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Could not open project window",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
}

/**
 * True in a desktop window opened for a single project. The shell tells each
 * window its role through the bridge; the URL carries only the route.
 */
export function isProjectWindow(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.desktopBridge?.getWindowRole?.() === "project";
  } catch {
    return false;
  }
}
