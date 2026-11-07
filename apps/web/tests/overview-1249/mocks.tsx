// Stand-ins for the modules vite.config.ts redirects here: synthetic data, no server.
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { createContext, useContext, type ReactNode } from "react";

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const M4 = "m4",
  M1 = "m1",
  MINI = "ministorm",
  MBP = "mbp";

const projects = [
  { id: "sw-m4", environmentId: M4, title: "specweave" },
  { id: "sw-m1", environmentId: M1, title: "specweave" },
  { id: "oly", environmentId: MBP, title: "oly" },
  { id: "ec-m4", environmentId: M4, title: "EasyChamp" },
  { id: "ec-m1", environmentId: M1, title: "EasyChamp" },
  { id: "sketch", environmentId: M1, title: "sketchmate_project" },
  { id: "swc", environmentId: M4, title: "specwithcode-dev" },
];
const groups = [
  ["specweave", ["sw-m4", "sw-m1"]],
  ["oly", ["oly"]],
  ["EasyChamp", ["ec-m4", "ec-m1"]],
  ["sketchmate_project", ["sketch"]],
  ["specwithcode-dev", ["swc"]],
].map(([name, ids]) => {
  const members = projects.filter((p) => (ids as string[]).includes(p.id));
  return {
    projectKey: name as string,
    displayName: name as string,
    memberProjectRefs: members.map((p) => ({ environmentId: p.environmentId, projectId: p.id })),
    memberProjects: members,
  };
});

function shell(
  id: string,
  title: string,
  projectId: string,
  minutes: number,
  extra: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  const project = projects.find((p) => p.id === projectId)!;
  return {
    id,
    environmentId: project.environmentId,
    projectId,
    title,
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    updatedAt: ago(minutes),
    createdAt: ago(minutes + 60),
    settledOverride: null,
    settledAt: null,
    archivedAt: null,
    deletedAt: null,
    ...extra,
  } as unknown as EnvironmentThreadShell;
}
const ask = { hasPendingUserInput: true };
const approve = { hasPendingApprovals: true };
const plan = { hasActionableProposedPlan: true };
const done = { settledOverride: "settled" } as Partial<EnvironmentThreadShell>;
const running = { runtime: { status: "running" } } as Partial<EnvironmentThreadShell>;
const shells: EnvironmentThreadShell[] = [
  shell("a1", "Open-source SpecWithCode (MIT)", "sw-m4", 7, ask),
  shell("a2", "Rethink onboarding steps", "sw-m4", 28, ask),
  shell("a3", "Aide missing on Ministorm", "sw-m4", 28, ask),
  shell("a4", "Fix Sadiya Datadog role revert", "oly", 360, approve),
  shell("a5", "Set up Datadog On-Call profile", "oly", 420, approve),
  shell("a6", "Club RSVP decline notifications", "ec-m1", 420, ask),
  shell("a7", "Stripe Connect fraud watch", "ec-m4", 720, plan),
  shell("a8", "Fix nova-24x7 failed run", "oly", 1440, ask),
  shell("a9", "Release notes for 1.0.206", "sw-m1", 1500, ask),
  shell("a10", "Copilot availability probe", "sw-m1", 1600, ask),
  shell("w1", "Overview page design review", "swc", 0, running),
  shell("r1", "EasyChamp hourly New Releases", "ec-m1", 60),
  shell("r2", "Move M1 release runner to Ministorm", "sw-m1", 120),
  shell("r3", "Media rule: global files only", "sw-m1", 180),
  shell("r4", "Test Android File Approval", "sketch", 1500),
  shell("r5", "Run Date Command on Android", "sketch", 1560),
  ...Array.from({ length: 26 }, (_, index) =>
    shell(`r${index + 6}`, `Routine check ${index + 1}`, "sw-m4", 3000 + index * 90),
  ),
  shell("d1", "Access card check (1.0.191)", "sw-m4", 2000, done),
  shell("d2", "Multiply 3 by 7", "sw-m4", 2100, done),
];

const environments = [
  [M4, "M4 Max", "connected"],
  [M1, "M1 Max", "connected"],
  [MINI, "ministorm", "reconnecting"],
  [MBP, "Anton's MacBook Pro", "connected"],
].map(([environmentId, label, phase]) => ({
  environmentId,
  label,
  connection: { phase, error: null, traceId: null },
  serverConfig: {
    environment: { serverVersion: environmentId === MINI ? "1.0.202" : "1.0.205" },
  },
}));

const empty = new URLSearchParams(location.search).get("data") === "empty";

// studio/useProjectAttention
export const useAttentionMembers = () =>
  projects.map((project) => ({
    environmentId: project.environmentId,
    projectId: project.id,
    coordinatorThreadId: `project-coordinator:${project.id}`,
    includeUserRoots: false,
    freshness: "live" as const,
    remoteWorkers: [],
    remoteWorkersComplete: true,
  }));
export const projectAttentionRoots = () => [];
// components/settings/useSettingsProjectGroups
export const useSettingsProjectGroups = () => (empty ? [] : groups);
// hooks/useSettings
export const useAideEnabled = () => true;
// state/entities
export const useProjects = () => (empty ? [] : projects);
export const useThreadShells = () => (empty ? [] : shells);
export const useServerConfigs = () => new Map();
export const useAllEnvironmentShellsBootstrapped = () => true;
// state/environments
export const useEnvironments = () => ({ environments, isReady: true, networkStatus: "online" });
export const usePrimaryEnvironmentId = () => M4;
// state/session
export const useEnvironmentsWithScope = () => new Set(environments.map((e) => e.environmentId));
export const useEnvironmentScope = () => false;
export const useEnvironmentScopeAccess = () => "denied";
// hooks/useNewChatDestination
export const useNewChatDestination = () => async () => ({ kind: "unavailable" });
// composerDraftStore
export const useComposerDraftStore = { getState: () => ({ setModelSelection: () => {} }) };
// env
export const isElectron = false;
// components/studio/WhatYouCanDo, CapacityFleet
export const WhatYouCanDo = () => null;
export const CapacityFleet = () => null;
// components/ProjectFavicon
export const ProjectFavicon = (props: {
  project: { title?: string; displayName?: string };
  className?: string;
}) => (
  <span
    className={props.className}
    style={{
      display: "inline-grid",
      placeItems: "center",
      background: "var(--secondary)",
      fontSize: 11,
      fontWeight: 700,
    }}
  >
    {(props.project.displayName ?? props.project.title ?? "?").slice(0, 1).toUpperCase()}
  </span>
);
// components/WorkspacePageHeader, ui/sidebar
export const WorkspacePageHeader = (props: { children: ReactNode; className?: string }) => (
  <header
    className={props.className}
    style={{ display: "flex", alignItems: "center", gap: 12, height: 40, padding: "0 20px" }}
  >
    {props.children}
  </header>
);
export const SidebarInset = (props: { children: ReactNode; className?: string }) => (
  <section className={props.className} style={{ display: "flex", flexDirection: "column" }}>
    {props.children}
  </section>
);
// components/studio/shell/ModelBadge
export const useProviderEntriesByEnvironment = () => new Map();
export const ThreadModelBadge = () => <span>Claude Code · Opus 5.5</span>;
// studio/useThreadIncrementProgress
export const useThreadIncrementProgress = () => new Map();
// studio/projectPaneThreads
export const chatNavigationTarget = (thread: { environmentId: string; id: string }) => ({
  to: "/$environmentId/$threadId",
  params: { environmentId: thread.environmentId, threadId: thread.id },
});
// @tanstack/react-router
export const Link = ({
  to,
  params,
  search: _search,
  children,
  ...props
}: {
  to: string;
  params?: Record<string, string>;
  search?: unknown;
  children: ReactNode;
  [key: string]: unknown;
}) => (
  <a
    href={
      params?.projectKey
        ? `#/projects/${params.projectKey}`
        : params
          ? `#/${params.environmentId}/${params.threadId}`
          : `#${to}`
    }
    {...props}
  >
    {children}
  </a>
);
// components/ui/select
const Chosen = createContext("");
export const Select = (props: { children: ReactNode; value: string }) => (
  <Chosen.Provider value={props.value}>{props.children}</Chosen.Provider>
);
export const SelectTrigger = (props: { children: ReactNode; id?: string; className?: string }) => (
  <button type="button" id={props.id} className={props.className}>
    {props.children}
  </button>
);
export const SelectValue = (props: { children: (value: string) => ReactNode }) =>
  props.children(useContext(Chosen));
export const SelectPopup = () => null;
export const SelectItem = () => null;
