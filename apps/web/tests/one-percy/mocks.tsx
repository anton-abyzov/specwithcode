/**
 * Simulated stores, routing, settings and RPC hooks for the one-Percy fixture.
 * StudioSidebar, the assistant rules (assistantEntries.ts, personalAssistant.ts),
 * PercySharedSetting and its confirmation, ThreadsPane and the offline line are
 * the real ones. Every machine and project is fictional.
 *
 * `?view=` picks the scenario:
 *   sidebar   Percy linked over Studio, Laptop and Desktop; Tower's Percy not joined
 *   settings  the switch on, with the machines table and Undo
 *   dialog    the switch off; Laptop is listed under the Connect account, Desktop
 *             is connected to this window but not listed (a LAN or team pairing)
 *   chats     Percy's one chat list over the joined machines, Tower offline
 */
import type { PropsWithChildren } from "react";
import { createContext, useSyncExternalStore } from "react";

const params = new URLSearchParams(location.search);
export const view = params.get("view") ?? "sidebar";

type Listener = () => void;
const listeners = new Set<Listener>();
export const fixture = {
  params: {} as Record<string, string>,
  navigations: [] as string[],
  /** Every RPC the views sent: `personalLink.setShared` and the rest. */
  calls: [] as Array<{ command: string; environmentId: string; input: unknown }>,
};
Object.assign(window, { fixtureCalls: fixture.calls });
function useFixture<T>(select: () => T): T {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, select);
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

// Machines. Studio is the window's own. Tower is off. Mini runs an older version.
type Phase = "connected" | "disconnected";
const machine = (environmentId: string, label: string, phase: Phase) => ({
  environmentId,
  label,
  entry: { thisMachine: environmentId === "studio", enabled: true },
  connection: { phase, error: null },
});
export const environments =
  view === "dialog"
    ? [
        machine("studio", "Studio", "connected"),
        machine("laptop", "Laptop", "connected"),
        machine("desktop", "Desktop", "connected"),
      ]
    : view === "settings"
      ? [
          machine("studio", "Studio", "connected"),
          machine("laptop", "Laptop", "connected"),
          machine("desktop", "Desktop", "connected"),
        ]
      : [
          machine("studio", "Studio", "connected"),
          machine("laptop", "Laptop", "connected"),
          machine("desktop", "Desktop", "connected"),
          machine("tower", "Tower", "disconnected"),
        ];
const nameSources = {
  nicknames: {},
  labels: new Map(environments.map((e) => [e.environmentId, e.label])),
};
/** The machines the relay lists under the window's signed-in Connect account. */
const accountMachines = view === "dialog" ? ["studio", "laptop"] : ["studio", "laptop", "desktop"];

// Projects: one personal assistant per machine; linked seats share a logical project.
const link = {
  id: "logical:percy:fixture",
  title: "Percy",
  members: [
    { environmentId: "studio", projectId: "percy-studio" },
    { environmentId: "laptop", projectId: "percy-laptop" },
    { environmentId: "desktop", projectId: "percy-desktop" },
  ],
};
// Linked seats share the link's icon; an assistant that is not joined keeps its own.
const LINKED_ICON = { kind: "lucide", name: "concierge-bell", color: "violet" };
const OWN_ICON = { kind: "lucide", name: "compass", color: "teal" };
const seat = (environmentId: string, linked: boolean, createdAt: string) => ({
  id: `percy-${environmentId}`,
  projectIcon: linked ? LINKED_ICON : OWN_ICON,
  environmentId,
  title: "Percy",
  workspaceRoot: `/fixtures/assistants/${environmentId}`,
  createdAt,
  updatedAt: createdAt,
  deletedAt: null,
  repositoryIdentity: null,
  workspaceSettings: {
    kind: "personal",
    archived: false,
    revision: 1,
    ...(linked
      ? {
          logicalProject: link,
          coordinatorBinding: { routineOwner: environmentId === "laptop" },
        }
      : {}),
  },
});
const code = (id: string, title: string, icon: string, color: string) => ({
  id,
  projectIcon: { kind: "lucide", name: icon, color },
  environmentId: "studio",
  title,
  workspaceRoot: `/fixtures/${id}`,
  createdAt: "2026-07-01T09:00:00.000Z",
  updatedAt: "2026-07-01T09:00:00.000Z",
  deletedAt: null,
  repositoryIdentity: null,
  workspaceSettings: { kind: "code", origin: "user", archived: false, revision: 1 },
});
export const projects =
  view === "dialog"
    ? // Two separate assistants and no link yet: the confirmation asks where to start.
      [
        seat("studio", false, "2026-09-01T09:00:00.000Z"),
        seat("laptop", false, "2026-08-01T09:00:00.000Z"),
      ]
    : [
        seat("studio", true, "2026-09-01T09:00:00.000Z"),
        seat("laptop", true, "2026-08-01T09:00:00.000Z"),
        seat("desktop", true, "2026-08-15T09:00:00.000Z"),
        ...(view === "settings" ? [] : [seat("tower", false, "2026-07-15T09:00:00.000Z")]),
        code("garden-planner", "Garden Planner", "leaf", "green"),
        code("recipe-notes", "Recipe Notes", "coffee", "orange"),
      ];

// Sidebar groups, the way the store groups them: linked seats are one group.
const GROUPS = [
  {
    projectKey: "logical-project:logical:percy:fixture",
    displayName: "Percy",
    memberProjects: projects.filter((p) => "logicalProject" in p.workspaceSettings),
  },
  ...projects
    .filter((p) => !("logicalProject" in p.workspaceSettings))
    .map((p) => ({
      projectKey: `${p.environmentId}:${p.workspaceRoot}`,
      displayName: p.title,
      workspaceRoot: p.workspaceRoot,
      memberProjects: [p],
    })),
].filter((group) => group.memberProjects.length > 0);

// Chats that wait on the person: one per joined seat, so the linked row counts three.
const shell = (id: string, environmentId: string, projectId: string, title: string) => ({
  id,
  environmentId,
  projectId,
  title,
  runtime: null,
  latestRun: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: true,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  settledOverride: null,
  lineage: { relationshipToParent: null },
  pullRequests: [],
  archivedAt: null,
  deletedAt: null,
  createdAt: minutesAgo(90),
  updatedAt: minutesAgo(30),
  createdBy: "user",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
});
const SHELLS =
  view === "sidebar"
    ? [
        shell("tax", "studio", "percy-studio", "Estimated tax for Q4"),
        shell("brief", "laptop", "percy-laptop", "Morning briefing"),
        shell("flights", "desktop", "percy-desktop", "Flights to Lisbon"),
      ]
    : [];

// The switch, as this machine's server saved it.
const settings = {
  aideEnabled: true,
  personalAssistantShared:
    view === "dialog"
      ? { enabled: false, machines: [] as string[] }
      : { enabled: true, machines: ["laptop", "desktop", "tower", "mini"] },
  projectCoordinatorMachines: {},
};

// personalLink.shareStatus on Studio.
const shareStatus = {
  enabled: view !== "dialog",
  environmentId: "studio",
  machineLabel: "Studio",
  connectLinked: true,
  linkId: "logical:percy:fixture",
  projectId: "percy-studio",
  assistantName: "Percy",
  linked: view !== "dialog",
  members: view === "dialog" ? [] : link.members,
  routineOwner: false,
  start: false,
  machines:
    view === "dialog"
      ? []
      : [
          {
            environmentId: "laptop",
            label: "Laptop",
            state: "joined",
            lastSyncedAt: minutesAgo(1),
          },
          { environmentId: "desktop", label: "Desktop", state: "switch_off" },
          { environmentId: "tower", label: "Tower", state: "offline" },
          { environmentId: "mini", label: "Mini", state: "older_version" },
        ],
  restorePoints:
    view === "dialog"
      ? []
      : [
          {
            id: "before-link",
            savedAt: "2026-11-24T09:00:00.000Z",
            reason: "before-link",
            memoryFileCount: 21,
          },
        ],
  refusal: null,
};

// personalLink.shareStatus on another machine. In the dialog, Laptop already
// confirmed Mini on its own, which this window does not know: turning it on
// here keeps Mini there.
const remoteShareStatus = (environmentId: string) => ({
  ...shareStatus,
  environmentId,
  machineLabel: environments.find((e) => e.environmentId === environmentId)?.label ?? environmentId,
  machines:
    view === "dialog" && environmentId === "laptop"
      ? [{ environmentId: "mini", label: "Mini", state: "waiting" }]
      : [],
  restorePoints: [],
});

// studio/personalShareCommands: named stand-ins, answered by useAtomCommand.
export const personalShareStatusCommand = { command: "personalLink.shareStatus" };
export const setPersonalSharedCommand = { command: "personalLink.setShared" };
export const undoPersonalShareCommand = { command: "personalLink.undo" };
export const personalLinkPreviewCommand = { command: "personalLink.preview" };
const MEMORY_FILES: Record<string, number> = { studio: 4, laptop: 21, desktop: 9 };
export const useAtomCommand =
  (command: { command?: string } | unknown) =>
  async ({ environmentId, input }: { environmentId: string; input: unknown }) => {
    const name = (command as { command?: string })?.command ?? "other";
    fixture.calls.push({ command: name, environmentId, input });
    if (name === "personalLink.shareStatus")
      return {
        _tag: "Success",
        value: environmentId === "studio" ? shareStatus : remoteShareStatus(environmentId),
      };
    if (name === "personalLink.preview")
      return { _tag: "Success", value: { memoryFileCount: MEMORY_FILES[environmentId] ?? 0 } };
    if (name === "personalLink.setShared")
      return {
        _tag: "Success",
        value: { ...shareStatus, enabled: (input as { enabled: boolean }).enabled },
      };
    return { _tag: "Success", value: undefined };
  };
export const squashAtomCommandFailure = (failure: { error: unknown }) => failure.error;
export const isAtomCommandInterrupted = () => false;

// @effect/atom-react
export const primaryServerKeybindingsAtom = { name: "keybindings" };
export const primaryServerConfigAtom = { name: "config" };
export const environmentServerConfigsAtom = { name: "server-configs" };
export const RegistryContext = createContext<unknown>(null);
export const useAtomRefresh = () => () => {};
export const useAtomSet = () => () => {};
// Derived atoms the views make with Atom.make read nothing here: no machine reports any.
const NO_VALUES = new Map();
const isDerivedAtom = (atom: unknown) =>
  typeof atom === "object" &&
  atom !== null &&
  typeof (atom as { read?: unknown }).read === "function";
export const useAtomValue = (atom: { label?: readonly unknown[] } | unknown) =>
  atom === primaryServerKeybindingsAtom
    ? []
    : (atom as { label?: readonly unknown[] })?.label?.[0] === "machine-name-sources"
      ? nameSources
      : isDerivedAtom(atom)
        ? NO_VALUES
        : null;

// @tanstack/react-router
export function Link({
  children,
  to,
  params,
  search: _search,
  hash,
  ...rest
}: PropsWithChildren<{
  to: string;
  params?: { projectKey: string };
  search?: unknown;
  hash?: string;
}>) {
  return (
    <a
      href={params ? `#/projects/${params.projectKey}` : `#${to}${hash ? `#${hash}` : ""}`}
      {...rest}
    >
      {children}
    </a>
  );
}
const location_ = {
  pathname: view === "settings" || view === "dialog" ? "/settings/general" : "/",
  hash: "",
  search: {},
  state: {},
};
export const useLocation = (options?: { select?: (l: typeof location_) => unknown }) =>
  options?.select ? options.select(location_) : location_;
export const useParams = ({ select }: { select: (p: Record<string, string>) => unknown }) =>
  select(useFixture(() => fixture.params));
export const useSearch = ({ select }: { select: (s: Record<string, string>) => unknown }) =>
  select({});
const navigate = async (target: { to?: string }) => {
  fixture.navigations.push(target.to ?? "");
};
export const useNavigate = () => navigate;
export const useRouter = () => ({ navigate, routesById: {}, buildLocation: () => ({ href: "#" }) });

// state/entities, state/environments, state/projects, state/session, state/server
export const useThreadShells = () => SHELLS;
export const useThreadShell = () => null;
export const readThreadShell = () => null;
const NO_CONFIGS = new Map();
export const useServerConfigs = () => NO_CONFIGS;
export const useProjects = () => projects;
export const useProject = () => null;
export const usePrimaryEnvironmentId = () => "studio";
const environmentState = { environments, isReady: true };
export const useEnvironments = () => environmentState;
export const useEnvironment = (environmentId: string) => {
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  return environment ? { label: environment.label, serverConfig: null } : null;
};
const ENVIRONMENT_IDS = environments.map((environment) => environment.environmentId);
export const useEnvironmentIds = () => ENVIRONMENT_IDS;
export const unreachableEnvironmentIds = () => [...UNREACHABLE];
// Tower is off: this window cannot reach it.
const UNREACHABLE: ReadonlySet<string> = new Set(
  environments.filter((e) => e.connection.phase !== "connected").map((e) => e.environmentId),
);
export const useUnreachableEnvironmentIds = () => UNREACHABLE;
const discovery = {
  environments: new Map(accountMachines.map((id) => [id, { environment: { environmentId: id } }])),
  refreshing: false,
  offline: false,
  error: { _tag: "None" },
};
export const useRelayEnvironmentDiscovery = () => discovery;
export const useAllEnvironmentProjectSnapshotsReady = () => true;
const permitted = new Set(ENVIRONMENT_IDS);
export const useEnvironmentsWithScope = () => permitted;
export const readEnvironmentScope = () => true;
export const useEnvironmentScope = () => true;
export const readEnvironmentScopeAccess = () => "granted";
export const useEnvironmentScopeAccess = () => "granted";
const ACCESS = new Map(ENVIRONMENT_IDS.map((id) => [id, "granted"]));
export const useEnvironmentsScopeAccess = () => ACCESS;
const noSession = () => ({ name: "no-session" });
export const environmentSession = {
  sessionStateAtom: noSession,
  preparedConnectionValueAtom: noSession,
};
export const readPreparedConnection = () => null;
export const projectEnvironment = { update: {} };
export const threadEnvironment = { updateMetadata: {} };
export const useOrchestrationCommand = () => async () => ({ _tag: "Success", value: undefined });
export const serverEnvironment = new Proxy(
  {},
  { get: () => () => ({ name: "server-environment" }) },
) as Record<string, (...args: unknown[]) => unknown>;
export const EMPTY_SERVER_PROVIDERS: ReadonlyArray<never> = [];

// hooks/useSettings
export const useClientSettings = <T,>(select: (s: typeof settings) => T) => select(settings);
export const usePrimarySettings = <T,>(select?: (s: typeof settings) => T) =>
  select ? select(settings) : settings;
export const usePrimarySettingsAvailable = () => true;
export const useUpdatePrimarySettings = () => () => {};
export const useAideEnabled = () => true;
export const useEnvironmentSettings = () => null;
export const mergeEnvironmentSettings = <T,>(server: T) => server;
export const PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE = "This setting is saved on a server.";
export const persistClientSettingsPatch = async () => {};
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
export const requestThreadMove = async () => {};

// threadRoutes
export const buildThreadRouteParams = (ref: { environmentId: string; threadId: string }) => ref;
export const resolveThreadRouteTarget = () => null;

// Sidebar groups, plan progress, favicons, model marks and chrome
export const useSettingsProjectGroups = () => GROUPS;
const NO_PLANS = { plans: new Map(), loaders: null };
export const useSidebarThreadPlans = () => NO_PLANS;
export const ModelBadgeMark = () => (
  <i className="inline-block size-4 rounded-full bg-orange-500/70" />
);
export const ThreadModelBadge = () => (
  <span className="text-muted-foreground text-xs" data-model-badge>
    Opus
  </span>
);
const NO_ENTRIES = new Map();
export const useProviderEntriesByEnvironment = () => NO_ENTRIES;
export const SidebarChromeHeader = () => null;
export const SidebarChromeFooter = () => null;

// studio/machineChecking and studio/useThreadIncrementProgress
export const useMachineStillChecking = () => () => false;
const NO_PROGRESS = new Map();
export const useThreadIncrementProgress = () => NO_PROGRESS;
export const useProjectThreadIncrementProgress = () => ({
  progress: NO_PROGRESS,
  unplanned: new Set<string>(),
  answered: true,
});
