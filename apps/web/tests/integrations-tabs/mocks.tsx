import { EnvironmentId } from "@specweave-studio/contracts";
import { useSyncExternalStore } from "react";

import {
  useAtomCommand as readOnlyCommand,
  useEnvironmentQuery as scan,
} from "../connections-library/mocks";

export { projectWorkspace, deviceEnvironment, useDeviceState } from "../connections-library/mocks";

/**
 * What the guided add wrote in this page load, per machine. The fixture's
 * machines answer an add and its undo; every other edit stays read-only.
 */
const TOOL_FILES: Record<string, readonly [string, string]> = {
  codex: ["Codex", "~/.codex/config.toml"],
  claude: ["Claude Code", "~/.claude.json"],
};
const added = new Map<string, Map<string, ReadonlyArray<string>>>();
const changes = new Map<string, { environmentId: string; name: string }>();
const addListeners = new Set<() => void>();
let addVersion = 0;
/** Every add and undo a machine was sent, in order, for the verifier to read. */
const applyCalls: Array<{ environmentId: string; action: string; preview: boolean }> = [];
(window as unknown as { fixtureApplyCalls: typeof applyCalls }).fixtureApplyCalls = applyCalls;
const emptySnapshot = {
  observedAt: "2026-10-14T12:00:00Z",
  runtime: "unverified",
  truncated: false,
  sources: [],
  connections: [],
  plugins: [],
};
function changed() {
  addVersion += 1;
  for (const notify of addListeners) notify();
}

export function useAtomCommand() {
  const readOnly = readOnlyCommand();
  return async (request: {
    environmentId: string;
    input: {
      action: string;
      preview?: boolean;
      name?: string;
      tools?: ReadonlyArray<string>;
      changeId?: string;
    };
  }) => {
    const { environmentId, input } = request;
    if (input.action !== "add" && input.action !== "undo") return readOnly();
    applyCalls.push({ environmentId, action: input.action, preview: input.preview === true });
    if (input.action === "undo") {
      const change = changes.get(input.changeId ?? "");
      if (!change) return readOnly();
      added.get(change.environmentId)?.delete(change.name);
      changed();
      return { _tag: "Success" as const, value: emptySnapshot };
    }
    const name = input.name ?? "";
    const files = (input.tools ?? []).map((tool) => ({
      tool: TOOL_FILES[tool]?.[0] ?? tool,
      path: TOOL_FILES[tool]?.[1] ?? `~/.${tool}/mcp.json`,
      lines: [`Add ${name}: {"url":"••••"}`],
    }));
    if (input.preview)
      return {
        _tag: "Success" as const,
        value: { ...emptySnapshot, change: { preview: true, files } },
      };
    const id = `fixture-change-${changes.size + 1}`;
    changes.set(id, { environmentId, name });
    const servers = added.get(environmentId) ?? new Map<string, ReadonlyArray<string>>();
    servers.set(name, input.tools ?? []);
    added.set(environmentId, servers);
    changed();
    return {
      _tag: "Success" as const,
      value: { ...emptySnapshot, change: { id, preview: false, files } },
    };
  };
}

/** One object per machine and scan, as the app's own store hands out. */
const scans = new Map<string, unknown>();
export function useEnvironmentQuery(atom: Parameters<typeof scan>[0]) {
  useSyncExternalStore(
    (notify) => {
      addListeners.add(notify);
      return () => {
        addListeners.delete(notify);
      };
    },
    () => addVersion,
  );
  const result = scan(atom);
  if (!atom || "chrome" in atom || !result.data) return result;
  const key = `${atom.environmentId}:${atom.input.projectId ?? "user"}:${addVersion}`;
  if (!scans.has(key)) {
    const servers = [...(added.get(atom.environmentId) ?? [])];
    scans.set(key, {
      ...result.data,
      observedAt: new Date(Date.UTC(2026, 9, 14, 12, 0, addVersion)).toISOString(),
      connections: [
        ...result.data.connections,
        ...servers.flatMap(([name, tools]) =>
          tools.map((tool) => ({
            id: `${tool}:${tool}-user:${name}`,
            name,
            provider: tool,
            sourceId: `${tool}-user`,
            scope: "user",
            transport: "http",
            state: "configured",
            shadowed: false,
          })),
        ),
      ],
    });
  }
  return { ...result, data: scans.get(key) as typeof result.data };
}

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
