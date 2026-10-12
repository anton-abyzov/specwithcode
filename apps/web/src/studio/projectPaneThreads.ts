/**
 * Which threads open in a project's right panel. The rule of thumb: inside a
 * project, every thread of that project opens in its panel, and a thread only
 * leaves the project when it truly belongs to another one.
 */
import { ThreadId } from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";

import { isOrchestratorThreadId, projectCoordinatorRole } from "./projectCoordinatorThreads";

type PaneShell = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "projectId" | "deletedAt" | "lineage" | "forkedFrom"
>;

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
  return threadBelongsToProject(thread, scope, (id) => byId.get(id))
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
}

const MAX_THREAD_ID_LENGTH = 512;

export function parseProjectWorkspaceSearch(raw: Record<string, unknown>): ProjectWorkspaceSearch {
  const value = raw.thread;
  if (typeof value !== "string") return {};
  const id = value.trim();
  if (
    id.length === 0 ||
    id.length > MAX_THREAD_ID_LENGTH ||
    [...id].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
  )
    return {};
  return { thread: ThreadId.make(id) };
}

/** The search for /projects/$projectKey with `thread` open in the right panel, or none. */
export function projectWorkspaceSearch(thread: ThreadId | null): ProjectWorkspaceSearch {
  return thread === null ? {} : { thread };
}

type ChatShell = Pick<EnvironmentThreadShell, "id">;

/** A chat's place on a project page: the thread open in its right panel. */
export interface ProjectChatTarget {
  readonly projectKey: string;
  readonly threadId: ThreadId;
}

/**
 * Where a sidebar chat row, a notification or a shortcut opens a chat. In a
 * project whose checkout has a coordinator, the project page lists every chat
 * of that checkout as one of its threads, so each of them opens in the
 * project's right panel, as it does from the project page itself.
 *
 * A coordinator, current or previous, never opens in the panel. It opens full
 * page (returns null), where its approval, question, plan and run controls
 * are: the project page shows only its conversation, and a notification about
 * a coordinator is usually one of those requests. Full page is also right for
 * a project on several machines, whose page shows the chosen machine's
 * coordinator, which may not be the one that asked. Any other chat that is not
 * a project thread opens full page too.
 */
export function projectPaneTargetForChat(
  thread: ChatShell,
  project: { readonly projectKey: string; readonly coordinatorThreadId: string | null } | null,
): ProjectChatTarget | null {
  const coordinator = project?.coordinatorThreadId ?? null;
  if (!project || coordinator === null) return null;
  if (thread.id === coordinator || isOrchestratorThreadId(thread.id)) return null;
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
 * and still opens in the project's panel. Threads from servers that do not say
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
  if (chatProjectPaneTarget(thread, group) === null) return false;
  const shown = input.displayedCheckout;
  if (shown?.environmentId !== thread.environmentId || shown.id !== thread.projectId) return false;
  const seen = new Set<string>();
  let current: T | undefined = thread;
  for (let step = 0; current && step < MAX_LINEAGE_STEPS; step += 1) {
    if (current.createdBy === "agent") return true;
    seen.add(current.id);
    const parent = parentOf(current);
    if (parent === null || seen.has(parent)) return false;
    current = input.lookup(parent);
  }
  return false;
}

/** Where a chat opens, as router navigation options. */
export function chatNavigationTarget(
  thread: ChatShell & Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
  group: ChatProjectGroup | undefined,
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
  const pane = chatProjectPaneTarget(thread, group);
  return pane
    ? {
        to: "/projects/$projectKey",
        params: { projectKey: pane.projectKey },
        search: projectWorkspaceSearch(pane.threadId),
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
