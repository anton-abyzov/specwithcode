// Stand-ins for the stores the advisor components read: settings scope,
// scoped settings, environments, the thread shell, commands and item detail.
// Every write is recorded in window.fixtureCalls instead of reaching a server.
// Names are fictional.
import {
  DEFAULT_ADVISOR_SETTINGS,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { applyServerSettingsPatch } from "@specweave-studio/shared/serverSettings";
import { useSyncExternalStore } from "react";

export const ENVIRONMENT_ID = "build-mac";
export const ENVIRONMENT_LABEL = "Build Mac";
export const PROJECT_ID = "atlas";

declare global {
  interface Window {
    fixtureCalls: unknown[];
  }
}
window.fixtureCalls ??= [];
const record = (call: unknown) => window.fixtureCalls.push(call);

const checkedAt = "2026-11-16T15:00:00.000Z";
function provider(
  id: string,
  driver: string,
  displayName: string,
  models: ReadonlyArray<readonly [string, string]>,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    displayName,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    version: null,
    models: models.map(([slug, name]) => ({ slug, name, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  } as ServerProvider;
}

export const providers: ServerProvider[] = [
  provider("claudeAgent", "claudeAgent", "Claude", [
    ["claude-fable-5-2", "Claude Fable 5.2"],
    ["claude-opus-5-5", "Claude Opus 5.5"],
  ]),
  provider("codex", "codex", "Codex", [["gpt-6.1-sol", "GPT-6.1 Sol"]]),
];

/** The machine's settings: the advisor on with its defaults; the project overrides two fields. */
let environmentSettings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  advisor: { ...DEFAULT_ADVISOR_SETTINGS, enabled: true },
  projectSettingsOverrides: {
    [PROJECT_ID]: { advisor: { maxConsultsPerRun: 5, briefTokenBudget: 32_000 } },
  } as ServerSettings["projectSettingsOverrides"],
};
export const fixtureState = { scope: "app" as "app" | "project" };

const listeners = new Set<() => void>();
let version = 0;
function setEnvironmentSettings(next: ServerSettings) {
  environmentSettings = next;
  version += 1;
  for (const listener of listeners) listener();
}
function useVersion() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
}

function scopeValue() {
  const project = fixtureState.scope === "project";
  const resolved = resolveProjectSettings(
    environmentSettings,
    project ? (PROJECT_ID as never) : null,
  );
  const environment = {
    environmentId: ENVIRONMENT_ID,
    label: ENVIRONMENT_LABEL,
    connection: { phase: "connected" },
    serverConfig: {
      settings: environmentSettings,
      providers,
      environment: {
        platform: { os: "darwin", arch: "arm64", machine: "laptop" },
        capabilities: { advisor: true, projectSettingsOverrides: true },
      },
    },
  };
  return {
    scope: project
      ? {
          kind: "project",
          environmentIds: [ENVIRONMENT_ID],
          members: [{ environmentId: ENVIRONMENT_ID, id: PROJECT_ID }],
        }
      : { kind: "environment", environmentIds: [ENVIRONMENT_ID] },
    target: { environmentId: ENVIRONMENT_ID },
    targets: [
      {
        environmentId: ENVIRONMENT_ID,
        label: ENVIRONMENT_LABEL,
        projectId: project ? PROJECT_ID : null,
        settings: resolved.settings,
        sources: resolved.sources,
        // The raw entry, which per-field rows read to tell their own field apart.
        ...(project
          ? {
              overrides:
                (environmentSettings.projectSettingsOverrides as Record<string, unknown>)[
                  PROJECT_ID
                ] ?? {},
            }
          : {}),
      },
    ],
    environments: [environment],
    connectedEnvironments: [environment],
    groups: [],
  } as never;
}

// SettingsScopeContext
export function useSettingsScope() {
  useVersion();
  return scopeValue();
}
export const useOptionalSettingsScope = useSettingsScope;

// useScopedSettings
export function useScopedSettings() {
  useVersion();
  const project = fixtureState.scope === "project";
  const { settings } = resolveProjectSettings(
    environmentSettings,
    project ? (PROJECT_ID as never) : null,
  );
  return { ...DEFAULT_CLIENT_SETTINGS, ...settings } as never;
}
export const useScopedSettingsMixed = () => false;
export const useUpdateScopedSettings = () => (patch: { advisor?: Record<string, unknown> }) => {
  record(["update", fixtureState.scope, patch]);
  if (!patch.advisor) return;
  if (fixtureState.scope === "project") {
    const overrides = (environmentSettings.projectSettingsOverrides ?? {}) as Record<
      string,
      { advisor?: Record<string, unknown> }
    >;
    setEnvironmentSettings({
      ...environmentSettings,
      projectSettingsOverrides: {
        ...overrides,
        [PROJECT_ID]: {
          ...overrides[PROJECT_ID],
          advisor: { ...overrides[PROJECT_ID]?.advisor, ...patch.advisor },
        },
      } as ServerSettings["projectSettingsOverrides"],
    });
  } else {
    setEnvironmentSettings({
      ...environmentSettings,
      advisor: { ...environmentSettings.advisor, ...patch.advisor },
    });
  }
};
export const useClearScopedSettings = () => (keys: readonly string[]) => {
  record(["clear", fixtureState.scope, keys]);
  if (fixtureState.scope !== "project") return;
  const overrides = { ...(environmentSettings.projectSettingsOverrides ?? {}) } as Record<
    string,
    Record<string, unknown>
  >;
  const entry = { ...overrides[PROJECT_ID] };
  for (const key of keys) delete entry[key];
  overrides[PROJECT_ID] = entry;
  setEnvironmentSettings({
    ...environmentSettings,
    projectSettingsOverrides: overrides as ServerSettings["projectSettingsOverrides"],
  });
};
/** Runs a save plan the way the app does: each server write's patch applied in turn. */
export const useRunScopedPlan =
  () => async (plan: { serverWrites: ReadonlyArray<{ patch: Record<string, unknown> }> }) => {
    record(["run-plan", fixtureState.scope, plan.serverWrites.map((write) => write.patch)]);
    for (const write of plan.serverWrites) {
      setEnvironmentSettings(applyServerSettingsPatch(environmentSettings, write.patch as never));
    }
    return { savedEnvironmentCount: plan.serverWrites.length, failedEnvironments: [] };
  };
export const useClearProjectOverrides = () => async (entries: unknown, keys: unknown) => {
  record(["clear-projects", entries, keys]);
};

// SettingsScopeSentence: the page names its scope; the fixture's headings do that.
export const SettingsScopeSentence = () => null;

// state/environments, state/session, hooks/useSettings
export const usePrimaryEnvironmentId = () => ENVIRONMENT_ID;
export const useEnvironmentScope = () => true;
export const useEnvironmentsWithScope = (environments: ReadonlyArray<{ environmentId: string }>) =>
  new Set(environments.map((environment) => environment.environmentId));
export const usePrimarySettingsAvailable = () => true;
export const PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE = "Settings are unavailable.";
export function useEnvironment() {
  useVersion();
  return {
    environmentId: ENVIRONMENT_ID,
    serverConfig: {
      settings: environmentSettings,
      providers,
      environment: { capabilities: { advisor: true, threadReviewMode: true } },
    },
  };
}

// @tanstack/react-router
export const useNavigate = () => (to: unknown) => record(["navigate", to]);
const location = { pathname: "/settings/models", search: {}, hash: "", state: {} };
export const useLocation = (options?: { select?: (value: typeof location) => unknown }) =>
  options?.select ? options.select(location) : location;

// state/entities, state/threads, state/use-orchestration-command
let threadAdvisorMode: "on" | "off" | null = null;
let threadReviewMode: "on" | "off" | null = null;
export function useThreadShell() {
  useVersion();
  return {
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: "Atlas checkout",
    source: { advisorMode: threadAdvisorMode, reviewMode: threadReviewMode, purpose: null },
  };
}
export const threadEnvironment = {
  setAdvisorMode: "setAdvisorMode",
  setReviewMode: "setReviewMode",
};
type ModeInput = { advisorMode?: "on" | "off" | null; reviewMode?: "on" | "off" | null };
export const useOrchestrationCommand =
  (command: string) => async (call: { input: ModeInput }) => {
    record([command, call]);
    if (command === "setReviewMode") threadReviewMode = call.input.reviewMode ?? null;
    else threadAdvisorMode = call.input.advisorMode ?? null;
    version += 1;
    for (const listener of listeners) listener();
  };

// state/queries: consult items carry their output, so nothing is fetched.
export const useTurnItemDetail = (target: unknown) => {
  if (target !== null) record(["detail-fetch", target]);
  return { data: undefined };
};
