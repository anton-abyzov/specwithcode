import { useLayoutEffect, useSyncExternalStore } from "react";
import { parseProjectWorkspaceSearch, type ProjectWorkspaceSearch } from "./projectPaneThreads";

const STORAGE_KEY = "studio:project-return:v1";
const CHANGED = "studio:project-return-changed";
const LIMIT = 100;
// The sidebar group is the navigation identity. Exact checkout and thread environment
// live in the value: returning to a group must not substitute its default machine.
const keyOf = (projectKey: string) => JSON.stringify([projectKey]);
function snapshot(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "{}";
  } catch {
    return "{}";
  }
}
function entries(raw: string): Record<string, ProjectWorkspaceSearch> {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, ProjectWorkspaceSearch>)
      : {};
  } catch {
    return {};
  }
}
function subscribe(listener: () => void) {
  window.addEventListener(CHANGED, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGED, listener);
    window.removeEventListener("storage", listener);
  };
}
/** A sidebar return only. Ordinary project links continue to mean overview. */
export function projectReturnSearch(
  projectKey: string,
  checkout?: string,
  raw = snapshot(),
): ProjectWorkspaceSearch {
  const saved = entries(raw)[keyOf(projectKey)];
  const parsed =
    saved && typeof saved === "object" ? parseProjectWorkspaceSearch({ ...saved }) : {};
  const destinationCheckout = parsed.checkout ?? checkout;
  return {
    ...(destinationCheckout ? { checkout: destinationCheckout } : {}),
    ...(parsed.thread
      ? {
          thread: parsed.thread,
          ...(parsed.threadEnvironment ? { threadEnvironment: parsed.threadEnvironment } : {}),
          restoreThread: true,
        }
      : {}),
  };
}
export function useProjectReturnSearch(projectKey: string, checkout?: string) {
  const raw = useSyncExternalStore(subscribe, snapshot, () => "{}");
  return projectReturnSearch(projectKey, checkout, raw);
}
/** Called by the active route, never by shell/activity subscriptions or hidden pages. */
export function rememberProjectDestination(
  projectKey: string,
  search: ProjectWorkspaceSearch,
): void {
  if (search.restoreThread) return;
  const values = entries(snapshot());
  const key = keyOf(projectKey);
  const next = parseProjectWorkspaceSearch({ ...search });
  if (JSON.stringify(values[key]) === JSON.stringify(next)) return;
  delete values[key];
  const bounded = Object.fromEntries([...Object.entries(values), [key, next]].slice(-LIMIT));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bounded));
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    /* Storage can be unavailable; navigation still works. */
  }
}
export function useRememberProjectDestination(
  projectKey: string | null,
  search: ProjectWorkspaceSearch,
) {
  const { thread, threadEnvironment, checkout, restoreThread } = search;
  useLayoutEffect(() => {
    if (projectKey !== null)
      rememberProjectDestination(projectKey, {
        ...(thread ? { thread } : {}),
        ...(threadEnvironment ? { threadEnvironment } : {}),
        ...(checkout ? { checkout } : {}),
        ...(restoreThread ? { restoreThread } : {}),
      });
  }, [projectKey, thread, threadEnvironment, checkout, restoreThread]);
}
