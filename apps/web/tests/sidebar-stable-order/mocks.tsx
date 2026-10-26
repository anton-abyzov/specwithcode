/**
 * Simulated data, routing and settings hooks for the sidebar fixture. The
 * sidebar component, its chat sort and its styles are the real ones.
 */
import type { PropsWithChildren } from "react";
import { createContext, useSyncExternalStore } from "react";
import * as Cause from "effect/Cause";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";

type Listener = () => void;
const listeners = new Set<Listener>();
export const fixture = {
  shells: [] as EnvironmentThreadShell[],
  params: {} as Record<string, string>,
  navigations: [] as string[],
  /** Titles sent with thread.meta.update, in order. */
  renames: [] as Array<{ threadId: string; title: string }>,
  /** A reason the next rename is refused with, as the server would. */
  refuseNextRename: null as string | null,
  /** Project groups the sidebar lists; null keeps the default single project. */
  groups: null as unknown[] | null,
  /** Workspace-settings patches the sidebar sent, in order. */
  projectUpdates: [] as unknown[],
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

// @effect/atom-react
export const primaryServerKeybindingsAtom = { name: "keybindings" };
export const primaryServerConfigAtom = { name: "config" };
export const environmentServerConfigsAtom = { name: "server-configs" };
export const RegistryContext = createContext(null);
const keybindings = [
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
];
// The attention members the sidebar derives with its own Atom.make: no machine
// reports any here, so every project's waiting count is zero.
const isDerivedAtom = (atom: unknown) =>
  typeof atom === "object" &&
  atom !== null &&
  typeof (atom as { read?: unknown }).read === "function";
export const useAtomValue = (atom: unknown) =>
  atom === primaryServerKeybindingsAtom ? keybindings : isDerivedAtom(atom) ? [] : null;

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
  if (environmentId && threadId) {
    fixture.navigations.push(threadId);
    publish({ params: { environmentId, threadId } });
  }
};
export const useNavigate = () => navigate;
export const useRouter = () => ({ navigate, routesById: {} });

// state/entities, state/environments, state/projects, state/use-atom-command
const NO_CONFIGS = new Map();
export const useThreadShells = () => useFixture(() => fixture.shells);
export const readThreadShell = (ref: { environmentId: string; threadId: string }) =>
  fixture.shells.find((t) => t.environmentId === ref.environmentId && t.id === ref.threadId) ??
  null;
export const useServerConfigs = () => NO_CONFIGS;
export const usePrimaryEnvironmentId = () => "host";
const NO_ENVIRONMENTS = { environments: [] };
export const useEnvironments = () => NO_ENVIRONMENTS;
export const unreachableEnvironmentIds = () => [];
const NO_IDS: string[] = [];
export const useUnreachableEnvironmentIds = () => NO_IDS;
export const projectEnvironment = { update: {} };
export const useAtomCommand =
  () =>
  async ({
    environmentId,
    input,
  }: {
    environmentId: string;
    input: { projectId: string; workspaceSettings?: Record<string, unknown> };
  }) => {
    fixture.projectUpdates.push({ environmentId, input });
    // Stored on the simulated project, the way the server's projection would.
    if (fixture.groups && input.workspaceSettings) {
      const { expectedRevision: _revision, ...patch } = input.workspaceSettings;
      publish({
        groups: (fixture.groups as Array<{ memberProjects: Array<Record<string, any>> }>).map(
          (group) => ({
            ...group,
            memberProjects: group.memberProjects.map((member) =>
              member.environmentId === environmentId && member.id === input.projectId
                ? { ...member, workspaceSettings: { ...member.workspaceSettings, ...patch } }
                : member,
            ),
          }),
        ),
      });
    }
    return { _tag: "Success", value: undefined };
  };

// state/session, state/threads, state/use-orchestration-command: a rename is
// stored on the simulated shell, the way the server's projection would.
export const readEnvironmentScope = () => true;
// The fleet helpers the sidebar reaches read no session here.
const noSession = () => ({ name: "no-session" });
export const environmentSession = {
  sessionStateAtom: noSession,
  preparedConnectionValueAtom: noSession,
};
export const readPreparedConnection = () => null;
export const threadEnvironment = { updateMetadata: {} };
export const useOrchestrationCommand =
  () =>
  async ({ input }: { input: { threadId: string; title: string } }) => {
    if (fixture.refuseNextRename !== null) {
      const reason = fixture.refuseNextRename;
      fixture.refuseNextRename = null;
      return { _tag: "Failure", cause: Cause.fail(new Error(reason)) };
    }
    fixture.renames.push({ threadId: input.threadId, title: input.title });
    publish({
      shells: fixture.shells.map((t) =>
        t.id === input.threadId ? { ...t, title: input.title } : t,
      ),
    });
    return { _tag: "Success", value: undefined };
  };

// hooks
const NO_MACHINES = { projectCoordinatorMachines: {} };
export const useClientSettings = <T,>(select: (s: typeof NO_MACHINES) => T) => select(NO_MACHINES);
export const usePrimarySettingsAvailable = () => false;
export const useUpdatePrimarySettings = () => () => {};
export const useScratchProject = () => ({
  scratchEnvironmentId: (environmentId: string | null) => environmentId,
  startScratchThread: async () => true,
});
const noop = async () => {};
export const useThreadActions = () => ({
  settleThread: noop,
  unsettleThread: noop,
  archiveThread: noop,
});
export const startNewThreadFromContext = async () => true;

// threadRoutes
export const buildThreadRouteParams = (ref: { environmentId: string; threadId: string }) => ref;
export const resolveThreadRouteTarget = (params: Record<string, string>) =>
  params.threadId
    ? {
        kind: "server",
        threadRef: { environmentId: params.environmentId, threadId: params.threadId },
      }
    : null;

// settings, plan progress, favicons, model marks
const GROUPS = [
  {
    projectKey: "host:/specweave",
    displayName: "specweave",
    memberProjects: [{ environmentId: "host", id: "p-specweave" }],
  },
];
export const useSettingsProjectGroups = () => useFixture(() => fixture.groups ?? GROUPS);
const NO_PLANS = { plans: new Map(), loaders: null };
export const useSidebarThreadPlans = () => NO_PLANS;
export const ProjectFavicon = () => <i className="inline-block size-4 rounded bg-amber-500/60" />;
export const ModelBadgeMark = () => (
  <i className="inline-block size-4 rounded-full bg-orange-500/70" />
);
const NO_ENTRIES = new Map();
export const useProviderEntriesByEnvironment = () => NO_ENTRIES;

// sidebar chrome: the brand header and footer are not under test
export const SidebarChromeHeader = () => null;
export const SidebarChromeFooter = () => null;
