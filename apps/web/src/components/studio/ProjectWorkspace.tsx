import {
  projectCoordinatorMessageDisplay,
  projectMessageAuthor,
  projectReportMessageIds,
  projectSystemNotice,
} from "../../studio/projectCoordinatorMessageDisplay";
import { ProjectWorkspaceAttachments } from "./ProjectWorkspaceAttachments";
import { ProjectPlan } from "./ProjectPlan";
import { CollapsibleReport } from "../chat/CollapsibleReport";
import { shouldCollapseReport } from "../chat/longReport";
import { ReportArtifact } from "../chat/ReportArtifact";
import { TimelineDetailMenu } from "../chat/TimelineDetailMenu";
import { CoordinatorRunActivity } from "./CoordinatorRunActivity";
import { coordinatorConversationView, withFoldedReplies } from "../../studio/coordinatorActivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import {
  AppWindowIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  EllipsisVerticalIcon,
  GaugeIcon,
  ListChecksIcon,
  PanelRightIcon,
  PlusIcon,
  RepeatIcon,
  SettingsIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  CommandId,
  type ChatAttachment,
  type ModelSelection,
  type ProjectStarterSuggestion,
  type ThreadId,
  PERSONAL_ASSISTANT_DESCRIPTION,
  PERSONAL_ASSISTANT_LABEL,
} from "@specweave-studio/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@specweave-studio/client-runtime/state/shell";
import { presentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { resolveCoordinatorModelSelection } from "@specweave-studio/shared/coordinatorDefault";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { derivePhysicalProjectKey } from "../../logicalProject";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
  useThreadProjection,
  useThreadHistory,
  useThreadStatus,
} from "../../state/entities";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { isHostedStaticApp } from "../../hostedPairing";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { composerSendButtonLabel, composerSubmissionIntentForKey } from "../../composer-logic";
import { isContextMenuOpen } from "../../contextMenuFallback";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { usePhoneKeyboard } from "../../hooks/usePhoneKeyboard";
import {
  useClientSettings,
  useClientSettingsHydrationStatus,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import {
  coordinatorMachineKey,
  resolveCoordinatorMachine,
} from "../../studio/projectCoordinatorMachine";
import { isEditableFocused } from "../../lib/editableFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { projectEnvironment } from "../../state/projects";
import { projectWorkspace } from "../../studio/projectWorkspace";
import {
  type SelectProjectThread,
  useProjectPaneSelection,
} from "../../studio/useProjectPaneSelection";
import {
  createScopedProjectSendReceipt,
  prepareProjectMarkdown,
  projectAdmissionReason,
  projectThreads,
} from "../../studio/projectWorkspaceModel";
import { modelLabel, THREAD_TONE_LABELS, threadTone, waitingCount } from "../../studio/shellModel";
import {
  PULL_REQUEST_REQUEST_EXPIRED_REASON,
  PULL_REQUEST_REQUEST_TTL_MS,
  expireThreadPullRequest,
  requestThreadPullRequest,
  showThreadDetailsPanel,
} from "../../studio/threadPullRequestRequests";
import {
  coordinatorAttention,
  type CoordinatorAttention,
} from "../../studio/projectCoordinatorThreads";
import { toastManager } from "../ui/toast";
import { ProjectThreadCard, ProjectThreadChip } from "./ProjectThreadCards";
import { RemoteWorkerCards } from "./RemoteWorkerCards";
import { useProjectRemoteWorkers } from "../../studio/fleet";
import { visibleRemoteWorkers } from "../../studio/remoteWorkerCards";
import { linkedThreadIds, newThreadsByMessage } from "../../studio/projectThreadMentions";
import { resolveStudioThreadLink } from "../../studio/studioThreadLinks";
import {
  coordinatorTurnFailure,
  sentStarterIds,
  type CoordinatorTurnFailure,
} from "../../studio/coordinatorTurnState";
import { ProjectMessageRoutingContext } from "../../studio/projectMessageRouting";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SidebarInset } from "../ui/sidebar";
import { isElectron } from "../../env";
import { canOpenProjectWindowFor, openProjectWindow } from "../../lib/projectWindow";
import ChatMarkdown from "../ChatMarkdown";
import ChatView from "../ChatView";
import { ProjectWorkspaceSettings, type ProjectSettingsTab } from "./ProjectWorkspaceSettings";
import {
  coordinatorAttachAccept,
  CoordinatorAttachmentNotice,
  CoordinatorAttachmentStrip,
  filesFrom,
  pastedFilesFrom,
  useCoordinatorAttachments,
} from "./shell/CoordinatorAttachments";
import { fileAttachmentStagingLimit } from "../chat/composerAttachmentFiles";
import { CoordinatorModelPicker } from "./shell/CoordinatorModelPicker";
import { useCoordinatorModelsLoading } from "./shell/useCoordinatorModelsLoading";
import { ProjectUsageIndicator } from "./shell/ProjectUsageIndicator";
import { useProviderEntries } from "./shell/ModelBadge";
import {
  StarterSuggestions,
  useCoordinatorPlaceholder,
  useStarterSuggestions,
} from "./shell/StarterSuggestions";
import {
  CoordinatorQuickStarts,
  greetingLine,
  quickStartDraft,
} from "./shell/CoordinatorQuickStarts";
import { ThreadsPane } from "./shell/ThreadsPane";
import { LibraryPane } from "./shell/LibraryPane";
import { PullRequestsPane } from "./shell/PullRequestsPane";
import { ScheduledPane } from "./shell/ScheduledPane";
import { ProjectThreadHeader } from "./shell/ProjectThreadHeader";
import type { ProjectPaneBarProps } from "./shell/ProjectPaneBar";
import {
  collectProjectPullRequests,
  openPullRequestCount,
  PROJECT_PANE_TABS,
  type ProjectPaneTab,
} from "../../studio/projectPaneModel";
import { isSidebarSubagentThread } from "../Sidebar.logic";
import { useOpenLink } from "../../browser/useOpenLink";
import { ProjectRoutedReplies } from "./ProjectRoutedReplies";
import {
  coordinatorProgress,
  formatProgressElapsed,
  type CoordinatorProgress,
} from "../../studio/coordinatorProgress";
import { Tip } from "./shell/Tip";
import { useCoordinatorVoiceAsk, useVoiceCall, VoiceCallBar, VoiceCallButton } from "./VoiceCall";
import { ProjectIconButton } from "./ProjectIconEditor";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { randomUUID } from "../../lib/utils";

const OVERVIEW_OPEN_STORAGE_KEY = "studio:project-overview-open:v1";
const PANE_TAB_STORAGE_KEY = "studio:project-pane-tab:v1";
const PaneTabSchema = Schema.Literals(PROJECT_PANE_TABS);
// F6 walks these in order; each names the first thing worth landing on in its pane.
const PANE_FOCUS_TARGETS = [
  "[data-app-sidebar] .sws-side-row",
  "#project-prompt",
  "[data-project-pane='threads'] :is(input[type='search'], textarea, [contenteditable='true'], .sws-group-bar, .sws-starter:enabled)",
] as const;

const QUEUED_NOTICE = "Queued for the coordinator.";
const SENT_WITH_CONTEXT_NOTICE = "Sent to the coordinator with this thread as context.";
/** Receipts for a send; the live working line replaces them while the coordinator runs. */
const SEND_NOTICES: ReadonlySet<string> = new Set([QUEUED_NOTICE, SENT_WITH_CONTEXT_NOTICE]);

/**
 * The group a project route names. Before a checkout's repository is known its
 * group is keyed by machine and path, and the key moves to the repository once
 * git answers; a link opened early still names the old key.
 */
export function findProjectGroup<
  G extends {
    projectKey: string;
    memberProjects: ReadonlyArray<Parameters<typeof derivePhysicalProjectKey>[0]>;
  },
>(groups: ReadonlyArray<G>, projectKey: string): G | undefined {
  return (
    groups.find((g) => g.projectKey === projectKey) ??
    groups.find((g) => g.memberProjects.some((m) => derivePhysicalProjectKey(m) === projectKey))
  );
}

export function ProjectWorkspace({
  projectKey: requestedKey,
  selectedThreadId = null,
  onSelectThread,
  onProjectKeyMoved,
}: {
  projectKey: string;
  /** The thread open in the right panel; the route keeps it in the URL. */
  selectedThreadId?: ThreadId | null;
  onSelectThread?: SelectProjectThread;
  /** The project's group key changed since the link was made; the route replaces the URL. */
  onProjectKeyMoved?: (projectKey: string) => void;
}) {
  // Without a route to hold it (tests, embedding), the open thread is plain state.
  const [localSelected, setLocalSelected] = useState<ThreadId | null>(null);
  const selected = onSelectThread ? selectedThreadId : localSelected;
  const setSelected: SelectProjectThread = onSelectThread ?? setLocalSelected;
  const groups = useSettingsProjectGroups();
  const projects = useProjects();
  const group = findProjectGroup(groups, requestedKey);
  // Saved choices and threads are keyed by the group's current key.
  const projectKey = group?.projectKey ?? requestedKey;
  useEffect(() => {
    if (projectKey !== requestedKey) onProjectKeyMoved?.(projectKey);
  }, [projectKey, requestedKey, onProjectKeyMoved]);
  const members = group?.memberProjects ?? [];
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const { isReady: environmentCatalogReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedMachines = useClientSettings((settings) => settings.projectCoordinatorMachines);
  const updateClientSettings = useUpdateClientSettings();
  // Before settings load the saved choices read as empty, and a pick would replace them all.
  const machinesLoaded = useClientSettingsHydrationStatus() === "ready";
  // The coordinator runs on the chosen checkout's machine; the choice is saved per project.
  const { member, savedMachineMissing } = resolveCoordinatorMachine({
    members,
    saved: savedMachines[projectKey],
    primaryEnvironmentId,
  });
  // The thread open when the checkout changed belongs to the old machine. The
  // panel closes, and until the URL catches up the new checkout does not see it,
  // or it would send the person to that machine's full page.
  const [leftThread, setLeftThread] = useState<ThreadId | null>(null);
  if (leftThread !== null && selected !== leftThread) setLeftThread(null);
  const paneSelected = selected === leftThread ? null : selected;
  const currentMachine = member ? coordinatorMachineKey(member) : null;
  const chooseMachine = (key: string) => {
    if (key !== currentMachine && selected !== null) {
      setLeftThread(selected);
      setSelected(null, { replace: true });
    }
    void updateClientSettings({
      projectCoordinatorMachines: { ...savedMachines, [projectKey]: key },
    });
  };
  const project = member
    ? projects.find((p) => p.environmentId === member.environmentId && p.id === member.id)
    : null;
  // A project window starts on this route before its hosts have answered, so
  // the project is not missing yet, only not loaded. The saved host list can
  // arrive before this computer's own host is registered, which is too early
  // to tell either.
  const hostsAnswered =
    shellsBootstrapped &&
    environmentCatalogReady &&
    (isHostedStaticApp() || primaryEnvironmentId !== null);
  // Until the hosts answer, a missing saved machine or unread choice may only be late.
  if ((!project || savedMachineMissing || !machinesLoaded) && !hostsAnswered)
    return (
      <SidebarInset className="h-dvh">
        <div className="project-surface flex min-h-0 flex-1 flex-col" aria-busy="true">
          <WorkspacePageHeader electron={isElectron}>Project workspace</WorkspacePageHeader>
          <div className="project-empty">
            <p>Loading project...</p>
            <Link to="/settings/projects">Manage projects</Link>
          </div>
        </div>
      </SidebarInset>
    );
  if (!project)
    return (
      <SidebarInset className="h-dvh">
        <div className="project-surface flex min-h-0 flex-1 flex-col">
          <WorkspacePageHeader electron={isElectron}>Project workspace</WorkspacePageHeader>
          <div className="project-empty">
            <h1>Project unavailable</h1>
            <p>Connect its host or select a registered project.</p>
            <Link to="/settings/projects">Manage projects</Link>
          </div>
        </div>
      </SidebarInset>
    );
  return (
    <ProjectWorkspaceSurface
      key={`${project.environmentId}:${project.id}`}
      project={project}
      projectKey={projectKey}
      iconCheckouts={members}
      checkouts={members.map((m) => ({
        key: coordinatorMachineKey(m),
        machine: m.environmentLabel ?? m.environmentId,
        folder: m.workspaceRoot,
      }))}
      savedMachineMissing={savedMachineMissing}
      onCheckout={machinesLoaded ? chooseMachine : null}
      selected={paneSelected}
      setSelected={setSelected}
    />
  );
}

function missingModelMessage(modelsLoading: boolean): string {
  return modelsLoading
    ? "Models are still loading from this host. Try again in a moment."
    : "Choose and save a coordinator or worker model in project settings first.";
}

function ProjectWorkspaceSurface({
  project,
  projectKey,
  iconCheckouts,
  checkouts,
  savedMachineMissing,
  onCheckout,
  selected,
  setSelected,
}: {
  project: EnvironmentProject;
  projectKey: string;
  /** Every checkout of this project; an icon change applies to all of them. */
  iconCheckouts: readonly EnvironmentProject[];
  /** The same project checked out on more than one machine or folder. */
  checkouts: ReadonlyArray<{ key: string; machine: string; folder: string }>;
  /** The saved coordinator machine is not listed, so this is another machine's coordinator. */
  savedMachineMissing: boolean;
  /** Saves the checkout whose machine runs this project's coordinator; null until saved choices load. */
  onCheckout: ((key: string) => void) | null;
  selected: ThreadId | null;
  setSelected: SelectProjectThread;
}) {
  const environment = useEnvironment(project.environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canOperate = useEnvironmentScope(project.environmentId, AuthOrchestrationOperateScope);
  // "Create PR" runs the thread's source control action, a grant of its own.
  const canWriteSourceControl = useEnvironmentScope(
    project.environmentId,
    AuthSourceControlWriteScope,
  );
  const query = useEnvironmentQuery(
    projectWorkspace.read({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const snapshot = query.data;
  const coordinatorId = snapshot?.settings.coordinatorThreadId ?? null;
  // The project shell names the coordinator before the workspace read answers; the
  // panel needs it at once, so a link to the coordinator never lands there.
  const mainCoordinatorId = coordinatorId ?? project.workspaceSettings?.coordinatorThreadId ?? null;
  const liveShells = useThreadShells();
  const archived = useArchivedThreadSnapshots([project.environmentId]);
  const remoteWorkerCount = visibleRemoteWorkers(
    useProjectRemoteWorkers(project.environmentId, project.id).workers,
  ).length;
  const shells = useMemo(() => {
    const rows = new Map<string, EnvironmentThreadShell>();
    for (const entry of archived.snapshots)
      for (const thread of entry.snapshot.threads) {
        const row = presentThreadShell(entry.environmentId, thread);
        rows.set(`${row.environmentId}:${row.id}`, row);
      }
    for (const row of liveShells) rows.set(`${row.environmentId}:${row.id}`, row);
    return [...rows.values()];
  }, [liveShells, archived.snapshots]);
  const workers = useMemo(
    () => projectThreads(shells, project.environmentId, project.id, mainCoordinatorId),
    [shells, project.environmentId, project.id, mainCoordinatorId],
  );
  const environmentThreads = useMemo(
    () => shells.filter((thread) => thread.environmentId === project.environmentId),
    [shells, project.environmentId],
  );
  const paneScope = useMemo(
    () => ({
      environmentId: project.environmentId,
      projectId: project.id,
      coordinatorThreadId: mainCoordinatorId,
    }),
    [project.environmentId, project.id, mainCoordinatorId],
  );
  const [tab, setTab] = useState<ProjectSettingsTab | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [storedOverviewOpen, setStoredOverviewOpen] = useLocalStorage<boolean, boolean>(
    OVERVIEW_OPEN_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  // A phone shows one pane at a time, so it starts on the coordinator and neither
  // inherits nor overwrites the wide layout's remembered choice. Keep 760px in step
  // with shell.css.
  const phone = useMediaQuery("(max-width: 760px)");
  const [phoneOverviewOpen, setPhoneOverviewOpen] = useState(false);
  const overviewOpen = phone ? phoneOverviewOpen : storedOverviewOpen;
  const setOverviewOpen = phone ? setPhoneOverviewOpen : setStoredOverviewOpen;
  const isPhoneKeyboard = usePhoneKeyboard();
  const sendShortcut = useClientSettings((settings) => settings.sendShortcut);
  const [savingModel, setSavingModel] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [paneTab, setPaneTab] = useLocalStorage<ProjectPaneTab, ProjectPaneTab>(
    PANE_TAB_STORAGE_KEY,
    "threads",
    PaneTabSchema,
  );
  // The panel takes the whole width, as the desktop app's expand does; never remembered.
  const [paneExpanded, setPaneExpanded] = useState(false);
  // The open thread's header slot that the embedded chat portals its panel toggles into.
  const [threadToolsSlot, setThreadToolsSlot] = useState<HTMLSpanElement | null>(null);
  const [findQuery, setFindQuery] = useState("");
  // Where to put the keyboard back when an opened thread is left.
  const lastOpened = useRef<ThreadId | null>(null);
  const threadsLoaded = useAllEnvironmentShellsBootstrapped() && !archived.isLoading;
  // The coordinator is this page's main conversation: a link to it brings that into view.
  const showCoordinator = useCallback(() => {
    if (phone) setOverviewOpen(false);
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>("[data-coordinator-end]")
        ?.scrollIntoView({ block: "end" });
      if (!phone)
        document
          .querySelector<HTMLTextAreaElement>("#project-prompt")
          ?.focus({ preventScroll: true });
    });
  }, [phone, setOverviewOpen]);
  const { selectedThread, openThreadInPane, openThread } = useProjectPaneSelection({
    shells,
    scope: paneScope,
    selected,
    setSelected,
    setOverviewOpen,
    lastOpened,
    threadsLoaded,
    onShowCoordinator: showCoordinator,
  });
  // The panel's thread steps aside for the main conversation.
  const openCoordinator = useCallback(() => {
    setSelected(null);
    showCoordinator();
  }, [setSelected, showCoordinator]);
  // "Create PR" on a card runs the thread's own source control button, beside the thread.
  const createPullRequest = useCallback(
    (thread: EnvironmentThreadShell) => {
      const ref = scopeThreadRef(thread.environmentId, thread.id);
      const requestedAt = requestThreadPullRequest(ref);
      showThreadDetailsPanel(ref);
      openThread(thread.id);
      // The card owns the deadline: when no source control button ever acts on
      // the request, it says so instead of leaving the click without an answer.
      window.setTimeout(() => {
        if (expireThreadPullRequest(ref, requestedAt))
          toastManager.add({
            type: "info",
            title: "No pull request opened",
            description: PULL_REQUEST_REQUEST_EXPIRED_REASON,
          });
      }, PULL_REQUEST_REQUEST_TTL_MS + 500);
    },
    [openThread],
  );
  const inFlight = useRef(false);
  const [receipt] = useState(() =>
    createScopedProjectSendReceipt(project.environmentId, project.id),
  );
  const sendCommand = useAtomCommand(projectWorkspace.send, { reportFailure: false });
  const navigate = useNavigate();
  const connected = environment?.connection.phase === "connected";
  const blocked = projectAdmissionReason(snapshot?.settings ?? null, connected, canOperate);
  const coordinator = shells.find(
    (t) => t.id === coordinatorId && t.environmentId === project.environmentId,
  );
  // An accepted message is not an answer: its run can still fail on the host.
  const coordinatorFailure = coordinatorTurnFailure(coordinator);
  const coordinatorRef = useMemo(
    () => (coordinatorId ? scopeThreadRef(project.environmentId, coordinatorId) : null),
    [project.environmentId, coordinatorId],
  );
  const coordinatorThread = useThreadProjection(coordinatorRef);
  // What the coordinator is doing this second; it answers a send before any reply is written.
  const coordinatorWork = coordinatorThread
    ? coordinatorProgress(coordinatorThread.projection)
    : null;
  const coordinatorWorking = coordinatorWork !== null;
  useEffect(() => {
    // The live line below the conversation now says more than "Queued" could,
    // and once the turn ends a send receipt is stale, whichever order the send
    // response and the projection update arrived in.
    if (coordinatorWorking) setNotice(null);
    else setNotice((current) => (current !== null && SEND_NOTICES.has(current) ? null : current));
  }, [coordinatorWorking]);
  // The project shell follows saves made in any window; the snapshot is read once.
  const liveSettings = project.workspaceSettings;
  const hostProviders = environment?.serverConfig?.providers;
  const hostSettings = environment?.serverConfig?.settings;
  // Until the host's providers are in and checked there is nothing to choose from, so nothing
  // is missing yet.
  const modelsLoading = useCoordinatorModelsLoading(environment?.serverConfig);
  // What the coordinator runs on, in the order the host starts one: shown so the picker is never empty.
  const model = resolveCoordinatorModelSelection({
    saved: liveSettings?.coordinatorModelSelection ?? snapshot?.settings.coordinatorModelSelection,
    coordinatorThreadModel: coordinator?.modelSelection,
    projectDefault: project.defaultModelSelection,
    scopedDefault: hostSettings
      ? resolveProjectSettings(hostSettings, project.id, project).settings.defaultModelSelection
      : null,
    providers: hostProviders,
  });
  const actions = useThreadActions();
  const providerEntries = useProviderEntries(project.environmentId);
  // The limit rule moved the coordinator off its saved model; it returns once that has room.
  const savedCoordinatorModel = liveSettings?.coordinatorModelSelection ?? null;
  const coordinatorFallback =
    coordinator && savedCoordinatorModel
      ? coordinator.modelSelection.instanceId !== savedCoordinatorModel.instanceId
        ? {
            now: modelLabel(
              providerEntries.get(coordinator.modelSelection.instanceId) ?? null,
              coordinator.modelSelection.instanceId,
              coordinator.modelSelection.model,
            ),
            saved: modelLabel(
              providerEntries.get(savedCoordinatorModel.instanceId) ?? null,
              savedCoordinatorModel.instanceId,
              savedCoordinatorModel.model,
            ),
          }
        : null
      : null;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const revision = liveSettings?.revision ?? snapshot?.settings.revision ?? null;
  const refreshSnapshot = query.refresh;
  const saveCoordinatorModel = useCallback(
    async (selection: ModelSelection) => {
      if (revision === null) return;
      setSavingModel(true);
      setError(null);
      const result = await updateProject({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          workspaceSettings: { expectedRevision: revision, coordinatorModelSelection: selection },
        },
      });
      setSavingModel(false);
      if (result._tag === "Failure") {
        const e = squashAtomCommandFailure(result);
        setError(
          e instanceof Error ? e.message : "The coordinator model was not saved. Try again.",
        );
      } else setNotice("Coordinator model saved for this project.");
      refreshSnapshot();
    },
    [project.environmentId, project.id, refreshSnapshot, revision, updateProject],
  );
  const threadOpen = selectedThread !== null;
  const threadBusy = selectedThread ? threadTone(selectedThread) === "working" : false;
  const leaveThread = useCallback(() => {
    const id = lastOpened.current;
    setSelected(null);
    requestAnimationFrame(() => {
      const row =
        id === null
          ? null
          : document.querySelector<HTMLElement>(
              `[data-thread-id="${CSS.escape(id)}"] .sws-thread-open`,
            );
      (row ?? document.querySelector<HTMLElement>(".sws-group-bar"))?.focus();
    });
  }, [setSelected]);
  const hideOverview = useCallback(() => {
    // The pane takes the focused control with it; hand the keyboard to what reopens it.
    const inPane = document.activeElement?.closest("[data-project-pane='threads']") != null;
    setSelected(null);
    setOverviewOpen(false);
    setPaneExpanded(false);
    if (inPane)
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(".sws-overview-toggle")?.focus(),
      );
  }, [setOverviewOpen, setSelected]);
  // Threads in a project are the coordinator's to start, so the new-thread shortcut
  // lands on the place to ask for one instead of opening an empty thread.
  const askCoordinator = useCallback(() => {
    // A phone shows one pane at a time; the coordinator is behind the thread pane.
    if (phone) {
      setSelected(null);
      setOverviewOpen(false);
    }
    setError(null);
    setNotice("Ask the coordinator for a new thread. It starts the thread and links it here.");
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>("#project-prompt")?.focus(),
    );
  }, [phone, setOverviewOpen, setSelected]);
  // The button and the shortcut are one control: with a thread open, hiding the pane leaves it.
  const toggleOverview = useCallback(() => {
    if (threadOpen || overviewOpen) hideOverview();
    else setOverviewOpen(true);
  }, [hideOverview, overviewOpen, threadOpen, setOverviewOpen]);
  useEffect(() => {
    // A dialog or menu owns the keyboard while it is open. It closes itself on the
    // same key press, so look before it has the chance to.
    let overlayOwnsKey = false;
    const onKeyDownCapture = (event: KeyboardEvent) => {
      overlayOwnsKey = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="dialog"], [role="menu"], [role="listbox"]',
        ),
      ].some((overlay) => overlay.checkVisibility?.() ?? true);
      // The opened thread focuses its own composer, which keeps Escape for itself. Take it
      // first, but only from an empty editor and an idle thread: a draft and a running turn
      // both have their own use for the key.
      if (
        event.key !== "Escape" ||
        !threadOpen ||
        threadBusy ||
        event.repeat ||
        event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        overlayOwnsKey ||
        isCommandPaletteOpen() ||
        isModelPickerOpen()
      )
        return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      // Only the thread's own composer is taken here. The terminal, comment editors,
      // banners and the context menu keep the key and are heard in the bubble phase.
      const composer = target?.closest<HTMLElement>(
        "[data-project-pane='threads'] [data-testid='composer-editor']",
      );
      if (!composer || isContextMenuOpen()) return;
      if ((composer.textContent ?? "").trim() !== "") return;
      event.preventDefault();
      event.stopPropagation();
      leaveThread();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
        return;
      if (overlayOwnsKey || isCommandPaletteOpen() || isModelPickerOpen()) return;
      const editable = isEditableFocused(event.target);
      const command = resolveShortcutCommand(event, keybindings, {
        context: { editableFocus: editable, modelPickerOpen: false },
      });
      if (command === "rightPanel.toggle") {
        event.preventDefault();
        toggleOverview();
        return;
      }
      if (command === "chat.new" || command === "chat.newLocal") {
        event.preventDefault();
        askCoordinator();
        return;
      }
      if (event.key === "F6") {
        event.preventDefault();
        const targets = PANE_FOCUS_TARGETS.map((selector) =>
          document.querySelector<HTMLElement>(selector),
        );
        const current = targets.findIndex(
          (target, index) =>
            target !== null &&
            document.activeElement instanceof HTMLElement &&
            document.activeElement.closest(
              index === 0
                ? "[data-app-sidebar]"
                : index === 1
                  ? "[data-project-pane='coordinator']"
                  : "[data-project-pane='threads']",
            ) !== null,
        );
        for (let step = 1; step <= targets.length; step += 1) {
          const next =
            targets[
              (current + (event.shiftKey ? -step : step) + targets.length * 2) % targets.length
            ];
          // A collapsed sidebar is only slid off screen; do not send focus there.
          if (next && next.offsetParent !== null && next.getBoundingClientRect().right > 0) {
            next.focus();
            break;
          }
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (editable) return;
      if (event.key === "Escape" && threadOpen && !threadBusy && !event.shiftKey) {
        event.preventDefault();
        leaveThread();
        return;
      }
      if (event.key === "/" && !threadOpen) {
        event.preventDefault();
        setOverviewOpen(true);
        setPaneTab("threads");
        setFindOpen(true);
        // By the next frame the field is on screen, whether it was already or not.
        requestAnimationFrame(() => findRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKeyDownCapture, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDownCapture, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    askCoordinator,
    keybindings,
    leaveThread,
    setOverviewOpen,
    setPaneTab,
    threadBusy,
    threadOpen,
    toggleOverview,
  ]);
  const routingSend = useCallback(
    async (
      text: string,
      sourceThreadId?: ThreadId,
      attachments?: ReadonlyArray<ChatAttachment>,
    ) => {
      if (inFlight.current)
        throw new Error("Another project message is being confirmed. Your draft is preserved.");
      if (blocked) throw new Error(blocked);
      if (!model && !coordinatorId) throw new Error(missingModelMessage(modelsLoading));
      inFlight.current = true;
      setSending(true);
      setError(null);
      setNotice(null);
      const commandId = receipt.forPrompt(
        JSON.stringify([project.id, text, sourceThreadId ?? null, attachments ?? []]),
        () => randomUUID(),
      );
      try {
        const result = await sendCommand({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            commandId: CommandId.make(commandId),
            prompt: text,
            ...(attachments?.length ? { attachments } : {}),
            ...(sourceThreadId ? { sourceThreadId } : {}),
          },
        });
        if (result._tag === "Failure") {
          const e = squashAtomCommandFailure(result);
          throw new Error(
            e instanceof Error
              ? e.message
              : "Delivery was not confirmed. Retry preserves the same request identity.",
          );
        }
        receipt.acknowledge(commandId);
        query.refresh();
        setNotice(sourceThreadId ? SENT_WITH_CONTEXT_NOTICE : QUEUED_NOTICE);
      } finally {
        inFlight.current = false;
        setSending(false);
      }
    },
    [
      blocked,
      model,
      modelsLoading,
      coordinatorId,
      receipt,
      project.environmentId,
      project.id,
      sendCommand,
      query.refresh,
    ],
  );
  // A voice call speaks through the same send path and listens to the same conversation.
  const coordinatorMessages = coordinatorThread?.projection.messages;
  const coordinatorRuns = coordinatorThread?.projection.runs;
  const failedRunId = coordinatorFailure?.runId ?? null;
  const failedMessage = coordinatorFailure?.message ?? "";
  const coordinatorLoaded = coordinatorRef === null || coordinatorThread !== null;
  const voiceSnapshot = useMemo(
    () => ({
      loaded: coordinatorLoaded,
      messages: coordinatorMessages ?? [],
      runs: coordinatorRuns ?? [],
      failure: failedRunId === null ? null : { runId: failedRunId, message: failedMessage },
    }),
    [coordinatorLoaded, coordinatorMessages, coordinatorRuns, failedRunId, failedMessage],
  );
  const askByVoice = useCoordinatorVoiceAsk(voiceSnapshot, (text) => routingSend(text));
  const voiceCall = useVoiceCall(askByVoice);
  const hostCapabilities = environment?.serverConfig?.environment.capabilities;
  const uploadsSupported = hostCapabilities?.attachmentUploads === true;
  // Coordinator turns carry files the way thread turns do: the agent gets each one's path.
  const maxFileBytes = fileAttachmentStagingLimit({
    attachmentUploadsCapabilityKnown: hostCapabilities !== undefined,
    supportsAttachmentUploads: uploadsSupported,
    maxFileAttachmentBytes: hostCapabilities?.fileAttachments?.maxUploadBytes ?? null,
  });
  const attached = useCoordinatorAttachments({
    environmentId: project.environmentId,
    uploadsSupported,
    canUpload: canOperate && connected,
    maxFileBytes,
  });
  const filePicker = useRef<HTMLInputElement>(null);
  // Uploads can take a while; one send owns the composer from the first keypress to the answer.
  const submitting = useRef(false);
  const [preparing, setPreparing] = useState(false);
  // One rule for the Send button and the Enter key.
  const sendDisabled =
    Boolean(blocked) ||
    (!model && !coordinatorId) ||
    sending ||
    preparing ||
    attached.preparing.length > 0 ||
    (!prompt.trim() && attached.attachments.length === 0);
  async function submit() {
    const text = prompt;
    const images = attached.attachments;
    if (submitting.current || (!text.trim() && images.length === 0)) return;
    submitting.current = true;
    setPreparing(true);
    setError(null);
    attached.dismissProblem();
    let release = () => {};
    try {
      const attachments = await attached.prepare(images);
      release = attached.hold(images);
      await routingSend(text, undefined, attachments.length ? attachments : undefined);
      release();
      setPrompt((current) => (current === text ? "" : current));
      attached.clearSent(images);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Message not sent.");
    } finally {
      release();
      submitting.current = false;
      setPreparing(false);
    }
  }
  async function resolve(thread: EnvironmentThreadShell) {
    const result =
      thread.archivedAt !== null
        ? await actions.unarchiveThread(scopeThreadRef(project.environmentId, thread.id), {
            navigate: false,
          })
        : thread.settledOverride === "settled"
          ? await actions.unsettleThread(scopeThreadRef(project.environmentId, thread.id))
          : await actions.settleThread(scopeThreadRef(project.environmentId, thread.id));
    if (result?._tag === "Failure") {
      const e = squashAtomCommandFailure(result);
      setError(e instanceof Error ? e.message : "Thread status could not be changed.");
    }
  }
  // A project with no threads yet is offered a few first tasks; choosing one is a
  // message to the coordinator like any other, so the coordinator still starts the thread.
  const starters = useStarterSuggestions({
    environmentId: project.environmentId,
    projectId: project.id,
    enabled: snapshot != null && workers.length === 0,
    kind: snapshot?.settings.kind ?? "code",
    goal: liveSettings?.goal ?? snapshot?.settings.goal ?? "",
    hasMemory: (snapshot?.memory.files.length ?? 0) > 0,
  });
  const promptPlaceholder = useCoordinatorPlaceholder(workers.length > 0, starters.suggestions);
  const [startingSuggestion, setStartingSuggestion] = useState<string | null>(null);
  // Sent cards come from the coordinator thread, so they survive a reload. Until
  // the host echoes the message, a local mark holds the card, keyed by the
  // failure showing when it was sent: a newer failure releases it for a retry.
  const [startedSuggestions, setStartedSuggestions] = useState<ReadonlyMap<string, string | null>>(
    () => new Map(),
  );
  const sentSuggestions = new Set(
    sentStarterIds(starters.suggestions, coordinatorThread?.projection ?? null, coordinatorFailure),
  );
  for (const [id, failureAtSend] of startedSuggestions)
    if ((coordinatorFailure?.runId ?? null) === failureAtSend) sentSuggestions.add(id);
  async function startSuggestion(suggestion: ProjectStarterSuggestion) {
    if (startingSuggestion !== null || submitting.current) return;
    setStartingSuggestion(suggestion.id);
    setError(null);
    try {
      await routingSend(suggestion.prompt);
      setStartedSuggestions((current) =>
        new Map(current).set(suggestion.id, coordinatorFailure?.runId ?? null),
      );
      // A phone shows one pane at a time; the coordinator's answer is in the other one.
      if (phone) setOverviewOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The suggestion was not sent.");
    } finally {
      setStartingSuggestion(null);
    }
  }
  const startersBlocked =
    blocked ??
    (!model && !coordinatorId
      ? modelsLoading
        ? "Models are still loading from this host."
        : "Choose a coordinator model to start one of these."
      : null);
  const starterList = (
    <StarterSuggestions
      suggestions={starters.suggestions}
      loading={starters.loading}
      layout="list"
      heading="Suggested first threads"
      blocked={startersBlocked}
      startingId={startingSuggestion}
      startedIds={sentSuggestions}
      onStart={(suggestion) => void startSuggestion(suggestion)}
    />
  );
  const coordinatorTone = coordinator ? threadTone(coordinator) : null;
  // Approvals, answers and plans live on the coordinator's own page; the project
  // page links there while the coordinator waits on the person, never the panel.
  const attention = coordinatorAttention(coordinator ?? null);
  const openCoordinatorPage = useCallback(() => {
    if (!coordinatorId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: project.environmentId, threadId: coordinatorId },
    });
  }, [coordinatorId, navigate, project.environmentId]);
  const waiting = waitingCount(workers);
  const openLink = useOpenLink(null);
  const pullRequests = collectProjectPullRequests(
    coordinator ? [coordinator, ...workers] : workers,
  );
  const openPullRequests = openPullRequestCount(pullRequests);
  const subagentCount = selectedThread
    ? shells.filter(
        (t) =>
          t.deletedAt === null &&
          t.environmentId === selectedThread.environmentId &&
          isSidebarSubagentThread(t) &&
          t.lineage.parentThreadId === selectedThread.id,
      ).length
    : 0;
  const paneBar: ProjectPaneBarProps = {
    tab: paneTab,
    onTabChange: setPaneTab,
    counts: {
      threads: { value: waiting, label: "waiting on you", tone: "waiting" },
      prs: { value: openPullRequests, label: "open" },
    },
    onNewThread: askCoordinator,
    onOpenPlan: () => setPlanOpen(true),
    onOpenUsage: () => setTab("usage"),
    expanded: paneExpanded,
    onToggleExpanded: () => setPaneExpanded((value) => !value),
    onClose: hideOverview,
  };
  const overviewShortcut = shortcutLabelForCommand(keybindings, "rightPanel.toggle");
  const paneOpen = overviewOpen || selectedThread !== null;
  // The desktop app's primary host is this Mac, so its owner is the person looking;
  // a browser may be paired with someone else's server.
  const greetsByName = isElectron && project.environmentId === primaryEnvironmentId;
  const quickStarts = (
    <CoordinatorQuickStarts
      // Hidden sends can't be appended to: a chip waits while a message is on its way.
      disabled={!canOperate || !connected || sending || preparing}
      onPrompt={(text) => {
        setPrompt((current) => quickStartDraft(current, text));
        // Typing continues at the end of the filled-in request.
        requestAnimationFrame(() => {
          const field = document.getElementById("project-prompt");
          if (!(field instanceof HTMLTextAreaElement)) return;
          field.focus();
          field.setSelectionRange(field.value.length, field.value.length);
        });
      }}
      onConnections={() => setTab("environment")}
    />
  );
  // Claude's project home: a short greeting and three ways in, at the top of an empty
  // conversation. The host's project-specific ideas stay in the Threads pane.
  const welcome = (
    <div className="project-conversation-empty sws-coordinator-empty sws-coordinator-greeting">
      <p className="sws-greeting">
        {greetingLine(greetsByName ? (environment?.label ?? null) : null)}
        <br />
        {snapshot?.settings.kind === "personal"
          ? `Excited to get started as your ${PERSONAL_ASSISTANT_LABEL.toLowerCase()}. Here are a few ways to begin.`
          : `Excited to get started on ${project.title}. Here are a few ways to begin.`}
      </p>
      {quickStarts}
    </div>
  );
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <div className="project-surface project-workspace sws-project flex min-h-0 flex-1 flex-col">
        {planOpen && (
          <ProjectPlan
            project={project}
            canOperate={canOperate && connected}
            onClose={() => setPlanOpen(false)}
            onOpenThread={openThread}
            onExecuteTask={(taskId) =>
              routingSend(
                `Work on saved project plan task ${taskId}. Read studio_project_plan_read for the current spec, criteria and owner. Delegate as appropriate; the executing thread should claim its own task using studio_project_plan_claim, preserve existing owners, and report concrete evidence. Reported completion remains separate from human verification.`,
              )
            }
          />
        )}
        <div
          className={`project-workspace-columns sws-columns ${selectedThread ? "project-worker-open" : ""}`}
          data-overview={paneOpen ? "open" : "closed"}
          data-expanded={paneOpen && paneExpanded ? "true" : undefined}
        >
          <section
            className="project-coordinator sws-coordinator"
            aria-label="Project coordinator"
            data-project-pane="coordinator"
          >
            {/* The top bar spans this column only: the panel beside it runs the full
                height and keeps its own header in the same title row. */}
            <WorkspacePageHeader
              electron={isElectron}
              reserveNativeControls={isElectron && !paneOpen}
              className="project-topbar project-workspace-header sws-topbar"
            >
              <div className="project-workspace-identity sws-project-id">
                <ProjectIconButton
                  project={project}
                  checkouts={iconCheckouts}
                  disabled={!canOperate || !connected}
                  className="size-5 shrink-0"
                />
                <Tip
                  label={
                    snapshot?.settings.kind === "personal"
                      ? `${project.title} · ${PERSONAL_ASSISTANT_LABEL}`
                      : project.workspaceRoot
                  }
                >
                  <h1>{project.title}</h1>
                </Tip>
                {snapshot?.settings.kind === "personal" ? (
                  <Tip label={PERSONAL_ASSISTANT_DESCRIPTION}>
                    <span className="sws-tag">
                      {PERSONAL_ASSISTANT_LABEL}
                      <span className="sr-only">: {PERSONAL_ASSISTANT_DESCRIPTION}</span>
                    </span>
                  </Tip>
                ) : null}
              </div>
              <div className="project-header-actions sws-top-actions">
                <Tip
                  label={`${paneOpen ? "Hide" : "Show"} overview${overviewShortcut ? ` (${overviewShortcut})` : ""}`}
                >
                  <button
                    type="button"
                    className="project-control sws-top-button sws-overview-toggle"
                    aria-label={`Overview${!paneOpen && waiting > 0 ? `, ${waiting} waiting on you` : ""}`}
                    aria-pressed={paneOpen}
                    aria-controls={paneOpen ? "project-threads-pane" : undefined}
                    onClick={toggleOverview}
                  >
                    <PanelRightIcon aria-hidden />
                    <span>Overview</span>
                    {!paneOpen && waiting > 0 ? (
                      <span className="sws-count sws-count-waiting" aria-hidden>
                        {waiting}
                      </span>
                    ) : null}
                  </button>
                </Tip>
                <TimelineDetailMenu appearance="project" />
                <Tip label="Project settings">
                  <button
                    type="button"
                    className="sws-icon-button"
                    aria-label="Project settings"
                    onClick={() => setTab("general")}
                  >
                    <SettingsIcon aria-hidden />
                  </button>
                </Tip>
                <Menu>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <MenuTrigger
                          render={
                            <button
                              type="button"
                              className="sws-icon-button"
                              aria-label="More project actions"
                            />
                          }
                        />
                      }
                    >
                      <EllipsisVerticalIcon aria-hidden />
                    </TooltipTrigger>
                    <TooltipPopup side="bottom">More</TooltipPopup>
                  </Tooltip>
                  <MenuPopup align="end" side="bottom" className="min-w-52">
                    <MenuItem onClick={() => setPlanOpen(true)}>
                      <ListChecksIcon aria-hidden />
                      Plan
                    </MenuItem>
                    <MenuItem onClick={() => setTab("usage")}>
                      <GaugeIcon aria-hidden />
                      Usage
                    </MenuItem>
                    <MenuItem onClick={() => setTab("routines")}>
                      <RepeatIcon aria-hidden />
                      Routines
                    </MenuItem>
                    {canOpenProjectWindowFor(projectKey) ? (
                      <MenuItem
                        onClick={() => void openProjectWindow({ projectKey, title: project.title })}
                      >
                        <AppWindowIcon aria-hidden />
                        Open in new window
                      </MenuItem>
                    ) : null}
                  </MenuPopup>
                </Menu>
              </div>
            </WorkspacePageHeader>
            <h2 className="sr-only">Coordinator</h2>
            {query.error && (
              <p className="project-notice sws-pane-notice" role="alert">
                {query.error}{" "}
                <button type="button" className="project-control" onClick={query.refresh}>
                  Retry
                </button>
              </p>
            )}
            {coordinatorId ? (
              <CoordinatorConversation
                project={project}
                coordinatorId={coordinatorId}
                workers={workers}
                environmentThreads={environmentThreads}
                onOpenThread={openThread}
                canChange={canWriteSourceControl && connected}
                onCreatePullRequest={createPullRequest}
                onOpenPullRequest={(url) => void openLink(url).catch(() => undefined)}
                attention={attention}
                onOpenCoordinatorPage={openCoordinatorPage}
                failure={coordinatorFailure}
                progress={coordinatorWork}
                empty={welcome}
              />
            ) : snapshot != null && !mainCoordinatorId ? (
              // Only a project known to have no coordinator yet is greeted: while the
              // workspace read is pending, a coordinator with history may be behind it.
              welcome
            ) : null}
            <form
              className="project-composer sws-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              {blocked && (
                <p className="project-muted" role="status">
                  {blocked}
                </p>
              )}
              {error && <p role="alert">{error}</p>}
              <CoordinatorAttachmentNotice
                problem={attached.problem}
                onDismiss={attached.dismissProblem}
              />
              {/* A "Queued" notice must not stand beside a turn that failed. */}
              {notice &&
                !coordinatorFailure &&
                !(coordinatorWorking && SEND_NOTICES.has(notice)) && (
                  <p className="project-muted" role="status">
                    {notice}
                  </p>
                )}
              <VoiceCallBar call={voiceCall} />
              <div
                className="sws-composer-card"
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes("Files")) e.preventDefault();
                }}
                onDrop={(e) => {
                  if (!e.dataTransfer.types.includes("Files")) return;
                  // Every dropped file is answered: attached, or told why not.
                  e.preventDefault();
                  attached.add(filesFrom(e.dataTransfer));
                }}
              >
                <CoordinatorAttachmentStrip
                  attachments={attached.attachments}
                  preparing={attached.preparing}
                  locked={preparing || sending}
                  onRemove={(id) => {
                    attached.remove(id);
                    // The button that had focus is gone; typing continues in the message.
                    document.getElementById("project-prompt")?.focus();
                  }}
                />
                <label className="sr-only" htmlFor="project-prompt">
                  Message the project coordinator
                </label>
                <textarea
                  id="project-prompt"
                  rows={1}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={promptPlaceholder}
                  onPaste={(e) => {
                    const files = pastedFilesFrom(e.clipboardData);
                    if (files.length === 0) return;
                    // A file on the clipboard is the message's attachment, not text to insert.
                    e.preventDefault();
                    attached.add(files);
                  }}
                  onKeyDown={(e) => {
                    // The chat composer's own rule: the person's send shortcut, never on a
                    // phone keyboard, never mid-composition or on a held key.
                    const intent = composerSubmissionIntentForKey({
                      event: e.nativeEvent,
                      keybindings,
                      isPhoneKeyboard,
                      isDraftThread: false,
                      sendShortcut,
                      prompt,
                    });
                    if (intent !== "foreground") return;
                    // The send key never types a new line, but it sends only when the Send
                    // button could: images still preparing, a blocked host or a send in
                    // flight are all visible beside it.
                    e.preventDefault();
                    if (sendDisabled) {
                      // The only reason not shown beside the composer: say it, as a send would.
                      if (
                        !blocked &&
                        !model &&
                        !coordinatorId &&
                        (prompt.trim() || attached.attachments.length > 0)
                      )
                        setError(missingModelMessage(modelsLoading));
                      return;
                    }
                    void submit();
                  }}
                />
                <Tip label={composerSendButtonLabel({ isPhoneKeyboard, sendShortcut, prompt })}>
                  <button
                    className="sws-send"
                    aria-label="Send to coordinator"
                    disabled={sendDisabled}
                  >
                    <ArrowUpIcon aria-hidden />
                    <span className="sr-only">{sending || preparing ? "Sending…" : "Send"}</span>
                  </button>
                </Tip>
              </div>
              <div className="sws-composer-foot">
                <span className="sws-composer-meta">
                  <input
                    ref={filePicker}
                    type="file"
                    accept={coordinatorAttachAccept(maxFileBytes !== null)}
                    multiple
                    hidden
                    tabIndex={-1}
                    aria-hidden
                    onChange={(e) => {
                      attached.add([...(e.target.files ?? [])]);
                      e.target.value = "";
                    }}
                  />
                  <Tip label="Attach images or files (or paste, or drop them on the message)">
                    <button
                      type="button"
                      className="sws-icon-button sws-attach"
                      aria-label="Attach files"
                      disabled={!canOperate || !connected}
                      onClick={() => filePicker.current?.click()}
                    >
                      <PlusIcon aria-hidden />
                    </button>
                  </Tip>
                  <VoiceCallButton
                    call={voiceCall}
                    disabled={Boolean(blocked) || (!model && !coordinatorId)}
                  />
                  {coordinator && coordinatorTone ? (
                    <Tip
                      label={
                        attention
                          ? `${attention.message} Open the coordinator's own page`
                          : "Coordinator status. Show its latest message"
                      }
                    >
                      <button
                        type="button"
                        className="sws-state"
                        data-tone={coordinatorTone}
                        data-opens={attention ? "coordinator-page" : "conversation"}
                        onClick={attention ? openCoordinatorPage : openCoordinator}
                      >
                        <span className="sws-dot" data-tone={coordinatorTone} aria-hidden />
                        {THREAD_TONE_LABELS[coordinatorTone]}
                        <span className="sr-only">
                          {attention
                            ? `, ${attention.action.toLowerCase()} on the coordinator's own page`
                            : ", show the coordinator's latest message"}
                        </span>
                      </button>
                    </Tip>
                  ) : null}
                  <CoordinatorMachine
                    label={environment?.label ?? "Host"}
                    connected={connected}
                    current={`${project.environmentId}:${project.id}`}
                    checkouts={checkouts}
                    savedMachineMissing={savedMachineMissing}
                    onChoose={onCheckout}
                  />
                  <ProjectUsageIndicator
                    onOpenProjectUsage={() => setTab("usage")}
                    projectEnvironmentId={project.environmentId}
                  />
                </span>
                <CoordinatorModelPicker
                  environmentId={project.environmentId}
                  value={model ?? null}
                  disabled={
                    !canOperate || !connected || revision === null || (query.isPending && !snapshot)
                  }
                  saving={savingModel}
                  onChange={(selection) => void saveCoordinatorModel(selection)}
                  onOpenSettings={() => setTab("general")}
                />
                {coordinatorFallback ? (
                  <span
                    className="sws-model-fallback"
                    role="status"
                    title={`Saved model: ${coordinatorFallback.saved.full}. The coordinator goes back to it once its usage has room.`}
                  >
                    On {coordinatorFallback.now.full}
                  </span>
                ) : null}
              </div>
            </form>
          </section>
          {paneOpen ? (
            <aside
              id="project-threads-pane"
              className="project-thread-pane sws-threads"
              aria-label={selectedThread ? `Thread ${selectedThread.title}` : "Project threads"}
              data-project-pane="threads"
            >
              {selectedThread ? (
                <>
                  <ProjectThreadHeader
                    thread={selectedThread}
                    subagentCount={subagentCount}
                    providerEntry={
                      providerEntries.get(selectedThread.modelSelection.instanceId) ?? null
                    }
                    projectCwd={project.workspaceRoot}
                    canChange={canOperate && connected}
                    expanded={paneExpanded}
                    onBack={leaveThread}
                    onToggleResolved={() => void resolve(selectedThread)}
                    onToggleExpanded={() => setPaneExpanded((value) => !value)}
                    onClose={hideOverview}
                    onOpenPullRequest={(url) => void openLink(url).catch(() => undefined)}
                    toolsSlotRef={setThreadToolsSlot}
                  />
                  <div className="project-route-note">
                    Replies pass through the coordinator with this thread as context.
                  </div>
                  {/* The panel never holds the coordinator: the main column shows it. */}
                  {coordinatorId ? (
                    <ProjectRoutedReplies
                      project={project}
                      coordinatorId={coordinatorId}
                      thread={selectedThread}
                      onOpenCoordinator={openCoordinator}
                    />
                  ) : null}
                  <ProjectMessageRoutingContext
                    value={{
                      coordinatorThreadId: coordinatorId,
                      send: (text, attachments) =>
                        routingSend(text, selectedThread.id, attachments),
                      openCoordinator,
                      openThread: openThreadInPane,
                    }}
                  >
                    <div className="project-native-thread">
                      <ChatView
                        key={`${project.environmentId}:${selectedThread.id}`}
                        environmentId={project.environmentId}
                        threadId={selectedThread.id}
                        routeKind="server"
                        layoutMode="embedded"
                        embeddedHeaderToolsTarget={threadToolsSlot}
                        reserveTitleBarControlInset={false}
                      />
                    </div>
                  </ProjectMessageRoutingContext>
                </>
              ) : paneTab === "library" ? (
                <LibraryPane
                  environmentId={project.environmentId}
                  projectId={project.id}
                  workspaceRoot={project.workspaceRoot}
                  canChange={canOperate && connected}
                  bar={paneBar}
                />
              ) : paneTab === "prs" ? (
                <PullRequestsPane
                  pullRequests={pullRequests}
                  onOpenThread={openThread}
                  bar={paneBar}
                />
              ) : paneTab === "scheduled" ? (
                <ScheduledPane
                  environmentId={project.environmentId}
                  projectId={project.id}
                  projectKey={projectKey}
                  canOperate={canOperate && connected}
                  admissionBlocked={Boolean(
                    snapshot?.settings.paused || snapshot?.settings.archived,
                  )}
                  bar={paneBar}
                />
              ) : (
                <ThreadsPane
                  environmentId={project.environmentId}
                  threads={workers}
                  canChange={canOperate && connected}
                  findRef={findRef}
                  findOpen={findOpen}
                  onFindOpenChange={setFindOpen}
                  query={findQuery}
                  onQueryChange={setFindQuery}
                  onOpen={openThread}
                  onToggleResolved={(thread) => void resolve(thread)}
                  starters={workers.length === 0 ? starterList : null}
                  remoteWorkerCount={remoteWorkerCount}
                  notice={
                    remoteWorkerCount > 0 || archived.error ? (
                      <>
                        {remoteWorkerCount > 0 ? (
                          <RemoteWorkerCards
                            environmentId={project.environmentId}
                            projectId={project.id}
                          />
                        ) : null}
                        {archived.error ? (
                          <p className="project-notice" role="alert">
                            Archived threads could not be loaded.{" "}
                            <button
                              type="button"
                              className="project-control"
                              onClick={archived.refresh}
                            >
                              Retry archived history
                            </button>
                          </p>
                        ) : null}
                      </>
                    ) : null
                  }
                  bar={paneBar}
                />
              )}
            </aside>
          ) : null}
        </div>
        {tab && snapshot && (
          <ProjectWorkspaceSettings
            project={project}
            coordinatorThreadModel={coordinator?.modelSelection ?? null}
            iconCheckouts={iconCheckouts}
            projectKey={projectKey}
            snapshot={snapshot}
            initialTab={tab}
            onClose={() => setTab(null)}
            onSaved={query.refresh}
            onOpenThread={openThread}
            canOperate={canOperate && connected}
            onDeleted={() => {
              setTab(null);
              void navigate({ to: "/" });
            }}
          />
        )}
      </div>
    </SidebarInset>
  );
}

function CoordinatorConversation({
  project,
  coordinatorId,
  workers,
  environmentThreads,
  onOpenThread,
  canChange,
  onCreatePullRequest,
  onOpenPullRequest,
  attention,
  onOpenCoordinatorPage,
  failure,
  progress,
  empty,
}: {
  project: EnvironmentProject;
  coordinatorId: ThreadId;
  workers: readonly EnvironmentThreadShell[];
  /** Every thread of the project's environment, live or deleted, that a link may name. */
  environmentThreads: readonly EnvironmentThreadShell[];
  onOpenThread: (id: ThreadId) => void;
  /** Source control can be changed on this host, and it is connected. */
  canChange: boolean;
  onCreatePullRequest: (thread: EnvironmentThreadShell) => void;
  onOpenPullRequest: (url: string) => void;
  /** What the coordinator waits on the person for; its controls are on its own page. */
  attention: CoordinatorAttention | null;
  /** Opens the coordinator full page, where its approval and answer controls are. */
  onOpenCoordinatorPage: () => void;
  /** The coordinator's latest run failed; the host keeps that on the run, not as a message. */
  failure: CoordinatorTurnFailure | null;
  /** What the coordinator is doing while its turn runs; null when it is idle. */
  progress: CoordinatorProgress | null;
  /** What to say before the first message. */
  empty: React.ReactNode;
}) {
  const ref = useMemo(
    () => scopeThreadRef(project.environmentId, coordinatorId),
    [project.environmentId, coordinatorId],
  );
  const thread = useThreadProjection(ref);
  const history = useThreadHistory(ref);
  const status = useThreadStatus(ref);
  const load = useAtomCommand(threadEnvironment.loadEarlierHistory);
  const end = useRef<HTMLDivElement>(null);
  const messages = thread?.projection.messages ?? [];
  const working = progress !== null && failure === null;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length, failure?.runId, working]);
  // A thread the coordinator started this turn is announced by a card under its message;
  // a thread that already existed is a link. Both open the thread in the right pane.
  const reportIds = useMemo(() => projectReportMessageIds(messages), [messages]);
  const prepared = messages.map((message) => {
    const notice = message.createdBy === "user" ? null : projectSystemNotice(message, workers);
    const display = projectCoordinatorMessageDisplay(message, project, workers);
    const text = prepareProjectMarkdown(notice ?? display.text, workers, environmentThreads);
    return { message, notice, display, text };
  });
  const timelineDetail = useClientSettings((settings) => settings.timelineDetail);
  const turnItems = thread?.projection.turnItems;
  const runs = thread?.projection.runs;
  // Linear in the history, and only rebuilt when it or the level changes.
  const view = useMemo(
    () =>
      coordinatorConversationView({
        messages: messages.map((message) => ({
          ...message,
          notice: message.createdBy !== "user" && projectSystemNotice(message, workers) !== null,
        })),
        turnItems: turnItems ?? [],
        runs: runs ?? [],
        detail: timelineDetail,
      }),
    [messages, workers, turnItems, runs, timelineDetail],
  );
  const messagesById = useMemo(
    () => new Map(messages.map((message) => [message.id as string, message])),
    [messages],
  );
  const newThreads = newThreadsByMessage(
    prepared.map(({ message, notice, text }) => ({
      id: message.id,
      role: notice === null ? message.role : "system",
      linked: notice === null ? linkedThreadIds(text) : [],
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    })),
    workers,
  );
  // Every thread of this project a message names is a chip with its status dot,
  // including one a card below announces, and opens in the right pane.
  const workerChip = (
    target: EnvironmentThreadShell,
    label: string,
    announced: readonly ThreadId[],
  ) => (
    <ProjectThreadChip
      thread={target}
      label={label}
      className={announced.includes(target.id) ? "sws-thread-mention" : undefined}
      onOpen={() => onOpenThread(target.id)}
    />
  );
  const referenceRenderer =
    (announced: readonly ThreadId[]) =>
    (reference: { kind: string; contextId: string; label: string }) => {
      // `workers` holds no coordinator, so a link to it reads as its label.
      const target = workers.find((t) => t.id === reference.contextId);
      if (reference.kind !== "thread" || !target) return <span>{reference.label}</span>;
      return workerChip(target, reference.label, announced);
    };
  // A `studio://thread/` link to another project's thread, or to one that is gone,
  // falls back to the standard chip, which opens it elsewhere or says why it cannot.
  // A link to this coordinator reads as its label: the page already shows it.
  const threadLinkRenderer =
    (announced: readonly ThreadId[]) =>
    (link: { candidates: readonly string[]; label: string }) => {
      if (link.candidates.includes(coordinatorId)) return <span>{link.label}</span>;
      const resolved = resolveStudioThreadLink(
        workers,
        link.candidates,
        link.label,
        null,
        environmentThreads,
      );
      return resolved.kind === "thread" ? workerChip(resolved.shell, link.label, announced) : null;
    };
  return (
    <div
      className="project-conversation"
      aria-label="Coordinator conversation"
      aria-busy={status === "empty" || status === "synchronizing"}
    >
      {history.hasMoreHistory && (
        <button
          className="project-control"
          disabled={history.loading}
          onClick={() =>
            void load({ environmentId: project.environmentId, input: { threadId: coordinatorId } })
          }
        >
          {history.loading ? "Loading…" : "Load earlier messages"}
        </button>
      )}
      {history.error && <p role="alert">{history.error}</p>}
      {!thread && (
        <p className="project-muted" role="status">
          Loading the retained coordinator…
        </p>
      )}
      {thread && messages.length === 0 && !history.hasMoreHistory ? empty : null}
      {prepared.map(({ message, notice, display, text }) => {
        if (view.hiddenMessageIds.has(message.id)) return null;
        // Concise: a reply that shows carries the cards and files of the replies it hides.
        const announced = withFoldedReplies(
          view,
          message.id,
          newThreads.get(message.id) ?? [],
          (id) => newThreads.get(id) ?? [],
        );
        const attachments = withFoldedReplies(
          view,
          message.id,
          message.attachments,
          (id) => messagesById.get(id)?.attachments ?? [],
        );
        const renderReference = referenceRenderer(announced);
        const renderThreadLink = threadLinkRenderer(announced);
        if (notice !== null)
          return (
            <div key={message.id} className="project-notice" role="status">
              <ChatMarkdown
                text={text}
                cwd={project.workspaceRoot}
                threadRef={ref}
                isStreaming={false}
                renderContextReference={renderReference}
                renderThreadLink={renderThreadLink}
              />
            </div>
          );
        const author = projectMessageAuthor(message);
        return (
          <article key={message.id} className={`project-message project-message-${message.role}`}>
            <h3>{author}</h3>
            {author === "Message from a worker" && message.senderThreadId && (
              <MessageThreadLink
                thread={workers.find((t) => t.id === message.senderThreadId)}
                prefix="Sent by"
                fallbackLabel="View sending thread"
                onOpen={() => onOpenThread(message.senderThreadId!)}
              />
            )}
            {display.sourceThread && (
              <MessageThreadLink
                thread={workers.find((t) => t.id === display.sourceThread!.id)}
                prefix="From"
                fallbackLabel={`From ${display.sourceThread.title}`}
                fallbackAriaLabel={`Open source thread ${display.sourceThread.title}`}
                onOpen={() => onOpenThread(display.sourceThread!.id)}
              />
            )}
            {author === "Message from a worker" &&
            reportIds.has(message.id) &&
            !message.streaming &&
            shouldCollapseReport(text) ? (
              <ReportArtifact
                source={
                  message.senderThreadId
                    ? {
                        environmentId: project.environmentId,
                        projectId: project.id,
                        threadId: message.senderThreadId,
                      }
                    : null
                }
                text={text}
                fallbackTitle={
                  workers.find((t) => t.id === message.senderThreadId)?.title ?? "Worker report"
                }
              >
                <ChatMarkdown
                  text={text}
                  cwd={project.workspaceRoot}
                  threadRef={ref}
                  isStreaming={false}
                  renderContextReference={renderReference}
                  renderThreadLink={renderThreadLink}
                />
              </ReportArtifact>
            ) : (
              <CollapsibleReport
                text={text}
                streaming={message.streaming}
                enabled={reportIds.has(message.id)}
                expandLabel="Show full message"
              >
                <ChatMarkdown
                  text={text}
                  cwd={project.workspaceRoot}
                  threadRef={ref}
                  isStreaming={message.streaming}
                  renderContextReference={renderReference}
                  renderThreadLink={renderThreadLink}
                />
              </CollapsibleReport>
            )}
            {announced.length > 0 ? (
              <ul className="sws-thread-cards" aria-label="Threads started">
                {announced.map((id) => {
                  const thread = workers.find((t) => t.id === id)!;
                  return (
                    <li key={id}>
                      <ProjectThreadCard
                        thread={thread}
                        projectRoot={project.workspaceRoot}
                        canChange={canChange}
                        onOpen={() => onOpenThread(id)}
                        onCreatePullRequest={() => onCreatePullRequest(thread)}
                        onOpenPullRequest={onOpenPullRequest}
                      />
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <ProjectWorkspaceAttachments
              environmentId={project.environmentId}
              attachments={attachments}
            />
            {view.activityByMessageId.has(message.id) ? (
              <CoordinatorRunActivity
                activity={view.activityByMessageId.get(message.id)!}
                onOpenCoordinatorPage={onOpenCoordinatorPage}
              />
            ) : null}
          </article>
        );
      })}
      <RemoteWorkerCards environmentId={project.environmentId} projectId={project.id} />
      {view.liveActivity && working ? (
        <CoordinatorRunActivity
          live
          activity={view.liveActivity}
          onOpenCoordinatorPage={onOpenCoordinatorPage}
        />
      ) : null}
      {working && <CoordinatorWorking progress={progress} />}
      {attention && attention.reason !== "failed" && (
        <div className="project-notice" role="status" data-coordinator-attention={attention.reason}>
          <p>
            <strong>{attention.message}</strong>
          </p>
          <button type="button" className="project-control" onClick={onOpenCoordinatorPage}>
            {attention.action}
          </button>
        </div>
      )}
      {failure && (
        <div className="project-notice" role="alert" data-coordinator-failure="">
          <p>
            <strong>The coordinator did not answer.</strong> {failure.message}
          </p>
          {/* Its own page, not the panel: the coordinator is this page's main conversation. */}
          <button type="button" className="project-control" onClick={onOpenCoordinatorPage}>
            Open the coordinator thread
          </button>
        </div>
      )}
      <div ref={end} data-coordinator-end="" />
    </div>
  );
}

/**
 * The thread a message came from, above the message: a chip with its status dot
 * when it is one of the project's threads, else the plain link it always was
 * (the coordinator is not one of `workers`, and opens as the main conversation).
 */
function MessageThreadLink({
  thread,
  prefix,
  fallbackLabel,
  fallbackAriaLabel,
  onOpen,
}: {
  thread: EnvironmentThreadShell | undefined;
  prefix: string;
  fallbackLabel: string;
  fallbackAriaLabel?: string;
  onOpen: () => void;
}) {
  if (thread)
    return (
      <span className="project-message-source">
        {prefix}{" "}
        <ProjectThreadChip
          thread={thread}
          label={thread.title.trim() || "Untitled thread"}
          onOpen={onOpen}
        />
      </span>
    );
  return (
    <button
      type="button"
      className="project-control project-text-link"
      aria-label={fallbackAriaLabel}
      onClick={onOpen}
    >
      {fallbackLabel}
    </button>
  );
}

/** The coordinator's live line: what it is doing and for how long, counting every second. */
function CoordinatorWorking({ progress }: { progress: CoordinatorProgress }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="sws-coordinator-working" role="status" aria-live="polite">
      <span className="sws-dot" data-tone={progress.waiting ? "waiting" : "working"} aria-hidden />
      <span className="sws-coordinator-working-label">{progress.label}…</span>
      {progress.since === null ? null : (
        <span className="sws-coordinator-working-time" aria-hidden>
          {formatProgressElapsed(progress.since, now)}
        </span>
      )}
    </div>
  );
}

/**
 * The machine this coordinator runs on. Its server starts the coordinator and
 * workers with that machine's providers and sign-ins, so with the project on
 * more than one machine the name opens a choice that is saved for the project.
 */
function CoordinatorMachine({
  label,
  connected,
  current,
  checkouts,
  savedMachineMissing,
  onChoose,
}: {
  label: string;
  connected: boolean;
  current: string;
  checkouts: ReadonlyArray<{ key: string; machine: string; folder: string }>;
  savedMachineMissing: boolean;
  onChoose: ((key: string) => void) | null;
}) {
  const status = (
    <>
      <span className="sws-dot" data-tone={connected ? "resolved" : "failed"} aria-hidden />
      <span className="sws-host-name">{label}</span>
      <span className="sr-only">{connected ? ", connected" : ", disconnected"}</span>
      {connected ? null : <span aria-hidden> · Disconnected</span>}
      {savedMachineMissing ? <span aria-hidden> · Saved machine offline</span> : null}
    </>
  );
  if (checkouts.length < 2 || !onChoose)
    return <span className="project-muted sws-host">{status}</span>;
  // Two checkouts on one machine need their folders to tell them apart.
  const machines = checkouts.map((checkout) => checkout.machine);
  const ambiguous = (machine: string) =>
    machines.indexOf(machine) !== machines.lastIndexOf(machine);
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  className="project-muted sws-host sws-host-pick"
                  aria-label={`Coordinator runs on ${label}. Choose the machine`}
                />
              }
            />
          }
        >
          {status}
          <ChevronDownIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="top">
          {savedMachineMissing
            ? "The saved machine is not connected, so this is another machine's coordinator"
            : "Choose which machine runs this project's coordinator"}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="top" className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>Coordinator machine</MenuGroupLabel>
          <MenuRadioGroup value={current} onValueChange={(value) => onChoose(value as string)}>
            {checkouts.map((checkout) => (
              <MenuRadioItem key={checkout.key} value={checkout.key}>
                <span className="flex items-center justify-between gap-6">
                  {ambiguous(checkout.machine)
                    ? `${checkout.machine} · ${checkout.folder}`
                    : checkout.machine}
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
