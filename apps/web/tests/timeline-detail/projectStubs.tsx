/* With ?project=1 the fixture's thread belongs to a project, so the header menu also
   offers the project's reply style. The style is kept in the page's localStorage; nothing
   reaches a server. Without the parameter the thread has no project, as before. */
import { useSyncExternalStore, type ReactNode } from "react";

const params = new URLSearchParams(location.search);
const inProject = params.get("project") === "1";
const readOnly = params.get("replies") === "read-only";
const STYLE_KEY = "fixture.responseStyle";
const listeners = new Set<() => void>();
const readStyle = () => (localStorage.getItem(STYLE_KEY) === "detailed" ? "detailed" : "concise");
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useThreadShell() {
  return inProject ? { projectId: "fixture-project" } : undefined;
}

export function useSettingsProjectGroups() {
  return [
    {
      projectKey: "fixture-project-key",
      memberProjects: [{ environmentId: "fixture-host", id: "fixture-project" }],
    },
  ];
}

export function SettingsScopeProvider({ children }: { children: ReactNode }) {
  return children;
}

export function useScopedSettings<T>(select: (settings: { responseStyle: string }) => T): T {
  return select({ responseStyle: useSyncExternalStore(subscribe, readStyle) });
}

export const useScopedSettingsMixed = () => params.get("replies") === "mixed";
export const useScopedSettingsWriteAllowed = () => !readOnly;
export const useUpdateScopedSettings = () => (patch: { responseStyle?: string }) => {
  if (patch.responseStyle) localStorage.setItem(STYLE_KEY, patch.responseStyle);
  for (const listener of listeners) listener();
};
