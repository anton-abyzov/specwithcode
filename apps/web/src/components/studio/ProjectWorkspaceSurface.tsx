import { ThreadArtifactsMenu } from "../chat/ThreadArtifacts";
import { CoordinatorComposerControls } from "./CoordinatorAccessPicker";
import { useProjectThreadInventory } from "../../studio/useProjectThreadInventory";
import { ProjectExecutionHistory, ProjectThreadAvailability } from "./ProjectExecutionHistory";
import { ProjectHandoffRecovery } from "./ProjectHandoffRecovery";
import { toggleProjectThreadResolution } from "../../studio/projectThreadResolution";
import { ProjectWorkspaceColumns } from "./ProjectWorkspaceColumns";
import { createCoordinatorSelectionTracker } from "../../studio/coordinatorContinuation";
import { useCoordinatorModelSave } from "../../studio/coordinatorModelSave";
import { useProjectCoordinatorDraft } from "../../studio/projectCoordinatorDraft";
import { getProjectCoordinatorComposer } from "../../studio/projectCoordinatorComposer";
import { settleAfter, settleCaught } from "../../lib/settle";
import { CoordinatorComposer } from "./CoordinatorComposer";
import { useDurableCoordinatorDraft, whenHostReady } from "../../lib/durableComposerDraftBindings";
import { retryTransientSend } from "../../lib/transientSendRetry";
import { ProjectCoordinatorDetails } from "./ProjectCoordinatorDetails";
import { ProjectMachineHandoff } from "./ProjectMachineHandoff";
import { ProjectPlan } from "./ProjectPlan";
import { TimelineDetailMenu } from "../chat/TimelineDetailMenu";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import {
  AppWindowIcon,
  EllipsisVerticalIcon,
  GaugeIcon,
  LaptopIcon,
  ListChecksIcon,
  PanelRightIcon,
  RepeatIcon,
  SettingsIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  CommandId,
  logicalProjectTitle,
  type ChatAttachment,
  type ProjectStarterSuggestion,
  type ThreadId,
  PERSONAL_ASSISTANT_DESCRIPTION,
  PERSONAL_ASSISTANT_LABEL,
} from "@specweave-studio/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@specweave-studio/client-runtime/state/shell";
import { scopedThreadKey, scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { resolveCoordinatorModelSelection } from "@specweave-studio/shared/coordinatorDefault";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import {
  coordinatorFallbackReason,
  coordinatorOnLimitFallback,
} from "@specweave-studio/shared/providerFallback";
import { formatDuration } from "@specweave-studio/shared/usageLimits";
import { useAllEnvironmentShellsBootstrapped, useThreadProjection } from "../../state/entities";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment } from "../../state/threads";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { isContextMenuOpen } from "../../contextMenuFallback";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { usePhoneKeyboard } from "../../hooks/usePhoneKeyboard";
import { useClientSettings } from "../../hooks/useSettings";
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
  hostDisconnectedLabel,
  projectAdmissionReason,
} from "../../studio/projectWorkspaceModel";
import {
  modelLabel,
  shortMachineName,
  THREAD_TONE_LABELS,
  threadTone,
  waitingCount,
} from "../../studio/shellModel";
import {
  PULL_REQUEST_REQUEST_EXPIRED_REASON,
  PULL_REQUEST_REQUEST_TTL_MS,
  expireThreadPullRequest,
  requestThreadPullRequest,
  showThreadDetailsPanel,
} from "../../studio/threadPullRequestRequests";
import { coordinatorAttention } from "../../studio/projectCoordinatorThreads";
import { toastManager } from "../ui/toast";
import { RemoteWorkerCards } from "./RemoteWorkerCards";
import { useProjectRemoteWorkers } from "../../studio/fleet";
import { visibleRemoteWorkers } from "../../studio/remoteWorkerCards";
import { coordinatorTurnFailure, sentStarterIds } from "../../studio/coordinatorTurnState";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SidebarInset } from "../ui/sidebar";
import { Button } from "../ui/button";
import { isElectron } from "../../env";
import { canOpenProjectWindowFor, openProjectWindow } from "../../lib/projectWindow";
import { ProjectWorkspaceSettings, type ProjectSettingsTab } from "./ProjectWorkspaceSettings";
import { isProjectSettingsTab } from "./projectSettingsSearch.logic";
import { useProjectSettingsRequest } from "../../studio/projectSettingsRequests";
import { fileAttachmentStagingLimit } from "../chat/composerAttachmentFiles";
import { coordinatorRetryMessage, coordinatorRetryFingerprint } from "./coordinatorRecovery";
import {
  useProjectCoordinatorRecovery,
  useProjectCoordinatorModelControls,
} from "./useProjectCoordinatorRecovery";
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
import { bulkThreadTargets } from "../../studio/bulkThreadControl";
import { useBulkThreadControl } from "../../studio/useBulkThreadControl";
import { useComposerAppCommands } from "../../studio/useComposerAppCommands";
import { LibraryPane } from "./shell/LibraryPane";
import { PullRequestsPane } from "./shell/PullRequestsPane";
import { ScheduledPane } from "./shell/ScheduledPane";
import type { ProjectPaneBarProps } from "./shell/ProjectPaneBar";
import {
  collectProjectPullRequests,
  openPullRequestCount,
  PROJECT_PANE_TABS,
  type ProjectPaneTab,
} from "../../studio/projectPaneModel";
import { runningSubagentCount } from "../../studio/threadSubagents";
import { useThreadSubagents } from "./shell/SubagentsChip";
import { useOpenLink } from "../../browser/useOpenLink";
import { ProjectWorkerPane } from "./ProjectWorkerPane";
import { coordinatorProgress } from "../../studio/coordinatorProgress";
import { Tip } from "./shell/Tip";
import { useCoordinatorVoiceAsk, useVoiceCall, VoiceCallBar, VoiceCallButton } from "./VoiceCall";
import { ProjectIconButton } from "./ProjectIconEditor";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { randomUUID } from "../../lib/utils";

import { CoordinatorConversation, CoordinatorMachine } from "./CoordinatorConversation";
import { useUnreachableHosts } from "../../studio/unreachableHosts";
import { isThisMachineTarget } from "../../connection/desktopLocal";
import {
  environmentWaitsForReconnectGrace,
  scheduleEnvironmentReconnectWarning,
} from "../ChatView.logic";
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
function missingModelMessage(modelsLoading: boolean): string {
  return modelsLoading
    ? "Models are still loading from this host. Try again in a moment."
    : "Choose and save a coordinator or worker model in project settings first.";
}

export function ProjectWorkspaceSurface({
  project,
  projectKey,
  iconCheckouts,
  checkouts,
  savedMachineMissing,
  onCheckout,
  selected,
  selectedEnvironmentId = null,
  ownershipProblem = null,
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
  selectedEnvironmentId?: string | null;
  ownershipProblem?: string | null;
  setSelected: SelectProjectThread;
}) {
  const projectTitle = logicalProjectTitle(project);
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
  const refreshWorkspace = query.refresh;
  const coordinatorId = snapshot?.settings.coordinatorThreadId ?? null;
  // The project shell names the coordinator before the workspace read answers; the
  // panel needs it at once, so a link to the coordinator never lands there.
  const mainCoordinatorId = coordinatorId ?? project.workspaceSettings?.coordinatorThreadId ?? null;
  // Until the read answers, the conversation opens from the project shell's
  // coordinator, so switching to a project paints its history without a wait.
  const conversationCoordinatorId = snapshot ? coordinatorId : mainCoordinatorId;
  // Every host's threads are read only while one is open in the panel, which may
  // be a subagent or fork of another project's thread; otherwise an update to
  // another project's thread renders nothing here.
  const { executionScopes, archived, shells, workers, linkTargets } = useProjectThreadInventory(
    project,
    iconCheckouts,
    mainCoordinatorId,
    selected !== null,
  );
  const remoteWorkerCount = visibleRemoteWorkers(
    useProjectRemoteWorkers(project.environmentId, project.id).workers,
  ).length;
  const paneScope = useMemo(
    () => ({
      environmentId: project.environmentId,
      projectId: project.id,
      coordinatorThreadId: mainCoordinatorId,
      ...(project.workspaceSettings?.logicalProject ? { members: executionScopes } : {}),
    }),
    [
      project.environmentId,
      project.id,
      project.workspaceSettings?.logicalProject,
      mainCoordinatorId,
      executionScopes,
    ],
  );
  const [tab, setTab] = useState<ProjectSettingsTab | null>(null);
  const [focusName, setFocusName] = useState(false);
  const [settingsRow, setSettingsRow] = useState<string | null>(null);
  useProjectSettingsRequest(
    projectKey,
    useCallback((target) => {
      // A search result opens its tab and row; a bare request (double-click) renames.
      if (target && isProjectSettingsTab(target.tab)) {
        setFocusName(false);
        setSettingsRow(target.row ?? null);
        setTab(target.tab);
        return;
      }
      setFocusName(true);
      setTab("general");
    }, []),
  );
  const [planOpen, setPlanOpen] = useState(false);
  const [coordinatorDetailsOpen, setCoordinatorDetailsOpen] = useState(false);
  const [machineHandoffOpen, setMachineHandoffOpen] = useState(false);
  const [handoffTarget, setHandoffTarget] = useState<string | null>(null);
  const handoffOpenChange = useCallback((open: boolean) => {
    setMachineHandoffOpen(open);
    if (!open) setHandoffTarget(null);
  }, []);
  const [retryingCoordinator, setRetryingCoordinator] = useState(false);
  const [coordinatorActivityRunId, setCoordinatorActivityRunId] = useState<string | null>(null);
  const [coordinatorReviewView, setCoordinatorReviewView] = useState<"requests" | "activity">(
    "requests",
  );
  // The draft lives in a store the composer subscribes to. This page reads it only
  // when it acts on it, so typing renders the composer and nothing else.
  const composer = getProjectCoordinatorComposer(project.environmentId, project.id);
  const setPrompt = composer.setPrompt;
  // Unsent text and attachments survive a crash and follow the user between windows.
  useDurableCoordinatorDraft(project.environmentId, project.id, composer);
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
  useProjectCoordinatorDraft(
    project.environmentId,
    project.id,
    useCallback(
      (text: string) => {
        setPrompt((current) => (current.trim() ? `${current}\n\n${text}` : text));
        setTab(null);
        setFocusName(false);
        setPlanOpen(false);
        setCoordinatorDetailsOpen(false);
        setPaneExpanded(false);
        showCoordinator();
      },
      [showCoordinator, setPrompt],
    ),
  );
  // The subagent whose transcript peeks over the open thread; it is not a thread itself.
  const [subagentPeek, setSubagentPeek] = useState<{
    readonly hostId: ThreadId;
    readonly subagentId: ThreadId;
  } | null>(null);
  const peekSubagent = useCallback(
    (hostId: ThreadId, subagentId: ThreadId) => setSubagentPeek({ hostId, subagentId }),
    [],
  );
  const { selectedThread, openThreadInPane, openThread } = useProjectPaneSelection({
    shells,
    scope: paneScope,
    selected,
    selectedEnvironmentId,
    setSelected,
    setOverviewOpen,
    lastOpened,
    threadsLoaded,
    onShowCoordinator: showCoordinator,
    onPeekSubagent: peekSubagent,
  });
  const openCoordinator = useCallback(() => {
    setCoordinatorDetailsOpen(false);
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
  // This machine reads as busy, never offline: a short blip shows neutral
  // text and only a stall past the grace says more. The grace runs in the same
  // phases as the chat banner's, so the two surfaces agree. Remote hosts keep
  // today's text and never wait on it.
  const hostPhase = environment?.connection.phase;
  const hostIsThisDevice = isThisMachineTarget(environment?.entry);
  const waitingEnvironmentId =
    hostIsThisDevice &&
    hostPhase !== undefined &&
    environmentWaitsForReconnectGrace(hostPhase, hostIsThisDevice)
      ? project.environmentId
      : null;
  const [graceElapsedEnvironmentId, setGraceElapsedEnvironmentId] = useState<string | null>(null);
  useEffect(() => {
    setGraceElapsedEnvironmentId(null);
    if (waitingEnvironmentId === null) return;
    return scheduleEnvironmentReconnectWarning(() =>
      setGraceElapsedEnvironmentId(waitingEnvironmentId),
    );
  }, [waitingEnvironmentId]);
  const hostAdmission = {
    isThisDevice: hostIsThisDevice,
    graceElapsed:
      waitingEnvironmentId === null || graceElapsedEnvironmentId === waitingEnvironmentId,
  };
  const blocked =
    ownershipProblem ??
    projectAdmissionReason(
      snapshot?.settings ?? null,
      connected,
      canOperate,
      environment?.connection,
      hostAdmission,
    );
  // Memoized, not just computed: these feed memoized callbacks below, and the
  // React Compiler keeps those only for values it knows are not changed later.
  const coordinator = useMemo(
    () => shells.find((t) => t.id === coordinatorId && t.environmentId === project.environmentId),
    [shells, coordinatorId, project.environmentId],
  );
  // An accepted message is not an answer: its run can still fail on the host.
  const coordinatorFailure = useMemo(() => coordinatorTurnFailure(coordinator), [coordinator]);
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
  const savedModel =
    liveSettings?.coordinatorModelSelection ?? snapshot?.settings.coordinatorModelSelection;
  const coordinatorThreadModel = coordinator?.modelSelection;
  const model = useMemo(
    () =>
      resolveCoordinatorModelSelection({
        saved: savedModel,
        coordinatorThreadModel,
        projectDefault: project.defaultModelSelection,
        scopedDefault: hostSettings
          ? resolveProjectSettings(hostSettings, project.id, project).settings.defaultModelSelection
          : null,
        providers: hostProviders,
      }),
    [savedModel, coordinatorThreadModel, project, hostSettings, hostProviders],
  );
  const actions = useThreadActions();
  const providerEntries = useProviderEntries(project.environmentId);
  // The limit rule moved the coordinator off its saved model; it returns once that has room.
  const savedCoordinatorModel = liveSettings?.coordinatorModelSelection ?? null;
  // Only a saved provider that really has no room is a limit: a coordinator a
  // scheduled run moved, or one whose limit has reset, goes back to the saved
  // model with the next message, so the line must not claim a limit then.
  const fallbackInput =
    coordinator && savedCoordinatorModel && hostProviders && hostSettings
      ? {
          saved: savedCoordinatorModel,
          thread: coordinator.modelSelection,
          providers: hostProviders,
          rule: resolveProjectSettings(hostSettings, project.id, project).settings,
          nowMs: Date.now(),
          // Only a run that stopped on a real usage limit marks its provider limited.
          limitedInstanceIds: new Set<string>(
            coordinator.limitRecovery ? [coordinator.providerInstanceId] : [],
          ),
        }
      : null;
  const fallbackReason =
    fallbackInput && coordinatorOnLimitFallback(fallbackInput)
      ? coordinatorFallbackReason(fallbackInput)
      : null;
  const coordinatorFallback =
    coordinator && savedCoordinatorModel && fallbackReason
      ? {
          reason:
            fallbackReason.resetsAt === null || fallbackReason.resetsAt <= Date.now()
              ? fallbackReason.text
              : `${fallbackReason.text}, resets in ${formatDuration(fallbackReason.resetsAt - Date.now())}`,
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
      : null;
  // "Switch back" puts the coordinator on its saved model; the host still moves it
  // again on the next turn if that model's limit has not reset.
  const setCoordinatorModel = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [switchingBack, setSwitchingBack] = useState(false);
  const switchCoordinatorBack = async () => {
    if (!coordinator || !savedCoordinatorModel || switchingBack) return;
    setSwitchingBack(true);
    setError(null);
    await settleAfter(
      async () => {
        const result = await setCoordinatorModel({
          environmentId: project.environmentId,
          input: { threadId: coordinator.id, modelSelection: savedCoordinatorModel },
        });
        if (result._tag === "Failure")
          setError(
            `Could not switch back to ${coordinatorFallback?.saved.full ?? "the saved model"}.`,
          );
      },
      () => setSwitchingBack(false),
    );
  };
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const revision = liveSettings?.revision ?? snapshot?.settings.revision ?? null;
  const refreshSnapshot = query.refresh;
  const [continuationSelection] = useState(createCoordinatorSelectionTracker);
  continuationSelection.observe(model ?? null, revision);
  const {
    save: saveCoordinatorModel,
    saving: savingModel,
    runAfterSave,
  } = useCoordinatorModelSave({
    persist: async (selection) => {
      const expectedRevision = continuationSelection.revision();
      if (expectedRevision === null)
        throw new Error("Project settings are still loading. Try again.");
      const result = await updateProject({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          workspaceSettings: { expectedRevision, coordinatorModelSelection: selection },
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      continuationSelection.observe(selection, expectedRevision + 1);
    },
    onError: setError,
    onSaved: () => setNotice("Coordinator model saved for this project."),
    onSettled: refreshSnapshot,
  });
  const { compatibility: modelCompatibility, controls: coordinatorModelControls } =
    useProjectCoordinatorModelControls({
      project,
      environmentSettings: hostSettings,
      folderSettings: liveSettings?.environment ?? snapshot?.settings.environment,
      coordinator,
      providers: hostProviders,
      model,
      canOperate,
      connected,
      revision,
      loading: query.isPending && !snapshot,
      saving: savingModel,
      retrying: retryingCoordinator,
      onChange: (selection) => void saveCoordinatorModel(selection),
      onOpenSettings: () => setTab("general"),
    });
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
  const toggleOverview = useCallback(() => {
    if (threadOpen || overviewOpen) hideOverview();
    else setOverviewOpen(true);
  }, [hideOverview, overviewOpen, threadOpen, setOverviewOpen]);
  useEffect(() => {
    if (coordinatorDetailsOpen) return;
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
    coordinatorDetailsOpen,
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
      onConfirmed?: () => void,
      retryIdentity?: readonly [string | null, string],
    ) => {
      const ownsRetryFlight = retryIdentity !== undefined;
      if (inFlight.current && !ownsRetryFlight)
        throw new Error("Another project message is being confirmed. Your draft is preserved.");
      if (blocked) throw new Error(blocked);
      if (modelCompatibility) throw new Error(modelCompatibility);
      if (!model && !coordinatorId) throw new Error(missingModelMessage(modelsLoading));
      inFlight.current = true;
      setSending(true);
      setError(null);
      setNotice(null);
      const keyParts = [project.id, text, sourceThreadId ?? null, attachments ?? []];
      await settleAfter(
        async () => {
          const commandId = receipt.forPrompt(
            coordinatorRetryFingerprint(JSON.stringify(keyParts), retryIdentity),
            () => randomUUID(),
            ownsRetryFlight,
          );
          // A host restarting for an update gets the same command again once it is back.
          const result = await runAfterSave(() =>
            retryTransientSend(
              () =>
                sendCommand({
                  environmentId: project.environmentId,
                  input: {
                    projectId: project.id,
                    commandId: CommandId.make(commandId),
                    prompt: text,
                    ...(attachments?.length ? { attachments } : {}),
                    ...(sourceThreadId ? { sourceThreadId } : {}),
                  },
                }),
              { waitForHost: () => whenHostReady(project.environmentId, { cancelled: false }) },
            ),
          );
          if (result._tag === "Failure") {
            const e = squashAtomCommandFailure(result);
            throw e instanceof Error
              ? e
              : new Error("Delivery was not confirmed. Retry preserves the same request identity.");
          }
          onConfirmed?.();
          receipt.acknowledge(commandId);
          refreshWorkspace();
          setNotice(sourceThreadId ? SENT_WITH_CONTEXT_NOTICE : QUEUED_NOTICE);
        },
        () => {
          if (!ownsRetryFlight) inFlight.current = false;
          setSending(false);
        },
      );
    },
    [
      blocked,
      modelCompatibility,
      model,
      modelsLoading,
      coordinatorId,
      receipt,
      project.environmentId,
      project.id,
      sendCommand,
      runAfterSave,
      refreshWorkspace,
    ],
  );
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
  // Uploads can take a while; one send owns the composer from the first keypress to the answer.
  const preparing = useSyncExternalStore(
    composer.subscribe,
    () => composer.getSnapshot().submitting,
    () => composer.getSnapshot().submitting,
  );
  const sendFromComposer = useCallback(
    (text: string, attachments: ReadonlyArray<ChatAttachment> | undefined) =>
      routingSend(text, undefined, attachments),
    [routingSend],
  );
  const retryMessage = coordinatorRetryMessage(coordinatorThread?.projection.messages ?? []);
  const retryCoordinator = useProjectCoordinatorRecovery({
    message: retryMessage,
    projectId: project.id,
    failureRunId: coordinatorFailure?.runId ?? null,
    coordinatorId,
    environmentId: project.environmentId,
    uploadsSupported,
    canRetry: !sending && !preparing && !savingModel && !blocked && !modelCompatibility,
    nativeBusy: coordinatorWorking,
    flight: inFlight,
    composer,
    revision: () => continuationSelection.revision(),
    send: routingSend,
    reportError: setError,
    setRetrying: setRetryingCoordinator,
  });
  async function resolve(thread: EnvironmentThreadShell) {
    const result = await toggleProjectThreadResolution(thread, actions, archived.refresh);
    if (result?._tag === "Failure") {
      const e = squashAtomCommandFailure(result);
      setError(e instanceof Error ? e.message : "Thread status could not be changed.");
    }
    return result;
  }
  // Resolving the open thread closes it and shows every thread; Reopen keeps it open.
  async function resolveOpenThread(thread: EnvironmentThreadShell) {
    const resolving = thread.archivedAt === null && thread.settledOverride !== "settled";
    const result = await resolve(thread);
    if (!resolving || result?._tag === "Failure") return;
    setFindQuery("");
    setPaneTab("threads");
    leaveThread();
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
  // Stop and continue every worker at once, from the Threads pane or the composer's `/` commands.
  const bulk = useBulkThreadControl();
  const bulkTargets = useMemo(() => bulkThreadTargets(workers), [workers]);
  const projectThreads = useMemo(
    () => (coordinator ? [...workers, coordinator] : workers),
    [workers, coordinator],
  );
  const readProjectThreads = useCallback(() => projectThreads, [projectThreads]);
  const runAppCommand = useComposerAppCommands({
    thread: coordinator ?? null,
    projectThreads: readProjectThreads,
  });
  const appCommandsOffered = canOperate && connected;
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
    if (startingSuggestion !== null || composer.getSnapshot().submitting) return;
    setStartingSuggestion(suggestion.id);
    setError(null);
    const failureAtSend = coordinatorFailure?.runId ?? null;
    await settleCaught(
      async () => {
        await routingSend(suggestion.prompt);
        setStartedSuggestions((current) => new Map(current).set(suggestion.id, failureAtSend));
        // A phone shows one pane at a time; the coordinator's answer is in the other one.
        if (phone) setOverviewOpen(false);
      },
      (e) => setError(e instanceof Error ? e.message : "The suggestion was not sent."),
      () => setStartingSuggestion(null),
    );
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
  const unreachableHosts = useUnreachableHosts();
  const coordinatorTone = coordinator ? threadTone(coordinator) : null;
  // Native review controls stay with the coordinator, in this project's main pane.
  const attention = coordinatorAttention(coordinator ?? null);
  const openCoordinatorPage = useCallback(() => {
    if (!coordinatorId) return;
    setCoordinatorReviewView("requests");
    setCoordinatorDetailsOpen(true);
    if (phone) setOverviewOpen(false);
  }, [coordinatorId, phone, setOverviewOpen]);
  const openCoordinatorActivity = useCallback(
    (runId: string) => {
      if (!coordinatorId) return;
      setCoordinatorActivityRunId(runId);
      setCoordinatorReviewView("activity");
      setCoordinatorDetailsOpen(true);
    },
    [coordinatorId],
  );

  const waiting = waitingCount(workers, unreachableHosts);
  const openLink = useOpenLink(null);
  const pullRequests = collectProjectPullRequests(
    coordinator ? [coordinator, ...workers] : workers,
  );
  const openPullRequests = openPullRequestCount(pullRequests);
  const coordinatorIds = useMemo(() => {
    const ids = new Set<string>();
    if (paneScope.coordinatorThreadId) ids.add(paneScope.coordinatorThreadId);
    for (const member of paneScope.members ?? [])
      if (member.coordinatorThreadId) ids.add(member.coordinatorThreadId);
    return ids;
  }, [paneScope]);
  const subagents = useThreadSubagents({ thread: selectedThread, shells, coordinatorIds });
  const peekedSubagent =
    selectedThread !== null && subagentPeek?.hostId === selectedThread.id
      ? (shells.find(
          (shell) =>
            shell.environmentId === selectedThread.environmentId &&
            shell.id === subagentPeek.subagentId,
        ) ?? null)
      : null;
  const closeSubagentPeek = useCallback(() => setSubagentPeek(null), []);
  // Working subagents keep their thread's row busy: "Working · 2 subagents".
  const runningSubagents = useMemo(() => {
    const counts = new Map<string, number>();
    for (const worker of workers) {
      const running = runningSubagentCount(shells, worker, coordinatorIds);
      if (running > 0) counts.set(`${worker.environmentId}:${worker.id}`, running);
    }
    return counts;
  }, [coordinatorIds, shells, workers]);
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
          : `Excited to get started on ${projectTitle}. Here are a few ways to begin.`}
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
        <ProjectWorkspaceColumns
          open={paneOpen}
          expanded={paneExpanded}
          phone={phone}
          workerOpen={!!selectedThread}
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
                      ? `${projectTitle} · ${PERSONAL_ASSISTANT_LABEL}`
                      : project.workspaceRoot
                  }
                >
                  <h1>{projectTitle}</h1>
                </Tip>
                {primaryEnvironmentId !== null && project.environmentId !== primaryEnvironmentId ? (
                  // Another machine runs this project: its coordinator, workers and sign-ins.
                  <Tip
                    label={`Runs on ${environment?.label ?? "another machine"}, not this computer`}
                  >
                    <span className="sws-tag sws-project-machine" data-project-machine>
                      <LaptopIcon aria-hidden />
                      <span className="sr-only">Runs on </span>
                      {shortMachineName(environment?.label ?? project.environmentId)}
                    </span>
                  </Tip>
                ) : null}
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
                <ThreadArtifactsMenu threadRef={coordinatorRef} cwd={project.workspaceRoot} />
                <TimelineDetailMenu
                  appearance="project"
                  threadKey={coordinatorRef ? scopedThreadKey(coordinatorRef) : null}
                />
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
                        onClick={() => void openProjectWindow({ projectKey, title: projectTitle })}
                      >
                        <AppWindowIcon aria-hidden />
                        Open in new window
                      </MenuItem>
                    ) : null}
                  </MenuPopup>
                </Menu>
              </div>
            </WorkspacePageHeader>
            {coordinatorDetailsOpen && coordinatorId ? (
              <ProjectCoordinatorDetails
                environmentId={project.environmentId}
                threadId={coordinatorId}
                error={error}
                view={coordinatorReviewView}
                runId={coordinatorReviewView === "activity" ? coordinatorActivityRunId : null}
                routing={{
                  coordinatorModelControls,
                  saveCoordinatorModel,
                  continueCoordinator: (operation) =>
                    runAfterSave(() => operation(continuationSelection.selection())),
                  coordinatorThreadId: coordinatorId,
                  send: (text, attachments) => routingSend(text, undefined, attachments),
                  openCoordinator,
                  openThread: openThreadInPane,
                }}
                onClose={() => setCoordinatorDetailsOpen(false)}
              />
            ) : null}
            <div className="contents">
              <h2 className="sr-only">Coordinator</h2>
              {query.error && (
                <p className="project-notice sws-pane-notice" role="alert">
                  {query.error}{" "}
                  <Button variant="outline" size="xs" onClick={query.refresh}>
                    Retry
                  </Button>
                </p>
              )}
              <ProjectHandoffRecovery scopes={executionScopes} members={iconCheckouts} />
              <ProjectExecutionHistory
                project={project}
                members={iconCheckouts}
                scopes={executionScopes}
              />
              {conversationCoordinatorId ? (
                <CoordinatorConversation
                  project={project}
                  coordinatorId={conversationCoordinatorId}
                  workers={workers.filter(
                    (thread) => thread.environmentId === project.environmentId,
                  )}
                  environmentThreads={linkTargets}
                  onOpenThread={openThread}
                  canChange={canWriteSourceControl && connected}
                  onCreatePullRequest={createPullRequest}
                  onOpenPullRequest={(url) => void openLink(url).catch(() => undefined)}
                  attention={attention}
                  onOpenCoordinatorPage={openCoordinatorPage}
                  onOpenCoordinatorActivity={openCoordinatorActivity}
                  failure={coordinatorFailure}
                  onRetry={retryCoordinator}
                  retrying={retryingCoordinator}
                  retryDisabled={
                    Boolean(blocked) ||
                    Boolean(modelCompatibility) ||
                    sending ||
                    preparing ||
                    savingModel ||
                    retryMessage === null
                  }
                  progress={coordinatorWork}
                  // The greeting waits for the read: it may yet name another coordinator.
                  empty={snapshot ? welcome : null}
                />
              ) : snapshot != null && !mainCoordinatorId ? (
                // Only a project known to have no coordinator yet is greeted: while the
                // workspace read is pending, a coordinator with history may be behind it.
                welcome
              ) : null}
              <CoordinatorComposer
                composer={composer}
                // A viewer showing the coordinator borrows this composer.
                threadRef={coordinatorRef}
                environmentId={project.environmentId}
                cwd={project.workspaceRoot}
                sendBlocked={
                  Boolean(blocked) ||
                  Boolean(modelCompatibility) ||
                  (!model && !coordinatorId) ||
                  savingModel ||
                  sending
                }
                missingModel={
                  !blocked && !model && !coordinatorId ? missingModelMessage(modelsLoading) : null
                }
                canAttach={canOperate && connected}
                uploadsSupported={uploadsSupported}
                maxFileBytes={maxFileBytes}
                sending={sending}
                placeholder={promptPlaceholder}
                keybindings={keybindings}
                isPhoneKeyboard={isPhoneKeyboard}
                sendShortcut={sendShortcut}
                onAppCommand={appCommandsOffered ? runAppCommand : null}
                provider={model ? (providerEntries.get(model.instanceId) ?? null) : null}
                onSend={sendFromComposer}
                onError={setError}
                status={
                  <>
                    {blocked && (
                      <p className="project-muted" role="status">
                        {blocked}
                      </p>
                    )}
                    {error && <p role="alert">{error}</p>}
                  </>
                }
                notices={
                  <>
                    {/* A "Queued" notice must not stand beside a turn that failed. */}
                    {notice &&
                      !coordinatorFailure &&
                      !(coordinatorWorking && SEND_NOTICES.has(notice)) && (
                        <p className="project-muted" role="status">
                          {notice}
                        </p>
                      )}
                    <VoiceCallBar call={voiceCall} />
                  </>
                }
                meta={
                  <>
                    <VoiceCallButton
                      call={voiceCall}
                      disabled={Boolean(blocked) || (!model && !coordinatorId)}
                    />
                    {coordinator && coordinatorTone ? (
                      <Tip
                        label={
                          attention && attention.reason !== "failed"
                            ? `${attention.message} Review here`
                            : "Coordinator status. Show its latest message"
                        }
                      >
                        <button
                          type="button"
                          className="sws-state"
                          data-tone={coordinatorTone}
                          data-opens={
                            attention && attention.reason !== "failed"
                              ? "coordinator-review"
                              : "conversation"
                          }
                          onClick={
                            attention && attention.reason !== "failed"
                              ? openCoordinatorPage
                              : openCoordinator
                          }
                        >
                          <span className="sws-dot" data-tone={coordinatorTone} aria-hidden />
                          {THREAD_TONE_LABELS[coordinatorTone]}
                          <span className="sr-only">
                            {attention && attention.reason !== "failed"
                              ? `, ${attention.action.toLowerCase()} here`
                              : ", show the coordinator's latest message"}
                          </span>
                        </button>
                      </Tip>
                    ) : null}
                    <CoordinatorMachine
                      label={environment?.label ?? "Host"}
                      connected={connected}
                      disconnectedLabel={hostDisconnectedLabel(
                        environment?.connection,
                        hostAdmission,
                      )}
                      current={`${project.environmentId}:${project.id}`}
                      checkouts={checkouts}
                      savedMachineMissing={savedMachineMissing}
                      onChoose={
                        onCheckout
                          ? (key) => {
                              if (key === `${project.environmentId}:${project.id}`) return;
                              if (mainCoordinatorId) setHandoffTarget(key);
                              else onCheckout(key);
                            }
                          : null
                      }
                    />
                    <ProjectMachineHandoff
                      key={`${project.environmentId}:${project.id}`}
                      project={project}
                      coordinatorId={mainCoordinatorId}
                      requestedTarget={handoffTarget}
                      onOpenChange={handoffOpenChange}
                    />
                    <ProjectUsageIndicator
                      onOpenProjectUsage={() => setTab("usage")}
                      projectEnvironmentId={project.environmentId}
                      // The provider that runs the next turn, not the saved one it moved off.
                      providerInstanceId={
                        coordinatorFallback && coordinator
                          ? coordinator.modelSelection.instanceId
                          : (model?.instanceId ?? null)
                      }
                      model={
                        coordinatorFallback && coordinator
                          ? coordinator.modelSelection.model
                          : (model?.model ?? null)
                      }
                    />
                  </>
                }
                controls={
                  <CoordinatorComposerControls
                    project={project}
                    coordinatorRuntimeMode={coordinator?.runtimeMode ?? null}
                    fallback={
                      coordinatorFallback
                        ? {
                            ...coordinatorFallback,
                            switching: switchingBack,
                            onSwitchBack:
                              canOperate && connected ? () => void switchCoordinatorBack() : null,
                          }
                        : null
                    }
                  >
                    {coordinatorModelControls}
                  </CoordinatorComposerControls>
                }
                modelFallback={coordinatorFallback !== null}
              />
            </div>
          </section>
          {paneOpen ? (
            <aside
              id="project-threads-pane"
              className="project-thread-pane sws-threads"
              aria-label={selectedThread ? `Thread ${selectedThread.title}` : "Project threads"}
              data-project-pane="threads"
            >
              {selectedThread ? (
                <ProjectWorkerPane
                  project={project}
                  thread={selectedThread}
                  coordinatorId={coordinatorId}
                  openCoordinator={openCoordinator}
                  openThread={openThreadInPane}
                  send={routingSend}
                  suspendShortcuts={coordinatorDetailsOpen || machineHandoffOpen}
                  toolsSlot={threadToolsSlot}
                  peek={
                    peekedSubagent
                      ? {
                          thread: peekedSubagent,
                          entry:
                            subagents.find((entry) => entry.childThreadId === peekedSubagent.id) ??
                            null,
                          onClose: closeSubagentPeek,
                        }
                      : null
                  }
                  header={{
                    thread: selectedThread,
                    subagents,
                    onPeekSubagent: (subagentId) => peekSubagent(selectedThread.id, subagentId),
                    providerEntry:
                      selectedThread.environmentId === project.environmentId
                        ? (providerEntries.get(selectedThread.modelSelection.instanceId) ?? null)
                        : null,
                    projectCwd: project.workspaceRoot,
                    canChange:
                      canOperate &&
                      connected &&
                      selectedThread.environmentId === project.environmentId,
                    expanded: paneExpanded,
                    onBack: leaveThread,
                    onToggleResolved: () => void resolveOpenThread(selectedThread),
                    onToggleExpanded: () => setPaneExpanded((value) => !value),
                    onClose: hideOverview,
                    onOpenPullRequest: (url) => void openLink(url).catch(() => undefined),
                    toolsSlotRef: setThreadToolsSlot,
                  }}
                />
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
                  runningSubagents={runningSubagents}
                  canChange={canOperate && connected}
                  findRef={findRef}
                  findOpen={findOpen}
                  onFindOpenChange={setFindOpen}
                  query={findQuery}
                  onQueryChange={setFindQuery}
                  onOpen={openThread}
                  onToggleResolved={(thread) => void resolve(thread)}
                  canChangeThread={(thread) =>
                    thread.environmentId === project.environmentId && canOperate && connected
                  }
                  machineLabels={
                    new Map(
                      iconCheckouts.map((member) => [
                        member.environmentId,
                        checkouts.find(
                          (checkout) => checkout.key === `${member.environmentId}:${member.id}`,
                        )?.machine ?? member.environmentId,
                      ]),
                    )
                  }
                  starters={workers.length === 0 ? starterList : null}
                  bulk={
                    canOperate && connected
                      ? {
                          running: bulkTargets.running.length,
                          interrupted: bulkTargets.interrupted.length,
                          busy: bulk.busy,
                          onStopAll: () => void bulk.stopAll(bulkTargets.running),
                          onContinueAll: () => void bulk.continueAll(bulkTargets.interrupted),
                        }
                      : undefined
                  }
                  remoteWorkerCount={remoteWorkerCount}
                  notice={
                    <>
                      <ProjectThreadAvailability scopes={executionScopes} />
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
                            Retry resolved history
                          </button>
                        </p>
                      ) : null}
                    </>
                  }
                  bar={paneBar}
                />
              )}
            </aside>
          ) : null}
        </ProjectWorkspaceColumns>
        {tab && snapshot && (
          <ProjectWorkspaceSettings
            project={project}
            coordinatorThreadModel={coordinator?.modelSelection ?? null}
            iconCheckouts={iconCheckouts}
            projectKey={projectKey}
            snapshot={snapshot}
            initialTab={tab}
            initialRow={settingsRow}
            focusName={focusName}
            onClose={() => {
              setTab(null);
              setFocusName(false);
              setSettingsRow(null);
            }}
            onSaved={query.refresh}
            onOpenThread={openThread}
            canOperate={canOperate && connected}
            onDeleted={() => {
              setTab(null);
              setFocusName(false);
              setSettingsRow(null);
              void navigate({ to: "/" });
            }}
          />
        )}
      </div>
    </SidebarInset>
  );
}
