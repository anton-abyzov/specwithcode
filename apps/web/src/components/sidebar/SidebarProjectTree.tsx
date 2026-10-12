/**
 * Projects view of the sidebar: every registered project is a top-level row
 * with its icon and colour, and its sessions are nested under it, the way
 * Claude Code desktop groups sessions by folder. The flat "Recent" list stays
 * one click away for pinning, snoozing and drag ordering.
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import type { ScopedProjectRef, ScopedThreadRef } from "@specweave-studio/contracts";
import { useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  CheckIcon,
  ChevronRightIcon,
  FolderIcon,
  LayoutDashboardIcon,
  SquarePenIcon,
} from "lucide-react";
import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "~/lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  buildProjectTree,
  compactAge,
  PROJECT_TREE_PROJECT_PAGE,
  PROJECT_TREE_SESSION_PAGE,
  resolveProjectTreeExpanded,
  type ProjectTreeGroup,
  type ProjectTreeSession,
} from "./SidebarProjectTree.logic";

export type SidebarView = "projects" | "recent";
export const SIDEBAR_VIEW_STORAGE_KEY = "studio:sidebar-view:v1";
const EXPANDED_STORAGE_KEY = "studio:sidebar-project-tree:v1";
const SidebarViewSchema = Schema.Literals(["projects", "recent"]);
const ExpandedSchema = Schema.Record(Schema.String, Schema.Boolean);

export function useSidebarView() {
  return useLocalStorage<SidebarView, SidebarView>(
    SIDEBAR_VIEW_STORAGE_KEY,
    "projects",
    SidebarViewSchema,
  );
}

export function SidebarViewToggle(props: {
  view: SidebarView;
  onChange: (view: SidebarView) => void;
}) {
  const options: ReadonlyArray<{ value: SidebarView; label: string }> = [
    { value: "projects", label: "Projects" },
    { value: "recent", label: "Recent" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Sidebar view"
      className="mx-0.5 mb-2 grid grid-cols-2 gap-0.5 rounded-lg bg-sidebar-row-hover/70 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={props.view === option.value}
          onClick={() => props.onChange(option.value)}
          className={cn(
            "h-7 cursor-pointer rounded-md text-xs font-medium transition-colors",
            props.view === option.value
              ? "bg-sidebar text-sidebar-foreground shadow-xs"
              : "text-sidebar-muted-foreground hover:text-sidebar-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SidebarProjectTree(props: {
  projectGroups: readonly SidebarProjectSnapshot[];
  threads: readonly EnvironmentThreadShell[];
  routeThreadKey: string | null;
  /** On for the "updated" project sort; manual and created orders stay as given. */
  orderByActivity: boolean;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
  onOpenProject: (project: SidebarProjectSnapshot) => void;
  onNewSession: (projectRef: ScopedProjectRef) => void;
  onThreadContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
}) {
  const nowMinute = useNowMinute();
  const now = Date.parse(nowMinute) || Date.now();
  const activeProjectKey = useParams({
    strict: false,
    select: (params) => (params as { projectKey?: string }).projectKey ?? null,
  });
  const [saved, setSaved] = useLocalStorage(EXPANDED_STORAGE_KEY, {}, ExpandedSchema);
  const [shownSessions, setShownSessions] = useState<Record<string, number>>({});
  const [showAllProjects, setShowAllProjects] = useState(false);
  const tree = useMemo(
    () =>
      buildProjectTree(props.projectGroups, props.threads, {
        orderByActivity: props.orderByActivity,
      }),
    [props.orderByActivity, props.projectGroups, props.threads],
  );
  const expanded = useMemo(
    () => resolveProjectTreeExpanded(tree, saved, props.routeThreadKey),
    [props.routeThreadKey, saved, tree],
  );
  const visibleTree =
    showAllProjects || tree.length <= PROJECT_TREE_PROJECT_PAGE + 2
      ? tree
      : tree.filter(
          (group, index) =>
            index < PROJECT_TREE_PROJECT_PAGE ||
            group.attentionCount > 0 ||
            group.workingCount > 0 ||
            group.key === activeProjectKey,
        );
  const hiddenProjects = tree.length - visibleTree.length;

  const toggle = (key: string) =>
    setSaved((previous) => ({ ...previous, [key]: !expanded.has(key) }));

  return (
    <div className="flex flex-col gap-0.5" data-testid="sidebar-project-tree">
      <ul role="tree" aria-label="Projects and sessions" className="flex flex-col gap-0.5">
        {visibleTree.map((group) => {
          const open = expanded.has(group.key);
          const limit = shownSessions[group.key] ?? PROJECT_TREE_SESSION_PAGE;
          const sessions = group.sessions.slice(0, limit);
          const remaining = group.sessions.length - sessions.length;
          return (
            <li
              key={group.key}
              role="treeitem"
              aria-expanded={open}
              aria-selected={group.key === activeProjectKey}
              className="list-none"
            >
              <ProjectRow
                group={group}
                open={open}
                active={group.key === activeProjectKey}
                onToggle={() => toggle(group.key)}
                onOpenProject={props.onOpenProject}
                onNewSession={props.onNewSession}
              />
              {open ? (
                <ul role="group" className="relative mb-1 flex flex-col gap-px">
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-0.5 bottom-0.5 left-[17px] w-px bg-sidebar-border"
                  />
                  {sessions.length === 0 ? (
                    <li className="list-none py-1 pr-2 pl-9 text-xs text-sidebar-muted-foreground/70">
                      No sessions yet
                    </li>
                  ) : (
                    sessions.map((session) => (
                      <SessionRow
                        key={session.key}
                        session={session}
                        now={now}
                        active={props.routeThreadKey === session.key}
                        onOpen={props.onOpenThread}
                        onContextMenu={props.onThreadContextMenu}
                      />
                    ))
                  )}
                  {remaining > 0 ? (
                    <li className="list-none">
                      <button
                        type="button"
                        onClick={() =>
                          setShownSessions((previous) => ({
                            ...previous,
                            [group.key]: limit + 10,
                          }))
                        }
                        className="flex h-7 w-full cursor-pointer items-center rounded-md pr-2 pl-9 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                      >
                        Show {Math.min(remaining, 10)} more
                        <span className="ml-1 text-sidebar-muted-foreground/60">
                          of {group.sessions.length}
                        </span>
                      </button>
                    </li>
                  ) : limit > PROJECT_TREE_SESSION_PAGE &&
                    group.sessions.length > PROJECT_TREE_SESSION_PAGE ? (
                    <li className="list-none">
                      <button
                        type="button"
                        onClick={() =>
                          setShownSessions((previous) => ({
                            ...previous,
                            [group.key]: PROJECT_TREE_SESSION_PAGE,
                          }))
                        }
                        className="flex h-7 w-full cursor-pointer items-center rounded-md pr-2 pl-9 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                      >
                        Show less
                      </button>
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {hiddenProjects > 0 || (showAllProjects && tree.length > PROJECT_TREE_PROJECT_PAGE + 2) ? (
        <button
          type="button"
          onClick={() => setShowAllProjects((value) => !value)}
          className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          <FolderIcon aria-hidden className="size-3.5 shrink-0" />
          {showAllProjects ? "Show fewer projects" : `Show ${hiddenProjects} more projects`}
        </button>
      ) : null}
    </div>
  );
}

function ProjectRow(props: {
  group: ProjectTreeGroup;
  open: boolean;
  active: boolean;
  onToggle: () => void;
  onOpenProject: (project: SidebarProjectSnapshot) => void;
  onNewSession: (projectRef: ScopedProjectRef) => void;
}) {
  const { group } = props;
  const project = group.project;
  const projectRef = project?.memberProjectRefs[0] ?? null;
  return (
    <div
      className={cn(
        "group/project relative flex h-8 items-center gap-1 rounded-md pr-1 text-sidebar-foreground",
        props.active ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
      )}
    >
      <button
        type="button"
        onClick={props.onToggle}
        aria-label={`${props.open ? "Collapse" : "Expand"} ${group.label}`}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md pl-1 text-left"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-sidebar-muted-foreground transition-transform duration-150",
            props.open && "rotate-90",
          )}
        />
        {project ? (
          <ProjectFavicon project={project} className="size-[18px] shrink-0" />
        ) : (
          <FolderIcon aria-hidden className="size-[18px] shrink-0 text-sidebar-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.005em]">
          {group.label}
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-1 group-hover/project:hidden group-focus-within/project:hidden">
        {group.attentionCount > 0 ? (
          <span
            title={`${group.attentionCount} need${group.attentionCount === 1 ? "s" : ""} you`}
            className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-warning/15 px-1.5 text-[10px] font-semibold text-warning-foreground"
          >
            {group.attentionCount}
          </span>
        ) : null}
        {group.workingCount > 0 ? (
          <span
            title={`${group.workingCount} working`}
            className="size-1.5 animate-pulse rounded-full bg-success"
          />
        ) : null}
        {group.attentionCount === 0 && group.sessions.length > 0 ? (
          <span className="pr-1 text-[11px] tabular-nums text-sidebar-muted-foreground/70">
            {group.sessions.length}
          </span>
        ) : null}
      </span>
      {project ? (
        <span className="hidden shrink-0 items-center group-hover/project:flex group-focus-within/project:flex">
          <button
            type="button"
            title={`Open ${group.label}`}
            aria-label={`Open project ${group.label}`}
            onClick={() => props.onOpenProject(project)}
            className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          >
            <LayoutDashboardIcon aria-hidden className="size-3.5" />
          </button>
          {projectRef ? (
            <button
              type="button"
              title={`New session in ${group.label}`}
              aria-label={`New session in ${group.label}`}
              onClick={() => props.onNewSession(projectRef)}
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            >
              <SquarePenIcon aria-hidden className="size-3.5" />
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function SessionRow(props: {
  session: ProjectTreeSession;
  now: number;
  active: boolean;
  onOpen: (threadRef: ScopedThreadRef) => void;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
}) {
  const { session } = props;
  const threadRef = scopeThreadRef(session.thread.environmentId, session.thread.id);
  const title = session.thread.title || "Untitled session";
  return (
    <li role="treeitem" aria-selected={props.active} className="list-none">
      <button
        type="button"
        title={`${title} · ${session.statusLabel}`}
        aria-current={props.active ? "page" : undefined}
        onClick={() => props.onOpen(threadRef)}
        onContextMenu={(event: ReactMouseEvent) => {
          event.preventDefault();
          props.onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
        }}
        className={cn(
          "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md pr-2 pl-[30px] text-left",
          props.active
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground/85 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
          session.status === "resolved" && !props.active && "text-sidebar-muted-foreground",
        )}
      >
        <StatusGlyph status={session.status} label={session.statusLabel} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px]",
            session.status === "attention" && "font-medium",
          )}
        >
          {title}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-sidebar-muted-foreground/70">
          {compactAge(session.updatedAt, props.now)}
        </span>
      </button>
    </li>
  );
}

function StatusGlyph(props: { status: ProjectTreeSession["status"]; label: string }) {
  const base = "relative z-[1] inline-flex size-2.5 shrink-0 items-center justify-center";
  switch (props.status) {
    case "attention":
      return (
        <span aria-label={props.label} role="img" className={base}>
          <span className="size-2 rounded-full bg-warning ring-2 ring-sidebar" />
        </span>
      );
    case "working":
      return (
        <span aria-label={props.label} role="img" className={base}>
          <span className="size-2 animate-pulse rounded-full bg-success ring-2 ring-sidebar" />
        </span>
      );
    case "failed":
      return (
        <span aria-label={props.label} role="img" className={base}>
          <span className="size-2 rounded-full bg-destructive ring-2 ring-sidebar" />
        </span>
      );
    case "resolved":
      return (
        <span aria-label={props.label} role="img" className={cn(base, "bg-sidebar")}>
          <CheckIcon className="size-2.5 text-sidebar-muted-foreground/70" />
        </span>
      );
    default:
      return (
        <span aria-label={props.label} role="img" className={base}>
          <span className="size-2 rounded-full border border-sidebar-muted-foreground/60 bg-sidebar" />
        </span>
      );
  }
}
