import {
  DEFAULT_SERVER_SETTINGS,
  type ServerProvider,
  type ServerSettings,
} from "@specweave-studio/contracts";
import { type ReactNode, useSyncExternalStore } from "react";

// One connected machine whose environment settings live in this module.
let settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
let providers: ReadonlyArray<ServerProvider> = [];
const listeners = new Set<() => void>();
export const fixtureState = {
  get settings() {
    return settings;
  },
  set(next: { settings?: ServerSettings; providers?: ReadonlyArray<ServerProvider> }) {
    settings = next.settings ?? settings;
    providers = next.providers ?? providers;
    for (const listener of listeners) listener();
  },
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const useFixtureSettings = () => useSyncExternalStore(subscribe, () => settings);

export const useScopedSettings = useFixtureSettings;
export const useScopedSettingsMixed = () => false;
export const useScopedSettingSource = () => "environment";
export const useUpdateScopedSettings = () => (patch: Partial<ServerSettings>) =>
  fixtureState.set({ settings: { ...settings, ...patch } });
export const useClearProjectOverrides = () => () => undefined;
export const useClearScopedSettings = () => () => undefined;

const environment = () => ({
  environmentId: "m4",
  label: "This Mac",
  serverConfig: { settings, providers },
  connection: { phase: "connected" },
});
export const useNamedEnvironments = () => {
  useFixtureSettings();
  return { environments: [environment()] };
};
const scope = () => ({
  scope: { kind: "environment" },
  target: { environmentId: "m4", projectId: null, settings, sources: {} },
  targets: [],
  connectedEnvironments: [environment()],
});
export const useSettingsScope = scope;
export const useOptionalSettingsScope = () => null;

export const usePrimaryEnvironmentId = () => "m4";
export const useEnvironmentScope = () => true;
export const useEnvironmentsWithScope = () => new Set(["m4"]);
export const useEnvironments = () => ({ environments: [environment()] });
export const useNavigate = () => () => undefined;
export const useLocation = () => ({ hash: "", pathname: "/settings" });
export const Link = ({ children }: { readonly children: ReactNode }) => <a href="#">{children}</a>;
export const usePrimarySettingsAvailable = () => true;
export const PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE = "";
export const isProjectScopedSettingKey = () => false;
export const scopedSettingsAreMixed = () => false;
export const scopedSettingsSource = () => null;
export const listProjectOverrides = () => [];
export const isArchivedMember = () => false;
export const SettingInheritance = () => null;
export const SettingsScopeSentence = () => null;
export const WorkspacePageContainer = ({ children }: { readonly children: ReactNode }) => (
  <div>{children}</div>
);
export const useFolderTeamRulesSummary = () => undefined;
export const useProjectFolderCheck = () => null;
export const useSettingsProjectGroups = () => [];
export const useBrowserDefaults = () => ({ profiles: [] });
export const ProviderLimitSettings = () => null;
export const ModelLanesSettings = () => null;
export const TaskRoutingSettings = () => null;
export const ComputerUsePermissionSetup = () => null;
export const AccessGrantsList = () => null;
export const useRouter = () => ({
  navigate: () => undefined,
  state: { location: { pathname: "/" } },
});
export const useParams = () => ({});
export const useSearch = () => ({});
export const useCanGoBack = () => false;
export const useChildMatches = () => [];
export const Outlet = () => null;
export const createFileRoute = () => (options: object) => options;
export const redirect = (options: object) => options;
export const isRedirect = () => false;
