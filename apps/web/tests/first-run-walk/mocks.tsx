// Stand-ins for everything first-run setup would ask a server, the desktop shell
// or the sign-in service: one machine, no account, Full access not answered yet,
// one project to import. The steps, the frame and their footers are the app's own.
import { DEFAULT_SERVER_SETTINGS } from "@specweave-studio/contracts";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";

const params = new URLSearchParams(location.search);
export const fixture = {
  entry: params.get("entry") === "start" ? "start" : "connection",
  theme: params.get("theme") === "dark" ? "dark" : "light",
  calls: [] as unknown[][],
};
Object.assign(window, { fixtureCalls: fixture.calls });
const record =
  (name: string, result: unknown = undefined) =>
  async (...args: unknown[]) => {
    fixture.calls.push([name, ...args]);
    return result;
  };
const once = <T,>(make: () => T) => {
  let value: T | undefined;
  return () => (value ??= make());
};

// env
export const isElectron = true;

// cloud/publicConfig: Connect is offered only where setup opens on the sign-in.
export const hasCloudPublicConfig = () => fixture.entry === "start";

// @clerk/react: signed out, sign-in loaded.
export const useAuth = () => ({ isLoaded: true, isSignedIn: false, userId: null });
export const useUser = () => ({ user: null });

// components/clerk/useStudioConnectAuthPrompt
export const useStudioConnectAuthPrompt = () => ({
  authPrompt: null,
  openAuthPrompt: record("openAuthPrompt"),
  openSetupAuthPrompt: record("openSetupAuthPrompt"),
});

// cloud/useCloudLinkController
export const useCloudLinkController = () => ({
  linkState: { data: null, isPending: false, error: null, target: { environmentId: "this-mac" } },
  linked: false,
  publishAgentActivity: false,
  operationError: null,
  reconcileCloudState: record("reconcileCloudState", true),
});

// state/environments, state/session, state/server
const serverConfig = {
  environment: { platform: { os: "darwin" } },
  settings: { ...DEFAULT_SERVER_SETTINGS, defaultRuntimeMode: "approval-required" },
};
const environment = {
  environmentId: "this-mac",
  label: "This Mac",
  connection: { phase: "connected" },
  serverConfig,
};
export const useEnvironments = () => ({ environments: [environment] });
export const usePrimaryEnvironment = () => environment;
export const useRelayEnvironmentDiscovery = () => ({ environments: new Map() });
const sessionAtom = once(() => Atom.make({ _tag: "Success" }));
export const environmentSession = { sessionStateAtom: () => sessionAtom() };
export const useEnvironmentScope = () => true;
export const useEnvironmentsWithScope = (environments: Array<{ environmentId: string }>) =>
  new Set(environments.map((entry) => entry.environmentId));
export const readEnvironmentScope = () => true;
const providersAtom = once(() => Atom.make([] as unknown[]));
const configAtom = once(() => Atom.make(serverConfig as unknown));
export const serverEnvironment = {
  providersValueAtom: () => providersAtom(),
  configValueAtom: () => configAtom(),
  refreshProviders: "refreshProviders",
  updateSettings: "updateSettings",
};

// state/use-atom-command: every command answers at once.
export const useAtomCommand = (command: unknown) =>
  command === "import"
    ? record("import", { _tag: "Success", value: { importedCount: 3, skippedCount: 0 } })
    : record(String(command), { _tag: "Success", value: undefined });
export const agentSessionImport = "import";
export const projectEnvironment = { create: "createProject" };
export const terminalEnvironment = {};
export const connectPairing = "connectPairing";

// state/entities
const projects = [{ id: "demo-project", environmentId: "this-mac", workspaceRoot: "/demo-app" }];
export const useProjects = () => projects;
export const readProjects = () => projects;

// studio/fleet, teamRules/useTeamRules
export const useMachineWorkGrants = () => ({ snapshot: { grants: [] } });
export const useTeamRules = () => ({ summary: undefined });

// onboarding/accessRecommendation: not answered yet, so the Access step shows.
export const useFullAccessRecommendation = () => ({
  answer: null,
  machineRole: null,
  hydrated: true,
  accept: record("accept", new Map([["this-mac", "approval-required"]])),
  decline: record("decline"),
  undo: record("undo", true),
});

// onboarding/firstRun
export const useCompleteOnboarding = () => record("completeOnboarding");

// onboarding/useProjectScans: one project with history.
const scan = (environmentId: string) => ({
  environmentId,
  isPending: false,
  error: null,
  refresh: record("refreshScan"),
  data: {
    truncated: false,
    candidates: [
      {
        path: "/demo-app",
        title: "demo-app",
        projectId: "demo-project",
        threadCount: 3,
        lastActiveAt: new Date().toISOString(),
        sources: ["codex"],
      },
    ],
  },
});
export const useProjectScans = (ids: readonly string[]) => ids.map(scan);

// Parts with their own fixtures and tests draw nothing here.
const Nothing = () => null;
export const FirstRunUpdateNotice = Nothing;
export const StarOnGitHubLink = Nothing;
export const AccountJoinCard = Nothing;
export const ChatGptWelcomeCoordinator = Nothing;
export const CodexSetupSection = Nothing;
export const AddManagedCodexAccountDialog = Nothing;
export const FoundAgentRow = Nothing;
export const ProviderAgentRow = Nothing;
export const FullDiskAccessRow = Nothing;
export const FirstRunFullDiskAccess = Nothing;
export const ProjectsFolderChoice = Nothing;
export const CloudEnvironmentConnectRows = Nothing;
export const TerminalViewport = Nothing;
export const MachineBasics = ({ fallback }: { readonly fallback: ReactNode }) => fallback;
export const rememberRecentFolder = () => {};

// components/settings/FoundAgents: no agent found on this machine.
export const agentName = (agent: string) => agent;
export const defaultAgentInstance = () => ({});
export const foundAgentsView = () => ({ rows: [] });
export const useAgentSearch = () => ({ search: null, searching: false, find: () => {} });
export const GitRow = Nothing;
export const InstallAgentRow = Nothing;
