/**
 * Agent-owned workers open beside their project coordinator. Independent chats
 * retain their full page even when they use the same folder.
 */
import { ThreadId } from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";

import { isOrchestratorThreadId, projectCoordinatorRole } from "./projectCoordinatorThreads";

type PaneShell = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "projectId" | "deletedAt" | "lineage" | "forkedFrom"
> &
  Partial<Pick<EnvironmentThreadShell, "createdBy">>;

export interface ProjectPaneScope {
  readonly environmentId: string;
  readonly projectId: string;
  /** The coordinator the project page shows in its main column; null until known. */
  readonly coordinatorThreadId?: string | null;
}

/** Forks and subagents rarely nest deeply; the cap only stops a malformed cycle. */
const MAX_LINEAGE_STEPS = 32;

function parentOf(
  thread: Pick<EnvironmentThreadShell, "id" | "lineage" | "forkedFrom">,
): string | null {
  const root = thread.lineage.rootThreadId;
  return (
    thread.lineage.parentThreadId ??
    (thread.forkedFrom?.type === "run" ? thread.forkedFrom.threadId : null) ??
    (root && root !== thread.id ? root : null)
  );
}

/**
 * A thread belongs to the project when it is the project's own, or when a parent
 * it was forked or spawned from is: a provider-native subagent can carry another
 * project id while still being part of a project thread's conversation.
 */
export function threadBelongsToProject<T extends PaneShell>(
  thread: T,
  scope: ProjectPaneScope,
  lookup: (threadId: string) => T | undefined,
): boolean {
  if (thread.environmentId !== scope.environmentId) return false;
  const seen = new Set<string>();
  let current: T | undefined = thread;
  for (let step = 0; current && step < MAX_LINEAGE_STEPS; step += 1) {
    if (current.environmentId !== scope.environmentId) return false;
    if (current.projectId === scope.projectId) return true;
    seen.add(current.id);
    const parent = parentOf(current);
    if (parent === null || seen.has(parent)) return false;
    current = lookup(parent);
  }
  return false;
}

export type ProjectPaneThreadDecision<T> =
  | { readonly kind: "pane"; readonly thread: T }
  /**
   * The project's coordinator: it is the main conversation, so it never opens in
   * the panel beside itself. The page shows the main conversation instead.
   */
  | { readonly kind: "coordinator" }
  /** Another project's thread, or another environment's: open it full page there. */
  | { readonly kind: "elsewhere"; readonly environmentId: string }
  | { readonly kind: "deleted" }
  /** Not loaded on this client yet. */
  | { readonly kind: "unknown" };

/** Decides where a thread link opens from inside a project. */
export function projectPaneThread<T extends PaneShell>(
  threads: readonly T[],
  scope: ProjectPaneScope,
  threadId: string,
  environmentId: string = scope.environmentId,
): ProjectPaneThreadDecision<T> {
  if (environmentId !== scope.environmentId) return { kind: "elsewhere", environmentId };
  const role = projectCoordinatorRole(threadId, {
    projectId: scope.projectId,
    coordinatorThreadId: scope.coordinatorThreadId ?? null,
  });
  if (role === "current") return { kind: "coordinator" };
  const byId = new Map<string, T>();
  for (const thread of threads)
    if (thread.environmentId === scope.environmentId) byId.set(thread.id, thread);
  const thread = byId.get(threadId);
  if (!thread) {
    // `?thread=` carries no machine: a thread only another checkout's machine has
    // opens full page there rather than leaving the panel empty.
    const remote = threads.find((t) => t.id === threadId && t.deletedAt === null);
    return remote
      ? { kind: "elsewhere", environmentId: remote.environmentId }
      : { kind: "unknown" };
  }
  if (thread.deletedAt !== null) return { kind: "deleted" };
  // A previous coordinator is not the conversation on screen: its own page shows its history.
  if (role === "previous") return { kind: "elsewhere", environmentId: thread.environmentId };
  return threadBelongsToProject(thread, scope, (id) => byId.get(id)) &&
    isAgentOwnedProjectThread(thread, scope.coordinatorThreadId ?? null, (id) => byId.get(id))
    ? { kind: "pane", thread }
    : { kind: "elsewhere", environmentId: thread.environmentId };
}

/** What to do about the URL's `?thread=` once the project knows where it lives. */
export type PaneSelectionCorrection =
  | { readonly kind: "none" }
  /** Clear the panel's thread (replacing the entry) and show the main conversation. */
  | { readonly kind: "coordinator" }
  /** Close the panel, replacing the history entry so Back does not reopen a dead link. */
  | { readonly kind: "close" }
  | { readonly kind: "elsewhere"; readonly environmentId: string };

/**
 * A deleted thread closes the panel; another project's opens full page; one this
 * client never loads closes the panel once every host has answered, so the URL
 * and the sidebar do not point at a thread the panel cannot show.
 */
export function paneSelectionCorrection(
  decision: ProjectPaneThreadDecision<unknown> | null,
  threadsLoaded: boolean,
): PaneSelectionCorrection {
  if (decision === null || decision.kind === "pane") return { kind: "none" };
  if (decision.kind === "coordinator") return { kind: "coordinator" };
  if (decision.kind === "deleted") return { kind: "close" };
  if (decision.kind === "elsewhere")
    return { kind: "elsewhere", environmentId: decision.environmentId };
  return threadsLoaded ? { kind: "close" } : { kind: "none" };
}

/** `?thread=<id>` on /projects/$projectKey names the thread open in the right panel. */
export interface ProjectWorkspaceSearch {
  readonly thread?: ThreadId;
  /** Exact checkout for a link; never changes the saved coordinator machine. */
  readonly checkout?: string;
}

const MAX_THREAD_ID_LENGTH = 512;

export function parseProjectWorkspaceSearch(raw: Record<string, unknown>): ProjectWorkspaceSearch {
  const valid = (value: unknown, limit: number) => {
    if (typeof value !== "string") return null;
    const text = value.trim();
    return text.length > 0 &&
      text.length <= limit &&
      ![...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
      ? text
      : null;
  };
  const thread = valid(raw.thread, MAX_THREAD_ID_LENGTH);
  const checkout = valid(raw.checkout, 1024);
  return {
    ...(thread ? { thread: ThreadId.make(thread) } : {}),
    ...(checkout && checkout.includes(":") ? { checkout } : {}),
  };
}

/** The project view keeps an explicit linked checkout while its side pane changes. */
export function projectWorkspaceSearch(
  thread: ThreadId | null,
  checkout?: string | null,
): ProjectWorkspaceSearch {
  return { ...(thread === null ? {} : { thread }), ...(checkout ? { checkout } : {}) };
}

type ChatShell = Pick<EnvironmentThreadShell, "id"> &
  Partial<Pick<EnvironmentThreadShell, "createdBy" | "lineage" | "forkedFrom">>;

/** A coordinator or agent-created root owns its descendants; a human chat keeps its own agents. */
export function isAgentOwnedProjectThread(
  thread: ChatShell,
  coordinator: string | null,
  lookup: (id: string) => ChatShell | undefined,
): boolean {
  const seen = new Set<string>();
  let current: ChatShell | undefined = thread;
  for (let step = 0; current && step < MAX_LINEAGE_STEPS; step += 1) {
    seen.add(current.id);
    const parent = parentOf({
      ...current,
      lineage: current.lineage ?? {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: current.id,
      },
      forkedFrom: current.forkedFrom ?? null,
    });
    if (parent !== null && parent === coordinator) return true;
    if (parent === null) return current.createdBy === "agent";
    // A missing parent is unproven ownership; its shell arrival re-evaluates the route.
    if (seen.has(parent)) return false;
    current = lookup(parent);
  }
  return false;
}

/** A chat's place on a project page: the thread open in its right panel. */
export interface ProjectChatTarget {
  readonly projectKey: string;
  readonly threadId: ThreadId;
}

/** Agent-owned workers open beside their coordinator; independent chats keep their own page. */
export function projectPaneTargetForChat(
  thread: ChatShell,
  project: { readonly projectKey: string; readonly coordinatorThreadId: string | null } | null,
  lookup: (threadId: string) => ChatShell | undefined = () => undefined,
): ProjectChatTarget | null {
  const coordinator = project?.coordinatorThreadId ?? null;
  if (!project || coordinator === null) return null;
  if (thread.id === coordinator || isOrchestratorThreadId(thread.id)) return null;
  if (!isAgentOwnedProjectThread(thread, coordinator, lookup)) return null;
  return { projectKey: project.projectKey, threadId: thread.id };
}

interface ChatProjectGroup {
  readonly projectKey: string;
  readonly memberProjects: ReadonlyArray<{
    readonly environmentId: string;
    readonly id: string;
    readonly workspaceSettings?: { readonly coordinatorThreadId: string | null } | null | undefined;
  }>;
}

/** The sidebar's decision for one chat row, given the project group the chat sits in. */
export function chatProjectPaneTarget(
  thread: ChatShell & Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
  group: ChatProjectGroup | undefined,
  lookup: (threadId: string) => ChatShell | undefined = () => undefined,
): ProjectChatTarget | null {
  const member = group?.memberProjects.find(
    (candidate) =>
      candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
  );
  return projectPaneTargetForChat(
    thread,
    group && member
      ? {
          projectKey: group.projectKey,
          coordinatorThreadId: member.workspaceSettings?.coordinatorThreadId ?? null,
        }
      : null,
    lookup,
  );
}

type OwnedShell = ChatShell &
  Pick<
    EnvironmentThreadShell,
    "environmentId" | "projectId" | "lineage" | "forkedFrom" | "createdBy"
  >;

/**
 * A thread its project owns, which the sidebar's list of chats leaves out: one an
 * agent started in the project (a coordinator's worker), or a fork or subagent of
 * one, in the checkout whose page the project row opens, so that page lists it.
 * A chat the person started stays a chat, even in a project with a coordinator,
 * and opens on its own page. Threads from servers that do not say
 * who started them count as the person's.
 */
export function isProjectOwnedChat<T extends OwnedShell>(
  thread: T,
  group: ChatProjectGroup | undefined,
  input: {
    /** The checkout the project page shows: its coordinator's machine. */
    readonly displayedCheckout: { readonly environmentId: string; readonly id: string } | undefined;
    /** Another thread on the same machine, for walking up forks and subagents. */
    readonly lookup: (threadId: string) => T | undefined;
  },
): boolean {
  if (chatProjectPaneTarget(thread, group, input.lookup) === null) return false;
  const shown = input.displayedCheckout;
  if (shown?.environmentId !== thread.environmentId || shown.id !== thread.projectId) return false;
  return true;
}

/** Where a chat opens, as router navigation options. */
export function chatNavigationTarget(
  thread: ChatShell & Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
  group: ChatProjectGroup | undefined,
  lookup: (threadId: string) => ChatShell | undefined = () => undefined,
):
  | {
      readonly to: "/projects/$projectKey";
      readonly params: { readonly projectKey: string };
      readonly search: ProjectWorkspaceSearch;
    }
  | {
      readonly to: "/$environmentId/$threadId";
      readonly params: {
        readonly environmentId: EnvironmentThreadShell["environmentId"];
        readonly threadId: ThreadId;
      };
    } {
  const member = group?.memberProjects.find(
    (item) => item.environmentId === thread.environmentId && item.id === thread.projectId,
  );
  const checkout = member ? `${member.environmentId}:${member.id}` : undefined;
  if (
    group &&
    member &&
    projectCoordinatorRole(thread.id, {
      projectId: member.id,
      coordinatorThreadId: member.workspaceSettings?.coordinatorThreadId ?? null,
    }) === "current"
  )
    return {
      to: "/projects/$projectKey",
      params: { projectKey: group.projectKey },
      search: projectWorkspaceSearch(null, checkout),
    };
  const pane = chatProjectPaneTarget(thread, group, lookup);
  return pane
    ? {
        to: "/projects/$projectKey",
        params: { projectKey: pane.projectKey },
        search: projectWorkspaceSearch(pane.threadId, checkout),
      }
    : {
        to: "/$environmentId/$threadId",
        params: { environmentId: thread.environmentId, threadId: thread.id },
      };
}

/**
 * The sidebar row that is "current": the full-page chat, or on a project page the
 * chat open in its right panel. Keyboard next/previous starts from it.
 */
export function currentSidebarChatKey<C>(input: {
  readonly routeThreadKey: string | null;
  readonly paneThreadId: string | null;
  readonly activeProjectKey: string | null;
  readonly chats: readonly C[];
  readonly keyOf: (chat: C) => string;
  readonly idOf: (chat: C) => string;
  readonly projectKeyOf: (chat: C) => string | null;
}): string | null {
  if (input.routeThreadKey !== null) return input.routeThreadKey;
  if (input.paneThreadId === null || input.activeProjectKey === null) return null;
  const chat = input.chats.find(
    (candidate) =>
      input.idOf(candidate) === input.paneThreadId &&
      input.projectKeyOf(candidate) === input.activeProjectKey,
  );
  return chat === undefined ? null : input.keyOf(chat);
}
