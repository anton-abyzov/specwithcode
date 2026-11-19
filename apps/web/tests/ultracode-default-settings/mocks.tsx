import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@specweave-studio/contracts";
import { type ReactNode, useSyncExternalStore } from "react";

// One connected machine whose environment settings live in this module.
let settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
const listeners = new Set<() => void>();
export const fixtureState = {
  get settings() {
    return settings;
  },
  patches: [] as Partial<ServerSettings>[],
  set(next: ServerSettings) {
    settings = next;
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
export const useScopedSettingsWriteAllowed = () => true;
export const useUpdateScopedSettings = () => (patch: Partial<ServerSettings>) => {
  fixtureState.patches.push(patch);
  fixtureState.set({ ...settings, ...patch });
};
export const useClearProjectOverrides = () => () => undefined;
export const useClearScopedSettings = () => () => undefined;

const environment = () => ({
  environmentId: "m4",
  label: "This Mac",
  serverConfig: { settings, providers: [] },
  connection: { phase: "connected" },
});
const target = () => ({ environmentId: "m4", label: "This Mac", projectId: null, settings });
export const useSettingsScope = () => {
  useFixtureSettings();
  return {
    scope: { kind: "environment" },
    target: target(),
    targets: [target()],
    connectedEnvironments: [environment()],
  };
};
export const useOptionalSettingsScope = () => null;

export const usePrimaryEnvironmentId = () => "m4";
export const useEnvironmentScope = () => true;
export const useEnvironmentsWithScope = () => new Set(["m4"]);
export const useNavigate = () => () => undefined;
const location = { hash: "", pathname: "/settings/agents", state: {} };
export const useLocation = (options?: { select?: (value: typeof location) => unknown }) =>
  options?.select ? options.select(location) : location;
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
