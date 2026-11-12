// Stand-ins for what the first-run steps read, driven by the page's query:
//   ?view=connection|projects        which step is shown in the setup frame
//   ?found=0                         setup found no project to import
//   ?connect=off                     a build without SpecWithCode Connect
import { useSyncExternalStore } from "react";

const params = new URLSearchParams(location.search);
const HERE = "here";
const HOME = "/Users/you";

export const calls: unknown[] = [];
Object.assign(window, { fixtureCalls: calls });

const here = {
  environmentId: HERE,
  label: "Sam's MacBook Pro",
  displayUrl: "http://localhost:5230",
  relayManaged: false,
  connection: { phase: "connected" },
  serverConfig: { suggestedProjectsRoot: `${HOME}/Projects` },
};
const other = {
  environmentId: "other",
  label: "Mac mini M1",
  displayUrl: "https://mini.example.net",
  relayManaged: false,
  connection: { phase: "connecting" },
  serverConfig: null,
};
const environments = [here, other];

// The frame's header and the window it sits in.
export const isElectron = true;
export const FirstRunUpdateNotice = () => null;
export const StarOnGitHubLink = () => null;

// Connection step.
export const hasCloudPublicConfig = () => params.get("connect") !== "off";
export const isOnboardingRelayEnvironment = () => false;
export const useAuth = () => ({ isLoaded: true, isSignedIn: false, userId: null });
export const useStudioConnectAuthPrompt = () => ({
  authPrompt: null,
  openAuthPrompt: () => calls.push(["sign-in"]),
});
export const CloudEnvironmentConnectRows = () => null;
export const connectPairing = "pair";
export const useEnvironments = () => ({ environments });
export const usePrimaryEnvironment = () => here;
export const useMachineNicknames = () => (_id: string, label: string) => label;

// Projects step.
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const found =
  params.get("found") === "0"
    ? []
    : [
        {
          path: `${HOME}/Projects/github/storefront`,
          title: "storefront",
          sources: ["codex", "claudeAgent"],
          threadCount: 14,
          lastActiveAt: minutesAgo(20),
          alreadyImported: false,
        },
        {
          path: `${HOME}/Projects/github/notes`,
          title: "notes",
          sources: ["claudeAgent"],
          threadCount: 3,
          lastActiveAt: minutesAgo(60 * 30),
          alreadyImported: false,
        },
      ];
const scans = [
  {
    environmentId: HERE,
    data: { candidates: found, truncated: false },
    error: null,
    isPending: false,
    refresh: () => calls.push(["rescan"]),
  },
];
export const useProjectScans = (ids: readonly string[]) => (ids.length === 0 ? [] : scans);
export const agentSessionImport = "import";
export const agentSessionScan = "scan";
export const projectEnvironment = { create: "create" };
let projects: ReadonlyArray<{
  id: string;
  environmentId: string;
  workspaceRoot: string;
  title: string;
}> = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const readProjects = () => projects;
export const useProjects = () => useSyncExternalStore(subscribe, () => projects);
export const readEnvironmentScope = () => true;
export const useEnvironmentsWithScope = (list: ReadonlyArray<{ environmentId: string }>) =>
  new Set(list.map((entry) => entry.environmentId));
export const useAtomCommand =
  (command: string) =>
  async (value?: {
    environmentId?: string;
    input?: { projectId?: string; workspaceRoot?: string; title?: string; parentPath?: string };
  }) => {
    calls.push([command, value?.input?.workspaceRoot ?? value?.input?.parentPath ?? null]);
    if (command === "create" && value?.input?.projectId) {
      projects = [
        ...projects,
        {
          id: value.input.projectId,
          environmentId: value.environmentId ?? HERE,
          workspaceRoot: value.input.workspaceRoot ?? "",
          title: value.input.title ?? "",
        },
      ];
      listeners.forEach((listener) => listener());
      return { _tag: "Success", value: undefined };
    }
    if (command === "import")
      return { _tag: "Success", value: { importedCount: 0, skippedCount: 0 } };
    return { _tag: "Success", value: undefined };
  };

// The folder list of this machine: a small, fixed disk.
type Entry = { name: string; kind?: "folder" | "git" };
const DISK: Record<string, Entry[]> = {
  [HOME]: [
    { name: "Desktop", kind: "folder" },
    { name: "Documents", kind: "folder" },
    { name: "Projects", kind: "folder" },
  ],
  [`${HOME}/Projects`]: [
    { name: "github", kind: "folder" },
    { name: "playground", kind: "folder" },
  ],
  [`${HOME}/Projects/github`]: [
    { name: "notes", kind: "folder" },
    { name: "storefront", kind: "git" },
  ],
  [`${HOME}/Projects/playground`]: [],
};
export const filesystemEnvironment = {
  browse: (value: unknown) => value,
  createDirectory: "mkdir",
};
export const useFilesystemReadAccess = () => ({
  canReadFiles: true,
  isPending: false,
  error: null,
});
export const useEnvironmentQuery = (
  value: { input: { partialPath: string } } | null | undefined,
) => {
  const refresh = () => {};
  if (!value) return { data: null, error: null, isPending: false, refresh };
  const path = value.input.partialPath.replace(/^~/, HOME).replace(/\/$/, "") || "/";
  const entries = DISK[path];
  if (entries === undefined) {
    return {
      data: null,
      isPending: false,
      refresh,
      error: `The folder '${path}' does not exist on this machine.`,
    };
  }
  return {
    error: null,
    isPending: false,
    refresh,
    data: {
      parentPath: path,
      homePath: HOME,
      version: 0,
      entries: entries
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .map((entry) => ({ ...entry, fullPath: `${path}/${entry.name}` })),
    },
  };
};
