/**
 * Simulated data, routing and settings hooks for the sidebar fixture. The
 * sidebar component, its chat sort and its styles are the real ones.
 */
import type { PropsWithChildren } from "react";
import { useSyncExternalStore } from "react";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";

type Listener = () => void;
const listeners = new Set<Listener>();
export const fixture = {
  shells: [] as EnvironmentThreadShell[],
  params: {} as Record<string, string>,
  navigations: [] as string[],
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
export const useAtomValue = (atom: unknown) =>
  atom === primaryServerKeybindingsAtom ? keybindings : null;

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
export const useAtomCommand = () => async () => ({ _tag: "Success", value: undefined });

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
export const useSettingsProjectGroups = () => GROUPS;
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
