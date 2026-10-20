import { useSyncExternalStore } from "react";

// One in-memory fleet: M4 (this machine), two Minis, a Mac Studio without the project and an M1 that is offline.
const nicknames = new Map<string, string>([["mini-2", "Mini 2"]]);
const listeners = new Set<() => void>();
let version = 0;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const useVersion = () => useSyncExternalStore(subscribe, () => version);
const shortName = (label: string) => label.replace(/^Anton's /, "");

export const environments = [
  ["m4", "Anton's MacBook M4MAX", "connected", true],
  ["mini-1", "Anton's Mac mini", "connected", false],
  ["mini-2", "Anton's Mac mini (2)", "connected", false],
  ["studio", "Anton's Mac Studio", "connected", false],
  ["m1", "Anton's MacBook Pro M1", "available", false],
].map(([environmentId, label, phase, thisMachine]) => ({
  environmentId,
  label,
  entry: { thisMachine },
  connection: { phase, error: null },
}));
const identity = (rootPath: string) => ({
  canonicalKey: "github.com/anton-abyzov/easychamp",
  rootPath,
  locator: { kind: "remote" },
});
export const projects = [
  {
    id: "easychamp-m4",
    environmentId: "m4",
    title: "EasyChamp",
    workspaceRoot: "/Users/anton/Projects/easychamp",
    repositoryIdentity: identity("/Users/anton/Projects/easychamp"),
  },
  {
    id: "easychamp-mini-1",
    environmentId: "mini-1",
    title: "EasyChamp",
    workspaceRoot: "/Users/anton/Projects/easychamp",
    repositoryIdentity: identity("/Users/anton/Projects/easychamp"),
  },
  // Same remote, never linked: Run on offers Link, not a second clone.
  {
    id: "champ-mini-2",
    environmentId: "mini-2",
    title: "champ-old",
    workspaceRoot: "/Users/anton/Code/champ-old",
    repositoryIdentity: identity("/Users/anton/Code/champ-old"),
  },
];

export function useMachineNicknames() {
  useVersion();
  return (environmentId: string, label?: string | null) =>
    nicknames.get(environmentId) ?? (label ? shortName(label) : environmentId);
}
export function useCustomMachineNickname(environmentId: string | null | undefined) {
  useVersion();
  return environmentId ? (nicknames.get(environmentId) ?? null) : null;
}
export const renameMachineLockText = () => null;
export function useRenameMachine() {
  return {
    lock: null,
    rename: (environmentId: string, name: string) => {
      if (name) nicknames.set(environmentId, name);
      else nicknames.delete(environmentId);
      version += 1;
      (window as any).renamed = { environmentId, name };
      for (const listener of listeners) listener();
      return true;
    },
  };
}

export const useProjectCoordinatorHandoff = () => async () => ({ kind: "standalone" });
export const environmentCatalog = { retryNow: "retryNow" };
export const isThisMachineTarget = (entry: { thisMachine?: boolean } | undefined) =>
  entry?.thisMachine === true;
// Commands are named by the proxies below; a fixture view installs handlers for the ones it drives.
export const handlers: Record<string, (input: any) => unknown> = {};
(window as any).calls = [];
export const useAtomCommand = (command: unknown) => async (request: unknown) => {
  (window as any).calls.push([command, request]);
  const handler = typeof command === "string" ? handlers[command] : undefined;
  try {
    return { _tag: "Success", value: await handler?.(request) };
  } catch (error) {
    return { _tag: "Failure", error };
  }
};
export const squashAtomCommandFailure = (failure: { error: unknown }) => failure.error;
export const isAtomCommandInterrupted = () => false;
const named = (prefix = "") =>
  new Proxy({}, { get: (_target, name) => `${prefix}${String(name)}` });
export const sourceControlEnvironment = named();
export const machineHandoff = named();
export const projectLink = named("link:");
export const linkCopyAsWorkers = async () => {
  (window as any).linked = true;
  return { status: "linked" };
};
export const waitForProject = async () => ({});
const capabilities = {
  cloneDestinationChecks: true,
  projectCloneTracking: true,
  projectLink: true,
};
export const useEnvironment = (environmentId: string) => {
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  return environment
    ? {
        label: environment.label,
        serverConfig: {
          environment: {
            platform: {
              machine: environmentId === "m4" || environmentId === "m1" ? "laptop" : "desktop",
            },
            capabilities,
          },
        },
      }
    : null;
};
export const useEnvironments = () => ({ environments });
export const useProjects = () => projects;
const permitted = new Set(["m4", "mini-1", "mini-2", "studio", "m1"]);
export const useEnvironmentsWithScope = () => permitted;
export const readEnvironmentScope = (environmentId: string) => permitted.has(environmentId);
export const useLegacySidebarEnabled = () => true;
export const useClientSettings = () => ({ mode: "repository", overrides: {} });
export const selectProjectGroupingSettings = () => ({});
export const deriveLogicalProjectKeyFromSettings = (project: { workspaceRoot: string }) =>
  project.workspaceRoot === "/Users/anton/Projects/easychamp" ? "easychamp" : project.workspaceRoot;
export const useScratchProject = () => ({
  openScratchProject: async () => null,
  scratchWorkspaceRootFor: (environmentId: string) => `/scratch/${environmentId}`,
});
export const machineLastSeenAt = () => null;
export const useMachineLastSeenVersion = () => 0;
export const Link = ({ to, ...props }: { to: string }) => <a href={to} {...props} />;
export function AddToMachineDialog(props: { open: boolean; destinationEnvironmentId: string }) {
  (window as any).addDialog = props.open ? props.destinationEnvironmentId : null;
  return null;
}
export function ProjectLinkDialog(props: {
  open: boolean;
  initialCandidate: { projectId: string };
}) {
  (window as any).linkDialog = props.open ? props.initialCandidate.projectId : null;
  return null;
}
