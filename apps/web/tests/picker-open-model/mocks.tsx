// Fixture stand-ins for settings and server atoms. Fictional providers and one fictional machine.
import { Atom } from "effect/reactivity";
import { DEFAULT_UNIFIED_SETTINGS } from "@specweave-studio/contracts";
import { useSyncExternalStore } from "react";

const favorites = [{ provider: "claudeAgent", model: "claude-opus-5-5" }];
let settings = {
  ...DEFAULT_UNIFIED_SETTINGS,
  favorites,
  timestampFormat: "12-hour" as const,
  modelLanes: { complex: [], routine: [] },
};
const listeners = new Set<() => void>();
const subscribe = (notify: () => void) => {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
};

export const useClientSettings = <T,>(select?: (value: typeof settings) => T): T =>
  (select ?? ((value) => value as T))(useSyncExternalStore(subscribe, () => settings));
export const usePrimarySettings = useClientSettings;
export const useSettings = useClientSettings;
export const useEnvironmentSettings = (
  _id: unknown,
  select?: (value: typeof settings) => unknown,
) => useClientSettings(select as never);
export const useUpdateClientSettings = () => (patch: Partial<typeof settings>) => {
  settings = { ...settings, ...patch };
  for (const listener of listeners) listener();
};
export const useEnvironmentIdentificationMode = () => "auto";
export const PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE = "Settings are unavailable.";
export const usePrimarySettingsAvailable = () => true;
export const mergeEnvironmentSettings = <A extends object, B extends object>(
  server: A,
  client: B,
) => ({
  ...server,
  ...client,
});
export const EMPTY_SERVER_PROVIDERS: ReadonlyArray<never> = [];
export const updateOutdatedServer = { label: "updateOutdatedServer" };
export const usePrimaryEnvironmentId = () => "env-m4";
export const useEnvironments = () => ({ environments: [] });
export const persistClientSettingsPatch = (patch: Partial<typeof settings>) => {
  settings = { ...settings, ...patch };
  for (const notify of listeners) notify();
};
export const primaryServerKeybindingsAtom = Atom.make({ bindings: [], warnings: [] });
export const ChatGptSharingControl = () => null;
export const serverEnvironment = { refreshProviders: { label: "refreshProviders" } };
export const environmentPresentations = { presentationsAtom: Atom.make(new Map()) };
export const environmentSummaries = {};
export const useEnvironmentPresentation = () => ({ presentation: null });
export const useEnvironment = () => null;

// One fictional machine, M4, which this window belongs to.
const nicknames = {
  "env-m4": { name: "M4", updatedAt: "2026-11-10T12:00:00.000Z", color: "violet", icon: "laptop" },
};
export const environmentServerConfigsAtom = Atom.make(
  new Map([
    [
      "env-m4",
      {
        environment: {
          environmentId: "env-m4",
          label: "Fixture MacBook",
          platform: { os: "darwin", arch: "arm64", machine: "laptop" },
        },
        settings: { machineNicknames: nicknames },
      },
    ],
  ]),
);
export const usePrimaryEnvironment = () => ({ environmentId: "env-m4", label: "Fixture MacBook" });
