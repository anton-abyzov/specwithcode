import { useSyncExternalStore } from "react";

type Listener = () => void;
let value: Record<string, unknown> = {};
const listeners = new Set<Listener>();

export const fixtureStore = {
  scope: "app" as "app" | "project",
  providers: [] as unknown[],
  get: () => value,
  set(next: Record<string, unknown>) {
    value = next;
    for (const listener of listeners) listener();
  },
};

export function useFixtureSettings() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => value,
  );
}
