import { EnvironmentId } from "@specweave-studio/contracts";
import { useSyncExternalStore } from "react";

export {
  projectWorkspace,
  deviceEnvironment,
  useAtomCommand,
  useDeviceState,
  useEnvironmentQuery,
} from "../connections-library/mocks";

/** Only what the built-in tools block reads: the operating system and three switches. */
const machineConfig = (os: "darwin" | "linux") => ({
  environment: { platform: { os } },
  settings: {
    enableAgentComputerAccess: true,
    enableAgentBrowserAccess: os === "darwin",
    enableDeviceSupport: true,
  },
});

/**
 * What the page is shown: `ready` (two machines, both connected), `single`
 * (one machine), `other` (setting up the machine you are not sitting at),
 * `offline`, `connecting`, `viewonly`, `noterminal` (may change settings and
 * files, may not run commands) and `unavailable`.
 */
export type FixtureState =
  | "ready"
  | "single"
  | "other"
  | "offline"
  | "connecting"
  | "viewonly"
  | "noterminal"
  | "unavailable";

const params = new URLSearchParams(location.search);
export const fixtureState = (params.get("state") ?? "ready") as FixtureState;

const here = {
  // The ids the MCP matrix fixture answers for: "mac" declares PostHog, "remote" Remote analytics.
  environmentId: EnvironmentId.make("mac"),
  label: "Desk",
  connection: { phase: "connected" },
  serverConfig: machineConfig("darwin"),
  entry: { target: { _tag: "PrimaryConnectionTarget", httpBaseUrl: location.origin } },
};
const other = {
  environmentId: EnvironmentId.make("remote"),
  label: "Loft Mini",
  connection: {
    phase:
      fixtureState === "offline"
        ? "error"
        : fixtureState === "connecting"
          ? "connecting"
          : "connected",
  },
  serverConfig: machineConfig("linux"),
  entry: { target: { _tag: "RemoteConnectionTarget" } },
};
const environments = fixtureState === "single" ? [here] : [here, other];

let machine: string =
  fixtureState === "unavailable"
    ? "gone"
    : fixtureState === "other" || fixtureState === "offline" || fixtureState === "connecting"
      ? other.environmentId
      : here.environmentId;
const listeners = new Set<() => void>();
const useMachine = () =>
  useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    () => machine,
  );

function scopeContext(selected: string) {
  const environment = environments.find((candidate) => candidate.environmentId === selected);
  const connected = environment?.connection.phase === "connected" ? [environment] : [];
  return {
    search: { machine: selected },
    singleEnvironment: true,
    groups: [],
    environments,
    connectedEnvironments: connected,
    environment: connected[0] ?? null,
    targets: [],
    target: null,
    scope: environment
      ? {
          kind: "environment",
          environmentId: environment.environmentId,
          label: environment.label,
          members: [],
          environmentIds: [environment.environmentId],
        }
      : {
          kind: "unavailable",
          reason: "environment-missing",
          label: "Unavailable selection",
          message: "This environment is no longer available.",
          members: [],
          environmentIds: [],
        },
    selectScope: (next: { machine?: string }) => {
      if (!next.machine) return;
      machine = next.machine;
      for (const notify of listeners) notify();
    },
  };
}

export const useSettingsScope = () => scopeContext(useMachine());
export const useOptionalSettingsScope = useSettingsScope;
export const useNamedEnvironments = () => ({ environments, isReady: true });
export const useEnvironments = useNamedEnvironments;
export const useEnvironment = (environmentId: string | null) =>
  environments.find((candidate) => candidate.environmentId === environmentId) ?? null;
export const usePrimaryEnvironmentId = () => here.environmentId;
export const usePrimaryEnvironment = () => here;
export const useServerConfigs = () => new Map();

const mayChange = fixtureState !== "viewonly";
export const useEnvironmentScope = () => mayChange;
export const useEnvironmentsWithScope = (
  targets: ReadonlyArray<{ readonly environmentId: string }>,
): ReadonlySet<string> => new Set(mayChange ? targets.map((target) => target.environmentId) : []);
export const useEnvironmentScopeAccess = (environmentId: string | null, scope?: string) =>
  environmentId === null
    ? "unknown"
    : !mayChange || (fixtureState === "noterminal" && scope === "terminal:operate")
      ? "denied"
      : "granted";
export const readEnvironmentScope = () => mayChange;
export const awaitEnvironmentScope = async () => mayChange;
export const environmentSession = {};

export const useMachineNickname = (_id: string, label?: string | null) => label ?? "";
export const useMachineNicknames = () => (id: string, label?: string | null) => label ?? id;
export const machineNickname = (id: string, label?: string | null) => label ?? id;

/** Rows in the fixture own no stored setting, so nothing is ever overridden. */
export const useClearProjectOverrides = () => () => {};
export const useClearScopedSettings = () => () => {};

/** Bundled by modules the fixture mounts but never drives. */
export const useScopedSettings = () => ({});
export const useUpdateScopedSettings = () => () => {};
export const useScopedSettingsMixed = () => false;
export const usePreparedConnection = () => null;
export const useThreadShell = () => null;
export const readEnvironmentScopeAccess = () => (mayChange ? "granted" : "denied");
