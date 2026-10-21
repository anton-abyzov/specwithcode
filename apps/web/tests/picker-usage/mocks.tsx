// Fixture stand-ins for settings and server atoms. Fictional providers only.
import { Atom } from "effect/reactivity";
import { DEFAULT_UNIFIED_SETTINGS } from "@specweave-studio/contracts";
import { useSyncExternalStore } from "react";

const favorites = [
  { provider: "codex", model: "gpt-6.1-sol" },
  { provider: "codex", model: "gpt-6-astra" },
  { provider: "claudeAgent", model: "claude-opus-5-5" },
  { provider: "claudeAgent", model: "claude-fable-5-1" },
  { provider: "claudeAgent", model: "claude-sonnet-5-5" },
  { provider: "github-copilot", model: "claude-opus-5.5" },
];
let settings = { ...DEFAULT_UNIFIED_SETTINGS, favorites, timestampFormat: "12-hour" as const };
const listeners = new Set<() => void>();
const subscribe = (notify: () => void) => {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
};

export const useClientSettings = <T,>(select: (value: typeof settings) => T): T =>
  select(useSyncExternalStore(subscribe, () => settings));
export const usePrimarySettings = useClientSettings;
export const useSettings = useClientSettings;
export const useUpdateClientSettings = () => (patch: Partial<typeof settings>) => {
  settings = { ...settings, ...patch };
  for (const listener of listeners) listener();
};
export const primaryServerKeybindingsAtom = Atom.make({ bindings: [], warnings: [] });
export const ChatGptSharingControl = () => null;
export const serverEnvironment = {};
export const environmentPresentations = { presentationsAtom: Atom.make(new Map()) };
export const environmentSummaries = {};
export const useEnvironmentPresentation = () => ({ presentation: null });
