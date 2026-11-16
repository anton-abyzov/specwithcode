/**
 * Simulated machine state, RPCs, setup terminal and routing for the install step
 * fixture. Every call a real component makes is recorded on `window.fixtureCalls`
 * so the verifier can check what Run in terminal and Check again asked for.
 */
import type { ReactNode } from "react";

export { codexSignInCanSwitch, signInAccountKey } from "~/components/onboarding/signInAccount";
export { FEATURED_ACP_AGENT_IDS } from "~/providerQuickSetup";

type Call = { readonly kind: string; readonly input: unknown };
declare global {
  interface Window {
    fixtureCalls: Call[];
  }
}
window.fixtureCalls = [];
const record = (kind: string, input: unknown) => window.fixtureCalls.push({ kind, input });

// Two fictional machines: a Mac and a Windows PC.
const SYSTEMS: Record<string, "darwin" | "windows"> = {
  "office-mac": "darwin",
  "office-pc": "windows",
};
const config = (environmentId: string) => ({
  cwd: "/work",
  keybindings: [],
  environment: { platform: { os: SYSTEMS[environmentId] ?? "darwin" } },
  settings: { providerInstances: {}, providers: {} },
});

// @effect/atom-react: the row reads its machine's config, which the atom below already is.
export const useAtomValue = <T,>(value: T): T => value;

// state/server
export const serverEnvironment = {
  configValueAtom: config,
  refreshProviders: "refreshProviders",
  prepareAcpRegistryAgent: "prepareAcpRegistryAgent",
};

// state/use-atom-command
export const useAtomCommand =
  (command: string) =>
  async (args: unknown): Promise<{ _tag: "Success"; value: unknown }> => {
    record(command, args);
    return { _tag: "Success", value: { version: "1.0.0" } };
  };

// state/session and state/environments
export const useEnvironmentScope = () => true;
export const readEnvironmentScope = () => true;
export const useEnvironmentsWithScope = () => new Set(Object.keys(SYSTEMS));
export const usePrimaryEnvironmentId = () => "office-mac";
export const useEnvironment = () => null;
export const useEnvironments = () => ({ environments: [] });

// onboarding/AgentSetupPanel: the setup terminal never opens; Run in terminal is recorded.
export const AGENT_CHECK_TIMEOUT_MS = 15_000;
export const agentSetupPanelKey = () => "panel";
const panel = {
  session: null,
  available: true,
  canOperateTerminal: true,
  open: (request: unknown) => record("openSetupTerminal", request),
  close: () => undefined,
  checkingInstance: null,
  endedInstance: null,
  stopChecking: () => undefined,
};
export const useAgentSetupPanel = () => panel;
const detached = { until: null, forget: () => undefined };
export const useDetachedInstall = () => detached;
export const AgentSetupPanel = () => null;

// onboarding/WizardFrame, ClaudeSignIn, FoundAgents
export const useHeldFor = () => false;
export const ClaudeSignIn = () => null;
export const useFoundAgentPath = () => null;

// The settings layout's scope, inheritance and routing.
export const usePrimarySettingsAvailable = () => true;
export const PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE = "";
export const isProjectScopedSettingKey = () => false;
export const scopedSettingsAreMixed = () => false;
export const scopedSettingsSource = () => null;
export const listProjectOverrides = () => [];
export const isArchivedMember = () => false;
export const useOptionalSettingsScope = () => null;
export const useClearProjectOverrides = () => () => undefined;
export const useClearScopedSettings = () => () => undefined;
export const SettingInheritance = () => null;
export const SettingsScopeSentence = () => null;
export const WorkspacePageContainer = ({ children }: { readonly children: ReactNode }) => (
  <div>{children}</div>
);
export const useNavigate = () => () => undefined;
export const useLocation = () => ({ hash: "", pathname: "/settings/providers" });
export const Link = ({ children }: { readonly children: ReactNode }) => <a href="#">{children}</a>;
export const useRouter = () => ({
  navigate: () => undefined,
  state: { location: { pathname: "/settings/providers" } },
});
export const useParams = () => ({});
export const useSearch = () => ({});
