/**
 * The simulated boundary of the idle-window fixture: one connected machine, its
 * settings and routing. The store on top of it is the real one: the shell state
 * atom is written with the real shell reducer, and the thread atoms, entity
 * hooks, sidebar and thread route read it as they do in the app.
 */
import type { PropsWithChildren } from "react";
import { useEffect, useSyncExternalStore } from "react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import type { EnvironmentCatalogState } from "@specweave-studio/client-runtime/state/connections";
import {
  createEnvironmentSnapshotAtom,
  type EnvironmentShellState,
} from "@specweave-studio/client-runtime/state/shell";
import { createEnvironmentThreadShellAtoms } from "@specweave-studio/client-runtime/state/threads";
import type { EnvironmentId } from "@specweave-studio/contracts";

type Listener = () => void;
const listeners = new Set<Listener>();
export const fixture = {
  params: {} as Record<string, string>,
  groups: [] as unknown[],
  /** How often the stand-in for the chat view rendered. */
  chatViewRenders: 0,
};
export function publish(change: Partial<typeof fixture>): void {
  Object.assign(fixture, change);
  for (const listener of listeners) listener();
}
function useFixture<T>(select: () => T): T {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, select);
}

export const HOST = "host" as EnvironmentId;
export const SCRATCH_ROOT = "/Users/me/.specwithcode/scratch";

// state/shell: one machine's shell state, written by the fixture's event stream.
const EMPTY_SHELL_STATE: EnvironmentShellState = {
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
};
const shellStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(AsyncResult.success(EMPTY_SHELL_STATE)).pipe(
    Atom.keepAlive,
    Atom.withLabel(`fixture-shell-state:${environmentId}`),
  ),
);
export const environmentShell = {
  stateAtom: shellStateAtom,
  stateValueAtom: Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(AsyncResult.value(get(shellStateAtom(environmentId))), () => {
        return EMPTY_SHELL_STATE;
      }),
    ),
  ),
};
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(shellStateAtom);
export const allEnvironmentShellsBootstrappedAtom = Atom.make(true);
export const allEnvironmentProjectSnapshotsReadyAtom = Atom.make(true);

// state/threads: the real thread shell atoms over that snapshot.
const catalogValueAtom = Atom.make<EnvironmentCatalogState>({
  isReady: true,
  entries: new Map([[HOST, { enabled: true }]]) as unknown as EnvironmentCatalogState["entries"],
});
export const threadEnvironment = { updateMetadata: {}, snapshotAtom: environmentSnapshotAtom };
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});
const constant = <A,>(value: A) => {
  const atom = Atom.make(value);
  return () => atom;
};
export const environmentThreadDetails = {
  threadAtom: constant(null),
  statusAtom: constant("empty"),
  errorAtom: constant(null),
  historyAtom: constant(null),
  visibleTurnItemsAtom: constant([]),
};

// state/projects, state/server, state/environments, state/session
export const environmentProjects = {
  projectsAtom: Atom.make([]),
  projectAtom: constant(null),
};
export const projectEnvironment = { update: {} };
const serverConfigs = new Map([
  [
    HOST,
    {
      scratchWorkspaceRoot: SCRATCH_ROOT,
      providers: [],
      settings: { machineNicknames: {} },
      environment: { environmentId: HOST, label: "m4", capabilities: { threadProjectMove: true } },
    },
  ],
]);
export const environmentServerConfigsAtom = Atom.make(serverConfigs);
export const primaryServerConfigAtom = Atom.make(null);
export const primaryServerKeybindingsAtom = Atom.make([
  {
    command: "thread.next",
    shortcut: {
      key: "]",
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      modKey: false,
    },
  },
]);
export const usePrimaryEnvironmentId = () => HOST;
const ENVIRONMENTS = {
  environments: [{ environmentId: HOST, label: "m4", connection: { phase: "connected" } }],
};
const ALL_HOSTS: ReadonlySet<string> = new Set([HOST]);
export const useEnvironmentsWithScope = () => ALL_HOSTS;
export const useEnvironments = () => ENVIRONMENTS;
const NO_HOSTS: string[] = [];
export const unreachableEnvironmentIds = () => NO_HOSTS;
export const useUnreachableEnvironmentIds = () => NO_HOSTS;
export const readEnvironmentScope = () => true;
export const useEnvironmentScope = () => true;
export const useEnvironmentScopeAccess = () => "granted";
const noSession = () => Atom.make(null);
export const environmentSession = {
  sessionStateAtom: noSession,
  preparedConnectionValueAtom: noSession,
};
export const readPreparedConnection = () => null;
const succeed = async () => ({ _tag: "Success", value: undefined });
export const useAtomCommand = () => succeed;
export const useOrchestrationCommand = () => succeed;

// studio/fleet: what each project's remote worker poll last answered. The app
// re-reads it every 10 s per project; `pollRemoteWorkers` stands for one answer.
type RemoteAttention = { workers: unknown[]; complete: boolean };
const remoteAttention = Atom.family((key: string) =>
  Atom.make<RemoteAttention>({ workers: [], complete: true }).pipe(
    Atom.keepAlive,
    Atom.withLabel(`fixture-remote-attention:${key}`),
  ),
);
export const projectRemoteAttentionAtom = remoteAttention;
export const remoteAttentionKey = (projectId: string) =>
  JSON.stringify({ environmentId: HOST, projectId });
export const REMOTE_WORKERS_REFRESH_MS = 10_000;
const NO_REMOTE_WORKERS = { workers: [], loaded: true, available: false, refresh: () => {} };
export const useProjectRemoteWorkers = () => NO_REMOTE_WORKERS;

// studio/projectWorkspace: no SpecWeave plan is linked to a thread here.
const NO_INCREMENTS = Atom.make(AsyncResult.success({ threads: [], unplanned: [] }));
const NO_WORKSPACE = Atom.make(AsyncResult.success(null));
export const projectWorkspace = {
  threadIncrementProgress: () => NO_INCREMENTS,
  read: () => NO_WORKSPACE,
};

// lib/archivedThreadsState: the machine's archive, as its own bounded read answers it.
export const archive = {
  snapshots: [] as Array<{ environmentId: EnvironmentId; snapshot: { threads: unknown[] } }>,
  error: null,
  isLoading: false,
  refresh: () => {},
};
export const useArchivedThreadSnapshots = () => archive;

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
const navigate = async (target: { params?: { environmentId?: string; threadId?: string } }) => {
  const { environmentId, threadId } = target.params ?? {};
  if (environmentId && threadId) publish({ params: { environmentId, threadId } });
};
export const useNavigate = () => navigate;
const ROUTER = { navigate, routesById: {} };
export const useRouter = () => ROUTER;

// hooks, settings, favicons, model marks, sidebar chrome
const NO_MACHINES = { projectCoordinatorMachines: {} };
export const useClientSettings = <T,>(select: (s: typeof NO_MACHINES) => T) => select(NO_MACHINES);
export const useAideEnabled = () => true;
export const useLegacySidebarEnabled = () => false;
export const usePrimarySettingsAvailable = () => false;
const noop = async () => {};
export const useUpdatePrimarySettings = () => noop;
const SCRATCH_PROJECT = {
  scratchEnvironmentId: (environmentId: string | null) => environmentId,
  startScratchThread: async () => true,
};
export const useScratchProject = () => SCRATCH_PROJECT;
const THREAD_ACTIONS = { settleThread: noop, unsettleThread: noop, archiveThread: noop };
export const useThreadActions = () => THREAD_ACTIONS;
export const startNewThreadFromContext = async () => true;
export const requestThreadMove = noop;
export const useSettingsProjectGroups = () => useFixture(() => fixture.groups);
export const ProjectFavicon = () => <i className="inline-block size-4 rounded bg-amber-500/60" />;
export const ModelBadgeMark = () => (
  <i className="inline-block size-4 rounded-full bg-orange-500/70" />
);
export const ThreadModelBadge = ModelBadgeMark;
export const ModelBadge = ModelBadgeMark;
const NO_ENTRIES = new Map();
export const useProviderEntriesByEnvironment = () => NO_ENTRIES;
export const SidebarChromeHeader = () => null;
export const SidebarChromeFooter = () => null;

// components/ChatView: the thread route's child. The chat view itself is not
// mounted; this counts how often the route asks it to render.
export default function ChatViewStandIn({ threadId }: { threadId: string }) {
  useEffect(() => {
    fixture.chatViewRenders += 1;
  });
  return <div data-chat-view={threadId} />;
}
