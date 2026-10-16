/**
 * Double-clicking a project in the sidebar asks that project's page to open its
 * settings on General with the name ready to edit. The first click already
 * navigates there, so the page may mount after the request: it is kept briefly
 * for the page of that project to take.
 */
import { useEffect, useSyncExternalStore } from "react";

export const PROJECT_SETTINGS_REQUEST_TTL_MS = 10_000;

/** Where the dialog opens: a tab, and optionally a row to scroll to and highlight. */
export interface ProjectSettingsRequestTarget {
  readonly tab: string;
  readonly row?: string;
}

const pending = new Map<string, { at: number; target: ProjectSettingsRequestTarget | null }>();
const listeners = new Set<() => void>();
function emit() {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function requestProjectSettings(
  projectKey: string,
  now: number = Date.now(),
  target: ProjectSettingsRequestTarget | null = null,
): void {
  pending.set(projectKey, { at: now, target });
  emit();
}

/** Removes a fresh request for this project; true when there was one. */
export function takeProjectSettingsRequest(projectKey: string, now: number = Date.now()): boolean {
  return takeRequest(projectKey, now) !== undefined;
}

function takeRequest(projectKey: string, now: number) {
  const request = pending.get(projectKey);
  if (request === undefined) return undefined;
  pending.delete(projectKey);
  return now - request.at <= PROJECT_SETTINGS_REQUEST_TTL_MS ? request : undefined;
}

/** Calls `onRequest` when a request for this project is waiting or arrives. */
export function useProjectSettingsRequest(
  projectKey: string,
  onRequest: (target: ProjectSettingsRequestTarget | null) => void,
): void {
  const waiting = useSyncExternalStore(
    subscribe,
    () => pending.has(projectKey),
    () => false,
  );
  useEffect(() => {
    if (!waiting) return;
    const request = takeRequest(projectKey, Date.now());
    if (request) onRequest(request.target);
  }, [waiting, projectKey, onRequest]);
}
