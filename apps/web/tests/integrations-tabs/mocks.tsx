import { EnvironmentId } from "@specweave-studio/contracts";
import { useSyncExternalStore } from "react";

export {
  projectWorkspace,
  useAtomCommand,
  useEnvironmentQuery,
} from "../connections-library/mocks";

/**
 * What the page is shown: `ready` (two machines, both connected), `single`
 * (one machine), `other` (setting up the machine you are not sitting at),
 * `offline`, `viewonly` and `unavailable`.
 */
export type FixtureState = "ready" | "single" | "other" | "offline" | "viewonly" | "unavailable";

const params = new URLSearchParams(location.search);
export const fixtureState = (params.get("state") ?? "ready") as FixtureState;

const here = {
  // The ids the MCP matrix fixture answers for: "mac" declares PostHog, "remote" Remote analytics.
  environmentId: EnvironmentId.make("mac"),
  label: "Desk",
  connection: { phase: "connected" },
  serverConfig: null,
  entry: { target: { _tag: "PrimaryConnectionTarget", httpBaseUrl: location.origin } },
};
const other = {
  environmentId: EnvironmentId.make("remote"),
  label: "Studio Mini",
  connection: { phase: fixtureState === "offline" ? "available" : "connected" },
  serverConfig: null,
  entry: { target: { _tag: "RemoteConnectionTarget" } },
};
const environments = fixtureState === "single" ? [here] : [here, other];

let machine: string =
  fixtureState === "unavailable"
    ? "gone"
    : fixtureState === "other" || fixtureState === "offline"
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
export const useEnvironmentScopeAccess = (environmentId: string | null) =>
  environmentId === null ? "unknown" : mayChange ? "granted" : "denied";
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
