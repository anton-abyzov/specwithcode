// Fixture stand-ins for settings and server atoms. Fictional providers and machines only.
import { Atom } from "effect/reactivity";
import { DEFAULT_UNIFIED_SETTINGS } from "@specweave-studio/contracts";
import { useSyncExternalStore } from "react";

const favorites = [
  { provider: "claudeAgent", model: "claude-opus-5-5" },
  { provider: "claudeAgent", model: "claude-fable-5-2" },
  { provider: "copilot-enterprise", model: "claude-opus-5.5" },
  { provider: "copilot-personal", model: "claude-opus-5.5" },
  { provider: "codex", model: "gpt-6.1-sol" },
  { provider: "openai-api", model: "gpt-6.1-sol" },
];
let settings = {
  ...DEFAULT_UNIFIED_SETTINGS,
  favorites,
  timestampFormat: "12-hour" as const,
  modelLanes: { complex: [{ instanceId: "claudeAgent", model: "claude-opus-5-5" }], routine: [] },
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
export const primaryServerKeybindingsAtom = Atom.make({ bindings: [], warnings: [] });
export const ChatGptSharingControl = () => null;
export const serverEnvironment = { refreshProviders: { label: "refreshProviders" } };
// The limits scene sets `globalThis.__fixturePresentations` before the first render.
export const environmentPresentations = {
  presentationsAtom: Atom.make(
    () =>
      (globalThis as { __fixturePresentations?: Map<string, unknown> }).__fixturePresentations ??
      new Map(),
  ),
};
export const environmentSummaries = {};
export const useEnvironmentPresentation = () => ({ presentation: null });

// Two fictional machines: a laptop named M4 and a mini named M1, with chosen colors.
const machine = (
  environmentId: string,
  label: string,
  kind: string,
  nicknames: Record<string, unknown>,
) => ({
  environment: { environmentId, label, platform: { os: "darwin", arch: "arm64", machine: kind } },
  settings: { machineNicknames: nicknames },
});
const machinesScene = new URLSearchParams(location.search).get("scene") === "machines";
const nicknames = {
  "env-m4": { name: "M4", updatedAt: "2026-11-10T12:00:00.000Z", color: "violet", icon: "laptop" },
  "env-m1": { name: "M1", updatedAt: "2026-11-10T12:00:00.000Z", color: "teal", icon: "mac-mini" },
  // The narrow-chip scene: a wide label someone chose.
  ...(machinesScene
    ? {
        "env-ww": {
          name: "Workstation W",
          updatedAt: "2026-11-10T12:00:00.000Z",
          color: "amber",
          icon: "desktop",
          short: "WWW",
        },
      }
    : {}),
};
export const environmentServerConfigsAtom = Atom.make(
  new Map([
    ["env-m4", machine("env-m4", "Fixture MacBook", "laptop", nicknames)],
    ["env-m1", machine("env-m1", "Fixture mini", "mac-mini", nicknames)],
    // The narrow-chip scene adds a machine with a long name and no nickname.
    ...(machinesScene
      ? [
          ["env-lm", machine("env-lm", "linux-mini", "server", nicknames)] as const,
          ["env-ww", machine("env-ww", "Workstation W", "desktop", nicknames)] as const,
        ]
      : []),
  ]),
);
// The window in the fixture belongs to M4.
export const usePrimaryEnvironment = () => ({ environmentId: "env-m4", label: "Fixture MacBook" });
