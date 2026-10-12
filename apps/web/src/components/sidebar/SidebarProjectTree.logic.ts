import { scopeThreadRef, scopedThreadKey } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";

export type ProjectTreeSessionStatus = "attention" | "working" | "failed" | "ready" | "resolved";

export interface ProjectTreeSession {
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly status: ProjectTreeSessionStatus;
  readonly statusLabel: string;
  readonly updatedAt: number;
}

export interface ProjectTreeGroup {
  readonly key: string;
  /** Null for sessions whose project is not registered in any group. */
  readonly project: SidebarProjectSnapshot | null;
  readonly label: string;
  readonly sessions: readonly ProjectTreeSession[];
  readonly attentionCount: number;
  readonly workingCount: number;
  readonly lastActivity: number;
}

export const PROJECT_TREE_OTHER_KEY = "studio:other-sessions";
export const PROJECT_TREE_SESSION_PAGE = 5;
export const PROJECT_TREE_PROJECT_PAGE = 12;

const STATUS_RANK: Record<ProjectTreeSessionStatus, number> = {
  attention: 0,
  working: 1,
  failed: 2,
  ready: 3,
  resolved: 4,
};

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function classifyProjectTreeSession(thread: EnvironmentThreadShell): {
  status: ProjectTreeSessionStatus;
  label: string;
} {
  const status = resolveSidebarThreadStatus(thread);
  switch (status) {
    case "approval":
      return { status: "attention", label: "Approval requested" };
    case "input":
      return { status: "attention", label: "Answer needed" };
    case "limited":
      return { status: "attention", label: "Usage limit reached" };
    case "failed":
      return { status: "failed", label: "Run needs review" };
    case "working":
      return { status: "working", label: "Working" };
    case "waiting":
      return { status: "working", label: "Waiting for background work" };
  }
  if (thread.hasActionableProposedPlan) return { status: "attention", label: "Plan ready" };
  if (thread.settledOverride === "settled") return { status: "resolved", label: "Resolved" };
  return { status: "ready", label: "Ready" };
}

/**
 * Projects first, sessions nested under them, the way Claude Code desktop
 * organizes its sidebar. Groups keep the caller's order (a manual project
 * order) unless `orderByActivity` puts the most recently active first; inside
 * a group, sessions that need a decision or are running
 * come first, then the most recently updated, with resolved sessions last.
 */
export function buildProjectTree(
  groups: readonly SidebarProjectSnapshot[],
  threads: readonly EnvironmentThreadShell[],
  options: { readonly orderByActivity?: boolean } = {},
): ProjectTreeGroup[] {
  const groupKeyByProject = new Map<string, string>();
  for (const group of groups) {
    for (const ref of group.memberProjectRefs) {
      groupKeyByProject.set(`${ref.environmentId}:${ref.projectId}`, group.projectKey);
    }
  }
  const sessionsByGroup = new Map<string, ProjectTreeSession[]>();
  for (const thread of threads) {
    if (thread.deletedAt !== null || thread.archivedAt !== null) continue;
    const groupKey =
      groupKeyByProject.get(`${thread.environmentId}:${thread.projectId}`) ??
      PROJECT_TREE_OTHER_KEY;
    const { status, label } = classifyProjectTreeSession(thread);
    const list = sessionsByGroup.get(groupKey) ?? [];
    list.push({
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
      status,
      statusLabel: label,
      updatedAt: timestamp(thread.updatedAt),
    });
    sessionsByGroup.set(groupKey, list);
  }
  const sortSessions = (sessions: ProjectTreeSession[]) =>
    sessions.sort((a, b) => {
      const urgent = (s: ProjectTreeSession) =>
        s.status === "attention" || s.status === "working" ? 0 : 1;
      return (
        urgent(a) - urgent(b) ||
        (a.status === "resolved" ? 1 : 0) - (b.status === "resolved" ? 1 : 0) ||
        b.updatedAt - a.updatedAt ||
        STATUS_RANK[a.status] - STATUS_RANK[b.status]
      );
    });
  const summarize = (
    key: string,
    project: SidebarProjectSnapshot | null,
    label: string,
  ): ProjectTreeGroup => {
    const sessions = sortSessions(sessionsByGroup.get(key) ?? []);
    return {
      key,
      project,
      label,
      sessions,
      attentionCount: sessions.filter((s) => s.status === "attention").length,
      workingCount: sessions.filter((s) => s.status === "working").length,
      lastActivity: sessions.reduce((latest, s) => Math.max(latest, s.updatedAt), 0),
    };
  };
  const tree = groups.map((group) => summarize(group.projectKey, group, group.displayName));
  if (options.orderByActivity) {
    // Stable: projects without sessions keep the caller's order at the end.
    tree.sort((a, b) => b.lastActivity - a.lastActivity);
  }
  if (sessionsByGroup.has(PROJECT_TREE_OTHER_KEY)) {
    tree.push(summarize(PROJECT_TREE_OTHER_KEY, null, "Other sessions"));
  }
  return tree;
}

/**
 * Without a saved choice, a project starts open when it holds the open
 * session, needs a decision, is running, or is one of the three most
 * recently active. Twenty registered projects stay scannable that way.
 */
export function resolveProjectTreeExpanded(
  tree: readonly ProjectTreeGroup[],
  saved: Readonly<Record<string, boolean>>,
  activeThreadKey: string | null,
): Set<string> {
  const recent = new Set(
    [...tree]
      .filter((group) => group.lastActivity > 0)
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, 3)
      .map((group) => group.key),
  );
  const expanded = new Set<string>();
  for (const group of tree) {
    const savedChoice = saved[group.key];
    const holdsActive =
      activeThreadKey !== null && group.sessions.some((s) => s.key === activeThreadKey);
    const open =
      holdsActive ||
      (savedChoice ??
        (group.attentionCount > 0 || group.workingCount > 0 || recent.has(group.key)));
    if (open) expanded.add(group.key);
  }
  return expanded;
}

export function compactAge(updatedAt: number, now: number): string {
  if (!updatedAt) return "";
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 10_080) return `${Math.floor(minutes / 1_440)}d`;
  return `${Math.floor(minutes / 10_080)}w`;
}
