import { aggregateProjectAttention } from "@specweave-studio/client-runtime/state/projectAttention";
import {
  useAttentionMembers,
  projectAttentionRoots,
  expandAttentionProjects,
} from "../../../studio/useProjectAttention";
/**
 * The default sidebar: the personal assistant under Overview, then projects, then a
 * separate Chats section. A project
 * row opens its orchestrator, and the threads a project owns are reached from
 * there; a chat row opens that session. Chats group by date unless the filter
 * menu says otherwise, and the menu's choices are remembered per browser.
 */
import { isExtraAssistant } from "../../../studio/personalAssistant";
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
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectOrigin,
  type SidebarProjectOrder,
  PERSONAL_ASSISTANT_DESCRIPTION,
  PERSONAL_ASSISTANT_LABEL,
} from "@specweave-studio/contracts";
import { Link, useLocation, useParams, useSearch } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ArchiveIcon,
  BotIcon,
  ChevronRightIcon,
  ConciergeBellIcon,
  LaptopIcon,
  LayoutGridIcon,
  PaletteIcon,
  PlusIcon,
  SearchIcon,
  SlidersVerticalIcon,
  SquarePenIcon,
  WifiOffIcon,
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
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../../sidebarProjectGrouping";
import { useServerConfigs, useThreadShells } from "../../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../../state/environments";
import { projectEnvironment } from "../../../state/projects";
import { threadLocation } from "../../../studio/threadLocation";
import { primaryServerKeybindingsAtom } from "../../../state/server";
import { readEnvironmentScope } from "../../../state/session";
import { threadEnvironment } from "../../../state/threads";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useOrchestrationCommand } from "../../../state/use-orchestration-command";
import { sessionStateSince } from "../../../studio/overviewModel";
import {
  archiveWorkspacePatch,
  isArchivedGroup,
  membersToToggle,
  partitionProjectGroups,
  membersToMark,
  originWorkspacePatch,
  sameNameHints,
} from "../../../studio/projectListVisibility";
import { chooseCoordinatorView } from "../../../studio/projectCoordinatorMachine";
import { useMachineNicknames } from "../../../studio/machineNickname";
import {
  arrangeProjects,
  moveProject,
  rememberPinnedMembers,
  resolveProjectOrder,
  stepProject,
  toggleProjectPin,
  type ProjectDropTarget,
} from "../../../studio/projectOrder";
import { useSidebarProjectOrder } from "../../../studio/useSidebarProjectOrder";
import {
  currentSidebarChatKey,
  isProjectOwnedChat,
  parseProjectWorkspaceSearch,
} from "../../../studio/projectPaneThreads";
import { checkProjectName, renameTargets, type NamedProject } from "../../../studio/projectRename";
import { useUnreachableHosts } from "../../../studio/unreachableHosts";
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
import { PlanProgressChip } from "../PlanProgressChip";
import { useSidebarThreadPlans } from "../../sidebar/SidebarPlanProgress";
import { describeThreadPlan } from "../../../studio/threadPlanProgress";
import { canRenameChat, checkChatTitle } from "../../../studio/threadTitles";
import { ModelBadgeMark, useProviderEntriesByEnvironment } from "./ModelBadge";
import { SidebarChatRow } from "./SidebarChatRow";
import {
  designsProjectId,
  displayNameOf,
  ProjectRow,
  SidebarProjectList,
  type ProjectRename,
} from "./SidebarProjectList";

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
  const { environments } = useEnvironments();
  const nickname = useMachineNicknames();
  const machineLabels = useMemo(
    () =>
      new Map(
        environments.map((environment) => [
          environment.environmentId,
          nickname(environment.environmentId, environment.label),
        ]),
      ),
    [environments, nickname],
  );
  const savedMachines = useClientSettings((settings) => settings.projectCoordinatorMachines);
  const providerEntries = useProviderEntriesByEnvironment();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { scratchEnvironmentId, startScratchThread, reportNoChatMachine } = useScratchProject();
  const actions = useThreadActions();
  const now = nowFromMinute(useNowMinute());
  const onOverview = useLocation({ select: (location) => location.pathname === "/" });
  const onDesign = useLocation({
    select: (location) =>
      location.pathname === "/design" || location.pathname.startsWith("/design/"),
  });
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
  const [savedProjectOrder, saveOrder] = useSidebarProjectOrder();
  // Saved keys follow projects whose folder moved; saves remember pinned members.
  const projectOrder = useMemo(
    () => resolveProjectOrder(savedProjectOrder, projectGroups),
    [projectGroups, savedProjectOrder],
  );
  const saveProjectOrder = (next: SidebarProjectOrder) =>
    saveOrder(rememberPinnedMembers(next, projectGroups));
  const [showAllProjects, setShowAllProjects] = useState(false);
  // Null follows the open project: the list opens while an archived project is open.
  const [showArchived, setShowArchived] = useState<boolean | null>(null);
  // Null follows the open project too: Automated opens while one of its projects is open.
  const [showAutomated, setShowAutomated] = useState<boolean | null>(null);
  const serverConfigs = useServerConfigs();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
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
  const unreachable = useUnreachableHosts();
  // The checkout each project page shows, as the page itself picks it.
  const displayedCheckouts = useMemo(() => {
    const map = new Map<string, SidebarProjectGroupMember>();
    for (const group of projectGroups) {
      const { member } = chooseCoordinatorView({
        members: group.memberProjects,
        checkoutKey: group.projectKey === activeProjectKey ? checkoutKey : null,
        lastViewed: savedMachines[group.projectKey],
        primaryEnvironmentId,
        unreachable,
      });
      if (member) map.set(group.projectKey, member);
    }
    return map;
  }, [
    activeProjectKey,
    checkoutKey,
    primaryEnvironmentId,
    projectGroups,
    savedMachines,
    unreachable,
  ]);
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
  const attentionScopes = useMemo(
    () =>
      new Map(
        projectGroups.map((group) => {
          const displayed = displayedCheckouts.get(group.projectKey) ?? group.memberProjects[0];
          const logicalId = displayed?.workspaceSettings?.logicalProject?.id;
          return [
            group.projectKey,
            logicalId
              ? group.memberProjects.filter(
                  (member) => member.workspaceSettings?.logicalProject?.id === logicalId,
                )
              : displayed
                ? [displayed]
                : [],
          ];
        }),
      ),
    [projectGroups, displayedCheckouts],
  );
  const attentionProjects = useMemo(() => [...attentionScopes.values()].flat(), [attentionScopes]);
  const attentionMembers = useAttentionMembers(attentionProjects);
  const attentionByProject = useMemo(
    () =>
      new Map(
        projectGroups.map((group) => {
          const members = attentionMembers.filter((member) =>
            expandAttentionProjects(attentionScopes.get(group.projectKey) ?? []).some(
              (p) => p.environmentId === member.environmentId && p.id === member.projectId,
            ),
          );
          return [
            group.projectKey,
            aggregateProjectAttention({
              members,
              roots: projectAttentionRoots(threads, members),
              threads,
            }),
          ];
        }),
      ),
    [projectGroups, attentionScopes, attentionMembers, threads],
  );
  const waitingByProject = useMemo(
    () => new Map([...attentionByProject].map(([key, attention]) => [key, attention.count])),
    [attentionByProject],
  );
  // The machines' "No project" folders are not projects. Archived projects are listed
  // only under Archived, even while open, and never carry a waiting count: the
  // person archived them, so nothing in them asks for attention here.
  // Projects checks and agents made for themselves leave the main list for Automated,
  // so the main list holds only the person's own projects.
  const {
    listed: listedProjects,
    automated: automatedProjects,
    archived: archivedProjects,
  } = useMemo(
    () => partitionProjectGroups(projectGroups, scratchRootFor),
    [projectGroups, scratchRootFor],
  );
  const archivedOpen =
    showArchived ?? archivedProjects.some((group) => group.projectKey === activeProjectKey);
  const automatedOpen =
    showAutomated ?? automatedProjects.some((group) => group.projectKey === activeProjectKey);
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
  const { plans: chatPlans, loaders: chatPlanLoaders } = useSidebarThreadPlans(visibleChats);
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
    if (environmentId === null) reportNoChatMachine();
    else void startScratchThread(environmentId);
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
            title: `Could not ${archived ? "archive" : "restore"} ${displayedCheckouts.get(group.projectKey)?.title ?? group.displayName}`,
            description: cause instanceof Error ? cause.message : "Try again in a moment.",
          }),
        );
        return;
      }
    }
  };
  // Moves the project to or from Automated on every machine that has it.
  const setGroupOrigin = async (group: SidebarProjectSnapshot, origin: ProjectOrigin) => {
    for (const member of membersToMark(group, origin, scratchRootFor)) {
      const result = await updateProject({
        environmentId: member.environmentId,
        input: { projectId: member.id, workspaceSettings: originWorkspacePatch(member, origin) },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not move ${displayedCheckouts.get(group.projectKey)?.title ?? group.displayName}`,
            description: cause instanceof Error ? cause.message : "Try again in a moment.",
          }),
        );
        return;
      }
    }
  };
  // Renames a project wherever it lives; the first machine that refuses says why.
  const renameGroup = async (group: SidebarProjectSnapshot, name: string) => {
    const plan = renameTargets(group.memberProjects, name);
    if ("error" in plan) return plan.error;
    for (const [index, member] of plan.targets.entries()) {
      const result = await updateProject({
        environmentId: member.environmentId,
        input: {
          projectId: member.id,
          title: name,
          // A shared name is written only by the coordinator that owned it when the edit began.
          ...(member.workspaceSettings?.logicalProject
            ? { workspaceSettings: { expectedRevision: member.workspaceSettings.revision } }
            : {}),
        },
      });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) continue;
      const cause = squashAtomCommandFailure(result);
      const reason =
        cause instanceof Error ? cause.message : "Could not rename the project. Try again.";
      return index > 0 && member.environmentLabel
        ? `${member.environmentLabel}: ${reason}`
        : reason;
    }
    return null;
  };
  // Every project the sidebar can show, archived ones too, so no two share a name.
  const namedProjects: NamedProject[] = [
    ...listedProjects.map((group) => ({ group, archived: false })),
    ...automatedProjects.map((group) => ({ group, archived: false })),
    ...archivedProjects.map((group) => ({ group, archived: true })),
  ].map(({ group, archived }) => ({
    projectKey: group.projectKey,
    name: displayNameOf(group, displayedCheckouts.get(group.projectKey)),
    archived,
  }));
  const designsFor = (group: SidebarProjectSnapshot) =>
    designsProjectId(
      group,
      displayedCheckouts.get(group.projectKey),
      primaryEnvironmentId,
      scratchRootFor,
    );
  const renameFor = (group: SidebarProjectSnapshot): ProjectRename => {
    const current = namedProjects.find((entry) => entry.projectKey === group.projectKey) ?? {
      projectKey: group.projectKey,
      name: displayNameOf(group, displayedCheckouts.get(group.projectKey)),
      archived: false,
    };
    return {
      check: (draft) => checkProjectName({ draft, current, others: namedProjects }),
      commit: (name) => renameGroup(group, name),
    };
  };
  // Chats a person started rename in place; a coordinator keeps the titles it gives.
  const chatRenameFor = (thread: EnvironmentThreadShell): ProjectRename | undefined =>
    !canRenameChat(
      thread,
      readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
    )
      ? undefined
      : {
          check: (draft) => checkChatTitle(draft, thread.title),
          commit: async (title) => {
            const result = await updateThreadMetadata({
              environmentId: thread.environmentId,
              input: { threadId: thread.id, title },
            });
            if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
            const cause = squashAtomCommandFailure(result);
            return cause instanceof Error
              ? cause.message
              : "Could not rename this chat. Try again.";
          },
        };
  // A personal assistant is not a code project: it sits under Overview, ahead of every
  // project and outside the project paging, so it is always one click away.
  // Each machine has its own: this machine's leads, and with more than one
  // machine each row names its machine. A duplicate from before that rule is marked extra.
  // Archived ones too: an archived earlier assistant is still its machine's own.
  const assistantMembers = [...listedProjects, ...automatedProjects, ...archivedProjects]
    .filter(isPersonalGroup)
    .flatMap((group) => group.memberProjects);
  const assistantOf = (group: (typeof listedProjects)[number]) =>
    group.memberProjects.find((member) => member.workspaceSettings?.kind === "personal");
  const assistantRank = (group: (typeof listedProjects)[number]) => {
    const member = assistantOf(group);
    if (member === undefined) return 3;
    const here = member.environmentId === primaryEnvironmentId ? 0 : 1;
    return isExtraAssistant(member, assistantMembers) ? here + 2 : here;
  };
  const assistants = listedProjects
    .filter(isPersonalGroup)
    .toSorted((left, right) => assistantRank(left) - assistantRank(right));
  const assistantHint = (group: (typeof listedProjects)[number]) => {
    const member = assistantOf(group);
    if (member === undefined) return undefined;
    const machine =
      environments.length > 1 ? (machineLabels.get(member.environmentId) ?? null) : null;
    const extra = isExtraAssistant(member, assistantMembers) ? "extra" : null;
    return [machine, extra].filter(Boolean).join(" · ") || undefined;
  };
  // Pinned projects lead, then the rest, both in the person's order.
  const arranged = arrangeProjects(
    listedProjects.filter((group) => !isPersonalGroup(group)),
    projectOrder,
  );
  const codeProjects = [...arranged.pinned, ...arranged.unpinned];
  const nameHints = sameNameHints(codeProjects, (group) =>
    displayNameOf(group, displayedCheckouts.get(group.projectKey)),
  );
  const listedKeys = {
    pinned: arranged.pinned.map((group) => group.projectKey),
    unpinned: arranged.unpinned.map((group) => group.projectKey),
  };
  const pinnedKeys = new Set(listedKeys.pinned);
  const folded = !showAllProjects && codeProjects.length > PROJECT_PAGE + 1;
  const shownWhenFolded = (group: SidebarProjectSnapshot, index: number) =>
    index < PROJECT_PAGE ||
    pinnedKeys.has(group.projectKey) ||
    group.projectKey === activeProjectKey ||
    (waitingByProject.get(group.projectKey) ?? 0) > 0;
  const visibleProjects = folded ? codeProjects.filter(shownWhenFolded) : codeProjects;
  const hiddenProjects = codeProjects.length - visibleProjects.length;
  const moveProjectTo = (projectKey: string, target: ProjectDropTarget) => {
    const next = moveProject(projectOrder, listedKeys, projectKey, target);
    // A project moved into the folded part of the list unfolds it, so it stays in view.
    if (folded) {
      const after = arrangeProjects(codeProjects, next);
      const index = [...after.pinned, ...after.unpinned].findIndex(
        (group) => group.projectKey === projectKey,
      );
      const group = codeProjects.find((entry) => entry.projectKey === projectKey);
      if (!target.pinned && group && !shownWhenFolded(group, index)) setShowAllProjects(true);
    }
    saveProjectOrder(next);
  };
  const hasAssistant = projectGroups.some(isPersonalGroup);
  const automatedWaiting = automatedProjects.reduce(
    (sum, group) => sum + (waitingByProject.get(group.projectKey) ?? 0),
    0,
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
            {assistants.length > 0 ? (
              <ul className="sws-side-list" aria-label={PERSONAL_ASSISTANT_LABEL}>
                {assistants.map((group) => (
                  <ProjectRow
                    key={group.projectKey}
                    group={group}
                    displayedProject={displayedCheckouts.get(group.projectKey)}
                    archived={isArchivedGroup(group, scratchRootFor)}
                    waiting={waitingByProject.get(group.projectKey) ?? 0}
                    attentionLabel={attentionByProject.get(group.projectKey)?.label}
                    attentionComplete={attentionByProject.get(group.projectKey)?.complete}
                    current={group.projectKey === activeProjectKey}
                    hint={assistantHint(group)}
                    onOpen={closeMobile}
                    onArchive={(archived) => void setGroupArchived(group, archived)}
                    rename={renameFor(group)}
                    designsProjectId={designsFor(group)}
                  />
                ))}
              </ul>
            ) : hasAssistant ? null : (
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
            <Link
              to="/design"
              className="sws-side-row"
              aria-current={onDesign ? "page" : undefined}
              onClick={closeMobile}
            >
              <PaletteIcon aria-hidden />
              <span className="sws-side-row-label">Design</span>
            </Link>
          </div>

          <div className="sws-side-section" role="group" aria-labelledby="sws-side-projects">
            <div className="sws-side-heading">
              <h2 id="sws-side-projects">Projects</h2>
              <Tip label="New project">
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
            {codeProjects.length === 0 &&
            automatedProjects.length === 0 &&
            archivedProjects.length === 0 ? (
              <p className="sws-side-empty">No projects yet. Create one or open a folder.</p>
            ) : (
              <SidebarProjectList
                visible={{
                  pinned: visibleProjects.filter((group) => pinnedKeys.has(group.projectKey)),
                  unpinned: visibleProjects.filter((group) => !pinnedKeys.has(group.projectKey)),
                }}
                listedKeys={listedKeys}
                rowState={(group) => ({
                  displayedProject: displayedCheckouts.get(group.projectKey),
                  archived: isArchivedGroup(group, scratchRootFor),
                  waiting: waitingByProject.get(group.projectKey) ?? 0,
                  attentionLabel: attentionByProject.get(group.projectKey)?.label,
                  attentionComplete: attentionByProject.get(group.projectKey)?.complete,
                  current: group.projectKey === activeProjectKey,
                  hint: nameHints.get(group.projectKey),
                  rename: renameFor(group),
                  designsProjectId: designsFor(group),
                })}
                onOpen={closeMobile}
                onMove={moveProjectTo}
                onStep={(projectKey, direction) => {
                  const target = stepProject(listedKeys, projectKey, direction);
                  if (target) moveProjectTo(projectKey, target);
                }}
                canStep={(projectKey, direction) =>
                  stepProject(listedKeys, projectKey, direction) !== null
                }
                onPin={(projectKey) =>
                  saveProjectOrder(toggleProjectPin(projectOrder, listedKeys, projectKey))
                }
                onArchive={(group, archived) => void setGroupArchived(group, archived)}
                onOriginChange={(group, origin) => void setGroupOrigin(group, origin)}
              />
            )}
            {hiddenProjects > 0 || (showAllProjects && codeProjects.length > PROJECT_PAGE + 1) ? (
              <button
                type="button"
                className="sws-side-more"
                aria-expanded={showAllProjects}
                onClick={() => setShowAllProjects((value) => !value)}
              >
                {showAllProjects ? "Show fewer" : `Show ${hiddenProjects} more`}
              </button>
            ) : null}
            {automatedProjects.length > 0 ? (
              <>
                <Tip
                  side="right"
                  label="Projects that checks and agents made for themselves. Move one to your projects from its menu."
                >
                  <button
                    type="button"
                    className="sws-side-more"
                    aria-expanded={automatedOpen}
                    aria-controls="sws-side-automated"
                    onClick={() => setShowAutomated(!automatedOpen)}
                  >
                    <BotIcon aria-hidden className="sws-side-more-icon" />
                    {automatedOpen ? "Hide automated" : `Automated (${automatedProjects.length})`}
                    {!automatedOpen && automatedWaiting > 0 ? (
                      <span className="sws-count sws-count-waiting">
                        {automatedWaiting}
                        <span className="sr-only"> waiting on you</span>
                      </span>
                    ) : null}
                  </button>
                </Tip>
                {automatedOpen ? (
                  <ul
                    id="sws-side-automated"
                    className="sws-side-list"
                    aria-label="Automated projects"
                  >
                    {automatedProjects.map((group) => (
                      <ProjectRow
                        key={group.projectKey}
                        group={group}
                        displayedProject={displayedCheckouts.get(group.projectKey)}
                        archived={isArchivedGroup(group, scratchRootFor)}
                        automated
                        waiting={waitingByProject.get(group.projectKey) ?? 0}
                        attentionLabel={attentionByProject.get(group.projectKey)?.label}
                        attentionComplete={attentionByProject.get(group.projectKey)?.complete}
                        current={group.projectKey === activeProjectKey}
                        onOpen={closeMobile}
                        onArchive={(archived) => void setGroupArchived(group, archived)}
                        onOriginChange={(origin) => void setGroupOrigin(group, origin)}
                        rename={renameFor(group)}
                        designsProjectId={designsFor(group)}
                      />
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
            {archivedProjects.length > 0 ? (
              <>
                <button
                  type="button"
                  className="sws-side-more"
                  aria-expanded={archivedOpen}
                  aria-controls="sws-side-archived"
                  onClick={() => setShowArchived(!archivedOpen)}
                >
                  <ArchiveIcon aria-hidden className="sws-side-more-icon" />
                  {archivedOpen ? "Hide archived" : `Archived (${archivedProjects.length})`}
                </button>
                {archivedOpen ? (
                  <ul
                    id="sws-side-archived"
                    className="sws-side-list"
                    aria-label="Archived projects"
                  >
                    {archivedProjects.map((group) => (
                      <ProjectRow
                        key={group.projectKey}
                        group={group}
                        displayedProject={displayedCheckouts.get(group.projectKey)}
                        archived
                        waiting={0}
                        current={group.projectKey === activeProjectKey}
                        onOpen={closeMobile}
                        onArchive={(archived) => void setGroupArchived(group, archived)}
                        rename={renameFor(group)}
                        designsProjectId={designsFor(group)}
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
            {chatPlanLoaders}
            <div className="sws-side-heading">
              <h2 id="sws-side-chats">Chats</h2>
              <div className="sws-side-heading-tools">
                {chatTools}
                <Tip label="New chat">
                  <button
                    type="button"
                    className="sws-icon-button"
                    aria-label="New chat"
                    onClick={newChat}
                  >
                    <PlusIcon aria-hidden />
                  </button>
                </Tip>
              </div>
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
                        const currentModel = thread.modelIdentity?.current ?? thread.modelSelection;
                        const entry =
                          providerEntries.get(thread.environmentId)?.get(currentModel.instanceId) ??
                          null;
                        const label = modelLabel(
                          entry,
                          currentModel.instanceId,
                          currentModel.model,
                        );
                        const preferred = thread.modelIdentity?.preferred;
                        const preferredLabel = preferred
                          ? modelLabel(
                              providerEntries
                                .get(thread.environmentId)
                                ?.get(preferred.instanceId) ?? null,
                              preferred.instanceId,
                              preferred.model,
                            ).full
                          : null;
                        const stateDescription = preferredLabel
                          ? thread.modelIdentity?.kind === "fallback"
                            ? `, fallback for ${preferredLabel} (${thread.modelIdentity.launched ? "no room at launch" : "usage limit"})`
                            : `, saved model ${preferredLabel}`
                          : "";
                        // This machine is never offline (see isEnvironmentUnreachable);
                        // the check here keeps its chats from ever showing it.
                        const hostOffline =
                          thread.environmentId !== primaryEnvironmentId &&
                          unreachable.has(thread.environmentId);
                        const tone = threadTone(thread, hostOffline);
                        // A chat names its machine when it is not this one, and
                        // says when that machine can't be reached.
                        const machine =
                          thread.environmentId === primaryEnvironmentId
                            ? null
                            : (machineLabels.get(thread.environmentId) ?? null);
                        // Once a chat runs away from the machine it lives on, the note
                        // says both ("Lives on M4 · runs on Minis").
                        const location = threadLocation({
                          summary: thread.source,
                          servingEnvironmentId: thread.environmentId,
                          name: (environmentId, fallbackLabel) => {
                            const known = machineLabels.get(environmentId as EnvironmentId);
                            if (known !== undefined) return known;
                            const name = nickname(environmentId, fallbackLabel);
                            return fallbackLabel || name !== environmentId
                              ? name
                              : "another machine";
                          },
                          unreachable,
                        });
                        const machineNote = hostOffline
                          ? `${machine ?? "Its machine"} can't be reached`
                          : location.moved || location.state !== "running"
                            ? location.description
                            : machine
                              ? `On ${machine}`
                              : null;
                        const title = thread.title || "Untitled chat";
                        const project = projectByMember.get(
                          `${thread.environmentId}:${thread.projectId}`,
                        );
                        const plan = chatPlans.get(key) ?? null;
                        const ref = scopeThreadRef(thread.environmentId, thread.id);
                        return (
                          <SidebarChatRow
                            key={key}
                            title={thread.title}
                            tone={tone}
                            tip={`${title} · ${label.full}${stateDescription}${project ? ` · ${project.displayName}` : ""}${machineNote ? ` · ${machineNote}` : ""} · ${compactAge(sessionStateSince(thread), now)}${plan ? ` · ${describeThreadPlan(plan)}` : ""}`}
                            current={currentChatKey === key}
                            icon={
                              <ModelBadgeMark
                                entry={entry}
                                instanceId={currentModel.instanceId}
                                provider={label.provider}
                              />
                            }
                            onOpen={() => openChat(thread)}
                            rename={chatRenameFor(thread)}
                            menuItems={
                              <>
                                {thread.settledOverride === "settled" ? (
                                  <MenuItem
                                    onClick={() =>
                                      void reportFailure("reopen", actions.unsettleThread(ref))
                                    }
                                  >
                                    Reopen
                                  </MenuItem>
                                ) : (
                                  <MenuItem
                                    onClick={() =>
                                      void reportFailure("resolve", actions.settleThread(ref))
                                    }
                                  >
                                    Resolve
                                  </MenuItem>
                                )}
                                <MenuSeparator />
                                <MenuItem
                                  disabled={!threadRuntimeCanArchive(thread.runtime)}
                                  onClick={() =>
                                    void reportFailure("archive", actions.archiveThread(ref))
                                  }
                                >
                                  Archive
                                </MenuItem>
                              </>
                            }
                          >
                            {plan ? <PlanProgressChip plan={plan} tip={false} /> : null}
                            {hostOffline ? (
                              <WifiOffIcon
                                className="sws-row-machine"
                                data-offline=""
                                aria-hidden
                              />
                            ) : machine || location.moved ? (
                              <LaptopIcon className="sws-row-machine" aria-hidden />
                            ) : null}
                            <span className="sr-only">
                              , {label.full}
                              {stateDescription}, {THREAD_TONE_LABELS[tone]}
                              {machineNote ? `, ${machineNote}` : ""}
                            </span>
                            {tone === "waiting" || tone === "working" || tone === "failed" ? (
                              <span className="sws-dot" data-tone={tone} aria-hidden />
                            ) : null}
                          </SidebarChatRow>
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

function isPersonalGroup(group: SidebarProjectSnapshot): boolean {
  return group.memberProjects.some((member) => member.workspaceSettings?.kind === "personal");
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
