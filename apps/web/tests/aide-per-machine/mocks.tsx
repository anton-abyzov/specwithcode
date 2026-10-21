/**
 * Simulated stores, routing, settings and RPC hooks for the assistant-per-machine
 * fixture. StudioSidebar, the Run on menu, the assistant rules
 * (personalAssistant.ts, addToMachine.ts) and machine naming are the real ones.
 *
 * The scenario comes from the query string:
 *   machines=1|2  connected machines (default 2: Studio Mac and Anna's MacBook)
 *   duplicate=1   Studio Mac also keeps a pre-rule personal project, created later
 */
import type { PropsWithChildren } from "react";
import { createContext, useSyncExternalStore } from "react";

const params = new URLSearchParams(location.search);
const machineCount = params.get("machines") === "1" ? 1 : 2;
const withDuplicate = params.get("duplicate") === "1";

type Listener = () => void;
const listeners = new Set<Listener>();
export const fixture = {
  params: {} as Record<string, string>,
  navigations: [] as string[],
};
function useFixture<T>(select: () => T): T {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, select);
}

// The fleet: this machine ("Studio Mac") and Anna's laptop. Anna's machine
// carries a nickname, the way a renamed machine does; machine names resolve
// through the real machineNickname module.
export const environments = [
  ["m4", "Studio Mac", true],
  ["anna", "Anna's MacBook", false],
]
  .slice(0, machineCount)
  .map(([environmentId, label, thisMachine]) => ({
    environmentId,
    label,
    entry: { thisMachine },
    connection: { phase: "connected", error: null },
  }));
const nameSources = {
  nicknames: { anna: { name: "Anna's MacBook", updatedAt: 1 } },
  labels: new Map(environments.map((e) => [e.environmentId as string, e.label as string])),
};

const personal = { kind: "personal" };
const project = (
  id: string,
  environmentId: string,
  title: string,
  workspaceRoot: string,
  createdAt: string,
  workspaceSettings: object | null,
) => ({
  id,
  environmentId,
  environmentLabel: environments.find((e) => e.environmentId === environmentId)?.label,
  title,
  workspaceRoot,
  createdAt,
  updatedAt: createdAt,
  deletedAt: null,
  workspaceSettings,
  repositoryIdentity:
    workspaceSettings === null
      ? {
          canonicalKey: `example.com/fixtures/${workspaceRoot.split("/").pop()}`,
          rootPath: workspaceRoot,
          locator: { kind: "remote" },
        }
      : null,
});
// Anna's assistant is the oldest on purpose: rows lead by machine, not by date.
const allProjects = [
  project(
    "aide-anna",
    "anna",
    "Aide",
    "/fixtures/assistants/annas-macbook",
    "2026-08-20T09:00:00.000Z",
    personal,
  ),
  project(
    "aide-m4",
    "m4",
    "Aide",
    "/fixtures/assistants/studio-mac",
    "2026-09-01T09:00:00.000Z",
    personal,
  ),
  ...(withDuplicate
    ? [
        // Made before the one-per-machine rule, after m4's own: it keeps its history.
        project(
          "aide-m4-older-rule",
          "m4",
          "Aide",
          "/fixtures/assistants/studio-mac-2",
          "2026-09-15T09:00:00.000Z",
          personal,
        ),
      ]
    : []),
  project(
    "household-m4",
    "m4",
    "Example Household",
    "/fixtures/example-household",
    "2026-07-01T09:00:00.000Z",
    null,
  ),
  project(
    "recipes-anna",
    "anna",
    "Recipe Notes",
    "/fixtures/recipe-notes",
    "2026-07-02T09:00:00.000Z",
    null,
  ),
];
export const projects = allProjects.filter((p) =>
  environments.some((e) => e.environmentId === p.environmentId),
);

// @effect/atom-react
export const primaryServerKeybindingsAtom = { name: "keybindings" };
export const primaryServerConfigAtom = { name: "config" };
export const environmentServerConfigsAtom = { name: "server-configs" };
export const RegistryContext = createContext<unknown>(null);
export const useAtomValue = (atom: { label?: readonly unknown[] } | unknown) =>
  atom === primaryServerKeybindingsAtom
    ? []
    : (atom as { label?: readonly unknown[] })?.label?.[0] === "machine-name-sources"
      ? nameSources
      : null;

// @tanstack/react-router
export function Link({
  children,
  to,
  params,
  search: _search,
  ...rest
}: PropsWithChildren<{ to: string; params?: { projectKey: string }; search?: unknown }>) {
  return (
    <a href={params ? `#/projects/${params.projectKey}` : `#${to}`} {...rest}>
      {children}
    </a>
  );
}
export const useLocation = ({ select }: { select: (l: { pathname: string }) => unknown }) =>
  select({ pathname: "/" });
export const useParams = ({ select }: { select: (p: Record<string, string>) => unknown }) =>
  select(useFixture(() => fixture.params));
export const useSearch = ({ select }: { select: (s: Record<string, string>) => unknown }) =>
  select({});
const navigate = async (target: { to?: string }) => {
  fixture.navigations.push(target.to ?? "");
};
export const useNavigate = () => navigate;
export const useRouter = () => ({ navigate, routesById: {} });

// state/entities, state/environments, state/projects, state/session, state/server
const NO_SHELLS: never[] = [];
const NO_CONFIGS = new Map();
export const useThreadShells = () => NO_SHELLS;
export const readThreadShell = () => null;
export const useServerConfigs = () => NO_CONFIGS;
export const useProjects = () => projects;
export const usePrimaryEnvironmentId = () => "m4";
const environmentState = { environments };
export const useEnvironments = () => environmentState;
export const useEnvironment = (environmentId: string) => {
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  return environment
    ? {
        label: environment.label,
        serverConfig: {
          environment: {
            platform: { machine: environmentId === "anna" ? "laptop" : "desktop" },
            capabilities: { cloneDestinationChecks: true, projectLink: true },
          },
        },
      }
    : null;
};
export const unreachableEnvironmentIds = () => [];
const NO_IDS: string[] = [];
export const useUnreachableEnvironmentIds = () => NO_IDS;
const permitted = new Set(environments.map((e) => e.environmentId as string));
export const useEnvironmentsWithScope = () => permitted;
export const readEnvironmentScope = (environmentId?: string) =>
  environmentId === undefined || permitted.has(environmentId);
export const projectEnvironment = { update: {} };
export const threadEnvironment = { updateMetadata: {} };
export const useAtomCommand = () => async () => ({ _tag: "Success", value: undefined });
export const useOrchestrationCommand = () => async () => ({ _tag: "Success", value: undefined });
export const squashAtomCommandFailure = (failure: { error: unknown }) => failure.error;
export const isAtomCommandInterrupted = () => false;

// hooks, settings, logical project keys
const settings = { projectCoordinatorMachines: {} };
export const useClientSettings = <T,>(select: (s: typeof settings) => T) => select(settings);
export const usePrimarySettingsAvailable = () => false;
export const useUpdatePrimarySettings = () => () => {};
export const useLegacySidebarEnabled = () => true;
export const selectProjectGroupingSettings = () => ({});
export const deriveLogicalProjectKeyFromSettings = (p: { workspaceRoot: string }) =>
  p.workspaceRoot;
export const useScratchProject = () => ({
  scratchEnvironmentId: (environmentId: string | null) => environmentId,
  startScratchThread: async () => true,
  openScratchProject: async () => null,
  scratchWorkspaceRootFor: (environmentId: string) => `/scratch/${environmentId}`,
});
const noop = async () => {};
export const useThreadActions = () => ({
  settleThread: noop,
  unsettleThread: noop,
  archiveThread: noop,
});
export const startNewThreadFromContext = async () => true;
export const useProjectCoordinatorHandoff = () => async () => ({ kind: "standalone" });
export const environmentCatalog = { retryNow: "retryNow" };
export const isThisMachineTarget = (entry: { thisMachine?: boolean } | undefined) =>
  entry?.thisMachine === true;
export const machineLastSeenAt = () => null;
export const useMachineLastSeenVersion = () => 0;
export const useRenameMachine = () => ({ lock: null, rename: () => true });
export function AddToMachineDialog() {
  return null;
}
export function ProjectLinkDialog() {
  return null;
}

// threadRoutes
export const buildThreadRouteParams = (ref: { environmentId: string; threadId: string }) => ref;
export const resolveThreadRouteTarget = () => null;

// Sidebar groups: one per checkout, in the order the store hands them over
// (Anna's assistant first, so leading with this machine's is the sidebar's doing).
const GROUPS = projects.map((p) => ({
  projectKey: `${p.environmentId}:${p.workspaceRoot}`,
  displayName: p.title,
  memberProjects: [p],
}));
export const useSettingsProjectGroups = () => GROUPS;
const NO_PLANS = { plans: new Map(), loaders: null };
export const useSidebarThreadPlans = () => NO_PLANS;
export const ProjectFavicon = () => <i className="inline-block size-4 rounded bg-amber-500/60" />;
export const ModelBadgeMark = () => (
  <i className="inline-block size-4 rounded-full bg-orange-500/70" />
);
const NO_ENTRIES = new Map();
export const useProviderEntriesByEnvironment = () => NO_ENTRIES;
export const SidebarChromeHeader = () => null;
export const SidebarChromeFooter = () => null;
