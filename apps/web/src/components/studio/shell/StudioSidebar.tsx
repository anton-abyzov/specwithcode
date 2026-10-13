/**
 * The default sidebar: projects on top, then a separate Chats section. A project
 * row opens its orchestrator, and the threads a project owns are reached from
 * there; a chat row opens that session. Chats group by date unless the filter
 * menu says otherwise, and the menu's choices are remembered per browser.
 */
import { useAtomValue } from "@effect/atom-react";
import { threadRuntimeCanArchive } from "@specweave-studio/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { scopedThreadKey, scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import {
  type EnvironmentId,
  PERSONAL_ASSISTANT_DESCRIPTION,
  PERSONAL_ASSISTANT_LABEL,
} from "@specweave-studio/contracts";
import { Link, useLocation, useParams, useSearch } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ArchiveIcon,
  ChevronRightIcon,
  ConciergeBellIcon,
  LayoutGridIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  SlidersVerticalIcon,
  SquarePenIcon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { isCommandPaletteOpen, openCommandPalette } from "../../../commandPaletteBus";
import { isElectron } from "../../../env";
import { useComposerDraftStore } from "../../../composerDraftStore";
import { useScratchProject } from "../../../hooks/useScratchProject";
import { useLocalStorage } from "../../../hooks/useLocalStorage";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { useOpenChat } from "../../../hooks/useOpenChat";
import { useClientSettings } from "../../../hooks/useSettings";
import { useThreadActions } from "../../../hooks/useThreadActions";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../../../keybindings";
import { isTerminalFocused } from "../../../lib/terminalFocus";
import { isModelPickerOpen } from "../../../modelPickerVisibility";
import { resolveAdjacentThreadId } from "../../Sidebar.logic";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { useServerConfigs, useThreadShells } from "../../../state/entities";
import { usePrimaryEnvironmentId } from "../../../state/environments";
import { projectEnvironment } from "../../../state/projects";
import { primaryServerKeybindingsAtom } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { sessionStateSince } from "../../../studio/overviewModel";
import {
  archiveWorkspacePatch,
  isArchivedGroup,
  membersToToggle,
  partitionProjectGroups,
} from "../../../studio/projectListVisibility";
import {
  coordinatorMachineKey,
  resolveCoordinatorMachine,
} from "../../../studio/projectCoordinatorMachine";
import { projectCoordinatorRole } from "../../../studio/projectCoordinatorThreads";
import {
  currentSidebarChatKey,
  isAgentOwnedProjectThread,
  isProjectOwnedChat,
  parseProjectWorkspaceSearch,
} from "../../../studio/projectPaneThreads";
import { projectThreadGroup } from "../../../studio/projectWorkspaceModel";
import { useProjectPaneThreadParam } from "../../../studio/useProjectPaneThreadParam";
import {
  buildChatGroups,
  CHAT_ACTIVITY_FILTERS,
  CHAT_GROUPINGS,
  CHAT_OPTION_LABELS,
  CHAT_PROJECT_THREAD_CHOICES,
  CHAT_SORTS,
  CHAT_STATUS_FILTERS,
  chatListEmptyMessage,
  chatListOptionsAreDefault,
  compactAge,
  DEFAULT_CHAT_LIST_OPTIONS,
  modelLabel,
  nowFromMinute,
  parseChatListOptions,
  THREAD_TONE_LABELS,
  threadTone,
  type ChatListOptions,
} from "../../../studio/shellModel";
import { resolveThreadRouteTarget } from "../../../threadRoutes";
import { cn } from "~/lib/utils";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { ProjectFavicon } from "../../ProjectFavicon";
import { useSettingsProjectGroups } from "../../settings/useSettingsProjectGroups";
import { SidebarChromeFooter, SidebarChromeHeader } from "../../sidebar/SidebarChrome";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../ui/menu";
import { SidebarContent, useSidebar } from "../../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { Tip } from "./Tip";
import { ModelBadgeMark, useProviderEntriesByEnvironment } from "./ModelBadge";

const CHAT_OPTIONS_STORAGE_KEY = "studio:sidebar-chats:v1";
const ChatOptionsSchema = Schema.Struct({
  status: Schema.Literals(CHAT_STATUS_FILTERS),
  activity: Schema.Literals(CHAT_ACTIVITY_FILTERS),
  // Saved before this choice existed, options lack it; they keep their other picks.
  projectThreads: Schema.optionalKey(Schema.Literals(CHAT_PROJECT_THREAD_CHOICES)),
  groupBy: Schema.Literals(CHAT_GROUPINGS),
  sortBy: Schema.Literals(CHAT_SORTS),
});
type StoredChatOptions = typeof ChatOptionsSchema.Type;
const PROJECT_PAGE = 7;
const CHAT_PAGE = 30;

export default function StudioSidebar() {
  const projectGroups = useSettingsProjectGroups();
  const threads = useThreadShells();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedMachines = useClientSettings((settings) => settings.projectCoordinatorMachines);
  const providerEntries = useProviderEntriesByEnvironment();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const actions = useThreadActions();
  const now = nowFromMinute(useNowMinute());
  const onOverview = useLocation({ select: (location) => location.pathname === "/" });
  const activeProjectKey = useParams({
    strict: false,
    select: (params) => (params as { projectKey?: string }).projectKey ?? null,
  });
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadKey =
    routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
  // A project page names the thread open in its right panel in `?thread=`.
  const paneThreadId = useProjectPaneThreadParam();
  const checkoutKey = useSearch({
    strict: false,
    select: (search) => parseProjectWorkspaceSearch(search as Record<string, unknown>).checkout,
  });
  const [storedOptions, setOptions] = useLocalStorage<StoredChatOptions, StoredChatOptions>(
    CHAT_OPTIONS_STORAGE_KEY,
    DEFAULT_CHAT_LIST_OPTIONS,
    ChatOptionsSchema,
  );
  const options = useMemo(() => parseChatListOptions(storedOptions), [storedOptions]);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const serverConfigs = useServerConfigs();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const scratchRootFor = useCallback(
    (environmentId: EnvironmentId) =>
      serverConfigs.get(environmentId)?.scratchWorkspaceRoot ?? null,
    [serverConfigs],
  );
  const [chatLimit, setChatLimit] = useState(CHAT_PAGE);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const projectByMember = useMemo(() => {
    const map = new Map<string, SidebarProjectSnapshot>();
    for (const group of projectGroups)
      for (const member of group.memberProjects)
        map.set(`${member.environmentId}:${member.id}`, group);
    return map;
  }, [projectGroups]);
  // The checkout each project page shows, as the page itself picks it.
  const displayedCheckouts = useMemo(() => {
    const map = new Map<string, { readonly environmentId: string; readonly id: string }>();
    for (const group of projectGroups) {
      if (group.projectKey === activeProjectKey && checkoutKey) {
        const exact = group.memberProjects.find(
          (member) => coordinatorMachineKey(member) === checkoutKey,
        );
        if (exact) map.set(group.projectKey, exact);
        continue;
      }
      const { member } = resolveCoordinatorMachine({
        members: group.memberProjects,
        saved: savedMachines[group.projectKey],
        primaryEnvironmentId,
      });
      if (member) map.set(group.projectKey, member);
    }
    return map;
  }, [activeProjectKey, checkoutKey, primaryEnvironmentId, projectGroups, savedMachines]);
  const threadByKey = useMemo(
    () => new Map(threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread])),
    [threads],
  );
  // A project workspace's chat opens in that project's right panel.
  const openChatTarget = useOpenChat();
  const navigateToChat = useCallback(
    (thread: EnvironmentThreadShell) =>
      void openChatTarget({
        environmentId: thread.environmentId,
        threadId: thread.id,
        projectId: thread.projectId,
      }),
    [openChatTarget],
  );
  const waitingByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) {
      if (thread.deletedAt !== null || projectThreadGroup(thread) !== "Waiting on you") continue;
      const group = projectByMember.get(`${thread.environmentId}:${thread.projectId}`);
      const member = group?.memberProjects.find(
        (project) =>
          project.environmentId === thread.environmentId && project.id === thread.projectId,
      );
      if (!group || !member) continue;
      const coordinatorThreadId = member.workspaceSettings?.coordinatorThreadId ?? null;
      const coordinatorRole = projectCoordinatorRole(thread.id, {
        projectId: member.id,
        coordinatorThreadId,
      });
      if (coordinatorRole === "previous") continue;
      if (
        coordinatorRole !== "current" &&
        !isAgentOwnedProjectThread(thread, coordinatorThreadId, (id) =>
          threadByKey.get(`${thread.environmentId}:${id}`),
        )
      )
        continue;
      counts.set(group.projectKey, (counts.get(group.projectKey) ?? 0) + 1);
    }
    return counts;
  }, [projectByMember, threadByKey, threads]);
  // The machines' "No project" folders are not projects; archived ones wait below the
  // list unless they are open or have threads waiting on the person.
  const { listed: listedProjects, archived: archivedProjects } = useMemo(
    () =>
      partitionProjectGroups(
        projectGroups,
        scratchRootFor,
        activeProjectKey,
        (projectKey) => (waitingByProject.get(projectKey) ?? 0) > 0,
      ),
    [activeProjectKey, projectGroups, scratchRootFor, waitingByProject],
  );
  const chatGroupInput = useMemo(
    () => ({
      now,
      projectLabel: (thread: EnvironmentThreadShell) =>
        projectByMember.get(`${thread.environmentId}:${thread.projectId}`)?.displayName ??
        "No project",
      // Threads a project started open from its project row, not from the chat list.
      isProjectThread: (thread: EnvironmentThreadShell) => {
        const group = projectByMember.get(`${thread.environmentId}:${thread.projectId}`);
        return isProjectOwnedChat(thread, group, {
          displayedCheckout: group ? displayedCheckouts.get(group.projectKey) : undefined,
          lookup: (threadId) => threadByKey.get(`${thread.environmentId}:${threadId}`),
        });
      },
    }),
    [displayedCheckouts, now, projectByMember, threadByKey],
  );
  const chatGroups = useMemo(
    () => buildChatGroups(threads, options, chatGroupInput),
    [chatGroupInput, options, threads],
  );
  const chatTotal = chatGroups.reduce((sum, group) => sum + group.threads.length, 0);
  // Only worked out for an empty list: whether project threads are all that is left out.
  const hiddenProjectThreads = useMemo(
    () =>
      chatTotal > 0 || options.projectThreads === "show"
        ? 0
        : buildChatGroups(threads, { ...options, projectThreads: "show" }, chatGroupInput).reduce(
            (sum, group) => sum + group.threads.length,
            0,
          ),
    [chatGroupInput, chatTotal, options, threads],
  );
  const chatTools = <ChatFilterMenu options={options} onChange={setOptions} />;
  // A menu closes on click, so a refused action has to say so somewhere else.
  const reportFailure = async (
    verb: string,
    pending: Promise<AtomCommandResult<unknown, unknown>>,
  ): Promise<void> => {
    const result = await pending;
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Could not ${verb} this chat`,
        description: cause instanceof Error ? cause.message : "Try again in a moment.",
      }),
    );
  };
  // What is on screen, in order: collapsed headings and the page limit both count.
  const visibleChatGroups = useMemo(() => {
    const visible: Array<{
      group: (typeof chatGroups)[number];
      isCollapsed: boolean;
      rows: (typeof chatGroups)[number]["threads"];
    }> = [];
    let left = chatLimit;
    for (const group of chatGroups) {
      if (left <= 0) break;
      const isCollapsed = collapsed[group.key] === true;
      const rows = isCollapsed ? [] : group.threads.slice(0, left);
      left -= rows.length;
      visible.push({ group, isCollapsed, rows });
    }
    return visible;
  }, [chatGroups, chatLimit, collapsed]);
  const visibleChats = useMemo(
    () => visibleChatGroups.flatMap((entry) => entry.rows),
    [visibleChatGroups],
  );
  // The full-page chat, or on a project page the chat open in its right panel.
  const currentChatKey = currentSidebarChatKey({
    routeThreadKey,
    paneThreadId,
    activeProjectKey,
    chats: visibleChats,
    keyOf: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    idOf: (thread) => thread.id,
    projectKeyOf: (thread) =>
      projectByMember.get(`${thread.environmentId}:${thread.projectId}`)?.projectKey ?? null,
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen())
        return;
      // An open dialog or menu owns the keyboard; jumping chats behind it would lose its work.
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          modelPickerOpen: false,
          isWeb: !isElectron,
          isDesktop: isElectron,
        },
      });
      const keys = visibleChats.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      );
      const direction = threadTraversalDirectionFromCommand(command);
      const jumpIndex = direction === null ? threadJumpIndexFromCommand(command ?? "") : null;
      const targetKey =
        direction !== null
          ? resolveAdjacentThreadId({
              threadIds: keys,
              // A chat the filter hides is not in the list; start from the list's edge instead.
              currentThreadId:
                currentChatKey !== null && keys.includes(currentChatKey) ? currentChatKey : null,
              direction,
            })
          : jumpIndex !== null
            ? (keys[jumpIndex] ?? null)
            : null;
      const target = targetKey === null ? undefined : visibleChats[keys.indexOf(targetKey)];
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      navigateToChat(target);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentChatKey, keybindings, navigateToChat, visibleChats]);

  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const newChat = () => {
    closeMobile();
    const selectedProject = activeProjectKey ? displayedCheckouts.get(activeProjectKey) : undefined;
    if (activeProjectKey && !selectedProject) {
      toastManager.add({
        type: "error",
        title: "Project machine unavailable",
        description: "Choose an available machine before starting a new chat.",
      });
      return;
    }
    const currentEnvironment =
      routeTarget?.kind === "server"
        ? routeTarget.threadRef.environmentId
        : routeTarget?.kind === "draft"
          ? useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)?.environmentId
          : selectedProject?.environmentId;
    const environmentId = scratchEnvironmentId(
      (currentEnvironment ?? primaryEnvironmentId) as EnvironmentId | null,
    );
    if (environmentId !== null) void startScratchThread(environmentId);
  };
  const openChat = (thread: EnvironmentThreadShell) => {
    closeMobile();
    navigateToChat(thread);
  };

  // Archives or restores the project on every machine that has it.
  const setGroupArchived = async (group: SidebarProjectSnapshot, archived: boolean) => {
    for (const member of membersToToggle(group, archived, scratchRootFor)) {
      const result = await updateProject({
        environmentId: member.environmentId,
        input: {
          projectId: member.id,
          workspaceSettings: archiveWorkspacePatch(member, archived),
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not ${archived ? "archive" : "restore"} ${group.displayName}`,
            description: cause instanceof Error ? cause.message : "Try again in a moment.",
          }),
        );
        return;
      }
    }
  };
  const visibleProjects =
    showAllProjects || listedProjects.length <= PROJECT_PAGE + 1
      ? listedProjects
      : listedProjects.filter(
          (group, index) =>
            index < PROJECT_PAGE ||
            group.projectKey === activeProjectKey ||
            (waitingByProject.get(group.projectKey) ?? 0) > 0,
        );
  const hiddenProjects = listedProjects.length - visibleProjects.length;
  const hasAssistant = projectGroups.some((group) =>
    group.memberProjects.some((member) => member.workspaceSettings?.kind === "personal"),
  );
  const newChatShortcut = shortcutLabelForCommand(keybindings, "chat.new");
  const searchShortcut = shortcutLabelForCommand(keybindings, "commandPalette.toggle");

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent>
        <div className="sws-sidebar">
          <div className="sws-side-actions">
            <button type="button" className="sws-side-row" onClick={newChat}>
              <SquarePenIcon aria-hidden />
              <span className="sws-side-row-label">New chat</span>
              {newChatShortcut ? <kbd className="sws-kbd">{newChatShortcut}</kbd> : null}
            </button>
            <button
              type="button"
              className="sws-side-row"
              onClick={() => {
                closeMobile();
                openCommandPalette();
              }}
            >
              <SearchIcon aria-hidden />
              <span className="sws-side-row-label">Search</span>
              {searchShortcut ? <kbd className="sws-kbd">{searchShortcut}</kbd> : null}
            </button>
            <Link
              to="/"
              className="sws-side-row"
              aria-current={onOverview ? "page" : undefined}
              onClick={closeMobile}
            >
              <LayoutGridIcon aria-hidden />
              <span className="sws-side-row-label">Overview</span>
            </Link>
          </div>

          <div className="sws-side-section" role="group" aria-labelledby="sws-side-projects">
            <div className="sws-side-heading">
              <h2 id="sws-side-projects">Projects</h2>
              <Tip label="New project or assistant">
                <button
                  type="button"
                  className="sws-icon-button"
                  aria-label="Add project"
                  onClick={() => {
                    closeMobile();
                    openCommandPalette({ open: "add-project" });
                  }}
                >
                  <PlusIcon aria-hidden />
                </button>
              </Tip>
            </div>
            {listedProjects.length === 0 && archivedProjects.length === 0 ? (
              <p className="sws-side-empty">
                No projects yet. Add a folder or a personal assistant.
              </p>
            ) : (
              <ul className="sws-side-list">
                {visibleProjects.map((group) => (
                  <ProjectRow
                    key={group.projectKey}
                    group={group}
                    archived={isArchivedGroup(group, scratchRootFor)}
                    waiting={waitingByProject.get(group.projectKey) ?? 0}
                    current={group.projectKey === activeProjectKey}
                    onOpen={closeMobile}
                    onArchive={(archived) => void setGroupArchived(group, archived)}
                  />
                ))}
              </ul>
            )}
            {hasAssistant ? null : (
              <Tip side="right" label={PERSONAL_ASSISTANT_DESCRIPTION}>
                <button
                  type="button"
                  className="sws-side-row sws-side-row-quiet"
                  onClick={() => {
                    closeMobile();
                    openCommandPalette({ open: "new-assistant" });
                  }}
                >
                  <ConciergeBellIcon aria-hidden />
                  <span className="sws-side-row-label">{PERSONAL_ASSISTANT_LABEL}</span>
                  <span className="sws-side-row-hint">Set up</span>
                </button>
              </Tip>
            )}
            {hiddenProjects > 0 || (showAllProjects && projectGroups.length > PROJECT_PAGE + 1) ? (
              <button
                type="button"
                className="sws-side-more"
                aria-expanded={showAllProjects}
                onClick={() => setShowAllProjects((value) => !value)}
              >
                {showAllProjects ? "Show fewer" : `Show ${hiddenProjects} more`}
              </button>
            ) : null}
            {archivedProjects.length > 0 ? (
              <>
                <button
                  type="button"
                  className="sws-side-more"
                  aria-expanded={showArchived}
                  aria-controls="sws-side-archived"
                  onClick={() => setShowArchived((value) => !value)}
                >
                  {showArchived ? "Hide archived" : `Archived (${archivedProjects.length})`}
                </button>
                {showArchived ? (
                  <ul
                    id="sws-side-archived"
                    className="sws-side-list"
                    aria-label="Archived projects"
                  >
                    {archivedProjects.map((group) => (
                      <ProjectRow
                        key={group.projectKey}
                        group={group}
                        archived
                        waiting={waitingByProject.get(group.projectKey) ?? 0}
                        current={false}
                        onOpen={closeMobile}
                        onArchive={(archived) => void setGroupArchived(group, archived)}
                      />
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
          </div>

          <div
            className="sws-side-section sws-side-chats"
            role="group"
            aria-labelledby="sws-side-chats"
          >
            {/* Mounted once, apart from the groups: a choice that regroups the list must
                not take the open menu and the keyboard with it. */}
            <div className="sws-side-heading">
              <h2 id="sws-side-chats">Chats</h2>
              {chatTools}
            </div>
            {chatTotal === 0 ? (
              <p className="sws-side-empty" role="status">
                {chatListEmptyMessage(options, hiddenProjectThreads)}
              </p>
            ) : (
              visibleChatGroups.map(({ group, isCollapsed, rows }) => {
                const headingId = `sws-chats-${group.key.replace(/[^a-z0-9]+/gi, "-")}`;
                const titled = options.groupBy !== "none";
                return (
                  <div
                    key={group.key}
                    className="sws-side-group"
                    {...(titled ? { role: "group", "aria-labelledby": headingId } : {})}
                  >
                    {titled ? (
                      <div className="sws-side-heading sws-side-subheading-row">
                        <h3 id={headingId} className="sws-side-subheading">
                          <button
                            type="button"
                            aria-expanded={!isCollapsed}
                            onClick={() =>
                              setCollapsed((previous) => ({
                                ...previous,
                                [group.key]: !isCollapsed,
                              }))
                            }
                          >
                            {group.label}
                            <span className="sr-only">
                              , {group.threads.length}{" "}
                              {group.threads.length === 1 ? "chat" : "chats"}
                            </span>
                            <ChevronRightIcon aria-hidden data-open={!isCollapsed} />
                          </button>
                        </h3>
                      </div>
                    ) : null}
                    <ul className="sws-side-list">
                      {rows.map((thread) => {
                        const key = scopedThreadKey(
                          scopeThreadRef(thread.environmentId, thread.id),
                        );
                        const entry =
                          providerEntries
                            .get(thread.environmentId)
                            ?.get(thread.modelSelection.instanceId) ?? null;
                        const label = modelLabel(
                          entry,
                          thread.modelSelection.instanceId,
                          thread.modelSelection.model,
                        );
                        const tone = threadTone(thread);
                        const title = thread.title || "Untitled chat";
                        const project = projectByMember.get(
                          `${thread.environmentId}:${thread.projectId}`,
                        );
                        return (
                          <li key={key} className="sws-chat-row" data-tone={tone}>
                            <Tip
                              side="right"
                              label={`${title} · ${label.full}${project ? ` · ${project.displayName}` : ""} · ${compactAge(sessionStateSince(thread), now)}`}
                            >
                              <button
                                type="button"
                                className="sws-side-row"
                                aria-current={currentChatKey === key ? "page" : undefined}
                                onClick={() => openChat(thread)}
                              >
                                <ModelBadgeMark
                                  entry={entry}
                                  instanceId={thread.modelSelection.instanceId}
                                  provider={label.provider}
                                />
                                <span className="sws-side-row-label">{title}</span>
                                <span className="sr-only">
                                  , {label.full}, {THREAD_TONE_LABELS[tone]}
                                </span>
                                {tone === "waiting" || tone === "working" || tone === "failed" ? (
                                  <span className="sws-dot" data-tone={tone} aria-hidden />
                                ) : null}
                              </button>
                            </Tip>
                            <Menu>
                              <MenuTrigger
                                render={
                                  <button
                                    type="button"
                                    className="sws-icon-button sws-chat-menu"
                                    aria-label={`Actions for ${title}`}
                                  />
                                }
                              >
                                <MoreHorizontalIcon aria-hidden />
                              </MenuTrigger>
                              <MenuPopup align="start" side="bottom">
                                <MenuItem onClick={() => openChat(thread)}>Open</MenuItem>
                                {thread.settledOverride === "settled" ? (
                                  <MenuItem
                                    onClick={() =>
                                      void reportFailure(
                                        "reopen",
                                        actions.unsettleThread(
                                          scopeThreadRef(thread.environmentId, thread.id),
                                        ),
                                      )
                                    }
                                  >
                                    Reopen
                                  </MenuItem>
                                ) : (
                                  <MenuItem
                                    onClick={() =>
                                      void reportFailure(
                                        "resolve",
                                        actions.settleThread(
                                          scopeThreadRef(thread.environmentId, thread.id),
                                        ),
                                      )
                                    }
                                  >
                                    Resolve
                                  </MenuItem>
                                )}
                                <MenuSeparator />
                                <MenuItem
                                  disabled={!threadRuntimeCanArchive(thread.runtime)}
                                  onClick={() =>
                                    void reportFailure(
                                      "archive",
                                      actions.archiveThread(
                                        scopeThreadRef(thread.environmentId, thread.id),
                                      ),
                                    )
                                  }
                                >
                                  Archive
                                </MenuItem>
                              </MenuPopup>
                            </Menu>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })
            )}
            {chatTotal > chatLimit ? (
              <button
                type="button"
                className="sws-side-more"
                onClick={() => setChatLimit((value) => value + CHAT_PAGE)}
              >
                Show more
              </button>
            ) : null}
          </div>
        </div>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

/** One project in the Projects list, with its Archive or Restore action. */
function ProjectRow(props: {
  group: SidebarProjectSnapshot;
  archived: boolean;
  waiting: number;
  current: boolean;
  onOpen: () => void;
  onArchive: (archived: boolean) => void;
}) {
  const { group, archived, waiting } = props;
  const personal = group.memberProjects.some(
    (member) => member.workspaceSettings?.kind === "personal",
  );
  return (
    <li className="sws-project-row" data-archived={archived || undefined}>
      <Tip
        side="right"
        label={
          personal
            ? `${group.displayName} · ${PERSONAL_ASSISTANT_LABEL}: ${PERSONAL_ASSISTANT_DESCRIPTION}`
            : `${group.displayName} · ${group.workspaceRoot}${archived ? " · Archived" : ""}`
        }
      >
        <Link
          to="/projects/$projectKey"
          params={{ projectKey: group.projectKey }}
          className="sws-side-row"
          aria-current={props.current ? "page" : undefined}
          onClick={props.onOpen}
        >
          <ProjectFavicon project={group} className="size-[18px] shrink-0" />
          <span className="sws-side-row-label">{group.displayName}</span>
          {archived ? <span className="sws-side-row-hint">Archived</span> : null}
          {waiting > 0 ? (
            <span className="sws-count sws-count-waiting">
              {waiting}
              <span className="sr-only"> waiting on you</span>
            </span>
          ) : null}
        </Link>
      </Tip>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              className="sws-icon-button sws-chat-menu"
              aria-label={`Actions for ${group.displayName}`}
            />
          }
        >
          <MoreHorizontalIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="start" side="bottom">
          <MenuItem onClick={() => props.onArchive(!archived)}>
            <ArchiveIcon aria-hidden />
            {archived ? "Restore project" : "Archive project"}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </li>
  );
}

const FILTER_SECTIONS = [
  { key: "status", title: "Status", values: CHAT_STATUS_FILTERS },
  { key: "activity", title: "Last activity", values: CHAT_ACTIVITY_FILTERS },
  { key: "projectThreads", title: "Agent threads", values: CHAT_PROJECT_THREAD_CHOICES },
  { key: "groupBy", title: "Group by", values: CHAT_GROUPINGS },
  { key: "sortBy", title: "Sort by", values: CHAT_SORTS },
] as const;
/** The first row that chooses how the list is arranged rather than what it lists. */
const FIRST_ARRANGE_SECTION = FILTER_SECTIONS.findIndex((section) => section.key === "groupBy");

function ChatFilterMenu(props: {
  options: ChatListOptions;
  onChange: (options: ChatListOptions) => void;
}) {
  const changed = !chatListOptionsAreDefault(props.options);
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  className={cn("sws-icon-button", changed && "sws-icon-button-on")}
                  aria-label={
                    changed ? "Filter and sort chats, filter active" : "Filter and sort chats"
                  }
                />
              }
            />
          }
        >
          <SlidersVerticalIcon aria-hidden />
          {changed ? <span className="sws-filter-flag" aria-hidden /> : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">Filter and sort chats</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="bottom" className="min-w-60">
        {FILTER_SECTIONS.map((section, index) => {
          const labels = CHAT_OPTION_LABELS[section.key] as Record<string, string>;
          return (
            <Fragment key={section.key}>
              {/* The rows above choose what is listed, the rows below how it is arranged. */}
              {index === FIRST_ARRANGE_SECTION ? <MenuSeparator /> : null}
              <MenuSub>
                <MenuSubTrigger>
                  <span className="flex-1">{section.title}</span>
                  <span className="text-muted-foreground">
                    {labels[props.options[section.key]]}
                  </span>
                </MenuSubTrigger>
                <MenuSubPopup className="min-w-44">
                  <MenuGroup>
                    <MenuGroupLabel>{section.title}</MenuGroupLabel>
                    <MenuRadioGroup
                      value={props.options[section.key]}
                      onValueChange={(value) =>
                        props.onChange({
                          ...props.options,
                          [section.key]: value,
                        } as ChatListOptions)
                      }
                    >
                      {section.values.map((value) => (
                        <MenuRadioItem key={value} value={value} closeOnClick={false}>
                          <span className="flex items-center justify-between gap-6">
                            {labels[value]}
                            <MenuRadioItemIndicator />
                          </span>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuGroup>
                </MenuSubPopup>
              </MenuSub>
            </Fragment>
          );
        })}
        {changed ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => props.onChange(DEFAULT_CHAT_LIST_OPTIONS)}>
              Reset to defaults
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
