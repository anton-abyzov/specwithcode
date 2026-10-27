import { modelLabel as threadIdentityLabel } from "../studio/shellModel";
import { registerChatViewWindowInput } from "./chat/chatViewWindowInput";
import type {
  ChatViewProps,
  TerminalLaunchContext,
  PersistentTerminalLaunchContext,
} from "./chat/ChatViewProps";
import { useProjectDraftSendGuard } from "./chat/ProjectDraftSendGuard";
import { useProjectCoordinatorHandoff } from "~/hooks/useProjectCoordinatorHandoff";
import { coordinatorForkHandoff } from "./chat/coordinatorForkHandoff";
import { coordinatorDeviceHandoff } from "./chat/coordinatorDeviceHandoff";
import { openBackgroundChatComposer, useNewChatDestination } from "~/hooks/useNewChatDestination";
import { chatControlAnchor, chatUsesPanelSheet } from "./chat/embeddedProjectLayout";
import { resolveCollapseLongReports } from "./chat/delegatedThreadMemory";
import {
  routesViaCoordinator,
  useProjectMessageRouting,
  sendProjectComposerDraft,
} from "../studio/projectMessageRouting";
import { withRoutedMessages } from "../studio/projectCoordinatorMessageDisplay";
import {
  assertCoordinatorQueueModel,
  continueWithProjectModel,
  resumeQueueWithProjectModel,
} from "../studio/coordinatorContinuation";
import { latestWorkStep } from "../studio/coordinatorProgress";
import { useUnreachableHosts } from "../studio/unreachableHosts";
import { threadBlocker } from "../studio/projectWorkspaceModel";
import { useMachineNicknames } from "../studio/machineNickname";
import { threadHandoffState, useHandoffModeSnapshot } from "../studio/handoffMode";
import { useOpenThread } from "../hooks/useOpenThread";
import { runThreadLifecycleShortcut } from "../lib/threadLifecycleShortcut";
import { settleAfter, settleCaught } from "../lib/settle";
import { useLatestRef } from "../hooks/useLatestRef";
import { THREAD_LIFECYCLE_LABELS } from "@specweave-studio/shared/threadLifecycleLabels";
import { ChatCanvas } from "./chat/ChatCanvas";
import {
  canSelectManualFallback,
  fallbackUnavailableReason,
  preswitchPairingRoom,
  limitPairingRoom,
  type FallbackChoice,
  usageApproachingBannerItem,
  usageLimitRecoveryBannerItem,
} from "./chat/UsageLimitRecoveryBanner";
import {
  accountChangeAutoContinues,
  accountChangedBannerItem,
  accountChangedWithRoom,
} from "./chat/AccountChangedBanner";
import {
  deviceHandoffText,
  pickContinueTarget,
  pickDeviceModel,
  type ContinueCandidate,
  type ContinueTarget,
} from "./chat/deviceHandoff";
import {
  formatOutgoingPrompt,
  resolveBackgroundDraftWorkspaceOptions,
  resolveDraftHeroState,
  shouldDockDraftHeroForSubmission,
  isSettledRunStatus,
  resolveVisibleWorktreeSetup,
  resolveWorktreeSetupProgress,
  switchThreadBackToPick,
} from "./ChatView.logic";
import * as DateTime from "effect/DateTime";
import { restorePlanFollowUpComposer } from "./ChatView.logic";
import { assistantCitationsToPlainText } from "@specweave-studio/shared/assistantCitations";
import { prepareQueuedEditAttachments, recoverQueuedMessageEdit } from "./chat/queuedMessageEdit";
import {
  isPaintOnlyThreadTimeline,
  peekHeldThreadTimeline,
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resolveThreadSwitchTimeline,
  timelineHasEphemeralPreviewUrls,
  recallCheckoutIsRepo,
  rememberCheckoutIsRepo,
} from "./ChatView.logic";
import { useLoadBalancedEnvironment } from "../hooks/useLoadBalancedEnvironment";
import { useScratchProject } from "../hooks/useScratchProject";
import { isScratchProject } from "@specweave-studio/client-runtime/state/projects";
import {
  threadRunHealth,
  threadRuntimeIsActive,
} from "@specweave-studio/client-runtime/state/models";
import { visibleThreadPullRequests } from "@specweave-studio/shared/threadPullRequests";
import {
  latestRootProviderFailureItem,
  providerFailureDisplayMessage,
  resumableRunId as resumableRunIdOf,
  threadErrorIsLive,
} from "@specweave-studio/shared/orchestrationV2ThreadError";
import type { UsageLimitSourceSnapshots } from "@specweave-studio/contracts";
import {
  collectProviderUsageLimits,
  hasProviderUsageLimits,
  isUsageLimitsCommand,
} from "@specweave-studio/shared/usageLimits";
import { feedbackBannerItem } from "./chat/ComposerFeedback";
import { usageLimitsBannerItem } from "./chat/ComposerUsageLimits";
import { getTerminalLabel } from "@specweave-studio/shared/terminalLabels";
import * as Schema from "effect/Schema";
import { Minimize2Icon } from "lucide-react";
import {
  questionAttachmentDraftId,
  questionAttachmentDraftPrefix,
  clearQuestionAttachmentDraft,
  useQuestionAttachmentPreparation,
} from "../questionAttachments";
import { planQuestionChatReply, type QuestionChatReply } from "../questionChatReply";
import { questionAnswerCommandId } from "../studio/coordinatorQuestionAnswers";
import {
  QuestionLiveStatus,
  useLiveAnnouncement,
  useQuestionSettleAnnouncements,
} from "./chat/questionLiveStatus";
import {
  isAnswerProblemOutdated,
  questionSendResult,
  settleQuestionAnswer,
  settledSendReason,
  settleQuestionDismiss,
  shownAnswerProblem as answerProblemText,
  type AnswerProblem,
  type QuestionSendProblem,
} from "./chat/questionSendOutcome";
import { useAttachmentUploadStore } from "../lib/attachmentUploadQueue";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthPreviewOperateScope,
  AuthTerminalReadScope,
  AuthProvidersManageScope,
  AuthTerminalOperateScope,
  type AssistantCitation,
  type ChatFileAttachment,
  CommandId,
  DEFAULT_MODEL,
  isProviderNativeSubagentThread,
  type ChatAttachment as ContractChatAttachment,
  EnvironmentAuthorizationError,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ManualCodexCreditIntent,
  type ProjectScript,
  type ProjectId,
  type ProviderApprovalDecision,
  type PreviewAnnotationPayload,
  ProviderInstanceId,
  type ServerProvider,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
  type ThreadLinkedPullRequest,
  type RunId,
  type RuntimeRequestId,
  type KeybindingCommand,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderInteractionMode,
  ProviderDriverKind,
  RuntimeMode,
  TerminalOpenInput,
  type WorktreeSetupSnapshot,
  isInlineRunTerminalId,
} from "@specweave-studio/contracts";
import { type EnvironmentConnectionPresentation } from "@specweave-studio/client-runtime/connection";
import { deriveThreadTitleSeed } from "@specweave-studio/client-runtime/operations";
import {
  wasBootstrapThreadDeleted,
  wasBootstrapThreadNotCreated,
} from "@specweave-studio/client-runtime/errors";
import { readPastedComposerContext } from "./composerInlineTokenPaste";
import { imageInputBlockReason, modelRejectsImages } from "./composerImageInput";
import { isPasteAsTextShortcut } from "@specweave-studio/client-runtime/text-paste";
import {
  effectiveSnoozed,
  threadWokeAt,
} from "@specweave-studio/client-runtime/state/thread-settled";
import { useAcknowledgeThreadWoke, useThreadActions } from "../hooks/useThreadActions";
import { useWorkspaceMissingRecovery } from "./chat/useWorkspaceMissingRecovery";
import {
  deriveProviderSubagentStatus,
  providerSubagentWorkActive,
  deriveReportedModelSelection,
  formatModelSelectionEffort,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveLatestThreadRun,
  deriveThreadRuntime,
  presentPendingBackgroundWork,
  presentProviderGoal,
} from "@specweave-studio/client-runtime/state/thread-execution";
import { threadSupportsProviderHandoff } from "@specweave-studio/client-runtime/state/thread-workflows";
import {
  codexFeedbackMessage,
  parseCodexFeedbackCommand,
  shouldShowLoadEarlierControl,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@specweave-studio/client-runtime/state/threads";
import { resolveThreadLastVisitedAt } from "./Sidebar.logic";
import { derivePendingThreadRequests } from "@specweave-studio/client-runtime/state/thread-requests";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@specweave-studio/client-runtime/environment";
import {
  createModelSelection,
  formatModelSlugName,
  modelSelectionsEqual,
  resolveSelectableModel,
} from "@specweave-studio/shared/model";
import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  resolveProjectScripts,
} from "@specweave-studio/shared/projectScripts";
import { CHAT_LIST_ANCHOR_OFFSET } from "@specweave-studio/shared/chatList";
import {
  deriveActiveRunWork,
  derivePendingBackgroundWork,
} from "@specweave-studio/shared/orchestrationV2PendingBackgroundWork";
import {
  latestUnheldRun,
  usageLimitRunPresentedAsLatest,
} from "@specweave-studio/shared/orchestrationV2ThreadError";
import {
  projectSettingsOverrideChangesPatch,
  resolveProjectSettings,
} from "@specweave-studio/shared/projectSettings";
import {
  isApiCreditExhaustedMessage,
  limitRestartRequest,
  limitStopWaitsForReset,
  provenFallbackSelection,
  providerUsedPercent,
  reportsNoUsage,
  resolveApiCreditSelections,
  describeFallbackOrder,
  resolveProviderFallback,
  shouldSwitchBeforeTurn,
  usageAtThreshold,
  usageResetAt,
} from "@specweave-studio/shared/providerFallback";
import { fallbackChain, fallbackStatusHeader } from "./chat/fallbackStatus";
import { preswitchReturnBlock } from "@specweave-studio/shared/preswitchReturn";
import { resolveProviderInstanceDisplayName } from "@specweave-studio/client-runtime/state/provider-instance-display";
import { isApiCreditAccountDriver } from "./settings/apiCreditAccount";
import { sourceControlRepositorySelector } from "@specweave-studio/shared/sourceControl";
import { truncate } from "@specweave-studio/shared/String";
import { resolveThreadReferenceCopyTarget } from "@specweave-studio/shared/threadReference";
import { nextTerminalId, resolveTerminalTabTitle } from "@specweave-studio/shared/terminalLabels";
import { Debouncer } from "@tanstack/react-pacer";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  lazy,
  memo,
  type SetStateAction,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { InViewerOverlay, useViewerOverlayStore } from "~/viewerOverlayStore";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { assistantCitationFromLocation } from "../lib/assistantCitationNavigation";
import { isMacPlatform } from "../lib/utils";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { useShallow } from "zustand/react/shallow";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { isElectron } from "../env";
import { readLocalApi } from "../localApi";
import { type TurnDiffLinkOptions, useDiffPanelStore } from "../diffPanelStore";
import { useActiveThreadRef } from "../hooks/useActiveThreadRef";
import { useHideRightPanelOnLeave } from "../hooks/useHideRightPanelOnLeave";
import {
  type ComposerSubmissionIntent,
  collapseExpandedComposerCursor,
  parseStandaloneComposerSlashCommand,
} from "../composer-logic";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  selectHandoffImageResources,
  deriveActivePlanState,
  deriveActiveWorkStartedAt,
  deriveCanInterruptRunningThread,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  isLatestRunSettled,
} from "../session-logic";
import { type LegendListRef } from "@legendapp/list/react";
import {
  CHAT_TIMELINE_ANCHOR_OFFSET,
  timelineContentOverflowsViewport,
  readTimelinePosition,
  observeTimelineRun,
  shouldPositionTimelineAnchor,
  type TimelineRunObservation,
  type TimelineScrollMode,
} from "./chat/timelineScrollAnchoring";
import {
  buildPendingUserInputAnswers,
  carryDisplacedCustomAnswerIntoPrompt,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { useUiStateStore } from "../uiStateStore";
import { useWorkspaceMutationRefresh } from "../hooks/useWorkspaceMutationRefresh";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ChatMessage,
  isBrowserPreviewAttachment,
  isImageAttachment,
  type SessionPhase,
  type Thread,
} from "../types";
import { useTheme } from "../hooks/useTheme";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { subscribeSnapShotComposerFocus } from "../lib/desktopSnapShot";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { usePhoneKeyboard } from "../hooks/usePhoneKeyboard";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useElementHeight } from "../hooks/useElementHeight";
import { useElementWidth } from "../hooks/useElementWidth";
import { usePreviewPanelInlineSize } from "../hooks/usePreviewPanelInlineSize";
import {
  RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY,
  type ThreadPanelPresentation,
} from "../rightPanelLayout";
import { PopoverCreateHandle } from "./ui/popover";
import {
  pullRequestSurface,
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadPanelOpen,
  selectThreadRightPanelState,
  type RightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import {
  isPreviewSupportedInRuntime,
  setActivePreviewTab,
  useThreadPreviewState,
} from "../previewStateStore";
import { BrowserSettingsReadError, openUrlInPreview } from "../browser/openFileInPreview";
import { resolveDiscoveredServerUrl } from "../browser/browserTargetResolver";
import { previewRuntimeTabId } from "../browser/previewRuntimeTabId";
import { addBrowserSurface } from "./preview/addBrowserSurface";
import { closePreviewSession } from "./preview/closePreviewSession";
import { ThreadPreviewMiniPlayer } from "./preview/ThreadPreviewMiniPlayer";
import { usePreviewSession } from "./preview/usePreviewSession";
import { subscribePreviewAction } from "./preview/previewActionBus";
import { getConfiguredPreviewUrls } from "./preview/previewEmptyStateLogic";

import {
  browserMiniPlayerSource,
  previewMiniPlayerSourceKey,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../previewMiniPlayerStore";
import {
  pullRequestPanelContext,
  threadPullRequestPanelTarget,
} from "./pullRequest/pullRequestDetail.logic";
import { PullRequestDetailPanel } from "./pullRequest/PullRequestDetailPanel";
import { PullRequestDetailGhost } from "./pullRequest/PullRequestGhosts";
import { PullRequestsUnavailableState } from "./pullRequest/PullRequestsUnavailableState";
import { RightPanelTabs } from "./RightPanelTabs";
import { LinkPullRequestDialogHost } from "./pullRequest/LinkPullRequestDialog";
import { ThreadPullRequestsPanel } from "./pullRequest/ThreadPullRequestsPanel";
import { useDeviceState } from "~/state/device";
import { DeviceSetup } from "./device/DeviceSetup";
import { Dialog } from "./ui/dialog";
import { isAppSheetOpen } from "./ui/appSheetState";
import { WizardPopup } from "./ui/wizard";
import { BranchToolbar, type BranchToolbarHandle } from "./BranchToolbar";
import { useWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import { isEditableFocused } from "../lib/editableFocus";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";
import { resolveChatShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import {
  AlarmClockIcon,
  MonitorIcon,
  CheckCircle2Icon,
  PaperclipIcon,
  DownloadIcon,
  GitBranchIcon,
  LaptopIcon,
  TargetIcon,
  HourglassIcon,
  FolderInputIcon,
  WifiOffIcon,
} from "lucide-react";
import { cn, randomUUID } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
} from "~/lib/projectScriptKeybindings";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptIdFromCommand,
} from "~/projectScripts";
import { newDraftId, newMessageId, newThreadId } from "~/lib/utils";
import {
  holdDurableThreadDraft,
  useDurableThreadDraftRestore,
  whenHostReady,
} from "~/lib/durableComposerDraftBindings";
import { isUnsentHostFailure, retryTransientSend } from "~/lib/transientSendRetry";
import { registerFaviconProjectForThread } from "~/browserFaviconStore";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  shouldShowInstanceBadge,
  sortProviderInstanceEntries,
} from "../providerInstances";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useEnvironmentSettings,
  useProjectOverrideWriteMode,
} from "../hooks/useSettings";
import { useNowMinute } from "../hooks/useNowMinute";
import { usePanelAnimationSettings, usePanelPresence } from "../panelAnimations";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useRemoveClonedProject } from "../hooks/useRemoveClonedProject";
import { useOpenPanelPullRequestUrl } from "../hooks/useOpenPanelPullRequestUrl";
import { resolveAppModelSelectionForInstance } from "../modelSelection";
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
} from "./chat/composerProviderState";
import { confirmTerminalClose, isTerminalCloseConfirmPending } from "../lib/terminalCloseConfirm";
import { isPreviewFocused } from "../lib/previewFocus";
import { getTerminalFocusOwner } from "../lib/terminalFocus";
import {
  preventRepeatedTerminalCloseShortcut,
  preventTerminalCloseShortcut,
} from "../lib/terminalCloseShortcut";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import { HANDOFF_CONTINUED, movedAwayBanner, threadMoveBanner } from "./threadMove.logic";
import {
  isSameSidebarThreadRef,
  useSidebarPendingFileDropStore,
} from "../sidebarPendingFileDropStore";
import {
  beginBackgroundDraftSubmissionByRef,
  clearBackgroundDraftSubmissionByRef,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  restoreFailedBackgroundDraftThread,
  composerDraftHasUserContent,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  useComposerDraftStore,
  DraftId,
} from "../composerDraftStore";
import {
  formatTerminalContextLabel,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import {
  ensureInlineContextReferences,
  removeInlineContextReference,
  stripInlineContextReferences,
} from "../lib/composerContextReferences";
import { serializeLegacyContextMessage } from "@specweave-studio/shared/composerContextLegacySend";
import {
  buildMessageContext,
  previewAnnotationContextLabel,
  previewAnnotationContextReference,
  reviewCommentContextLabel,
  terminalContextReference,
} from "../lib/composerContextRecords";
import { type ReviewCommentContext } from "../reviewCommentContext";
import { environmentCatalog } from "../connection/catalog";
import { machineLastSeenAt, useMachineLastSeenVersion } from "../lib/machineLastSeen";
import {
  chatContinuation,
  dismissContinuedFrom,
  recordChatContinuation,
  useChatContinuationsVersion,
} from "../lib/chatContinuations";
import {
  environmentUnavailableSendToast,
  isThisMachineCatchingUp,
  lastSeenLabel,
  machineDetail,
} from "../lib/machineStatus";
import { isDesktopLocalConnectionTarget, isThisMachineTarget } from "../connection/desktopLocal";
import { useEnvironmentDisconnectDelay } from "../hooks/useEnvironmentDisconnectDelay";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useKnownTerminalSessions, useThreadRunningTerminalIds } from "../state/terminalSessions";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "~/state/session";
import {
  environmentServerConfigsAtom,
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  serverEnvironment,
} from "../state/server";
import { terminalEnvironment } from "../state/terminal";
import { environmentThreadDetails, threadEnvironment } from "../state/threads";
import { workspacePreparationRetryRunIds } from "@specweave-studio/client-runtime/state/turn-item-presentation";
import { CoordinatorNativeControls } from "./studio/CoordinatorNativeControls";
import { resolveProviderSkillsForCwd } from "@specweave-studio/client-runtime/providerSkills";
import { vcsEnvironment } from "../state/vcs";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useProjectClone } from "../state/projectClones";
import { clearAddToMachineJob, readAddToMachineJob } from "../studio/addToMachine";
import {
  projectCloneDisplayName,
  projectCloneProgressSummary,
  projectCloneSendBlockReason as projectCloneSendBlockReasonOf,
  type OrchestrationV2Subagent,
} from "@specweave-studio/contracts";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import {
  resolveThreadDetailRef,
  useEnvironmentSupportsServerBrowser,
  readThreadShell,
  useProject,
  useProjects,
  useThreadError,
  useThreadProjection,
  useThreadStatus,
  useThreadHistory,
  useThreadShell,
  useThreadRefs,
  useThreadVisibleTurnItems,
  waitForThreadShell,
} from "../state/entities";
import { environmentShell } from "../state/shell";
import { ChatComposer, type ChatComposerHandle } from "./chat/ChatComposer";
import { createPageScrollController, type PageScrollKey } from "./chat/pageScrollController";
import { isTimelineScrollTarget } from "./chat/timelineScrollTarget";
import { DraftHeroHeadline } from "./chat/DraftHeroHeadline";
import { fallbackModelState } from "./chat/ModelStateTag";
import { DraftMachinePicker } from "./chat/DraftMachinePicker";
import { buildLogicalProjectEnvironments } from "./chat/logicalProjectEnvironments";
import { useDraftMachineRouting } from "./chat/useDraftMachineRouting";
import { explicitCreditSendStillMatches, type CreditSendContext } from "./chat/explicitCreditSend";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { EmbeddedThreadDiffPanel } from "./chat/EmbeddedThreadDiffPanel";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import type { AssistantCitationRequest } from "./chat/AssistantCitationSource";
import {
  MessagesTimeline,
  type MessagesTimelineHistoryControls,
  type TimelineSubagentParent,
} from "./chat/MessagesTimeline";
import { JumpToLatestButton } from "./chat/JumpToLatestButton";
import { ProviderSubagentBar } from "./chat/ProviderSubagentBar";
import { getTriggerDisplayModelName } from "./chat/providerIconUtils";
import { resolveTimelineIsAtEnd, worktreeSetupAgentStarted } from "./chat/MessagesTimeline.logic";
import {
  overlayComposerIsResting,
  resolveComposerTimelineInset,
  resolveScrollToEndClearance,
} from "./composerFooterLayout";
import { ChatHeader } from "./chat/ChatHeader";
import { limitFallbackPairing } from "../studio/runIdentity";
import { useRemoteOpenState } from "~/remoteOpen";
import { shouldShowOpenInPicker } from "./chat/OpenInPicker.logic";
import { useOpenFavoriteEditorShortcut } from "./chat/OpenInPickerShortcut";
import {
  PanelLayoutControls,
  type PanelLayoutControlsProps,
  RightPanelMaximizeControl,
} from "./chat/PanelLayoutControls";
import { expandedImageKey, type ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./chat/ThreadDetailsPanel";
import { NoActiveThreadState } from "./NoActiveThreadState";
import {
  resolveEffectiveEnvMode,
  resolveLocalCheckoutBranchMismatch,
  shouldShowComposerContextStrip,
  shouldShowEnvironmentIndicator,
} from "./BranchToolbar.logic";
import {
  getProviderStatusBannerKey,
  ProviderStatusBanner,
  shouldShowProviderStatusBanner,
} from "./chat/ProviderStatusBanner";
import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  ThreadErrorBanner,
} from "./chat/ThreadErrorBanner";
import {
  QueuedRunsControl,
  type QueuedRunsControlHandle,
  type EditQueuedRunRequest,
} from "./chat/QueuedRunsControl";
import { queuedRunActionsUnavailableReason } from "./chat/queuedRunSummary";
import { useLinkedThreadPullRequest } from "./ThreadStatusIndicators";
import type { ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import { lifecycleDeliveryBannerItem } from "./chat/LifecycleDeliveryBanner";
import {
  COMPUTER_USE_PERMISSION_COPY,
  ComputerUsePermissionWaitNotice,
  ComputerUseRetryContext,
} from "./computerUse/ComputerUsePermissions";
import { ShellRunTargetContext, type ShellRunTarget } from "./chat/InlineShellRun";
import { useComputerUsePermissionWait } from "../state/computerUsePermissionWait";
import { ComposerSurface } from "./chat/ComposerSurface";
import { resolveThreadSyncPhase } from "../threadSync";
import {
  hasAvailableCompactionProvider,
  hasDismissedResumeCompaction,
  providerSupportsManualCompaction,
  shouldOfferResumeCompaction,
} from "./chat/ContextWindowMeter.logic";
import { deriveLatestContextWindowSnapshot, formatContextWindowTokens } from "../lib/contextWindow";
import {
  DRAFT_HERO_TRANSITION_ANIMATION_ID,
  DRAFT_HERO_TRANSITION_EASING,
  MOBILE_COMPOSER_VIEW_TRANSITION_NAME,
  MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
  runMobileComposerTransition,
} from "./chat/draftHeroTransition";
import type { ComposerDispatchMode } from "@specweave-studio/client-runtime/state/composer-dispatch";
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  agentControlledBrowserCloseConfirmation,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  collectUserMessageBlobPreviewUrls,
  createLocalDispatchSnapshot,
  deriveCommittedServerUserMessageIds,
  deriveComposerSendState,
  dismissBranchMismatchForSession,
  hasEnvironmentReconnectWarningGraceElapsed,
  scheduleEnvironmentReconnectWarning,
  hasServerAcknowledgedLocalDispatch,
  isBranchMismatchDismissedForSession,
  shouldShowBranchMismatchBanner,
  shouldShowPlanFollowUpPrompt,
  shouldOpenProactivePullRequest,
  shouldRetargetThreadPullRequestPanel,
  shouldOpenProactiveTurnDiff,
  shouldReleaseTimelineAnchorForToolActivity,
  shouldRenderPreviewMiniPlayer,
  getStartedThreadModelChangeBlockReason,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  type LocalDispatchSnapshot,
  PullRequestDialogState,
  cloneComposerImageForRetry,
  deriveLockedProvider,
  providerInstanceCanRun,
  readFileAsDataUrl,
  resolveFileAttachmentUrl,
  prepareRevertedMessageAttachments,
  waitForRevertedMessage,
  reconcileMountedTerminalThreadIds,
  resolveComposerInteractionMode,
  resolveComposerDraftProvider,
  resolveComposerProviderSelection,
  resolveComposerServerProviderSync,
  getAntigravitySendBlockReason,
  observeProactivePanelUserChoice,
  resolveProactiveTurnDiffAction,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  startNewThreadForProject,
  codexArtifactTemplatePromptToAppend,
  waitForStartedServerThread,
  shouldRefocusComposerOnWindowFocus,
  environmentUnavailableBanner,
  environmentWaitsForReconnectGrace,
  THIS_MACHINE_BUSY_DESCRIPTION,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerHandleContext } from "../composerHandleContext";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../lib/attachmentUploadQueue";
import { sanitizeThreadErrorMessage } from "~/rpc/transportError";
import { RightPanelSheet } from "./RightPanelSheet";
import { previewEnvironment } from "../state/preview";
import { clampFileAttachmentUploadBytes } from "@specweave-studio/client-runtime/state/attachments";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { fileAttachmentCapabilityBlockReason } from "./chat/composerAttachmentFiles";
import { assetEnvironment } from "../state/assets";
import { readEnvironmentScope, readPreparedConnection } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { parseComposerAppCommand } from "../studio/composerAppCommands";
import { useComposerAppCommands } from "../studio/useComposerAppCommands";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  BackgroundWorkIcon,
  BackgroundWorkLabel,
  BackgroundWorkStopButton,
} from "./chat/BackgroundWorkStrip";
import { useAssetUrls } from "../assets/assetUrls";
import { useOpenLink } from "../browser/useOpenLink";
import {
  openFileInFront,
  useFileReaderLayoutReport,
  viewerOverlayInFront,
} from "~/lib/openInFront";
import { useOpenChangeRequestLink } from "~/lib/openPullRequestLink";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { deriveThreadPlanView, displayFolder } from "../studio/threadPlanProgress";
import { useThreadIncrementState } from "../studio/useThreadIncrementProgress";
import { useUnplannedNoticeShown } from "../studio/unplannedNotice";
import { ThreadPlanCard } from "./chat/ThreadPlanCard";
import { ThreadBlockerNote } from "./chat/ThreadBlockerNote";
import { ThreadHeaderLine, ThreadProgressDock } from "./chat/ThreadProgressDock";
import {
  LinkIncrementDialogHost,
  openLinkIncrementDialog,
  useSetThreadIncrementLink,
} from "./chat/LinkIncrementDialog";
import { ThreadMetaRow, type ThreadOrigin } from "./chat/ThreadMetaRow";
import { isNestedSubagentThread } from "../studio/threadSubagents";
import { isCoordinatorNamedThread } from "../studio/threadTitles";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  recallableComposerPrompt,
} from "./chat/composerPromptHistory";

/** A click with no modifier, for openers that read the event. */
const PLAIN_CLICK = {
  metaKey: false,
  ctrlKey: false,
  preventDefault: () => undefined,
  stopPropagation: () => undefined,
};

const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PROVIDER_MODELS: ServerProvider["models"] = [];
const EMPTY_USAGE_LIMIT_SOURCES: UsageLimitSourceSnapshots = [];
import type { CodexArtifactTemplate } from "@specweave-studio/client-runtime/codex-artifact-templates";

const TIMELINE_SCROLL_CANCEL_SENTINEL = Object.freeze({});
const EMPTY_FEEDBACK_SUBMISSIONS: ReadonlyArray<CodexFeedbackSubmission> = [];
// During an active turn the thread's updatedAt advances several times per
// second, and every server-side visit is a full command dispatch plus a
// broadcast to all shell subscribers. Mid-turn bumps carry no unread signal
// (unread flips on run completions, which bypass the throttle), so one
// watermark per interval is plenty.
const VISIT_DISPATCH_THROTTLE_MS = 10_000;
const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
const NO_SUBAGENT_RECORDS: ReadonlyArray<OrchestrationV2Subagent> = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const EMPTY_REVIEW_OPTIMISTIC_MESSAGES: ReadonlyArray<never> = [];
function useDraftHeroLayoutTransition(
  isDraftHeroState: boolean,
  animationsActive: boolean,
  animationDurationMs: number,
) {
  const transitionGroupRef = useRef<HTMLDivElement | null>(null);
  const composerAnchorRef = useRef<HTMLDivElement | null>(null);
  const previousStateRef = useRef(isDraftHeroState);
  const previousComposerRectRef = useRef<DOMRect | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const attachTransitionGroupRef = (element: HTMLDivElement | null) => {
    transitionGroupRef.current = element;
  };
  const attachComposerAnchorRef = (element: HTMLDivElement | null) => {
    composerAnchorRef.current = element;
  };

  const captureComposerRect = () => {
    previousComposerRectRef.current = composerAnchorRef.current?.getBoundingClientRect() ?? null;
  };

  useLayoutEffect(() => {
    const transitionGroup = transitionGroupRef.current;
    const nextComposerRect = composerAnchorRef.current?.getBoundingClientRect() ?? null;
    const stateChanged = previousStateRef.current !== isDraftHeroState;
    const mobileComposerTransitionActive =
      typeof document !== "undefined" &&
      document.documentElement.dataset.mobileComposerRouteTransition === "true";

    animationRef.current?.cancel();
    animationRef.current = null;
    const previousComposerRect = previousComposerRectRef.current;
    if (
      stateChanged &&
      animationsActive &&
      !mobileComposerTransitionActive &&
      transitionGroup &&
      previousComposerRect &&
      nextComposerRect &&
      typeof transitionGroup.animate === "function"
    ) {
      const translateX = previousComposerRect.left - nextComposerRect.left;
      const translateY = previousComposerRect.top - nextComposerRect.top;
      if (Math.abs(translateX) >= 0.5 || Math.abs(translateY) >= 0.5) {
        const animation = transitionGroup.animate(
          [
            { transform: `translate3d(${translateX}px, ${translateY}px, 0)` },
            { transform: "translate3d(0, 0, 0)" },
          ],
          {
            duration: animationDurationMs,
            easing: DRAFT_HERO_TRANSITION_EASING,
          },
        );
        animation.id = DRAFT_HERO_TRANSITION_ANIMATION_ID;
        animationRef.current = animation;
        void animation.finished
          .catch(() => undefined)
          .then(() => {
            if (animationRef.current === animation) animationRef.current = null;
          });
      }
    }
    previousStateRef.current = isDraftHeroState;
    previousComposerRectRef.current = nextComposerRect;
  }, [animationDurationMs, animationsActive, isDraftHeroState]);

  return {
    transitionGroupRef: attachTransitionGroupRef,
    composerAnchorRef: attachComposerAnchorRef,
    captureComposerRect,
  } as const;
}

const PreviewPanel = lazy(() =>
  import("./preview/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);
const selectAutoShowFloatingPreview = (settings: { browserAutoShowFloatingPreview: boolean }) =>
  settings.browserAutoShowFloatingPreview;
const DevicePanel = lazy(() =>
  import("./device/DevicePanel").then((module) => ({ default: module.DevicePanel })),
);
const FilePreviewPanel = lazy(() => import("./files/FilePreviewPanel"));
const EMPTY_PENDING_FILE_SURFACE_IDS: ReadonlySet<string> = new Set();
const TYPE_TO_FOCUS_EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");
const TYPE_TO_FOCUS_INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
].join(",");
// Popups match only while open or closing: some stay mounted when closed,
// such as the chat header actions menu.
const TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR = [
  '[role="dialog"][aria-modal="true"]',
  '[data-slot="alert-dialog-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="command-dialog-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="dialog-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="sheet-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="sidebar"][data-mobile="true"]:is([data-open],[data-ending-style])',
  '[data-slot="menu-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="select-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="popover-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="combobox-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="autocomplete-popup"]:is([data-open],[data-ending-style])',
].join(",");

type EnvironmentUnavailableState = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: EnvironmentConnectionPresentation;
  readonly isThisMachine: boolean;
};

function eventPathContainsSelector(event: Event, selector: string): boolean {
  const path = event.composedPath();
  if (path.length === 0 && event.target) {
    path.push(event.target);
  }
  return path.some((target) => target instanceof Element && target.closest(selector));
}

const SECRET_REQUEST_SELECTOR = '[data-v2-item-type="secret_request"]';
// Surfaces that handle their own keys (the design canvas, a device stream). The chat
// listens on the window in capture phase, so it must leave their keys alone.
const KEYBOARD_OWNER_SELECTOR = '[role="application"]';

/**
 * Whether input that landed outside any editable or interactive element
 * should be redirected into the composer. Shared by type-to-focus and
 * paste-to-focus so both honour the same surfaces.
 */
function shouldRedirectInputToComposer(event: Event): boolean {
  if (event.defaultPrevented) return false;
  // Near a pending secret request, input is meant for its private field: it
  // must never land in the composer draft, which is persisted and sent.
  if (eventPathContainsSelector(event, SECRET_REQUEST_SELECTOR)) return false;
  if (eventPathContainsSelector(event, KEYBOARD_OWNER_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_INTERACTIVE_SELECTOR)) return false;
  if (document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)) return false;
  return true;
}

function shouldTypeToFocusComposer(event: KeyboardEvent): boolean {
  if (event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key.length !== 1) return false;
  if (!shouldRedirectInputToComposer(event)) return false;

  return true;
}

/**
 * Plain text pasted with nothing editable focused, such as after the resting
 * composer blurred. Files are left to the composer's own paste handler.
 */
function pasteTextToFocusComposer(event: ClipboardEvent): string | null {
  if (!event.clipboardData || event.clipboardData.files.length > 0) return null;
  if (!shouldRedirectInputToComposer(event)) return null;
  const text = event.clipboardData.getData("text/plain");
  return text.length > 0 ? text : null;
}

const draftFanoutStateAtom = Atom.family((_routeKey: string) =>
  Atom.make({
    selections: null as ReadonlyArray<ModelSelection> | null,
    sendInFlight: { current: false },
    uncertainSubmissions: { current: new Map<string, ThreadId>() },
  }).pipe(Atom.keepAlive),
);

const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

function isCompactCommandMessage(message: ChatMessage): boolean {
  const text = message.text.trim().toLowerCase();
  return message.role === "user" && text === "/compact" && !message.attachments?.length;
}

function useLocalDispatchState(input: {
  activeThread: Thread | undefined;
  activeLatestRun: Thread["latestRun"] | null;
  latestUserMessageId: MessageId | null;
  phase: SessionPhase;
  activePendingApproval: RuntimeRequestId | null;
  activePendingUserInput: RuntimeRequestId | null;
  threadError: string | null | undefined;
}) {
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);

  const resetLocalDispatch = useCallback(() => {
    setLocalDispatch(null);
  }, []);

  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: input.phase,
        latestRun: input.activeLatestRun,
        latestUserMessageId: input.latestUserMessageId,
        runtime: input.activeThread?.runtime ?? null,
        hasPendingApproval: input.activePendingApproval !== null,
        hasPendingUserInput: input.activePendingUserInput !== null,
        threadError: input.threadError,
      }),
    [
      input.activeLatestRun,
      input.latestUserMessageId,
      input.activePendingApproval,
      input.activePendingUserInput,
      input.activeThread?.runtime,
      input.phase,
      input.threadError,
      localDispatch,
    ],
  );
  const activeLocalDispatch = serverAcknowledgedLocalDispatch ? null : localDispatch;
  const beginLocalDispatch = useCallback(
    (options?: { preparingWorktree?: boolean; submissionIntent?: ComposerSubmissionIntent }) => {
      const preparingWorktree = Boolean(options?.preparingWorktree);
      setLocalDispatch((current) => {
        const active = serverAcknowledgedLocalDispatch ? null : current;
        if (active) {
          const submissionIntent = options?.submissionIntent ?? active.submissionIntent;
          return active.preparingWorktree === preparingWorktree &&
            active.submissionIntent === submissionIntent
            ? active
            : { ...active, preparingWorktree, submissionIntent };
        }
        return createLocalDispatchSnapshot(input.activeThread, {
          ...options,
          latestUserMessageId: input.latestUserMessageId,
        });
      });
    },
    [input.activeThread, input.latestUserMessageId, serverAcknowledgedLocalDispatch],
  );

  return {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: activeLocalDispatch?.startedAt ?? null,
    isPreparingWorktree: activeLocalDispatch?.preparingWorktree ?? false,
    isSendBusy: activeLocalDispatch !== null,
    backgroundSubmissionPending: activeLocalDispatch?.submissionIntent === "background",
  };
}

/** Same terminal ids (order ignored) — avoids reconcile when only server session ordering differs. */
function terminalIdListsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  if (left.length === 0) {
    return true;
  }
  const sortedLeft = left.toSorted((a, b) => a.localeCompare(b));
  const sortedRight = right.toSorted((a, b) => a.localeCompare(b));
  for (let index = 0; index < sortedLeft.length; index += 1) {
    if (sortedLeft[index] !== sortedRight[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Server knows about fewer sessions than the client, but every server id still exists locally.
 * Typical right after `terminal.open`: known-session list lags; reconciling would drop the new id
 * and later re-add it as a separate group (no split layout).
 */
function serverTerminalIdsStrictSubsetOfClient(
  serverIds: readonly string[],
  clientIds: readonly string[],
): boolean {
  if (serverIds.length >= clientIds.length || clientIds.length === 0) {
    return false;
  }
  const clientSet = new Set(clientIds);
  for (const id of serverIds) {
    if (!clientSet.has(id)) {
      return false;
    }
  }
  return true;
}

/** What thread messages can do from the timeline: retry after a macOS permission, run code. */
function TimelineActionContexts({
  computerUseRetry,
  shellRunTarget,
  children,
}: {
  computerUseRetry: ((text: string) => void) | null;
  shellRunTarget: ShellRunTarget | null;
  children: ReactNode;
}) {
  return (
    <ComputerUseRetryContext value={computerUseRetry}>
      <ShellRunTargetContext value={shellRunTarget}>{children}</ShellRunTargetContext>
    </ComputerUseRetryContext>
  );
}

interface PersistentThreadTerminalDrawerProps {
  threadRef: { environmentId: EnvironmentId; threadId: ThreadId };
  threadId: ThreadId;
  active: boolean;
  launchContext: PersistentTerminalLaunchContext | null;
  focusRequestId: number;
  splitShortcutLabel: string | undefined;
  splitVerticalShortcutLabel: string | undefined;
  newShortcutLabel: string | undefined;
  closeShortcutLabel: string | undefined;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

const PersistentThreadTerminalDrawer = memo(function PersistentThreadTerminalDrawer({
  threadRef,
  threadId,
  active,
  launchContext,
  focusRequestId,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  keybindings,
  onAddTerminalContext,
}: PersistentThreadTerminalDrawerProps) {
  const canOperateTerminal = useEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope);
  const hasTerminalWriteAccess = useCallback(
    () => readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope),
    [threadRef.environmentId],
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const serverThread = useThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef),
  );
  const visible = active && terminalUiState.terminalOpen;
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId,
  });
  const panelSurfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );
  const panelTerminalIds = useMemo(
    () =>
      new Set(
        panelSurfaces.flatMap((surface) =>
          surface.kind === "terminal" ? surface.terminalIds : [],
        ),
      ),
    [panelSurfaces],
  );
  const drawerTerminalSessions = useMemo(
    () =>
      knownTerminalSessions?.filter(
        (session) =>
          !panelTerminalIds.has(session.target.terminalId) &&
          // A code block's run shows its output under the block, not as a tab.
          !isInlineRunTerminalId(session.target.terminalId),
      ) ?? [],
    [knownTerminalSessions, panelTerminalIds],
  );
  const terminalLabelsById = useMemo(() => {
    const next = new Map<string, string>();
    for (const session of drawerTerminalSessions) {
      next.set(
        session.target.terminalId,
        resolveTerminalTabTitle(session.target.terminalId, session.state.summary),
      );
    }
    return next;
  }, [drawerTerminalSessions]);
  const terminalLaunchLocationsById = useMemo(() => {
    const next = new Map<
      string,
      {
        readonly cwd: string;
        readonly worktreePath: string | null;
        readonly runtimeEnv: Record<string, string>;
      }
    >();
    if (!project) {
      return next;
    }

    for (const session of drawerTerminalSessions) {
      const summary = session.state.summary;
      if (!summary) {
        continue;
      }
      const worktreePathForLaunch =
        launchContext !== null ? launchContext.worktreePath : summary.worktreePath;
      next.set(session.target.terminalId, {
        cwd: launchContext?.cwd ?? summary.cwd,
        worktreePath: worktreePathForLaunch,
        runtimeEnv: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: worktreePathForLaunch,
        }),
      });
    }

    return next;
  }, [drawerTerminalSessions, launchContext, project]);
  const serverOrderedTerminalIds = useMemo(
    () => drawerTerminalSessions.map((session) => session.target.terminalId),
    [drawerTerminalSessions],
  );
  // Every client-side id source participates in allocation: the server list
  // lags fresh opens, and panel terminals are filtered out of the drawer's
  // sessions — an id collision attaches two viewports to one PTY session.
  const allocatableTerminalIds = useMemo(
    () => [
      ...new Set([
        ...serverOrderedTerminalIds,
        ...terminalUiState.terminalIds,
        ...panelTerminalIds,
      ]),
    ],
    [panelTerminalIds, serverOrderedTerminalIds, terminalUiState.terminalIds],
  );
  const allocateTerminalId = useCallback(
    () =>
      nextTerminalId(
        allocatableTerminalIds,
        knownTerminalSessions === null ||
          !readEnvironmentScope(threadRef.environmentId, AuthTerminalReadScope)
          ? randomUUID()
          : undefined,
      ),
    [allocatableTerminalIds, knownTerminalSessions, threadRef.environmentId],
  );
  const storeSetTerminalHeight = useTerminalUiStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalUiStateStore((state) => state.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore(
    (state) => state.splitTerminalVertical,
  );
  const storeNewTerminal = useTerminalUiStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalUiStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((state) => state.closeTerminal);
  const reconcileTerminalIds = useTerminalUiStateStore((state) => state.reconcileTerminalIds);

  useEffect(() => {
    if (terminalIdListsEqual(serverOrderedTerminalIds, terminalUiState.terminalIds)) {
      return;
    }
    if (
      serverTerminalIdsStrictSubsetOfClient(serverOrderedTerminalIds, terminalUiState.terminalIds)
    ) {
      return;
    }
    reconcileTerminalIds(threadRef, serverOrderedTerminalIds);
  }, [reconcileTerminalIds, serverOrderedTerminalIds, terminalUiState.terminalIds, threadRef]);
  const [localFocusRequestId, setLocalFocusRequestId] = useState(0);
  const worktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const effectiveWorktreePath = useMemo(() => {
    if (launchContext !== null) {
      return launchContext.worktreePath;
    }
    return worktreePath;
  }, [launchContext, worktreePath]);
  const cwd = useMemo(
    () =>
      launchContext?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.workspaceRoot },
            worktreePath: effectiveWorktreePath,
          })
        : null),
    [effectiveWorktreePath, launchContext?.cwd, project],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.workspaceRoot },
            worktreePath: effectiveWorktreePath,
          })
        : {},
    [effectiveWorktreePath, project],
  );

  const bumpFocusRequestId = useCallback(() => {
    if (!visible) {
      return;
    }
    setLocalFocusRequestId((value) => value + 1);
  }, [visible]);

  const setTerminalHeight = useCallback(
    (height: number) => {
      storeSetTerminalHeight(threadRef, height);
    },
    [storeSetTerminalHeight, threadRef],
  );

  const splitTerminal = useCallback(() => {
    if (!hasTerminalWriteAccess() || !cwd) {
      return;
    }
    const terminalId = allocateTerminalId();
    storeSplitTerminal(threadRef, terminalId);
    bumpFocusRequestId();
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(project ? { fallbackCwd: project.workspaceRoot } : {}),
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      },
    });
  }, [
    allocateTerminalId,
    bumpFocusRequestId,
    cwd,
    effectiveWorktreePath,
    project,
    runtimeEnv,
    storeSplitTerminal,
    threadId,
    threadRef,
    openTerminal,
    hasTerminalWriteAccess,
  ]);
  const splitTerminalVertical = useCallback(() => {
    if (!hasTerminalWriteAccess() || !cwd) {
      return;
    }
    const terminalId = allocateTerminalId();
    storeSplitTerminalVertical(threadRef, terminalId);
    bumpFocusRequestId();
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(project ? { fallbackCwd: project.workspaceRoot } : {}),
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      },
    });
  }, [
    allocateTerminalId,
    bumpFocusRequestId,
    cwd,
    effectiveWorktreePath,
    project,
    openTerminal,
    hasTerminalWriteAccess,
    runtimeEnv,
    storeSplitTerminalVertical,
    threadId,
    threadRef,
  ]);

  const createNewTerminal = useCallback(() => {
    if (!hasTerminalWriteAccess() || !cwd) {
      return;
    }
    const terminalId = allocateTerminalId();
    storeNewTerminal(threadRef, terminalId);
    bumpFocusRequestId();
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        ...(project ? { fallbackCwd: project.workspaceRoot } : {}),
        ...(effectiveWorktreePath != null ? { worktreePath: effectiveWorktreePath } : {}),
        env: runtimeEnv,
      },
    });
  }, [
    bumpFocusRequestId,
    cwd,
    effectiveWorktreePath,
    project,
    allocateTerminalId,
    runtimeEnv,
    storeNewTerminal,
    threadId,
    threadRef,
    openTerminal,
    hasTerminalWriteAccess,
  ]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      storeSetActiveTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeSetActiveTerminal, threadRef],
  );

  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (!hasTerminalWriteAccess()) return;
      const fallbackExitWrite = () =>
        writeTerminal({
          environmentId: threadRef.environmentId,
          input: { threadId, terminalId, data: "exit\n" },
        });

      void (async () => {
        const closeResult = await closeTerminalMutation({
          environmentId: threadRef.environmentId,
          input: {
            threadId,
            terminalId,
            deleteHistory: true,
          },
        });
        if (
          closeResult._tag === "Failure" &&
          !isAtomCommandInterrupted(closeResult) &&
          hasTerminalWriteAccess()
        ) {
          await fallbackExitWrite();
        }
      })();

      storeCloseTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [
      bumpFocusRequestId,
      storeCloseTerminal,
      threadId,
      threadRef,
      closeTerminalMutation,
      hasTerminalWriteAccess,
      writeTerminal,
    ],
  );

  const handleAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      if (!visible) {
        return;
      }
      onAddTerminalContext(selection);
    },
    [onAddTerminalContext, visible],
  );

  if (!project || (!terminalUiState.terminalOpen && !active) || !cwd) {
    return null;
  }

  return (
    <div
      className={cn(
        "grid shrink-0 overflow-clip",
        active ? (visible ? "grid-rows-[1fr]" : "grid-rows-[0fr]") : "hidden",
        active &&
          "[[data-panel-animations=true]_&]:transition-[grid-template-rows] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:ease-out",
        active && visible && "[[data-panel-animations=true]_&]:starting:grid-rows-[0fr]!",
      )}
    >
      <div className="min-h-0 overflow-clip">
        <ThreadTerminalDrawer
          threadRef={threadRef}
          threadId={threadId}
          cwd={cwd}
          fallbackCwd={project.workspaceRoot}
          worktreePath={effectiveWorktreePath}
          runtimeEnv={runtimeEnv}
          visible={visible}
          height={terminalUiState.terminalHeight}
          // Known-session order is MRU and changes on focus; persisted store order keeps sidebar labels stable.
          terminalIds={canOperateTerminal ? terminalUiState.terminalIds : serverOrderedTerminalIds}
          activeTerminalId={terminalUiState.activeTerminalId}
          terminalGroups={terminalUiState.terminalGroups}
          activeTerminalGroupId={terminalUiState.activeTerminalGroupId}
          focusRequestId={focusRequestId + localFocusRequestId + (visible ? 1 : 0)}
          onSplitTerminal={splitTerminal}
          onSplitTerminalVertical={splitTerminalVertical}
          onNewTerminal={createNewTerminal}
          splitShortcutLabel={visible ? splitShortcutLabel : undefined}
          splitVerticalShortcutLabel={visible ? splitVerticalShortcutLabel : undefined}
          newShortcutLabel={visible ? newShortcutLabel : undefined}
          closeShortcutLabel={visible ? closeShortcutLabel : undefined}
          keybindings={keybindings}
          onActiveTerminalChange={activateTerminal}
          onCloseTerminal={closeTerminal}
          onHeightChange={setTerminalHeight}
          onAddTerminalContext={handleAddTerminalContext}
          terminalLabelsById={terminalLabelsById}
          terminalLaunchLocationsById={terminalLaunchLocationsById}
        />
      </div>
    </div>
  );
});

interface PersistentThreadTerminalPanelProps {
  visible: boolean;
  threadRef: ScopedThreadRef;
  surface: Extract<RightPanelSurface, { kind: "terminal" }>;
  launchContext: PersistentTerminalLaunchContext | null;
  focusRequestId: number;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onSplitTerminal: () => void;
  onSplitTerminalVertical: () => void;
  onNewTerminal: () => void;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  splitShortcutLabel?: string | undefined;
  splitVerticalShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
}

const PersistentThreadTerminalPanel = memo(function PersistentThreadTerminalPanel({
  visible,
  threadRef,
  surface,
  launchContext,
  focusRequestId,
  keybindings,
  onAddTerminalContext,
  onSplitTerminal,
  onSplitTerminalVertical,
  onNewTerminal,
  onActiveTerminalChange,
  onCloseTerminal,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
}: PersistentThreadTerminalPanelProps) {
  const serverThread = useThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const threadWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const activeSummary =
    knownTerminalSessions?.find((session) => session.target.terminalId === surface.activeTerminalId)
      ?.state.summary ?? null;
  const worktreePath =
    launchContext?.worktreePath ?? activeSummary?.worktreePath ?? threadWorktreePath;
  const cwd = useMemo(
    () =>
      launchContext?.cwd ??
      activeSummary?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.workspaceRoot },
            worktreePath,
          })
        : null),
    [activeSummary?.cwd, launchContext?.cwd, project, worktreePath],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.workspaceRoot },
            worktreePath,
          })
        : {},
    [project, worktreePath],
  );
  const terminalLabelsById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const terminalId of surface.terminalIds) {
      const summary =
        knownTerminalSessions?.find((session) => session.target.terminalId === terminalId)?.state
          .summary ?? null;
      labels.set(terminalId, resolveTerminalTabTitle(terminalId, summary));
    }
    return labels;
  }, [knownTerminalSessions, surface.terminalIds]);
  const terminalLaunchLocationsById = useMemo(() => {
    const locations = new Map<
      string,
      {
        readonly cwd: string;
        readonly worktreePath: string | null;
        readonly runtimeEnv: Record<string, string>;
      }
    >();
    for (const terminalId of surface.terminalIds) {
      const summary =
        knownTerminalSessions?.find((session) => session.target.terminalId === terminalId)?.state
          .summary ?? null;
      const terminalWorktreePath =
        launchContext?.worktreePath ?? summary?.worktreePath ?? threadWorktreePath;
      const terminalCwd =
        launchContext?.cwd ??
        summary?.cwd ??
        (project
          ? projectScriptCwd({
              project: { cwd: project.workspaceRoot },
              worktreePath: terminalWorktreePath,
            })
          : null);
      if (!terminalCwd || !project) continue;
      locations.set(terminalId, {
        cwd: terminalCwd,
        worktreePath: terminalWorktreePath,
        runtimeEnv: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: terminalWorktreePath,
        }),
      });
    }
    return locations;
  }, [
    knownTerminalSessions,
    launchContext?.cwd,
    launchContext?.worktreePath,
    project,
    surface.terminalIds,
    threadWorktreePath,
  ]);

  if (!project || !cwd) return null;

  return (
    <ThreadTerminalDrawer
      mode="panel"
      visible={visible}
      threadRef={threadRef}
      threadId={threadRef.threadId}
      cwd={cwd}
      fallbackCwd={project.workspaceRoot}
      worktreePath={worktreePath}
      runtimeEnv={runtimeEnv}
      height={0}
      terminalIds={surface.terminalIds}
      activeTerminalId={surface.activeTerminalId}
      terminalGroups={[
        {
          id: surface.id,
          terminalIds: surface.terminalIds,
          ...(surface.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
        },
      ]}
      activeTerminalGroupId={surface.id}
      focusRequestId={focusRequestId}
      onSplitTerminal={onSplitTerminal}
      onSplitTerminalVertical={onSplitTerminalVertical}
      onNewTerminal={onNewTerminal}
      splitShortcutLabel={splitShortcutLabel}
      splitVerticalShortcutLabel={splitVerticalShortcutLabel}
      newShortcutLabel={newShortcutLabel}
      closeShortcutLabel={closeShortcutLabel}
      onActiveTerminalChange={onActiveTerminalChange}
      onCloseTerminal={onCloseTerminal}
      onHeightChange={() => undefined}
      onAddTerminalContext={onAddTerminalContext}
      terminalLabelsById={terminalLabelsById}
      terminalLaunchLocationsById={terminalLaunchLocationsById}
      keybindings={keybindings}
    />
  );
});

// Errors surface through two maps (draft-keyed and thread-keyed) whose entries
// can race around promotion, so each write carries its time to let the latest
// one win when they collide.
type LocalThreadErrorEntry = {
  readonly message: string | null;
  readonly at: number;
};

function chatActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

const ENVIRONMENT_UNAVAILABLE_SEND_TOAST_TRAIL_SIZE = 3;
const EMPTY_HELD_TURN_DIFF_SUMMARIES: readonly never[] = [];
const EMPTY_HELD_PROVIDER_SESSIONS: readonly never[] = [];
const noopHeldTurnDiff = (_turnId: RunId, _filePath?: string) => {};
const noopHeldRevert = (_targetTurnCount: number) => {};
const noopHeldAttachment = (_attachment: ChatFileAttachment) => {};

/**
 * Drops the send-time anchored end space. That space is what holds a sent
 * message near the top while its turn streams, and it keeps LegendList's
 * maintainScrollAtEnd switched off for as long as it is installed. Tool
 * activity and every return to the live edge release the anchor, otherwise
 * the timeline settles into "following-end" with nothing following anything.
 */
function releaseChatTimelineAnchor<T extends { readonly messageId: MessageId | null }>(
  current: T,
): T {
  return current.messageId === null ? current : { ...current, messageId: null };
}

/** Runs with a workspace preparation retry in flight, across ChatView instances. */
const retryingWorkspacePreparationRunIds = new Set<RunId>();

/**
 * The fan-out state's selections and its mutable boxes as separate values. Read
 * as properties in ChatView, the boxes' `Ref` names made the React Compiler
 * treat the whole state, selections too, as a ref read while rendering.
 */
function useDraftFanoutState(atom: ReturnType<typeof draftFanoutStateAtom>) {
  const state = useAtomValue(atom);
  return {
    selections: state.selections,
    sendInFlightRef: state.sendInFlight,
    uncertainSubmissionsRef: state.uncertainSubmissions,
  };
}

/**
 * A banner item built while rendering. A hook, so the React Compiler accepts
 * the item's handlers reading refs: it cannot tell a plain builder only stores
 * them for a click.
 */
function useBannerItem<I, O>(build: (input: I) => O, input: I | null): O | null {
  return input === null ? null : build(input);
}

/**
 * A draft's model before the user picks one. Outside ChatView: the React
 * Compiler fails on these nested `??` inside the draft's memo.
 */
function draftDefaultModelSelection(
  settings: Parameters<typeof resolveProjectSettings>[0],
  project: ReturnType<typeof useProject>,
) {
  return (
    resolveProjectSettings(settings, project?.id ?? null, project ?? undefined).settings
      .defaultModelSelection ?? NO_PROVIDER_MODEL_SELECTION
  );
}

/**
 * The time of this render. A hook outside the compiler, so what reads it is
 * worked out again on every render, as it was before ChatView compiled: an
 * expired error or a passed reset would otherwise wait for another input.
 */
function useRenderTime(): number {
  "use no memo";
  return Date.now();
}

/**
 * A value read from outside React on every render: a session's dismissed set, a
 * timeline cache or the clock. ChatView re-renders to pick these up (a dismissal
 * bumps a tick); compiled, a plain call would be cached until its arguments change.
 */
function useRenderRead<T>(read: () => T): T {
  "use no memo";
  return read();
}

type TimelineInput = Parameters<typeof deriveTimelineEntriesFromVisibleTurnItemsWithState>[0];
type TimelineProjection = ReturnType<typeof deriveTimelineEntriesFromVisibleTurnItemsWithState>;

/**
 * The thread's timeline entries, sharing unchanged rows with the previous
 * projection of the same thread. That reads and writes a ref while rendering,
 * which the React Compiler rejects, so it is kept out of ChatView: only this
 * hook goes unoptimized.
 */
function useServerTimelineEntries(
  threadKey: string | null,
  visibleTurnItems: NonNullable<TimelineInput["visibleTurnItems"]>,
  optimisticMessages: NonNullable<TimelineInput["optimisticMessages"]>,
  anchoredMessages: NonNullable<TimelineInput["anchoredMessages"]>,
  attachmentUrlById: NonNullable<TimelineInput["attachmentUrlById"]>,
  projection: {
    readonly attempts: NonNullable<TimelineInput["attempts"]>;
    readonly nodes: NonNullable<TimelineInput["nodes"]>;
    readonly plans: NonNullable<TimelineInput["plans"]>;
  } | null,
) {
  "use no memo";
  const previousRef = useRef<{
    readonly threadKey: string | null;
    readonly projection: TimelineProjection;
  } | null>(null);
  return useMemo(() => {
    const previous = previousRef.current;
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(
      {
        visibleTurnItems,
        optimisticMessages,
        anchoredMessages,
        attachmentUrlById,
        ...(projection === null
          ? {}
          : { attempts: projection.attempts, nodes: projection.nodes, plans: projection.plans }),
      },
      previous?.threadKey === threadKey ? previous.projection : null,
    );
    previousRef.current = { threadKey, projection: next };
    return next.entries;
  }, [
    threadKey,
    visibleTurnItems,
    optimisticMessages,
    anchoredMessages,
    attachmentUrlById,
    projection,
  ]);
}

/**
 * ChatView's state, the first part of its body. ChatView is split into this,
 * useChatViewActions and the rest because the React Compiler overflows its
 * stack on one function this long and then leaves the whole view unoptimized.
 */
function useChatViewState(props: ChatViewProps) {
  const renderNowMs = useRenderTime();
  const projectRouting = useProjectMessageRouting();
  // Inside a project's panel a thread link opens in the same panel.
  const { openThread: openThreadRoute } = useOpenThread();
  const {
    environmentId,
    threadId,
    routeKind,
    onDiffPanelOpen,
    reserveTitleBarControlInset = true,
    layoutMode = "workspace",
    reviewOnly = false,
    transcriptOnly = false,
    suspendShortcuts = false,
    embeddedHeaderToolsTarget = null,
    forceExpandedMobileComposer = false,
  } = props;
  // While the viewer overlay is in front, a thread behind it leaves keys and
  // pastes alone; the overlay's own copy of the thread takes them.
  const inViewerOverlay = useContext(InViewerOverlay);
  const viewerOverlayOpen = useViewerOverlayStore((state) => state.active !== null);
  const behindViewerOverlay = viewerOverlayOpen && !inViewerOverlay;
  const suspendChatInput = reviewOnly || transcriptOnly || suspendShortcuts || behindViewerOverlay;
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const hasTerminalWriteAccess = useCallback(
    () => readEnvironmentScope(environmentId, AuthTerminalOperateScope),
    [environmentId],
  );
  const canReadTerminal = useEnvironmentScope(environmentId, AuthTerminalReadScope);
  const draftId = routeKind === "draft" ? props.draftId : null;
  const handleNewThread = useNewThreadHandler();
  const openNewChatDestination = useNewChatDestination();
  const openCoordinatorHandoff = useProjectCoordinatorHandoff();
  const { settleThread, pinThread, confirmAndUnpinThread } = useThreadActions();
  const routeThreadTarget = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const routeThreadKey = useMemo(() => scopedThreadKey(routeThreadTarget), [routeThreadTarget]);
  const currentRouteThreadKeyRef = useRef<string | null>(routeThreadKey);
  useLayoutEffect(() => {
    currentRouteThreadKeyRef.current = routeThreadKey;
    return () => {
      currentRouteThreadKeyRef.current = null;
    };
  }, [routeThreadKey]);
  const updateProjectScriptSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding, {
    reportFailure: false,
  });
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const closeIdleTerminalsMutation = useAtomCommand(
    terminalEnvironment.closeIdle,
    "terminal close idle",
  );
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const deleteThread = useOrchestrationCommand(threadEnvironment.delete, { reportFailure: false });
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const switchGitRevision = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const setThreadRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useOrchestrationCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const resumeThreadQueue = useOrchestrationCommand(threadEnvironment.resumeThreadQueue, {
    reportFailure: false,
  });
  const uploadThreadFeedback = useOrchestrationCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const interruptThreadTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const loadEarlierThreadHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  const respondToThreadApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToThreadUserInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const dismissThreadUserInput = useAtomCommand(threadEnvironment.dismissUserInput, {
    reportFailure: false,
  });
  const revertThreadCheckpoint = useOrchestrationCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const forkThreadFromRun = useAtomCommand(threadEnvironment.forkFromRun, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const setEnvironmentEnabled = useAtomCommand(environmentCatalog.setEnabled, {
    reportFailure: false,
  });
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );
  // Queued-message edit mode. While active, the composer is retargeted to a
  // per-run edit draft so the user's in-progress draft on the thread survives
  // untouched; `existingAttachments` tracks which stored attachments the edit
  // keeps (removal is client state until save).
  const [editingQueuedRun, setEditingQueuedRun] = useState<{
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly messageId: MessageId;
    readonly originalText: string;
    readonly existingAttachments: ReadonlyArray<ContractChatAttachment>;
    readonly context?:
      | import("@specweave-studio/contracts").OrchestrationMessageContext
      | undefined;
  } | null>(null);
  const queuedEditDraftTargetFor = useCallback(
    (runId: RunId) => DraftId.make(`queued-edit:${scopedThreadKey(routeThreadTarget)}:${runId}`),
    [routeThreadTarget],
  );
  const baseComposerDraftTarget: ScopedThreadRef | DraftId =
    routeKind === "server" ? routeThreadTarget : props.draftId;
  const composerDraftTarget: ScopedThreadRef | DraftId =
    editingQueuedRun === null
      ? baseComposerDraftTarget
      : queuedEditDraftTargetFor(editingQueuedRun.runId);
  // Unsent text and attachments come back after a crash or from another window.
  useDurableThreadDraftRestore(baseComposerDraftTarget);
  const draftThread = useComposerDraftStore((store) =>
    routeKind === "server"
      ? store.getDraftSessionByRef(routeThreadTarget)
      : draftId
        ? store.getDraftSession(draftId)
        : null,
  );
  const serverThread = useThreadShell(routeThreadTarget);
  const routeThreadDetailTarget = resolveThreadDetailRef(routeThreadTarget, {
    shellExists: serverThread !== null,
    waitForShell: draftThread !== null,
  });
  const serverThreadProjection = useThreadProjection(routeThreadDetailTarget);
  const serverProjection = serverThreadProjection?.projection ?? null;
  // A subagent's bar reads its parent's record too, so it says what the parent's list says.
  const subagentParentId =
    serverThread?.lineage.relationshipToParent === "subagent"
      ? serverThread.lineage.parentThreadId
      : null;
  const subagentParentRef = useMemo(
    () =>
      serverThread === null || subagentParentId === null
        ? null
        : scopeThreadRef(serverThread.environmentId, subagentParentId),
    [serverThread?.environmentId, subagentParentId],
  );
  const subagentParentRecords =
    useThreadProjection(subagentParentRef)?.projection.subagents ?? NO_SUBAGENT_RECORDS;
  // Placement as the list reads it: the parent's shell and the hosts that do not answer.
  const subagentParentShell = useThreadShell(subagentParentRef);
  const unreachableHosts = useUnreachableHosts();
  const subagentExecution = useMemo(
    () => ({ thread: serverThread, parent: subagentParentShell, unreachable: unreachableHosts }),
    [serverThread, subagentParentShell, unreachableHosts],
  );
  const reportedModelSelection = serverProjection
    ? deriveReportedModelSelection(serverProjection)
    : null;
  const threadStatus = useThreadStatus(routeThreadDetailTarget);
  const threadSyncError = useThreadError(routeThreadDetailTarget);
  // The thread last shown as stale. Kept until it goes live so a retry, which
  // clears the error while it runs, does not blink the row off and on.
  const [threadSyncStaleKey, setThreadSyncStaleKey] = useState<string | null>(null);
  const threadSyncInput = {
    detailExists: serverProjection !== null,
    shellExists: serverThread !== null,
    status: threadStatus,
    error: threadSyncError,
    staleHeld: routeThreadKey !== null && threadSyncStaleKey === routeThreadKey,
  };
  // Catching up after a reconnect usually takes well under a second; show the
  // syncing row only once it outlasts the same grace as the reconnect warning.
  const threadSyncPendingKey =
    resolveThreadSyncPhase({ ...threadSyncInput, syncGraceElapsed: true }) === "syncing"
      ? routeThreadKey
      : null;
  const [threadSyncGraceElapsedKey, setThreadSyncGraceElapsedKey] = useState<string | null>(null);
  useEffect(() => {
    setThreadSyncGraceElapsedKey(null);
    if (threadSyncPendingKey === null) return;
    return scheduleEnvironmentReconnectWarning(() =>
      setThreadSyncGraceElapsedKey(threadSyncPendingKey),
    );
  }, [threadSyncPendingKey]);
  const threadSyncPhase = resolveThreadSyncPhase({
    ...threadSyncInput,
    syncGraceElapsed:
      threadSyncPendingKey !== null && threadSyncGraceElapsedKey === threadSyncPendingKey,
  });
  useEffect(() => {
    setThreadSyncStaleKey(threadSyncPhase === "stale" ? routeThreadKey : null);
  }, [threadSyncPhase, routeThreadKey]);
  const threadDetailLoading = threadSyncPhase === "loading";
  // Latest provider-reported context usage (#8144): the newest turn that has
  // a report wins; stale turns keep the meter alive between turns.
  const activeThreadLiveTokenUsage = useMemo(() => {
    const turns = serverProjection?.providerTurns;
    if (!turns || turns.length === 0) return null;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const usage = turns[index]?.tokenUsage;
      if (usage !== undefined) return usage;
    }
    return null;
  }, [serverProjection?.providerTurns]);
  const serverVisibleTurnItems = useThreadVisibleTurnItems(routeThreadDetailTarget);
  const serverThreadHistory = useThreadHistory(routeThreadDetailTarget);
  const threadHistoryControls = useMemo<MessagesTimelineHistoryControls | undefined>(() => {
    if (routeThreadDetailTarget === null || !shouldShowLoadEarlierControl(serverThreadHistory)) {
      return undefined;
    }
    return {
      hasMoreHistory: serverThreadHistory.hasMoreHistory,
      loading: serverThreadHistory.loading,
      error: serverThreadHistory.error,
      windowTurnStartKey: serverThreadHistory.windowTurnStartKey,
      onLoadEarlier: () => {
        void loadEarlierThreadHistory({
          environmentId: routeThreadDetailTarget.environmentId,
          input: { threadId: routeThreadDetailTarget.threadId },
        });
      },
    };
  }, [loadEarlierThreadHistory, routeThreadDetailTarget, serverThreadHistory]);
  const committedServerMessageIds = useMemo(
    () => deriveCommittedServerUserMessageIds(serverVisibleTurnItems),
    [serverVisibleTurnItems],
  );
  // Queued messages have no turn item until their run starts, so the
  // turn-item-derived set alone can never retire their optimistic rows —
  // cancelling such a run would leave a phantom "pending" queue row behind.
  // Union in the projection's user messages: once the server holds the
  // message, the optimistic copy is redundant everywhere it could render.
  const serverAcknowledgedUserMessageIds = useMemo(() => {
    const ids = new Set(committedServerMessageIds);
    for (const message of serverProjection?.messages ?? []) {
      if (message.role === "user") ids.add(message.id);
    }
    return ids;
  }, [committedServerMessageIds, serverProjection]);
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const activeThreadLocalLastVisitedAt = useUiStateStore(
    (store) => store.threadLastVisitedAtById[routeThreadKey],
  );
  const visitThreadMutation = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const lastDispatchedVisitRef = useRef<string | null>(null);
  const lastVisitDispatchAtRef = useRef(0);
  const settings = useEnvironmentSettings(environmentId);
  const clientSettingsHydrated = useClientSettingsHydrated();
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const navigate = useNavigate();
  const citationLocation = useLocation({
    select: (location) => ({
      href: location.href,
      key: location.state.assistantCitationActivation ?? location.state.__TSR_key,
    }),
  });
  const citationRequest = useMemo<AssistantCitationRequest | null>(() => {
    const citation = assistantCitationFromLocation(citationLocation.href);
    return citation && citation.environmentId === environmentId && citation.threadId === threadId
      ? { citation, key: citationLocation.key ?? citationLocation.href }
      : null;
  }, [citationLocation.href, citationLocation.key, environmentId, threadId]);
  const { resolvedTheme } = useTheme();
  // Granular store selectors — avoid subscribing to prompt changes.
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const composerInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.interactionMode ?? null,
  );
  const composerActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  const composerModelSelectionExplicit = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.modelSelectionExplicit === true,
  );
  const composerActiveSelection = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return draft?.activeProvider
      ? (draft.modelSelectionByProvider[draft.activeProvider] ?? null)
      : null;
  });
  const composerHasAttachments = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return (draft?.images.length ?? 0) > 0 || (draft?.files.length ?? 0) > 0;
  });
  // Anything beyond the prompt text: attachments, terminal or element contexts, annotations.
  const composerHasNonPromptContent = useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(composerDraftTarget);
    return draft ? composerDraftHasUserContent({ ...draft, prompt: "" }) : false;
  });
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const addComposerDraftFiles = useComposerDraftStore((store) => store.addFiles);
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const setComposerDraftPreviewAnnotations = useComposerDraftStore(
    (store) => store.setPreviewAnnotations,
  );
  const setComposerDraftReviewComments = useComposerDraftStore((store) => store.setReviewComments);
  const setComposerDraftThreadContexts = useComposerDraftStore((store) => store.setThreadContexts);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSessionByLogicalProjectKey = useComposerDraftStore(
    (store) => store.getDraftSessionByLogicalProjectKey,
  );
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const composerRef = useComposerHandleContext() ?? localComposerRef;
  const branchToolbarRef = useRef<BranchToolbarHandle>(null);
  const pasteAsTextShortcutUntilRef = useRef(0);
  const [restingComposerControlsHost, setRestingComposerControlsHost] =
    useState<HTMLDivElement | null>(null);
  const [restingComposerControlsVisible, setRestingComposerControlsVisible] = useState(false);
  const citeAssistantText = useCallback(
    (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => {
      const inserted = composerRef.current?.citeAssistantText(citation, sourceAnchor) ?? false;
      if (!inserted) {
        toastManager.add({
          type: "warning",
          title: "The composer is not ready",
          description:
            "Try citing the selection after the connection or pending input is resolved.",
        });
      }
      return inserted;
    },
    [composerRef],
  );
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isWorkspaceFileDragActive, setIsWorkspaceFileDragActive] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  useEffect(() => {
    const item = expandedImage?.images[expandedImage.index];
    if (item?.type !== "video" || item.src === null || !item.src.startsWith("blob:")) return;
    const src = item.src;
    return () => revokeBlobPreviewUrl(src);
  }, [expandedImage]);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  // Last live snapshot from the setup stream. The server drops a finished
  // snapshot after a grace period and emits null; holding it here bridges the
  // gap until the settled activity arrives on the thread projection.
  const [worktreeSetupThread, setWorktreeSetupThread] = useState<{
    environmentId: EnvironmentId;
    threadId: ThreadId;
    ownerKey: string;
  } | null>(null);
  const [heldWorktreeSetup, setHeldWorktreeSetup] = useState<WorktreeSetupSnapshot | null>(null);
  // Set by "Work locally": the draft whose restored message should be resent
  // once the cancelled dispatch has settled and the draft is in local mode.
  // Keyed by draft id so a bootstrap rotating the thread id keeps it, while
  // moving to another draft drops it without an effect.
  const [workLocallyResendDraftId, setWorkLocallyResendDraftId] = useState<DraftId | null>(null);
  // The draft route reuses this component across drafts, so a resend recorded
  // for one draft must not fire when the user comes back to it later.
  useEffect(() => {
    if (workLocallyResendDraftId !== null && workLocallyResendDraftId !== draftId) {
      setWorkLocallyResendDraftId(null);
    }
  }, [draftId, workLocallyResendDraftId]);
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const feedbackSubmissions =
    feedbackSubmissionsByThreadKey[routeThreadKey] ?? EMPTY_FEEDBACK_SUBMISSIONS;
  const feedbackUploading = feedbackSubmissions.some(
    (submission) => submission.status === "uploading",
  );
  const optimisticUserMessagesRef = useLatestRef(optimisticUserMessages);
  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [localServerErrorsByThreadKey, setLocalServerErrorsByThreadKey] = useState<
    Record<string, LocalThreadErrorEntry>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const isRevertingCheckpoint = useComposerDraftStore((store) =>
    store.rewindingThreadKeys.has(routeThreadKey),
  );
  const [maximizedRightPanelThreadKey, setMaximizedRightPanelThreadKey] = useState<string | null>(
    null,
  );
  const userInputResponsesInFlight = useRef(new Set<string>());
  const [respondingRequestIds, setRespondingRequestIds] = useState<RuntimeRequestId[]>([]);

  useEffect(() => {
    setIsWorkspaceFileDragActive(false);
  }, [draftId, routeThreadKey]);

  useEffect(() => {
    if (!isWorkspaceFileDragActive) return;
    const clearWorkspaceFileDrag = () => setIsWorkspaceFileDragActive(false);
    window.addEventListener("dragend", clearWorkspaceFileDrag);
    return () => window.removeEventListener("dragend", clearWorkspaceFileDrag);
  }, [isWorkspaceFileDragActive]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    RuntimeRequestId[]
  >([]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const viewportUsesPlanSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const isPhoneKeyboard = usePhoneKeyboard();
  const [workspaceLayoutRef, workspaceLayoutWidth] = useElementWidth<HTMLDivElement>();
  // Banners overlay the top of the timeline; the timeline reserves their height.
  const [timelineBannerOverlayRef, timelineBannerOverlayHeight] =
    useElementHeight<HTMLDivElement>();
  const timelineBannerOverlayHeightRef = useLatestRef(timelineBannerOverlayHeight);
  const shouldUsePlanSidebarSheet = chatUsesPanelSheet(
    layoutMode,
    workspaceLayoutWidth,
    viewportUsesPlanSheet,
  );
  const threadPanelPopoverAnchorRef = useRef<HTMLElement | null>(null);
  // Tracks whether the user explicitly dismissed the sidebar for the active turn.
  // When set, the thread-change reset effect will open the sidebar instead of closing it.
  // Used by "Implement in a new thread" to carry the sidebar-open intent across navigation.
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [terminalUiLaunchContext, setTerminalUiLaunchContext] =
    useState<TerminalLaunchContext | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [pendingServerThreadEnvMode, setPendingServerThreadEnvMode] =
    useState<DraftThreadEnvMode | null>(null);
  const [pendingServerThreadBranch, setPendingServerThreadBranch] = useState<string | null>();
  const [
    pendingServerThreadStartFromOriginByThreadId,
    setPendingServerThreadStartFromOriginByThreadId,
  ] = useState<Record<string, boolean>>({});
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const legendListRef = useRef<LegendListRef | null>(null);
  const getTimelineScrollableNode = useCallback(
    () => legendListRef.current?.getScrollableNode() ?? null,
    [],
  );
  const [composerOverlayElement, setComposerOverlayElement] = useState<HTMLDivElement | null>(null);
  // Space the timeline keeps clear above its end. Tracks the overlay while the
  // composer is expanded and holds that height while it rests, so the resting
  // composer never exposes rows that its expansion will cover.
  const [composerTimelineInset, setComposerTimelineInset] = useState(0);
  const composerTimelineInsetRef = useRef(0);
  const composerRestingRef = useRef(false);
  // False while a status bar stands in for the composer (a native subagent).
  const composerMountedRef = useRef(true);
  const [scrollToEndClearance, setScrollToEndClearance] = useState(0);
  const isAtEndRef = useRef(true);
  const isTimelineAtLogicalEnd = useCallback(
    () => resolveTimelineIsAtEnd(legendListRef.current?.getState()) ?? isAtEndRef.current,
    [],
  );
  // Whether the timeline's rows extend past the viewport above the composer.
  // The composer only rests when there is reading space to give back.
  const [timelineOverflows, setTimelineOverflows] = useState(false);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewPromotionInFlightByMessageIdRef = useRef<Record<string, true>>({});
  const fanoutStateAtom = draftFanoutStateAtom(routeThreadKey);
  const {
    selections: multipleModelSelections,
    sendInFlightRef,
    uncertainSubmissionsRef: uncertainMultipleSubmissionsRef,
  } = useDraftFanoutState(fanoutStateAtom);
  const [resumingThreadKeys, setResumingThreadKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const isResuming = resumingThreadKeys.has(routeThreadKey);
  const composerSendGenerationRef = useRef(0);
  const setMultipleModelSelections = useCallback(
    (selections: SetStateAction<ReadonlyArray<ModelSelection> | null>) => {
      appAtomRegistry.update(fanoutStateAtom, (current) => ({
        ...current,
        selections: typeof selections === "function" ? selections(current.selections) : selections,
      }));
    },
    [fanoutStateAtom],
  );
  const multipleModelSelectionsRef = useLatestRef(multipleModelSelections);
  const environmentUnavailableSendToastSlotRef = useRef(0);
  const feedbackUploadsInFlightRef = useRef(new Set<string>());
  const terminalUiOpenByThreadRef = useRef<Record<string, boolean>>({});

  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadTarget),
  );
  const openTerminalThreadKeys = useTerminalUiStateStore(
    useShallow((state) =>
      Object.entries(state.terminalUiStateByThreadKey).flatMap(
        ([nextThreadKey, nextTerminalUiState]) =>
          nextTerminalUiState.terminalOpen ? [nextThreadKey] : [],
      ),
    ),
  );
  const storeSetTerminalOpen = useTerminalUiStateStore((s) => s.setTerminalOpen);
  const storeEnsureTerminal = useTerminalUiStateStore((state) => state.ensureTerminal);
  const storeSplitTerminal = useTerminalUiStateStore((s) => s.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore((s) => s.splitTerminalVertical);
  const storeNewTerminal = useTerminalUiStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalUiStateStore((s) => s.setActiveTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((s) => s.closeTerminal);
  const serverThreadRefs = useThreadRefs();
  const serverThreadKeys = useMemo(() => serverThreadRefs.map(scopedThreadKey), [serverThreadRefs]);
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftThreadKeys = useMemo(
    () =>
      Object.values(draftThreadsByThreadKey).map((draftThread) =>
        scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
      ),
    [draftThreadsByThreadKey],
  );
  const [mountedTerminalThreadKeys, setMountedTerminalThreadKeys] = useState<string[]>([]);
  const mountedTerminalThreadRefs = useMemo(
    () =>
      mountedTerminalThreadKeys.flatMap((mountedThreadKey) => {
        const mountedThreadRef = parseScopedThreadKey(mountedThreadKey);
        return mountedThreadRef ? [{ key: mountedThreadKey, threadRef: mountedThreadRef }] : [];
      }),
    [mountedTerminalThreadKeys],
  );

  const fallbackDraftProjectTarget = draftThread
    ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
    : null;
  const fallbackDraftProject = useProject(fallbackDraftProjectTarget);
  const localDraftError = serverThread
    ? null
    : ((draftId ? localDraftErrorsByDraftId[draftId]?.message : null) ?? null);
  const localServerError = localServerErrorsByThreadKey[routeThreadKey]?.message ?? null;
  // Draft errors are keyed by draftId while server errors are keyed by thread
  // key, so a pending draft entry must migrate when the server thread loads or
  // a failed send would silently disappear on promotion. When both keys hold
  // an entry, the most recent write wins.
  useEffect(() => {
    if (!serverThread || !draftId) {
      return;
    }
    const pendingDraftEntry = localDraftErrorsByDraftId[draftId];
    if (pendingDraftEntry === undefined) {
      return;
    }
    setLocalDraftErrorsByDraftId((existing) => {
      if (existing[draftId] === undefined) {
        return existing;
      }
      const next = { ...existing };
      delete next[draftId];
      return next;
    });
    setLocalServerErrorsByThreadKey((existing) => {
      const currentEntry = existing[routeThreadKey];
      if (
        currentEntry !== undefined &&
        (currentEntry.at > pendingDraftEntry.at ||
          currentEntry.message === pendingDraftEntry.message)
      ) {
        return existing;
      }
      return {
        ...existing,
        [routeThreadKey]: pendingDraftEntry,
      };
    });
  }, [draftId, localDraftErrorsByDraftId, routeThreadKey, serverThread]);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            draftDefaultModelSelection(settings, fallbackDraftProject),
          )
        : undefined,
    [draftThread, fallbackDraftProject, settings, threadId],
  );
  const isServerThread = serverThread !== null;
  const activeThread = isServerThread ? serverThread : localDraftThread;
  const serverLatestRun = useMemo(
    () => (serverProjection === null ? null : deriveLatestThreadRun(serverProjection)),
    [serverProjection],
  );
  const serverActivityRun = useMemo(
    () => (serverProjection === null ? null : deriveThreadActivityRun(serverProjection)),
    [serverProjection],
  );
  const serverRuntime = useMemo(
    () => (serverProjection === null ? null : deriveThreadRuntime(serverProjection)),
    [serverProjection],
  );
  const runlessWorkStartedAt = useMemo(
    () =>
      serverProjection === null
        ? null
        : deriveRunlessWorkStartedAt(serverProjection, subagentParentRecords, subagentExecution),
    [serverProjection, subagentParentRecords, subagentExecution],
  );
  const providerSubagentStatus = useMemo(
    () =>
      serverProjection === null
        ? null
        : deriveProviderSubagentStatus(serverProjection, subagentParentRecords, subagentExecution),
    [serverProjection, subagentParentRecords, subagentExecution],
  );
  const providerSubagentStep = useMemo(
    () =>
      serverProjection === null || !providerSubagentWorkActive(providerSubagentStatus)
        ? null
        : latestWorkStep(serverProjection.turnItems),
    [serverProjection, providerSubagentStatus],
  );
  const isProviderSubagent =
    serverThread !== null && isProviderNativeSubagentThread(serverThread.source);
  const activeLatestRun = isServerThread ? serverLatestRun : (activeThread?.latestRun ?? null);
  // Opening a thread first draws its cached copy, which can still show a turn
  // that ended while it was closed. Until fresh detail lands, the live shell
  // decides whether anything is running.
  const cachedDetailOutlivedRun =
    isServerThread &&
    threadStatus !== "live" &&
    serverThread !== null &&
    !threadRuntimeIsActive(serverThread.runtime) &&
    threadRuntimeIsActive(serverRuntime);
  const activeActivityRun = isServerThread
    ? cachedDetailOutlivedRun
      ? (serverThread?.latestRun ?? null)
      : serverActivityRun
    : (activeThread?.latestRun ?? null);
  const activeRuntime = isServerThread
    ? cachedDetailOutlivedRun
      ? (serverThread?.runtime ?? null)
      : serverRuntime
    : (activeThread?.runtime ?? null);
  const hasHeldQueuedRuns =
    isServerThread &&
    serverProjection?.runs.some((run) => run.status === "queued" && run.queueHeld === true) ===
      true;
  // Stopped, limited, or failed in a way Continue can pick up in place.
  const resumableRunId = useMemo(
    () =>
      !isServerThread || serverProjection === null
        ? null
        : resumableRunIdOf({
            runs: serverProjection.runs,
            turnItems: serverProjection.turnItems,
            lastErrorClass: serverRuntime?.lastErrorClass,
          }),
    [isServerThread, serverProjection, serverRuntime?.lastErrorClass],
  );
  const parentSubagentThreadId =
    activeThread?.lineage.relationshipToParent === "subagent"
      ? activeThread.lineage.parentThreadId
      : null;
  const parentSubagentEnvironmentId = activeThread?.environmentId ?? null;
  const parentSubagentThreadTarget = useMemo(() => {
    if (parentSubagentEnvironmentId === null || parentSubagentThreadId === null) {
      return null;
    }
    return scopeThreadRef(parentSubagentEnvironmentId, parentSubagentThreadId);
  }, [parentSubagentEnvironmentId, parentSubagentThreadId]);
  const parentSubagentThread = useThreadShell(parentSubagentThreadTarget);
  // A provider-native subagent's edits open its parent's turn diff (AC-19), so its timeline
  // reads the parent's subagents and runs. App-owned delegates open their own diff.
  const subagentParentProjection =
    useThreadProjection(isProviderSubagent ? parentSubagentThreadTarget : null)?.projection ?? null;
  const timelineSubagentParent = useMemo<TimelineSubagentParent | null>(
    () =>
      !isProviderSubagent || parentSubagentThreadId === null
        ? null
        : {
            threadId: parentSubagentThreadId,
            subagents: subagentParentProjection?.subagents ?? null,
            runs: subagentParentProjection?.runs ?? [],
          },
    [isProviderSubagent, parentSubagentThreadId, subagentParentProjection],
  );
  const parentThreadLink = useMemo(
    () =>
      parentSubagentThreadTarget === null
        ? null
        : {
            threadId: parentSubagentThreadTarget.threadId,
            title: parentSubagentThread?.title ?? "Parent thread",
          },
    [parentSubagentThread?.title, parentSubagentThreadTarget],
  );
  // Only the current turn's error is a banner. One from a run that ended long
  // ago, or on a resolved thread, stays in the timeline as a quiet note.
  const serverThreadSettled = serverProjection?.thread.settledOverride === "settled";
  const serverRuntimeError =
    serverRuntime?.lastError != null &&
    threadErrorIsLive({
      errorAt: serverRuntime.lastErrorAt,
      settled: serverThreadSettled,
      nowMs: renderNowMs,
    })
      ? serverRuntime.lastErrorClass == null
        ? serverRuntime.lastError
        : providerFailureDisplayMessage({
            class: serverRuntime.lastErrorClass,
            message: serverRuntime.lastError,
          })
      : null;
  const threadError = isServerThread ? (localServerError ?? serverRuntimeError) : localDraftError;
  // Dismissals can only mask the shown error, never clear it: a server thread
  // keeps its error in session.lastError, so clearing the local shadow would
  // just fall through to the persisted one. Mask the current error until a
  // different error arrives, mirroring the provider status banner.
  const threadErrorBannerKey = getThreadErrorBannerKey(routeThreadKey, threadError);
  const threadErrorBannerDismissed = useRenderRead(() =>
    isThreadErrorBannerDismissedForSession(threadErrorBannerKey),
  );
  const visibleThreadError = shouldShowThreadErrorBanner(
    routeThreadKey,
    threadError,
    threadErrorBannerDismissed,
  )
    ? threadError
    : null;
  // Dismissing only mutates the session-scoped mask set, which does not
  // trigger a render on its own; setThreadError(null) can also bail when the
  // local shadow is already empty and the banner is driven purely by
  // session.lastError. Bump a tick so the banner hides immediately. Mirrors
  // the branch mismatch banner.
  const [, setThreadErrorBannerDismissTick] = useState(0);
  const defaultRuntimeMode = resolveProjectSettings(settings, activeThread?.projectId ?? null)
    .settings.defaultRuntimeMode;
  // Implicit drafts follow their current project/environment, including retargets.
  // Explicit composer choices and existing server threads retain their permissions.
  const runtimeMode =
    composerRuntimeMode ??
    (isServerThread ? activeThread?.runtimeMode : undefined) ??
    defaultRuntimeMode;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = canWriteSourceControl && isLocalDraftThread;
  const activeThreadId = activeThread?.id ?? null;
  // Prefer the larger of turn-item-committed ids and projection messages so
  // env lock does not unlock while turn items lag projection hydration.
  const activeMessageCount = isServerThread
    ? Math.max(committedServerMessageIds.size, serverProjection?.messages.length ?? 0)
    : 0;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessionsRaw = useKnownTerminalSessions({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThreadId,
  });
  const activeThreadKnownSessions = useMemo(() => {
    if (activeThreadId === null || activeThreadKnownSessionsRaw === null) {
      return [];
    }
    return activeThreadKnownSessionsRaw.filter(
      (session) =>
        session.target.threadId === activeThreadId &&
        !isInlineRunTerminalId(session.target.terminalId),
    );
  }, [activeThreadId, activeThreadKnownSessionsRaw]);
  const activeServerOrderedTerminalIds = useMemo(
    () => activeThreadKnownSessions.map((session) => session.target.terminalId),
    [activeThreadKnownSessions],
  );
  const activeKnownTerminalIds = useMemo(
    () => [...new Set([...activeServerOrderedTerminalIds, ...terminalUiState.terminalIds])],
    [activeServerOrderedTerminalIds, terminalUiState.terminalIds],
  );
  const activeTerminalLabelsById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const session of activeThreadKnownSessions) {
      labels.set(
        session.target.terminalId,
        resolveTerminalTabTitle(session.target.terminalId, session.state.summary),
      );
    }
    return labels;
  }, [activeThreadKnownSessions]);
  const activeThreadTarget = useActiveThreadRef(activeThread);
  const activeThreadKey = activeThreadTarget ? scopedThreadKey(activeThreadTarget) : null;
  // Arriving at a thread shows its conversation; its right panel opens only on request.
  useHideRightPanelOnLeave(activeThreadTarget);
  const activeEnvironmentServerBrowser = useEnvironmentSupportsServerBrowser(
    activeThreadTarget?.environmentId ?? null,
  );
  // Electron hosts its own browser tabs; other clients need the environment to host them.
  const browserAvailable = isPreviewSupportedInRuntime() || activeEnvironmentServerBrowser;
  const previewPanelInlineSize = usePreviewPanelInlineSize(undefined, {
    containerWidth: workspaceLayoutWidth ?? undefined,
    widthStorageKey: `studio:preview-panel-width:${activeThreadKey}`,
  });
  const activeThreadShell = useThreadShell(isServerThread ? activeThreadTarget : null);
  // A switch the server made (the project's limit rule, or a continuation on
  // another provider) moves the composer with the thread, so the picker shows
  // the provider the next message goes to. A provider the user picked in the
  // composer is already there, so nothing is overwritten.
  const serverProviderInstanceId =
    isServerThread && activeThread ? activeThread.modelSelection.instanceId : null;
  const previousServerProviderRef = useRef<{
    key: string | null;
    instanceId: ProviderInstanceId | null;
  }>({ key: null, instanceId: null });
  // A seeded copy also follows a switch made while the chat was closed (a
  // reload, a reconnect, a project switch), so the composer and the sidebar
  // name the same provider. A pick the user has not sent yet stays.
  useEffect(() => {
    const previous = previousServerProviderRef.current;
    previousServerProviderRef.current = {
      key: activeThreadKey,
      instanceId: serverProviderInstanceId,
    };
    if (!isServerThread || !activeThread || serverProviderInstanceId === null) return;
    const sync = resolveComposerServerProviderSync({
      server: activeThread.modelSelection,
      serverChangedInPlace:
        previous.key === activeThreadKey &&
        previous.instanceId !== null &&
        previous.instanceId !== serverProviderInstanceId,
      draftProvider: composerActiveProvider,
      draftExplicit: composerModelSelectionExplicit,
      draftSelection: composerActiveSelection,
    });
    if (sync === "none") return;
    setComposerDraftModelSelection(
      scopeThreadRef(activeThread.environmentId, activeThread.id),
      sync === "adopt" && composerActiveSelection !== null
        ? composerActiveSelection
        : activeThread.modelSelection,
      { explicit: false, replaceOptions: true },
    );
  }, [
    activeThread,
    activeThreadKey,
    composerActiveProvider,
    composerActiveSelection,
    composerModelSelectionExplicit,
    isServerThread,
    serverProviderInstanceId,
    setComposerDraftModelSelection,
  ]);
  const timelineThreadError =
    serverRuntime?.status === "failed" &&
    serverRuntime.lastErrorClass === "usage_limit" &&
    activeThreadShell?.latestRun &&
    visibleThreadError === serverRuntimeError
      ? null
      : visibleThreadError;

  const [timelineAnchor, setTimelineAnchor] = useState<{
    readonly threadKey: string | null;
    readonly messageId: MessageId | null;
  }>({ threadKey: activeThreadKey, messageId: null });
  if (timelineAnchor.threadKey !== activeThreadKey) {
    setTimelineAnchor({ threadKey: activeThreadKey, messageId: null });
  }
  const timelineAnchorMessageId = timelineAnchor.messageId;
  // Release the turn anchor once its run finishes. LegendList sizes the
  // anchored end-space filler for the geometry at anchor time and never
  // recomputes it, so a lingering anchor leaves stale filler height behind
  // the composer — phantom scroll range on threads whose content fits.
  const anchorRunSettled = useMemo(() => {
    if (timelineAnchorMessageId === null) return false;
    const anchorRun = serverProjection?.runs.find(
      (run) => run.userMessageId === timelineAnchorMessageId,
    );
    if (anchorRun === undefined) return false;
    return (
      anchorRun.status !== "preparing" &&
      anchorRun.status !== "queued" &&
      anchorRun.status !== "starting" &&
      anchorRun.status !== "running" &&
      anchorRun.status !== "waiting"
    );
  }, [serverProjection, timelineAnchorMessageId]);
  useEffect(() => {
    if (!anchorRunSettled) return;
    setTimelineAnchor({ threadKey: activeThreadKey, messageId: null });
  }, [anchorRunSettled, activeThreadKey]);
  const activeRightPanelKind = useRightPanelStore((state) =>
    selectActiveRightPanel(state.byThreadKey, activeThreadTarget),
  );
  const diffOpen = activeRightPanelKind === "diff";
  const explicitDiffOpenRef = useRef<ScopedThreadRef | null>(null);
  useLayoutEffect(() => {
    const explicitThreadRef = explicitDiffOpenRef.current;
    explicitDiffOpenRef.current = null;
    // Generic openings always show Changes, including tab fallbacks and thread changes.
    // A timeline click instead opens the specific turn/file the user requested.
    if (
      diffOpen &&
      activeThreadTarget &&
      explicitThreadRef !== activeThreadTarget &&
      !useDiffPanelStore.getState().takeLinkedOpen(activeThreadTarget)
    ) {
      useDiffPanelStore.getState().selectGitScope(activeThreadTarget, "branch");
    }
  }, [activeThreadTarget, diffOpen]);
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, activeThreadTarget),
  );
  const activeRightPanelSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, activeThreadTarget),
  );
  const activePreviewState = useThreadPreviewState(activeThreadTarget);
  const activePreviewServerEpoch = activePreviewState.serverEpoch;
  const previewSessionsReady = !activeEnvironmentServerBrowser || activePreviewState.listLoaded;
  const resolvePreviewRuntimeTabId = useMemo(
    () =>
      activeThreadTarget
        ? (tabId: string) =>
            previewRuntimeTabId(activeThreadTarget, activePreviewServerEpoch, tabId)
        : undefined,
    [activeThreadTarget, activePreviewServerEpoch],
  );
  const activePreviewMiniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, activeThreadTarget),
  );
  const panelTerminalIds = useMemo(
    () =>
      new Set(
        rightPanelState.surfaces.flatMap((surface) =>
          surface.kind === "terminal" ? surface.terminalIds : [],
        ),
      ),
    [rightPanelState.surfaces],
  );
  const allocatableActiveTerminalIds = useMemo(
    () => [...new Set([...activeKnownTerminalIds, ...panelTerminalIds])],
    [activeKnownTerminalIds, panelTerminalIds],
  );
  const canReuseTerminal = activeThreadKnownSessionsRaw !== null;
  const allocateTerminalId = useCallback(
    () =>
      nextTerminalId(
        allocatableActiveTerminalIds,
        canReuseTerminal && readEnvironmentScope(environmentId, AuthTerminalReadScope)
          ? undefined
          : randomUUID(),
      ),
    [allocatableActiveTerminalIds, canReuseTerminal, environmentId],
  );
  const previewPanelOpen = activeRightPanelKind === "preview" && browserAvailable;
  const rightPanelOpen = rightPanelState.isOpen;
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const activeTerminalDrawerPresence = usePanelPresence(
    Boolean(activeThreadKey && terminalUiState.terminalOpen),
    true,
    panelAnimationsActive,
    activeThreadKey,
    panelAnimationDurationMs,
  );
  const rightPanelPresenceValue = useMemo(
    () => ({
      activeSurface: activeRightPanelSurface,
      surfaces: rightPanelState.surfaces,
    }),
    [activeRightPanelSurface, rightPanelState.surfaces],
  );
  const rightPanelPresence = usePanelPresence(
    rightPanelOpen && activeThreadTarget !== null,
    rightPanelPresenceValue,
    panelAnimationsActive,
    activeThreadKey,
    panelAnimationDurationMs,
  );
  const rightPanelPresent = rightPanelPresence.present;
  const rightPanelControlsInPanel =
    shouldUsePlanSidebarSheet && rightPanelPresent && rightPanelOpen;
  const rightPanelControlsAtRoot = rightPanelPresent && !shouldUsePlanSidebarSheet;
  const renderedRightPanelSurface = rightPanelPresence.value?.activeSurface ?? null;
  const renderedRightPanelSurfaces = rightPanelPresence.value?.surfaces ?? [];
  const previewMiniPlayerVisible = shouldRenderPreviewMiniPlayer(
    activePreviewMiniPlayer?.source ?? null,
    renderedRightPanelSurface,
  );
  const canMaximizeRightPanel = rightPanelOpen && !shouldUsePlanSidebarSheet;
  const rightPanelMaximized =
    canMaximizeRightPanel && maximizedRightPanelThreadKey === routeThreadKey;
  useFileReaderLayoutReport(
    inViewerOverlay ? null : activeThreadTarget,
    workspaceLayoutWidth,
    previewPanelInlineSize.width,
    shouldUsePlanSidebarSheet,
    rightPanelMaximized,
  );
  const inlineRightPanelOwnsTitleBar = rightPanelOpen && !shouldUsePlanSidebarSheet;
  const [threadPanelPresentation, setThreadPanelPresentation] =
    useState<ThreadPanelPresentation>("inline");
  const [threadPanelPopoverHandle] = useState(PopoverCreateHandle);
  const threadPanelOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(
      state.threadPanelVisibilityByThreadKey,
      activeThreadTarget,
      threadPanelPresentation,
      draftId !== null,
    ),
  );

  useEffect(() => {
    if (!activeThreadTarget || !previewSessionsReady) return;
    const hiddenTabIds = new Set(
      Object.values(activePreviewState.sessions)
        .filter((session) => session.runtime === "server" && session.reveal === false)
        .map((session) => session.tabId),
    );
    useRightPanelStore
      .getState()
      .reconcileBrowserSurfaces(
        activeThreadTarget,
        Object.keys(activePreviewState.sessions),
        hiddenTabIds,
      );
  }, [activePreviewState.sessions, activeThreadTarget, previewSessionsReady]);

  useEffect(() => {
    const source = activePreviewMiniPlayer?.source;
    if (
      activeThreadTarget &&
      previewSessionsReady &&
      source?.kind === "browser" &&
      !activePreviewState.sessions[source.tabId]
    ) {
      usePreviewMiniPlayerStore.getState().close(activeThreadTarget);
    }
  }, [
    activePreviewMiniPlayer,
    activePreviewState.sessions,
    activeThreadTarget,
    previewSessionsReady,
  ]);

  const existingOpenTerminalThreadKeys = useMemo(() => {
    const existingThreadKeys = new Set<string>([...serverThreadKeys, ...draftThreadKeys]);
    return openTerminalThreadKeys.filter((nextThreadKey) => existingThreadKeys.has(nextThreadKey));
  }, [draftThreadKeys, openTerminalThreadKeys, serverThreadKeys]);
  useEffect(() => {
    setMountedTerminalThreadKeys((currentThreadIds) => {
      const nextThreadIds = reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: existingOpenTerminalThreadKeys,
        activeThreadId: activeThreadKey,
        activeThreadTerminalOpen: activeTerminalDrawerPresence.present,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
      });
      return currentThreadIds.length === nextThreadIds.length &&
        currentThreadIds.every((nextThreadId, index) => nextThreadId === nextThreadIds[index])
        ? currentThreadIds
        : nextThreadIds;
    });
  }, [activeTerminalDrawerPresence.present, activeThreadKey, existingOpenTerminalThreadKeys]);
  const latestRunSettled = isLatestRunSettled(activeLatestRun, activeRuntime);
  const activePlan = useMemo(
    () => deriveActivePlanState(serverProjection, activeActivityRun?.runId),
    [activeActivityRun?.runId, serverProjection],
  );
  // Tasks progress for the running turn's own plan only — deriveActivePlanState
  // falls back to older runs' plans, which must not label fresh work.
  const activeComposerTasksProgress = useMemo(() => {
    if (
      isLatestRunSettled(activeActivityRun, activeRuntime) ||
      !activePlan ||
      activePlan.runId !== (activeActivityRun?.runId ?? null)
    ) {
      return null;
    }
    const totalSteps = activePlan.steps.length;
    if (totalSteps === 0) return null;
    const completedSteps = activePlan.steps.filter((step) => step.status === "completed").length;
    const step =
      activePlan.steps.find((candidate) => candidate.status === "inProgress")?.step ??
      activePlan.steps.find((candidate) => candidate.status === "pending")?.step ??
      activePlan.steps.at(-1)!.step;
    return { step, completedSteps, totalSteps };
  }, [activeActivityRun, activePlan, activeRuntime]);
  const activeComposerTaskSteps =
    activeComposerTasksProgress && activePlan ? activePlan.steps : null;
  const activeProjectTarget = useMemo(
    () =>
      activeThread ? scopeProjectRef(activeThread.environmentId, activeThread.projectId) : null,
    [activeThread?.environmentId, activeThread?.projectId, activeThread],
  );
  const activeProject = useProject(activeProjectTarget);
  // A worker that runs out of room may continue where its coordinator runs.
  const activeCoordinatorThreadId = activeProject?.workspaceSettings?.coordinatorThreadId ?? null;
  const activeCoordinatorTarget = useMemo(
    () =>
      activeThread && activeCoordinatorThreadId && activeCoordinatorThreadId !== activeThread.id
        ? scopeThreadRef(activeThread.environmentId, activeCoordinatorThreadId)
        : null,
    [activeCoordinatorThreadId, activeThread],
  );
  const coordinatorThreadShell = useThreadShell(activeCoordinatorTarget);
  const activeCoordinatorShell = useMemo(
    () =>
      coordinatorThreadShell === null
        ? null
        : {
            id: coordinatorThreadShell.id,
            providerInstanceId: coordinatorThreadShell.providerInstanceId,
            modelSelection: coordinatorThreadShell.modelSelection,
            status: coordinatorThreadShell.runtime?.status ?? "idle",
            lastErrorClass: coordinatorThreadShell.runtime?.lastErrorClass ?? null,
          },
    [coordinatorThreadShell],
  );
  // Environment settings with the active project's overrides applied.
  const activeProjectSettings = useMemo(
    () => resolveProjectSettings(settings, activeProject?.id ?? null, activeProject ?? undefined),
    [activeProject, settings],
  );
  const activeProjectScripts = useMemo(
    () => (activeProject ? resolveProjectScripts(settings, activeProject) : []),
    [activeProject, settings],
  );
  // A project added by cloning exists before its files do. The draft stays
  // editable throughout; only sending waits for the clone, and a failed
  // clone offers its retry right where the user is looking.
  const activeProjectClone = useProjectClone(activeProjectTarget);
  const cancelProjectClone = useAtomCommand(sourceControlEnvironment.cancelProjectClone, {
    reportFailure: false,
  });
  const retryProjectClone = useAtomCommand(sourceControlEnvironment.retryProjectClone, {
    reportFailure: false,
  });
  const removeClonedProject = useRemoveClonedProject();
  // The banner mirrors the server's clone state, so a request that never got
  // there needs its own feedback.
  const runProjectCloneAction = useCallback(
    async (
      title: string,
      action: () => Promise<AtomCommandResult<unknown, unknown>>,
    ): Promise<void> => {
      const result = await action();
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [],
  );
  // A clone started from Run on is a copy of another project: cancelling it
  // removes the copy and its folder and returns to the project it came from.
  const cancelAddToMachine = useCallback(
    async (environmentId: EnvironmentId, projectId: ProjectId, running: boolean) => {
      const job = readAddToMachineJob(environmentId, projectId);
      if (!job) return;
      if (running) await cancelProjectClone({ environmentId, input: { projectId } });
      if (!(await removeClonedProject({ environmentId, projectId }))) return;
      clearAddToMachineJob(environmentId, projectId);
      const sourceRef = scopeProjectRef(job.source.environmentId, job.source.projectId);
      const entry = await openCoordinatorHandoff(sourceRef);
      if (entry.kind === "standalone") void handleNewThread(sourceRef);
    },
    [cancelProjectClone, handleNewThread, openCoordinatorHandoff, removeClonedProject],
  );
  const projectCloneSendBlockReason = projectCloneSendBlockReasonOf(activeProjectClone);
  const projectCloneBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!activeProjectClone || !activeProjectTarget || activeProjectClone.phase === "done") {
      return null;
    }
    const name = projectCloneDisplayName(activeProjectClone);
    const { environmentId, projectId } = activeProjectTarget;
    const addJob = readAddToMachineJob(environmentId, projectId);
    if (activeProjectClone.phase === "running") {
      return {
        id: `project-clone:${projectId}`,
        variant: "info",
        compact: true,
        priority: "activity",
        icon: <DownloadIcon />,
        title: `Cloning ${name}`,
        description: projectCloneProgressSummary(activeProjectClone),
        actions: (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void (addJob
                ? cancelAddToMachine(environmentId, projectId, true)
                : runProjectCloneAction("Failed to cancel clone", () =>
                    cancelProjectClone({ environmentId, input: { projectId } }),
                  ))
            }
          >
            Cancel
          </Button>
        ),
      };
    }
    const cancelled = activeProjectClone.phase === "cancelled";
    return {
      id: `project-clone:${projectId}`,
      variant: cancelled ? "warning" : "error",
      compact: true,
      icon: <DownloadIcon />,
      title: cancelled ? `Cancelled cloning ${name}` : `Failed to clone ${name}`,
      description: cancelled ? "Retry to bring in the repository." : activeProjectClone.error,
      actions: (
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void (addJob
                ? cancelAddToMachine(environmentId, projectId, false)
                : removeClonedProject({ environmentId, projectId }))
            }
          >
            Remove project
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void runProjectCloneAction("Failed to retry clone", () =>
                retryProjectClone({ environmentId, input: { projectId } }),
              )
            }
          >
            Retry
          </Button>
        </>
      ),
    };
  }, [
    activeProjectClone,
    activeProjectTarget,
    cancelAddToMachine,
    cancelProjectClone,
    removeClonedProject,
    retryProjectClone,
    runProjectCloneAction,
  ]);
  const activeProjectDefaultModelSelection = activeProjectSettings.settings.defaultModelSelection;
  const handleNewThreadInActiveProject = useCallback(() => {
    startNewThreadForProject(activeProjectTarget, handleNewThread);
  }, [activeProjectTarget, handleNewThread]);
  const projectGroupingSettings = selectProjectGroupingSettings(settings);
  const activeDraftLogicalProjectKey =
    !isServerThread && activeProject
      ? deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings)
      : undefined;
  const handleOpenDraftProjectSettings = useCallback(() => {
    if (!activeDraftLogicalProjectKey) return;
    void navigate({
      to: "/projects/$projectKey",
      params: { projectKey: activeDraftLogicalProjectKey },
    });
  }, [activeDraftLogicalProjectKey, navigate]);
  const activeEnvironmentShell = useEnvironmentQuery(
    activeThread ? environmentShell.stateAtom(activeThread.environmentId) : null,
  );
  const activeEnvironmentBootstrapComplete = activeEnvironmentShell.data?.snapshot._tag === "Some";
  const activeProjectKey = activeProject
    ? `${activeProject.environmentId}:${activeProject.workspaceRoot}`
    : null;
  const [pendingFileSurfaceIdsByProject, setPendingFileSurfaceIdsByProject] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  const pendingFileSurfaceIds = activeProjectKey
    ? (pendingFileSurfaceIdsByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS)
    : EMPTY_PENDING_FILE_SURFACE_IDS;
  const handleFilePendingChange = useCallback(
    (relativePath: string, pending: boolean) => {
      if (!activeProjectKey) return;
      setPendingFileSurfaceIdsByProject((currentByProject) => {
        const current = currentByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS;
        const surfaceId = `file:${relativePath}`;
        if (current.has(surfaceId) === pending) return currentByProject;
        const next = new Set(current);
        if (pending) next.add(surfaceId);
        else next.delete(surfaceId);
        const nextByProject = new Map(currentByProject);
        if (next.size === 0) nextByProject.delete(activeProjectKey);
        else nextByProject.set(activeProjectKey, next);
        return nextByProject;
      });
    },
    [activeProjectKey],
  );
  const configuredPreviewUrls = useMemo(
    () => getConfiguredPreviewUrls(activeProjectScripts),
    [activeProjectScripts],
  );

  useEffect(() => {
    if (!activeThreadTarget || !activeEnvironmentBootstrapComplete) return;
    useRightPanelStore.getState().reconcileFileSurfaces(activeThreadTarget, activeProject !== null);
  }, [activeEnvironmentBootstrapComplete, activeProject, activeThreadTarget]);

  // Compute the list of environments this logical project spans, used to
  // drive the environment picker in BranchToolbar.
  const allProjects = useProjects();
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  useEffect(() => {
    if (!activeThreadTarget || !activeProjectTarget) return;
    registerFaviconProjectForThread(activeThreadTarget, activeProjectTarget);
  }, [activeProjectTarget, activeThreadTarget]);
  const activeEnvironment =
    activeThread == null ? null : (environmentById.get(activeThread.environmentId) ?? null);
  const activeEnvironmentConnectionPhase = activeEnvironment?.connection.phase ?? "available";
  const activeEnvironmentUnavailable =
    activeEnvironment !== null && activeEnvironmentConnectionPhase !== "connected";
  // The app's own machine is never offline: a slow answer from it means busy.
  const activeEnvironmentIsThisMachine = isThisMachineTarget(activeEnvironment?.entry);
  const activeReconnectingEnvironmentId = environmentWaitsForReconnectGrace(
    activeEnvironmentConnectionPhase,
    activeEnvironmentIsThisMachine,
  )
    ? (activeEnvironment?.environmentId ?? null)
    : null;
  const [reconnectWarningGraceElapsedEnvironmentId, setReconnectWarningGraceElapsedEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const reconnectWarningGraceElapsed = hasEnvironmentReconnectWarningGraceElapsed(
    activeReconnectingEnvironmentId,
    reconnectWarningGraceElapsedEnvironmentId,
  );
  useEffect(() => {
    setReconnectWarningGraceElapsedEnvironmentId(null);
    if (activeReconnectingEnvironmentId === null) return;
    return scheduleEnvironmentReconnectWarning(() =>
      setReconnectWarningGraceElapsedEnvironmentId(activeReconnectingEnvironmentId),
    );
  }, [activeReconnectingEnvironmentId]);
  const activeEnvironmentUnavailableLabel = activeEnvironment?.label ?? null;
  const activeEnvironmentUnavailableState = useMemo<EnvironmentUnavailableState | null>(() => {
    if (!activeEnvironmentUnavailable || !activeEnvironmentUnavailableLabel || !activeEnvironment) {
      return null;
    }

    return {
      environmentId: activeEnvironment.environmentId,
      label: activeEnvironmentUnavailableLabel,
      connection: activeEnvironment.connection,
      isThisMachine: activeEnvironmentIsThisMachine,
    };
  }, [
    activeEnvironment,
    activeEnvironmentIsThisMachine,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
  ]);
  const handleReconnectActiveEnvironment = useCallback(
    async (environmentId: EnvironmentId) => {
      const result = await retryEnvironment(environmentId);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not reconnect environment",
            description: error instanceof Error ? error.message : "Failed to reconnect.",
          }),
        );
      }
    },
    [retryEnvironment],
  );
  const disconnectDelayElapsed = useEnvironmentDisconnectDelay(
    activeEnvironmentUnavailable ? activeEnvironment.environmentId : null,
  );
  const canDisconnectActiveEnvironment =
    disconnectDelayElapsed &&
    activeEnvironment !== null &&
    activeEnvironment.entry.target._tag !== "PrimaryConnectionTarget" &&
    !isDesktopLocalConnectionTarget(activeEnvironment.entry.target);
  const [disconnectingEnvironment, setDisconnectingEnvironment] = useState(false);
  const handleDisconnectActiveEnvironment = useCallback(
    async (environmentId: EnvironmentId) => {
      setDisconnectingEnvironment(true);
      const result = await setEnvironmentEnabled({ environmentId, enabled: false });
      setDisconnectingEnvironment(false);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not disconnect server",
              description: error instanceof Error ? error.message : "Failed to disconnect.",
            }),
          );
        }
        return;
      }
      void navigate({ to: "/", replace: true });
    },
    [navigate, setEnvironmentEnabled],
  );
  const { scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const machineNickname = useMachineNicknames();
  const activeProjectIsScratch =
    activeProject !== null &&
    isScratchProject(
      activeProject,
      environmentById.get(activeProject.environmentId)?.serverConfig?.scratchWorkspaceRoot ?? null,
    );
  const projectDraftSendGuard = useProjectDraftSendGuard(
    isLocalDraftThread && projectRouting === null,
    activeProject,
    activeProject
      ? environmentById.get(activeProject.environmentId)?.serverConfig?.scratchWorkspaceRoot
      : null,
    openCoordinatorHandoff,
  );
  const logicalProjectEnvironments = useMemo(
    () =>
      buildLogicalProjectEnvironments({
        activeProject,
        activeProjectIsScratch,
        draftId,
        allProjects,
        environments,
        environmentById,
        primaryEnvironmentId,
        projectGroupingSettings,
        scratchWorkspaceRootFor,
        nickname: machineNickname,
      }),
    [
      activeProject,
      activeProjectIsScratch,
      allProjects,
      draftId,
      environments,
      projectGroupingSettings,
      primaryEnvironmentId,
      environmentById,
      scratchWorkspaceRootFor,
      machineNickname,
    ],
  );
  const hasMultipleEnvironments = logicalProjectEnvironments.length > 1;
  // Auto balance retargets to an existing project; a machine's "No project"
  // folder may not exist until it is picked.
  const canAutoBalanceEnvironments = hasMultipleEnvironments && !activeProjectIsScratch;
  const activeEnvironmentOption =
    logicalProjectEnvironments.find(
      (environment) => environment.environmentId === activeThread?.environmentId,
    ) ?? null;
  const showComposerEnvironmentIndicator =
    !draftId &&
    shouldShowEnvironmentIndicator({
      activeEnvironment: activeEnvironmentOption,
      canPickEnvironment: hasMultipleEnvironments,
    });
  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
    },
    [canCheckoutPullRequestIntoThread, setPullRequestDialogState],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, [setPullRequestDialogState]);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: { branch: string; worktreePath: string | null; envMode: DraftThreadEnvMode }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const activeProjectRef = scopeProjectRef(activeProject.environmentId, activeProject.id);
      const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
        activeProject,
        projectGroupingSettings,
      );
      const storedDraftSession = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      if (storedDraftSession) {
        setDraftThreadContext(storedDraftSession.draftId, input);
        setLogicalProjectDraftThreadId(
          logicalProjectKey,
          activeProjectRef,
          storedDraftSession.draftId,
          {
            threadId: storedDraftSession.threadId,
            ...input,
          },
        );
        if (routeKind !== "draft" || draftId !== storedDraftSession.draftId) {
          await navigate({
            to: "/draft/$draftId",
            params: buildDraftThreadRouteParams(storedDraftSession.draftId),
          });
        }
        return storedDraftSession.threadId;
      }

      const activeDraftSession = routeKind === "draft" && draftId ? getDraftSession(draftId) : null;
      if (
        !isServerThread &&
        activeDraftSession?.logicalProjectKey === logicalProjectKey &&
        draftId
      ) {
        setDraftThreadContext(draftId, input);
        setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, draftId, {
          threadId: activeDraftSession.threadId,
          createdAt: activeDraftSession.createdAt,
          runtimeMode: activeDraftSession.runtimeMode,
          interactionMode: activeDraftSession.interactionMode,
          ...input,
        });
        return activeDraftSession.threadId;
      }

      const nextDraftId = newDraftId();
      const nextThreadId = newThreadId();
      setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, nextDraftId, {
        threadId: nextThreadId,
        createdAt: new Date().toISOString(),
        runtimeMode: resolveProjectSettings(settings, activeProject.id, activeProject).settings
          .defaultRuntimeMode,
        interactionMode: DEFAULT_INTERACTION_MODE,
        ...input,
      });
      await navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(nextDraftId),
      });
      return nextThreadId;
    },
    [
      activeProject,
      draftId,
      getDraftSession,
      getDraftSessionByLogicalProjectKey,
      isServerThread,
      navigate,
      projectGroupingSettings,
      routeKind,
      settings,
      setDraftThreadContext,
      setLogicalProjectDraftThreadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
    },
    [openOrReuseProjectDraftThread],
  );

  useEffect(() => {
    if (!serverThread?.id) return;
    const threadUpdatedAt = Date.parse(serverThread.updatedAt);
    if (Number.isNaN(threadUpdatedAt)) return;
    const effectiveLastVisitedAt = resolveThreadLastVisitedAt(
      serverThread.lastVisitedAt,
      activeThreadLocalLastVisitedAt,
    );
    const lastVisitedAt = effectiveLastVisitedAt ? Date.parse(effectiveLastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= threadUpdatedAt) return;

    if (serverThread.lastVisitedAt !== undefined) {
      // Server-tracked visited state: record the watermark server-side so it
      // syncs across every device connected to the environment. Dedupe per
      // watermark — the effect re-runs before the command's echo lands. The
      // dedupe also keeps a mark-unread on the open thread sticky: the rewind
      // leaves updatedAt untouched, so the already-dispatched key skips a
      // fresh visit until new activity lands or the thread is reopened.
      const dispatchKey = `${routeThreadKey}:${serverThread.updatedAt}`;
      if (lastDispatchedVisitRef.current === dispatchKey) return;
      const dispatch = () => {
        lastDispatchedVisitRef.current = dispatchKey;
        lastVisitDispatchAtRef.current = Date.now();
        void visitThreadMutation({
          environmentId: serverThread.environmentId,
          input: { threadId: serverThread.id, visitedAt: serverThread.updatedAt },
        });
      };
      // Unread prominence only flips on run completions (hasUnseenCompletion),
      // so an unseen completion publishes immediately; mid-turn activity bumps
      // — several per second while a turn streams — ride a trailing throttle,
      // each rerun swapping the timer so the trailing dispatch carries the
      // newest watermark.
      const latestRunCompletedAtMs = serverThread.latestRun?.completedAt
        ? Date.parse(serverThread.latestRun.completedAt)
        : NaN;
      const hasUnseenCompletion =
        !Number.isNaN(latestRunCompletedAtMs) &&
        (Number.isNaN(lastVisitedAt) || latestRunCompletedAtMs > lastVisitedAt);
      const elapsed = Date.now() - lastVisitDispatchAtRef.current;
      if (hasUnseenCompletion || elapsed >= VISIT_DISPATCH_THROTTLE_MS) {
        dispatch();
        return;
      }
      const timer = setTimeout(dispatch, VISIT_DISPATCH_THROTTLE_MS - elapsed);
      return () => clearTimeout(timer);
    }

    markThreadVisited(
      scopedThreadKey(scopeThreadRef(serverThread.environmentId, serverThread.id)),
      serverThread.updatedAt,
    );
  }, [
    activeThreadLocalLastVisitedAt,
    markThreadVisited,
    routeThreadKey,
    serverThread?.environmentId,
    serverThread?.id,
    serverThread?.lastVisitedAt,
    serverThread?.latestRun?.completedAt,
    serverThread?.updatedAt,
    visitThreadMutation,
  ]);

  // Once a thread selects an environment, never substitute the primary
  // environment's config while the selected environment is still loading.
  const serverConfig = activeThread
    ? (activeEnvironment?.serverConfig ?? null)
    : (primaryEnvironment?.serverConfig ?? null);
  const providerStatuses = serverConfig?.providers ?? EMPTY_PROVIDERS;
  const selectedProviderByThreadId = resolveComposerDraftProvider({
    draftProvider: composerActiveProvider,
    draftExplicit: composerModelSelectionExplicit,
    serverInstanceId: isServerThread ? (activeThread?.modelSelection.instanceId ?? null) : null,
  });
  const threadProvider =
    activeThread?.modelSelection.instanceId ??
    activeProjectDefaultModelSelection?.instanceId ??
    null;
  // A provider that cannot run here (e.g. a managed agent not prepared on this
  // machine) holds nothing to keep, so an idle thread may leave it.
  const selectedProviderCanRun = providerInstanceCanRun(
    providerStatuses,
    serverProjection?.thread.modelSelection.instanceId,
  );
  const supportsProviderSwitchingViaHandoff = useMemo(
    () =>
      threadSupportsProviderHandoff(
        serverProjection,
        selectedProviderCanRun === undefined
          ? undefined
          : { selectedInstanceCanRun: selectedProviderCanRun },
      ),
    [serverProjection, selectedProviderCanRun],
  );
  const lockedProvider = deriveLockedProvider({
    thread: activeThread,
    selectedProvider: selectedProviderByThreadId,
    threadProvider,
    providers: providerStatuses,
  });
  const modelPickerLockedProvider = supportsProviderSwitchingViaHandoff ? null : lockedProvider;
  const pullRequestsCapabilityKnown = serverConfig !== null;
  const supportsPullRequests = serverConfig?.environment.capabilities.pullRequests === true;
  const attachmentEnvironmentConfig = environmentById.get(environmentId)?.serverConfig ?? null;
  const attachmentUploadsCapabilityKnown = attachmentEnvironmentConfig !== null;
  const supportsQuestionAttachments =
    attachmentEnvironmentConfig?.environment.capabilities.questionAttachments === true;
  const supportsAttachmentUploads =
    attachmentEnvironmentConfig?.environment.capabilities.attachmentUploads === true;
  const advertisedFileAttachmentBytes =
    attachmentEnvironmentConfig?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null;
  const maxFileAttachmentBytes =
    advertisedFileAttachmentBytes === null
      ? null
      : clampFileAttachmentUploadBytes(advertisedFileAttachmentBytes);
  const envLocked = Boolean(activeThread && (activeMessageCount > 0 || activeRuntime !== null));

  const loadBalancingSettings = useClientSettings();
  const automaticEnvironment = Boolean(
    clientSettingsHydrated &&
    draftId &&
    !envLocked &&
    canAutoBalanceEnvironments &&
    loadBalancingSettings.loadBalancingEnabled &&
    draftThread?.environmentSelection !== "manual" &&
    (!composerHasNonPromptContent || Boolean(draftThread?.loadBalancedEnvironmentId)) &&
    (!draftThread?.branch || draftThread.environmentSelection === "auto") &&
    !draftThread?.worktreePath,
  );
  const serverUpdateEnvironmentId = activeThread?.environmentId ?? null;
  const serverUpdateState = useAtomValue(
    serverEnvironment.updateStateAtom(serverUpdateEnvironmentId),
  );
  useMachineLastSeenVersion();
  const activeMachineLastSeenAt = activeEnvironmentUnavailableState
    ? machineLastSeenAt(activeEnvironmentUnavailableState.environmentId)
    : null;
  // A sent thread whose machine can't be reached can carry on elsewhere: the
  // same project on another machine, or that machine's own chat folder for a
  // chat without a project.
  const continueElsewhereTarget = useMemo<ContinueTarget | null>(() => {
    if (!isServerThread || !activeThread || !activeEnvironmentUnavailableState) return null;
    // This machine catching up is not "could not be reached": forking the chat
    // over a few-second stall would say exactly that, so offer no fork.
    if (
      activeEnvironmentUnavailableState.isThisMachine &&
      isThisMachineCatchingUp(activeEnvironmentUnavailableState.connection.phase)
    ) {
      return null;
    }
    const machineCandidate = (
      id: EnvironmentId,
      projectId: ProjectId | null,
      label: string,
    ): ContinueCandidate => {
      const environment = environmentById.get(id);
      return {
        environmentId: id,
        projectId,
        label,
        connected: environment?.connection.phase === "connected",
        canOperate: readEnvironmentScope(id, AuthOrchestrationOperateScope),
        providers: environment?.serverConfig?.providers ?? [],
      };
    };
    const candidates: ContinueCandidate[] = activeProjectIsScratch
      ? environments
          .filter((environment) => scratchWorkspaceRootFor(environment.environmentId) !== null)
          .toSorted((a, b) =>
            a.environmentId === primaryEnvironmentId
              ? -1
              : b.environmentId === primaryEnvironmentId
                ? 1
                : a.label.localeCompare(b.label),
          )
          .map((environment) =>
            machineCandidate(
              environment.environmentId,
              allProjects.find(
                (project) =>
                  project.environmentId === environment.environmentId &&
                  isScratchProject(project, scratchWorkspaceRootFor(environment.environmentId)),
              )?.id ?? null,
              environment.label,
            ),
          )
      : logicalProjectEnvironments.map((option) =>
          machineCandidate(option.environmentId, option.projectId, option.label),
        );
    const current = activeThreadShell?.modelSelection ?? activeThread.modelSelection;
    return pickContinueTarget({
      sourceEnvironmentId: activeThread.environmentId,
      candidates,
      chatFolder: activeProjectIsScratch,
      current,
      currentDriver:
        providerStatuses.find((provider) => provider.instanceId === current.instanceId)?.driver ??
        null,
      nowMs: renderNowMs,
    });
  }, [
    activeEnvironmentUnavailableState,
    activeProjectIsScratch,
    activeThread,
    activeThreadShell?.modelSelection,
    allProjects,
    environmentById,
    environments,
    isServerThread,
    logicalProjectEnvironments,
    primaryEnvironmentId,
    providerStatuses,
    renderNowMs,
    scratchWorkspaceRootFor,
  ]);
  // Filled by ChatView, which owns starting threads; read only on click.
  const continueElsewhereRef = useRef<((target: ContinueTarget) => Promise<void>) | null>(null);
  const [continuingElsewhere, setContinuingElsewhere] = useState(false);
  // Re-renders when a link is written; the link object is stable until then.
  useChatContinuationsVersion();
  const activeContinuation = activeThread
    ? chatContinuation(activeThread.environmentId, activeThread.id)
    : null;
  const systemComposerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const items: ComposerBannerStackItem[] = [];
    const updateRunning = serverUpdateState.status === "running";
    const unavailableConnection = activeEnvironmentUnavailableState?.connection ?? null;
    const disconnectAction =
      canDisconnectActiveEnvironment && activeEnvironmentUnavailableState ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={disconnectingEnvironment}
          title="Hide this server's threads. Switch it on again in Connections."
          onClick={() =>
            void handleDisconnectActiveEnvironment(activeEnvironmentUnavailableState.environmentId)
          }
        >
          Disconnect server
        </Button>
      ) : undefined;
    const unavailableBanner =
      activeEnvironmentUnavailableState && unavailableConnection
        ? environmentUnavailableBanner({
            label: activeEnvironmentUnavailableState.label,
            connection: unavailableConnection,
            isThisMachine: activeEnvironmentUnavailableState.isThisMachine,
          })
        : null;
    const unavailableStatus = unavailableBanner?.status ?? null;
    // Why it is unreachable and when it was last connected, so the banner says
    // more than "offline". This machine is only busy: one calm line instead.
    const unavailableDetail = unavailableBanner?.calm
      ? THIS_MACHINE_BUSY_DESCRIPTION
      : activeEnvironmentUnavailableState
        ? machineDetail(
            lastSeenLabel(activeMachineLastSeenAt, Date.now()),
            unavailableStatus?.reason ?? null,
          )
        : "";
    const environmentReconnecting = unavailableBanner?.waitsForGrace === true;
    // While an update runs, transient connect blips are expected (the server
    // restarts) and the update banner already shows progress. Hard failure
    // phases still surface so the Reconnect action stays reachable.
    const suppressUnavailableBanner =
      environmentReconnecting && (updateRunning || !reconnectWarningGraceElapsed);
    if (
      activeEnvironmentUnavailableState &&
      unavailableConnection &&
      unavailableBanner &&
      !suppressUnavailableBanner
    ) {
      items.push({
        id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
        variant: unavailableBanner.variant,
        icon: unavailableBanner.calm ? <HourglassIcon /> : <WifiOffIcon />,
        title: unavailableBanner.title,
        description:
          [
            unavailableDetail,
            activeContinuation?.continuedIn
              ? `Continued on ${activeContinuation.continuedIn.label}`
              : continueElsewhereTarget && activeProjectIsScratch
                ? `Files in this chat's folder stay on ${activeEnvironmentUnavailableState.label}`
                : "",
          ]
            .filter(Boolean)
            .join(". ") || undefined,
        actionsLayout: "wrap-below",
        actions: (
          <>
            {activeContinuation?.continuedIn ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  const link = activeContinuation.continuedIn!;
                  void openThreadRoute(
                    scopeThreadRef(link.environmentId as EnvironmentId, link.threadId as ThreadId),
                  );
                }}
              >
                Open on {activeContinuation.continuedIn.label}
              </Button>
            ) : continueElsewhereTarget ? (
              <Button
                size="xs"
                variant="outline"
                disabled={continuingElsewhere}
                title={`Start a new chat on ${continueElsewhereTarget.label} (${continueElsewhereTarget.model}) from a summary of this one`}
                onClick={() => {
                  const run = continueElsewhereRef.current;
                  if (!run) return;
                  setContinuingElsewhere(true);
                  void run(continueElsewhereTarget)
                    .catch((error: unknown) => {
                      toastManager.add(
                        stackedThreadToast({
                          type: "error",
                          title: `Could not continue on ${continueElsewhereTarget.label}`,
                          description:
                            error instanceof Error ? error.message : "This chat is unchanged.",
                        }),
                      );
                    })
                    .finally(() => setContinuingElsewhere(false));
                }}
              >
                {continuingElsewhere
                  ? `Continuing on ${continueElsewhereTarget.label}...`
                  : `Continue on ${continueElsewhereTarget.label}`}
              </Button>
            ) : null}
            {unavailableStatus?.retryable ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  void handleReconnectActiveEnvironment(
                    activeEnvironmentUnavailableState.environmentId,
                  )
                }
              >
                Retry
              </Button>
            ) : null}
            {disconnectAction}
          </>
        ),
      });
    }
    // The new chat names the one it continues, until the notice is closed.
    const continues = activeContinuation?.dismissed ? undefined : activeContinuation?.continues;
    if (continues && activeThread) {
      items.push({
        id: `continued-from:${continues.environmentId}:${continues.threadId}`,
        variant: "info",
        icon: <LaptopIcon />,
        title: `Continued from ${continues.label}`,
        description: `"${continues.title}" stopped when ${continues.label} could not be reached. Its files stay on ${continues.label}.`,
        actions: (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void openThreadRoute(
                scopeThreadRef(
                  continues.environmentId as EnvironmentId,
                  continues.threadId as ThreadId,
                ),
              )
            }
          >
            Open original
          </Button>
        ),
        dismissLabel: "Close",
        onDismiss: () => dismissContinuedFrom(activeThread.environmentId, activeThread.id),
      });
    }
    // Server updates show once, in the sidebar footer (SidebarServerUpdate),
    // not above every thread's composer.
    return items;
  }, [
    activeContinuation,
    activeProjectIsScratch,
    activeThread,
    continueElsewhereTarget,
    continuingElsewhere,
    openThreadRoute,
    automaticEnvironment,
    activeEnvironmentUnavailableState,
    handleReconnectActiveEnvironment,
    canDisconnectActiveEnvironment,
    disconnectingEnvironment,
    handleDisconnectActiveEnvironment,
    reconnectWarningGraceElapsed,
    serverUpdateState,
    activeMachineLastSeenAt,
  ]);
  const providerInstanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providerStatuses), settings),
      ),
    [providerStatuses, settings],
  );
  const { selectedProviderEntry, requestedDriverKind } = useMemo(
    () =>
      resolveComposerProviderSelection({
        entries: providerInstanceEntries,
        candidateInstanceIds: [
          selectedProviderByThreadId,
          activeRuntime?.providerInstanceId,
          activeThread?.modelSelection.instanceId,
          activeProjectDefaultModelSelection?.instanceId,
        ],
        lockedProvider,
        lockedInstanceId:
          activeRuntime?.providerInstanceId ?? activeThread?.modelSelection.instanceId,
      }),
    [
      activeProjectDefaultModelSelection?.instanceId,
      activeThread?.modelSelection.instanceId,
      activeRuntime?.providerInstanceId,
      lockedProvider,
      providerInstanceEntries,
      selectedProviderByThreadId,
    ],
  );
  const selectedProvider = selectedProviderEntry?.driverKind ?? requestedDriverKind;
  const activeProviderInstanceId = selectedProviderEntry?.instanceId ?? null;
  const activeProviderStatus = selectedProviderEntry?.snapshot ?? null;
  const { enabled: interactionModeEnabled, interactionMode } = resolveComposerInteractionMode({
    planModeEnabled: settings.planModeEnabled,
    provider: activeProviderStatus,
    interactionMode:
      composerInteractionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
  });
  const conversationProviderStatus =
    providerStatuses.find((status) => status.instanceId === activeRuntime?.providerInstanceId) ??
    activeProviderStatus;
  const supportsConversationRollback =
    canOperateThread &&
    conversationProviderStatus !== null &&
    conversationProviderStatus.supportsConversationRollback !== false;
  const phase = derivePhase(activeRuntime);
  const pendingRequests = useMemo(
    () =>
      serverProjection === null
        ? { approvals: [], userInputs: [] }
        : derivePendingThreadRequests(serverProjection),
    [serverProjection],
  );
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(pendingRequests.approvals),
    [pendingRequests.approvals],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(pendingRequests.userInputs),
    [pendingRequests.userInputs],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingRequestKey = JSON.stringify([
    environmentId,
    activeThreadId,
    activePendingUserInput?.requestId,
  ]);
  const pendingQuestionDraftKeys = useMemo(
    () =>
      activeThreadId
        ? pendingUserInputs.flatMap((request) =>
            request.questions.map((question) =>
              questionAttachmentDraftId(
                environmentId,
                activeThreadId,
                request.requestId,
                question.id,
              ),
            ),
          )
        : [],
    [activeThreadId, environmentId, pendingUserInputs],
  );
  const questionComposerDrafts = useComposerDraftStore(
    useShallow((state) =>
      Object.fromEntries(
        pendingQuestionDraftKeys.map((key) => [key, state.draftsByThreadKey[key]]),
      ),
    ),
  );
  const questionUploadsBlocked = useAttachmentUploadStore(
    useShallow((state) =>
      Object.fromEntries(
        pendingQuestionDraftKeys.map((key) => {
          const draft = questionComposerDrafts[key];
          const attachments = draft ? [...draft.images, ...draft.files] : [];
          return [
            key,
            attachments.some((attachment) => {
              const upload = state.uploadsByImageId[attachment.id];
              return upload?.status !== "ready" || upload.environmentId !== environmentId;
            }),
          ];
        }),
      ),
    ),
  );
  const questionPreparations = useQuestionAttachmentPreparation(
    useShallow((state) =>
      Object.fromEntries(pendingQuestionDraftKeys.map((key) => [key, state.counts[key] ?? 0])),
    ),
  );
  useEffect(() => {
    if (!activeThread) return;
    const questionThread = activeThread;
    const currentRequests = pendingUserInputs;
    const prefix = questionAttachmentDraftPrefix(environmentId, questionThread.id);
    const retained = new Set(
      currentRequests.flatMap((request) =>
        request.questions.map((question) =>
          questionAttachmentDraftId(
            environmentId,
            questionThread.id,
            request.requestId,
            question.id,
          ),
        ),
      ),
    );
    const keys = new Set([
      ...Object.keys(useComposerDraftStore.getState().draftsByThreadKey),
      ...Object.keys(useQuestionAttachmentPreparation.getState().counts),
    ]);
    for (const key of keys) {
      if (key.startsWith(prefix) && !retained.has(DraftId.make(key)))
        clearQuestionAttachmentDraft(DraftId.make(key));
    }
  }, [environmentId, activeThread, pendingUserInputs]);
  const activePendingDraftAnswers = useMemo(() => {
    if (!activePendingUserInput || !activeThreadId) return EMPTY_PENDING_USER_INPUT_ANSWERS;
    return Object.fromEntries(
      activePendingUserInput.questions.map((question) => {
        const key = questionAttachmentDraftId(
          environmentId,
          activeThreadId,
          activePendingUserInput.requestId,
          question.id,
        );
        const draft = questionComposerDrafts[key];
        const attachments = draft ? [...draft.images, ...draft.files] : [];
        return [
          question.id,
          {
            ...pendingUserInputAnswersByRequestId[activePendingRequestKey]?.[question.id],
            attachmentCount: attachments.length,
            attachmentsBlocked:
              (attachments.length > 0 && !supportsQuestionAttachments) ||
              (questionPreparations[key] ?? 0) > 0 ||
              questionUploadsBlocked[key] === true,
          },
        ];
      }),
    );
  }, [
    activePendingUserInput,
    activeThreadId,
    environmentId,
    questionComposerDrafts,
    questionUploadsBlocked,
    supportsQuestionAttachments,
    questionPreparations,
    pendingUserInputAnswersByRequestId,
    activePendingRequestKey,
  ]);
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingRequestKey] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? activePendingUserInput.responseCapability === "not_resumable" ||
      respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestRunSettled) {
      return null;
    }
    return findLatestProposedPlan(serverProjection, activeLatestRun?.runId ?? null);
  }, [activeLatestRun?.runId, latestRunSettled, serverProjection]);
  const showPlanFollowUpPrompt = shouldShowPlanFollowUpPrompt({
    pendingUserInputCount: pendingUserInputs.length,
    interactionMode,
    latestTurnSettled: latestRunSettled,
    hasActionableProposedPlan: hasActionableProposedPlan(activeProposedPlan),
    hasComposerAttachments: composerHasAttachments,
  });
  const activePendingApproval = pendingApprovals[0] ?? null;
  // Suggestions to switch before the limit, dismissed per thread and usage window.
  const [dismissedUsageApproaching, setDismissedUsageApproaching] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // The open /usage-limits panel for this thread, model and turn. Only the open
  // moment is stored: the rows read live provider data, so a redeemed reset
  // credit or refreshed probe shows through. Anything that spends quota closes
  // it: a new turn from any source, or the agent resuming after an approval or
  // answered question.
  const [usageLimitsPanel, setUsageLimitsPanel] = useState<{
    readonly key: string;
    readonly threadKey: string;
    readonly now: number;
  } | null>(null);
  // Null while the provider list or the thread itself is unavailable, such as
  // during a reconnect; the panel then stays hidden rather than being dropped.
  // A pending approval or question is part of the key: once it is answered,
  // from this client or any other, the agent resumes and spends quota.
  const usageLimitsKey =
    activeProviderInstanceId === null || (isServerThread && activeThread === undefined)
      ? null
      : [
          routeThreadKey,
          activeProviderInstanceId,
          activeThread?.latestRun?.runId ?? "",
          activePendingApproval?.requestId ?? activePendingUserInput?.requestId ?? "",
        ].join(":");
  // Drop the snapshot as soon as the thread or model changes so it cannot resurface stale.
  if (
    usageLimitsPanel !== null &&
    usageLimitsKey !== null &&
    usageLimitsPanel.key !== usageLimitsKey
  ) {
    setUsageLimitsPanel(null);
  }
  const usageLimitSources = serverConfig?.usageLimitSources ?? EMPTY_USAGE_LIMIT_SOURCES;
  const usageLimitsReport = useMemo(
    () =>
      usageLimitsPanel !== null &&
      usageLimitsKey !== null &&
      usageLimitsPanel.key === usageLimitsKey &&
      activeProviderInstanceId !== null
        ? collectProviderUsageLimits(
            activeProviderInstanceId,
            providerStatuses,
            usageLimitSources,
            usageLimitsPanel.now,
          )
        : null,
    [
      activeProviderInstanceId,
      providerStatuses,
      usageLimitSources,
      usageLimitsKey,
      usageLimitsPanel,
    ],
  );
  const usageLimitsBanner = useMemo(
    () =>
      usageLimitsReport !== null && usageLimitsPanel !== null
        ? // A fresh id per opening: the stack keeps the last dismissed id as "exiting".
          usageLimitsBannerItem(
            `usage-limits:${usageLimitsPanel.key}:${usageLimitsPanel.now}`,
            usageLimitsReport,
            environmentId,
            () => setUsageLimitsPanel(null),
          )
        : null,
    [environmentId, usageLimitsPanel, usageLimitsReport],
  );
  // Studio owns /usage-limits only where Limits has data for the selected provider;
  // elsewhere the name stays the provider's own and is sent through untouched.
  const usageLimitsOffered =
    activeProviderStatus !== null &&
    hasProviderUsageLimits(activeProviderStatus.driver, providerStatuses, usageLimitSources);
  // Answered locally from the last Limits snapshot; the agent never sees it.
  const openUsageLimits = useCallback(() => {
    const now = Date.now();
    const report =
      activeProviderInstanceId !== null && usageLimitsKey !== null
        ? collectProviderUsageLimits(
            activeProviderInstanceId,
            providerStatuses,
            usageLimitSources,
            now,
          )
        : null;
    if (report && usageLimitsKey !== null) {
      setUsageLimitsPanel({ key: usageLimitsKey, threadKey: routeThreadKey, now });
      return true;
    }
    setUsageLimitsPanel(null);
    toastManager.add({ type: "info", title: "Usage limits are unavailable for this provider" });
    return false;
  }, [
    activeProviderInstanceId,
    providerStatuses,
    routeThreadKey,
    usageLimitSources,
    usageLimitsKey,
  ]);
  // Responses can resolve after navigating away; only the originating thread's panel clears.
  const clearUsageLimitsFor = useCallback(
    (threadKey: string) =>
      setUsageLimitsPanel((current) =>
        current !== null && current.threadKey === threadKey ? null : current,
      ),
    [],
  );
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree: isLocallyPreparingWorktree,
    isSendBusy,
    backgroundSubmissionPending,
  } = useLocalDispatchState({
    activeThread,
    activeLatestRun,
    latestUserMessageId:
      serverProjection?.messages.findLast((message) => message.role === "user")?.id ?? null,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError,
  });
  const optimisticCompactionMessage = optimisticUserMessages.at(-1);
  const latestServerUserItem = serverVisibleTurnItems.findLast(
    (row) => row.item.type === "user_message",
  )?.item;
  const compactRequestIsActive =
    (isSendBusy &&
      optimisticCompactionMessage !== undefined &&
      isCompactCommandMessage(optimisticCompactionMessage)) ||
    (latestServerUserItem?.type === "user_message" &&
      latestServerUserItem.text.trim().toLowerCase() === "/compact" &&
      latestServerUserItem.attachments.length === 0 &&
      latestServerUserItem.runId === activeActivityRun?.runId &&
      !isLatestRunSettled(activeActivityRun, activeRuntime));
  const compactionSettled = serverVisibleTurnItems.some(
    ({ item }) =>
      item.type === "compaction" &&
      item.runId === activeActivityRun?.runId &&
      item.status === "completed",
  );
  const isCompacting =
    (isSendBusy || phase === "connecting" || phase === "running") &&
    compactRequestIsActive &&
    !compactionSettled;
  // A rewind is not agent work: the composer shows "Rewinding conversation"
  // instead of the timeline growing a Thinking row.
  const isWorking =
    phase === "running" ||
    isSendBusy ||
    isConnecting ||
    isCompacting ||
    runlessWorkStartedAt !== null;
  const activeContextWindow = useMemo(
    () =>
      deriveLatestContextWindowSnapshot(
        serverVisibleTurnItems ?? [],
        activeThreadLiveTokenUsage,
        serverProjection?.providerThreads.find(
          (thread) => thread.id === serverProjection.thread.activeProviderThreadId,
        ),
      ),
    [activeThreadLiveTokenUsage, serverVisibleTurnItems, serverProjection],
  );
  const pendingBackgroundTasks = useMemo(() => {
    if (serverProjection === null || serverProjection === undefined) {
      return [];
    }
    const sessionError =
      serverProjection.providerSessions.findLast(
        (session) => session.providerInstanceId === serverProjection.thread.providerInstanceId,
      )?.lastError ?? null;
    const latestRun =
      usageLimitRunPresentedAsLatest(
        serverProjection.runs,
        serverProjection.turnItems,
        sessionError,
      ) ?? latestUnheldRun(serverProjection.runs);
    return [
      ...derivePendingBackgroundWork({
        latestRun,
        providerThreads: serverProjection.providerThreads,
        turnItems: serverProjection.turnItems,
        activeProviderThreadId: serverProjection.thread.activeProviderThreadId,
        runs: serverProjection.runs,
        pullRequests: serverProjection.thread.pullRequests,
      }),
    ];
  }, [serverProjection]);
  const activeWorkStartedAt =
    deriveActiveWorkStartedAt(activeActivityRun, activeRuntime, localDispatchStartedAt) ??
    runlessWorkStartedAt;
  const nowMinute = useNowMinute();
  // The open thread's own items say what is in flight, even when its server is
  // too old to send `activeWork` on the shell, so a long wait is not a stall.
  const activeRunIdForWork = activeRuntime?.activeRunId ?? null;
  const projectedActiveWork = useMemo(() => {
    if (serverProjection === null || serverProjection === undefined) return undefined;
    const work = deriveActiveRunWork({
      activeRunId: activeRunIdForWork,
      turnItems: serverProjection.turnItems,
      toMillis: DateTime.toEpochMillis,
    });
    if (work === null) return null;
    return {
      label: work.label,
      startedAt: DateTime.formatIso(work.startedAt),
      ...(work.waitThreadId === undefined ? {} : { waitThreadId: work.waitThreadId }),
    };
  }, [activeRunIdForWork, serverProjection]);
  const activeRunHealth = useMemo(
    () =>
      isServerThread && serverThread !== null
        ? threadRunHealth(
            projectedActiveWork === undefined
              ? serverThread
              : { ...serverThread, activeWork: projectedActiveWork },
            Date.parse(`${nowMinute}:00Z`),
          )
        : null,
    [isServerThread, nowMinute, projectedActiveWork, serverThread],
  );
  // A wait on another thread names and links that thread.
  const waitThreadId =
    activeRunHealth?.state === "waiting" ? (activeRunHealth.waitThreadId ?? null) : null;
  const waitThreadTarget = useMemo(
    () =>
      waitThreadId === null || serverThread === null
        ? null
        : scopeThreadRef(serverThread.environmentId, waitThreadId as ThreadId),
    [serverThread, waitThreadId],
  );
  const waitThread = useThreadShell(waitThreadTarget);
  const timelineRunHealth = useMemo(
    () =>
      activeRunHealth?.state === "waiting" && waitThreadId !== null
        ? { ...activeRunHealth, label: waitThread?.title ?? activeRunHealth.label }
        : activeRunHealth,
    [activeRunHealth, waitThread?.title, waitThreadId],
  );
  // The working header names the machine. This machine is never offline, and
  // a brief reconnect gets the same grace as the unavailable banner.
  const timelineActiveHostLabel = activeEnvironment?.label ?? null;
  const timelineActiveHostConnected =
    !activeEnvironmentUnavailable ||
    activeEnvironmentIsThisMachine ||
    (activeReconnectingEnvironmentId !== null && !reconnectWarningGraceElapsed);
  const timelineActiveHost = useMemo(
    () =>
      timelineActiveHostLabel === null
        ? null
        : { label: timelineActiveHostLabel, connected: timelineActiveHostConnected },
    [timelineActiveHostConnected, timelineActiveHostLabel],
  );
  // Server-side workspace preparation: unlike the local-dispatch flag this
  // survives reloads and shows on remote viewers of the same thread.
  const activeRunPreparing = activeActivityRun?.status === "preparing";
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoff = useCallback(
    (messageId: MessageId, previewUrls?: ReadonlyArray<string>) => {
      delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
      const currentPreviewUrls =
        previewUrls ?? attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) {
          return existing;
        }
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      for (const previewUrl of currentPreviewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    },
    [],
  );
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    attachmentPreviewPromotionInFlightByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    const nextPreviewUrlSet = new Set(previewUrls);
    for (const previewUrl of previousPreviewUrls) {
      if (!nextPreviewUrlSet.has(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });
  }, []);
  const downloadFileAttachment = useCallback(
    async (attachment: ChatFileAttachment) => {
      const connection = readPreparedConnection(environmentId);
      if (!connection) {
        toastManager.add({ type: "error", title: "The environment is not connected." });
        return;
      }

      try {
        const url = await resolveFileAttachmentUrl({
          attachment,
          environmentId,
          httpBaseUrl: connection.httpBaseUrl,
          createAssetUrl: createAttachmentAssetUrl,
        });
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = attachment.name;
        anchor.click();
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not download " + attachment.name,
          description: error instanceof Error ? error.message : "The attachment is unavailable.",
        });
      }
    },
    [createAttachmentAssetUrl, environmentId],
  );
  const openFileAttachment = useCallback(
    (attachment: ChatFileAttachment) => {
      if (activeThreadTarget) {
        useRightPanelStore.getState().openAttachment(activeThreadTarget, attachment);
        return;
      }
    },
    [activeThreadTarget],
  );
  const serverAttachmentResources = useMemo(
    () =>
      selectHandoffImageResources(
        Object.keys(attachmentPreviewHandoffByMessageId).length === 0
          ? undefined
          : serverVisibleTurnItems.flatMap(({ item }) =>
              item.type === "user_message"
                ? [{ id: item.messageId, role: "user" as const, attachments: item.attachments }]
                : [],
            ),
        attachmentPreviewHandoffByMessageId,
      ),
    [serverVisibleTurnItems, attachmentPreviewHandoffByMessageId],
  );
  const serverAttachmentUrls = useAssetUrls(environmentId, serverAttachmentResources);
  const serverAttachmentUrlById = useMemo(
    () =>
      new Map(
        serverAttachmentResources.flatMap((resource, index) => {
          const url = serverAttachmentUrls[index];
          return url ? [[resource.attachmentId, url] as const] : [];
        }),
      ),
    [serverAttachmentResources, serverAttachmentUrls],
  );
  useEffect(() => {
    if (typeof Image === "undefined" || serverVisibleTurnItems.length === 0) {
      return;
    }

    const cleanups: Array<() => void> = [];
    const userMessagesById = new Map(
      serverVisibleTurnItems.flatMap((row) =>
        row.item.type === "user_message" ? [[String(row.item.messageId), row.item] as const] : [],
      ),
    );

    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    )) {
      if (attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId]) {
        continue;
      }

      const serverMessage = userMessagesById.get(messageId);
      if (serverMessage === undefined || serverMessage.attachments.length === 0) {
        continue;
      }

      const serverPreviewUrls = serverMessage.attachments.flatMap((attachment) =>
        attachment.type === "image"
          ? [serverAttachmentUrlById.get(attachment.id)].filter(
              (previewUrl): previewUrl is string => previewUrl !== undefined,
            )
          : [],
      );
      if (
        serverPreviewUrls.length === 0 ||
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
      ) {
        continue;
      }

      attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId] = true;

      let cancelled = false;
      const imageInstances: HTMLImageElement[] = [];

      const preloadServerPreviews = Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              imageInstances.push(image);
              const handleLoad = () => resolve();
              const handleError = () =>
                reject(new Error(`Failed to load server preview for ${messageId}.`));
              image.addEventListener("load", handleLoad, { once: true });
              image.addEventListener("error", handleError, { once: true });
              image.src = previewUrl;
            }),
        ),
      );

      void preloadServerPreviews
        .then(() => {
          if (cancelled) {
            return;
          }
          clearAttachmentPreviewHandoff(messageId as MessageId, handoffPreviewUrls);
        })
        .catch(() => {
          if (!cancelled) {
            delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
          }
        });

      cleanups.push(() => {
        cancelled = true;
        delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
        for (const image of imageInstances) {
          image.src = "";
        }
      });
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [
    attachmentPreviewHandoffByMessageId,
    clearAttachmentPreviewHandoff,
    serverAttachmentUrlById,
    serverVisibleTurnItems,
  ]);
  const timelineAttachmentUrlById = useMemo(() => {
    const urls = new Map(serverAttachmentUrlById);
    for (const row of serverVisibleTurnItems) {
      if (row.item.type !== "user_message") continue;
      const handoffUrls = attachmentPreviewHandoffByMessageId[row.item.messageId];
      if (handoffUrls === undefined) continue;
      let imageIndex = 0;
      for (const attachment of row.item.attachments) {
        if (attachment.type !== "image") continue;
        const handoffUrl = handoffUrls[imageIndex];
        imageIndex += 1;
        if (handoffUrl !== undefined) urls.set(attachment.id, handoffUrl);
      }
    }
    return urls;
  }, [attachmentPreviewHandoffByMessageId, serverAttachmentUrlById, serverVisibleTurnItems]);
  const anchoredTimelineMessages = useMemo(
    () =>
      feedbackSubmissions.flatMap((submission) =>
        submission.status === "interrupted"
          ? []
          : [
              { ...codexFeedbackMessage(submission), runId: null },
              { ...codexFeedbackMessage(submission, "assistant"), runId: null },
            ],
      ),
    [feedbackSubmissions],
  );
  const serverTimelineEntries = useServerTimelineEntries(
    activeThreadKey,
    serverVisibleTurnItems,
    optimisticUserMessages,
    anchoredTimelineMessages,
    timelineAttachmentUrlById,
    serverProjection,
  );
  const draftTimelineEntries = useMemo(
    () =>
      optimisticUserMessages.map(
        (message) =>
          ({
            id: message.id,
            kind: "message",
            createdAt: message.createdAt,
            message,
          }) as const,
      ),
    [optimisticUserMessages],
  );
  const routedMessages = projectRouting?.routedMessages;
  const timelineEntries = useMemo(
    () =>
      isServerThread
        ? withRoutedMessages(serverTimelineEntries, routedMessages)
        : draftTimelineEntries,
    [isServerThread, serverTimelineEntries, draftTimelineEntries, routedMessages],
  );
  const timelineMessages = useMemo(
    () => timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
    [timelineEntries],
  );
  const rememberedTimelineForActive = useRenderRead(() =>
    peekRememberedThreadTimeline<typeof timelineEntries>(activeThreadKey),
  );
  const displayedTimeline = resolveThreadSwitchTimeline({
    loading: timelineEntries.length === 0 && threadSyncPhase !== null,
    activeThreadKey,
    nextEntries: timelineEntries,
    rememberedForActive: rememberedTimelineForActive,
  });
  const displayedTimelineKey = displayedTimeline.displayThreadKey ?? routeThreadKey;
  const paintOnlyDisplayedTimeline = isPaintOnlyThreadTimeline(
    displayedTimeline.displayThreadKey,
    activeThreadKey,
  );
  const displayedThreadTarget = parseScopedThreadKey(displayedTimelineKey);
  const collapseLongReports = resolveCollapseLongReports({
    displayThreadKey: displayedTimelineKey,
    activeThreadKey,
    activeIsDelegated: isProviderSubagent || parentSubagentThreadId !== null,
    paintOnly: paintOnlyDisplayedTimeline,
  });
  const worktreeSetupOwnerKey = draftId ?? routeThreadKey;
  const worktreeSetupActive =
    worktreeSetupThread !== null && worktreeSetupThread.ownerKey === worktreeSetupOwnerKey;
  // Keep the sending environment during local draft setup; revisiting a
  // canonical thread subscribes by its durable identity.
  const setupTarget = worktreeSetupActive ? worktreeSetupThread : routeThreadTarget;
  const worktreeSetupQuery = useEnvironmentQuery(
    worktreeSetupActive ||
      (activeThread?.id === routeThreadTarget.threadId &&
        (isLocallyPreparingWorktree || activeRunPreparing || activeThread.worktreePath !== null))
      ? vcsEnvironment.worktreeSetup({
          environmentId: setupTarget.environmentId,
          input: { threadId: setupTarget.threadId },
        })
      : null,
  );
  const latestWorktreeSetup = worktreeSetupQuery.data;
  useEffect(() => {
    if (!latestWorktreeSetup) return;
    setHeldWorktreeSetup((current) =>
      current?.threadId === latestWorktreeSetup.threadId &&
      current.sequence > latestWorktreeSetup.sequence
        ? current
        : latestWorktreeSetup,
    );
  }, [latestWorktreeSetup]);
  useEffect(() => {
    setHeldWorktreeSetup(null);
  }, [routeThreadKey]);
  const { snapshot: liveWorktreeSetup, isPreparingWorktree } = resolveWorktreeSetupProgress({
    threadId: setupTarget.threadId,
    localPreparing: isLocallyPreparingWorktree,
    runStatus: activeActivityRun?.status,
    latest: latestWorktreeSetup,
    held: heldWorktreeSetup,
  });
  const worktreeSetup = resolveVisibleWorktreeSetup({
    live: liveWorktreeSetup,
    recorded: null,
    turnStarted: activeActivityRun?.startedAt != null,
    turnSettled: isSettledRunStatus(activeActivityRun?.status),
    // Counts the optimistic send too, so the row retires the moment the
    // follow-up is on screen rather than when the server echoes it back.
    followUpSent: timelineMessages.filter((message) => message.role === "user").length > 1,
  });
  // Sends wait for the agent handoff, not for the setup script: an async
  // script keeps the snapshot running while the agent already works, and a
  // follow-up must not be held behind a slow install. Before the first
  // snapshot arrives the starting session stands in for it.
  const worktreeSetupBlocksSend =
    worktreeSetup !== null
      ? worktreeSetup.phase === "running" && !worktreeSetupAgentStarted(worktreeSetup)
      : isPreparingWorktree;
  const cancelWorktreeSetup = useAtomCommand(vcsEnvironment.cancelWorktreeSetup, {
    reportFailure: false,
  });
  const retryWorkspacePreparation = useAtomCommand(threadEnvironment.retryWorkspacePreparation);
  // A resolved thread is finished: its failed setup is history, not a retry.
  const retryableRunIdsKey = useMemo(
    () =>
      serverThreadSettled
        ? ""
        : [
            ...workspacePreparationRetryRunIds(
              serverProjection?.runs ?? [],
              serverProjection?.turnItems ?? [],
            ),
          ].join("\n"),
    [serverProjection?.runs, serverProjection?.turnItems, serverThreadSettled],
  );
  // Keyed by content so the timeline context only changes when a retry appears or clears.
  const retryableWorkspacePreparationRunIds = useMemo(
    () => new Set(retryableRunIdsKey === "" ? [] : (retryableRunIdsKey.split("\n") as RunId[])),
    [retryableRunIdsKey],
  );
  const onRetryWorkspacePreparation = useCallback(
    (runId: RunId) => {
      // One retry per failed run: a second click lands after the run is preparing again.
      if (!activeThreadTarget || retryingWorkspacePreparationRunIds.has(runId)) return;
      retryingWorkspacePreparationRunIds.add(runId);
      void retryWorkspacePreparation({
        environmentId: activeThreadTarget.environmentId,
        input: { threadId: activeThreadTarget.threadId, runId },
      }).finally(() => retryingWorkspacePreparationRunIds.delete(runId));
    },
    [activeThreadTarget, retryWorkspacePreparation],
  );
  const onCancelWorktreeSetup = useCallback(() => {
    if (!worktreeSetup || worktreeSetup.phase !== "running") return;
    void cancelWorktreeSetup({
      environmentId: setupTarget.environmentId,
      input: { threadId: worktreeSetup.threadId },
    });
  }, [cancelWorktreeSetup, setupTarget.environmentId, worktreeSetup]);
  // The setup terminal belongs to the thread that was set up. A failed
  // bootstrap deletes that thread and closes its terminals, so only offer the
  // terminal while the setup thread is still the active one.
  const onOpenWorktreeSetupTerminal = useMemo(() => {
    if (
      !worktreeSetup ||
      !activeThreadTarget ||
      worktreeSetup.threadId !== activeThreadTarget.threadId
    ) {
      return null;
    }
    const setupThreadRef = activeThreadTarget;
    return (terminalId: string) => {
      storeEnsureTerminal(setupThreadRef, terminalId, { open: true, active: true });
    };
  }, [activeThreadTarget, storeEnsureTerminal, worktreeSetup]);
  const [dockedDraftHeroThreadKey, setDockedDraftHeroThreadKey] = useState<string | null>(null);
  const draftHeroDockRequested =
    activeThreadKey !== null && dockedDraftHeroThreadKey === activeThreadKey;
  const isDraftHeroState = resolveDraftHeroState({
    isLocalDraftThread,
    hasTimelineEntries: timelineEntries.length > 0,
    isWorking,
    draftHeroDockRequested,
    backgroundSubmissionPending,
    hasWorktreeSetupCard: worktreeSetup !== null,
  });
  const draftHeroTransition = useDraftHeroLayoutTransition(
    isDraftHeroState,
    panelAnimationsActive,
    panelAnimationDurationMs,
  );
  const captureDraftHeroComposerRect = draftHeroTransition.captureComposerRect;
  const {
    transitionGroupRef: draftHeroTransitionGroupRef,
    composerAnchorRef: draftHeroComposerAnchorRef,
  } = draftHeroTransition;
  const { turnDiffSummaries } = useTurnDiffSummaries(serverProjection);

  /**
   * The latest settled item after which files on disk may have changed.
   * File tools are explicit; completed commands are included because a shell
   * command can mutate the workspace without reporting the paths it touched.
   */
  const workspaceMutationId = useMemo(() => {
    let itemId: string | null = null;
    for (let index = serverVisibleTurnItems.length - 1; index >= 0; index -= 1) {
      const item = serverVisibleTurnItems[index]?.item;
      if (!item) continue;
      if (item.type !== "command_execution" && item.type !== "file_change") continue;
      if (item.status === "pending" || item.status === "running" || item.status === "waiting") {
        continue;
      }
      itemId = item.id;
      break;
    }
    const latestCheckpointCompletedAt = turnDiffSummaries.at(-1)?.completedAt ?? null;
    return itemId === null && latestCheckpointCompletedAt === null
      ? null
      : JSON.stringify([itemId, latestCheckpointCompletedAt]);
  }, [serverVisibleTurnItems, turnDiffSummaries]);

  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.workspaceRoot },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const gitStatusCwd = activeThread?.worktreePath ?? gitCwd;
  const gitStatusQuery = useEnvironmentQuery(
    gitStatusCwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd: gitStatusCwd },
        }),
  );
  useWorkspaceMutationRefresh({
    enabled: gitStatusCwd !== null,
    mutationId: workspaceMutationId,
    refresh: gitStatusQuery.refresh,
    resourceKey: `git-status:${activeThreadKey ?? ""}:${gitStatusCwd ?? ""}`,
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const scriptKeybindings =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.keybindings ??
    DEFAULT_RESOLVED_KEYBINDINGS;
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const remoteOpenState = useRemoteOpenState(activeThread?.environmentId ?? environmentId);
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName: activeProject?.title,
    activeThreadEnvironmentId: activeThread?.environmentId ?? environmentId,
    primaryEnvironmentId,
    remoteOpenMode: remoteOpenState.mode,
  });
  useOpenFavoriteEditorShortcut({
    enabled: showOpenInPicker && !suspendChatInput,
    environmentId: activeThread?.environmentId ?? environmentId,
    keybindings,
    availableEditors,
    openInCwd: gitCwd,
  });
  // The plan card: the thread's SpecWeave increment when it is bound to one,
  // else the agent's own todo list. See docs/studio/plan-progress.md.
  const threadIncrementState = useThreadIncrementState({
    environmentId: activeThreadShell?.environmentId ?? null,
    projectId: activeThreadShell?.projectId ?? null,
    threadIds: activeThreadShell ? [activeThreadShell.id] : [],
    activityKey: activeThreadShell?.updatedAt ?? null,
  });
  // Hidden for the project in the Threads pane: no unplanned headline, and the
  // card no longer opens itself for those threads.
  const [unplannedNoticeShown] = useUnplannedNoticeShown(
    activeThreadShell?.environmentId,
    activeThreadShell?.projectId,
  );
  const threadPlanView = useMemo(() => {
    const unplanned = Boolean(
      activeThreadShell &&
      !transcriptOnly &&
      unplannedNoticeShown &&
      threadIncrementState.unplanned.has(activeThreadShell.id),
    );
    return deriveThreadPlanView({
      increment: activeThreadShell
        ? (threadIncrementState.progress.get(activeThreadShell.id) ?? null)
        : null,
      todoSteps: activePlan?.steps ?? null,
      // Every worker thread shows its card, even before it has a plan, and so
      // does a thread that changed code without one.
      alwaysShow: !transcriptOnly && (isCoordinatorNamedThread(activeThreadShell) || unplanned),
      unplanned,
    });
  }, [activePlan, activeThreadShell, threadIncrementState, transcriptOnly, unplannedNoticeShown]);
  const threadPlanStatus = activeThreadShell?.activeWork?.label
    ? `Now: ${activeThreadShell.activeWork.label}`
    : null;
  const setThreadIncrementLink = useSetThreadIncrementLink();
  const threadIncrementActions = useMemo(() => {
    if (!activeThreadShell || !canOperateThread) return null;
    const threadRef = scopeThreadRef(activeThreadShell.environmentId, activeThreadShell.id);
    const projectId = activeThreadShell.projectId;
    return {
      link: () => openLinkIncrementDialog(threadRef),
      unlink: () =>
        void setThreadIncrementLink(threadRef, projectId, { type: "none" }).catch(
          (error: unknown) =>
            toastManager.add({
              type: "error",
              title: "Could not unlink the increment",
              description: error instanceof Error ? error.message : undefined,
            }),
        ),
    };
  }, [activeThreadShell, canOperateThread, setThreadIncrementLink]);
  const openThreadPath = useOpenInPreferredEditor(
    activeThreadShell?.environmentId ?? null,
    availableEditors,
  );
  const openThreadLink = useOpenLink(activeThreadTarget);
  const openThreadChangeRequest = useOpenChangeRequestLink(activeThreadTarget ?? undefined);
  const timelineWorkingFolder = useMemo(
    () =>
      // The project's own folder is implied; only a worktree is worth a chip.
      activeThreadShell && gitCwd !== null && activeThread?.worktreePath
        ? {
            label: displayFolder(gitCwd),
            path: gitCwd,
            onOpen: availableEditors.length > 0 ? () => void openThreadPath(gitCwd) : undefined,
          }
        : null,
    [
      activeThread?.worktreePath,
      activeThreadShell,
      availableEditors.length,
      gitCwd,
      openThreadPath,
    ],
  );
  const threadPullRequests = activeThreadShell?.pullRequests ?? [];
  const manualCompactionProviderAvailable = useMemo(
    () =>
      hasAvailableCompactionProvider({
        providers: providerInstanceEntries,
        driverKind: selectedProvider,
        instanceId: activeProviderInstanceId,
        lockedInstanceId: lockedProvider
          ? (activeRuntime?.providerInstanceId ?? activeThread?.modelSelection.instanceId ?? null)
          : null,
      }),
    [
      activeProviderInstanceId,
      activeThread?.modelSelection.instanceId,
      activeRuntime?.providerInstanceId,
      lockedProvider,
      providerInstanceEntries,
      selectedProvider,
    ],
  );
  const [resumeCompactionPermanentlyDismissed, setResumeCompactionPermanentlyDismissed] =
    useLocalStorage(
      `studio:resume-compaction-dismissed:${environmentId}:${activeProviderInstanceId ?? "claudeAgent"}`,
      false,
      Schema.Boolean,
    );
  const nativeResumeCompactionDismissed = useMemo(
    () =>
      hasDismissedResumeCompaction(
        (serverProjection?.runtimeRequests ?? [])
          .filter((request) => request.kind === "user_input" && request.status === "resolved")
          .map((request) => ({
            kind: "user-input.resolved",
            payload: { answers: request.answers },
          })),
      ),
    [serverProjection?.runtimeRequests],
  );
  useEffect(() => {
    if (nativeResumeCompactionDismissed && !resumeCompactionPermanentlyDismissed) {
      setResumeCompactionPermanentlyDismissed(true);
    }
  }, [
    nativeResumeCompactionDismissed,
    resumeCompactionPermanentlyDismissed,
    setResumeCompactionPermanentlyDismissed,
  ]);
  const providerStatusBannerKey = getProviderStatusBannerKey(activeProviderStatus);
  const [dismissedProviderStatusBannerKey, setDismissedProviderStatusBannerKey] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (providerStatusBannerKey === null && dismissedProviderStatusBannerKey !== null) {
      setDismissedProviderStatusBannerKey(null);
    }
  }, [dismissedProviderStatusBannerKey, providerStatusBannerKey]);
  const visibleProviderStatus = shouldShowProviderStatusBanner(
    activeProviderStatus,
    dismissedProviderStatusBannerKey,
  )
    ? activeProviderStatus
    : null;
  const hasTimelineTopBanner = Boolean(timelineThreadError) || visibleProviderStatus !== null;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeWorkspaceRoot = activeThreadWorktreePath ?? activeProjectCwd ?? undefined;
  useLayoutEffect(() => {
    if (
      threadDetailLoading ||
      timelineEntries.length === 0 ||
      timelineHasEphemeralPreviewUrls(timelineEntries)
    ) {
      return;
    }
    rememberReadyThreadTimeline({
      threadKey: activeThreadKey,
      entries: timelineEntries,
      markdownCwd: gitCwd,
      workspaceRoot: activeWorkspaceRoot ?? null,
    });
  }, [activeThreadKey, activeWorkspaceRoot, gitCwd, threadDetailLoading, timelineEntries]);
  const heldPaintContext = useRenderRead(() =>
    paintOnlyDisplayedTimeline ? peekHeldThreadTimeline<typeof timelineEntries>() : null,
  );
  const activeTerminalLaunchContext =
    terminalUiLaunchContext?.threadId === activeThreadId ? terminalUiLaunchContext : null;
  // Git status arrives after the composer paints. A checkout seen earlier in
  // this session answers from memory, so a non-Git project does not mount the
  // branch strip and then drop it. A never-seen checkout assumes Git, which
  // is what nearly every project is.
  const liveIsGitRepo = gitStatusQuery.data?.isRepo;
  useEffect(() => {
    if (gitStatusCwd !== null && liveIsGitRepo !== undefined) {
      rememberCheckoutIsRepo(environmentId, gitStatusCwd, liveIsGitRepo);
    }
  }, [environmentId, gitStatusCwd, liveIsGitRepo]);
  const isGitRepo = liveIsGitRepo ?? recallCheckoutIsRepo(environmentId, gitStatusCwd) ?? true;
  // When context is enabled, keep a hidden, off-flow strip mounted so the composer
  // can measure whether its relocated controls fit. The visible chrome remains
  // content-driven: Git/environment context or controls that actually fit.
  // A provider-native subagent cannot take messages: a status bar replaces the
  // composer and its strips. Its approvals and questions are asked on the
  // top-level parent thread.
  const showProviderSubagentBar = isProviderSubagent;
  const composerMounted = !showProviderSubagentBar;
  const providerSubagentModels = selectedProviderEntry?.models ?? EMPTY_PROVIDER_MODELS;
  // Providers can report a dated id or alias (claude-haiku-4-5-20251001).
  const providerSubagentModelSlug = selectedProviderEntry
    ? resolveSelectableModel(
        selectedProviderEntry.driverKind,
        activeThread?.modelSelection.model,
        providerSubagentModels,
      )
    : null;
  const providerSubagentCatalogModel = providerSubagentModels.find(
    (model) => model.slug === providerSubagentModelSlug,
  );
  const providerSubagentModelLabel = providerSubagentCatalogModel
    ? getTriggerDisplayModelName(providerSubagentCatalogModel)
    : formatModelSlugName(activeThread?.modelSelection.model ?? "");
  const providerSubagentEffortLabel =
    activeThread === undefined
      ? null
      : formatModelSelectionEffort(
          activeThread.modelSelection,
          providerSubagentModels,
          reportedModelSelection,
        );
  const mountComposerContextStrip = shouldShowComposerContextStrip({
    isDraftHeroState,
    persistInActiveThreads: settings.persistComposerContextStrip,
    hasActiveProject: activeProject !== null && !showProviderSubagentBar,
    isGitRepo,
    showEnvironmentIndicator: showComposerEnvironmentIndicator,
    hostsRestingComposerControls: routeKind === "server",
  });
  const showComposerContextStrip = shouldShowComposerContextStrip({
    isDraftHeroState,
    persistInActiveThreads: settings.persistComposerContextStrip,
    hasActiveProject: activeProject !== null && !showProviderSubagentBar,
    isGitRepo,
    showEnvironmentIndicator: showComposerEnvironmentIndicator,
    hostsRestingComposerControls: routeKind === "server" && restingComposerControlsVisible,
  });
  const mountComposerModelStrip =
    routeKind === "server" && !mountComposerContextStrip && !showProviderSubagentBar;
  const showComposerModelStrip = mountComposerModelStrip && restingComposerControlsVisible;
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: true,
        terminalOpen: Boolean(terminalUiState.terminalOpen),
      },
    }),
    [terminalUiState.terminalOpen],
  );
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const splitTerminalVerticalShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "terminal.splitVertical", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const onToggleDiff = useCallback(() => {
    if (!isServerThread) {
      return;
    }
    if (!diffOpen) {
      onDiffPanelOpen?.();
    }
    if (activeThreadTarget) {
      useRightPanelStore.getState().toggle(activeThreadTarget, "diff");
    }
  }, [activeThreadTarget, diffOpen, isServerThread, onDiffPanelOpen]);

  const needsLoadBalancing = automaticEnvironment && !draftThread?.loadBalancedEnvironmentId;
  return {
    activeActivityRun,
    activeComposerTaskSteps,
    activeComposerTasksProgress,
    activeContextWindow,
    activeCoordinatorShell,
    activeDraftLogicalProjectKey,
    activeEnvironmentConnectionPhase,
    activeEnvironmentIsThisMachine,
    activeEnvironmentServerBrowser,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    activeEnvironmentUnavailableState,
    activeKnownTerminalIds,
    activeLatestRun,
    activeMessageCount,
    activePendingApproval,
    activePendingDraftAnswers,
    activePendingIsResponding,
    activePendingProgress,
    activePendingQuestionIndex,
    activePendingRequestKey,
    activePendingResolvedAnswers,
    activePendingUserInput,
    activePreviewMiniPlayer,
    activePreviewState,
    activeProject,
    activeProjectCwd,
    activeProjectDefaultModelSelection,
    activeProjectIsScratch,
    continueElsewhereRef,
    continueElsewhereTarget,
    activeProjectKey,
    activeProjectScripts,
    activeProjectSettings,
    activeProjectTarget,
    activeProposedPlan,
    activeProviderInstanceId,
    activeProviderStatus,
    activeRightPanelSurface,
    activeRuntime,
    activeTerminalLabelsById,
    activeTerminalLaunchContext,
    activeThread,
    activeThreadId,
    activeThreadKey,
    activeThreadShell,
    activeThreadTarget,
    activeThreadWorktreePath,
    activeWorkStartedAt,
    activeWorkspaceRoot,
    addComposerDraftFiles,
    addComposerDraftImages,
    allProjects,
    allocateTerminalId,
    attachmentUploadsCapabilityKnown,
    automaticEnvironment,
    availableEditors,
    backgroundSubmissionPending,
    baseComposerDraftTarget,
    beginLocalDispatch,
    branchToolbarRef,
    browserAvailable,
    canAutoBalanceEnvironments,
    canCheckoutPullRequestIntoThread,
    canMaximizeRightPanel,
    canOperateTerminal,
    canOperateThread,
    canReadTerminal,
    canReuseTerminal,
    canWriteSourceControl,
    cancelWorktreeSetup,
    captureDraftHeroComposerRect,
    citationRequest,
    citeAssistantText,
    clearComposerDraftContent,
    clearUsageLimitsFor,
    clientSettingsHydrated,
    closeIdleTerminalsMutation,
    closePreview,
    closePullRequestDialog,
    closeTerminalMutation,
    closeTerminalShortcutLabel,
    collapseLongReports,
    composerDraftTarget,
    composerFilesRef,
    composerHasNonPromptContent,
    composerImagesRef,
    composerMounted,
    composerMountedRef,
    composerOverlayElement,
    composerRef,
    composerRestingRef,
    composerSendGenerationRef,
    composerTerminalContextsRef,
    composerTimelineInset,
    composerTimelineInsetRef,
    configuredPreviewUrls,
    confirmAndUnpinThread,
    createAttachmentAssetUrl,
    createThread,
    currentRouteThreadKeyRef,
    defaultRuntimeMode,
    deleteThread,
    diffOpen,
    dismissThreadUserInput,
    dismissedUsageApproaching,
    displayedThreadTarget,
    displayedTimeline,
    displayedTimelineKey,
    downloadFileAttachment,
    draftHeroComposerAnchorRef,
    draftHeroTransitionGroupRef,
    draftId,
    draftThread,
    editingQueuedRun,
    embeddedHeaderToolsTarget,
    envLocked,
    environmentById,
    environmentId,
    environmentUnavailableSendToastSlotRef,
    environments,
    expandedImage,
    explicitDiffOpenRef,
    feedbackSubmissions,
    feedbackUploading,
    feedbackUploadsInFlightRef,
    forceExpandedMobileComposer,
    forkThreadFromRun,
    getTimelineScrollableNode,
    gitCwd,
    gitStatusQuery,
    handleFilePendingChange,
    handleNewThreadInActiveProject,
    handleOpenDraftProjectSettings,
    handlePreparedPullRequestThread,
    handoffAttachmentPreviews,
    hasHeldQueuedRuns,
    hasMultipleEnvironments,
    hasTerminalWriteAccess,
    hasTimelineTopBanner,
    heldPaintContext,
    inlineRightPanelOwnsTitleBar,
    interactionMode,
    interactionModeEnabled,
    interruptThreadTurn,
    isAtEndRef,
    isCompacting,
    isConnecting,
    isDraftHeroState,
    isGitRepo,
    isLocalDraftThread,
    isPhoneKeyboard,
    isPreparingWorktree,
    isResuming,
    isRevertingCheckpoint,
    isSendBusy,
    isServerThread,
    isTimelineAtLogicalEnd,
    isWorking,
    isWorkspaceFileDragActive,
    keybindings,
    lastInvokedScriptByProjectId,
    latestRunSettled,
    layoutMode,
    legendListRef,
    loadBalancingSettings,
    localServerError,
    lockedProvider,
    logicalProjectEnvironments,
    manualCompactionProviderAvailable,
    maxFileAttachmentBytes,
    modelPickerLockedProvider,
    mountComposerContextStrip,
    mountComposerModelStrip,
    mountedTerminalThreadRefs,
    multipleModelSelections,
    multipleModelSelectionsRef,
    nativeResumeCompactionDismissed,
    navigate,
    needsLoadBalancing,
    newTerminalShortcutLabel,
    nowMinute,
    onCancelWorktreeSetup,
    onDiffPanelOpen,
    onOpenWorktreeSetupTerminal,
    onRetryWorkspacePreparation,
    onToggleDiff,
    openCoordinatorHandoff,
    openFileAttachment,
    openNewChatDestination,
    openPreview,
    openPullRequestDialog,
    openScratchProject,
    openTerminal,
    openThreadChangeRequest,
    openThreadLink,
    openThreadPath,
    openThreadRoute,
    openUsageLimits,
    optimisticUserMessages,
    paintOnlyDisplayedTimeline,
    panelAnimationDurationMs,
    panelAnimationsActive,
    parentThreadLink,
    pasteAsTextShortcutUntilRef,
    pendingApprovals,
    pendingBackgroundTasks,
    pendingFileSurfaceIds,
    pendingServerThreadBranch,
    pendingServerThreadEnvMode,
    pendingServerThreadStartFromOriginByThreadId,
    pendingUserInputAnswersByRequestId,
    pendingUserInputs,
    phase,
    pinThread,
    previewMiniPlayerVisible,
    previewPanelInlineSize,
    previewPanelOpen,
    projectCloneBannerItem,
    projectCloneSendBlockReason,
    projectDraftSendGuard,
    projectGroupingSettings,
    projectRouting,
    promptRef,
    providerInstanceEntries,
    providerStatusBannerKey,
    providerStatuses,
    providerSubagentEffortLabel,
    providerSubagentModelLabel,
    providerSubagentStatus,
    providerSubagentStep,
    pullRequestDialogState,
    pullRequestsCapabilityKnown,
    queuedEditDraftTargetFor,
    removeKeybinding,
    renderedRightPanelSurface,
    renderedRightPanelSurfaces,
    reportedModelSelection,
    reserveTitleBarControlInset,
    resetLocalDispatch,
    resolvePreviewRuntimeTabId,
    resolvedTheme,
    respondToThreadApproval,
    respondToThreadUserInput,
    respondingRequestIds,
    respondingUserInputRequestIds,
    restingComposerControlsHost,
    resumableRunId,
    resumeCompactionPermanentlyDismissed,
    resumeThreadQueue,
    retryableWorkspacePreparationRunIds,
    revertThreadCheckpoint,
    reviewOnly,
    rightPanelControlsAtRoot,
    rightPanelControlsInPanel,
    rightPanelMaximized,
    rightPanelOpen,
    rightPanelPresent,
    rightPanelState,
    routeKind,
    routeThreadKey,
    routeThreadTarget,
    runlessWorkStartedAt,
    runningTerminalIds,
    runtimeMode,
    scriptKeybindings,
    scrollToEndClearance,
    selectedProvider,
    selectedProviderEntry,
    sendInFlightRef,
    serverAcknowledgedUserMessageIds,
    serverConfig,
    serverProjection,
    timelineSubagentParent,
    serverRuntime,
    serverRuntimeError,
    serverThread,
    serverThreadSettled,
    serverVisibleTurnItems,
    setComposerDraftInteractionMode,
    setComposerDraftModelSelection,
    setComposerDraftPreviewAnnotations,
    setComposerDraftPrompt,
    setComposerDraftReviewComments,
    setComposerDraftRuntimeMode,
    setComposerDraftTerminalContexts,
    setComposerDraftThreadContexts,
    setComposerOverlayElement,
    setComposerTimelineInset,
    setDismissedProviderStatusBannerKey,
    setDismissedUsageApproaching,
    setDockedDraftHeroThreadKey,
    setDraftThreadContext,
    setEditingQueuedRun,
    setExpandedImage,
    setFeedbackSubmissionsByThreadKey,
    setIsWorkspaceFileDragActive,
    setLastInvokedScriptByProjectId,
    setLocalDraftErrorsByDraftId,
    setLocalServerErrorsByThreadKey,
    setMaximizedRightPanelThreadKey,
    setMultipleModelSelections,
    setOptimisticUserMessages,
    setPendingServerThreadBranch,
    setPendingServerThreadEnvMode,
    setPendingServerThreadStartFromOriginByThreadId,
    setPendingUserInputAnswersByRequestId,
    setPendingUserInputQuestionIndexByRequestId,
    setPullRequestDialogState,
    setRespondingRequestIds,
    setRespondingUserInputRequestIds,
    setRestingComposerControlsHost,
    setRestingComposerControlsVisible,
    setResumingThreadKeys,
    setScrollToEndClearance,
    setShowScrollToBottom,
    setStickyComposerModelSelection,
    setTerminalFocusRequestId,
    setTerminalUiLaunchContext,
    setThreadErrorBannerDismissTick,
    setThreadInteractionMode,
    setThreadPanelPresentation,
    setThreadRuntimeMode,
    setTimelineAnchor,
    setTimelineOverflows,
    setWorkLocallyResendDraftId,
    setWorktreeSetupThread,
    settings,
    settleThread,
    setupTarget,
    shouldUsePlanSidebarSheet,
    showComposerContextStrip,
    showComposerEnvironmentIndicator,
    showComposerModelStrip,
    showOpenInPicker,
    showPlanFollowUpPrompt,
    showProviderSubagentBar,
    showScrollToBottom,
    splitTerminalShortcutLabel,
    splitTerminalVerticalShortcutLabel,
    startThreadTurn,
    storeCloseTerminal,
    storeEnsureTerminal,
    storeNewTerminal,
    storeSetActiveTerminal,
    storeSetTerminalOpen,
    storeSplitTerminal,
    storeSplitTerminalVertical,
    supportsAttachmentUploads,
    supportsConversationRollback,
    supportsProviderSwitchingViaHandoff,
    supportsPullRequests,
    supportsQuestionAttachments,
    suspendChatInput,
    switchGitRevision,
    systemComposerBannerItems,
    terminalFocusRequestId,
    terminalUiOpenByThreadRef,
    terminalUiState,
    threadDetailLoading,
    threadErrorBannerKey,
    threadHistoryControls,
    threadId,
    threadIncrementActions,
    threadPanelOpen,
    threadPanelPopoverAnchorRef,
    threadPanelPopoverHandle,
    threadPanelPresentation,
    threadPlanStatus,
    threadPlanView,
    threadPullRequests,
    threadStatus,
    threadSyncPhase,
    timelineAnchorMessageId,
    timelineBannerOverlayHeight,
    timelineBannerOverlayHeightRef,
    timelineBannerOverlayRef,
    timelineEntries,
    timelineMessages,
    timelineOverflows,
    timelineRunHealth,
    timelineActiveHost,
    timelineThreadError,
    timelineWorkingFolder,
    timestampFormat,
    transcriptOnly,
    turnDiffSummaries,
    uncertainMultipleSubmissionsRef,
    updateProjectScriptSettings,
    updateThreadMetadata,
    uploadThreadFeedback,
    upsertKeybinding,
    usageLimitsBanner,
    usageLimitsKey,
    usageLimitsOffered,
    userInputResponsesInFlight,
    visibleProviderStatus,
    visibleThreadError,
    workLocallyResendDraftId,
    workspaceLayoutRef,
    workspaceMutationId,
    worktreeSetup,
    worktreeSetupBlocksSend,
    worktreeSetupOwnerKey,
    writeTerminal,
  };
}

/** The second part of ChatView's body: handlers and derived state. */
function useChatViewActions(
  props: ChatViewProps,
  chatViewState: ReturnType<typeof useChatViewState>,
) {
  const {
    activeActivityRun,
    activeContextWindow,
    activeCoordinatorShell,
    activeEnvironmentServerBrowser,
    activeEnvironmentUnavailable,
    activeKnownTerminalIds,
    activeLatestRun,
    activeMessageCount,
    activePreviewMiniPlayer,
    activePreviewState,
    activeProject,
    activeProjectCwd,
    activeProjectIsScratch,
    activeProjectKey,
    activeProjectScripts,
    activeProjectSettings,
    activeProviderInstanceId,
    activeRightPanelSurface,
    activeRuntime,
    activeTerminalLabelsById,
    activeThread,
    activeThreadId,
    activeThreadKey,
    activeThreadShell,
    activeThreadTarget,
    activeThreadWorktreePath,
    allProjects,
    allocateTerminalId,
    automaticEnvironment,
    baseComposerDraftTarget,
    beginLocalDispatch,
    browserAvailable,
    canMaximizeRightPanel,
    canOperateThread,
    canReuseTerminal,
    canWriteSourceControl,
    clearComposerDraftContent,
    clearUsageLimitsFor,
    clientSettingsHydrated,
    closeIdleTerminalsMutation,
    closePreview,
    closeTerminalMutation,
    composerDraftTarget,
    composerMounted,
    composerMountedRef,
    composerOverlayElement,
    composerRef,
    composerRestingRef,
    composerTimelineInset,
    composerTimelineInsetRef,
    diffOpen,
    draftId,
    draftThread,
    editingQueuedRun,
    envLocked,
    environmentById,
    environmentId,
    environments,
    feedbackSubmissions,
    feedbackUploading,
    gitCwd,
    gitStatusQuery,
    handoffAttachmentPreviews,
    hasTerminalWriteAccess,
    interactionMode,
    interactionModeEnabled,
    interruptThreadTurn,
    isAtEndRef,
    isGitRepo,
    isLocalDraftThread,
    isPhoneKeyboard,
    isPreparingWorktree,
    isRevertingCheckpoint,
    isServerThread,
    isTimelineAtLogicalEnd,
    isWorking,
    latestRunSettled,
    legendListRef,
    loadBalancingSettings,
    logicalProjectEnvironments,
    manualCompactionProviderAvailable,
    nativeResumeCompactionDismissed,
    navigate,
    needsLoadBalancing,
    nowMinute,
    onDiffPanelOpen,
    openPreview,
    openScratchProject,
    openTerminal,
    openThreadRoute,
    optimisticUserMessages,
    parentThreadLink,
    pendingApprovals,
    pendingBackgroundTasks,
    pendingServerThreadBranch,
    pendingServerThreadEnvMode,
    pendingServerThreadStartFromOriginByThreadId,
    pendingUserInputs,
    phase,
    previewPanelOpen,
    projectGroupingSettings,
    projectRouting,
    providerStatuses,
    pullRequestsCapabilityKnown,
    queuedEditDraftTargetFor,
    removeKeybinding,
    resetLocalDispatch,
    resumableRunId,
    resumeCompactionPermanentlyDismissed,
    rightPanelOpen,
    rightPanelState,
    routeThreadKey,
    routeThreadTarget,
    runningTerminalIds,
    runtimeMode,
    selectedProvider,
    sendInFlightRef,
    serverAcknowledgedUserMessageIds,
    serverConfig,
    serverProjection,
    serverRuntime,
    serverThread,
    serverThreadSettled,
    serverVisibleTurnItems,
    setComposerDraftInteractionMode,
    setComposerDraftPrompt,
    setComposerDraftRuntimeMode,
    setComposerTimelineInset,
    setDraftThreadContext,
    setEditingQueuedRun,
    setExpandedImage,
    setFeedbackSubmissionsByThreadKey,
    setLastInvokedScriptByProjectId,
    setLocalDraftErrorsByDraftId,
    setLocalServerErrorsByThreadKey,
    setMaximizedRightPanelThreadKey,
    setOptimisticUserMessages,
    setPullRequestDialogState,
    setScrollToEndClearance,
    setShowScrollToBottom,
    setTerminalFocusRequestId,
    setTerminalUiLaunchContext,
    setThreadInteractionMode,
    setThreadRuntimeMode,
    setTimelineAnchor,
    settings,
    shouldUsePlanSidebarSheet,
    showPlanFollowUpPrompt,
    showScrollToBottom,
    startThreadTurn,
    storeCloseTerminal,
    storeEnsureTerminal,
    storeNewTerminal,
    storeSetActiveTerminal,
    storeSetTerminalOpen,
    storeSplitTerminal,
    storeSplitTerminalVertical,
    supportsProviderSwitchingViaHandoff,
    supportsPullRequests,
    switchGitRevision,
    terminalUiState,
    threadDetailLoading,
    threadId,
    threadPanelPresentation,
    threadStatus,
    timelineAnchorMessageId,
    timelineBannerOverlayHeightRef,
    timelineEntries,
    transcriptOnly,
    turnDiffSummaries,
    updateProjectScriptSettings,
    updateThreadMetadata,
    upsertKeybinding,
    writeTerminal,
  } = chatViewState;
  const renderNowMs = useRenderTime();
  const loadBalancingCandidates = useMemo(
    () =>
      needsLoadBalancing
        ? logicalProjectEnvironments
            .filter((candidate) => {
              const environment = environmentById.get(candidate.environmentId);
              return (
                environment?.connection.phase === "connected" &&
                readEnvironmentScope(candidate.environmentId, AuthOrchestrationOperateScope) &&
                (loadBalancingSettings.loadBalancingWeights[candidate.environmentId] ?? 50) > 0 &&
                environment.serverConfig?.providers.some(
                  (provider) =>
                    (activeProviderInstanceId === null ||
                      provider.instanceId === activeProviderInstanceId) &&
                    provider.driver === selectedProvider &&
                    provider.enabled &&
                    provider.installed &&
                    provider.status !== "error" &&
                    provider.auth.status !== "unauthenticated" &&
                    provider.availability !== "unavailable",
                )
              );
            })
            .map((candidate) => candidate.environmentId)
        : [],
    [
      needsLoadBalancing,
      logicalProjectEnvironments,
      environmentById,
      loadBalancingSettings.loadBalancingWeights,
      activeProviderInstanceId,
      selectedProvider,
    ],
  );
  const loadBalancing = useLoadBalancedEnvironment(
    loadBalancingCandidates,
    loadBalancingSettings.loadBalancingWeights,
  );
  const {
    draftMachinePendingRef,
    environmentChangeRef,
    isEnvironmentChanging,
    onDraftMachinePendingChange,
    onAutoEnvironment,
    onEnvironmentChange,
  } = useDraftMachineRouting({
    draftId,
    draftThread,
    envLocked,
    sendInFlightRef,
    environments,
    allProjects,
    logicalProjectEnvironments,
    projectGroupingSettings,
    activeProjectIsScratch,
    activeProjectKey,
    needsLoadBalancing,
    loadBalancing,
    openScratchProject,
  });
  const autoEnvironmentLabel = automaticEnvironment
    ? draftThread?.loadBalancedEnvironmentId
      ? "Auto balance"
      : loadBalancing.pending
        ? "Checking machines…"
        : loadBalancing.failed
          ? "Auto balance unavailable"
          : "Auto balance"
    : undefined;

  const activeTerminalGroup =
    terminalUiState.terminalGroups.find(
      (group) => group.id === terminalUiState.activeTerminalGroupId,
    ) ??
    terminalUiState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalUiState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      const nextError = sanitizeThreadErrorMessage(error);
      const nextEntry: LocalThreadErrorEntry = { message: nextError, at: Date.now() };
      if (
        serverThread &&
        targetThreadId === routeThreadTarget.threadId &&
        serverThread.environmentId === routeThreadTarget.environmentId &&
        serverThread.id === targetThreadId
      ) {
        setLocalServerErrorsByThreadKey((existing) => {
          if ((existing[routeThreadKey]?.message ?? null) === nextError) {
            return existing;
          }
          return {
            ...existing,
            [routeThreadKey]: nextEntry,
          };
        });
        return;
      }
      const localDraftErrorKey = draftId ?? targetThreadId;
      setLocalDraftErrorsByDraftId((existing) => {
        if ((existing[localDraftErrorKey]?.message ?? null) === nextError) {
          return existing;
        }
        return {
          ...existing,
          [localDraftErrorKey]: nextEntry,
        };
      });
    },
    [
      draftId,
      routeThreadKey,
      routeThreadTarget,
      serverThread,
      setLocalServerErrorsByThreadKey,
      setLocalDraftErrorsByDraftId,
    ],
  );

  const focusComposer = useCallback(() => {
    composerRef.current?.focusAtEnd();
  }, [composerRef]);
  const canInterruptRunningThread =
    canOperateThread && deriveCanInterruptRunningThread(activeThread !== undefined, activeRuntime);
  const onInterrupt = useCallback(async () => {
    if (
      !activeThread ||
      !readEnvironmentScope(activeThread.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const result = await interruptThreadTurn({
      environmentId,
      input: { threadId: activeThread.id },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to interrupt the current turn.",
      );
    }
  }, [activeThread, environmentId, interruptThreadTurn, setThreadError]);
  // `/continue` resumes like the Continue button, which is declared further down.
  const resumeForAppCommandRef = useRef<() => void>(() => {});
  const continueSelfForAppCommand = useCallback(() => resumeForAppCommandRef.current(), []);
  const appCommandsOffered = isServerThread && serverThread !== null && canOperateThread;
  const runAppCommand = useComposerAppCommands({
    thread: isServerThread ? serverThread : null,
    stopSelf: onInterrupt,
    continueSelf: continueSelfForAppCommand,
  });
  useEffect(() => subscribeSnapShotComposerFocus(focusComposer), [focusComposer]);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  const useArtifactTemplate = useCallback(
    (template: CodexArtifactTemplate) => {
      const composer = composerRef.current;
      if (!composer) return;

      const currentDraft = composer.getSendContext().prompt;
      const prompt = codexArtifactTemplatePromptToAppend(currentDraft, template);
      if (prompt !== null && !composer.insertTextAtEnd(prompt, { ensureLeadingBoundary: true })) {
        toastManager.add({
          type: "error",
          title: "Unable to add to chat",
          description: "The composer is busy; try again once it is ready.",
        });
        return;
      }
      scheduleComposerFocus();
    },
    [composerRef, scheduleComposerFocus],
  );
  const editQueuedRunCommand = useAtomCommand(threadEnvironment.editQueuedRun, {
    reportFailure: false,
  });
  const queuedRunsControlRef = useRef<QueuedRunsControlHandle>(null);
  const queuedEditSaveInFlightRef = useRef(false);
  const [isSavingQueuedEdit, setIsSavingQueuedEdit] = useState(false);
  const queuedEditImageResources = useMemo(
    () =>
      (editingQueuedRun?.existingAttachments ?? [])
        .filter((attachment) => attachment.type === "image")
        .map((attachment) => ({ _tag: "attachment" as const, attachmentId: attachment.id })),
    [editingQueuedRun],
  );
  const queuedEditImageUrls = useAssetUrls(environmentId, queuedEditImageResources);
  const composerEditingQueuedAttachments = useMemo(() => {
    if (editingQueuedRun === null) return null;
    const urlByAttachmentId = new Map(
      queuedEditImageResources.map((resource, index) => [
        resource.attachmentId,
        queuedEditImageUrls[index] ?? null,
      ]),
    );
    return editingQueuedRun.existingAttachments.map((attachment) => ({
      attachment,
      url: urlByAttachmentId.get(attachment.id) ?? null,
    }));
  }, [editingQueuedRun, queuedEditImageResources, queuedEditImageUrls]);
  const beginEditingQueuedRun = useCallback(
    (request: EditQueuedRunRequest) => {
      if (!activeThread) return;
      if (editingQueuedRun !== null && editingQueuedRun.runId !== request.runId) {
        clearComposerDraftContent(queuedEditDraftTargetFor(editingQueuedRun.runId));
      }
      const target = queuedEditDraftTargetFor(request.runId);
      clearComposerDraftContent(target);
      setComposerDraftPrompt(target, request.text);
      setEditingQueuedRun({
        threadId: activeThread.id,
        runId: request.runId,
        messageId: request.messageId,
        originalText: request.text,
        existingAttachments: request.attachments,
        context: serverProjection?.messages.find((message) => message.id === request.messageId)
          ?.context,
      });
      scheduleComposerFocus();
    },
    [
      activeThread,
      clearComposerDraftContent,
      editingQueuedRun,
      queuedEditDraftTargetFor,
      serverProjection,
      scheduleComposerFocus,
      setComposerDraftPrompt,
      setEditingQueuedRun,
    ],
  );
  const cancelEditingQueuedRun = useCallback(() => {
    if (editingQueuedRun === null) return;
    clearComposerDraftContent(queuedEditDraftTargetFor(editingQueuedRun.runId));
    setEditingQueuedRun(null);
    scheduleComposerFocus();
  }, [
    clearComposerDraftContent,
    editingQueuedRun,
    queuedEditDraftTargetFor,
    scheduleComposerFocus,
    setEditingQueuedRun,
  ]);
  const removeEditingQueuedAttachment = useCallback(
    (attachmentId: string) => {
      setEditingQueuedRun((current) =>
        current === null
          ? current
          : {
              ...current,
              existingAttachments: current.existingAttachments.filter(
                (attachment) => attachment.id !== attachmentId,
              ),
            },
      );
    },
    [setEditingQueuedRun],
  );
  // Exit edit mode when the edited run leaves the queue (it started, or was
  // cancelled from another client). A dirty edit moves into the thread's own
  // draft when that draft is empty; otherwise it is dropped with a toast.
  useEffect(() => {
    if (editingQueuedRun === null) return;
    if (activeThread?.id !== editingQueuedRun.threadId) {
      setEditingQueuedRun(null);
      return;
    }
    if (serverProjection === null) return;
    const run = serverProjection.runs.find((candidate) => candidate.id === editingQueuedRun.runId);
    if (run !== undefined && run.status === "queued") return;
    const recovery = recoverQueuedMessageEdit({
      editTarget: queuedEditDraftTargetFor(editingQueuedRun.runId),
      threadTarget: baseComposerDraftTarget,
      originalText: editingQueuedRun.originalText,
    });
    if (recovery === "kept") {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Queued message is no longer queued",
          description: "Your unsaved edit was kept in the composer.",
        }),
      );
    } else if (recovery === "discarded") {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Queued message is no longer queued",
          description: "Your unsaved edit was discarded.",
        }),
      );
    }
    setEditingQueuedRun(null);
  }, [
    activeThread?.id,
    baseComposerDraftTarget,
    editingQueuedRun,
    queuedEditDraftTargetFor,
    serverProjection,
  ]);
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      composerRef.current?.addTerminalContext(selection);
    },
    [composerRef],
  );
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadTarget) return;
      storeSetTerminalOpen(activeThreadTarget, open);
    },
    [activeThreadTarget, storeSetTerminalOpen],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadTarget) return;
    const nextOpen = !terminalUiState.terminalOpen;
    if (!nextOpen) {
      setTerminalOpen(false);
      // A shell left at an idle prompt would keep running under the service
      // (and block its updates), so hiding the drawer closes it. A terminal
      // running a command stays for the user to close.
      if (hasTerminalWriteAccess() && activeThreadId && terminalUiState.terminalIds.length > 0) {
        const threadRef = activeThreadTarget;
        void closeIdleTerminalsMutation({
          environmentId,
          input: { threadId: activeThreadId },
        }).then((result) => {
          if (result._tag !== "Success") return;
          for (const terminalId of result.value.closedTerminalIds) {
            storeCloseTerminal(threadRef, terminalId);
          }
        });
      }
      return;
    }
    if (
      nextOpen &&
      !readEnvironmentScope(environmentId, AuthTerminalReadScope) &&
      !hasTerminalWriteAccess()
    )
      return;
    if (nextOpen && hasTerminalWriteAccess() && terminalUiState.terminalIds.length === 0) {
      if (!activeThreadId || !activeProject) {
        return;
      }
      const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
      if (!cwdForOpen) {
        return;
      }
      const terminalId = allocateTerminalId();
      storeEnsureTerminal(activeThreadTarget, terminalId, { open: true });
      void openTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd: cwdForOpen,
          fallbackCwd: activeProject.workspaceRoot,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      });
      return;
    }
    setTerminalOpen(nextOpen);
  }, [
    activeProject,
    activeThreadId,
    activeThreadTarget,
    activeThreadWorktreePath,
    allocateTerminalId,
    closeIdleTerminalsMutation,
    environmentId,
    gitCwd,
    openTerminal,
    hasTerminalWriteAccess,
    setTerminalOpen,
    storeCloseTerminal,
    storeEnsureTerminal,
    terminalUiState.terminalIds.length,
    terminalUiState.terminalOpen,
  ]);
  const splitTerminal = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal") => {
      if (
        !hasTerminalWriteAccess() ||
        !activeThreadTarget ||
        hasReachedSplitLimit ||
        !activeThreadId ||
        !activeProject
      ) {
        return;
      }
      const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
      if (!cwdForOpen) {
        return;
      }
      const terminalId = allocateTerminalId();
      if (direction === "vertical") {
        storeSplitTerminalVertical(activeThreadTarget, terminalId);
      } else {
        storeSplitTerminal(activeThreadTarget, terminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);
      void openTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd: cwdForOpen,
          fallbackCwd: activeProject.workspaceRoot,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      });
    },
    [
      activeProject,
      activeThreadId,
      allocateTerminalId,
      activeThreadTarget,
      openTerminal,
      hasTerminalWriteAccess,
      activeThreadWorktreePath,
      environmentId,
      gitCwd,
      hasReachedSplitLimit,
      storeSplitTerminal,
      storeSplitTerminalVertical,
      setTerminalFocusRequestId,
    ],
  );
  const createNewTerminal = useCallback(() => {
    if (!hasTerminalWriteAccess() || !activeThreadTarget || !activeThreadId || !activeProject) {
      return;
    }
    const cwdForOpen = gitCwd ?? activeProject.workspaceRoot;
    if (!cwdForOpen) {
      return;
    }
    const terminalId = allocateTerminalId();
    storeNewTerminal(activeThreadTarget, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
    void openTerminal({
      environmentId,
      input: {
        threadId: activeThreadId,
        terminalId,
        cwd: cwdForOpen,
        fallbackCwd: activeProject.workspaceRoot,
        ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: activeProject.workspaceRoot },
          worktreePath: activeThreadWorktreePath,
        }),
      },
    });
  }, [
    activeProject,
    activeThreadId,
    allocateTerminalId,
    activeThreadTarget,
    openTerminal,
    hasTerminalWriteAccess,
    activeThreadWorktreePath,
    environmentId,
    gitCwd,
    storeNewTerminal,
    setTerminalFocusRequestId,
  ]);
  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (!hasTerminalWriteAccess() || !activeThreadId || !activeThreadTarget) return;
      const fallbackExitWrite = () =>
        writeTerminal({
          environmentId,
          input: { threadId: activeThreadId, terminalId, data: "exit\n" },
        });
      void (async () => {
        const closeResult = await closeTerminalMutation({
          environmentId,
          input: {
            threadId: activeThreadId,
            terminalId,
            deleteHistory: true,
          },
        });
        if (
          closeResult._tag === "Failure" &&
          !isAtomCommandInterrupted(closeResult) &&
          hasTerminalWriteAccess()
        ) {
          await fallbackExitWrite();
        }
      })();
      storeCloseTerminal(activeThreadTarget, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [
      activeThreadId,
      activeThreadTarget,
      closeTerminalMutation,
      hasTerminalWriteAccess,
      environmentId,
      storeCloseTerminal,
      writeTerminal,
      setTerminalFocusRequestId,
    ],
  );
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
        rememberAsLastInvoked?: boolean;
      },
    ) => {
      if (!hasTerminalWriteAccess() || !activeThreadId || !activeProject || !activeThread) return;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.workspaceRoot;
      const baseTerminalId =
        terminalUiState.activeTerminalId || activeKnownTerminalIds[0] || DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = runningTerminalIds.includes(baseTerminalId);
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const shouldCreateNewTerminal =
        wantsNewTerminal ||
        !canReuseTerminal ||
        !readEnvironmentScope(environmentId, AuthTerminalReadScope);
      const targetWorktreePath = options?.worktreePath ?? activeThread.worktreePath ?? null;

      setTerminalUiLaunchContext({
        threadId: activeThreadId,
        cwd: targetCwd,
        worktreePath: targetWorktreePath,
      });
      setTerminalOpen(true);
      if (!activeThreadTarget) {
        return;
      }
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.workspaceRoot,
        },
        worktreePath: targetWorktreePath,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const targetTerminalId = shouldCreateNewTerminal ? allocateTerminalId() : baseTerminalId;
      const openTerminalInput: TerminalOpenInput = shouldCreateNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            fallbackCwd: activeProject.workspaceRoot,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            fallbackCwd: activeProject.workspaceRoot,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
          };

      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadTarget, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadTarget, targetTerminalId);
      }

      const openResult = await openTerminal({ environmentId, input: openTerminalInput });
      if (openResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(openResult)) {
          const error = squashAtomCommandFailure(openResult);
          setThreadError(
            activeThreadId,
            error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
          );
        }
        return;
      }

      if (!hasTerminalWriteAccess()) return;
      const writeResult = await writeTerminal({
        environmentId,
        input: {
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        },
      });
      if (writeResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(writeResult)) {
          const error = squashAtomCommandFailure(writeResult);
          setThreadError(
            activeThreadId,
            error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
          );
        }
        return;
      }
      if (script.autoOpenPreview && script.previewUrl && isPreviewSupportedInRuntime()) {
        const previewResult = await openUrlInPreview({
          threadRef: activeThreadTarget,
          url: resolveDiscoveredServerUrl(activeThreadTarget.environmentId, script.previewUrl),
          openPreview,
        });
        if (previewResult._tag === "Failure" && !isAtomCommandInterrupted(previewResult)) {
          const error = squashAtomCommandFailure(previewResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not open preview",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        }
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      activeThreadTarget,
      gitCwd,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      setLastInvokedScriptByProjectId,
      environmentId,
      openTerminal,
      openPreview,
      hasTerminalWriteAccess,
      activeKnownTerminalIds,
      canReuseTerminal,
      allocateTerminalId,
      runningTerminalIds,
      terminalUiState.activeTerminalId,
      writeTerminal,
      setTerminalUiLaunchContext,
      setTerminalFocusRequestId,
    ],
  );

  // Shell code blocks in this thread's messages run on its host, in its worktree.
  const shellRunTarget = useMemo<ShellRunTarget | null>(
    () =>
      activeProject && activeThreadId && gitCwd !== null
        ? {
            environmentId,
            threadId: activeThreadId,
            cwd: gitCwd,
            fallbackCwd: activeProject.workspaceRoot,
            worktreePath: activeThreadWorktreePath,
            env: projectScriptRuntimeEnv({
              project: { cwd: activeProject.workspaceRoot },
              worktreePath: activeThreadWorktreePath,
            }),
            runtimeMode,
          }
        : null,
    [activeProject, activeThreadId, activeThreadWorktreePath, environmentId, gitCwd, runtimeMode],
  );

  const environmentCapabilities =
    environmentById.get(environmentId)?.serverConfig?.environment.capabilities;
  const supportsProjectSettingsOverrides =
    environmentCapabilities?.projectSettingsOverrides === true;
  const projectOverrideWriteMode = useProjectOverrideWriteMode(environmentId);
  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ReadonlyArray<ProjectScript>;
      nextScripts: ReadonlyArray<ProjectScript>;
      keybinding: NewProjectScriptInput["keybinding"];
      keybindingCommand: KeybindingCommand | null;
    }): Promise<AtomCommandResult<void, unknown>> => {
      // Until the machine's settings load, the scripts come from the defaults
      // and saving them would replace the project's saved actions.
      if (projectOverrideWriteMode === null) {
        return AsyncResult.failure(
          Cause.fail(
            new Error("This machine's settings are still loading. Try again in a moment."),
          ),
        );
      }
      const previousKeybinding = keybindingValueForCommand(
        appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.keybindings ?? [],
        input.keybindingCommand,
      );
      const isDeletingScript = !input.nextScripts.some(
        (script) => commandForProjectScript(script.id) === input.keybindingCommand,
      );
      const changesKeybinding =
        isElectron &&
        input.keybinding !== undefined &&
        (input.keybinding?.trim() || null) !== previousKeybinding &&
        (!isDeletingScript || readEnvironmentScope(environmentId, AuthSettingsWriteScope));
      if (changesKeybinding && !readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
        return AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              requiredScope: AuthSettingsWriteScope,
              message: "This connection cannot change keyboard shortcuts.",
            }),
          ),
        );
      }
      const keybindingRule = changesKeybinding
        ? decodeProjectScriptKeybindingRule({
            keybinding: input.keybinding,
            command: input.keybindingCommand,
          })
        : null;
      const updateResult = mapAtomCommandResult(
        await updateProjectScriptSettings({
          environmentId,
          input: {
            // The canonical key on servers that understand it; the legacy
            // per-project map is still translated on older ones.
            patch: supportsProjectSettingsOverrides
              ? projectSettingsOverrideChangesPatch(
                  settings,
                  { [input.projectId]: { set: { defaultProjectScripts: input.nextScripts } } },
                  projectOverrideWriteMode === "per-key",
                )
              : {
                  projectScriptOverrides: {
                    [input.projectId]: input.nextScripts,
                  },
                },
          },
        }),
        () => undefined,
      );
      if (updateResult._tag === "Failure") {
        return updateResult;
      }

      if (!changesKeybinding) return updateResult;
      if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
        return AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              requiredScope: AuthSettingsWriteScope,
              message: isDeletingScript
                ? "The script was deleted, but its keyboard shortcut could not be removed because permission changed."
                : "The script was saved, but this connection can no longer change keyboard shortcuts.",
            }),
          ),
        );
      }

      if (!isElectron) return updateResult;

      const scriptId = input.keybindingCommand
        ? projectScriptIdFromCommand(input.keybindingCommand)
        : null;
      if (!keybindingRule && !input.previousScripts.some((script) => script.id === scriptId)) {
        return updateResult;
      }
      const retainedElsewhere =
        !input.nextScripts.some((script) => script.id === scriptId) &&
        (settings.defaultProjectScripts.some((script) => script.id === scriptId) ||
          Object.entries(settings.projectSettingsOverrides).some(
            ([projectId, entry]) =>
              projectId !== input.projectId &&
              entry.defaultProjectScripts?.some((script) => script.id === scriptId),
          ) ||
          allProjects.some(
            (other) =>
              other.environmentId === environmentId &&
              other.id !== input.projectId &&
              resolveProjectScripts(settings, other).some((script) => script.id === scriptId),
          ));
      if (!keybindingRule && retainedElsewhere) return updateResult;

      const previousRules = (
        environmentById.get(environmentId)?.serverConfig?.keybindings ?? []
      ).flatMap((binding) => {
        if (binding.command !== input.keybindingCommand || binding.whenAst) return [];
        const previous = decodeProjectScriptKeybindingRule({
          keybinding: keybindingValueForCommand([binding], input.keybindingCommand),
          command: input.keybindingCommand,
        });
        return previous ? [previous] : [];
      });
      const previous = previousRules.at(-1);
      for (const rule of keybindingRule ? previousRules.slice(0, -1) : previousRules) {
        const result = await removeKeybinding({ environmentId, input: rule });
        if (result._tag === "Failure") return mapAtomCommandResult(result, () => undefined);
      }
      return keybindingRule
        ? mapAtomCommandResult(
            await upsertKeybinding({
              environmentId,
              input:
                previous && previous.key !== keybindingRule.key
                  ? { ...keybindingRule, replace: previous }
                  : keybindingRule,
            }),
            () => undefined,
          )
        : updateResult;
    },
    [
      allProjects,
      environmentById,
      environmentId,
      projectOverrideWriteMode,
      removeKeybinding,
      settings,
      supportsProjectSettingsOverrides,
      updateProjectScriptSettings,
      upsertKeybinding,
    ],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput): Promise<AtomCommandResult<void, unknown>> => {
      if (!activeProject) {
        return AsyncResult.success(undefined);
      }
      const nextId = nextProjectScriptId(
        input.name,
        activeProjectScripts.map((script) => script.id),
      );
      const nextScript = buildProjectScript(nextId, input);
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProjectScripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProjectScripts, nextScript];

      return persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProjectScripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, activeProjectScripts, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (
      scriptId: string,
      input: NewProjectScriptInput,
    ): Promise<AtomCommandResult<void, unknown>> => {
      if (!activeProject) {
        return AsyncResult.success(undefined);
      }
      const existingScript = activeProjectScripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        return AsyncResult.failure(Cause.fail(new Error("Script not found.")));
      }

      const updatedScript = buildProjectScript(existingScript.id, input);
      const nextScripts = activeProjectScripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      return persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProjectScripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, activeProjectScripts, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string): Promise<AtomCommandResult<void, unknown>> => {
      if (!activeProject) {
        return AsyncResult.success(undefined);
      }
      const nextScripts = activeProjectScripts.filter((script) => script.id !== scriptId);

      const deletedName = activeProjectScripts.find((s) => s.id === scriptId)?.name;

      const result = await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.workspaceRoot,
        previousScripts: activeProjectScripts,
        nextScripts,
        keybinding: null,
        keybindingCommand: commandForProjectScript(scriptId),
      });
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not delete action",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      }
      return result;
    },
    [activeProject, activeProjectScripts, persistProjectScripts],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === "plan" && !interactionModeEnabled) return;
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      interactionModeEnabled,
      isLocalDraftThread,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    if (!interactionModeEnabled) return;
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode, interactionModeEnabled]);
  const openProviderSetup = useCallback(
    (instanceId: ProviderInstanceId) => {
      void navigate({
        to: "/settings/providers",
        search: { environmentId, instanceId },
      });
    },
    [environmentId, navigate],
  );
  const canOperatePreview = useEnvironmentScope(
    activeThreadTarget?.environmentId ?? null,
    AuthPreviewOperateScope,
  );
  const createBrowserSurface = useCallback(
    (profileId?: string) => {
      if (!activeThreadTarget || !canOperatePreview) return;
      void addBrowserSurface({
        threadRef: activeThreadTarget,
        openPreview,
        ...(profileId === undefined ? {} : { profileId }),
      }).then((result) => {
        if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        if (error instanceof BrowserSettingsReadError) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to open browser",
              description: error.message,
            }),
          );
        }
      });
    },
    [activeThreadTarget, canOperatePreview, openPreview],
  );
  const addDiffSurface = useCallback(() => {
    if (!activeThreadTarget || !isServerThread || !isGitRepo) return;
    useDiffPanelStore.getState().selectGitScope(activeThreadTarget, "branch");
    useRightPanelStore.getState().open(activeThreadTarget, "diff");
    onDiffPanelOpen?.();
  }, [activeThreadTarget, isGitRepo, isServerThread, onDiffPanelOpen]);
  const openChangesFromThreadPanel = useCallback(() => {
    addDiffSurface();
  }, [addDiffSurface]);
  const addFilesSurface = useCallback(() => {
    if (!activeThreadTarget || !activeProject) return;
    useRightPanelStore.getState().open(activeThreadTarget, "files");
  }, [activeProject, activeThreadTarget]);
  const supportsThreadPullRequests =
    serverConfig?.environment.capabilities.threadPullRequests === true;
  const visiblePullRequests = visibleThreadPullRequests(
    (activeThreadShell ?? activeThread)?.pullRequests ?? [],
  );
  const visiblePullRequestCount = visiblePullRequests.length;
  const pullRequestsSurfaceAvailable =
    isServerThread && supportsThreadPullRequests && visiblePullRequestCount > 0;
  const addPullRequestsSurface = useCallback(() => {
    if (!activeThreadTarget || !pullRequestsSurfaceAvailable) return;
    useRightPanelStore.getState().open(activeThreadTarget, "pull-requests");
  }, [activeThreadTarget, pullRequestsSurfaceAvailable]);
  const { state: deviceState, loaded: deviceStateLoaded } = useDeviceState(
    activeThreadTarget?.environmentId ?? null,
  );
  const [deviceSetupThread, setDeviceSetupThread] = useState<ScopedThreadRef | null>(null);
  const addDeviceSurface = useCallback(() => {
    if (!activeThreadTarget) return;
    if (!deviceState.onboardingCompleted || deviceState.hostStatus === "disabled") {
      setDeviceSetupThread(activeThreadTarget);
      return;
    }
    useRightPanelStore.getState().open(activeThreadTarget, "device");
  }, [
    activeThreadTarget,
    deviceState.onboardingCompleted,
    deviceState.hostStatus,
    setDeviceSetupThread,
  ]);
  // A device the agent opens floats over chat like an agent-driven browser,
  // or becomes a panel tab when floating previews are off. Sessions opened by
  // another client arrive the same way; sheet layouts get neither. The first
  // snapshot is a baseline: persisted tabs restore themselves, and existing
  // sessions must not resurrect closed tabs. A session whose device summary
  // has not arrived yet stays out of the baseline so a later snapshot opens it.
  const autoShowFloatingPreview = useClientSettings(selectAutoShowFloatingPreview);
  const previousDeviceSessions = useRef(new Map<string, Set<string>>());
  useEffect(() => {
    if (!activeThreadTarget || !deviceStateLoaded) return;
    const threadKey = `${activeThreadTarget.environmentId}:${activeThreadTarget.threadId}`;
    const sessions = deviceState.sessions.filter(
      (session) => session.threadId === activeThreadTarget.threadId,
    );
    const key = (session: (typeof sessions)[number]) => `${session.hostId}:${session.deviceId}`;
    const deviceFor = (session: (typeof sessions)[number]) =>
      deviceState.devices.find(
        (entry) => entry.hostId === session.hostId && entry.id === session.deviceId,
      );
    const previous = previousDeviceSessions.current.get(threadKey);
    previousDeviceSessions.current.set(
      threadKey,
      new Set(sessions.filter((session) => deviceFor(session) !== undefined).map(key)),
    );
    if (!previous || shouldUsePlanSidebarSheet) return;
    for (const session of sessions) {
      if (previous.has(key(session))) continue;
      const device = deviceFor(session);
      if (!device) continue;
      const target = {
        hostId: session.hostId,
        deviceId: session.deviceId,
        platform: device.platform,
        name: device.name,
      };
      if (autoShowFloatingPreview) {
        usePreviewMiniPlayerStore
          .getState()
          .open(activeThreadTarget, { kind: "device", ...target });
        continue;
      }
      const existing = useRightPanelStore
        .getState()
        .byThreadKey[scopedThreadKey(activeThreadTarget)]?.surfaces.some(
          (surface) =>
            surface.kind === "device" &&
            surface.target?.hostId === session.hostId &&
            surface.target.deviceId === session.deviceId,
        );
      if (existing) continue;
      useRightPanelStore.getState().openDevice(activeThreadTarget, target, true);
    }
  }, [
    activeThreadTarget,
    autoShowFloatingPreview,
    deviceStateLoaded,
    shouldUsePlanSidebarSheet,
    deviceState.sessions,
    deviceState.devices,
  ]);
  // Baseline loaded tabs so reloads never reopen previews the user dismissed.
  const previousServerPreviewTabs = useRef(new Map<string, Map<string, string | undefined>>());
  useEffect(() => {
    if (!activeThreadTarget || !activeEnvironmentServerBrowser || !activePreviewState.listLoaded)
      return;
    const threadKey = scopedThreadKey(activeThreadTarget);
    const serverSessions = Object.values(activePreviewState.sessions).filter(
      (session) => session.runtime === "server",
    );
    const previous = previousServerPreviewTabs.current.get(threadKey);
    previousServerPreviewTabs.current.set(
      threadKey,
      new Map(serverSessions.map((session) => [session.tabId, session.revealRequest?.id])),
    );
    if (!previous) return;
    for (const session of serverSessions) {
      const requested = session.revealRequest;
      const fresh = requested
        ? previous.get(session.tabId) !== requested.id
        : !previous.has(session.tabId);
      if (!fresh || session.reveal !== true) continue;
      if (!autoShowFloatingPreview && requested?.force !== true) continue;
      const surface = rightPanelState.surfaces.find(
        (surface) => surface.kind === "preview" && surface.resourceId === session.tabId,
      );
      if (surface && requested?.force === true) {
        useRightPanelStore.getState().activateSurface(activeThreadTarget, surface.id);
      } else if (!surface) {
        usePreviewMiniPlayerStore
          .getState()
          .open(activeThreadTarget, browserMiniPlayerSource(session.tabId));
      }
    }
  }, [
    activeEnvironmentServerBrowser,
    activePreviewState.listLoaded,
    activePreviewState.sessions,
    activeThreadTarget,
    autoShowFloatingPreview,
    rightPanelState.surfaces,
  ]);
  // A floating device follows its session: once the agent or another client
  // closes the device there is nothing left to stream.
  useEffect(() => {
    if (!activeThreadTarget || !deviceStateLoaded) return;
    const source = activePreviewMiniPlayer?.source;
    if (source?.kind !== "device") return;
    const sessionStillExists = deviceState.sessions.some(
      (session) =>
        session.threadId === activeThreadTarget.threadId &&
        session.hostId === source.hostId &&
        session.deviceId === source.deviceId,
    );
    if (!sessionStillExists) usePreviewMiniPlayerStore.getState().close(activeThreadTarget);
  }, [activePreviewMiniPlayer, activeThreadTarget, deviceState.sessions, deviceStateLoaded]);
  const openFileSurface = useCallback(
    (relativePath: string) => {
      if (!activeThreadTarget || !activeProject) return;
      useRightPanelStore.getState().openFile(activeThreadTarget, relativePath);
    },
    [activeProject, activeThreadTarget],
  );
  // The thread's own change request, placed against the project it belongs to. Without a
  // project there is nothing to resolve it against, so the caller falls back to the browser.
  const persistedLinkedThreadPullRequest = isServerThread
    ? (activeThreadShell?.linkedPullRequest ?? activeThread?.linkedPullRequest ?? null)
    : (activeThread?.linkedPullRequest ?? null);
  const activeProjectRepository = sourceControlRepositorySelector(
    activeProject?.repositoryIdentity,
  );
  const persistedLinkedThreadPullRequestStatus = useLinkedThreadPullRequest(
    activeThreadTarget?.environmentId ?? null,
    persistedLinkedThreadPullRequest,
  );
  const replacementLinkedThreadPullRequest = useMemo(() => {
    const detected = gitStatusQuery.data?.pr;
    const threadBranch = activeThread?.branch;
    const projectId = activeProject?.id;
    if (
      persistedLinkedThreadPullRequest === null ||
      (persistedLinkedThreadPullRequestStatus?.pr.state !== "merged" &&
        persistedLinkedThreadPullRequestStatus?.pr.state !== "closed") ||
      gitStatusQuery.data?.refName !== threadBranch ||
      detected?.state !== "open" ||
      detected.headRef !== threadBranch ||
      projectId === undefined ||
      activeProjectRepository === null ||
      (persistedLinkedThreadPullRequest.projectId === projectId &&
        persistedLinkedThreadPullRequest.repository.toLowerCase() ===
          activeProjectRepository.toLowerCase() &&
        persistedLinkedThreadPullRequest.number === detected.number)
    ) {
      return null;
    }
    return {
      projectId,
      repository: activeProjectRepository,
      number: detected.number,
      url: detected.url,
    };
  }, [
    activeProject?.id,
    activeProjectRepository,
    activeThread?.branch,
    gitStatusQuery.data,
    persistedLinkedThreadPullRequest,
    persistedLinkedThreadPullRequestStatus?.pr.state,
  ]);
  const linkedThreadPullRequest =
    replacementLinkedThreadPullRequest ?? persistedLinkedThreadPullRequest;
  const linkedThreadPullRequestKey = linkedThreadPullRequest
    ? JSON.stringify([
        linkedThreadPullRequest.projectId,
        linkedThreadPullRequest.repository,
        linkedThreadPullRequest.number,
      ])
    : null;
  const threadRepository = linkedThreadPullRequest?.repository ?? activeProjectRepository;
  const threadPrRelinkKeysRef = useRef(new Map<string, string>());
  const threadPrRelinkWriteRef = useRef(Promise.resolve());
  useEffect(() => {
    if (!isServerThread || activeThreadKey === null || activeThreadTarget === null) {
      return;
    }
    if (replacementLinkedThreadPullRequest === null) {
      threadPrRelinkKeysRef.current.delete(activeThreadKey);
      return;
    }
    const relinkKey = `${replacementLinkedThreadPullRequest.projectId}:${replacementLinkedThreadPullRequest.repository}#${replacementLinkedThreadPullRequest.number}`;
    if (threadPrRelinkKeysRef.current.get(activeThreadKey) === relinkKey) return;
    threadPrRelinkKeysRef.current.set(activeThreadKey, relinkKey);
    const openSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      activeThreadTarget,
    );
    if (
      openSurface?.kind === "pull-request" &&
      persistedLinkedThreadPullRequest !== null &&
      openSurface.projectId === persistedLinkedThreadPullRequest.projectId &&
      openSurface.repository.toLowerCase() ===
        persistedLinkedThreadPullRequest.repository.toLowerCase() &&
      openSurface.number === persistedLinkedThreadPullRequest.number
    ) {
      useRightPanelStore
        .getState()
        .openPullRequest(activeThreadTarget, replacementLinkedThreadPullRequest);
    }

    threadPrRelinkWriteRef.current = threadPrRelinkWriteRef.current.then(async () => {
      if (threadPrRelinkKeysRef.current.get(activeThreadKey) !== relinkKey) return;
      const result = await updateThreadMetadata({
        environmentId: activeThreadTarget.environmentId,
        input: {
          threadId: activeThreadTarget.threadId,
          linkedPullRequest: replacementLinkedThreadPullRequest,
        },
      });
      if (threadPrRelinkKeysRef.current.get(activeThreadKey) !== relinkKey) return;
      if (result._tag !== "Failure") return;
      threadPrRelinkKeysRef.current.delete(activeThreadKey);
      if (isAtomCommandInterrupted(result)) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to update the thread pull request",
          description: chatActionErrorMessage(squashAtomCommandFailure(result)),
        }),
      );
    });
  }, [
    activeThreadKey,
    activeThreadTarget,
    isServerThread,
    persistedLinkedThreadPullRequest,
    replacementLinkedThreadPullRequest,
    updateThreadMetadata,
  ]);
  const hasLinkedPullRequestDetail = persistedLinkedThreadPullRequest !== null;
  const proactivePullRequestsKey = pullRequestsSurfaceAvailable
    ? JSON.stringify(
        visiblePullRequests.map((link) => [link.host, link.repository, link.number]).sort(),
      )
    : linkedThreadPullRequestKey;
  const activeRunningTurnId = activeRuntime?.activeRunId ?? null;
  const proactivePanelObservationRef = useRef<ReturnType<
    typeof observeProactivePanelUserChoice
  > | null>(null);
  const observedThreadPullRequestRef = useRef<{
    readonly threadKey: string;
    readonly reference: ThreadLinkedPullRequest | null;
  } | null>(null);

  useEffect(() => {
    if (!isServerThread || activeThreadKey === null || activeThreadTarget === null) {
      proactivePanelObservationRef.current = null;
      observedThreadPullRequestRef.current = null;
      return;
    }
    const panels = useRightPanelStore.getState();
    const observation = observeProactivePanelUserChoice(proactivePanelObservationRef.current, {
      threadKey: activeThreadKey,
      runningTurnId: activeRunningTurnId,
      userActionRevision: panels.getUserActionRevision(activeThreadTarget),
    });
    proactivePanelObservationRef.current = observation;
    const {
      runningTurnId: previousRunningTurnId,
      targetKey: previousTargetKey,
      userActionRevision,
    } = observation;
    const openSurface = selectActiveRightPanelSurface(panels.byThreadKey, activeThreadTarget);
    const previousPullRequest = observedThreadPullRequestRef.current;
    observedThreadPullRequestRef.current = {
      threadKey: activeThreadKey,
      reference: linkedThreadPullRequest,
    };
    const followSelectedPullRequest =
      previousPullRequest?.threadKey === activeThreadKey &&
      shouldRetargetThreadPullRequestPanel(
        previousPullRequest.reference,
        linkedThreadPullRequest,
        openSurface,
      );
    // Following the selected linked PR does not open an unrelated panel, so it
    // remains available with proactive panels off. It still respects a later choice.
    if (followSelectedPullRequest && linkedThreadPullRequest !== null) {
      panels.openProactive(
        activeThreadTarget,
        pullRequestSurface(linkedThreadPullRequest),
        userActionRevision,
      );
    }
    if (!clientSettingsHydrated) return;

    const proactivePanelsEnabled = settings.proactivePanelsEnabled && !shouldUsePlanSidebarSheet;
    const eligibleLink =
      proactivePanelsEnabled &&
      shouldOpenProactivePullRequest(previousTargetKey, proactivePullRequestsKey);
    const shouldDeferLink = eligibleLink && !pullRequestsCapabilityKnown;
    proactivePanelObservationRef.current = {
      ...observation,
      targetKey: shouldDeferLink ? (previousTargetKey ?? null) : proactivePullRequestsKey,
    };
    if (eligibleLink && pullRequestsCapabilityKnown) {
      if (
        pullRequestsSurfaceAvailable &&
        (visiblePullRequestCount > 1 || !hasLinkedPullRequestDetail || !supportsPullRequests)
      ) {
        panels.openProactive(
          activeThreadTarget,
          { id: "pull-requests", kind: "pull-requests" },
          userActionRevision,
        );
      } else if (
        !followSelectedPullRequest &&
        supportsPullRequests &&
        linkedThreadPullRequest !== null
      ) {
        panels.openProactive(
          activeThreadTarget,
          pullRequestSurface(linkedThreadPullRequest),
          userActionRevision,
        );
      }
    }
    if (threadDetailLoading) return;

    const settledTurnId = latestRunSettled ? (activeLatestRun?.runId ?? null) : null;
    const newlyCompletedTurnId = shouldOpenProactiveTurnDiff({
      previousRunningTurnId,
      runningTurnId: activeRunningTurnId,
      settledTurnId,
      turnCompleted: activeLatestRun?.status === "completed",
    })
      ? settledTurnId
      : null;
    const eligibleCompletion =
      proactivePanelsEnabled &&
      newlyCompletedTurnId !== null &&
      !(
        proactivePullRequestsKey !== null &&
        (!pullRequestsCapabilityKnown || supportsPullRequests || pullRequestsSurfaceAvailable)
      );
    const completedCheckpoint = eligibleCompletion
      ? turnDiffSummaries.find((checkpoint) => checkpoint.runId === newlyCompletedTurnId)
      : undefined;
    const diffAction = eligibleCompletion
      ? resolveProactiveTurnDiffAction({
          checkpoint: completedCheckpoint,
          isGitRepo: gitStatusQuery.data?.isRepo,
          activeSurfaceKind: openSurface?.kind ?? null,
        })
      : "ignore";
    proactivePanelObservationRef.current = {
      ...proactivePanelObservationRef.current,
      // Preserve first-entry eligibility while capabilities, checkpoint or repository load.
      runningTurnId:
        diffAction === "defer" || shouldDeferLink ? previousRunningTurnId : activeRunningTurnId,
    };
    if (diffAction !== "open" || newlyCompletedTurnId === null) return;
    if (
      !panels.openProactive(activeThreadTarget, { id: "diff", kind: "diff" }, userActionRevision)
    ) {
      return;
    }
    useDiffPanelStore.getState().selectGitScope(activeThreadTarget, "branch");
    onDiffPanelOpen?.();
  }, [
    turnDiffSummaries,
    activeLatestRun?.runId,
    activeLatestRun?.status,
    activeRunningTurnId,
    activeThreadKey,
    activeThreadTarget,
    clientSettingsHydrated,
    gitStatusQuery.data?.isRepo,
    isServerThread,
    latestRunSettled,
    linkedThreadPullRequest,
    proactivePullRequestsKey,
    hasLinkedPullRequestDetail,
    onDiffPanelOpen,
    pullRequestsCapabilityKnown,
    pullRequestsSurfaceAvailable,
    visiblePullRequestCount,

    settings.proactivePanelsEnabled,
    shouldUsePlanSidebarSheet,
    threadDetailLoading,
  ]);
  const closePreviewPanel = useCallback(() => {
    if (activeThreadTarget) {
      // Closing the panel on a live browser or device floats it instead of dropping it.
      if (activeRightPanelSurface?.kind === "preview" && activeRightPanelSurface.resourceId) {
        usePreviewMiniPlayerStore
          .getState()
          .open(activeThreadTarget, browserMiniPlayerSource(activeRightPanelSurface.resourceId));
      } else if (activeRightPanelSurface?.kind === "device" && activeRightPanelSurface.target) {
        usePreviewMiniPlayerStore
          .getState()
          .open(activeThreadTarget, { kind: "device", ...activeRightPanelSurface.target });
      }
      setMaximizedRightPanelThreadKey(null);
      useRightPanelStore.getState().close(activeThreadTarget);
    }
  }, [activeRightPanelSurface, activeThreadTarget, setMaximizedRightPanelThreadKey]);
  const togglePreviewPanel = useCallback(() => {
    if (!activeThreadTarget || !browserAvailable) return;
    if (previewPanelOpen) {
      closePreviewPanel();
      return;
    }
    if (!canOperatePreview) return;
    const activeTabId = activePreviewState.activeTabId;
    if (activeTabId) {
      useRightPanelStore.getState().openBrowser(activeThreadTarget, activeTabId);
    } else {
      createBrowserSurface();
    }
  }, [
    activePreviewState.activeTabId,
    activeThreadTarget,
    browserAvailable,
    canOperatePreview,
    closePreviewPanel,
    createBrowserSurface,
    previewPanelOpen,
  ]);
  const addTerminalSurface = useCallback(() => {
    if (!hasTerminalWriteAccess() || !activeThreadTarget || !activeThreadId || !activeProject)
      return;
    const cwd = gitCwd ?? activeProject.workspaceRoot;
    const terminalId = allocateTerminalId();
    useRightPanelStore.getState().openTerminal(activeThreadTarget, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
    void openTerminal({
      environmentId: activeThreadTarget.environmentId,
      input: {
        threadId: activeThreadId,
        terminalId,
        cwd,
        fallbackCwd: activeProject.workspaceRoot,
        ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: activeProject.workspaceRoot },
          worktreePath: activeThreadWorktreePath,
        }),
      },
    });
  }, [
    activeProject,
    activeThreadId,
    activeThreadTarget,
    activeThreadWorktreePath,
    allocateTerminalId,
    gitCwd,
    openTerminal,
    hasTerminalWriteAccess,
    setTerminalFocusRequestId,
  ]);
  const splitPanelTerminal = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal") => {
      if (
        !hasTerminalWriteAccess() ||
        !activeThreadTarget ||
        !activeThreadId ||
        !activeProject ||
        activeRightPanelSurface?.kind !== "terminal" ||
        activeRightPanelSurface.terminalIds.length >= MAX_TERMINALS_PER_GROUP
      ) {
        return;
      }
      const terminalId = allocateTerminalId();
      const cwd = gitCwd ?? activeProject.workspaceRoot;
      useRightPanelStore
        .getState()
        .splitTerminal(activeThreadTarget, activeRightPanelSurface.id, terminalId, direction);
      setTerminalFocusRequestId((value) => value + 1);
      void openTerminal({
        environmentId: activeThreadTarget.environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd,
          fallbackCwd: activeProject.workspaceRoot,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      });
    },
    [
      activeProject,
      activeRightPanelSurface,
      activeThreadId,
      activeThreadTarget,
      activeThreadWorktreePath,
      allocateTerminalId,
      gitCwd,
      openTerminal,
      hasTerminalWriteAccess,
      setTerminalFocusRequestId,
    ],
  );
  const splitPanelTerminalVertical = useCallback(() => {
    splitPanelTerminal("vertical");
  }, [splitPanelTerminal]);
  const activatePanelTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadTarget || activeRightPanelSurface?.kind !== "terminal") return;
      useRightPanelStore
        .getState()
        .activateTerminal(activeThreadTarget, activeRightPanelSurface.id, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeRightPanelSurface, activeThreadTarget, setTerminalFocusRequestId],
  );
  const closePanelTerminal = useCallback(
    (terminalId: string) => {
      if (
        !hasTerminalWriteAccess() ||
        !activeThreadTarget ||
        activeRightPanelSurface?.kind !== "terminal"
      )
        return;
      void closeTerminalMutation({
        environmentId: activeThreadTarget.environmentId,
        input: { threadId: activeThreadTarget.threadId, terminalId, deleteHistory: true },
      });
      storeCloseTerminal(activeThreadTarget, terminalId);
      useRightPanelStore
        .getState()
        .closeTerminal(activeThreadTarget, activeRightPanelSurface.id, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [
      hasTerminalWriteAccess,
      activeRightPanelSurface,
      activeThreadTarget,
      closeTerminalMutation,
      storeCloseTerminal,
      setTerminalFocusRequestId,
    ],
  );
  const requestCloseTerminal = useCallback(
    (terminalId: string) => {
      if (!hasTerminalWriteAccess()) return;
      const label = activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
      void confirmTerminalClose([label]).then((confirmed) => {
        if (confirmed && readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
          closeTerminal(terminalId);
        }
      });
    },
    [hasTerminalWriteAccess, activeTerminalLabelsById, closeTerminal, environmentId],
  );
  const requestClosePanelTerminal = useCallback(
    (terminalId: string) => {
      if (!hasTerminalWriteAccess()) return;
      const label = activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
      void confirmTerminalClose([label]).then((confirmed) => {
        if (confirmed && readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
          closePanelTerminal(terminalId);
        }
      });
    },
    [hasTerminalWriteAccess, activeTerminalLabelsById, closePanelTerminal, environmentId],
  );
  const activateRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadTarget) return;
      useRightPanelStore.getState().activateSurface(activeThreadTarget, surface.id);
      if (surface.kind === "preview" && surface.resourceId) {
        setActivePreviewTab(activeThreadTarget, surface.resourceId);
      }
      if (surface.kind === "terminal") {
        setTerminalFocusRequestId((value) => value + 1);
      }
      if (surface.kind === "diff" && !diffOpen) {
        onDiffPanelOpen?.();
      }
    },
    [activeThreadTarget, diffOpen, onDiffPanelOpen, setTerminalFocusRequestId],
  );
  const toggleRightPanel = useCallback(() => {
    if (!activeThreadTarget) return;
    if (rightPanelOpen) {
      closePreviewPanel();
      return;
    }
    useRightPanelStore.getState().toggleVisibility(activeThreadTarget);
  }, [activeThreadTarget, closePreviewPanel, rightPanelOpen]);
  const toggleThreadPanel = useCallback(() => {
    if (!activeThreadTarget) return;
    useRightPanelStore
      .getState()
      .toggleThreadPanel(activeThreadTarget, threadPanelPresentation, draftId !== null);
  }, [activeThreadTarget, threadPanelPresentation, draftId]);
  const toggleRightPanelMaximized = useCallback(() => {
    if (!canMaximizeRightPanel) return;
    setMaximizedRightPanelThreadKey((threadKey) =>
      threadKey === routeThreadKey ? null : routeThreadKey,
    );
  }, [canMaximizeRightPanel, routeThreadKey, setMaximizedRightPanelThreadKey]);
  const cleanupRightPanelSurfaces = useCallback(
    (surfaces: readonly RightPanelSurface[]) => {
      if (!activeThreadTarget) return;
      for (const surface of surfaces) {
        // Without preview access only the local surface goes away. The
        // server record is in-memory bookkeeping, not a live view, and stays
        // listed until a client with the scope closes it or the server restarts.
        if (canOperatePreview && surface.kind === "preview" && surface.resourceId) {
          void closePreviewSession({
            closePreview,
            snapshot: activePreviewState.sessions[surface.resourceId] ?? null,
            tabId: surface.resourceId,
            threadRef: activeThreadTarget,
          });
        }
        if (
          surface.kind === "terminal" &&
          readEnvironmentScope(activeThreadTarget.environmentId, AuthTerminalOperateScope)
        ) {
          for (const terminalId of surface.terminalIds) {
            storeCloseTerminal(activeThreadTarget, terminalId);
            void closeTerminalMutation({
              environmentId: activeThreadTarget.environmentId,
              input: { threadId: activeThreadTarget.threadId, terminalId, deleteHistory: true },
            });
          }
        }
      }
    },
    [
      activeThreadTarget,
      activePreviewState.sessions,
      canOperatePreview,
      closePreview,
      closeTerminalMutation,
      storeCloseTerminal,
    ],
  );
  const closeAfterAgentBrowserConfirmation = useCallback(
    (surfaces: readonly RightPanelSurface[], closeSurfaces: () => void) => {
      const message = agentControlledBrowserCloseConfirmation(
        surfaces,
        activePreviewState.desktopByTabId,
      );
      if (!message) {
        closeSurfaces();
        return;
      }
      const localApi = readLocalApi();
      if (!localApi) return;
      void localApi.dialogs.confirm(message, { variant: "destructive" }).then(
        (confirmed) => {
          if (confirmed) closeSurfaces();
        },
        () => undefined,
      );
    },
    [activePreviewState.desktopByTabId],
  );
  const syncActivePreviewSurface = useCallback(() => {
    if (!activeThreadTarget) return;
    const nextActiveSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      activeThreadTarget,
    );
    if (nextActiveSurface?.kind === "preview" && nextActiveSurface.resourceId) {
      setActivePreviewTab(activeThreadTarget, nextActiveSurface.resourceId);
    }
  }, [activeThreadTarget]);
  const finishRightPanelSurfaceClose = useCallback(
    (surfaces: readonly RightPanelSurface[]) => {
      if (!activeThreadTarget) return;
      const store = useRightPanelStore.getState();
      const activeId = selectThreadRightPanelState(
        store.byThreadKey,
        activeThreadTarget,
      ).activeSurfaceId;
      const ordered = surfaces.toSorted(
        (left, right) => Number(left.id === activeId) - Number(right.id === activeId),
      );
      for (const surface of ordered) {
        cleanupRightPanelSurfaces([surface]);
        store.closeSurface(activeThreadTarget, surface.id);
      }
      syncActivePreviewSurface();
    },
    [activeThreadTarget, cleanupRightPanelSurfaces, syncActivePreviewSurface],
  );
  const closeRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadTarget) return;
      const finishClose = () => finishRightPanelSurfaceClose([surface]);
      if (surface.kind === "preview") {
        closeAfterAgentBrowserConfirmation([surface], finishClose);
        return;
      }
      if (
        surface.kind !== "terminal" ||
        !readEnvironmentScope(activeThreadTarget.environmentId, AuthTerminalOperateScope)
      ) {
        finishClose();
        return;
      }
      const activeLabel =
        activeTerminalLabelsById.get(surface.activeTerminalId) ??
        getTerminalLabel(surface.activeTerminalId);
      const otherLabels = surface.terminalIds
        .filter((terminalId) => terminalId !== surface.activeTerminalId)
        .map(
          (terminalId) => activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId),
        );
      void confirmTerminalClose([activeLabel, ...otherLabels]).then((confirmed) => {
        if (confirmed) {
          finishClose();
        }
      });
    },
    [
      activeThreadTarget,
      activeTerminalLabelsById,
      closeAfterAgentBrowserConfirmation,
      finishRightPanelSurfaceClose,
    ],
  );
  const closeOtherRightPanelSurfaces = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadTarget) return;
      const surfaces = rightPanelState.surfaces.filter((entry) => entry.id !== surface.id);
      const finishClose = () => finishRightPanelSurfaceClose(surfaces);
      closeAfterAgentBrowserConfirmation(surfaces, finishClose);
    },
    [
      activeThreadTarget,
      closeAfterAgentBrowserConfirmation,
      finishRightPanelSurfaceClose,
      rightPanelState.surfaces,
    ],
  );
  const closeRightPanelSurfacesToRight = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadTarget) return;
      const surfaceIndex = rightPanelState.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;
      const surfaces = rightPanelState.surfaces.slice(surfaceIndex + 1);
      const finishClose = () => finishRightPanelSurfaceClose(surfaces);
      closeAfterAgentBrowserConfirmation(surfaces, finishClose);
    },
    [
      activeThreadTarget,
      closeAfterAgentBrowserConfirmation,
      finishRightPanelSurfaceClose,
      rightPanelState.surfaces,
    ],
  );
  const closeAllRightPanelSurfaces = useCallback(() => {
    if (!activeThreadTarget) return;
    const finishClose = () => finishRightPanelSurfaceClose(rightPanelState.surfaces);
    closeAfterAgentBrowserConfirmation(rightPanelState.surfaces, finishClose);
  }, [
    activeThreadTarget,
    closeAfterAgentBrowserConfirmation,
    finishRightPanelSurfaceClose,
    rightPanelState.surfaces,
  ]);
  const copyRightPanelFilePath = useCallback((relativePath: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }

    void navigator.clipboard.writeText(relativePath).then(
      () => {
        toastManager.add({
          type: "success",
          title: "Path copied",
          description: relativePath,
        });
      },
      (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy path",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  }, []);
  useEffect(
    () =>
      subscribePreviewAction((action) => {
        if (action === "toggle-panel") togglePreviewPanel();
      }),
    [togglePreviewPanel],
  );
  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      branch?: string;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }): Promise<AtomCommandResult<void, unknown>> => {
      if (!serverThread) {
        return AsyncResult.success(undefined);
      }

      let result: AtomCommandResult<void, unknown> = AsyncResult.success(undefined);
      const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: serverThread.modelSelection,
        currentBranch: serverThread.branch,
        ...(input.branch ? { nextBranch: input.branch } : {}),
      });
      if (metadataUpdate) {
        result = mapAtomCommandResult(
          await updateThreadMetadata({
            environmentId,
            input: {
              threadId: input.threadId,
              ...metadataUpdate,
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          return result;
        }
      }

      if (input.runtimeMode !== serverThread.runtimeMode) {
        result = mapAtomCommandResult(
          await setThreadRuntimeMode({
            environmentId,
            input: {
              threadId: input.threadId,
              runtimeMode: input.runtimeMode,
              createdAt: input.createdAt,
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          return result;
        }
      }

      if (input.interactionMode !== serverThread.interactionMode) {
        result = mapAtomCommandResult(
          await setThreadInteractionMode({
            environmentId,
            input: {
              threadId: input.threadId,
              interactionMode: input.interactionMode,
              createdAt: input.createdAt,
            },
          }),
          () => undefined,
        );
      }
      return result;
    },
    [
      environmentId,
      serverThread,
      setThreadInteractionMode,
      setThreadRuntimeMode,
      updateThreadMetadata,
    ],
  );

  // Debounce *showing* the scroll-to-bottom pill so it doesn't flash during
  // thread switches. LegendList fires scroll events with isAtEnd=false while
  // initialScrollAtEnd is settling; hiding is always immediate.
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );
  const timelineScrollIntentRef = useRef<"toward-end" | "away-from-end" | null>(null);
  const timelineScrollModeRef = useRef<TimelineScrollMode>("following-end");
  // State mirror of the follow mode refs. LegendList's maintainScrollAtEnd
  // re-pins on its own (independent of the refs), so the timeline needs a
  // render-visible flag to switch it off once the user scrolls away.
  const [timelineLiveFollowEnabled, setTimelineLiveFollowEnabled] = useState(true);
  const pendingTimelineAnchorRef = useRef<MessageId | null>(null);
  const positionedTimelineAnchorRef = useRef<MessageId | null>(null);
  const settledTimelineAnchorRef = useRef<MessageId | null>(null);
  const activeTimelineAnchorIndexRef = useRef<number | null>(null);
  const observedTimelineActivityRef = useRef<TimelineRunObservation | null>(null);
  const anchorUserScrollGenerationRef = useRef(0);
  const cancelPositionRestoreRef = useRef<(() => void) | null>(null);
  const liveFollowUserScrollGenerationRef = useRef<number | null>(0);
  const pendingAnchorScrollRestoreRef = useRef<{
    readonly messageId: MessageId;
    readonly offset: number;
    readonly userScrollGeneration: number;
  } | null>(null);
  const anchorScrollRestoreFrameRef = useRef<number | null>(null);
  const cancelTimelineLiveFollowForUserNavigation = useCallback(() => {
    cancelPositionRestoreRef.current?.();
    anchorUserScrollGenerationRef.current += 1;
    const wasProgrammaticScrollMode = timelineScrollModeRef.current !== "free-scrolling";
    timelineScrollModeRef.current = "free-scrolling";
    liveFollowUserScrollGenerationRef.current = null;
    setTimelineLiveFollowEnabled(false);
    pendingTimelineAnchorRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    pendingAnchorScrollRestoreRef.current = null;
    if (anchorScrollRestoreFrameRef.current !== null) {
      cancelAnimationFrame(anchorScrollRestoreFrameRef.current);
      anchorScrollRestoreFrameRef.current = null;
    }
    if (wasProgrammaticScrollMode) {
      // While following or anchoring, our scrollToEnd/scrollToOffset calls can
      // sit in LegendList's pending-imperative-scroll queue (it defers them
      // while layout settles) and fire seconds later with stale targets,
      // yanking the view away after the user scrolled. Starting a new
      // imperative scroll cancels everything queued; targeting an item that
      // is not in the data makes the new request itself resolve without ever
      // scrolling, so this is a pure cancel.
      void legendListRef.current?.scrollToItem({
        item: TIMELINE_SCROLL_CANCEL_SENTINEL,
        animated: false,
      });
      // An already-started animated scroll (behavior: smooth) keeps running in
      // the browser regardless of the queue; a same-position instant write is
      // the only way to halt it where it is.
      const scrollNode = legendListRef.current?.getScrollableNode() as
        | { scrollTop?: number }
        | null
        | undefined;
      const currentScrollTop = scrollNode?.scrollTop;
      if (scrollNode && typeof currentScrollTop === "number") {
        scrollNode.scrollTop = currentScrollTop;
      }
    }
  }, [setTimelineLiveFollowEnabled, legendListRef]);
  const cancelTimelineLiveFollowForUserNavigationRef = useRef(
    cancelTimelineLiveFollowForUserNavigation,
  );
  useEffect(() => {
    cancelTimelineLiveFollowForUserNavigationRef.current =
      cancelTimelineLiveFollowForUserNavigation;
  }, [cancelTimelineLiveFollowForUserNavigation]);
  useEffect(() => {
    const previous = observedTimelineActivityRef.current;
    const dispatchedUserItem =
      previous?.hydrated &&
      previous.threadKey === activeThreadKey &&
      activeActivityRun !== null &&
      previous.runId !== activeActivityRun.runId
        ? serverProjection?.visibleTurnItems.find(
            (row) => row.item.type === "user_message" && row.item.runId === activeActivityRun.runId,
          )
        : undefined;
    const { observation, anchorMessageId: messageId } = observeTimelineRun(previous, {
      threadKey: activeThreadKey,
      hydrated: !isServerThread || (serverProjection !== null && threadStatus === "live"),
      runId: activeActivityRun?.runId ?? null,
      queued: activeActivityRun?.status === "queued",
      messageId:
        dispatchedUserItem?.item.type === "user_message" ? dispatchedUserItem.item.messageId : null,
    });
    observedTimelineActivityRef.current = observation;
    if (messageId === null) return;
    if (
      pendingTimelineAnchorRef.current !== null ||
      timelineScrollModeRef.current === "free-scrolling"
    ) {
      return;
    }

    isAtEndRef.current = true;
    timelineScrollModeRef.current = "anchoring-new-turn";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    pendingTimelineAnchorRef.current = messageId;
    activeTimelineAnchorIndexRef.current = null;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    setTimelineAnchor({ threadKey: activeThreadKey, messageId });
  }, [activeActivityRun, activeThreadKey, isServerThread, serverProjection, threadStatus]);
  const timelineRealContentOverflowsViewport = useCallback(
    (list?: LegendListRef | null) =>
      timelineContentOverflowsViewport((list ?? legendListRef.current)?.getState(), {
        composerInset: composerTimelineInset,
        anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET,
      }),
    [composerTimelineInset, legendListRef],
  );
  const pageScrollControllerRef = useRef<ReturnType<typeof createPageScrollController> | null>(
    null,
  );
  const handlePageScrollStart = useEffectEvent((key: PageScrollKey) => {
    timelineScrollIntentRef.current = key === "PageUp" ? "away-from-end" : "toward-end";
    composerRef.current?.collapseForTimelineScrollKey(key);
    if ((key === "PageUp" && timelineRealContentOverflowsViewport()) || !isTimelineAtLogicalEnd()) {
      cancelTimelineLiveFollowForUserNavigation();
    }
  });
  useEffect(() => {
    const controller = createPageScrollController({
      getContainer: () => legendListRef.current?.getScrollableNode() ?? null,
      getScrollPaddingBottomPx: () => composerOverlayElement?.getBoundingClientRect().height ?? 0,
      onScrollStart: handlePageScrollStart,
    });
    pageScrollControllerRef.current = controller;

    return () => {
      controller.dispose();
      if (pageScrollControllerRef.current === controller) {
        pageScrollControllerRef.current = null;
      }
    };
  }, [composerOverlayElement]);
  const onComposerPageScrollKeyDown = useCallback((key: PageScrollKey) => {
    pageScrollControllerRef.current?.handleKeyDown(key);
  }, []);
  const onComposerPageScrollKeyUp = useCallback((key: string) => {
    pageScrollControllerRef.current?.handleKeyUp(key);
  }, []);
  const onComposerPageScrollRelease = useCallback(() => {
    pageScrollControllerRef.current?.releaseActiveKey();
  }, []);
  // Live-follow stays active after send/thread-open until an actual list scroll
  // gesture opts out.
  const scrollToEnd = useCallback(
    (animated = false) => {
      cancelPositionRestoreRef.current?.();
      isAtEndRef.current = true;
      timelineScrollModeRef.current = "following-end";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      setTimelineLiveFollowEnabled(true);
      pendingTimelineAnchorRef.current = null;
      activeTimelineAnchorIndexRef.current = null;
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      setTimelineAnchor(releaseChatTimelineAnchor);
      // The anchored end space must be gone before the scroll measures, or the
      // list lands short of the real end (#6519).
      requestAnimationFrame(() => {
        void legendListRef.current?.scrollToEnd?.({ animated });
      });
    },
    [
      isAtEndRef,
      setTimelineLiveFollowEnabled,
      setShowScrollToBottom,
      setTimelineAnchor,
      legendListRef,
    ],
  );
  useEffect(() => {
    let removeListeners: (() => void) | null = null;
    let frame: number | null = null;
    const attach = (remainingAttempts: number) => {
      frame = requestAnimationFrame(() => {
        frame = null;
        const scrollNode = legendListRef.current?.getScrollableNode();
        if (!scrollNode) {
          // The list may not have mounted on the first frame after a thread
          // switch — without a retry the opt-out listeners never attach and
          // live-follow becomes impossible to escape for the whole thread.
          if (remainingAttempts > 0) {
            attach(remainingAttempts - 1);
          }
          return;
        }
        const handleManualNavigation = () => {
          cancelTimelineLiveFollowForUserNavigationRef.current();
        };
        // The gestures below must only break follow when they can actually
        // move the viewport away from the live edge (#5566): a spurious break
        // while pinned at the end produces no scroll event, never re-arms,
        // and streaming silently stops following. Underflowing content can't
        // scroll at all, so nothing there should break follow.
        const contentScrollsUp = () => timelineRealContentOverflowsViewport();
        // The follow re-arm band, not the strict flag: streaming growth makes
        // isAtEnd flicker false for a frame before the follow scroll catches
        // up, and a gesture landing in that window while still pinned would
        // otherwise break follow with no scroll event left to re-arm it.
        const viewportIsAwayFromEnd = () =>
          resolveTimelineIsAtEnd(legendListRef.current?.getState()) === false;
        // Only an upward wheel is a navigation intent; wheeling down while
        // following either does nothing (at the end) or moves toward it.
        const handleWheel = (event: WheelEvent) => {
          if (event.ctrlKey || !isTimelineScrollTarget(event.target, scrollNode, event.deltaY))
            return;
          if (event.deltaY > 0) {
            timelineScrollIntentRef.current = "toward-end";
            if (isAtEndRef.current) {
              composerRef.current?.restoreAfterTimelineReachedEnd();
            }
          } else if (event.deltaY < 0) {
            timelineScrollIntentRef.current = "away-from-end";
          }
          if (event.deltaY < 0 && contentScrollsUp()) {
            handleManualNavigation();
          }
        };
        // Only a finger moving down scrolls the list up, and only once the
        // drag has carried the viewport out of the end band — an upward flick
        // gets there within its first few events and later touchmoves break.
        // A tap's jitter, or a finger moving up, never does.
        let touchStartY: number | null = null;
        const handleTouchStart = (event: TouchEvent) => {
          touchStartY = event.touches[0]?.clientY ?? null;
        };
        const handleTouchMove = (event: TouchEvent) => {
          const y = event.touches[0]?.clientY;
          if (touchStartY === null || y === undefined || y - touchStartY < 8) return;
          if (viewportIsAwayFromEnd()) {
            handleManualNavigation();
          }
        };
        // Scrollbar drags produce no wheel/touch events; they are the only
        // pointerdowns whose target is the scroll node itself rather than a
        // message row. A click on a message is not a scroll: the view sits
        // off the end while a new turn is framed at the top or a frame
        // behind streamed text, and a click there (a link, a disclosure, a
        // word) must keep following. Dragging a selection past the edge does
        // scroll, so the list moving while a pressed pointer moves breaks it.
        let selectionDrag: "pressed" | "dragging" | null = null;
        const handlePointerDown = (event: PointerEvent) => {
          if (event.target === scrollNode) {
            if (contentScrollsUp()) {
              handleManualNavigation();
            }
            return;
          }
          selectionDrag = event.pointerType === "mouse" ? "pressed" : null;
        };
        const handlePointerMove = () => {
          if (selectionDrag === "pressed") selectionDrag = "dragging";
        };
        const handlePointerUp = () => {
          selectionDrag = null;
        };
        const handleScrollWhileSelecting = () => {
          if (selectionDrag === "dragging" && viewportIsAwayFromEnd()) {
            selectionDrag = null;
            handleManualNavigation();
          }
        };
        // Keyboard scrolling (PageUp/Home/ArrowUp) bypasses wheel and
        // pointer events entirely; without this the timeline yanks back to
        // the end on the next stream chunk. Clicking message text can leave
        // DOM focus on body, so these keys must also be heard at document.
        const handleKeyDown = (event: KeyboardEvent) => {
          if (
            !(event.target instanceof Node) ||
            (!scrollNode.contains(event.target) &&
              event.target !== document.body &&
              event.target !== document.documentElement) ||
            event.defaultPrevented ||
            event.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR) ||
            eventPathContainsSelector(event, KEYBOARD_OWNER_SELECTOR) ||
            document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)
          ) {
            return;
          }
          if (!["PageUp", "Home", "ArrowUp", "PageDown", "End", "ArrowDown"].includes(event.key))
            return;
          const scrollDirection = ["PageUp", "Home", "ArrowUp"].includes(event.key) ? -1 : 1;
          if (
            scrollNode.contains(event.target) &&
            !isTimelineScrollTarget(event.target, scrollNode, scrollDirection)
          )
            return;
          switch (event.key) {
            case "PageUp":
            case "Home":
            case "ArrowUp":
              timelineScrollIntentRef.current = "away-from-end";
              if (contentScrollsUp()) {
                handleManualNavigation();
                composerRef.current?.collapseForTimelineScrollKey(event.key);
              }
              break;
            case "PageDown":
            case "End":
            case "ArrowDown":
              timelineScrollIntentRef.current = "toward-end";
              if (viewportIsAwayFromEnd()) {
                handleManualNavigation();
              }
              composerRef.current?.collapseForTimelineScrollKey(event.key);
              if (isTimelineAtLogicalEnd()) {
                composerRef.current?.restoreAfterTimelineReachedEnd();
              }
              break;
            default:
              break;
          }
        };
        scrollNode.addEventListener("wheel", handleWheel, {
          passive: true,
        });
        scrollNode.addEventListener("touchstart", handleTouchStart, { passive: true });
        scrollNode.addEventListener("touchmove", handleTouchMove, {
          passive: true,
        });
        scrollNode.addEventListener("pointerdown", handlePointerDown, {
          passive: true,
        });
        scrollNode.addEventListener("scroll", handleScrollWhileSelecting, { passive: true });
        window.addEventListener("pointermove", handlePointerMove, { passive: true });
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerUp);
        document.addEventListener("keydown", handleKeyDown);
        removeListeners = () => {
          scrollNode.removeEventListener("wheel", handleWheel);
          scrollNode.removeEventListener("touchstart", handleTouchStart);
          scrollNode.removeEventListener("touchmove", handleTouchMove);
          scrollNode.removeEventListener("pointerdown", handlePointerDown);
          scrollNode.removeEventListener("scroll", handleScrollWhileSelecting);
          window.removeEventListener("pointermove", handlePointerMove);
          window.removeEventListener("pointerup", handlePointerUp);
          window.removeEventListener("pointercancel", handlePointerUp);
          document.removeEventListener("keydown", handleKeyDown);
        };
      });
    };
    attach(12);

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      removeListeners?.();
    };
  }, [activeThread?.id, isTimelineAtLogicalEnd, timelineRealContentOverflowsViewport]);

  const onTimelineAnchorReady = useCallback(
    (messageId: MessageId, anchorIndex: number) => {
      if (!shouldPositionTimelineAnchor(timelineScrollModeRef.current)) {
        return;
      }
      if (pendingTimelineAnchorRef.current === messageId) {
        pendingTimelineAnchorRef.current = null;
      }
      activeTimelineAnchorIndexRef.current = anchorIndex;
      if (positionedTimelineAnchorRef.current === messageId) {
        return;
      }
      positionedTimelineAnchorRef.current = messageId;
      settledTimelineAnchorRef.current = null;
      const positionAnchor = (remainingAttempts: number) => {
        requestAnimationFrame(() => {
          if (positionedTimelineAnchorRef.current !== messageId) {
            return;
          }
          const list = legendListRef.current;
          if (!list) {
            if (remainingAttempts > 0) {
              positionAnchor(remainingAttempts - 1);
            }
            return;
          }
          const scrollNode = list.getScrollableNode();
          let finished = false;
          const finishAnimatedPositioning = () => {
            if (finished) {
              return;
            }
            finished = true;
            window.clearTimeout(fallbackTimer);
            scrollNode.removeEventListener("scrollend", finishAnimatedPositioning);
            if (positionedTimelineAnchorRef.current !== messageId) {
              return;
            }
            const scrollOffset = list.getState().scroll;
            void list.scrollToOffset({ offset: scrollOffset, animated: false });
            settledTimelineAnchorRef.current = messageId;
          };
          const fallbackTimer = window.setTimeout(finishAnimatedPositioning, 750);
          scrollNode.addEventListener("scrollend", finishAnimatedPositioning, { once: true });
          void list.scrollToIndex({
            index: anchorIndex,
            animated: true,
            viewPosition: 0,
            // Land below the banner lane, not under it.
            viewOffset: CHAT_LIST_ANCHOR_OFFSET + timelineBannerOverlayHeightRef.current,
          });
        });
      };
      requestAnimationFrame(() => positionAnchor(12));
    },
    [legendListRef, timelineBannerOverlayHeightRef],
  );
  const onTimelineAnchorSizeChanged = useCallback(
    (messageId: MessageId) => {
      if (settledTimelineAnchorRef.current !== messageId) {
        return;
      }
      if (liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current) {
        return;
      }
      const scrollOffset = legendListRef.current?.getState().scroll;
      if (scrollOffset === undefined) {
        return;
      }
      if (pendingAnchorScrollRestoreRef.current === null) {
        pendingAnchorScrollRestoreRef.current = {
          messageId,
          offset: scrollOffset,
          userScrollGeneration: anchorUserScrollGenerationRef.current,
        };
      }
      if (anchorScrollRestoreFrameRef.current !== null) {
        return;
      }
      anchorScrollRestoreFrameRef.current = requestAnimationFrame(() => {
        anchorScrollRestoreFrameRef.current = null;
        const pending = pendingAnchorScrollRestoreRef.current;
        pendingAnchorScrollRestoreRef.current = null;
        if (
          pending &&
          settledTimelineAnchorRef.current === pending.messageId &&
          pending.userScrollGeneration === anchorUserScrollGenerationRef.current
        ) {
          const list = legendListRef.current;
          const currentScrollOffset = list?.getState().scroll;
          if (
            typeof currentScrollOffset === "number" &&
            Math.abs(currentScrollOffset - pending.offset) <= 2
          ) {
            void list?.scrollToOffset({ offset: pending.offset, animated: false });
          }
        }
      });
    },
    [legendListRef],
  );

  const onToolOutputCollapsedAtEnd = useCallback(() => {
    composerRef.current?.restoreAfterTimelineReachedEnd();
  }, [composerRef]);

  const onIsAtEndChange = useCallback(
    (isAtEnd: boolean) => {
      if (
        !isAtEnd &&
        liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current
      ) {
        showScrollDebouncer.current.cancel();
        setShowScrollToBottom(false);
        return;
      }
      if (isAtEndRef.current === isAtEnd) return;
      isAtEndRef.current = isAtEnd;
      if (isAtEnd) {
        if (timelineScrollIntentRef.current === "toward-end") {
          composerRef.current?.restoreAfterTimelineReachedEnd();
        }
        timelineScrollModeRef.current = "following-end";
        liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
        setTimelineLiveFollowEnabled(true);
        // Reachable only once manual navigation has already broken follow, so
        // the anchored turn framing is over: the user scrolled back to the live
        // edge and expects the stream to stick to it again, exactly like the
        // scroll-to-bottom pill (#6519).
        setTimelineAnchor(releaseChatTimelineAnchor);
        showScrollDebouncer.current.cancel();
        setShowScrollToBottom(false);
      } else {
        timelineScrollModeRef.current = "free-scrolling";
        liveFollowUserScrollGenerationRef.current = null;
        showScrollDebouncer.current.maybeExecute();
      }
    },
    [
      setShowScrollToBottom,
      isAtEndRef,
      composerRef,
      setTimelineLiveFollowEnabled,
      setTimelineAnchor,
    ],
  );

  useLayoutEffect(() => {
    if (timelineScrollModeRef.current !== "anchoring-new-turn") return;
    if (
      shouldReleaseTimelineAnchorForToolActivity({
        anchorMessageId: timelineAnchorMessageId,
        liveFollowEnabled: timelineLiveFollowEnabled,
        runningTurnId: activeRunningTurnId,
        timelineEntries,
      })
    ) {
      scrollToEnd();
    }
  }, [
    activeRunningTurnId,
    scrollToEnd,
    timelineAnchorMessageId,
    timelineEntries,
    timelineLiveFollowEnabled,
  ]);

  useEffect(() => {
    setPullRequestDialogState(null);
    const followEnd = readTimelinePosition(routeThreadKey)?.atEnd !== false;
    isAtEndRef.current = followEnd;
    timelineScrollIntentRef.current = null;
    timelineScrollModeRef.current = followEnd ? "following-end" : "free-scrolling";
    liveFollowUserScrollGenerationRef.current = followEnd
      ? anchorUserScrollGenerationRef.current
      : null;
    setTimelineLiveFollowEnabled(followEnd);
    pendingTimelineAnchorRef.current = null;
    positionedTimelineAnchorRef.current = null;
    settledTimelineAnchorRef.current = null;
    activeTimelineAnchorIndexRef.current = null;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(!followEnd);
    // Environment identity is part of the scroll session too.
  }, [activeThreadKey]);

  // The viewer overlay's copy of the thread leaves focus with the viewer, so
  // its keys (arrows, zoom) work on open; a click puts it in the composer.
  const inViewerOverlay = useContext(InViewerOverlay);
  useEffect(() => {
    if (!activeThread?.id || terminalUiState.terminalOpen || inViewerOverlay) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, inViewerOverlay, terminalUiState.terminalOpen]);

  // Tabbing back into the app lands focus wherever it last was, often the right panel or the
  // body. Put it in the composer unless something that takes typing already holds it. The
  // drawer terminal owns keyboard input while it is open, so it opts out here; a right panel
  // terminal is a surface and is recognized by the predicate instead. A phone keyboard is left
  // alone so returning to the app does not raise it; a narrow desktop window still refocuses.
  useEffect(() => {
    if (!activeThread?.id || terminalUiState.terminalOpen || isPhoneKeyboard || inViewerOverlay)
      return;
    let frame: number | null = null;
    const onWindowFocus = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      // The element that held focus receives it again after the window's own event, and the
      // composer ignores that same frame so a restored focus does not lift a scroll-collapsed
      // composer. Wait one more frame so this focus counts as a request to expand it.
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          if (shouldRefocusComposerOnWindowFocus(document.activeElement)) focusComposer();
        });
      });
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [
    activeThread?.id,
    focusComposer,
    inViewerOverlay,
    isPhoneKeyboard,
    terminalUiState.terminalOpen,
  ]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeMessageCount === 0) {
      return;
    }
    const removedMessages = optimisticUserMessages.filter((message) =>
      serverAcknowledgedUserMessageIds.has(message.id),
    );
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverAcknowledgedUserMessageIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    activeMessageCount,
    activeThread?.id,
    serverAcknowledgedUserMessageIds,
    handoffAttachmentPreviews,
    optimisticUserMessages,
  ]);

  // Keyed on the thread, not the draft: a draft's promotion to its server
  // route keeps this instance and drops `draftId`, and the send it is still
  // dispatching must survive that swap.
  useEffect(() => {
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    resetLocalDispatch();
    setExpandedImage(null);
  }, [resetLocalDispatch, threadId]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, [setExpandedImage]);

  const activeWorktreePath = activeThread?.worktreePath ?? null;
  const derivedEnvMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: isServerThread,
    draftThreadEnvMode: isLocalDraftThread ? draftThread?.envMode : undefined,
    preparingWorktree: isPreparingWorktree,
  });
  const canOverrideServerThreadEnvMode = Boolean(
    isServerThread &&
    activeThread &&
    activeMessageCount === 0 &&
    activeThread.worktreePath === null &&
    !envLocked,
  );
  const envMode: DraftThreadEnvMode = canOverrideServerThreadEnvMode
    ? (pendingServerThreadEnvMode ?? draftThread?.envMode ?? derivedEnvMode)
    : derivedEnvMode;
  const activeThreadBranch =
    canOverrideServerThreadEnvMode && pendingServerThreadBranch !== undefined
      ? pendingServerThreadBranch
      : (activeThread?.branch ?? null);
  const startFromOrigin = isLocalDraftThread
    ? (draftThread?.startFromOrigin ?? false)
    : canOverrideServerThreadEnvMode
      ? (pendingServerThreadStartFromOriginByThreadId[activeThread?.id ?? ""] ??
        activeProjectSettings.settings.newWorktreesStartFromOrigin)
      : false;
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
  });
  const localCheckoutBranchMismatch = useMemo(
    () =>
      isServerThread
        ? resolveLocalCheckoutBranchMismatch({
            effectiveEnvMode: envMode,
            activeWorktreePath,
            activeThreadBranch,
            currentGitBranch: gitStatusQuery.data?.refName ?? null,
          })
        : null,
    [activeThreadBranch, activeWorktreePath, envMode, gitStatusQuery.data?.refName, isServerThread],
  );
  const publishComposerOverlayHeight = useCallback(
    (height: number) => {
      const nextHeight = Math.ceil(height);
      if (nextHeight <= 0) return;
      const isResting = overlayComposerIsResting({
        composerMounted: composerMountedRef.current,
        composerReportedResting: composerRestingRef.current,
      });
      const modelStrip = composerOverlayElement?.querySelector<HTMLElement>(
        '[data-composer-model-strip="true"]',
      );
      // The model-only strip disappears on expansion; counting it again would
      // add 32px of timeline padding as soon as the empty composer collapses.
      const restingOnlyHeight =
        modelStrip && isResting
          ? Math.max(
              0,
              modelStrip.offsetHeight + Number.parseFloat(getComputedStyle(modelStrip).marginTop),
            )
          : 0;
      const nextInset = resolveComposerTimelineInset({
        currentInset: composerTimelineInsetRef.current,
        overlayHeight: nextHeight,
        isResting,
        restingOnlyHeight,
      });
      if (composerTimelineInsetRef.current !== nextInset) {
        composerTimelineInsetRef.current = nextInset;
        setComposerTimelineInset(nextInset);
      }
      const mainSurface = composerOverlayElement?.querySelector<HTMLElement>(
        '[data-chat-composer-main-surface="true"]',
      );
      const button = composerOverlayElement?.parentElement?.querySelector<HTMLElement>(
        'button[aria-label="Jump to latest"]',
      );
      const clearance =
        composerOverlayElement && mainSurface && button
          ? resolveScrollToEndClearance({
              overlayHeight: nextHeight,
              mainSurfaceTop: mainSurface.getBoundingClientRect().top,
              button: button.getBoundingClientRect(),
              attachments: Array.from(
                composerOverlayElement.querySelectorAll<HTMLElement>(
                  '[data-composer-banner-surface="attached"]',
                ),
                (element) => element.getBoundingClientRect(),
              ),
            })
          : nextHeight;
      setScrollToEndClearance(clearance);
    },
    [
      composerOverlayElement,
      composerMountedRef,
      composerRestingRef,
      composerTimelineInsetRef,
      setComposerTimelineInset,
      setScrollToEndClearance,
    ],
  );
  // The composer reports its resting flag from a layout effect, which runs
  // before this component's own layout effects and before any resize
  // observation, so every measurement below sees the flag for its layout.
  // Only the flag is stored here: the stored height still belongs to the
  // previous layout, and the composer publishes the new layout's height
  // itself once it has measured it.
  const onComposerRestingChange = useCallback(
    (resting: boolean) => {
      composerRestingRef.current = resting;
    },
    [composerRestingRef],
  );
  // A held reservation belongs to the previous thread's draft. Rebuild it from
  // this thread's overlay so a tall draft elsewhere does not pad this one.
  useLayoutEffect(() => {
    if (!composerOverlayElement) return;
    composerTimelineInsetRef.current = 0;
    publishComposerOverlayHeight(composerOverlayElement.getBoundingClientRect().height);
  }, [activeThreadKey, composerOverlayElement, publishComposerOverlayHeight]);

  useLayoutEffect(() => {
    if (!composerOverlayElement) return;

    const updateHeight = () => {
      publishComposerOverlayHeight(composerOverlayElement.getBoundingClientRect().height);
    };

    updateHeight();
    if (typeof ResizeObserver === "undefined") return;

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(composerOverlayElement);
    return () => {
      resizeObserver.disconnect();
    };
  }, [composerOverlayElement, publishComposerOverlayHeight, showScrollToBottom]);
  // Swapping the composer for the status bar (or back) changes what the
  // overlay holds, so rebuild the reservation from the new content.
  useLayoutEffect(() => {
    if (composerMountedRef.current === composerMounted) return;
    composerMountedRef.current = composerMounted;
    if (!composerOverlayElement) return;
    composerTimelineInsetRef.current = 0;
    publishComposerOverlayHeight(composerOverlayElement.getBoundingClientRect().height);
  }, [composerMounted, composerOverlayElement, publishComposerOverlayHeight]);
  const openPanelPullRequestUrl = useOpenPanelPullRequestUrl(activeThreadTarget);
  const activeThreadReferenceCopyTarget = useMemo(
    () =>
      activeThreadId === null || !isServerThread
        ? null
        : resolveThreadReferenceCopyTarget({
            threadId: activeThreadId,
            openPanelPullRequestUrl,
            pullRequests: activeThread?.pullRequests,
            linkedPullRequestUrl: linkedThreadPullRequest?.url ?? null,
          }),
    [
      activeThreadId,
      isServerThread,
      activeThread?.pullRequests,
      linkedThreadPullRequest?.url,
      openPanelPullRequestUrl,
    ],
  );
  const copyActiveThreadReference = useCallback(() => {
    const target = activeThreadReferenceCopyTarget;
    if (target === null) return;
    void writeTextToClipboard(target.value, target.clipboardTarget).then(
      (didCopy) => {
        if (!didCopy) return;
        toastManager.add({
          type: "success",
          title: target.successTitle,
          description: target.value,
        });
      },
      (error) => {
        console.error(error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: target.failureTitle,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  }, [activeThreadReferenceCopyTarget]);
  const pullRequestPanelTarget = activeThread
    ? threadPullRequestPanelTarget({
        projectId: activeThread.projectId,
        pullRequests: visiblePullRequests,
        linkedPullRequest: linkedThreadPullRequest,
        branchPullRequest: activeThreadShell?.branchPullRequest ?? activeThread.branchPullRequest,
      })
    : null;
  const addPullRequestSurface = useCallback(() => {
    if (!supportsPullRequests || activeThreadTarget === null || pullRequestPanelTarget === null)
      return;
    useRightPanelStore.getState().openPullRequest(activeThreadTarget, pullRequestPanelTarget);
  }, [activeThreadTarget, pullRequestPanelTarget, supportsPullRequests]);
  const pullRequestSurfaceAvailable = supportsPullRequests && pullRequestPanelTarget !== null;
  const supportsSettlement = serverConfig?.environment.capabilities.threadSettlement === true;
  const supportsSnooze = serverConfig?.environment.capabilities.threadSnooze === true;
  const supportsPinning = serverConfig?.environment.capabilities.threadPinning === true;
  const activeThreadPinned = supportsPinning && activeThreadShell?.pinnedAt != null;
  const activeThreadSnoozed = useRenderRead(
    () =>
      activeThreadShell !== null &&
      supportsSnooze &&
      effectiveSnoozed(activeThreadShell, { now: new Date().toISOString() }),
  );
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  useEffect(() => {
    void snoozeWakeTick;
    if (!activeThreadSnoozed) return;
    const wakeAtMs = Date.parse(activeThreadShell?.snoozedUntil ?? "");
    if (!Number.isFinite(wakeAtMs)) return;
    const id = window.setTimeout(
      () => bumpSnoozeWakeTick((tick) => tick + 1),
      Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647),
    );
    return () => window.clearTimeout(id);
  }, [activeThreadShell?.snoozedUntil, activeThreadSnoozed, snoozeWakeTick]);
  const activeThreadWokeAt = useRenderRead(() =>
    activeThreadShell !== null && supportsSnooze
      ? threadWokeAt(activeThreadShell, { now: new Date().toISOString() })
      : null,
  );
  const acknowledgeThreadWoke = useAcknowledgeThreadWoke();
  const acknowledgeActiveThreadWoke = useCallback(() => {
    if (activeThreadTarget === null || activeThreadWokeAt === null) return;
    acknowledgeThreadWoke(activeThreadTarget, activeThreadWokeAt);
  }, [acknowledgeThreadWoke, activeThreadTarget, activeThreadWokeAt]);
  // Mirror of the sidebar's Woke pill for the open thread. Same watermark as
  // the sidebar, so an acknowledgement from any device hides it.
  const activeThreadLocalVisitedAt = useUiStateStore((store) =>
    activeThreadKey === null ? undefined : store.threadLastVisitedAtById[activeThreadKey],
  );
  const activeThreadLastVisitedAt = resolveThreadLastVisitedAt(
    activeThreadShell?.lastVisitedAt,
    activeThreadLocalVisitedAt,
  );
  const activeThreadWokeVisible = useMemo(() => {
    if (activeThreadWokeAt === null) return false;
    if (activeThreadShell?.settledOverride === "settled") return false;
    const wokeAtMs = Date.parse(activeThreadWokeAt);
    if (Number.isNaN(wokeAtMs)) return false;
    // Having the thread open counts as a visit at completedAt (the effect
    // above stamps it); folding that floor in here keeps a completion-
    // triggered wake from flashing a banner for one frame before the stamp
    // lands. An unparseable stored visit counts as never-visited: corrupt
    // data must not eat the wake signal.
    const storedVisitMs = activeThreadLastVisitedAt ? Date.parse(activeThreadLastVisitedAt) : NaN;
    const completedAtMs = activeLatestRun?.completedAt
      ? Date.parse(activeLatestRun.completedAt)
      : NaN;
    const visitedMs = Number.isNaN(storedVisitMs) ? -Infinity : storedVisitMs;
    const completedMs = Number.isNaN(completedAtMs) ? -Infinity : completedAtMs;
    // Not Math.max: the React Compiler fails to generate code for that call here.
    const lastVisitedMs = visitedMs > completedMs ? visitedMs : completedMs;
    return lastVisitedMs < wokeAtMs;
  }, [
    activeLatestRun?.completedAt,
    activeThreadLastVisitedAt,
    activeThreadShell,
    activeThreadWokeAt,
    activeLatestRun,
  ]);
  const activeThreadSettled =
    supportsSettlement && activeThreadShell?.settledOverride === "settled";
  const unsettleThreadMutation = useOrchestrationCommand(threadEnvironment.unsettle, {
    reportFailure: false,
  });
  // Keyed by thread, not a boolean: the pending state must follow the thread
  // it belongs to across navigation, and a request resolving for thread A
  // must never clear (or re-enable) thread B's button.
  const [unsettlingThreadKey, setUnsettlingThreadKey] = useState<string | null>(null);
  const isUnsettling = unsettlingThreadKey !== null && unsettlingThreadKey === activeThreadKey;
  const handleUnsettleActiveThread = useCallback(async () => {
    if (
      !activeThreadTarget ||
      !readEnvironmentScope(activeThreadTarget.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const threadKey = scopedThreadKey(activeThreadTarget);
    setUnsettlingThreadKey(threadKey);
    await settleAfter(
      async () => {
        const result = await unsettleThreadMutation({
          environmentId: activeThreadTarget.environmentId,
          input: { threadId: activeThreadTarget.threadId, reason: "user" },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: THREAD_LIFECYCLE_LABELS.failedReopen,
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      },
      () => {
        setUnsettlingThreadKey((current) => (current === threadKey ? null : current));
      },
    );
  }, [activeThreadTarget, unsettleThreadMutation]);
  const unsnoozeThreadMutation = useOrchestrationCommand(threadEnvironment.unsnooze, {
    reportFailure: false,
  });
  const [unsnoozingThreadKey, setUnsnoozingThreadKey] = useState<string | null>(null);
  const isUnsnoozing = unsnoozingThreadKey !== null && unsnoozingThreadKey === activeThreadKey;
  const handleUnsnoozeActiveThread = useCallback(async () => {
    if (
      !activeThreadTarget ||
      !readEnvironmentScope(activeThreadTarget.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const threadKey = scopedThreadKey(activeThreadTarget);
    setUnsnoozingThreadKey(threadKey);
    await settleAfter(
      async () => {
        const recovery = activeThreadShell?.limitRecovery;
        const recoveryOwnsSnooze =
          recovery?.snooze === true &&
          recovery.runId === activeThreadShell?.latestRun?.runId &&
          activeThreadShell?.snoozedUntil != null &&
          Date.parse(activeThreadShell.snoozedUntil) === Date.parse(recovery.resetAt ?? "");
        const result = recoveryOwnsSnooze
          ? await updateThreadMetadata({
              environmentId: activeThreadTarget.environmentId,
              input: {
                threadId: activeThreadTarget.threadId,
                limitRecovery: { runId: recovery.runId, resetAt: recovery.resetAt, snooze: false },
              },
            })
          : await unsnoozeThreadMutation({
              environmentId: activeThreadTarget.environmentId,
              input: { threadId: activeThreadTarget.threadId, reason: "user" },
            });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to wake thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      },
      () => {
        setUnsnoozingThreadKey((current) => (current === threadKey ? null : current));
      },
    );
  }, [activeThreadTarget, activeThreadShell, unsnoozeThreadMutation, updateThreadMetadata]);
  const [isRestoringThreadBranch, setIsRestoringThreadBranch] = useState(false);
  const [branchRestoreConfirmOpen, setBranchRestoreConfirmOpen] = useState(false);
  // Once revealed for a given mismatch, the banner stays mounted until the
  // mismatch changes or resolves, so clearing the draft doesn't flicker it.
  const [revealedBranchMismatchKey, setRevealedBranchMismatchKey] = useState<string | null>(null);
  // Dismissal lives in a module-level set (survives remounts); this tick just
  // forces a re-render so the banner leaves immediately.
  const [, setBranchMismatchDismissTick] = useState(0);
  const composerHasDraftContent = useComposerDraftStore((store) =>
    composerDraftHasUserContent(store.getComposerDraft(composerDraftTarget)),
  );
  const activeBranchMismatchKey = branchMismatchKey(
    activeThread?.id ?? null,
    localCheckoutBranchMismatch,
  );
  const branchMismatchDismissed = useRenderRead(() =>
    isBranchMismatchDismissedForSession(activeBranchMismatchKey),
  );
  const showBranchMismatchBanner = shouldShowBranchMismatchBanner({
    hasMismatch: localCheckoutBranchMismatch !== null,
    isDismissed: branchMismatchDismissed,
    composerHasContent: composerHasDraftContent,
    wasShownForCurrentMismatch:
      revealedBranchMismatchKey !== null && revealedBranchMismatchKey === activeBranchMismatchKey,
  });
  useEffect(() => {
    setRevealedBranchMismatchKey((revealed) => {
      if (showBranchMismatchBanner) {
        return activeBranchMismatchKey;
      }
      // Hysteresis is scoped to an uninterrupted mismatch: reset when the
      // mismatch resolves or changes so a recurrence re-gates on intent.
      return revealed !== null && revealed !== activeBranchMismatchKey ? null : revealed;
    });
  }, [activeBranchMismatchKey, showBranchMismatchBanner]);
  const handleSwitchCheckoutToThread = useCallback(async () => {
    if (!canWriteSourceControl) return;
    if (
      !activeProjectCwd ||
      !activeThread ||
      !localCheckoutBranchMismatch ||
      isRestoringThreadBranch
    ) {
      return;
    }
    setIsRestoringThreadBranch(true);
    const checkoutResult = await switchGitRevision({
      environmentId,
      input: {
        cwd: activeProjectCwd,
        refName: localCheckoutBranchMismatch.threadBranch,
      },
    });
    if (checkoutResult._tag === "Failure") {
      setIsRestoringThreadBranch(false);
      if (!isAtomCommandInterrupted(checkoutResult)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to switch checkout",
            description: chatActionErrorMessage(squashAtomCommandFailure(checkoutResult)),
          }),
        );
      }
      return;
    }

    if (!readEnvironmentScope(environmentId, AuthSourceControlWriteScope)) {
      setIsRestoringThreadBranch(false);
      return;
    }
    const nextBranch = checkoutResult.value.refName ?? localCheckoutBranchMismatch.threadBranch;
    if (nextBranch !== activeThread.branch) {
      const updateResult = await updateThreadMetadata({
        environmentId,
        input: { threadId: activeThread.id, branch: nextBranch, worktreePath: null },
      });
      if (updateResult._tag === "Failure") {
        setIsRestoringThreadBranch(false);
        if (!isAtomCommandInterrupted(updateResult)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Checkout switched, but the thread could not be updated",
              description: chatActionErrorMessage(squashAtomCommandFailure(updateResult)),
            }),
          );
        }
        gitStatusQuery.refresh();
        return;
      }
    }
    gitStatusQuery.refresh();
    setIsRestoringThreadBranch(false);
    scheduleComposerFocus();
  }, [
    canWriteSourceControl,
    activeProjectCwd,
    activeThread,
    environmentId,
    gitStatusQuery,
    isRestoringThreadBranch,
    localCheckoutBranchMismatch,
    scheduleComposerFocus,
    switchGitRevision,
    updateThreadMetadata,
  ]);
  // The stack renders items[0] front-most and tucks the rest behind hover, so
  // ordering is priority: system banners, then the branch-mismatch notice,
  // and the informational parked-thread banner last — it must never cover another.
  // Background work (subagent fleets, workflow runs, watch loops, dev servers) can outlive
  // the turn; once it settles, the composer stop button is gone, so this
  // banner is the only visible stop affordance. The interrupt path also
  // accepts a completed run while its provider still has background work.
  const activeBackgroundTasks = !isWorking && activeThread ? pendingBackgroundTasks : [];
  const [stoppingBackgroundWorkKey, setStoppingBackgroundWorkKey] = useState<string | null>(null);
  const isStoppingBackgroundWork =
    stoppingBackgroundWorkKey === `${environmentId}:${activeThreadId}`;
  const handleStopBackgroundWork = useCallback(async () => {
    if (!activeThread || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return;
    const requestKey = `${environmentId}:${activeThread.id}`;
    setStoppingBackgroundWorkKey(requestKey);
    const result = await interruptThreadTurn({
      environmentId,
      input: { threadId: activeThread.id },
    });
    // Acceptance does not confirm termination. Allow retry while the provider
    // finishes stopping the tasks or reports a failure.
    setStoppingBackgroundWorkKey((current) => (current === requestKey ? null : current));
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to stop background work.",
        );
      }
    }
  }, [activeThread, environmentId, interruptThreadTurn, setThreadError]);
  const onOpenRelatedThread = useCallback(
    (threadId: ThreadId) => {
      void openThreadRoute(scopeThreadRef(environmentId, threadId));
    },
    [environmentId, openThreadRoute],
  );
  // Where the thread came from, for the meta row above the timeline: a thread
  // the coordinator delegated is a worker; only one another thread started is
  // a subagent of it.
  const coordinatorThreadId = projectRouting?.coordinatorThreadId ?? null;
  // Only the coordinator starts a project's threads, so a worker needs no chip;
  // the coordinator stays one click away in the column beside it.
  const threadOrigin = useMemo<ThreadOrigin | null>(() => {
    if (transcriptOnly || !activeThreadShell || parentThreadLink === null) return null;
    const coordinatorIds = new Set(coordinatorThreadId ? [coordinatorThreadId] : []);
    if (!isNestedSubagentThread(activeThreadShell, coordinatorIds)) return null;
    return {
      kind: "subagent",
      parentTitle: parentThreadLink.title,
      onOpen: () => onOpenRelatedThread(parentThreadLink.threadId),
    };
  }, [
    activeThreadShell,
    coordinatorThreadId,
    onOpenRelatedThread,
    parentThreadLink,
    transcriptOnly,
  ]);

  // Commands such as /compact and /goal clear run as their own turn. The draft
  // and its attachments stay local.
  const sendStandaloneCommand = useCallback(
    async (text: string, failureMessage: string) => {
      if (!activeThread || !clientSettingsHydrated || sendInFlightRef.current) return;
      const context = composerRef.current?.getSendContext();
      if (!context || (!context.providerAvailable && !projectRouting?.continueCoordinator)) return;

      const threadId = activeThread.id;
      const messageId = newMessageId();
      const createdAt = new Date().toISOString();
      sendInFlightRef.current = true;
      beginLocalDispatch();
      setThreadError(threadId, null);
      setOptimisticUserMessages((messages) => [
        ...messages,
        {
          id: messageId,
          role: "user",
          text,
          runId: null,
          createdAt,
          updatedAt: createdAt,
          streaming: false,
        },
      ]);
      scrollToEnd();
      await settleAfter(
        async () => {
          const settingsResult = await persistThreadSettingsForNextTurn({
            threadId,
            createdAt,
            ...(localCheckoutBranchMismatch
              ? { branch: localCheckoutBranchMismatch.currentBranch }
              : {}),
            runtimeMode,
            interactionMode: context.interactionMode,
          });
          const dispatched = await settlePromise<AtomCommandResult<unknown, unknown>>(() =>
            settingsResult._tag === "Failure"
              ? Promise.resolve(settingsResult)
              : continueWithProjectModel(
                  projectRouting,
                  context.selectedModelSelection,
                  (selection) =>
                    startThreadTurn({
                      environmentId,
                      input: {
                        threadId,
                        message: { messageId, role: "user", text, attachments: [] },
                        modelSelection: selection ?? context.selectedModelSelection,
                        runtimeMode,
                        interactionMode: context.interactionMode,
                        createdAt,
                      },
                    }),
                ),
          );
          const result = dispatched._tag === "Failure" ? dispatched : dispatched.value;
          if (result._tag === "Failure") {
            setOptimisticUserMessages((messages) =>
              messages.filter((message) => message.id !== messageId),
            );
            resetLocalDispatch();
            if (!isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              setThreadError(threadId, error instanceof Error ? error.message : failureMessage);
            }
          } else {
            clearUsageLimitsFor(routeThreadKey);
          }
        },
        () => {
          sendInFlightRef.current = false;
        },
      );
    },
    [
      activeThread,
      projectRouting,
      beginLocalDispatch,
      clientSettingsHydrated,
      composerRef,
      environmentId,
      localCheckoutBranchMismatch,
      persistThreadSettingsForNextTurn,
      resetLocalDispatch,
      routeThreadKey,
      runtimeMode,
      scrollToEnd,
      sendInFlightRef,
      setThreadError,
      startThreadTurn,
      setOptimisticUserMessages,
      clearUsageLimitsFor,
    ],
  );
  // A native /goal keeps the agent working across turns. Stop pauses a Codex
  // goal; once the thread is idle the row offers the native follow-ups.
  const activeGoal = activeThreadShell?.goal ?? null;
  const goalBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!activeThread || activeGoal === null) return null;
    const presentation = presentProviderGoal(activeGoal, isWorking);
    return {
      id: `goal:${activeThread.id}`,
      variant: "default",
      priority: "activity",
      icon: <TargetIcon />,
      // Usage stays in the title so a long objective cannot clip it.
      title:
        presentation.usage === null
          ? presentation.title
          : `${presentation.title} · ${presentation.usage}`,
      description: presentation.objective,
      actions: isWorking ? undefined : (
        <>
          {presentation.canResume ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void sendStandaloneCommand("/goal resume", "Failed to resume goal.")}
            >
              Resume
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void sendStandaloneCommand("/goal clear", "Failed to clear goal.")}
          >
            Clear
          </Button>
        </>
      ),
    };
  }, [activeGoal, activeThread, isWorking, sendStandaloneCommand]);

  const backgroundWorkBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    const presentation = presentPendingBackgroundWork(activeBackgroundTasks);
    if (presentation === null || !activeThread) {
      return null;
    }
    return {
      id: `background-work:${activeThread.id}`,
      variant: "default",
      priority: "activity",
      // A dev server can run for hours after the agent is done, so only work that
      // will wake the agent pulses.
      icon: <BackgroundWorkIcon kind={presentation.kind} running={presentation.waiting} />,
      title: (
        <BackgroundWorkLabel
          presentation={presentation}
          onOpenRelatedThread={onOpenRelatedThread}
        />
      ),
      actions: (
        <BackgroundWorkStopButton
          stopping={isStoppingBackgroundWork}
          disabled={!canOperateThread}
          onStop={() => void handleStopBackgroundWork()}
        />
      ),
    };
  }, [
    activeBackgroundTasks,
    activeThread,
    canOperateThread,
    handleStopBackgroundWork,
    isStoppingBackgroundWork,
    onOpenRelatedThread,
  ]);
  // A woken thread announces itself in the open view, not just the sidebar
  // pill. Dismissing marks the wake as seen (same acknowledgment as the
  // pill); sending a message clears it as a side effect of the send path.
  const wokeThreadBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!activeThreadWokeVisible) {
      return null;
    }
    return {
      id: `thread-woke:${activeThread?.id ?? "unknown"}`,
      variant: "info",
      icon: <AlarmClockIcon />,
      title: "Thread woke from snooze",
      description: "Send a message to continue",
      dismissLabel: "Dismiss Woke notification",
      onDismiss: acknowledgeActiveThreadWoke,
    };
  }, [acknowledgeActiveThreadWoke, activeThread?.id, activeThreadWokeVisible]);
  // A computer-use action in this thread is on hold until the user allows a
  // macOS permission; it continues by itself once they do.
  const computerUsePermissionWait = useComputerUsePermissionWait(activeThread?.id);
  const computerUsePermissionBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (computerUsePermissionWait === null) return null;
    const { title } = COMPUTER_USE_PERMISSION_COPY[computerUsePermissionWait];
    return {
      id: `computer-use-permission:${activeThread?.id ?? "unknown"}`,
      variant: "warning",
      priority: "urgent",
      icon: <MonitorIcon />,
      title: `The agent is waiting for ${title}`,
      description: `Allow ${title} for SpecWithCode and its action continues by itself.`,
      children: <ComputerUsePermissionWaitNotice permission={computerUsePermissionWait} />,
    };
  }, [activeThread?.id, computerUsePermissionWait]);
  const retryAfterComputerUsePermission = useCallback(
    (text: string) => void sendStandaloneCommand(text, "Could not ask the agent to try again."),
    [sendStandaloneCommand],
  );
  // Handoff mode: another machine continues this thread, so this copy takes no new turns.
  const handoffSnapshot = useHandoffModeSnapshot(activeThread?.environmentId ?? null).snapshot;
  const handoffMachineName = useMachineNicknames();
  const handoffContinuedOn =
    activeThread === undefined
      ? null
      : (threadHandoffState(handoffSnapshot, activeThread.id)?.continuedOn ?? null);
  const projectedThread = serverProjection?.thread ?? null;
  const threadMoveBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    const banner =
      projectedThread === null || activeThread === undefined
        ? null
        : threadMoveBanner(
            { ...projectedThread, environmentId: activeThread.environmentId },
            (projectId) =>
              allProjects.find(
                (project) =>
                  project.environmentId === activeThread.environmentId && project.id === projectId,
              )?.title,
          );
    if (activeThread === undefined) return null;
    if (banner === null) {
      // Fenced by the heartbeat without a recorded link: the handoff state still names the continuation.
      if (handoffContinuedOn === null) return null;
      const machine = handoffMachineName(
        handoffContinuedOn.environmentId,
        handoffContinuedOn.machineLabel,
      );
      const continuation = scopeThreadRef(
        handoffContinuedOn.environmentId,
        handoffContinuedOn.threadId,
      );
      return {
        id: `${HANDOFF_CONTINUED}${activeThread.id}`,
        variant: "info",
        icon: <FolderInputIcon />,
        title: `Continued on ${machine}`,
        description:
          "This thread handed off. It is read-only here; send new messages in the continuation.",
        actions: (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(continuation),
              })
            }
          >
            Open continuation
          </Button>
        ),
      };
    }
    const linkedRef = scopeThreadRef(banner.target.environmentId, banner.target.threadId);
    // A project move's original is archived, and archived threads open only once restored.
    const open = () =>
      banner.targetArchived && readThreadShell(linkedRef) === null
        ? void navigate({ to: "/settings/archived" })
        : void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(linkedRef),
          });
    return {
      id: banner.id,
      variant: "info",
      icon: <FolderInputIcon />,
      title: banner.title,
      description: banner.description,
      actions: (
        <Button size="xs" variant="ghost" onClick={open}>
          {banner.actionLabel}
        </Button>
      ),
    };
  }, [
    activeThread,
    allProjects,
    handoffContinuedOn,
    handoffMachineName,
    navigate,
    projectedThread,
  ]);
  const settledNote = activeThreadSettled ? (serverProjection?.thread.settledNote ?? null) : null;
  const deliveryBannerItem = useMemo(
    () =>
      lifecycleDeliveryBannerItem(serverProjection, {
        settled: activeThreadSettled,
        nowMs: Date.parse(`${nowMinute}:00Z`),
      }),
    [activeThreadSettled, nowMinute, serverProjection],
  );
  const parkedThreadBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!activeThreadSnoozed && !activeThreadSettled) {
      return null;
    }
    const isSnoozed = activeThreadSnoozed;
    return {
      id: `thread-${isSnoozed ? "snoozed" : "settled"}:${activeThread?.id ?? "unknown"}`,
      variant: "info",
      icon: isSnoozed ? <AlarmClockIcon /> : <CheckCircle2Icon />,
      title: `This thread is ${isSnoozed ? "snoozed" : "resolved"}`,
      description:
        !isSnoozed && settledNote
          ? `${settledNote} Send a message to reopen.`
          : `Send a message to ${isSnoozed ? "wake" : "reopen"}`,
      actions: (
        <Button
          size="xs"
          variant="ghost"
          disabled={!canOperateThread || (isSnoozed ? isUnsnoozing : isUnsettling)}
          onClick={() =>
            void (isSnoozed ? handleUnsnoozeActiveThread() : handleUnsettleActiveThread())
          }
        >
          {isSnoozed
            ? isUnsnoozing
              ? "Waking..."
              : "Wake now"
            : isUnsettling
              ? THREAD_LIFECYCLE_LABELS.reopening
              : THREAD_LIFECYCLE_LABELS.reopen}
        </Button>
      ),
    };
  }, [
    activeThread?.id,
    activeThreadSettled,
    activeThreadSnoozed,
    canOperateThread,
    handleUnsnoozeActiveThread,
    handleUnsettleActiveThread,
    isUnsnoozing,
    isUnsettling,
    settledNote,
  ]);
  // Session-scoped dismissals, one key per (thread, snapshot). A set rather
  // than a single slot so dismissing the banner on one thread does not
  // resurface it on another thread dismissed earlier.
  const [dismissedResumeCompactionKeys, setDismissedResumeCompactionKeys] = useState<
    ReadonlySet<string>
  >(new Set());
  const resumeCompactionKey =
    activeThread && activeContextWindow
      ? `${activeThread.id}:${activeContextWindow.updatedAt}`
      : null;
  const activeThreadHasCompactableConversation = serverVisibleTurnItems.some(
    ({ item }) =>
      item.type === "user_message" &&
      (item.text.trim().toLowerCase() !== "/compact" || item.attachments.length > 0),
  );
  const compactThreadUnavailable =
    !canOperateThread ||
    !activeThread ||
    !activeThreadHasCompactableConversation ||
    !activeProject ||
    !isServerThread ||
    !manualCompactionProviderAvailable ||
    isWorking ||
    isRevertingCheckpoint ||
    threadDetailLoading ||
    isPreparingWorktree ||
    activeEnvironmentUnavailable ||
    feedbackUploading ||
    pendingApprovals.length > 0 ||
    pendingUserInputs.length > 0 ||
    showPlanFollowUpPrompt;
  const compactDisabled = compactThreadUnavailable;
  const compactDisabledReason = compactDisabled
    ? !canOperateThread
      ? "This connection cannot change threads."
      : !activeProject
        ? "Choose a project before compacting"
        : !manualCompactionProviderAvailable
          ? "Compaction is unavailable for this provider"
          : "Compacting is unavailable right now"
    : null;
  const resumeCompactionBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (
      !activeThread ||
      !activeContextWindow ||
      resumeCompactionKey === null ||
      dismissedResumeCompactionKeys.has(resumeCompactionKey) ||
      resumeCompactionPermanentlyDismissed ||
      nativeResumeCompactionDismissed ||
      pendingUserInputs.length > 0 ||
      phase === "running" ||
      !shouldOfferResumeCompaction({
        provider: selectedProvider,
        usedTokens: activeContextWindow.usedTokens,
        updatedAt: activeContextWindow.updatedAt,
        now: `${nowMinute}:00.000Z`,
        settled: serverThreadSettled,
      })
    ) {
      return null;
    }

    const dismiss = () =>
      setDismissedResumeCompactionKeys((keys) => new Set(keys).add(resumeCompactionKey));
    const compactAction = (
      <Button
        size="xs"
        variant="ghost"
        disabled={compactDisabled}
        onClick={() => {
          if (compactDisabled) return;
          composerRef.current?.compactContext();
        }}
      >
        Compact
      </Button>
    );
    return {
      id: `resume-compaction:${resumeCompactionKey}`,
      variant: "info",
      icon: <Minimize2Icon />,
      title: "Resume with less context",
      description: `${formatContextWindowTokens(activeContextWindow.usedTokens)} tokens from earlier`,
      actions: compactDisabledReason ? (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex">{compactAction}</span>} />
          <TooltipPopup side="top">{compactDisabledReason}</TooltipPopup>
        </Tooltip>
      ) : (
        compactAction
      ),
      dismissLabel: "Keep full history",
      onDismiss: dismiss,
    };
  }, [
    activeContextWindow,
    activeThread,
    compactDisabled,
    compactDisabledReason,
    composerRef,
    dismissedResumeCompactionKeys,
    nativeResumeCompactionDismissed,
    nowMinute,
    pendingUserInputs.length,
    phase,
    resumeCompactionKey,
    resumeCompactionPermanentlyDismissed,
    selectedProvider,
    serverThreadSettled,
  ]);
  const handleRestoreThreadBranch = useCallback(() => {
    if (!canWriteSourceControl) return;
    if (gitStatusQuery.data?.hasWorkingTreeChanges) {
      setBranchRestoreConfirmOpen(true);
      return;
    }
    void handleSwitchCheckoutToThread();
  }, [
    canWriteSourceControl,
    gitStatusQuery.data?.hasWorkingTreeChanges,
    handleSwitchCheckoutToThread,
  ]);
  const feedbackBannerItems = useMemo(
    () =>
      feedbackSubmissions.flatMap((submission) => {
        const item = feedbackBannerItem(submission, () => {
          setFeedbackSubmissionsByThreadKey((current) => ({
            ...current,
            [routeThreadKey]: (current[routeThreadKey] ?? []).filter(
              (entry) => entry.id !== submission.id,
            ),
          }));
        });
        return item ? [item] : [];
      }),
    [feedbackSubmissions, routeThreadKey, setFeedbackSubmissionsByThreadKey],
  );
  // The provider the stopped thread can continue on: the project's fallback,
  // its default model, or any other ready provider.
  const limitFallbackSelection =
    serverRuntime?.status === "failed" &&
    serverRuntime.lastErrorClass === "usage_limit" &&
    activeThreadShell &&
    resumableRunId !== null &&
    supportsProviderSwitchingViaHandoff &&
    activeProjectSettings.settings.providerLimitAction !== "wait"
      ? resolveProviderFallback({
          providers: providerStatuses,
          currentInstanceId: activeThreadShell.providerInstanceId,
          currentModel: activeThreadShell.modelSelection.model,
          currentOptions: activeThreadShell.modelSelection.options,
          rule: activeProjectSettings.settings,
          nowMs: renderNowMs,
          belowPercent: 100,
          anyReady: true,
          proven: provenFallbackSelection(activeThreadShell, activeCoordinatorShell),
        })
      : null;
  // The rest of the user's fallback order for the banner's menu, each with
  // the reason it cannot take the thread now. A person may pick one whose
  // usage was not read: the start's own admission check still applies.
  const limitFallbackOrder =
    serverRuntime?.status === "failed" &&
    serverRuntime.lastErrorClass === "usage_limit" &&
    activeThreadShell &&
    resumableRunId !== null &&
    supportsProviderSwitchingViaHandoff
      ? describeFallbackOrder({
          providers: providerStatuses,
          currentInstanceId: activeThreadShell.providerInstanceId,
          rule: activeProjectSettings.settings,
          nowMs: renderNowMs,
          belowPercent: 100,
        })
      : [];
  const limitFallbackProvider =
    limitFallbackSelection === null
      ? undefined
      : providerStatuses.find(
          (provider) => provider.instanceId === limitFallbackSelection.instanceId,
        );
  // A thread the provider never answered resends its request on the fallback.
  const limitRestart =
    serverProjection !== null && resumableRunId !== null
      ? limitRestartRequest({
          threadId: serverProjection.thread.id,
          runId: resumableRunId,
          runs: serverProjection.runs,
          providerThreads: serverProjection.providerThreads,
          turnItems: serverProjection.turnItems,
        })
      : null;
  const limitRule = activeProjectSettings.settings;
  const limitStopped =
    serverRuntime?.status === "failed" && serverRuntime.lastErrorClass === "usage_limit";
  // The reset is within the project's wait and the rule would otherwise act by
  // itself: the server holds the switch and resumes the thread at the reset.
  const limitWaiting =
    limitStopped &&
    limitRule.providerLimitAction !== "wait" &&
    (limitRule.providerLimitAction === "switch" ||
      limitRule.providerLimitRedeemResets ||
      limitRule.providerLimitSpendCredits ||
      limitRule.providerLimitUseApiCredits) &&
    limitStopWaitsForReset({
      resetAt: serverRuntime?.usageLimitResetAt,
      waitUnderMinutes: limitRule.providerLimitWaitUnderMinutes,
      nowMs: renderNowMs,
    });
  // Another device of this project whose own provider has room: the thread
  // can start over there from a written handoff.
  const limitDeviceTarget = (() => {
    if (!limitStopped || !activeThreadShell || !activeThread) return null;
    const currentDriver =
      providerStatuses.find(
        (provider) => provider.instanceId === activeThreadShell.providerInstanceId,
      )?.driver ?? null;
    for (const candidate of logicalProjectEnvironments) {
      if (candidate.environmentId === environmentId || candidate.projectId === null) continue;
      const environment = environmentById.get(candidate.environmentId);
      if (
        environment?.connection.phase !== "connected" ||
        !readEnvironmentScope(candidate.environmentId, AuthOrchestrationOperateScope)
      )
        continue;
      const providers = environment.serverConfig?.providers ?? [];
      const selection = pickDeviceModel({
        providers,
        current: activeThreadShell.modelSelection,
        currentDriver,
        belowPercent: limitRule.providerLimitSwitchAtPercent,
        nowMs: renderNowMs,
      });
      if (selection === null) continue;
      const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
      return {
        environmentId: candidate.environmentId,
        projectId: candidate.projectId,
        label: candidate.label,
        selection,
        model:
          provider?.models.find((model) => model.slug === selection.model)?.name ?? selection.model,
      };
    }
    return null;
  })();
  return {
    acknowledgeActiveThreadWoke,
    activatePanelTerminal,
    activateRightPanelSurface,
    activeBranchMismatchKey,
    activeGoal,
    activeProjectRepository,
    activeRunningTurnId,
    activeThreadBranch,
    activeThreadPinned,
    activeThreadSettled,
    activeTimelineAnchorIndexRef,
    addDeviceSurface,
    addDiffSurface,
    addFilesSurface,
    addPullRequestSurface,
    addPullRequestsSurface,
    addTerminalContextToDraft,
    addTerminalSurface,
    anchorUserScrollGenerationRef,
    appCommandsOffered,
    autoEnvironmentLabel,
    backgroundWorkBannerItem,
    beginEditingQueuedRun,
    branchRestoreConfirmOpen,
    canInterruptRunningThread,
    canOperatePreview,
    canOverrideServerThreadEnvMode,
    cancelEditingQueuedRun,
    cancelPositionRestoreRef,
    cancelTimelineLiveFollowForUserNavigation,
    closeAllRightPanelSurfaces,
    closeExpandedImage,
    closeOtherRightPanelSurfaces,
    closePanelTerminal,
    closePreviewPanel,
    closeRightPanelSurface,
    closeRightPanelSurfacesToRight,
    compactDisabled,
    compactDisabledReason,
    compactThreadUnavailable,
    composerEditingQueuedAttachments,
    copyActiveThreadReference,
    copyRightPanelFilePath,
    createBrowserSurface,
    createNewTerminal,
    deleteProjectScript,
    deviceSetupThread,
    deviceState,
    draftMachinePendingRef,
    editQueuedRunCommand,
    envMode,
    environmentChangeRef,
    feedbackBannerItems,
    focusComposer,
    goalBannerItem,
    handleInteractionModeChange,
    handleRestoreThreadBranch,
    handleRuntimeModeChange,
    handleSwitchCheckoutToThread,
    handleUnsettleActiveThread,
    isEnvironmentChanging,
    isRestoringThreadBranch,
    isSavingQueuedEdit,
    limitDeviceTarget,
    limitFallbackOrder,
    limitFallbackProvider,
    limitFallbackSelection,
    limitRestart,
    limitRule,
    limitStopped,
    limitWaiting,
    linkedThreadPullRequest,
    liveFollowUserScrollGenerationRef,
    loadBalancing,
    localCheckoutBranchMismatch,
    onAutoEnvironment,
    onComposerPageScrollKeyDown,
    onComposerPageScrollKeyUp,
    onComposerPageScrollRelease,
    onComposerRestingChange,
    onDraftMachinePendingChange,
    onEnvironmentChange,
    onInterrupt,
    onIsAtEndChange,
    onOpenRelatedThread,
    onTimelineAnchorReady,
    onTimelineAnchorSizeChanged,
    onToolOutputCollapsedAtEnd,
    openChangesFromThreadPanel,
    openFileSurface,
    openProviderSetup,
    deliveryBannerItem,
    parkedThreadBannerItem,
    threadMoveBannerItem,
    pendingTimelineAnchorRef,
    persistThreadSettingsForNextTurn,
    publishComposerOverlayHeight,
    pullRequestSurfaceAvailable,
    pullRequestsSurfaceAvailable,
    queuedEditSaveInFlightRef,
    queuedRunsControlRef,
    removeEditingQueuedAttachment,
    requestClosePanelTerminal,
    requestCloseTerminal,
    resumeCompactionBannerItem,
    resumeForAppCommandRef,
    runAppCommand,
    runProjectScript,
    saveProjectScript,
    scheduleComposerFocus,
    scrollToEnd,
    sendEnvMode,
    sendStandaloneCommand,
    shellRunTarget,
    setBranchMismatchDismissTick,
    setBranchRestoreConfirmOpen,
    setDeviceSetupThread,
    setIsSavingQueuedEdit,
    setTerminalOpen,
    setThreadError,
    setTimelineLiveFollowEnabled,
    showBranchMismatchBanner,
    showScrollDebouncer,
    splitPanelTerminal,
    splitPanelTerminalVertical,
    splitTerminal,
    startFromOrigin,
    supportsPinning,
    supportsSettlement,
    threadOrigin,
    timelineLiveFollowEnabled,
    timelineScrollModeRef,
    toggleInteractionMode,
    toggleRightPanel,
    toggleRightPanelMaximized,
    toggleTerminalVisibility,
    toggleThreadPanel,
    updateProjectScript,
    useArtifactTemplate,
    visiblePullRequestCount,
    visiblePullRequests,
    wokeThreadBannerItem,
    computerUsePermissionBannerItem,
    retryAfterComputerUsePermission,
  };
}

export default function ChatView(props: ChatViewProps) {
  const renderNowMs = useRenderTime();
  const chatViewState = useChatViewState(props);
  const {
    activeProjectIsScratch,
    continueElsewhereRef,
    continueElsewhereTarget,
    openScratchProject,
    activeActivityRun,
    activeComposerTaskSteps,
    activeComposerTasksProgress,
    activeContextWindow,
    activeCoordinatorShell,
    activeDraftLogicalProjectKey,
    activeEnvironmentConnectionPhase,
    activeEnvironmentIsThisMachine,
    activeEnvironmentServerBrowser,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    activeEnvironmentUnavailableState,
    activeMessageCount,
    activePendingApproval,
    activePendingDraftAnswers,
    activePendingIsResponding,
    activePendingProgress,
    activePendingQuestionIndex,
    activePendingRequestKey,
    activePendingResolvedAnswers,
    activePendingUserInput,
    activePreviewMiniPlayer,
    activePreviewState,
    activeProject,
    activeProjectCwd,
    activeProjectDefaultModelSelection,
    activeProjectScripts,
    activeProjectSettings,
    activeProjectTarget,
    activeProposedPlan,
    activeProviderStatus,
    activeRightPanelSurface,
    activeRuntime,
    activeTerminalLabelsById,
    activeTerminalLaunchContext,
    activeThread,
    activeThreadId,
    activeThreadKey,
    activeThreadShell,
    activeThreadTarget,
    activeThreadWorktreePath,
    activeWorkStartedAt,
    activeWorkspaceRoot,
    addComposerDraftFiles,
    addComposerDraftImages,
    allProjects,
    attachmentUploadsCapabilityKnown,
    availableEditors,
    backgroundSubmissionPending,
    beginLocalDispatch,
    branchToolbarRef,
    browserAvailable,
    canAutoBalanceEnvironments,
    canCheckoutPullRequestIntoThread,
    canOperateTerminal,
    canOperateThread,
    canReadTerminal,
    canWriteSourceControl,
    cancelWorktreeSetup,
    captureDraftHeroComposerRect,
    citationRequest,
    citeAssistantText,
    clearComposerDraftContent,
    clearUsageLimitsFor,
    clientSettingsHydrated,
    closePullRequestDialog,
    closeTerminalShortcutLabel,
    collapseLongReports,
    composerDraftTarget,
    composerFilesRef,
    composerHasNonPromptContent,
    composerImagesRef,
    composerMounted,
    composerOverlayElement,
    composerRef,
    composerSendGenerationRef,
    composerTerminalContextsRef,
    composerTimelineInset,
    configuredPreviewUrls,
    confirmAndUnpinThread,
    createAttachmentAssetUrl,
    createThread,
    currentRouteThreadKeyRef,
    defaultRuntimeMode,
    deleteThread,
    diffOpen,
    dismissThreadUserInput,
    dismissedUsageApproaching,
    displayedThreadTarget,
    displayedTimeline,
    displayedTimelineKey,
    downloadFileAttachment,
    draftHeroComposerAnchorRef,
    draftHeroTransitionGroupRef,
    draftId,
    draftThread,
    editingQueuedRun,
    embeddedHeaderToolsTarget,
    envLocked,
    environmentById,
    environmentId,
    environmentUnavailableSendToastSlotRef,
    expandedImage,
    explicitDiffOpenRef,
    feedbackUploading,
    feedbackUploadsInFlightRef,
    forceExpandedMobileComposer,
    forkThreadFromRun,
    getTimelineScrollableNode,
    gitCwd,
    handleFilePendingChange,
    handleNewThreadInActiveProject,
    handleOpenDraftProjectSettings,
    handlePreparedPullRequestThread,
    hasHeldQueuedRuns,
    hasMultipleEnvironments,
    hasTimelineTopBanner,
    heldPaintContext,
    inlineRightPanelOwnsTitleBar,
    interactionMode,
    isAtEndRef,
    isCompacting,
    isConnecting,
    isDraftHeroState,
    isGitRepo,
    isLocalDraftThread,
    isPreparingWorktree,
    isResuming,
    isRevertingCheckpoint,
    isSendBusy,
    isServerThread,
    isTimelineAtLogicalEnd,
    isWorking,
    isWorkspaceFileDragActive,
    keybindings,
    lastInvokedScriptByProjectId,
    latestRunSettled,
    layoutMode,
    legendListRef,
    loadBalancingSettings,
    localServerError,
    lockedProvider,
    logicalProjectEnvironments,
    maxFileAttachmentBytes,
    modelPickerLockedProvider,
    mountComposerContextStrip,
    mountComposerModelStrip,
    mountedTerminalThreadRefs,
    multipleModelSelections,
    multipleModelSelectionsRef,
    navigate,
    needsLoadBalancing,
    newTerminalShortcutLabel,
    onCancelWorktreeSetup,
    onDiffPanelOpen,
    onOpenWorktreeSetupTerminal,
    onRetryWorkspacePreparation,
    onToggleDiff,
    openCoordinatorHandoff,
    openFileAttachment,
    openNewChatDestination,
    openPullRequestDialog,
    openThreadChangeRequest,
    openThreadLink,
    openThreadPath,
    openThreadRoute,
    openUsageLimits,
    optimisticUserMessages,
    paintOnlyDisplayedTimeline,
    panelAnimationDurationMs,
    panelAnimationsActive,
    parentThreadLink,
    pasteAsTextShortcutUntilRef,
    pendingApprovals,
    pendingFileSurfaceIds,
    pendingUserInputAnswersByRequestId,
    pendingUserInputs,
    phase,
    pinThread,
    previewMiniPlayerVisible,
    previewPanelInlineSize,
    previewPanelOpen,
    projectCloneBannerItem,
    projectCloneSendBlockReason,
    projectDraftSendGuard,
    projectRouting,
    promptRef,
    providerInstanceEntries,
    providerStatusBannerKey,
    providerStatuses,
    providerSubagentEffortLabel,
    providerSubagentModelLabel,
    providerSubagentStatus,
    providerSubagentStep,
    pullRequestDialogState,
    pullRequestsCapabilityKnown,
    queuedEditDraftTargetFor,
    renderedRightPanelSurface,
    renderedRightPanelSurfaces,
    reportedModelSelection,
    reserveTitleBarControlInset,
    resetLocalDispatch,
    resolvePreviewRuntimeTabId,
    resolvedTheme,
    respondToThreadApproval,
    respondToThreadUserInput,
    respondingRequestIds,
    respondingUserInputRequestIds,
    restingComposerControlsHost,
    resumableRunId,
    resumeThreadQueue,
    retryableWorkspacePreparationRunIds,
    revertThreadCheckpoint,
    reviewOnly,
    rightPanelControlsAtRoot,
    rightPanelControlsInPanel,
    rightPanelMaximized,
    rightPanelOpen,
    rightPanelPresent,
    routeKind,
    routeThreadKey,
    routeThreadTarget,
    runlessWorkStartedAt,
    runtimeMode,
    scriptKeybindings,
    scrollToEndClearance,
    selectedProviderEntry,
    sendInFlightRef,
    serverConfig,
    serverProjection,
    timelineSubagentParent,
    serverRuntime,
    serverRuntimeError,
    serverThreadSettled,
    setComposerDraftInteractionMode,
    setComposerDraftModelSelection,
    setComposerDraftPreviewAnnotations,
    setComposerDraftPrompt,
    setComposerDraftReviewComments,
    setComposerDraftTerminalContexts,
    setComposerDraftThreadContexts,
    setComposerOverlayElement,
    setDismissedProviderStatusBannerKey,
    setDismissedUsageApproaching,
    setDockedDraftHeroThreadKey,
    setDraftThreadContext,
    setEditingQueuedRun,
    setExpandedImage,
    setFeedbackSubmissionsByThreadKey,
    setIsWorkspaceFileDragActive,
    setMultipleModelSelections,
    setOptimisticUserMessages,
    setPendingServerThreadBranch,
    setPendingServerThreadEnvMode,
    setPendingServerThreadStartFromOriginByThreadId,
    setPendingUserInputAnswersByRequestId,
    setPendingUserInputQuestionIndexByRequestId,
    setRespondingRequestIds,
    setRespondingUserInputRequestIds,
    setRestingComposerControlsHost,
    setRestingComposerControlsVisible,
    setResumingThreadKeys,
    setShowScrollToBottom,
    setStickyComposerModelSelection,
    setTerminalFocusRequestId,
    setTerminalUiLaunchContext,
    setThreadErrorBannerDismissTick,
    setThreadPanelPresentation,
    setTimelineAnchor,
    setTimelineOverflows,
    setWorkLocallyResendDraftId,
    setWorktreeSetupThread,
    settings,
    settleThread,
    setupTarget,
    shouldUsePlanSidebarSheet,
    showComposerContextStrip,
    showComposerEnvironmentIndicator,
    showComposerModelStrip,
    showOpenInPicker,
    showPlanFollowUpPrompt,
    showProviderSubagentBar,
    showScrollToBottom,
    splitTerminalShortcutLabel,
    splitTerminalVerticalShortcutLabel,
    startThreadTurn,
    supportsAttachmentUploads,
    supportsConversationRollback,
    supportsProviderSwitchingViaHandoff,
    supportsPullRequests,
    supportsQuestionAttachments,
    suspendChatInput,
    systemComposerBannerItems,
    terminalFocusRequestId,
    terminalUiOpenByThreadRef,
    terminalUiState,
    threadDetailLoading,
    threadErrorBannerKey,
    threadHistoryControls,
    threadId,
    threadIncrementActions,
    threadPanelOpen,
    threadPanelPopoverAnchorRef,
    threadPanelPopoverHandle,
    threadPanelPresentation,
    threadPlanStatus,
    threadPlanView,
    threadPullRequests,
    threadSyncPhase,
    timelineAnchorMessageId,
    timelineBannerOverlayHeight,
    timelineBannerOverlayRef,
    timelineMessages,
    timelineOverflows,
    timelineRunHealth,
    timelineActiveHost,
    timelineThreadError,
    timelineWorkingFolder,
    timestampFormat,
    transcriptOnly,
    turnDiffSummaries,
    uncertainMultipleSubmissionsRef,
    updateThreadMetadata,
    uploadThreadFeedback,
    usageLimitsBanner,
    usageLimitsKey,
    usageLimitsOffered,
    userInputResponsesInFlight,
    visibleProviderStatus,
    visibleThreadError,
    workLocallyResendDraftId,
    workspaceLayoutRef,
    workspaceMutationId,
    worktreeSetup,
    worktreeSetupBlocksSend,
    worktreeSetupOwnerKey,
  } = chatViewState;
  const pendingUserInputIds = useMemo<ReadonlyArray<string>>(
    () => pendingUserInputs.map((input) => input.requestId),
    [pendingUserInputs],
  );
  // Read to a screen reader when an answer is sent or a question settles.
  const [answerAnnouncement, announceAnswer] = useLiveAnnouncement();
  const answerSettle = useQuestionSettleAnnouncements(
    serverProjection === null || !activeThreadId ? null : `${environmentId}:${activeThreadId}`,
    pendingUserInputIds,
    announceAnswer,
  );
  // Why an answer was not sent, shown beside the composer.
  const [answerProblem, setAnswerProblem] = useState<AnswerProblem | null>(null);
  const shownAnswerProblem = answerProblemText(answerProblem, activeThreadId, pendingUserInputIds);
  // A settled question's reason must not come back once a newer question has come and gone.
  useEffect(() => {
    if (!isAnswerProblemOutdated(answerProblem, activeThreadId, pendingUserInputIds)) return;
    // Only this reason: one set since by a send's result stays.
    setAnswerProblem((current) => (current === answerProblem ? null : current));
  }, [activeThreadId, answerProblem, pendingUserInputIds]);
  const dismissAnswerProblem = useCallback(() => setAnswerProblem(null), []);
  const clearThreadAnswerProblem = useCallback(
    (threadId: string) =>
      setAnswerProblem((problem) => (problem?.threadId === threadId ? null : problem)),
    [],
  );
  const serverProjectionRef = useLatestRef(serverProjection);
  const pendingUserInputIdsRef = useLatestRef(pendingUserInputIds);
  const activeThreadIdRef = useLatestRef(activeThreadId);
  // True when the reason is kept. A settled question's reason is judged against
  // the requests waiting when the answer was sent: any other is newer, and
  // sending the box now would answer it, so the reason is dropped.
  const showSendProblem = useCallback(
    (
      threadId: string,
      requestId: string,
      problem: QuestionSendProblem,
      waitingAtSend: ReadonlyArray<string> = pendingUserInputIdsRef.current,
    ) => {
      const next = settledSendReason({
        threadId,
        requestId,
        problem,
        waitingAtSend,
        activeThreadId: activeThreadIdRef.current,
        pendingRequestIds: pendingUserInputIdsRef.current,
      });
      if (next === null) return false;
      setAnswerProblem(next);
      return true;
    },
    [activeThreadIdRef, pendingUserInputIdsRef],
  );
  // The held queue above the composer and the queue in it share one reason.
  const queuedActionsUnavailableReason = queuedRunActionsUnavailableReason({
    canOperateThread,
    environmentUnavailable: activeEnvironmentUnavailable,
    environmentLabel: activeEnvironmentUnavailableLabel,
    isThisMachineCatchingUp:
      activeEnvironmentIsThisMachine && isThisMachineCatchingUp(activeEnvironmentConnectionPhase),
  });
  // The same rule that files the thread under Blocked, so the two never disagree.
  const activeThreadBlocker = activeThreadShell ? threadBlocker(activeThreadShell) : null;
  const {
    acknowledgeActiveThreadWoke,
    activatePanelTerminal,
    activateRightPanelSurface,
    activeBranchMismatchKey,
    activeGoal,
    activeProjectRepository,
    activeRunningTurnId,
    activeThreadBranch,
    activeThreadPinned,
    activeThreadSettled,
    activeTimelineAnchorIndexRef,
    addDeviceSurface,
    addDiffSurface,
    addFilesSurface,
    addPullRequestSurface,
    addPullRequestsSurface,
    addTerminalContextToDraft,
    addTerminalSurface,
    anchorUserScrollGenerationRef,
    appCommandsOffered,
    autoEnvironmentLabel,
    backgroundWorkBannerItem,
    beginEditingQueuedRun,
    branchRestoreConfirmOpen,
    canInterruptRunningThread,
    canOperatePreview,
    canOverrideServerThreadEnvMode,
    cancelEditingQueuedRun,
    cancelPositionRestoreRef,
    cancelTimelineLiveFollowForUserNavigation,
    closeAllRightPanelSurfaces,
    closeExpandedImage,
    closeOtherRightPanelSurfaces,
    closePanelTerminal,
    closePreviewPanel,
    closeRightPanelSurface,
    closeRightPanelSurfacesToRight,
    compactDisabled,
    compactDisabledReason,
    compactThreadUnavailable,
    composerEditingQueuedAttachments,
    copyActiveThreadReference,
    copyRightPanelFilePath,
    createBrowserSurface,
    createNewTerminal,
    deleteProjectScript,
    deviceSetupThread,
    deviceState,
    draftMachinePendingRef,
    editQueuedRunCommand,
    envMode,
    environmentChangeRef,
    feedbackBannerItems,
    focusComposer,
    goalBannerItem,
    handleInteractionModeChange,
    handleRestoreThreadBranch,
    handleRuntimeModeChange,
    handleSwitchCheckoutToThread,
    handleUnsettleActiveThread,
    isEnvironmentChanging,
    isRestoringThreadBranch,
    isSavingQueuedEdit,
    limitDeviceTarget,
    limitFallbackOrder,
    limitFallbackProvider,
    limitFallbackSelection,
    limitRestart,
    limitRule,
    limitStopped,
    limitWaiting,
    linkedThreadPullRequest,
    liveFollowUserScrollGenerationRef,
    loadBalancing,
    localCheckoutBranchMismatch,
    onAutoEnvironment,
    onComposerPageScrollKeyDown,
    onComposerPageScrollKeyUp,
    onComposerPageScrollRelease,
    onComposerRestingChange,
    onDraftMachinePendingChange,
    onEnvironmentChange,
    onInterrupt,
    onIsAtEndChange,
    onOpenRelatedThread,
    onTimelineAnchorReady,
    onTimelineAnchorSizeChanged,
    onToolOutputCollapsedAtEnd,
    openChangesFromThreadPanel,
    openFileSurface,
    openProviderSetup,
    deliveryBannerItem,
    parkedThreadBannerItem,
    threadMoveBannerItem,
    pendingTimelineAnchorRef,
    persistThreadSettingsForNextTurn,
    publishComposerOverlayHeight,
    pullRequestSurfaceAvailable,
    pullRequestsSurfaceAvailable,
    queuedEditSaveInFlightRef,
    queuedRunsControlRef,
    removeEditingQueuedAttachment,
    requestClosePanelTerminal,
    requestCloseTerminal,
    resumeCompactionBannerItem,
    resumeForAppCommandRef,
    runAppCommand,
    runProjectScript,
    saveProjectScript,
    scheduleComposerFocus,
    scrollToEnd,
    sendEnvMode,
    sendStandaloneCommand,
    shellRunTarget,
    setBranchMismatchDismissTick,
    setBranchRestoreConfirmOpen,
    setDeviceSetupThread,
    setIsSavingQueuedEdit,
    setTerminalOpen,
    setThreadError,
    setTimelineLiveFollowEnabled,
    showBranchMismatchBanner,
    showScrollDebouncer,
    splitPanelTerminal,
    splitPanelTerminalVertical,
    splitTerminal,
    startFromOrigin,
    supportsPinning,
    supportsSettlement,
    threadOrigin,
    timelineLiveFollowEnabled,
    timelineScrollModeRef,
    toggleInteractionMode,
    toggleRightPanel,
    toggleRightPanelMaximized,
    toggleTerminalVisibility,
    toggleThreadPanel,
    updateProjectScript,
    useArtifactTemplate,
    visiblePullRequestCount,
    visiblePullRequests,
    wokeThreadBannerItem,
    computerUsePermissionBannerItem,
    retryAfterComputerUsePermission,
  } = useChatViewActions(props, chatViewState);
  const contextLimitRecovery = useMemo(() => {
    const failedRun = serverProjection?.runs.find((run) => run.id === activeActivityRun?.runId);
    const failureItemId = failedRun
      ? (latestRootProviderFailureItem(failedRun, serverProjection!.turnItems)?.id ?? null)
      : null;
    return canOperateThread && isServerThread && activeProject && !suspendChatInput
      ? {
          failureItemId,
          ...(providerSupportsManualCompaction(selectedProviderEntry)
            ? {
                onCompactContext: () => {
                  if (!compactDisabled) composerRef.current?.compactContext();
                },
                compactDisabledReason,
              }
            : {}),
          onNewThread: handleNewThreadInActiveProject,
        }
      : undefined;
  }, [
    canOperateThread,
    suspendChatInput,
    serverProjection,
    activeActivityRun?.runId,
    isServerThread,
    activeProject,
    selectedProviderEntry,
    compactDisabled,
    compactDisabledReason,
    handleNewThreadInActiveProject,
  ]);
  // The ways out of the latest failed turn, kept on its timeline row however
  // old it is: Continue where it stopped, or pick another model for the next
  // message. Both reuse the composer's own resume and picker.
  const continueBusy =
    isSendBusy || isResuming || isConnecting || threadDetailLoading || isRevertingCheckpoint;
  // Only the failed latest run's root failure owns recovery actions; a failed
  // item inside a turn that went on, or in an older run, does not. Its code
  // also names the banner for viewers who can't act on it.
  const latestFailureItem = useMemo(() => {
    const failedRun = serverProjection?.runs.find(
      (run) => run.id === activeActivityRun?.runId && run.status === "failed",
    );
    return failedRun ? latestRootProviderFailureItem(failedRun, serverProjection!.turnItems) : null;
  }, [serverProjection, activeActivityRun?.runId]);
  const failureRecovery = useMemo(() => {
    if (!canOperateThread || !isServerThread || suspendChatInput || !composerMounted) {
      return undefined;
    }
    const failureItem = latestFailureItem;
    return {
      failureItemId: failureItem?.id ?? null,
      failureCode: failureItem?.failure.code ?? null,
      continueRunId: resumableRunId,
      onContinue: () => resumeForAppCommandRef.current(),
      continueBusy,
      onSwitchModel: () => composerRef.current?.openModelPicker(),
    };
  }, [
    canOperateThread,
    isServerThread,
    suspendChatInput,
    composerMounted,
    latestFailureItem,
    resumableRunId,
    resumeForAppCommandRef,
    continueBusy,
    composerRef,
  ]);
  const resolveActiveThread = useMemo(
    () =>
      supportsSettlement && activeThreadTarget ? () => settleThread(activeThreadTarget) : null,
    [supportsSettlement, activeThreadTarget, settleThread],
  );
  // Like the composer's Resume: queued requests keep their own model.
  const resumeHeldQueueForRecovery = useCallback(
    (threadId: ThreadId) =>
      resumeQueueWithProjectModel(
        projectRouting,
        undefined,
        () =>
          appAtomRegistry.get(
            environmentThreadDetails.threadAtom(scopeThreadRef(environmentId, threadId)),
          )?.projection.runs ?? null,
        () => resumeThreadQueue({ environmentId, input: { threadId } }),
      ),
    [projectRouting, environmentId, resumeThreadQueue],
  );
  // A deleted thread folder replaces Continue and Switch model with its own repairs.
  const workspaceMissingRecovery = useWorkspaceMissingRecovery({
    environmentId,
    threadId: activeThread?.id ?? null,
    failureItemId: failureRecovery?.failureItemId ?? null,
    failureCode: failureRecovery?.failureCode ?? null,
    worktreePath: activeThread?.worktreePath ?? null,
    branch: activeThread?.branch ?? null,
    projectFolder: activeProject?.workspaceRoot ?? null,
    enabled: failureRecovery !== undefined,
    canWriteSourceControl,
    resolveThread: resolveActiveThread,
    resumeHeldQueue: resumeHeldQueueForRecovery,
  });
  const timelineFailureRecovery = useMemo(
    () =>
      failureRecovery && workspaceMissingRecovery
        ? { ...failureRecovery, workspaceMissing: workspaceMissingRecovery }
        : failureRecovery,
    [failureRecovery, workspaceMissingRecovery],
  );
  // Starts the thread over on another machine from a written handoff: when
  // this one's provider hit its limit, or this machine can't be reached. A
  // chat without a project gets a new chat folder there, never a worktree.
  const continueOnDevice = async (
    target: ContinueTarget,
    reason: "usage_limit" | "unreachable" = "usage_limit",
  ) => {
    if (!activeThread) return;
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const title = activeThread.title;
    const sourceLabel = environmentById.get(environmentId)?.label ?? "another device";
    const chatFolder = activeProjectIsScratch;
    const projectId = chatFolder
      ? ((await openScratchProject(target.environmentId, `Could not continue on ${target.label}`))
          ?.id ?? null)
      : target.projectId;
    if (projectId === null) return;
    const branch = chatFolder ? null : activeThreadBranch;
    const targetProject = allProjects.find(
      (project) => project.environmentId === target.environmentId && project.id === projectId,
    );
    const text = deviceHandoffText({
      title,
      sourceLabel,
      branch,
      turnItems: serverProjection?.turnItems ?? [],
      reason,
      chatFolder,
    });
    if (
      !chatFolder &&
      (await coordinatorDeviceHandoff(
        openCoordinatorHandoff,
        { ...target, projectId },
        text,
        branch,
      ))
    )
      return;
    const result = await startThreadTurn({
      environmentId: target.environmentId,
      input: {
        threadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        modelSelection: target.selection,
        titleSeed: title,
        runtimeMode,
        interactionMode,
        bootstrap: {
          createThread: {
            projectId,
            title,
            modelSelection: target.selection,
            runtimeMode,
            interactionMode,
            branch,
            worktreePath: null,
            createdAt,
          },
          ...(branch && targetProject
            ? {
                prepareWorktree: {
                  projectCwd: targetProject.workspaceRoot,
                  baseBranch: branch,
                  requireWorktree: true,
                  startFromOrigin: true,
                },
                runSetupScript: true,
              }
            : {}),
        },
        createdAt,
      },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    if (reason === "unreachable")
      recordChatContinuation(
        {
          environmentId: activeThread.environmentId,
          threadId: activeThread.id,
          label: sourceLabel,
          title,
        },
        { environmentId: target.environmentId, threadId, label: target.label },
      );
    await openThreadRoute(scopeThreadRef(target.environmentId, threadId));
  };
  useEffect(() => {
    continueElsewhereRef.current = (target) => continueOnDevice(target, "unreachable");
  });
  const creditRecoveryContext: CreditSendContext | null =
    activeThread && activeThreadShell
      ? {
          environmentId,
          projectId: activeThread.projectId,
          threadId: activeThread.id,
          draftId: null,
          runtimeMode,
          selection: activeThreadShell.modelSelection,
          allowed:
            canOperateThread &&
            !routesViaCoordinator(projectRouting) &&
            !activeEnvironmentUnavailable &&
            !activeGoal &&
            !hasHeldQueuedRuns &&
            !activePendingApproval &&
            pendingUserInputs.length === 0 &&
            !isRevertingCheckpoint &&
            !threadDetailLoading &&
            editingQueuedRun === null,
        }
      : null;
  const creditRecoveryContextRef = useLatestRef(creditRecoveryContext);
  const continueLimitedOn = async (selection: ModelSelection) => {
    // The composer follows the thread to the provider it now runs on.
    if (projectRouting?.saveCoordinatorModel) await projectRouting.saveCoordinatorModel(selection);
    else onProviderModelSelect(selection.instanceId, selection.model, { focusComposer: false });
    await onResume(selection, limitRestart ?? undefined);
  };
  const limitFallbackChoices: ReadonlyArray<FallbackChoice> = limitFallbackOrder.flatMap(
    (entry) => {
      if (
        entry.unavailable === "current" ||
        (limitFallbackSelection !== null &&
          entry.selection.instanceId === limitFallbackSelection.instanceId &&
          entry.selection.model === limitFallbackSelection.model)
      )
        return [];
      const label = entry.provider
        ? resolveProviderInstanceDisplayName(entry.provider)
        : entry.selection.instanceId;
      const model =
        entry.provider?.models.find((candidate) => candidate.slug === entry.selection.model)
          ?.name ?? entry.selection.model;
      const choosable = canSelectManualFallback(entry);
      const reason = fallbackUnavailableReason(entry.unavailable, entry.resetAt, choosable);
      return [
        {
          label,
          model,
          ...(reason ? { unavailable: reason } : {}),
          ...(choosable ? { onContinue: () => continueLimitedOn(entry.selection) } : {}),
        },
      ];
    },
  );
  const limitRecoveryBanner = useBannerItem(
    usageLimitRecoveryBannerItem,
    limitStopped && activeThreadShell?.latestRun
      ? {
          canCheck: providerStatuses.some(
            (provider) =>
              provider.instanceId === activeThreadShell.providerInstanceId &&
              provider.driver === "codex",
          ),
          credits: (() => {
            const provider = providerStatuses.find(
              (p) => p.instanceId === activeThreadShell.providerInstanceId,
            );
            if (
              !activeThread ||
              provider?.driver !== "codex" ||
              provider.usageLimits?.credits?.hasCredits !== true ||
              routesViaCoordinator(projectRouting)
            )
              return null;
            return {
              provider,
              context: creditRecoveryContext!,
              onContinue: async (intent: ManualCodexCreditIntent) => {
                await onResume(activeThreadShell.modelSelection, limitRestart ?? undefined, intent);
              },
            };
          })(),
          creditsExhausted: isApiCreditExhaustedMessage(serverRuntime?.lastError),
          apiCredits: (() => {
            const current = providerStatuses.find(
              (p) => p.instanceId === activeThreadShell.providerInstanceId,
            );
            if (!activeThread || current === undefined) return null;
            const targets = resolveApiCreditSelections({
              providers: providerStatuses,
              current: activeThreadShell.modelSelection,
            }).flatMap((selection) => {
              const target = providerStatuses.find(
                (provider) => provider.instanceId === selection.instanceId,
              );
              if (target === undefined) return [];
              return [
                {
                  label: resolveProviderInstanceDisplayName(target),
                  model:
                    target.models.find((model) => model.slug === selection.model)?.name ??
                    selection.model,
                  onContinue: async () => {
                    // The composer follows the thread onto the API account.
                    if (projectRouting?.saveCoordinatorModel)
                      await projectRouting.saveCoordinatorModel(selection);
                    else
                      onProviderModelSelect(selection.instanceId, selection.model, {
                        focusComposer: false,
                      });
                    await onResume(selection, limitRestart ?? undefined);
                  },
                },
              ];
            });
            const driver = current.driver;
            const setup =
              isApiCreditAccountDriver(driver) &&
              readEnvironmentScope(environmentId, AuthProvidersManageScope)
                ? { environmentId, driver }
                : null;
            if (targets.length === 0 && setup === null) return null;
            return {
              targets,
              automatic:
                driver === "claudeAgent" &&
                activeProjectSettings.settings.providerLimitUseApiCredits === true &&
                activeProjectSettings.settings.providerLimitAction !== "wait",
              setup,
            };
          })(),
          runId: activeThreadShell.latestRun.runId,
          resetAt: serverRuntime?.usageLimitResetAt ?? null,
          stoppedAt: activeThreadShell.latestRun.completedAt ?? activeThreadShell.updatedAt,
          recovery: activeThreadShell.limitRecovery ?? null,
          snoozedUntil: activeThreadShell.snoozedUntil,
          fallback:
            limitFallbackSelection !== null && limitFallbackProvider !== undefined
              ? {
                  label: resolveProviderInstanceDisplayName(limitFallbackProvider),
                  model:
                    limitFallbackProvider.models.find(
                      (model) => model.slug === limitFallbackSelection.model,
                    )?.name ?? limitFallbackSelection.model,
                  automatic: activeProjectSettings.settings.providerLimitAction === "switch",
                  onContinue: () => continueLimitedOn(limitFallbackSelection),
                }
              : null,
          fallbackChoices: limitFallbackChoices,
          waiting: limitWaiting,
          device:
            limitDeviceTarget === null
              ? null
              : {
                  label: limitDeviceTarget.label,
                  model: limitDeviceTarget.model,
                  onContinue: () => continueOnDevice(limitDeviceTarget),
                },
          machines:
            activeProjectSettings.settings.providerLimitMachineTargets.length > 0
              ? { environmentId, threadId: activeThreadShell.id }
              : null,
          onChange: async (limitRecovery) => {
            const result = await updateThreadMetadata({
              environmentId,
              input: { threadId: activeThreadShell.id, limitRecovery },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          },
        }
      : null,
  );
  // Under "Offer the fallback", the provider reached the switch threshold with
  // a reset too far off to wait for: suggest moving on before a turn stops.
  const approachingProvider =
    !limitStopped && activeThreadShell
      ? providerStatuses.find(
          (provider) => provider.instanceId === activeThreadShell.providerInstanceId,
        )
      : undefined;
  const approachingNowMs = renderNowMs;
  const approachingThreshold = limitRule.providerLimitSwitchAtPercent;
  const approachingSelection =
    approachingProvider !== undefined &&
    approachingThreshold !== null &&
    limitRule.providerLimitAction === "ask" &&
    supportsProviderSwitchingViaHandoff &&
    usageAtThreshold({
      provider: approachingProvider,
      model: activeThreadShell?.modelSelection.model,
      rule: limitRule,
      nowMs: approachingNowMs,
    })
      ? resolveProviderFallback({
          providers: providerStatuses,
          currentInstanceId: approachingProvider.instanceId,
          currentModel: activeThreadShell?.modelSelection.model,
          currentOptions: activeThreadShell?.modelSelection.options,
          rule: limitRule,
          nowMs: approachingNowMs,
          belowPercent: approachingThreshold,
          anyReady: true,
          proven: activeThreadShell
            ? provenFallbackSelection(activeThreadShell, activeCoordinatorShell)
            : null,
        })
      : null;
  const approachingResetMs =
    approachingProvider !== undefined && approachingThreshold !== null
      ? usageResetAt(
          approachingProvider,
          approachingThreshold,
          approachingNowMs,
          activeThreadShell?.modelSelection.model,
        )
      : null;
  const approachingKey =
    approachingProvider === undefined
      ? null
      : `usage-approaching:${routeThreadKey}:${approachingProvider.instanceId}:${approachingResetMs ?? "open"}`;
  const approachingFallbackProvider =
    approachingSelection === null
      ? undefined
      : providerStatuses.find(
          (provider) => provider.instanceId === approachingSelection.instanceId,
        );
  const usageApproachingBanner = useBannerItem(
    usageApproachingBannerItem,
    approachingSelection !== null &&
      approachingProvider !== undefined &&
      approachingFallbackProvider !== undefined &&
      approachingKey !== null &&
      !dismissedUsageApproaching.has(approachingKey)
      ? {
          id: approachingKey,
          providerLabel: resolveProviderInstanceDisplayName(approachingProvider),
          leftPercent:
            100 -
            (providerUsedPercent(
              approachingProvider,
              approachingNowMs,
              activeThreadShell?.modelSelection.model,
            ) ?? 0),
          resetAt: approachingResetMs === null ? null : new Date(approachingResetMs).toISOString(),
          fallbackLabel: resolveProviderInstanceDisplayName(approachingFallbackProvider),
          onSwitch: () => {
            if (projectRouting?.saveCoordinatorModel)
              void projectRouting.saveCoordinatorModel(approachingSelection);
            else
              onProviderModelSelect(approachingSelection.instanceId, approachingSelection.model, {
                focusComposer: false,
              });
            setDismissedUsageApproaching((current) => new Set(current).add(approachingKey));
          },
          onDismiss: () =>
            setDismissedUsageApproaching((current) => new Set(current).add(approachingKey)),
        }
      : null,
  );
  // A thread a usage limit moved to a fallback stays paired with the model it stood in for.
  const pairing = activeThreadShell?.modelIdentity
    ? activeThreadShell.modelIdentity.kind === "fallback" &&
      activeThreadShell.modelIdentity.preferred
      ? {
          original: activeThreadShell.modelIdentity.preferred,
          stoppedRunId: `model:${activeThreadShell.modelIdentity.preferred.instanceId}:${activeThreadShell.modelIdentity.preferred.model}`,
          launched: activeThreadShell.modelIdentity.launched === true,
          preswitched: activeThreadShell.modelIdentity.preswitched === true,
        }
      : null
    : activeThreadShell && serverProjection
      ? limitFallbackPairing(
          serverProjection.messages,
          serverProjection.runs,
          activeThreadShell.modelSelection,
          serverProjection.thread.launchFallbackFrom,
          serverProjection.thread.limitPreswitchFrom,
        )
      : null;
  const pairingProvider =
    pairing === null
      ? undefined
      : providerStatuses.find((provider) => provider.instanceId === pairing.original.instanceId);
  const pairingStandIn =
    pairing === null
      ? null
      : (() => {
          const originalEntry =
            providerInstanceEntries.find(
              (entry) => entry.instanceId === pairing.original.instanceId,
            ) ?? null;
          const runningSelection =
            activeThreadShell?.modelIdentity?.current ?? activeThreadShell?.modelSelection ?? null;
          const runningEntry = runningSelection
            ? (providerInstanceEntries.find(
                (entry) => entry.instanceId === runningSelection.instanceId,
              ) ?? null)
            : null;
          // The chip's twin rule: a pick named like the running model goes by its provider.
          const originalLabel = fallbackModelState({
            pick: {
              ...threadIdentityLabel(
                originalEntry,
                pairing.original.instanceId,
                pairing.original.model,
              ),
              instance: originalEntry?.displayName ?? pairing.original.instanceId,
            },
            running: runningSelection
              ? {
                  ...threadIdentityLabel(
                    runningEntry,
                    runningSelection.instanceId,
                    runningSelection.model,
                  ),
                  instance: runningEntry?.displayName ?? runningSelection.instanceId,
                }
              : null,
          });
          const room = limitPairingRoom(
            pairingProvider,
            approachingNowMs,
            pairing.original.model,
            activeThreadShell
              ? provenFallbackSelection(activeThreadShell, activeCoordinatorShell)
              : null,
          );
          const pickLabel = threadIdentityLabel(
            originalEntry,
            pairing.original.instanceId,
            pairing.original.model,
          );
          // A pre-switched thread goes back only below the switch threshold, so
          // the banner and header claim room only then; a pick back stays open.
          const shownRoom =
            pairing.preswitched === true
              ? preswitchPairingRoom(room, {
                  provider: pairingProvider,
                  model: pairing.original.model,
                  rule: limitRule,
                  nowMs: approachingNowMs,
                })
              : room;
          return {
            original: originalLabel.pick,
            originalModel: originalLabel.pickModel,
            pickLabel,
            running: runningSelection
              ? {
                  instanceId: runningSelection.instanceId as string,
                  model: runningSelection.model,
                  label: threadIdentityLabel(
                    runningEntry,
                    runningSelection.instanceId,
                    runningSelection.model,
                  ),
                }
              : null,
            launched: pairing.launched === true,
            canPickBack: room.hasRoom || room.roomUnknown !== undefined,
            // Why the way back from a usage pre-switch will not move the thread (1075).
            returnBlock:
              pairing.preswitched === true
                ? preswitchReturnBlock(
                    { modelSelection: pairing.original },
                    providerStatuses,
                    limitRule,
                  )
                : null,
            resetAt:
              pairingProvider === undefined
                ? null
                : usageResetAt(pairingProvider, 100, approachingNowMs, pairing.original.model),
            ...shownRoom,
            onBack: () => {
              const threadId = activeThreadShell?.id;
              if (threadId === undefined) return;
              void switchThreadBackToPick({
                selection: {
                  instanceId: pairing.original.instanceId,
                  model: pairing.original.model,
                } as ModelSelection,
                setThreadModel: (selection) =>
                  updateThreadMetadata({
                    environmentId,
                    input: { threadId, modelSelection: selection },
                  }),
                selectInComposer: (selection) => {
                  if (projectRouting?.saveCoordinatorModel)
                    void projectRouting.saveCoordinatorModel(selection);
                  else
                    onProviderModelSelect(selection.instanceId, selection.model, {
                      focusComposer: false,
                    });
                },
              }).then((outcome) => {
                if (outcome.ok) return;
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: `Could not switch back to ${originalLabel.pick}`,
                    description:
                      outcome.error instanceof Error
                        ? outcome.error.message
                        : "The thread kept its current model.",
                  }),
                );
              });
            },
          };
        })();
  const pairingResetLabel =
    pairingStandIn?.resetAt == null
      ? null
      : new Date(pairingStandIn.resetAt).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        });
  // One status in the picker: what runs now, the pick and why not, the way back
  // (automatic after a limit, by hand for a launch stand-in) and the fallback order.
  // No thread banner repeats the way back.
  const modelStateHeader =
    pairing && pairingStandIn
      ? fallbackStatusHeader({
          pick: pairingStandIn.pickLabel,
          pickModel: pairingStandIn.originalModel,
          running: pairingStandIn.running?.label ?? null,
          launched: pairing.launched === true,
          preswitched: pairing.preswitched === true,
          returnBlock: pairingStandIn.returnBlock,
          canPickBack: pairingStandIn.canPickBack,
          hasRoom: pairingStandIn.hasRoom,
          roomUnknown: pairingStandIn.roomUnknown,
          pickReportsNoUsage: pairingProvider !== undefined && reportsNoUsage(pairingProvider),
          resetLabel: pairingResetLabel,
          chain: fallbackChain({
            pick: {
              instanceId: pairing.original.instanceId,
              model: pairing.original.model,
              label: pairingStandIn.pickLabel,
            },
            running: pairingStandIn.running,
            order: (activeThreadShell
              ? describeFallbackOrder({
                  providers: providerStatuses,
                  currentInstanceId: activeThreadShell.providerInstanceId,
                  rule: activeProjectSettings.settings,
                  nowMs: approachingNowMs,
                  belowPercent: 100,
                })
              : []
            ).map((step) => ({
              instanceId: step.selection.instanceId,
              model: step.selection.model,
              label: threadIdentityLabel(
                providerInstanceEntries.find(
                  (entry) => entry.instanceId === step.selection.instanceId,
                ) ?? null,
                step.selection.instanceId,
                step.selection.model,
              ),
              unavailable: step.unavailable,
              resetLabel:
                step.resetAt === null
                  ? null
                  : new Date(step.resetAt).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    }),
            })),
          }),
          onBack: pairingStandIn.onBack,
        })
      : null;
  const [dismissedAccountChanges, setDismissedAccountChanges] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const accountChangedProvider = providerStatuses.find(
    (provider) => provider.instanceId === activeThreadShell?.providerInstanceId,
  );
  const accountChangedKey =
    limitStopped && activeThreadShell?.latestRun
      ? `${activeThreadShell.latestRun.runId}:${accountChangedProvider?.usageLimits?.accountChangedAt ?? ""}`
      : null;
  const accountChangedBanner = useBannerItem(
    accountChangedBannerItem,
    limitStopped &&
      activeThreadShell?.latestRun &&
      accountChangedKey !== null &&
      !dismissedAccountChanges.has(accountChangedKey) &&
      accountChangedWithRoom(
        accountChangedProvider,
        Date.parse(activeThreadShell.latestRun.completedAt ?? activeThreadShell.updatedAt),
        // Room as the read saw it; a newer read re-renders this.
        Date.parse(accountChangedProvider?.usageLimits?.checkedAt ?? ""),
      )
      ? {
          runId: activeThreadShell.latestRun.runId,
          providerName: accountChangedProvider
            ? resolveProviderInstanceDisplayName(accountChangedProvider)
            : "provider",
          autoContinuing: accountChangeAutoContinues({
            driver: accountChangedProvider?.driver,
            autoApprove: limitRule.autoApproveSubscriptionChange !== false,
            runId: activeThreadShell.latestRun.runId,
            limitRecovery: activeThreadShell.limitRecovery,
            settledOverride: activeThreadShell.settledOverride,
            snoozedUntil: activeThreadShell.snoozedUntil,
            pendingRequest:
              activeThreadShell.hasPendingApprovals || activeThreadShell.hasPendingUserInput,
            project: activeProject?.workspaceSettings,
            nowMs: Date.now(),
          }),
          // The notice shows a failure inline as well as on the thread.
          onContinue: async () => {
            const failure = await onResume(
              activeThreadShell.modelSelection,
              limitRestart ?? undefined,
            );
            if (failure !== null) throw new Error(failure);
          },
          onDismiss: () =>
            setDismissedAccountChanges((current) => new Set(current).add(accountChangedKey)),
        }
      : null,
  );
  const composerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    // A handed-off thread is read-only: its move banner leads, not the limit it left behind.
    // A limit the previous account hit gives way to the account change that lifts it.
    const limitRecoveryItems = movedAwayBanner(threadMoveBannerItem?.id)
      ? []
      : accountChangedBanner !== null
        ? [accountChangedBanner]
        : limitRecoveryBanner !== null
          ? [limitRecoveryBanner]
          : usageApproachingBanner !== null
            ? [usageApproachingBanner]
            : [];
    const backgroundWorkItems = [goalBannerItem, backgroundWorkBannerItem].filter(
      (item) => item !== null,
    );
    const resumeCompactionItems =
      resumeCompactionBannerItem === null ? [] : [resumeCompactionBannerItem];
    const wokeThreadItems = wokeThreadBannerItem === null ? [] : [wokeThreadBannerItem];
    const computerUseItems =
      computerUsePermissionBannerItem === null ? [] : [computerUsePermissionBannerItem];
    const parkedThreadItems = [
      threadMoveBannerItem,
      deliveryBannerItem,
      parkedThreadBannerItem,
    ].filter((item) => item !== null);
    // The user asked for this one, so it leads the notice tier instead of trailing it.
    const usageLimitsItems = usageLimitsBanner === null ? [] : [usageLimitsBanner];
    const projectCloneItems = projectCloneBannerItem === null ? [] : [projectCloneBannerItem];
    if (!localCheckoutBranchMismatch || !showBranchMismatchBanner || !activeBranchMismatchKey) {
      return [
        ...feedbackBannerItems,
        ...limitRecoveryItems,
        ...usageLimitsItems,
        ...projectCloneItems,
        ...computerUseItems,
        ...systemComposerBannerItems,
        ...backgroundWorkItems,
        ...resumeCompactionItems,
        ...wokeThreadItems,
        ...parkedThreadItems,
      ];
    }
    return [
      ...feedbackBannerItems,
      ...limitRecoveryItems,
      ...usageLimitsItems,
      ...projectCloneItems,
      ...computerUseItems,
      ...systemComposerBannerItems,
      ...backgroundWorkItems,
      ...resumeCompactionItems,
      ...wokeThreadItems,
      {
        id: `branch-mismatch:${activeBranchMismatchKey}`,
        variant: "info",
        icon: <GitBranchIcon />,
        title: (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 font-normal text-muted-foreground">Branch changed — was</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <code className="min-w-0 truncate font-medium text-foreground">
                    {localCheckoutBranchMismatch.threadBranch}
                  </code>
                }
              />
              <TooltipPopup side="top">
                This thread last ran on {localCheckoutBranchMismatch.threadBranch}. Sending will
                continue on {localCheckoutBranchMismatch.currentBranch}.
              </TooltipPopup>
            </Tooltip>
          </span>
        ),
        actions: (
          <Button
            size="xs"
            variant="ghost"
            disabled={!canWriteSourceControl || isRestoringThreadBranch}
            onClick={handleRestoreThreadBranch}
          >
            {isRestoringThreadBranch ? "Restoring..." : "Restore branch"}
          </Button>
        ),
        dismissLabel: "Dismiss branch change notice",
        onDismiss: () => {
          dismissBranchMismatchForSession(activeBranchMismatchKey);
          setBranchMismatchDismissTick((tick) => tick + 1);
        },
      },
      ...parkedThreadItems,
    ];
  }, [
    activeBranchMismatchKey,
    activeThreadShell,
    serverRuntime?.usageLimitResetAt,
    canWriteSourceControl,
    feedbackBannerItems,
    accountChangedBanner,
    limitRecoveryBanner,
    usageApproachingBanner,
    handleRestoreThreadBranch,
    isRestoringThreadBranch,
    backgroundWorkBannerItem,
    computerUsePermissionBannerItem,
    deliveryBannerItem,
    goalBannerItem,
    localCheckoutBranchMismatch,
    parkedThreadBannerItem,
    threadMoveBannerItem,
    projectCloneBannerItem,
    resumeCompactionBannerItem,
    showBranchMismatchBanner,
    systemComposerBannerItems,
    usageLimitsBanner,
    wokeThreadBannerItem,
    setBranchMismatchDismissTick,
  ]);

  useEffect(() => {
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [activeThread?.id]);

  useEffect(() => {
    if (canOverrideServerThreadEnvMode) {
      return;
    }
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [canOverrideServerThreadEnvMode]);

  useEffect(() => {
    if (!activeThreadId) {
      setTerminalUiLaunchContext(null);
      return;
    }
    setTerminalUiLaunchContext((current) => {
      if (!current) return current;
      if (current.threadId === activeThreadId) return current;
      return null;
    });
  }, [activeThreadId]);

  useEffect(() => {
    if (!activeThreadId || !activeProjectCwd) {
      return;
    }
    setTerminalUiLaunchContext((current) => {
      if (!current || current.threadId !== activeThreadId) {
        return current;
      }
      const settledCwd = projectScriptCwd({
        project: { cwd: activeProjectCwd },
        worktreePath: activeThreadWorktreePath,
      });
      if (
        settledCwd === current.cwd &&
        (activeThreadWorktreePath ?? null) === current.worktreePath
      ) {
        return null;
      }
      return current;
    });
  }, [activeProjectCwd, activeThreadId, activeThreadWorktreePath]);

  useEffect(() => {
    if (terminalUiState.terminalOpen) {
      return;
    }
    setTerminalUiLaunchContext((current) =>
      current?.threadId === activeThreadId ? null : current,
    );
  }, [activeThreadId, terminalUiState.terminalOpen]);

  useEffect(() => {
    if (!activeThreadKey) return;
    const previous = terminalUiOpenByThreadRef.current[activeThreadKey] ?? false;
    const current = Boolean(terminalUiState.terminalOpen);

    if (!previous && current) {
      terminalUiOpenByThreadRef.current[activeThreadKey] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalUiOpenByThreadRef.current[activeThreadKey] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalUiOpenByThreadRef.current[activeThreadKey] = current;
  }, [activeThreadKey, focusComposer, terminalUiState.terminalOpen]);

  const getShortcutContext = useCallback(
    (eventTarget: EventTarget | null = document.activeElement) => ({
      terminalFocus: getTerminalFocusOwner() !== null,
      terminalOpen: Boolean(terminalUiState.terminalOpen),
      previewFocus: isPreviewFocused(),
      previewOpen: previewPanelOpen,
      editableFocus: isEditableFocused(eventTarget),
      modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false,
      composerFocus: document.activeElement?.getAttribute("data-testid") === "composer-editor",
      draftThreadRoute: routeKind === "draft",
      turnRunning: phase === "running",
      isWeb: !isElectron,
      isDesktop: isElectron,
    }),
    [composerRef, previewPanelOpen, terminalUiState.terminalOpen, routeKind, phase],
  );

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (preventRepeatedTerminalCloseShortcut(event, keybindings)) {
        event.stopPropagation();
        return;
      }
      if (isTerminalCloseConfirmPending() && preventTerminalCloseShortcut(event, keybindings)) {
        event.stopPropagation();
        return;
      }
      if (!activeThreadId || isCommandPaletteOpen()) {
        return;
      }
      if (eventPathContainsSelector(event, KEYBOARD_OWNER_SELECTOR)) return;
      // A sheet over the app (Usage) leaves this chat mounted; its keys are the sheet's.
      if (isAppSheetOpen()) return;
      const terminalFocusOwner = getTerminalFocusOwner();
      if (event.defaultPrevented && terminalFocusOwner === null) {
        return;
      }
      const shortcutContext = getShortcutContext(event.target);

      if (
        !shortcutContext.terminalFocus &&
        !shortcutContext.modelPickerOpen &&
        shouldTypeToFocusComposer(event)
      ) {
        if (composerRef.current?.insertTextAtEnd(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      const command = resolveChatShortcutCommand(event, keybindings, scriptKeybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "thread.copyReference") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) copyActiveThreadReference();
        return;
      }

      if (command === "thread.settle") {
        if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
        if (!isServerThread || !activeThreadTarget || !supportsSettlement) return;
        void runThreadLifecycleShortcut(event, {
          threadKey: scopedThreadKey(activeThreadTarget),
          context: shortcutContext,
          run: () =>
            activeThreadSettled
              ? handleUnsettleActiveThread()
              : settleThread(activeThreadTarget).then((result) => {
                  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
                  const error = squashAtomCommandFailure(result);
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: THREAD_LIFECYCLE_LABELS.failedResolve,
                      description: error instanceof Error ? error.message : "An error occurred.",
                    }),
                  );
                }),
        });
        return;
      }

      if (command === "thread.pin") {
        if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!isServerThread || !activeThreadTarget || !supportsPinning) return;
        const pinned = activeThreadPinned;
        void (
          pinned ? confirmAndUnpinThread(activeThreadTarget) : pinThread(activeThreadTarget)
        ).then((result) => {
          if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: pinned ? "Failed to unpin thread" : "Failed to pin thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        });
        return;
      }

      if (command === "terminal.toggle") {
        if (!terminalUiState.terminalOpen && !canReadTerminal && !canOperateTerminal) return;
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "rightPanel.toggle") {
        // Inside a project the shortcut belongs to the project's own Overview pane.
        // Its own sheet, when open, is a dialog the project leaves alone, so close it here.
        if (layoutMode === "embedded" && !(shouldUsePlanSidebarSheet && rightPanelOpen)) return;
        event.preventDefault();
        event.stopPropagation();
        toggleRightPanel();
        return;
      }

      if (command === "threadPanel.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleThreadPanel();
        return;
      }

      if (command === "rightPanel.close") {
        // Nothing open: leave the event alone so the shortcut keeps its
        // native meaning (close window on desktop, close tab in a browser).
        if (!activeRightPanelSurface) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) closeRightPanelSurface(activeRightPanelSurface);
        return;
      }

      if (command === "terminal.split") {
        // Without operate access the key keeps its native meaning, as it
        // does when nothing is open.
        if (!canOperateTerminal) return;
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel") {
          splitPanelTerminal();
          return;
        }
        if (!terminalUiState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.splitVertical") {
        // Without operate access the key keeps its native meaning, as it
        // does when nothing is open.
        if (!canOperateTerminal) return;
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel") {
          splitPanelTerminal("vertical");
          return;
        }
        if (!terminalUiState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal("vertical");
        return;
      }

      if (command === "terminal.close") {
        // Without operate access the key keeps its native meaning, as it
        // does when nothing is open.
        if (!canOperateTerminal) return;
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel" && activeRightPanelSurface?.kind === "terminal") {
          requestClosePanelTerminal(activeRightPanelSurface.activeTerminalId);
          return;
        }
        if (!terminalUiState.terminalOpen) return;
        requestCloseTerminal(terminalUiState.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        // Without operate access the key keeps its native meaning, as it
        // does when nothing is open.
        if (!canOperateTerminal) return;
        event.preventDefault();
        event.stopPropagation();
        if (terminalFocusOwner === "right-panel") {
          addTerminalSurface();
          return;
        }
        if (!terminalUiState.terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      if (command === "modelPicker.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) composerRef.current?.toggleModelPicker();
        return;
      }

      if (
        command === "composer.host" ||
        command === "composer.effort" ||
        command === "composer.mode" ||
        command === "composer.workspace"
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) composerRef.current?.openControl(command);
        return;
      }

      if (command === "composer.cycleHost") {
        if (envLocked || !draftId || !hasMultipleEnvironments) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        // Step from where a pending switch is heading, so repeated presses keep advancing.
        const currentId = environmentChangeRef.current?.environmentId ?? environmentId;
        const index = logicalProjectEnvironments.findIndex(
          (env) => env.environmentId === currentId,
        );
        const next = logicalProjectEnvironments[(index + 1) % logicalProjectEnvironments.length];
        if (next) onEnvironmentChange(next.environmentId);
        return;
      }

      if (command === "composer.branch") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) branchToolbarRef.current?.openBranchPicker();
        return;
      }

      if (command === "composer.previousWorktree") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) branchToolbarRef.current?.usePreviousWorktree();
        return;
      }

      if (command === "thread.steerQueuedMessage") {
        if (routeKind === "draft") return;
        if (!queuedRunsControlRef.current?.steerNext(event.repeat)) return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (command === "thread.editQueuedMessage") {
        if (routeKind === "draft") return;
        // Anywhere else in the draft the key keeps moving the caret, so a
        // second press from the first paragraph reaches the queue.
        if (!composerRef.current?.isCaretAtStart()) return;
        if (!queuedRunsControlRef.current?.editLatest(event.repeat)) return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (command === "thread.stop") {
        // An unavailable command should not shadow contextual shortcuts such as Escape to close a dialog.
        if (!canInterruptRunningThread) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        void onInterrupt();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject || !canOperateTerminal) return;
      const script = activeProjectScripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    return registerChatViewWindowInput("keydown", handler, !suspendChatInput);
  }, [
    suspendChatInput,
    activeProject,
    activeRightPanelSurface,
    activeProjectScripts,
    canReadTerminal,
    canOperateTerminal,
    addTerminalSurface,
    activeThreadTarget,
    activeThreadPinned,
    activeThreadSettled,
    canInterruptRunningThread,
    terminalUiState.terminalOpen,
    terminalUiState.activeTerminalId,
    activeThreadId,
    closeRightPanelSurface,
    requestCloseTerminal,
    requestClosePanelTerminal,
    createNewTerminal,
    setTerminalOpen,
    runProjectScript,
    splitTerminal,
    splitPanelTerminal,
    keybindings,
    layoutMode,
    shouldUsePlanSidebarSheet,
    rightPanelOpen,
    scriptKeybindings,
    handleUnsettleActiveThread,
    isServerThread,
    onInterrupt,
    onToggleDiff,
    pinThread,
    settleThread,
    supportsPinning,
    supportsSettlement,
    confirmAndUnpinThread,
    copyActiveThreadReference,
    getShortcutContext,
    toggleRightPanel,
    toggleThreadPanel,
    toggleTerminalVisibility,
    composerRef,
    draftId,
    environmentId,
    envLocked,
    hasMultipleEnvironments,
    logicalProjectEnvironments,
    onEnvironmentChange,
  ]);

  // Paste-to-focus: the resting composer blurs on a click into the timeline,
  // so a paste that follows has no editable target and would be dropped.
  // Route it to the composer like a typed key, which also expands it.
  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if (
        shouldRedirectInputToComposer(event) &&
        isPasteAsTextShortcut(event, isMacPlatform(navigator.platform))
      ) {
        pasteAsTextShortcutUntilRef.current = Date.now() + 1_000;
      }
    };
    const handler = (event: ClipboardEvent) => {
      if (!activeThreadId || isCommandPaletteOpen()) return;
      if (getTerminalFocusOwner() !== null) return;
      if (composerRef.current?.isModelPickerOpen()) return;
      const text = pasteTextToFocusComposer(event);
      const clipboardData = event.clipboardData;
      if (text === null || clipboardData === null) return;
      const bypassAutoAttachment = Date.now() <= pasteAsTextShortcutUntilRef.current;
      pasteAsTextShortcutUntilRef.current = 0;
      if (
        ((readPastedComposerContext(clipboardData)?.records.length ?? 0) === 0 &&
          composerRef.current?.pasteTextAtEnd(text, { bypassAutoAttachment })) ||
        composerRef.current?.insertTextAtEnd(text, { clipboardData })
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const stopKeys = registerChatViewWindowInput("keydown", keyHandler, !suspendChatInput);
    const stopPaste = registerChatViewWindowInput("paste", handler, !suspendChatInput);
    return () => {
      stopKeys();
      stopPaste();
    };
  }, [activeThreadId, composerRef, suspendChatInput]);

  const [pendingRevert, setPendingRevert] = useState<{
    turnCount: number;
    messageId: MessageId;
    routeThreadKey: string;
  } | null>(null);

  if (pendingRevert && pendingRevert.routeThreadKey !== routeThreadKey) {
    setPendingRevert(null);
  }

  const onRevertToTurnCount = useCallback(
    async (turnCount: number, messageId: MessageId, restoreFiles?: boolean) => {
      const localApi = readLocalApi();
      if (
        !localApi ||
        !activeThread ||
        isRevertingCheckpoint ||
        !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
      )
        return;
      const sourceMessage = serverProjection?.messages.find((message) => message.id === messageId);
      const message = sourceMessage
        ? {
            id: sourceMessage.id,
            role: sourceMessage.role,
            text: sourceMessage.text,
            attachments: sourceMessage.attachments,
            context: sourceMessage.context,
            runId: sourceMessage.runId,
            streaming: false,
            createdAt: DateTime.formatIso(sourceMessage.createdAt),
            updatedAt: DateTime.formatIso(sourceMessage.updatedAt),
          }
        : undefined;
      if (!message || message.role !== "user") return;

      if (!supportsConversationRollback) {
        setThreadError(
          activeThread.id,
          "This provider does not support reverting conversation history. Start a new thread instead.",
        );
        return;
      }
      if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
        setThreadError(
          activeThread.id,
          `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
        );
        return;
      }
      if (phase === "running" || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      if (restoreFiles === undefined) {
        setPendingRevert({ turnCount, messageId, routeThreadKey });
        return;
      }

      useComposerDraftStore.setState((store) => ({
        rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
      }));
      setThreadError(activeThread.id, null);
      await settleCaught(
        async () => {
          if (composerRef.current?.hasPendingAttachments()) {
            throw new Error("Wait for attachments to finish preparing before rewinding.");
          }
          const connection = readPreparedConnection(environmentId);
          if (!connection) throw new Error("The environment is not connected.");
          const files = await prepareRevertedMessageAttachments({
            message,
            environmentId,
            httpBaseUrl: connection.httpBaseUrl,
            createAssetUrl: createAttachmentAssetUrl,
          });
          const store = useComposerDraftStore.getState();
          const draft = store.getComposerDraft(composerDraftTarget);
          if (
            (draft?.images.length ?? 0) + (draft?.files.length ?? 0) + files.length >
            PROVIDER_SEND_TURN_MAX_ATTACHMENTS
          ) {
            throw new Error(
              "Make room for this message's attachments in the composer before rewinding.",
            );
          }
          const commandId = CommandId.make(randomUUID());
          await waitForRevertedMessage(
            routeThreadTarget,
            messageId,
            turnCount,
            commandId,
            async () => {
              const result = await revertThreadCheckpoint({
                environmentId,
                input: { commandId, threadId: activeThread.id, turnCount, restoreFiles },
              });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            },
          );
          const currentPrompt = store.getComposerDraft(composerDraftTarget)?.prompt ?? "";
          const restoredPrompt = recallableComposerPrompt(message.text);
          const nextPrompt =
            restoredPrompt.length === 0
              ? currentPrompt
              : currentPrompt.length > 0
                ? `${currentPrompt}\n\n${restoredPrompt}`
                : restoredPrompt;
          store.setPrompt(composerDraftTarget, nextPrompt);
          const images: ComposerImageAttachment[] = [];
          const restoredFiles: ComposerFileAttachment[] = [];
          files.forEach((file, index) => {
            const attachment = {
              id: randomUUID(),
              name: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
              file,
            };
            if (message.attachments?.[index]?.type === "image") {
              images.push({ ...attachment, type: "image", previewUrl: URL.createObjectURL(file) });
            } else {
              restoredFiles.push({ ...attachment, type: "file" });
            }
          });
          store.addImages(composerDraftTarget, images, { allowDuplicates: true });
          store.addFiles(composerDraftTarget, restoredFiles, { allowDuplicates: true });
          if (currentRouteThreadKeyRef.current === routeThreadKey) {
            promptRef.current = nextPrompt;
            composerRef.current?.resetCursorState({
              prompt: nextPrompt,
              cursor: nextPrompt.length,
            });
            requestAnimationFrame(() => {
              if (currentRouteThreadKeyRef.current === routeThreadKey)
                composerRef.current?.focusAtEnd();
            });
          }
        },
        (error) => {
          setThreadError(
            activeThread.id,
            error instanceof Error ? error.message : "Failed to revert thread state.",
          );
        },
        () => {
          useComposerDraftStore.setState((store) => {
            const remaining = new Set(store.rewindingThreadKeys);
            remaining.delete(routeThreadKey);
            return { rewindingThreadKeys: remaining };
          });
        },
      );
    },
    [
      activeThread,
      activeEnvironmentUnavailable,
      activeEnvironmentUnavailableLabel,
      composerDraftTarget,
      composerRef,
      createAttachmentAssetUrl,
      environmentId,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      phase,
      revertThreadCheckpoint,
      routeThreadKey,
      routeThreadTarget,
      setThreadError,
      supportsConversationRollback,
      serverProjection,
      setPendingRevert,
      currentRouteThreadKeyRef,
      promptRef,
    ],
  );

  const onRollbackCheckpoint = useCallback(
    async (input: { readonly checkpointId: string; readonly scopeId: string }) => {
      if (!activeThread || isRevertingCheckpoint) return;
      if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
        setThreadError(
          activeThread.id,
          `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
        );
        return;
      }
      if (phase === "running" || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      const localApi = readLocalApi();
      const confirmed =
        localApi == null
          ? window.confirm("Roll back this thread to the selected checkpoint?")
          : await localApi.dialogs.confirm(
              "Roll back this thread to the selected checkpoint?\nThis action cannot be undone.",
            );
      if (!confirmed) return;

      useComposerDraftStore.setState((store) => ({
        rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
      }));
      setThreadError(activeThread.id, null);
      const result = await revertThreadCheckpoint({
        environmentId,
        input: {
          threadId: activeThread.id,
          checkpointId: input.checkpointId,
          scopeId: input.scopeId,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to revert thread state.",
        );
      }
      useComposerDraftStore.setState((store) => {
        const remaining = new Set(store.rewindingThreadKeys);
        remaining.delete(routeThreadKey);
        return { rewindingThreadKeys: remaining };
      });
    },
    [
      activeEnvironmentUnavailable,
      activeEnvironmentUnavailableLabel,
      activeThread,
      environmentId,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      phase,
      revertThreadCheckpoint,
      setThreadError,
      routeThreadKey,
    ],
  );

  const onForkFromRun = useCallback(
    async (input: { readonly sourceThreadId: ThreadId; readonly runId: RunId }) => {
      if (!activeThread || activeEnvironmentUnavailable) return;
      if (await coordinatorForkHandoff(openCoordinatorHandoff, environmentId, input)) return;
      const targetThreadId = newThreadId();
      const targetThreadRef = scopeThreadRef(environmentId, targetThreadId);
      const result = await forkThreadFromRun({
        environmentId,
        input: {
          sourceThreadId: input.sourceThreadId,
          targetThreadId,
          runId: input.runId,
          title: `${activeThread.title} fork`,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setThreadError(
            activeThread.id,
            error instanceof Error ? error.message : "Failed to fork this response.",
          );
        }
        return;
      }
      const targetThreadReady = await waitForThreadShell(targetThreadRef);
      if (!targetThreadReady) {
        setThreadError(
          activeThread.id,
          "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.",
        );
        return;
      }
      await openThreadRoute(targetThreadRef);
    },
    [
      activeEnvironmentUnavailable,
      activeThread,
      environmentId,
      forkThreadFromRun,
      openCoordinatorHandoff,
      openThreadRoute,
      setThreadError,
    ],
  );
  const onCompactContext = () => {
    if (compactDisabled) return;
    void sendStandaloneCommand("/compact", "Failed to compact context.");
  };

  /**
   * With a model selection, the stopped run continues on that provider through a context handoff.
   * Resolves to the failure it also shows as the thread error, or null.
   */
  const onResume = async (
    modelSelection?: ModelSelection,
    restart?: {
      readonly text: string;
      readonly attachments: ReadonlyArray<ContractChatAttachment>;
    },
    creditIntent?: ManualCodexCreditIntent,
  ): Promise<string | null> => {
    if (
      !activeThread ||
      (resumableRunId === null && !hasHeldQueuedRuns) ||
      isSendBusy ||
      isResuming ||
      isConnecting ||
      isRevertingCheckpoint ||
      threadDetailLoading ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return null;
    }
    const capturedRecoveryContext = creditRecoveryContextRef.current;
    const creditStillCurrent = () => {
      if (!creditIntent) return true;
      const current = creditRecoveryContextRef.current;
      const provider = appAtomRegistry
        .get(environmentServerConfigsAtom)
        .get(environmentId)
        ?.providers.find((entry) => entry.instanceId === creditIntent.instanceId);
      const selection = composerRef.current?.getSendContext().selectedModelSelection;
      return (
        capturedRecoveryContext !== null &&
        current !== null &&
        selection !== undefined &&
        explicitCreditSendStillMatches(
          creditIntent,
          capturedRecoveryContext,
          { ...current, selection, allowed: current.allowed && capturedRecoveryContext.allowed },
          provider,
        )
      );
    };
    if (!creditStillCurrent())
      throw new Error("Credit account, model or chat changed. Refresh Providers and try again.");
    const threadId = activeThread.id;
    const readCurrentRuns = () =>
      appAtomRegistry.get(
        environmentThreadDetails.threadAtom(scopeThreadRef(environmentId, threadId)),
      )?.projection.runs ?? null;
    sendInFlightRef.current = true;
    setResumingThreadKeys((current) => new Set(current).add(routeThreadKey));
    setThreadError(threadId, null);
    let failure: string | null = null;
    await settleCaught(
      async () => {
        const resume = async (selectedModel: ModelSelection | undefined) => {
          if (projectRouting?.continueCoordinator && selectedModel)
            assertCoordinatorQueueModel(selectedModel, readCurrentRuns());
          if (resumableRunId === null) {
            return resumeQueueWithProjectModel(projectRouting, selectedModel, readCurrentRuns, () =>
              resumeThreadQueue({ environmentId, input: { threadId } }),
            );
          }
          const createdAt = new Date().toISOString();
          const settingsResult = await persistThreadSettingsForNextTurn({
            threadId,
            createdAt,
            ...(localCheckoutBranchMismatch
              ? { branch: localCheckoutBranchMismatch.currentBranch }
              : {}),
            runtimeMode,
            interactionMode,
          });
          if (settingsResult._tag === "Failure") return settingsResult;
          if (!creditStillCurrent())
            throw new Error(
              "Credit account, model or chat changed. Refresh Providers and try again.",
            );
          const turnResult = await continueWithProjectModel(
            projectRouting,
            selectedModel,
            (currentModel) => {
              if (projectRouting?.continueCoordinator && currentModel)
                assertCoordinatorQueueModel(currentModel, readCurrentRuns());
              if (!creditStillCurrent())
                throw new Error(
                  "Credit account, model or chat changed. Refresh Providers and try again.",
                );
              return startThreadTurn({
                environmentId,
                input: {
                  threadId,
                  // An explicit credit click submits one foreground message, never a persistent recovery rule.
                  ...(creditIntent
                    ? { manualCodexCreditIntent: creditIntent }
                    : { manualContinuationOfRunId: resumableRunId }),
                  ...(currentModel === undefined ? {} : { modelSelection: currentModel }),
                  message: {
                    messageId: newMessageId(),
                    role: "user",
                    text: restart?.text ?? "Continue where you left off.",
                    attachments: restart?.attachments ?? [],
                  },
                  runtimeMode,
                  interactionMode,
                  dispatchMode: "start",
                },
              });
            },
          );
          if (turnResult._tag === "Failure" || !hasHeldQueuedRuns) return turnResult;
          clearUsageLimitsFor(routeThreadKey);
          return resumeQueueWithProjectModel(projectRouting, selectedModel, readCurrentRuns, () =>
            resumeThreadQueue({ environmentId, input: { threadId } }),
          );
        };
        const result = await continueWithProjectModel(projectRouting, modelSelection, resume);
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            failure = error instanceof Error ? error.message : "Could not resume thread.";
            setThreadError(threadId, failure);
          }
        } else {
          clearUsageLimitsFor(routeThreadKey);
          if (currentRouteThreadKeyRef.current === routeThreadKey) scrollToEnd();
        }
      },
      (error) => {
        failure = error instanceof Error ? error.message : "Could not resume coordinator.";
        setThreadError(threadId, failure);
      },
      () => {
        sendInFlightRef.current = false;
        setResumingThreadKeys((current) => {
          const next = new Set(current);
          next.delete(routeThreadKey);
          return next;
        });
      },
    );
    return failure;
  };

  // Continue on a stalled turn: stop it, then resume once the stop has landed.
  const continueAfterStallStopRef = useRef(false);
  const onContinueStalledRun = useCallback(async () => {
    continueAfterStallStopRef.current = true;
    await onInterrupt();
  }, [onInterrupt]);
  useEffect(() => {
    if (!continueAfterStallStopRef.current) return;
    if (threadRuntimeIsActive(activeRuntime) || resumableRunId === null) return;
    continueAfterStallStopRef.current = false;
    void onResume();
  });

  // Read again after attachment/settings awaits; a render may retarget the draft meanwhile.
  const currentCreditRoute = {
    environmentId,
    projectId: activeThread?.projectId ?? null,
    threadId: activeThreadId,
    draftId,
    runtimeMode,
    allowed:
      !routesViaCoordinator(projectRouting) &&
      phase !== "running" &&
      phase !== "connecting" &&
      !activeGoal &&
      editingQueuedRun === null &&
      !activePendingProgress &&
      !canInterruptRunningThread &&
      resumableRunId === null &&
      !hasHeldQueuedRuns &&
      !showPlanFollowUpPrompt &&
      activePendingApproval === null &&
      pendingUserInputs.length === 0 &&
      !activeEnvironmentUnavailable &&
      !isRevertingCheckpoint &&
      !threadDetailLoading,
  };
  const currentCreditRouteRef = useLatestRef(currentCreditRoute);

  // Continue runs a failed or stopped turn on a model the person picked in the
  // composer; without an explicit pick it keeps the thread's own model.
  const resumeWithComposerModel = () => {
    const explicitPick =
      useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)
        ?.modelSelectionExplicit === true;
    const picked = composerRef.current?.getSendContext().selectedModelSelection;
    const current = activeThread?.modelSelection;
    const switched =
      explicitPick &&
      resumableRunId !== null &&
      picked !== undefined &&
      current !== undefined &&
      !modelSelectionsEqual(picked, current);
    return onResume(switched ? picked : undefined);
  };
  useInsertionEffect(() => {
    resumeForAppCommandRef.current = () => void resumeWithComposerModel();
  });
  async function onSubmitPlanFollowUp({
    text,
    context,
    interactionMode: nextInteractionMode,
  }: {
    text: string;
    context?: ReturnType<typeof buildMessageContext>;
    interactionMode: "default" | "plan";
  }) {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !activeThread ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      sendInFlightRef.current
    ) {
      return false;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }

    const sendCtx = composerRef.current?.getSendContext();
    if (
      !projectRouting?.continueCoordinator &&
      (!sendCtx || !sendCtx.providerAvailable || !sendCtx.interactionModeEnabled)
    ) {
      return false;
    }
    const ctxSelectedModelSelection =
      sendCtx?.selectedModelSelection ?? activeThread.modelSelection;

    const threadIdForSend = activeThread.id;
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = projectRouting?.continueCoordinator
      ? trimmed
      : formatOutgoingPrompt({
          provider: sendCtx!.selectedProvider,
          model: sendCtx!.selectedModel,
          models: sendCtx!.selectedProviderModels,
          effort: sendCtx!.selectedPromptEffort,
          text: trimmed,
        });

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    setThreadError(threadIdForSend, null);
    clearThreadAnswerProblem(threadIdForSend);

    // Position this sent row once LegendList has measured the anchored tail.
    isAtEndRef.current = true;
    timelineScrollModeRef.current = "anchoring-new-turn";
    liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
    setTimelineLiveFollowEnabled(true);
    pendingTimelineAnchorRef.current = messageIdForSend;
    activeTimelineAnchorIndexRef.current = null;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    setTimelineAnchor({
      threadKey: scopedThreadKey(scopeThreadRef(activeThread.environmentId, threadIdForSend)),
      messageId: messageIdForSend,
    });

    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        ...(context ? { context } : {}),
        runId: null,
        createdAt: messageCreatedAt,
        updatedAt: messageCreatedAt,
        streaming: false,
      },
    ]);

    const dispatch = async (selectedModel: ModelSelection | undefined) => {
      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        ...(localCheckoutBranchMismatch
          ? { branch: localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode,
        interactionMode: nextInteractionMode,
      });
      let failure: AtomCommandResult<unknown, unknown> | null =
        settingsResult._tag === "Failure" ? settingsResult : null;

      if (failure === null) {
        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(
          scopeThreadRef(activeThread.environmentId, threadIdForSend),
          nextInteractionMode,
        );

        const startResult = await continueWithProjectModel(
          projectRouting,
          selectedModel,
          (currentModel) =>
            startThreadTurn({
              environmentId,
              input: {
                threadId: threadIdForSend,
                message: {
                  messageId: messageIdForSend,
                  role: "user",
                  text: outgoingMessageText,
                  ...(context ? { context } : {}),
                  attachments: [],
                },
                modelSelection: currentModel ?? ctxSelectedModelSelection,
                titleSeed: activeThread.title,
                runtimeMode,
                interactionMode: nextInteractionMode,
                ...(nextInteractionMode === "default" && activeProposedPlan
                  ? {
                      sourceProposedPlan: {
                        threadId: activeThread.id,
                        planId: activeProposedPlan.id,
                      },
                    }
                  : {}),
                createdAt: messageCreatedAt,
              },
            }),
        );
        failure = startResult._tag === "Failure" ? startResult : null;
      }

      return failure;
    };
    const dispatched = await settlePromise(() =>
      continueWithProjectModel(projectRouting, ctxSelectedModelSelection, dispatch),
    );
    const failure = dispatched._tag === "Failure" ? dispatched : dispatched.value;
    if (failure === null) {
      sendInFlightRef.current = false;
      resetLocalDispatch();
      return true;
    }

    setOptimisticUserMessages((existing) =>
      existing.filter((message) => message.id !== messageIdForSend),
    );
    if (!isAtomCommandInterrupted(failure)) {
      const error = squashAtomCommandFailure(failure);
      setThreadError(
        threadIdForSend,
        error instanceof Error ? error.message : "Failed to send plan follow-up.",
      );
    }
    sendInFlightRef.current = false;
    resetLocalDispatch();
    return false;
  }

  const onSend = async (
    e?: { preventDefault: () => void },
    dispatchMode: ComposerDispatchMode = "auto",
    submissionIntent: ComposerSubmissionIntent = "foreground",
    directAnnotation?: {
      annotation: PreviewAnnotationPayload;
      image: ComposerImageAttachment | null;
    },
    manualCodexCreditIntent?: ManualCodexCreditIntent,
  ) => {
    e?.preventDefault();
    if (projectDraftSendGuard.preventSend()) return;
    // Typed out in full rather than picked from the menu. Attachments or contexts
    // mean the user is sending a prompt, so those go through as usual.
    if (
      usageLimitsOffered &&
      usageLimitsKey !== null &&
      !directAnnotation &&
      !composerHasNonPromptContent &&
      isUsageLimitsCommand(promptRef.current)
    ) {
      if (openUsageLimits()) {
        promptRef.current = "";
        setComposerDraftPrompt(composerDraftTarget, "");
        composerRef.current?.resetCursorState();
      }
      return;
    }
    // `/stop`, `/continue`, `/stop-all`, `/continue-all` and `/status` typed out in full
    // run in the app, never as a model turn.
    const appCommand =
      appCommandsOffered && !directAnnotation && !composerHasNonPromptContent
        ? parseComposerAppCommand(promptRef.current)
        : null;
    if (appCommand !== null) {
      promptRef.current = "";
      setComposerDraftPrompt(composerDraftTarget, "");
      composerRef.current?.resetCursorState();
      void runAppCommand(appCommand);
      return;
    }

    if (
      manualCodexCreditIntent &&
      (routesViaCoordinator(projectRouting) ||
        directAnnotation ||
        submissionIntent !== "foreground" ||
        dispatchMode !== "auto" ||
        activePendingProgress ||
        !currentCreditRouteRef.current.allowed)
    ) {
      composerRef.current?.rejectCreditSubmission(
        "Credits require a direct foreground message to the same thread and model.",
      );
      return;
    }

    // A worker's proposed plan is answered where it was proposed, like approvals and questions.
    const answersWorkerPlan =
      !directAnnotation &&
      showPlanFollowUpPrompt &&
      Boolean(activeProposedPlan) &&
      !composerHasNonPromptContent;
    if (
      projectRouting?.continueCoordinator &&
      !activePendingProgress &&
      answersWorkerPlan &&
      activeProposedPlan
    ) {
      const capturedPrompt = promptRef.current;
      const followUp = resolvePlanFollowUpSubmission({
        draftText: capturedPrompt,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      const sent = await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      const currentDraft = useComposerDraftStore.getState().getComposerDraft(composerDraftTarget);
      const changedContent =
        currentDraft &&
        (currentDraft.images.length ||
          currentDraft.files.length ||
          currentDraft.terminalContexts.length ||
          currentDraft.previewAnnotations.length ||
          currentDraft.reviewComments.length ||
          currentDraft.threadContexts.length);
      if (sent && promptRef.current === capturedPrompt && !changedContent) {
        promptRef.current = "";
        clearComposerDraftContent(composerDraftTarget);
        composerRef.current?.resetCursorState();
      }
      return;
    }
    if (routesViaCoordinator(projectRouting) && !activePendingProgress && !answersWorkerPlan) {
      if (sendInFlightRef.current) return;
      sendInFlightRef.current = true;
      await settleAfter(
        async () => {
          await sendProjectComposerDraft({
            routing: projectRouting,
            environmentId,
            draftTarget: composerDraftTarget,
            promptRef,
            supportsAttachmentUploads,
            hasDirectAnnotation: Boolean(directAnnotation),
            resetCursor: () => composerRef.current?.resetCursorState(),
            reportError: (description) =>
              toastManager.add({ type: "error", title: "Project message not sent", description }),
          });
        },
        () => {
          sendInFlightRef.current = false;
        },
      );
      return;
    }

    const notifyDirectAnnotationAttached = () => {
      if (!directAnnotation) return;
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Annotation attached to draft",
          description: "Sending is unavailable right now. Finish the current action, then send.",
        }),
      );
    };
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !activeThread ||
      isSendBusy ||
      isConnecting ||
      isRevertingCheckpoint ||
      !clientSettingsHydrated ||
      threadDetailLoading ||
      environmentChangeRef.current !== null ||
      draftMachinePendingRef.current ||
      sendInFlightRef.current ||
      feedbackUploadsInFlightRef.current.has(routeThreadKey)
    ) {
      notifyDirectAnnotationAttached();
      return;
    }
    if (needsLoadBalancing) {
      toastManager.add({
        type: "warning",
        title: loadBalancing.pending
          ? "Checking machine resources"
          : "Choose a machine to continue",
        description: loadBalancing.pending
          ? "Resource checks are still running. You can choose a machine in the composer."
          : "No eligible machine has available resources. Choose a machine in the composer to override.",
      });
      return;
    }
    if (activeEnvironmentUnavailable) {
      const toastSlot = environmentUnavailableSendToastSlotRef.current;
      environmentUnavailableSendToastSlotRef.current =
        (toastSlot + 1) % ENVIRONMENT_UNAVAILABLE_SEND_TOAST_TRAIL_SIZE;
      toastManager.add({
        ...stackedThreadToast({
          type: "warning",
          ...environmentUnavailableSendToast({
            label: activeEnvironmentUnavailableLabel,
            isThisMachineCatchingUp:
              activeEnvironmentUnavailableState?.isThisMachine === true &&
              isThisMachineCatchingUp(activeEnvironmentUnavailableState.connection.phase),
            continueOn: continueElsewhereTarget?.label ?? null,
          }),
        }),
        id: `chat-send-environment-unavailable:${toastSlot}`,
      });
      return;
    }
    if (activePendingProgress) {
      if (directAnnotation) {
        notifyDirectAnnotationAttached();
        return;
      }
      // Whatever is in the composer answers the question in chat.
      const reply = planQuestionChatReply({
        draft: useComposerDraftStore.getState().getComposerDraft(composerDraftTarget),
        allowCustomAnswer: activePendingProgress.activeQuestion?.allowCustomAnswer,
        supportsQuestionAttachments,
      });
      if (reply.kind === "blocked") {
        if (activeThreadId)
          setAnswerProblem({
            threadId: activeThreadId,
            requestId: activePendingUserInput?.requestId ?? null,
            text: reply.reason,
          });
        else setThreadError(activeThreadId, reply.reason);
        return;
      }
      if (reply.kind === "reply") {
        await onReplyToActivePendingUserInputInChat(reply);
        return;
      }
      onAdvanceActivePendingUserInput();
      return;
    }
    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable) {
      notifyDirectAnnotationAttached();
      return;
    }
    const multipleModelSelections = sendCtx.multipleModelSelections;
    if (
      multipleModelSelections !== null &&
      serverConfig?.environment.capabilities.requiredWorktreeBootstrap !== true
    ) {
      setThreadError(activeThread.id, "Update this server before starting multiple models.");
      return;
    }
    if (
      multipleModelSelections !== null &&
      (!isLocalDraftThread ||
        !isGitRepo ||
        !activeThreadBranch ||
        multipleModelSelections.length === 0)
    ) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Choose models and a base branch",
          description:
            "Multiple models need a new thread in a Git project. Each gets its own worktree.",
        }),
      );
      return;
    }
    const {
      images: sendContextImages,
      files: composerFiles,
      terminalContexts: composerTerminalContexts,
      previewAnnotations: sendContextPreviewAnnotations,
      reviewComments: composerReviewComments,
      threadContexts: composerThreadContexts,
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
      interactionMode: sendInteractionMode,
      interactionModeEnabled: sendInteractionModeEnabled,
    } = sendCtx;
    const capturedCreditContext: CreditSendContext = {
      ...currentCreditRouteRef.current,
      selection: ctxSelectedModelSelection,
      allowed:
        currentCreditRouteRef.current.allowed &&
        !directAnnotation &&
        multipleModelSelections === null &&
        submissionIntent === "foreground" &&
        dispatchMode === "auto" &&
        !/^\s*\/(?:goal|compact)(?:\s|$)/i.test(promptRef.current),
    };
    const creditIntentStillCurrent = () => {
      if (!manualCodexCreditIntent) return true;
      const liveSelection = composerRef.current?.getSendContext().selectedModelSelection;
      if (
        !liveSelection ||
        currentRouteThreadKeyRef.current !== routeThreadKey ||
        environmentChangeRef.current !== null ||
        draftMachinePendingRef.current ||
        !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
      )
        return false;
      if (draftId !== null) {
        const liveDraft = useComposerDraftStore.getState().getDraftSession(draftId);
        if (
          !liveDraft ||
          liveDraft.promotedTo ||
          liveDraft.environmentId !== capturedCreditContext.environmentId ||
          liveDraft.projectId !== capturedCreditContext.projectId ||
          liveDraft.threadId !== capturedCreditContext.threadId
        )
          return false;
      }
      const liveProvider = appAtomRegistry
        .get(environmentServerConfigsAtom)
        .get(environmentId)
        ?.providers.find((provider) => provider.instanceId === manualCodexCreditIntent.instanceId);
      return explicitCreditSendStillMatches(
        manualCodexCreditIntent,
        capturedCreditContext,
        {
          ...currentCreditRouteRef.current,
          selection: liveSelection,
          allowed: currentCreditRouteRef.current.allowed && capturedCreditContext.allowed,
        },
        liveProvider,
      );
    };
    if (!creditIntentStillCurrent()) {
      composerRef.current?.rejectCreditSubmission(
        "Credit availability or the selected draft changed. Send again.",
      );
      setThreadError(
        activeThread.id,
        "Credit availability or the selected draft changed. Send again.",
      );
      return;
    }
    const annotationImageAlreadyAttached =
      directAnnotation?.image !== undefined &&
      sendContextImages.some((image) => image.id === directAnnotation.image?.id);
    const textOnlyModel =
      multipleModelSelections === null &&
      modelRejectsImages(ctxSelectedModel, ctxSelectedProviderModels);
    // A full composer (e.g. 8 files) cannot take the annotation screenshot;
    // over the cap the server rejects the whole turn. A text-only model gets
    // the annotation without its crop.
    const annotationImageAppended =
      directAnnotation?.image !== undefined &&
      !annotationImageAlreadyAttached &&
      !textOnlyModel &&
      sendContextImages.length + composerFiles.length < PROVIDER_SEND_TURN_MAX_ATTACHMENTS;
    const composerImages =
      directAnnotation?.image && annotationImageAppended
        ? [...sendContextImages, directAnnotation.image]
        : sendContextImages;
    // Only images the user can see in the composer block the send.
    const imageBlockReason = textOnlyModel
      ? imageInputBlockReason({
          model: ctxSelectedModel,
          models: ctxSelectedProviderModels,
          imageCount: sendContextImages.length,
        })
      : null;
    if (imageBlockReason !== null) {
      setThreadError(activeThread.id, imageBlockReason);
      return;
    }
    const composerPreviewAnnotations =
      directAnnotation &&
      !sendContextPreviewAnnotations.some(
        (annotation) => annotation.id === directAnnotation.annotation.id,
      )
        ? [
            ...sendContextPreviewAnnotations,
            {
              ...directAnnotation.annotation,
              // Claim an attached crop only when the screenshot really rides
              // along; a cap-dropped image must not produce a lying prompt.
              screenshot:
                directAnnotation.annotation.screenshot &&
                (annotationImageAppended || annotationImageAlreadyAttached)
                  ? { ...directAnnotation.annotation.screenshot, dataUrl: "" }
                  : null,
            },
          ]
        : sendContextPreviewAnnotations;
    // A direct "send annotation" writes the draft and sends in the same tick; the reference
    // must be in the text now, not after the next render.
    const promptForSend = directAnnotation
      ? ensureInlineContextReferences(promptRef.current, [
          previewAnnotationContextReference(directAnnotation.annotation),
        ])
      : promptRef.current;
    if (editingQueuedRun !== null) {
      // Edit mode repurposes the composer: sending saves the queued message
      // in place instead of dispatching a new turn.
      if (queuedEditSaveInFlightRef.current) return;
      const editText = promptForSend.trim();
      const newEditImages = [...composerImages];
      const newEditFiles = [...composerFiles];
      const newEditAttachments = [...newEditImages, ...newEditFiles];
      if (
        editingQueuedRun.existingAttachments.length + newEditAttachments.length >
        PROVIDER_SEND_TURN_MAX_ATTACHMENTS
      ) {
        setThreadError(
          editingQueuedRun.threadId,
          `A message can have at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
        );
        return;
      }
      if (
        editText.length === 0 &&
        editingQueuedRun.existingAttachments.length === 0 &&
        newEditImages.length === 0 &&
        newEditFiles.length === 0
      ) {
        return;
      }
      queuedEditSaveInFlightRef.current = true;
      setIsSavingQueuedEdit(true);
      await settleCaught(
        async () => {
          const uploads = await prepareQueuedEditAttachments({
            existingAttachments: editingQueuedRun.existingAttachments,
            images: newEditImages,
            files: newEditFiles,
            readImage: readFileAsDataUrl,
            uploadFiles: async (files) => {
              const validateFiles = () => {
                const config =
                  appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
                const reason = fileAttachmentCapabilityBlockReason({
                  files,
                  attachmentUploadsCapabilityKnown: config !== null,
                  supportsAttachmentUploads:
                    config?.environment.capabilities.attachmentUploads === true,
                  maxFileAttachmentBytes:
                    config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
                });
                if (reason !== null) throw new Error(reason);
              };
              validateFiles();
              for (const file of files)
                startAttachmentUpload({
                  environmentId,
                  image: file,
                  draftTarget: composerDraftTarget,
                });
              await awaitAttachmentUploads(files.map((file) => file.id));
              validateFiles();
              const uploaded = getUploadedAttachments({ environmentId, images: files });
              if (uploaded === null)
                throw new Error("Retry or remove failed uploads before saving.");
              return uploaded;
            },
          });
          const result = await editQueuedRunCommand({
            environmentId: activeThread.environmentId,
            input: {
              threadId: editingQueuedRun.threadId,
              runId: editingQueuedRun.runId,
              text: editText.length === 0 ? ATTACHMENT_ONLY_BOOTSTRAP_PROMPT : editText,
              edit: {
                messageId: editingQueuedRun.messageId,
                attachments: uploads,
                context: {
                  version: 1,
                  records: [
                    ...new Map(
                      [
                        ...(editingQueuedRun.context?.records ?? []).filter(
                          (record) =>
                            !("attachmentId" in record) ||
                            editingQueuedRun.existingAttachments.some(
                              (attachment) => attachment.id === record.attachmentId,
                            ),
                        ),
                        ...(buildMessageContext({
                          terminalContexts: composerTerminalContexts.filter(
                            (context) => context.text.trim().length > 0,
                          ),
                          reviewComments: composerReviewComments,
                          previewAnnotations: composerPreviewAnnotations,
                          threadContexts: composerThreadContexts,
                          attachments: newEditAttachments.map((attachment, index) => ({
                            attachment,
                            attachmentId:
                              uploads[editingQueuedRun.existingAttachments.length + index]?.id ??
                              attachment.id,
                          })),
                        })?.records ?? []),
                      ].map((record) => [record.contextId, record] as const),
                    ).values(),
                  ],
                },
              },
            },
          });
          if (result._tag === "Failure") {
            setThreadError(editingQueuedRun.threadId, "Could not save the edited queued message.");
            return;
          }
          setThreadError(editingQueuedRun.threadId, null);
          releaseDraftAttachments(newEditAttachments);
          promptRef.current = "";
          clearComposerDraftContent(queuedEditDraftTargetFor(editingQueuedRun.runId));
          composerRef.current?.resetCursorState();
          setEditingQueuedRun(null);
          scheduleComposerFocus();
        },
        (error) => {
          setThreadError(
            editingQueuedRun.threadId,
            error instanceof Error ? error.message : "Could not save the edited queued message.",
          );
        },
        () => {
          queuedEditSaveInFlightRef.current = false;
          setIsSavingQueuedEdit(false);
        },
      );
      return;
    }
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length + composerFiles.length,
      terminalContexts: composerTerminalContexts,
      elementContextCount:
        composerPreviewAnnotations.length +
        composerReviewComments.length +
        composerThreadContexts.length,
    });
    const feedbackCommand =
      ctxSelectedProvider === "codex" &&
      composerImages.length === 0 &&
      composerFiles.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      composerPreviewAnnotations.length === 0 &&
      composerReviewComments.length === 0 &&
      composerThreadContexts.length === 0
        ? parseCodexFeedbackCommand(trimmed)
        : null;
    if (feedbackCommand && multipleModelSelections === null) {
      if (!isServerThread || activeThread.activeProviderThreadId === null) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Start a Codex thread first",
            description: "Send a message before you submit feedback.",
          }),
        );
        return;
      }
      feedbackUploadsInFlightRef.current.add(routeThreadKey);
      await submitCodexFeedback({
        submission: {
          id: newMessageId(),
          command: trimmed,
          createdAt: new Date().toISOString(),
        },
        clearDraft: () => {
          promptRef.current = "";
          clearComposerDraftContent(composerDraftTarget);
          composerRef.current?.resetCursorState();
        },
        onUpdate: (submission) => {
          setFeedbackSubmissionsByThreadKey((current) => {
            const existing = current[routeThreadKey] ?? [];
            const found = existing.some((entry) => entry.id === submission.id);
            return {
              ...current,
              [routeThreadKey]: found
                ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
                : [...existing, submission],
            };
          });
        },
        upload: () =>
          uploadThreadFeedback({
            environmentId: activeThread.environmentId,
            input: { threadId: activeThread.id, ...feedbackCommand },
          }),
      }).finally(() => {
        feedbackUploadsInFlightRef.current.delete(routeThreadKey);
      });

      return;
    }
    if (
      !directAnnotation &&
      sendInteractionModeEnabled &&
      showPlanFollowUpPrompt &&
      activeProposedPlan &&
      composerImages.length === 0 &&
      composerFiles.length === 0
    ) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: promptForSend,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      const outgoingFollowUpText = formatOutgoingPrompt({
        provider: ctxSelectedProvider,
        model: ctxSelectedModel,
        models: ctxSelectedProviderModels,
        effort: ctxSelectedPromptEffort,
        text: followUp.text.trim(),
      });
      if (composerRef.current?.validateProviderInput(outgoingFollowUpText) === false) {
        return;
      }
      // The composer is cleared before the send resolves, so hold everything it carried: a
      // transient failure must give the prose and its context back, as the ordinary send does.
      // Snapshot exactly what was sent, copied, so later mutations cannot alias the backup.
      const followUpPromptSnapshot = promptRef.current;
      const followUpTerminalContexts = [...sendableComposerTerminalContexts];
      const followUpReviewComments = [...composerReviewComments];
      const followUpPreviewAnnotations = [...composerPreviewAnnotations];
      const followUpThreadContexts = [...composerThreadContexts];
      promptRef.current = "";
      const releaseFollowUpHostDraft = holdDurableThreadDraft(composerDraftTarget);
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      const followUpSent = await onSubmitPlanFollowUp({
        text: followUp.text,
        context: buildMessageContext({
          terminalContexts: sendableComposerTerminalContexts,
          reviewComments: composerReviewComments,
          previewAnnotations: composerPreviewAnnotations,
          threadContexts: composerThreadContexts,
        }),
        interactionMode: followUp.interactionMode,
      });
      if (!followUpSent) {
        promptRef.current = followUpPromptSnapshot;
        composerTerminalContextsRef.current = [...followUpTerminalContexts];
        restorePlanFollowUpComposer({
          snapshot: {
            prompt: followUpPromptSnapshot,
            terminalContexts: followUpTerminalContexts,
            reviewComments: followUpReviewComments,
            previewAnnotations: followUpPreviewAnnotations,
            threadContexts: followUpThreadContexts,
          },
          writePrompt: (prompt) => setComposerDraftPrompt(composerDraftTarget, prompt),
          writeTerminalContexts: (contexts) =>
            setComposerDraftTerminalContexts(composerDraftTarget, [...contexts]),
          writeReviewComments: (comments) =>
            setComposerDraftReviewComments(composerDraftTarget, [...comments]),
          writePreviewAnnotations: (annotations) =>
            setComposerDraftPreviewAnnotations(composerDraftTarget, [...annotations]),
          writeThreadContexts: (records) =>
            setComposerDraftThreadContexts(composerDraftTarget, [...records]),
          resetCursor: (options) => composerRef.current?.resetCursorState(options),
        });
      } else if (
        submissionIntent === "background" &&
        currentRouteThreadKeyRef.current === routeThreadKey
      ) {
        handleNewThreadInActiveProject();
      }
      releaseFollowUpHostDraft();
      return;
    }
    // Providers without the legacy toggle receive their native commands unchanged.
    const standaloneSlashCommand =
      sendInteractionModeEnabled &&
      composerImages.length === 0 &&
      composerFiles.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      composerPreviewAnnotations.length === 0 &&
      composerReviewComments.length === 0 &&
      composerThreadContexts.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand && multipleModelSelections === null) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      return;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: toastCopy.title,
            description: toastCopy.description,
          }),
        );
      }
      return;
    }
    if (!activeProject) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Choose a project first",
          description: "This draft no longer points to an available project.",
        }),
      );
      return;
    }
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || activeMessageCount === 0;
    const baseBranchForWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath
        ? activeThreadBranch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath;
    if (shouldCreateWorktree && !activeThreadBranch) {
      setThreadError(threadIdForSend, "Select a base branch before sending in New worktree mode.");
      return;
    }

    const composerImagesSnapshot = [...composerImages];
    const composerFilesSnapshot = [...composerFiles];
    const composerAttachmentsSnapshot = [...composerImagesSnapshot, ...composerFilesSnapshot];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const composerPreviewAnnotationsSnapshot = [...composerPreviewAnnotations];
    const composerReviewCommentsSnapshot: ReviewCommentContext[] = [...composerReviewComments];
    const composerThreadContextsSnapshot = [...composerThreadContexts];
    // Expired terminal excerpts are not sent; their chips leave the text with them.
    const messageTextForSend = composerTerminalContexts
      .filter((context) => !composerTerminalContextsSnapshot.includes(context))
      .reduce(
        (text, context) =>
          removeInlineContextReference(text, terminalContextReference(context).contextId).prompt,
        promptForSend,
      )
      .trim();
    // Records bind attachments by the id each side knows: the local id for the optimistic
    // row, the upload id (or local id on the data-URL path) on the wire; the server
    // rebinds them to the persisted id.
    const buildOutgoingMessageContext = (attachmentIds: ReadonlyArray<string>) =>
      buildMessageContext({
        terminalContexts: composerTerminalContextsSnapshot,
        reviewComments: composerReviewCommentsSnapshot,
        previewAnnotations: composerPreviewAnnotationsSnapshot,
        threadContexts: composerThreadContextsSnapshot,
        attachments: composerAttachmentsSnapshot.map((attachment, index) => ({
          attachment,
          attachmentId: attachmentIds[index] ?? attachment.id,
        })),
      });
    const outgoingMessageContext = buildOutgoingMessageContext(
      composerAttachmentsSnapshot.map((attachment) => attachment.id),
    );
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const shouldQueueBehindActiveRun = phase === "running" && dispatchMode === "queue";
    const outgoingMessageText = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: messageTextForSend || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    });
    if (composerRef.current?.validateProviderInput(outgoingMessageText) === false) {
      return;
    }

    const readLiveAttachmentCapabilities = () => {
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
      const liveSupportsAttachmentUploads =
        config?.environment.capabilities.attachmentUploads === true;
      return {
        supportsAttachmentUploads: liveSupportsAttachmentUploads,
        fileBlockReason: fileAttachmentCapabilityBlockReason({
          files: composerFilesSnapshot,
          attachmentUploadsCapabilityKnown: config !== null,
          supportsAttachmentUploads: liveSupportsAttachmentUploads,
          maxFileAttachmentBytes:
            config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
        }),
      };
    };

    const multipleTargets: Array<{
      selection: ReturnType<typeof createModelSelection>;
      text: string;
      interactionMode: ReturnType<typeof resolveComposerInteractionMode>["interactionMode"];
    }> = [];
    for (const selection of multipleModelSelections ?? []) {
      const provider = providerInstanceEntries.find(
        (entry) => entry.instanceId === selection.instanceId,
      );
      if (!provider?.enabled || !provider.isAvailable || provider.status !== "ready") {
        setThreadError(threadIdForSend, `Provider for ${selection.model} is unavailable.`);
        return;
      }
      const providerBlockReason = getAntigravitySendBlockReason(provider.snapshot, selection.model);
      if (providerBlockReason) {
        setThreadError(threadIdForSend, providerBlockReason);
        return;
      }
      const providerState = getComposerProviderState({
        provider: provider.driverKind,
        model: selection.model,
        models: provider.models,
        modelOptions: selection.options,
        promptInjectionState: getComposerPromptInjectionState(messageTextForSend),
        planModeEnabled: settings.planModeEnabled,
      });
      const text = formatOutgoingPrompt({
        provider: provider.driverKind,
        model: selection.model,
        models: provider.models,
        effort: providerState.promptEffort,
        text: messageTextForSend || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      });
      if (composerRef.current?.validateProviderInput(text) === false) return;
      multipleTargets.push({
        selection: createModelSelection(
          selection.instanceId,
          selection.model,
          providerState.modelOptionsForDispatch,
        ),
        text,
        interactionMode: resolveComposerInteractionMode({
          planModeEnabled: settings.planModeEnabled,
          provider: provider.snapshot,
          interactionMode: sendInteractionMode,
        }).interactionMode,
      });
    }

    sendInFlightRef.current = true;
    const sendGeneration = ++composerSendGenerationRef.current;
    const attachmentCapabilitiesBeforeUpload = readLiveAttachmentCapabilities();
    if (attachmentCapabilitiesBeforeUpload.fileBlockReason !== null) {
      sendInFlightRef.current = false;
      setThreadError(threadIdForSend, attachmentCapabilitiesBeforeUpload.fileBlockReason);
      return;
    }
    const turnUsesAttachmentUploads =
      composerFilesSnapshot.length > 0
        ? attachmentCapabilitiesBeforeUpload.supportsAttachmentUploads
        : supportsAttachmentUploads;
    if (turnUsesAttachmentUploads && composerAttachmentsSnapshot.length > 0) {
      for (const attachment of composerAttachmentsSnapshot) {
        startAttachmentUpload({
          environmentId,
          image: attachment,
          draftTarget: composerDraftTarget,
        });
      }
      await awaitAttachmentUploads(composerAttachmentsSnapshot.map((attachment) => attachment.id));
      const attachmentCapabilitiesAfterUpload = readLiveAttachmentCapabilities();
      if (attachmentCapabilitiesAfterUpload.fileBlockReason !== null) {
        sendInFlightRef.current = false;
        setThreadError(threadIdForSend, attachmentCapabilitiesAfterUpload.fileBlockReason);
        return;
      }
      if (getUploadedAttachments({ environmentId, images: composerAttachmentsSnapshot }) === null) {
        sendInFlightRef.current = false;
        setThreadError(threadIdForSend, "Retry or remove failed uploads before sending.");
        return;
      }
    }

    if (
      multipleModelSelections === null &&
      shouldDockDraftHeroForSubmission({ isDraftHeroState, activeThreadKey, submissionIntent }) &&
      activeThreadKey
    ) {
      let resolveDockStarted: (() => void) | undefined;
      const dockStarted = new Promise<void>((resolve) => {
        resolveDockStarted = resolve;
      });
      const dockTransition = runMobileComposerTransition(
        () => {
          flushSync(() => {
            captureDraftHeroComposerRect();
            setDockedDraftHeroThreadKey(activeThreadKey);
          });
          resolveDockStarted?.();
        },
        {
          active: panelAnimationsActive,
          durationMs: panelAnimationDurationMs,
        },
      );
      void dockTransition.catch(() => resolveDockStarted?.());
      await dockStarted;
    }

    const attachmentCapabilitiesBeforeDispatch = readLiveAttachmentCapabilities();
    if (!creditIntentStillCurrent()) {
      sendInFlightRef.current = false;
      setThreadError(
        threadIdForSend,
        "Credit availability or the selected draft changed. Send again.",
      );
      setDockedDraftHeroThreadKey((current) => (current === activeThreadKey ? null : current));
      return;
    }
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      attachmentCapabilitiesBeforeDispatch.fileBlockReason !== null
    ) {
      sendInFlightRef.current = false;
      setThreadError(
        threadIdForSend,
        attachmentCapabilitiesBeforeDispatch.fileBlockReason ??
          "This connection cannot change threads.",
      );
      setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === activeThreadKey ? null : currentThreadKey,
      );
      return;
    }
    beginLocalDispatch({
      preparingWorktree: multipleModelSelections !== null || Boolean(baseBranchForWorktree),
      // Only a draft has a background submission to hide behind its hero.
      submissionIntent:
        submissionIntent === "background" && !isLocalDraftThread ? "foreground" : submissionIntent,
    });
    setWorktreeSetupThread(
      multipleModelSelections === null && baseBranchForWorktree
        ? {
            environmentId: activeThread.environmentId,
            threadId: threadIdForSend,
            ownerKey: worktreeSetupOwnerKey,
          }
        : null,
    );

    const turnAttachmentsPromise = Promise.all(
      composerAttachmentsSnapshot.map(async (attachment) => {
        if (turnUsesAttachmentUploads) {
          const uploaded = getUploadedAttachments({ environmentId, images: [attachment] })?.[0];
          if (!uploaded) {
            throw new Error(`Attachment '${attachment.name}' did not finish uploading.`);
          }
          return uploaded;
        }
        if (attachment.type !== "image") {
          throw new Error("This server does not support file attachments.");
        }
        return {
          type: "image" as const,
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          dataUrl: await readFileAsDataUrl(attachment.file),
          ...(attachment.source ? { source: attachment.source } : {}),
        };
      }),
    );
    if (multipleModelSelections !== null) {
      const failedSelections: ModelSelection[] = [];
      let clearedDraft = false;
      // The host keeps the draft until the starts settle or the composer is restored.
      let releaseHostDraft = () => {};
      let releasedComposer = false;
      let canRestoreDraft = () => false;
      let startedCount = 0;
      await settleCaught(
        async () => {
          const attachments = await turnAttachmentsPromise;
          const fileBlockReason = readLiveAttachmentCapabilities().fileBlockReason;
          if (fileBlockReason !== null) throw new Error(fileBlockReason);
          const context = buildOutgoingMessageContext(
            attachments.map((attachment, index) =>
              "id" in attachment && attachment.id !== undefined
                ? attachment.id
                : composerAttachmentsSnapshot[index]!.id,
            ),
          );
          const title = truncate(
            assistantCitationsToPlainText(stripInlineContextReferences(trimmed)).trim() ||
              composerAttachmentsSnapshot[0]?.name ||
              "New thread",
          );
          promptRef.current = "";
          releaseHostDraft = holdDurableThreadDraft(composerDraftTarget);
          clearComposerDraftContent(composerDraftTarget);
          composerRef.current?.resetCursorState();
          clearedDraft = true;
          const clearedDraftSnapshot = useComposerDraftStore
            .getState()
            .getComposerDraft(composerDraftTarget);
          const submittedSelections = multipleModelSelectionsRef.current;
          canRestoreDraft = () =>
            currentRouteThreadKeyRef.current === routeThreadKey &&
            composerSendGenerationRef.current === sendGeneration &&
            useComposerDraftStore.getState().getComposerDraft(composerDraftTarget) ===
              clearedDraftSnapshot &&
            multipleModelSelectionsRef.current === submittedSelections;
          setThreadError(threadIdForSend, null);
          clearThreadAnswerProblem(threadIdForSend);
          const starts = Promise.all(
            multipleTargets.map(async (target) => {
              const retryKey = JSON.stringify([
                routeThreadKey,
                target.selection.instanceId,
                target.selection.model,
              ]);
              const uncertainThreadId = uncertainMultipleSubmissionsRef.current.get(retryKey);
              const targetThreadId = uncertainThreadId ?? newThreadId();
              let requestMayHaveStarted = false;
              await settleCaught(
                async () => {
                  if (uncertainThreadId) {
                    throw new Error(
                      "The previous request may have started. Open its thread to check before sending again.",
                    );
                  }
                  const supportsInlineMessageContext =
                    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)
                      ?.environment.capabilities.inlineMessageContext === true;
                  requestMayHaveStarted = true;
                  const result = await startThreadTurn({
                    environmentId,
                    input: {
                      threadId: targetThreadId,
                      message: {
                        messageId: newMessageId(),
                        role: "user",
                        text:
                          context && !supportsInlineMessageContext
                            ? serializeLegacyContextMessage({
                                text: target.text,
                                records: context.records,
                              })
                            : target.text,
                        attachments,
                        ...(context && supportsInlineMessageContext ? { context } : {}),
                      },
                      modelSelection: target.selection,
                      titleSeed: title,
                      runtimeMode,
                      interactionMode: target.interactionMode,
                      bootstrap: {
                        createThread: {
                          projectId: activeProject.id,
                          title,
                          modelSelection: target.selection,
                          runtimeMode,
                          interactionMode: target.interactionMode,
                          branch: activeThreadBranch,
                          worktreePath: null,
                          createdAt: messageCreatedAt,
                        },
                        prepareWorktree: {
                          projectCwd: activeProject.workspaceRoot,
                          baseBranch: activeThreadBranch!,
                          requireWorktree: true,
                          ...(startFromOrigin ? { startFromOrigin: true } : {}),
                        },
                        runSetupScript: true,
                      },
                      createdAt: messageCreatedAt,
                    },
                  });
                  if (result._tag === "Failure") {
                    const error = squashAtomCommandFailure(result);
                    if (wasBootstrapThreadDeleted(error) || wasBootstrapThreadNotCreated(error)) {
                      requestMayHaveStarted = false;
                    }
                    throw error;
                  }
                  startedCount += 1;
                },
                (error) => {
                  if (
                    requestMayHaveStarted &&
                    !uncertainMultipleSubmissionsRef.current.has(retryKey)
                  ) {
                    uncertainMultipleSubmissionsRef.current.set(retryKey, targetThreadId);
                  }
                  failedSelections.push(target.selection);
                  const retainedThreadId = uncertainMultipleSubmissionsRef.current.get(retryKey);
                  const failureToastId = toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: `Could not start ${target.selection.model}`,
                      description:
                        error instanceof Error ? error.message : "Failed to send message.",
                      ...(retainedThreadId
                        ? {
                            timeout: 0,
                            data: {
                              secondaryActionProps: {
                                children: "Allow retry",
                                onClick: () => {
                                  void readLocalApi()
                                    ?.dialogs.confirm(
                                      "The previous request may already be running. Check its thread first. Allow another send that could create a duplicate thread?",
                                    )
                                    .then(
                                      (confirmed) => {
                                        if (
                                          confirmed &&
                                          uncertainMultipleSubmissionsRef.current.get(retryKey) ===
                                            retainedThreadId
                                        ) {
                                          uncertainMultipleSubmissionsRef.current.delete(retryKey);
                                          toastManager.close(failureToastId);
                                        }
                                      },
                                      () => undefined,
                                    );
                                },
                              },
                            },
                            actionProps: {
                              children: "Open thread",
                              onClick: () => {
                                void openThreadRoute(
                                  scopeThreadRef(environmentId, retainedThreadId),
                                );
                              },
                            },
                          }
                        : {}),
                    }),
                  );
                },
                () => {},
              );
            }),
          );
          // Each request now owns its background thread. The original draft is
          // ready for another prompt while checkout and setup scripts finish.
          sendInFlightRef.current = false;
          resetLocalDispatch();
          releasedComposer = true;
          await starts;
          if (startedCount > 0) {
            toastManager.add(
              stackedThreadToast({
                type: "success",
                title: `Started ${startedCount} ${startedCount === 1 ? "thread" : "threads"} in background`,
              }),
            );
          }
          if (failedSelections.length === 0 && turnUsesAttachmentUploads) {
            releaseDraftAttachments(composerAttachmentsSnapshot);
          }
        },
        (error) => {
          failedSelections.push(...multipleModelSelections);
          setThreadError(
            threadIdForSend,
            error instanceof Error ? error.message : "Failed to send messages.",
          );
        },
        () => {
          const restoreFailedDraft = () => {
            setMultipleModelSelections(failedSelections);
            if (clearedDraft) {
              setComposerDraftPrompt(composerDraftTarget, messageTextForSend);
              addComposerDraftImages(
                composerDraftTarget,
                composerImagesSnapshot.map(cloneComposerImageForRetry),
              );
              addComposerDraftFiles(composerDraftTarget, composerFilesSnapshot);
              setComposerDraftTerminalContexts(
                composerDraftTarget,
                composerTerminalContextsSnapshot,
              );
              setComposerDraftPreviewAnnotations(
                composerDraftTarget,
                composerPreviewAnnotationsSnapshot,
              );
              setComposerDraftReviewComments(composerDraftTarget, composerReviewCommentsSnapshot);
              setComposerDraftThreadContexts(composerDraftTarget, composerThreadContextsSnapshot);
              if (composerRef.current && currentRouteThreadKeyRef.current === routeThreadKey) {
                promptRef.current = messageTextForSend;
                composerRef.current.resetCursorState({
                  cursor: collapseExpandedComposerCursor(
                    messageTextForSend,
                    messageTextForSend.length,
                  ),
                  prompt: messageTextForSend,
                  detectTrigger: true,
                });
              }
            }
          };
          if (failedSelections.length > 0) {
            if (canRestoreDraft() && composerRef.current) {
              restoreFailedDraft();
            } else if (clearedDraft) {
              const recoveryToastId = toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "A background prompt could not be sent",
                  description:
                    "Your newer draft is unchanged. Restore the failed prompt when this composer is empty.",
                  timeout: 0,
                  actionProps: {
                    children: "Restore prompt",
                    onClick: () => {
                      if (
                        !draftId ||
                        !useComposerDraftStore.getState().getDraftSession(draftId) ||
                        sendInFlightRef.current ||
                        composerDraftHasUserContent(
                          useComposerDraftStore.getState().getComposerDraft(composerDraftTarget),
                        )
                      ) {
                        toastManager.update(recoveryToastId, {
                          description:
                            "Return to the original draft and send or clear its current prompt before restoring.",
                        });
                        return;
                      }
                      restoreFailedDraft();
                      void navigate({ to: "/draft/$draftId", params: { draftId } });
                      toastManager.close(recoveryToastId);
                    },
                  },
                }),
              );
            }
          }
          releaseHostDraft();
          if (!releasedComposer) {
            sendInFlightRef.current = false;
            resetLocalDispatch();
          }
        },
      );
      return;
    }
    const optimisticAttachments = composerAttachmentsSnapshot.map((attachment) =>
      attachment.type === "image"
        ? {
            type: "image" as const,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            previewUrl: attachment.previewUrl,
            ...(attachment.source ? { source: attachment.source } : {}),
          }
        : {
            type: "file" as const,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            downloadable: false,
            ...(attachment.source ? { source: attachment.source } : {}),
          },
    );
    if (!shouldQueueBehindActiveRun) {
      // A sent turn returns to the live edge and anchors its new transcript
      // row. Queued input stays in the composer queue and must not move the
      // timeline away from the provider work already in flight.
      isAtEndRef.current = true;
      timelineScrollModeRef.current = "anchoring-new-turn";
      liveFollowUserScrollGenerationRef.current = anchorUserScrollGenerationRef.current;
      setTimelineLiveFollowEnabled(true);
      pendingTimelineAnchorRef.current = messageIdForSend;
      activeTimelineAnchorIndexRef.current = null;
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      setTimelineAnchor({
        threadKey: scopedThreadKey(scopeThreadRef(activeThread.environmentId, threadIdForSend)),
        messageId: messageIdForSend,
      });
    }
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        ...(outgoingMessageContext !== undefined ? { context: outgoingMessageContext } : {}),
        runId: null,
        createdAt: messageCreatedAt,
        updatedAt: messageCreatedAt,
        streaming: false,
        ...(shouldQueueBehindActiveRun
          ? { inputIntent: "queued_turn" as const }
          : phase === "running" && dispatchMode === "steer"
            ? { inputIntent: "steer" as const }
            : {}),
      },
    ]);
    setThreadError(threadIdForSend, null);
    clearThreadAnswerProblem(threadIdForSend);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        }),
      );
    }
    promptRef.current = "";
    // The host keeps the draft until the turn starts, or the composer is restored.
    const releaseHostDraft = holdDurableThreadDraft(composerDraftTarget);
    clearComposerDraftContent(composerDraftTarget);
    composerRef.current?.resetCursorState();

    let firstComposerImageName: string | null = null;
    if (composerImagesSnapshot.length > 0) {
      const firstComposerImage = composerImagesSnapshot[0];
      if (firstComposerImage) {
        firstComposerImageName = firstComposerImage.name;
      }
    }
    let titleSeed = assistantCitationsToPlainText(stripInlineContextReferences(trimmed)).trim();
    if (!titleSeed) {
      if (firstComposerImageName) {
        titleSeed = `Image: ${firstComposerImageName}`;
      } else if (composerFilesSnapshot[0]) {
        titleSeed = `File: ${composerFilesSnapshot[0].name}`;
      } else if (composerTerminalContextsSnapshot.length > 0) {
        titleSeed = formatTerminalContextLabel(composerTerminalContextsSnapshot[0]!);
      } else if (composerReviewCommentsSnapshot.length > 0) {
        titleSeed = `Review: ${reviewCommentContextLabel(composerReviewCommentsSnapshot[0]!)}`;
      } else if (composerPreviewAnnotationsSnapshot.length > 0) {
        titleSeed = previewAnnotationContextLabel(composerPreviewAnnotationsSnapshot[0]!);
      } else {
        titleSeed = "New thread";
      }
    }
    const title = truncate(titleSeed);
    const threadCreateModelSelection = createModelSelection(
      ctxSelectedModelSelection.instanceId,
      ctxSelectedModel || activeProjectDefaultModelSelection?.model || DEFAULT_MODEL,
      ctxSelectedModelSelection.options,
    );

    let failure: AtomCommandResult<unknown, unknown> | null = null;

    if (failure === null && isServerThread && creditIntentStillCurrent()) {
      const settingsResult = await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        ...(localCheckoutBranchMismatch
          ? { branch: localCheckoutBranchMismatch.currentBranch }
          : {}),
        runtimeMode,
        interactionMode: sendInteractionMode,
      });
      if (settingsResult._tag === "Failure") {
        failure = settingsResult;
      }
    }

    const turnAttachmentsResult = await settlePromise(async () => {
      const turnAttachments = await turnAttachmentsPromise;
      if (!creditIntentStillCurrent()) {
        throw new Error("Credit availability or the selected draft changed. Send again.");
      }
      const liveFileBlockReason = readLiveAttachmentCapabilities().fileBlockReason;
      if (liveFileBlockReason !== null) {
        throw new Error(liveFileBlockReason);
      }
      return turnAttachments;
    });
    if (failure === null && turnAttachmentsResult._tag === "Failure") {
      failure = turnAttachmentsResult;
    }

    let backgroundDraftOpened = false;
    let turnStartSucceeded = false;
    if (failure === null && turnAttachmentsResult._tag === "Success") {
      const bootstrap =
        isLocalDraftThread || baseBranchForWorktree
          ? {
              ...(isLocalDraftThread
                ? {
                    createThread: {
                      projectId: activeProject.id,
                      title,
                      modelSelection: threadCreateModelSelection,
                      runtimeMode,
                      interactionMode: sendInteractionMode,
                      branch: activeThreadBranch,
                      worktreePath: activeThread.worktreePath,
                      createdAt: activeThread.createdAt,
                    },
                  }
                : {}),
              ...(baseBranchForWorktree
                ? {
                    prepareWorktree: {
                      projectCwd: activeProject.workspaceRoot,
                      baseBranch: baseBranchForWorktree,
                      ...(startFromOrigin ? { startFromOrigin: true } : {}),
                    },
                    runSetupScript: true,
                  }
                : {}),
            }
          : undefined;
      const backgroundThreadRef =
        submissionIntent === "background" && isLocalDraftThread
          ? scopeThreadRef(environmentId, threadIdForSend)
          : null;
      if (backgroundThreadRef) beginBackgroundDraftSubmissionByRef(backgroundThreadRef);
      const commandIdForSend = CommandId.make(randomUUID());
      const startPromise = !creditIntentStillCurrent()
        ? settlePromise(async () => {
            throw new Error("Credit availability or the selected draft changed. Send again.");
          })
        : retryTransientSend(
            // One command id for every attempt: the server drops a repeat.
            () =>
              startThreadTurn({
                environmentId,
                input: {
                  commandId: commandIdForSend,
                  threadId: threadIdForSend,
                  message: {
                    messageId: messageIdForSend,
                    role: "user",
                    text: outgoingMessageText,
                    attachments: turnAttachmentsResult.value,
                    ...(() => {
                      const context = buildOutgoingMessageContext(
                        turnAttachmentsResult.value.map((attachment, index) =>
                          "id" in attachment && attachment.id !== undefined
                            ? attachment.id
                            : composerAttachmentsSnapshot[index]!.id,
                        ),
                      );
                      if (context === undefined) return {};
                      // Read the capability at dispatch time: the upload and persistence
                      // awaits above can span a server reconnect that changes it. Servers
                      // from before inline context drop the records and forward the links
                      // as literal text, so their turns carry the payload the legacy way.
                      const supportsInlineMessageContext =
                        appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)
                          ?.environment.capabilities.inlineMessageContext === true;
                      if (!supportsInlineMessageContext) {
                        return {
                          text: serializeLegacyContextMessage({
                            text: outgoingMessageText,
                            records: context.records,
                          }),
                        };
                      }
                      return { context };
                    })(),
                  },
                  modelSelection: ctxSelectedModelSelection,
                  titleSeed: title,
                  runtimeMode,
                  interactionMode: sendInteractionMode,
                  dispatchMode,
                  ...(manualCodexCreditIntent ? { manualCodexCreditIntent } : {}),
                  ...(bootstrap ? { bootstrap } : {}),
                  createdAt: messageCreatedAt,
                },
              }),
            {
              // A host that is restarting (an update) takes the send once it is back.
              waitForHost: () => whenHostReady(environmentId, { cancelled: false }),
            },
          );
      if (backgroundThreadRef) {
        markPromotedDraftThreadByRef(backgroundThreadRef);
        try {
          backgroundDraftOpened = await openBackgroundChatComposer(
            openNewChatDestination,
            scopeProjectRef(activeProject.environmentId, activeProject.id),
            resolveBackgroundDraftWorkspaceOptions({
              envMode: sendEnvMode,
              branch: activeThreadBranch,
              startFromOrigin,
            }),
          );
        } catch (error) {
          clearBackgroundDraftSubmissionByRef(backgroundThreadRef);
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "Could not open a fresh composer",
              description: error instanceof Error ? error.message : undefined,
            }),
          );
        }
      }
      const startResult = await startPromise;
      if (startResult._tag === "Failure") {
        failure = startResult;
      } else {
        turnStartSucceeded = true;
        // The turn is under way and will spend quota, so that thread's limits
        // snapshot is stale. Uploads may have outlasted a navigation, so only
        // the sending thread's panel clears.
        clearUsageLimitsFor(routeThreadKey);
        if (turnUsesAttachmentUploads) {
          releaseDraftAttachments(composerAttachmentsSnapshot);
        }
        acknowledgeActiveThreadWoke();
        if (backgroundThreadRef) {
          if (backgroundDraftOpened || currentRouteThreadKeyRef.current !== routeThreadKey) {
            finalizePromotedDraftThreadByRef(backgroundThreadRef);
          } else {
            clearBackgroundDraftSubmissionByRef(backgroundThreadRef);
          }
          if (backgroundDraftOpened) {
            toastManager.add(
              stackedThreadToast({
                type: "success",
                title: "Started in background",
                timeout: 5_000,
                actionProps: {
                  children: "Open",
                  onClick: () => {
                    void openThreadRoute(backgroundThreadRef);
                  },
                },
              }),
            );
          }
        } else if (
          submissionIntent === "background" &&
          currentRouteThreadKeyRef.current === routeThreadKey
        ) {
          // An existing thread keeps running; open a fresh composer like a draft does.
          handleNewThreadInActiveProject();
        }
      }
    }

    if (failure !== null) {
      if (submissionIntent === "background" && draftId && draftThread) {
        restoreFailedBackgroundDraftThread(
          draftId,
          draftThread,
          wasBootstrapThreadDeleted(squashAtomCommandFailure(failure))
            ? newThreadId()
            : threadIdForSend,
        );
        clearBackgroundDraftSubmissionByRef(scopeThreadRef(environmentId, threadIdForSend));
      }
      // A message that was not delivered never stays on screen as if it were.
      setOptimisticUserMessages((existing) => {
        const removed = existing.filter((message) => message.id === messageIdForSend);
        for (const message of removed) {
          revokeUserMessagePreviewUrls(message);
        }
        const next = existing.filter((message) => message.id !== messageIdForSend);
        return next.length === existing.length ? existing : next;
      });
      const composerIsEmpty = backgroundDraftOpened
        ? !composerDraftHasUserContent(
            useComposerDraftStore.getState().getComposerDraft(composerDraftTarget),
          )
        : promptRef.current.length === 0 &&
          composerImagesRef.current.length === 0 &&
          composerFilesRef.current.length === 0 &&
          composerTerminalContextsRef.current.length === 0 &&
          (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)
            ?.previewAnnotations.length ?? 0) === 0 &&
          (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.reviewComments
            .length ?? 0) === 0 &&
          (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.threadContexts
            .length ?? 0) === 0;
      if (!composerIsEmpty && !backgroundDraftOpened) {
        // Typed more while it was sending: put the failed message first, keep the rest.
        const current =
          useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.prompt ??
          promptRef.current;
        const merged = current.trim() ? `${messageTextForSend}\n\n${current}` : messageTextForSend;
        promptRef.current = merged;
        setComposerDraftPrompt(composerDraftTarget, merged);
        addComposerDraftImages(
          composerDraftTarget,
          composerImagesSnapshot.map(cloneComposerImageForRetry),
        );
        addComposerDraftFiles(composerDraftTarget, composerFilesSnapshot);
        composerRef.current?.resetCursorState({
          cursor: collapseExpandedComposerCursor(merged, merged.length),
          prompt: merged,
          detectTrigger: false,
        });
      }
      if (composerIsEmpty) {
        promptRef.current = messageTextForSend;
        const retryComposerImages = composerImagesSnapshot.map(cloneComposerImageForRetry);
        composerImagesRef.current = retryComposerImages;
        composerFilesRef.current = composerFilesSnapshot;
        composerTerminalContextsRef.current = composerTerminalContextsSnapshot;
        setComposerDraftPrompt(composerDraftTarget, messageTextForSend);
        addComposerDraftImages(composerDraftTarget, retryComposerImages);
        addComposerDraftFiles(composerDraftTarget, composerFilesSnapshot);
        setComposerDraftTerminalContexts(composerDraftTarget, composerTerminalContextsSnapshot);
        setComposerDraftPreviewAnnotations(composerDraftTarget, composerPreviewAnnotationsSnapshot);
        setComposerDraftReviewComments(composerDraftTarget, composerReviewCommentsSnapshot);
        setComposerDraftThreadContexts(composerDraftTarget, composerThreadContextsSnapshot);
        composerRef.current?.resetCursorState({
          cursor: collapseExpandedComposerCursor(messageTextForSend, messageTextForSend.length),
          prompt: messageTextForSend,
          detectTrigger: true,
        });
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : "Failed to send message.",
        );
        if (backgroundDraftOpened && draftId) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Background task failed",
              description: error instanceof Error ? error.message : "Failed to send message.",
              actionProps: {
                children: "Open draft",
                onClick: () => {
                  void navigate({ to: "/draft/$draftId", params: { draftId } });
                },
              },
            }),
          );
        }
      }
    }
    releaseHostDraft();
    sendInFlightRef.current = false;
    if (!turnStartSucceeded) {
      setDockedDraftHeroThreadKey((currentThreadKey) =>
        currentThreadKey === activeThreadKey ? null : currentThreadKey,
      );
      resetLocalDispatch();
    }
  };

  const onRespondToApproval = useCallback(
    async (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => {
      if (!activeThreadId || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
        return;
      if (
        pendingApprovals.find((approval) => approval.requestId === requestId)
          ?.responseCapability !== "live"
      )
        return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      // A decision the host never received goes again once it is back. One it
      // may have received is not: the host does not deduplicate decisions.
      const result = await retryTransientSend(
        () =>
          respondToThreadApproval({
            environmentId,
            input: {
              threadId: activeThreadId,
              requestId,
              decision,
            },
          }),
        {
          waitForHost: () => whenHostReady(environmentId, { cancelled: false }),
          retryable: isUnsentHostFailure,
        },
      );
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : "Failed to submit approval decision.",
        );
      }
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [
      activeThreadId,
      environmentId,
      pendingApprovals,
      respondToThreadApproval,
      setThreadError,
      setRespondingRequestIds,
    ],
  );

  const onRespondToUserInput = useCallback(
    async (
      requestId: RuntimeRequestId,
      answers: Record<string, unknown>,
      /** Files sent from the chat composer with the reply to one question. */
      chatReply?: {
        readonly questionId: string;
        readonly attachments: ReadonlyArray<ContractChatAttachment>;
      },
      /** A send that seemed to fail landed after all: clear what it sent. */
      onLanded?: () => void,
    ) => {
      if (!activeThreadId || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
        return false;
      const pendingInput = pendingUserInputs.find((input) => input.requestId === requestId);
      if (!pendingInput || pendingInput.responseCapability === "not_resumable") return false;
      const responseKey = JSON.stringify([environmentId, activeThreadId, requestId]);
      if (userInputResponsesInFlight.current.has(responseKey)) return false;
      const attachmentsByQuestionId = new Map<
        string,
        import("@specweave-studio/contracts").UserInputAttachments[string]
      >();
      for (const question of pendingInput.questions) {
        const target = questionAttachmentDraftId(
          environmentId,
          activeThreadId,
          requestId,
          question.id,
        );
        if ((useQuestionAttachmentPreparation.getState().counts[target] ?? 0) > 0) return false;
        const draft = useComposerDraftStore.getState().getComposerDraft(target);
        const attachments = draft ? [...draft.images, ...draft.files] : [];
        const fromChat = chatReply?.questionId === question.id ? chatReply.attachments : [];
        if (attachments.length === 0 && fromChat.length === 0) continue;
        const fromDraft = getUploadedAttachments({ environmentId, images: attachments });
        const uploaded = fromDraft ? [...fromDraft, ...fromChat] : null;
        if (!uploaded) {
          setAnswerProblem({
            threadId: activeThreadId,
            requestId,
            text: "Wait for attachments to finish uploading, or remove failed uploads.",
          });
          return false;
        }
        attachmentsByQuestionId.set(
          question.id,
          uploaded as import("@specweave-studio/contracts").UserInputAttachments[string],
        );
      }
      userInputResponsesInFlight.current.add(responseKey);
      // Another thread's reason waits for its return.
      clearThreadAnswerProblem(activeThreadId);
      answerSettle.claim(requestId);

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const waitingAtSend = pendingUserInputIdsRef.current;
      // The answer's command id makes a repeat safe, so a host that is busy or
      // restarting (an update) takes it once it is back instead of failing it.
      const result = await retryTransientSend(
        () =>
          respondToThreadUserInput({
            environmentId,
            input: {
              // The same answer sent again replays one command instead of a refused second one.
              commandId: CommandId.make(
                questionAnswerCommandId({
                  requestId,
                  answers,
                  attachmentIdsByQuestionId: Object.fromEntries(
                    [...attachmentsByQuestionId].map(([id, list]) => [
                      id,
                      list.map((attachment) => attachment.id),
                    ]),
                  ),
                }),
              ),
              threadId: activeThreadId,
              requestId,
              answers,
              ...(attachmentsByQuestionId.size > 0
                ? { attachmentsByQuestionId: Object.fromEntries(attachmentsByQuestionId) }
                : {}),
              ...(chatReply ? { answeredInChat: true } : {}),
            },
          }),
        { waitForHost: () => whenHostReady(environmentId, { cancelled: false }) },
      );
      userInputResponsesInFlight.current.delete(responseKey);
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
      const threadId = activeThreadId;
      const problem = settleQuestionAnswer({
        result: questionSendResult(
          result,
          "Failed to submit user input.",
          activeEnvironmentIsThisMachine,
        ),
        requestId,
        answers,
        files: Object.fromEntries(attachmentsByQuestionId),
        heldInBox: chatReply !== undefined,
        runtimeRequests: () => serverProjectionRef.current?.runtimeRequests,
        settle: answerSettle,
        announce: announceAnswer,
        onLanded: () => {
          clearThreadAnswerProblem(threadId);
          onLanded?.();
        },
        onSettledElsewhere: (settled) =>
          showSendProblem(threadId, requestId, settled, waitingAtSend),
      });
      if (problem === null) return true;
      if (!problem.settled) showSendProblem(threadId, requestId, problem);
      return false;
    },
    [
      activeEnvironmentIsThisMachine,
      activeThreadId,
      announceAnswer,
      answerSettle,
      environmentId,
      pendingUserInputIdsRef,
      pendingUserInputs,
      respondToThreadUserInput,
      serverProjectionRef,
      showSendProblem,
      clearThreadAnswerProblem,
      userInputResponsesInFlight,
      setRespondingUserInputRequestIds,
    ],
  );

  // Closes an async question without messaging the agent. The server records
  // the dismissal so every client releases the composer.
  const onDismissUserInput = useCallback(
    async (requestId: RuntimeRequestId) => {
      if (!activeThreadId) return;
      answerSettle.claim(requestId);

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const waitingAtSend = pendingUserInputIdsRef.current;
      const threadId = activeThreadId;
      // Only a dismissal the host never received goes again: a repeat of one
      // it took would come back as "already answered".
      const result = await retryTransientSend(
        () =>
          dismissThreadUserInput({
            environmentId,
            input: { threadId, requestId },
          }),
        {
          waitForHost: () => whenHostReady(environmentId, { cancelled: false }),
          retryable: isUnsentHostFailure,
        },
      );
      const problem = settleQuestionDismiss({
        result: questionSendResult(
          result,
          "Failed to dismiss the question.",
          activeEnvironmentIsThisMachine,
        ),
        requestId,
        runtimeRequests: () => serverProjectionRef.current?.runtimeRequests,
        settle: answerSettle,
        announce: announceAnswer,
        onSettledElsewhere: (settled) =>
          showSendProblem(threadId, requestId, settled, waitingAtSend),
      });
      if (problem !== null && !problem.settled) showSendProblem(threadId, requestId, problem);
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
    [
      activeEnvironmentIsThisMachine,
      activeThreadId,
      announceAnswer,
      answerSettle,
      dismissThreadUserInput,
      environmentId,
      pendingUserInputIdsRef,
      serverProjectionRef,
      setRespondingUserInputRequestIds,
      showSendProblem,
    ],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingRequestKey]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput, activePendingRequestKey, setPendingUserInputQuestionIndexByRequestId],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionValue: string) => {
      if (!activePendingUserInput) {
        return;
      }
      // The option replaces the custom answer. Anything typed there is the
      // user's text, so it goes back to the thread draft instead of vanishing.
      const displacedAnswer =
        pendingUserInputAnswersByRequestId[activePendingRequestKey]?.[questionId]?.customAnswer;
      const currentPrompt =
        useComposerDraftStore.getState().getComposerDraft(composerDraftTarget)?.prompt ?? "";
      const nextPrompt = carryDisplacedCustomAnswerIntoPrompt(currentPrompt, displacedAnswer);
      if (nextPrompt !== currentPrompt) {
        setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      }
      setPendingUserInputAnswersByRequestId((existing) => {
        const question =
          (activePendingProgress?.activeQuestion?.id === questionId
            ? activePendingProgress.activeQuestion
            : undefined) ??
          activePendingUserInput.questions.find((entry) => entry.id === questionId);
        if (!question) {
          return existing;
        }

        return {
          ...existing,
          [activePendingRequestKey]: {
            ...existing[activePendingRequestKey],
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[activePendingRequestKey]?.[questionId],
              optionValue,
            ),
          },
        };
      });
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      activePendingRequestKey,
      composerDraftTarget,
      pendingUserInputAnswersByRequestId,
      setComposerDraftPrompt,
      activePendingProgress,
      setPendingUserInputAnswersByRequestId,
    ],
  );

  // The answer box of the review-only request panel; the chat composer keeps the thread draft.
  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (questionId: string, value: string) => {
      if (!activePendingUserInput) {
        return;
      }
      const question = activePendingUserInput.questions.find((entry) => entry.id === questionId);
      if (!question || question.allowCustomAnswer === false) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingRequestKey]: {
          ...existing[activePendingRequestKey],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingRequestKey]?.[questionId],
            value,
          ),
        },
      }));
    },
    [activePendingUserInput, activePendingRequestKey, setPendingUserInputAnswersByRequestId],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (
      !activePendingUserInput ||
      activePendingUserInput.responseCapability === "not_resumable" ||
      !activePendingProgress
    ) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    activePendingIsResponding,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  /**
   * Answers the active question with the chat composer's text and files. The
   * draft stays in the composer until the answer is accepted.
   */
  const onReplyToActivePendingUserInputInChat = async (
    reply: Extract<QuestionChatReply, { kind: "reply" }>,
  ) => {
    const request = activePendingUserInput;
    const question = activePendingProgress?.activeQuestion;
    if (!request || !question || !activePendingProgress || !activeThreadId) return;
    if (request.responseCapability === "not_resumable") return;
    const files = [...reply.images, ...reply.files];
    const uploaded = getUploadedAttachments({ environmentId, images: files });
    if (!uploaded) {
      setAnswerProblem({
        threadId: activeThreadId,
        requestId: request.requestId,
        text: "Wait for attachments to finish uploading, or remove failed uploads.",
      });
      return;
    }
    const store = useComposerDraftStore.getState();
    const sentDraft = store.getComposerDraft(composerDraftTarget);
    const clearSentDraft = () => {
      if (useComposerDraftStore.getState().getComposerDraft(composerDraftTarget) !== sentDraft)
        return;
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState({ cursor: 0 });
    };
    if (!activePendingProgress.isLastQuestion) {
      // Later questions still wait: the reply becomes this question's answer
      // and its files move to the answer, keeping their uploads.
      const target = questionAttachmentDraftId(
        environmentId,
        activeThreadId,
        request.requestId,
        question.id,
      );
      if (reply.images.length > 0) store.addImages(target, [...reply.images]);
      if (reply.files.length > 0)
        store.addFiles(target, [...reply.files], { appendReference: false });
      onChangeActivePendingUserInputCustomAnswer(question.id, reply.text);
      clearSentDraft();
      setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
      return;
    }
    const answers = buildPendingUserInputAnswers(request.questions, {
      ...activePendingDraftAnswers,
      [question.id]: { customAnswer: reply.text, attachmentCount: files.length },
    });
    if (!answers) {
      setAnswerProblem({
        threadId: activeThreadId,
        requestId: request.requestId,
        text: "Answer each question on the card before sending.",
      });
      return;
    }
    const delivered = await onRespondToUserInput(
      request.requestId,
      answers,
      { questionId: question.id, attachments: uploaded },
      clearSentDraft,
    );
    if (delivered) clearSentDraft();
  };

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const onImplementPlanInNewThread = useCallback(async () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return;
    }

    if (routesViaCoordinator(projectRouting)) {
      sendInFlightRef.current = true;
      await settleCaught(
        async () => {
          await projectRouting.send(buildPlanImplementationPrompt(activeProposedPlan.planMarkdown));
          projectRouting.openCoordinator();
        },
        (error) => {
          setThreadError(
            activeThread.id,
            error instanceof Error
              ? error.message
              : "Could not ask the coordinator to implement the plan.",
          );
        },
        () => {
          sendInFlightRef.current = false;
        },
      );
      return;
    }

    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx?.providerAvailable || !sendCtx.interactionModeEnabled) {
      return;
    }
    const {
      selectedProvider: ctxSelectedProvider,
      selectedModel: ctxSelectedModel,
      selectedProviderModels: ctxSelectedProviderModels,
      selectedPromptEffort: ctxSelectedPromptEffort,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: ctxSelectedProvider,
      model: ctxSelectedModel,
      models: ctxSelectedProviderModels,
      effort: ctxSelectedPromptEffort,
      text: implementationPrompt,
    });
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = ctxSelectedModelSelection;

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    };

    const createResult = await createThread({
      environmentId,
      input: {
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode: defaultRuntimeMode,
        interactionMode: "default",
        branch: activeThreadBranch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      },
    });
    let failure: AtomCommandResult<unknown, unknown> | null =
      createResult._tag === "Failure" ? createResult : null;

    if (failure === null) {
      const startResult = await startThreadTurn({
        environmentId,
        input: {
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode: defaultRuntimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        },
      });
      failure = startResult._tag === "Failure" ? startResult : null;
    }

    if (failure === null) {
      const startedResult = await settlePromise(() =>
        waitForStartedServerThread(scopeThreadRef(activeThread.environmentId, nextThreadId)),
      );
      failure = startedResult._tag === "Failure" ? startedResult : null;
    }

    if (failure === null) {
      const navigateResult = await settlePromise(() =>
        openThreadRoute(scopeThreadRef(activeThread.environmentId, nextThreadId)),
      );
      failure = navigateResult._tag === "Failure" ? navigateResult : null;
    }

    if (failure !== null) {
      const cleanupResult = await deleteThread({
        environmentId,
        input: {
          threadId: nextThreadId,
        },
      });
      if (cleanupResult._tag === "Failure" && !isAtomCommandInterrupted(cleanupResult)) {
        console.warn(
          "Failed to clean up implementation thread after start failure.",
          squashAtomCommandFailure(cleanupResult),
        );
      }
      if (!isAtomCommandInterrupted(failure)) {
        const error = squashAtomCommandFailure(failure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start implementation thread",
            description:
              error instanceof Error
                ? error.message
                : "An error occurred while creating the new thread.",
          }),
        );
      }
    }
    finish();
  }, [
    projectRouting,
    setThreadError,
    activeProject,
    activeProposedPlan,
    activeThreadBranch,
    activeThread,
    beginLocalDispatch,
    activeEnvironmentUnavailable,
    createThread,
    deleteThread,
    isConnecting,
    isSendBusy,
    isServerThread,
    openThreadRoute,
    resetLocalDispatch,
    defaultRuntimeMode,
    startThreadTurn,
    environmentId,
    composerRef,
    sendInFlightRef,
  ]);

  const getModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId, model: string): string | null => {
      if (!activeThread) {
        return null;
      }
      const reason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeRuntime !== null,
        supportsProviderSwitchingViaHandoff,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId: activeRuntime?.providerInstanceId ?? null,
        nextModelSelection: { instanceId, model },
      });
      return reason ? `${reason.description} Start a new thread to use this model.` : null;
    },
    [activeRuntime, activeThread, providerStatuses, supportsProviderSwitchingViaHandoff],
  );

  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string, options?: { focusComposer?: boolean }) => {
      if (!activeThread) return;
      if (projectRouting?.saveCoordinatorModel) {
        void projectRouting.saveCoordinatorModel({ instanceId, model });
        if (options?.focusComposer !== false) scheduleComposerFocus();
        return;
      }
      // Look up the configured instance so model normalization and custom
      // model lookup stay scoped to that exact instance. Unknown instance ids
      // are rejected by returning early; the server remains authoritative too.
      const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId);
      const resolvedDriverKind = entry?.driver ?? null;
      if (
        !supportsProviderSwitchingViaHandoff &&
        lockedProvider !== null &&
        resolvedDriverKind !== null &&
        resolvedDriverKind !== lockedProvider
      ) {
        if (options?.focusComposer !== false) scheduleComposerFocus();
        return;
      }
      if (
        !supportsProviderSwitchingViaHandoff &&
        lockedProvider !== null &&
        activeRuntime?.providerInstanceId
      ) {
        const currentEntry = providerStatuses.find(
          (snapshot) => snapshot.instanceId === activeRuntime.providerInstanceId,
        );
        if (
          currentEntry?.continuation?.groupKey &&
          entry?.continuation?.groupKey &&
          currentEntry.continuation.groupKey !== entry.continuation.groupKey
        ) {
          if (options?.focusComposer !== false) scheduleComposerFocus();
          return;
        }
      }
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      );
      if (!resolvedModel) {
        if (options?.focusComposer !== false) scheduleComposerFocus();
        return;
      }
      // Restore this model's own remembered options; without any, start it
      // from its default rather than carrying the previous model's over.
      const rememberedOptions =
        useComposerDraftStore.getState().stickyOptionsByModelByProvider[instanceId]?.[
          resolvedModel
        ];
      const nextModelSelection: ModelSelection =
        rememberedOptions !== undefined && rememberedOptions.length > 0
          ? { instanceId, model: resolvedModel, options: [...rememberedOptions] }
          : { instanceId, model: resolvedModel };
      const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: activeRuntime !== null,
        supportsProviderSwitchingViaHandoff,
        currentModelSelection: activeThread.modelSelection,
        currentProviderInstanceId: activeRuntime?.providerInstanceId ?? null,
        nextModelSelection,
      });
      if (modelChangeBlockReason) {
        toastManager.add({
          type: "warning",
          title: modelChangeBlockReason.title,
          description: modelChangeBlockReason.description,
        });
        if (options?.focusComposer !== false) scheduleComposerFocus();
        return;
      }
      setComposerDraftModelSelection(
        scopeThreadRef(activeThread.environmentId, activeThread.id),
        nextModelSelection,
        // A complete snapshot: an absent options field means "start from the
        // model default", not "keep the previous model's options".
        { explicit: true, replaceOptions: true },
      );
      setStickyComposerModelSelection(nextModelSelection);
      if (options?.focusComposer !== false) scheduleComposerFocus();
    },
    [
      projectRouting,
      activeThread,
      activeRuntime,
      lockedProvider,
      supportsProviderSwitchingViaHandoff,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      providerStatuses,
      settings,
    ],
  );
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      if (multipleModelSelections !== null) return;
      if (canOverrideServerThreadEnvMode) {
        setPendingServerThreadEnvMode(mode);
        scheduleComposerFocus();
        return;
      }
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, {
          envMode: mode,
          startFromOrigin: resolveNewDraftStartFromOrigin({
            envMode: mode,
            newWorktreesStartFromOrigin: activeProjectSettings.settings.newWorktreesStartFromOrigin,
          }),
          ...(mode === "worktree" && draftThread?.worktreePath ? { worktreePath: null } : {}),
        });
      }
      scheduleComposerFocus();
    },
    [
      canOverrideServerThreadEnvMode,
      composerDraftTarget,
      draftThread?.worktreePath,
      isLocalDraftThread,
      multipleModelSelections,
      activeProjectSettings.settings.newWorktreesStartFromOrigin,
      setPendingServerThreadEnvMode,
      scheduleComposerFocus,
      setDraftThreadContext,
    ],
  );

  // "Work locally" on the setup card: cancel the bootstrap and remember the
  // draft. The cancelled dispatch deletes the half-made thread and puts the
  // message back in the composer; the effect below then flips the draft to
  // local mode and resends. The draft is a server thread for the whole
  // setup (the bootstrap created it), so this keys off the route, not
  // `isLocalDraftThread`.
  const onWorktreeSetupWorkLocally = useCallback(() => {
    if (!worktreeSetup || worktreeSetup.phase !== "running" || !draftId) {
      return;
    }
    const target = {
      environmentId: setupTarget.environmentId,
      input: { threadId: worktreeSetup.threadId },
    };
    void (async () => {
      const result = await cancelWorktreeSetup(target);
      if (result._tag !== "Success" || !result.value.cancelled) return;
      setWorkLocallyResendDraftId(draftId);
    })();
  }, [
    cancelWorktreeSetup,
    draftId,
    setupTarget.environmentId,
    worktreeSetup,
    setWorkLocallyResendDraftId,
  ]);
  const onSendRef = useLatestRef(onSend);
  // Resend once the cancelled dispatch has settled and the composer is free.
  // Every state that makes `onSend` bail and wait is part of the readiness
  // check, so the flag survives a reconnect, a reverting checkpoint, or a
  // feedback upload in between. What remains inside `onSend` are the checks
  // that need the user to change something, and those should not auto retry.
  const workLocallyResendReady =
    workLocallyResendDraftId !== null &&
    workLocallyResendDraftId === draftId &&
    isLocalDraftThread &&
    !isSendBusy &&
    !isConnecting &&
    !isRevertingCheckpoint &&
    !threadDetailLoading &&
    clientSettingsHydrated &&
    !needsLoadBalancing &&
    !activeEnvironmentUnavailable &&
    !activePendingProgress &&
    !feedbackUploading;
  useEffect(() => {
    if (
      !workLocallyResendReady ||
      sendInFlightRef.current ||
      feedbackUploadsInFlightRef.current.has(routeThreadKey)
    ) {
      return;
    }
    if (sendEnvMode !== "local") {
      // The draft is back; switch it to the project checkout and let the next
      // render resend.
      setDraftThreadContext(composerDraftTarget, { envMode: "local", startFromOrigin: false });
      return;
    }
    setWorkLocallyResendDraftId(null);
    void onSendRef.current();
  }, [
    composerDraftTarget,
    routeThreadKey,
    sendEnvMode,
    setDraftThreadContext,
    workLocallyResendReady,
  ]);

  const onStartFromOriginChange = (nextStartFromOrigin: boolean) => {
    if (canOverrideServerThreadEnvMode && activeThread) {
      setPendingServerThreadStartFromOriginByThreadId((current) =>
        current[activeThread.id] === nextStartFromOrigin
          ? current
          : { ...current, [activeThread.id]: nextStartFromOrigin },
      );
      return;
    }
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, {
        startFromOrigin: nextStartFromOrigin,
      });
    }
  };

  const onExpandTimelineImage = useCallback(
    (preview: ExpandedImagePreview) => {
      setExpandedImage(preview);
    },
    [setExpandedImage],
  );
  const onOpenTurnDiff = useCallback(
    (runId: RunId, filePath?: string, options?: TurnDiffLinkOptions) => {
      if (!isServerThread || !activeThreadTarget) return;
      const sourceThreadId = options?.sourceThreadId;
      if (sourceThreadId && sourceThreadId !== activeThreadTarget.threadId) {
        // An inherited or subagent row's turn belongs to another thread: open that thread with
        // its diff at the run, and keep the link's turn across the thread switch.
        const sourceThreadRef = scopeThreadRef(activeThreadTarget.environmentId, sourceThreadId);
        useDiffPanelStore.getState().selectTurn(sourceThreadRef, runId, filePath, options);
        useDiffPanelStore.getState().markLinkedOpen(sourceThreadRef);
        useRightPanelStore.getState().open(sourceThreadRef, "diff");
        void openThreadRoute(sourceThreadRef);
        return;
      }
      explicitDiffOpenRef.current = diffOpen ? null : activeThreadTarget;
      useDiffPanelStore.getState().selectTurn(activeThreadTarget, runId, filePath, options ?? {});
      useRightPanelStore.getState().open(activeThreadTarget, "diff");
      onDiffPanelOpen?.();
    },
    [
      activeThreadTarget,
      diffOpen,
      isServerThread,
      onDiffPanelOpen,
      explicitDiffOpenRef,
      openThreadRoute,
    ],
  );
  // The revert handler is read from a ref at call-time so the callback
  // reference is fully stable and never busts TimelineRowCtx identity.
  const onRevertToTurnCountRef = useLatestRef(onRevertToTurnCount);
  const onRevertTimelineTurn = useCallback(
    (targetTurnCount: number, messageId: MessageId) => {
      void onRevertToTurnCountRef.current(targetTurnCount, messageId);
    },
    [onRevertToTurnCountRef],
  );

  const pendingSidebarFileDrops = useSidebarPendingFileDropStore((state) => state.pending);
  const consumePendingFileDrop = useSidebarPendingFileDropStore(
    (state) => state.consumePendingFileDrop,
  );
  useEffect(() => {
    if (pendingSidebarFileDrops.length === 0) return;
    if (
      typeof composerDraftTarget === "string" ||
      !pendingSidebarFileDrops.some((drop) =>
        isSameSidebarThreadRef(composerDraftTarget, drop.threadRef),
      )
    ) {
      return;
    }
    if (!activeThread) return;
    if (!composerRef.current) {
      const raf = window.requestAnimationFrame(() => {
        if (!composerRef.current || typeof composerDraftTarget === "string") return;
        const files = consumePendingFileDrop(composerDraftTarget);
        if (files !== null) composerRef.current?.addDroppedFiles(files);
      });
      return () => window.cancelAnimationFrame(raf);
    }
    const files = consumePendingFileDrop(composerDraftTarget);
    if (files !== null) composerRef.current.addDroppedFiles(files);
  }, [
    activeThread,
    composerDraftTarget,
    composerRef,
    consumePendingFileDrop,
    pendingSidebarFileDrops,
  ]);

  // Empty state: no active thread
  const workspaceFileDropHandlers = useWorkspaceFileDropHandlers({
    setDragActive: setIsWorkspaceFileDragActive,
    addFiles: (files) => composerRef.current?.addDroppedFiles(files),
    addFolders: (folders) => composerRef.current?.addDroppedFolders(folders),
  });
  if (!activeThread) {
    return <NoActiveThreadState />;
  }

  const rightPanelContent = activeThreadTarget ? (
    renderedRightPanelSurface?.kind === "preview" ? (
      <Suspense fallback={null}>
        <PreviewPanel
          mode="embedded"
          threadRef={activeThreadTarget}
          tabId={renderedRightPanelSurface.resourceId}
          configuredUrls={configuredPreviewUrls}
          visible={rightPanelOpen}
          onSendAnnotation={(annotation, image) => {
            void onSend(undefined, "auto", "foreground", { annotation, image });
          }}
        />
      </Suspense>
    ) : renderedRightPanelSurface?.kind === "terminal" ? (
      <PersistentThreadTerminalPanel
        visible={rightPanelOpen}
        threadRef={activeThreadTarget}
        surface={renderedRightPanelSurface}
        launchContext={activeTerminalLaunchContext ?? null}
        focusRequestId={terminalFocusRequestId}
        keybindings={keybindings}
        onAddTerminalContext={addTerminalContextToDraft}
        onSplitTerminal={splitPanelTerminal}
        onSplitTerminalVertical={splitPanelTerminalVertical}
        onNewTerminal={addTerminalSurface}
        onActiveTerminalChange={activatePanelTerminal}
        onCloseTerminal={closePanelTerminal}
        splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
        splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
        newShortcutLabel={newTerminalShortcutLabel ?? undefined}
        closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
      />
    ) : renderedRightPanelSurface?.kind === "diff" ? (
      <EmbeddedThreadDiffPanel
        threadRef={activeThreadTarget}
        composerDraftTarget={composerDraftTarget}
        workspaceMutationId={workspaceMutationId}
      />
    ) : renderedRightPanelSurface?.kind === "pull-request" && !pullRequestsCapabilityKnown ? (
      <PullRequestDetailGhost />
    ) : renderedRightPanelSurface?.kind === "pull-request" && !supportsPullRequests ? (
      <PullRequestsUnavailableState
        title="Pull requests unavailable"
        error="Update this environment's SpecWithCode server to browse pull requests."
      />
    ) : renderedRightPanelSurface?.kind === "pull-request" ? (
      // No onClose: the surface tab's own X owns closing here, and a second X in the header
      // would be the same action twice. The thread context also drops the checkout button, so it
      // is only right for the thread's own pull request, whose branch is already under the
      // reader's feet. A link the agent wrote can open any other one here, and that one has to be
      // checkable out like it is anywhere else.
      <PullRequestDetailPanel
        getShortcutContext={getShortcutContext}
        shortcutsEnabled={
          rightPanelOpen && activeRightPanelSurface?.id === renderedRightPanelSurface.id
        }
        key={`${renderedRightPanelSurface.host ?? ""}:${renderedRightPanelSurface.repository}#${renderedRightPanelSurface.number}`}
        environmentId={activeThread.environmentId}
        onSelectPullRequest={(reference) => {
          if (activeThreadTarget)
            useRightPanelStore.getState().openPullRequest(activeThreadTarget, {
              projectId: reference.projectId,
              repository: reference.repository,
              number: reference.number,
              ...(reference.host ? { host: reference.host } : {}),
            });
        }}
        threadRef={activeThreadTarget}
        reference={{
          projectId: renderedRightPanelSurface.projectId as ProjectId,
          ...(renderedRightPanelSurface.host ? { host: renderedRightPanelSurface.host } : {}),
          repository: renderedRightPanelSurface.repository,
          number: renderedRightPanelSurface.number,
        }}
        context={pullRequestPanelContext(
          {
            projectId: activeThread.projectId,
            pullRequests: visiblePullRequests,
            linkedPullRequest: linkedThreadPullRequest,
            branchPullRequest:
              activeThreadShell?.branchPullRequest ?? activeThread.branchPullRequest,
          },
          renderedRightPanelSurface,
        )}
        composerDraftTarget={composerDraftTarget}
        onBack={
          activeThreadTarget !== null && pullRequestsSurfaceAvailable && visiblePullRequestCount > 1
            ? addPullRequestsSurface
            : undefined
        }
      />
    ) : renderedRightPanelSurface?.kind === "pull-requests" && activeThreadTarget ? (
      <ThreadPullRequestsPanel threadRef={activeThreadTarget} />
    ) : renderedRightPanelSurface?.kind === "device" ? (
      <Suspense fallback={null}>
        <DevicePanel
          mode="embedded"
          threadRef={activeThreadTarget}
          key={renderedRightPanelSurface.id}
          surface={renderedRightPanelSurface}
          visible={rightPanelOpen}
          onDismissSetup={() => {
            closeRightPanelSurface(renderedRightPanelSurface);
            useRightPanelStore.getState().show(activeThreadTarget);
          }}
        />
      </Suspense>
    ) : (renderedRightPanelSurface?.kind === "files" ||
        renderedRightPanelSurface?.kind === "file") &&
      ((activeProject && activeWorkspaceRoot) ||
        (renderedRightPanelSurface.kind === "file" && renderedRightPanelSurface.attachment)) ? (
      <Suspense fallback={null}>
        <FilePreviewPanel
          key={`${activeThread.environmentId}:${
            renderedRightPanelSurface.kind === "file" && renderedRightPanelSurface.attachment
              ? `attachment:${renderedRightPanelSurface.attachment.id}`
              : activeWorkspaceRoot
          }`}
          environmentId={activeThread.environmentId}
          cwd={activeWorkspaceRoot ?? ""}
          projectName={activeProject?.title ?? ""}
          threadRef={activeThreadTarget}
          composerDraftTarget={composerDraftTarget}
          keybindings={keybindings}
          availableEditors={availableEditors}
          relativePath={
            renderedRightPanelSurface.kind === "file"
              ? renderedRightPanelSurface.relativePath
              : null
          }
          {...(renderedRightPanelSurface.kind === "file" && renderedRightPanelSurface.attachment
            ? { attachment: renderedRightPanelSurface.attachment }
            : {})}
          revealLine={
            renderedRightPanelSurface.kind === "file"
              ? (renderedRightPanelSurface.revealLine ?? null)
              : null
          }
          revealRequestId={
            renderedRightPanelSurface.kind === "file"
              ? renderedRightPanelSurface.revealRequestId
              : 0
          }
          onOpenFile={openFileSurface}
          onPendingChange={handleFilePendingChange}
          selectedFilePending={
            renderedRightPanelSurface.kind === "file" &&
            pendingFileSurfaceIds.has(renderedRightPanelSurface.id)
          }
          workspaceMutationId={workspaceMutationId}
        />
      </Suspense>
    ) : null
  ) : null;
  const threadDetailsPanelProps: ThreadDetailsPanelProps = {
    anchor: threadPanelPopoverAnchorRef,
    handle: threadPanelPopoverHandle,
    onPresentationChange: setThreadPanelPresentation,
    forceNewWorktree: multipleModelSelections !== null,
    environmentId: activeThread.environmentId,
    threadId: activeThread.id,
    ...(draftId ? { draftId } : {}),
    activeProjectName: activeProject?.title,
    activeProjectScripts: activeProject ? activeProjectScripts : undefined,
    chatFolder:
      activeProject &&
      isScratchProject(
        activeProject,
        environmentById.get(activeProject.environmentId)?.serverConfig?.scratchWorkspaceRoot ??
          null,
      )
        ? { path: activeThread.worktreePath ?? null, chatTitle: activeThread.title ?? null }
        : undefined,
    preferredScriptId: activeProject
      ? (lastInvokedScriptByProjectId[activeProject.id] ?? null)
      : null,
    keybindings,
    availableEditors,
    showOpenInPicker,
    gitCwd,
    isGitRepo,
    envLocked,
    availableEnvironments: logicalProjectEnvironments,
    autoEnvironmentLabel,
    onAutoEnvironment:
      draftId &&
      !envLocked &&
      canAutoBalanceEnvironments &&
      loadBalancingSettings.loadBalancingEnabled
        ? onAutoEnvironment
        : undefined,
    onEnvironmentChange,
    onEnvModeChange,
    envMode,
    ...(canOverrideServerThreadEnvMode
      ? {
          activeThreadBranchOverride: activeThreadBranch,
          onActiveThreadBranchOverrideChange: setPendingServerThreadBranch,
        }
      : {}),
    startFromOrigin,
    onStartFromOriginChange,
    ...(canCheckoutPullRequestIntoThread
      ? { onCheckoutPullRequestRequest: openPullRequestDialog }
      : {}),
    onComposerFocusRequest: scheduleComposerFocus,
    ...(isServerThread && isGitRepo ? { onOpenChanges: openChangesFromThreadPanel } : {}),
    onRunProjectScript: runProjectScript,
    onAddProjectScript: saveProjectScript,
    onUpdateProjectScript: updateProjectScript,
    onDeleteProjectScript: deleteProjectScript,
  };
  const panelToggleControlProps = {
    terminalAvailable: activeProject !== null,
    terminalOpen: terminalUiState.terminalOpen,
    terminalShortcutLabel: shortcutLabelForCommand(keybindings, "terminal.toggle"),
    threadPanelOpen,
    threadPanelPresentation,
    threadPanelPopoverHandle,
    threadPanelShortcutLabel: shortcutLabelForCommand(keybindings, "threadPanel.toggle"),
    threadPanelHasAttention: activeEnvironmentUnavailableState !== null,
    rightPanelAvailable: activeProject !== null,
    rightPanelOpen,
    // Embedded in a project, the shortcut toggles the project's Overview instead.
    rightPanelShortcutLabel:
      layoutMode === "embedded" ? null : shortcutLabelForCommand(keybindings, "rightPanel.toggle"),
    onToggleTerminal: toggleTerminalVisibility,
    onToggleThreadPanel: toggleThreadPanel,
    onToggleRightPanel: toggleRightPanel,
  } satisfies PanelLayoutControlsProps;
  const panelToggleControls = (
    <PanelLayoutControls
      {...panelToggleControlProps}
      showThreadPanelControl={!inlineRightPanelOwnsTitleBar}
    />
  );
  const threadPanelHeaderControl = (
    <div
      className="absolute top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 flex h-[var(--workspace-topbar-height)] items-center [-webkit-app-region:no-drag]"
      data-workspace-titlebar-controls
    >
      <PanelLayoutControls
        {...panelToggleControlProps}
        showTerminalControl={false}
        showRightPanelControl={false}
      />
    </div>
  );
  // Portaled into the project pane's header, the controls sit in its flex row.
  // With the right panel present they stay at the layout root over that panel.
  const panelLayoutControlsInHostHeader =
    layoutMode === "embedded" &&
    embeddedHeaderToolsTarget != null &&
    !rightPanelControlsAtRoot &&
    !rightPanelControlsInPanel;
  const panelLayoutControls = (
    <div
      className={cn(
        // Full chat uses the native viewport anchor; embedded chat stays in its pane.
        // The header can shrink behind the right panel without moving the controls.
        "pointer-events-none z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]",
        panelLayoutControlsInHostHeader ? "relative h-full" : chatControlAnchor(layoutMode),
      )}
      data-workspace-titlebar-controls
    >
      {!shouldUsePlanSidebarSheet ? (
        <span
          aria-hidden={!rightPanelOpen}
          className={cn(
            "flex shrink-0",
            panelAnimationsActive &&
              "motion-safe:transition-opacity motion-safe:duration-(--panel-animation-duration) motion-safe:ease-out",
            // Closed, the control leaves the flex flow so the cluster is only as wide as the two
            // toggles the header reserves room for; anchored to the cluster's left edge, it fades
            // out where it stood rather than over the terminal toggle.
            rightPanelOpen
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none absolute right-full mr-1 opacity-0",
          )}
          inert={!rightPanelOpen}
        >
          <RightPanelMaximizeControl
            maximized={rightPanelMaximized}
            onToggle={toggleRightPanelMaximized}
          />
        </span>
      ) : null}
      <div className="pointer-events-auto flex h-full items-center">{panelToggleControls}</div>
    </div>
  );

  // Keep every hook above this presentation branch. Native callbacks retain
  // their host permission checks and persisted request/model identity.
  if (reviewOnly)
    return (
      <CoordinatorNativeControls
        markdownContext={{
          environmentId,
          threadRef: activeThreadTarget ?? undefined,
          cwd: gitCwd ?? undefined,
        }}
        loading={threadDetailLoading}
        disabled={!canOperateThread || activeEnvironmentUnavailable || isSendBusy || isConnecting}
        error={visibleThreadError ?? null}
        approvals={pendingApprovals}
        respondingApprovals={respondingRequestIds}
        onApproval={onRespondToApproval}
        questions={pendingUserInputs}
        answers={activePendingDraftAnswers}
        questionIndex={activePendingQuestionIndex}
        progress={activePendingProgress}
        respondingQuestions={respondingUserInputRequestIds}
        onOption={onSelectActivePendingUserInputOption}
        onPrevious={onPreviousActivePendingUserInputQuestion}
        onAdvance={onAdvanceActivePendingUserInput}
        onDismiss={(id) => void onDismissUserInput(id)}
        planMarkdown={showPlanFollowUpPrompt ? (activeProposedPlan?.planMarkdown ?? null) : null}
        onImplementPlan={() =>
          onSubmitPlanFollowUp({ text: "Implement this plan.", interactionMode: "default" })
        }
        // The held queue's own Resume and Discard; editing needs the thread's composer.
        heldQueue={
          hasHeldQueuedRuns && isServerThread && activeThread ? (
            <QueuedRunsControl
              environmentId={activeThread.environmentId}
              threadId={activeThread.id}
              optimisticMessages={EMPTY_REVIEW_OPTIMISTIC_MESSAGES}
              editingRunId={null}
              onCancelEdit={cancelEditingQueuedRun}
              onResumeHeld={canOperateThread ? () => void onResume() : undefined}
              resumeBusy={isSendBusy || isResuming || isConnecting || threadDetailLoading}
              actionsUnavailableReason={queuedActionsUnavailableReason}
            />
          ) : null
        }
      />
    );

  // Where the server moves this thread's next turn before it starts, by the
  // same pre-turn rule (ProviderFallbackWorker): the chip says "next on <model>"
  // only when the rule would really move it.
  const threadLimitRule = activeProjectSettings.settings;
  const threadNextTurn = (() => {
    if (!activeThreadShell || !supportsProviderSwitchingViaHandoff) return null;
    const from = activeThreadShell.modelSelection;
    const provider = providerStatuses.find(
      (candidate) => candidate.instanceId === activeThreadShell.providerInstanceId,
    );
    if (
      !shouldSwitchBeforeTurn({
        provider,
        model: from.model,
        rule: threadLimitRule,
        nowMs: renderNowMs,
      })
    )
      return null;
    const target = resolveProviderFallback({
      providers: providerStatuses,
      currentInstanceId: activeThreadShell.providerInstanceId,
      currentModel: from.model,
      currentOptions: from.options,
      rule: threadLimitRule,
      nowMs: renderNowMs,
      belowPercent: threadLimitRule.providerLimitSwitchAtPercent,
      anyReady: true,
      proven: provenFallbackSelection(activeThreadShell, activeCoordinatorShell),
    });
    if (target === null) return null;
    if (target.instanceId === from.instanceId && target.model === from.model) return null;
    return {
      from: { instanceId: from.instanceId, model: from.model },
      label: threadIdentityLabel(
        providerInstanceEntries.find((entry) => entry.instanceId === target.instanceId) ?? null,
        target.instanceId,
        target.model,
      ).model,
    };
  })();
  // The models a limit moves this thread to, best first, for the limits view.
  const threadFallbackOrder =
    threadLimitRule.providerLimitAction === "switch"
      ? (threadLimitRule.providerLimitFallbackModels?.length
          ? threadLimitRule.providerLimitFallbackModels
          : threadLimitRule.providerLimitFallbackModelSelection
            ? [threadLimitRule.providerLimitFallbackModelSelection]
            : []
        ).map((selection) => ({
          instanceId: selection.instanceId,
          label: threadIdentityLabel(
            providerInstanceEntries.find((entry) => entry.instanceId === selection.instanceId) ??
              null,
            selection.instanceId,
            selection.model,
          ).full,
        }))
      : [];

  return (
    <div
      ref={workspaceLayoutRef}
      data-chat-layout={layoutMode}
      data-chat-thread={`${environmentId}:${threadId}`}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
    >
      <Dialog
        open={
          deviceSetupThread !== null &&
          deviceSetupThread.environmentId === activeThreadTarget?.environmentId &&
          deviceSetupThread.threadId === activeThreadTarget?.threadId
        }
        onOpenChange={(open) => {
          if (!open) setDeviceSetupThread(null);
        }}
      >
        <WizardPopup>
          {activeThreadTarget ? (
            <DeviceSetup
              environmentId={activeThreadTarget.environmentId}
              state={deviceState}
              onComplete={() => {
                useRightPanelStore.getState().open(activeThreadTarget, "device");
                setDeviceSetupThread(null);
              }}
            />
          ) : null}
        </WizardPopup>
      </Dialog>
      {rightPanelControlsAtRoot ? panelLayoutControls : null}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-x-hidden",
          rightPanelMaximized ? "w-0 flex-none" : "flex-1",
        )}
        data-chat-column-maximized-away={rightPanelMaximized ? "true" : "false"}
      >
        {/* Top bar. Embedded in a project, the project panel's own header already
            names the thread and holds its controls in the title row; the thread
            details popover still hangs from the top of this column. */}
        {layoutMode === "embedded" ? (
          <>
            <div
              ref={(node) => {
                threadPanelPopoverAnchorRef.current = node;
              }}
              aria-hidden
              className="h-0 shrink-0"
              data-chat-header-anchor
            />
            {embeddedHeaderToolsTarget && panelLayoutControlsInHostHeader
              ? createPortal(panelLayoutControls, embeddedHeaderToolsTarget)
              : null}
            {/* The panel's own controls drop the thread-details toggle while it
                owns the title row, so the pane header keeps that one. */}
            {embeddedHeaderToolsTarget && inlineRightPanelOwnsTitleBar
              ? createPortal(
                  <div
                    className="relative z-50 flex h-full items-center [-webkit-app-region:no-drag]"
                    data-workspace-titlebar-controls
                  >
                    <PanelLayoutControls
                      {...panelToggleControlProps}
                      showTerminalControl={false}
                      showRightPanelControl={false}
                    />
                  </div>,
                  embeddedHeaderToolsTarget,
                )
              : null}
          </>
        ) : (
          <header
            ref={threadPanelPopoverAnchorRef}
            data-chat-header
            className={cn(
              "relative bg-background [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out",
              isElectron
                ? cn(
                    "drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 sm:px-5",
                    reserveTitleBarControlInset &&
                      !inlineRightPanelOwnsTitleBar &&
                      "wco:pr-(--workspace-native-controls-inset)",
                  )
                : "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
              layoutMode === "workspace" && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            {isElectron && layoutMode === "workspace" && rightPanelControlsAtRoot ? (
              <span
                aria-hidden
                className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)] w-28 [-webkit-app-region:no-drag]"
              />
            ) : null}
            {!rightPanelControlsAtRoot && !rightPanelControlsInPanel ? panelLayoutControls : null}
            {inlineRightPanelOwnsTitleBar ? threadPanelHeaderControl : null}
            <ChatHeader
              activeThreadEnvironmentId={activeThread.environmentId}
              activeThreadId={activeThread.id}
              isServerThread={isServerThread}
              activeThreadTitle={activeThread.title}
              activeProject={activeProject ?? null}
              rightPanelOpen={inlineRightPanelOwnsTitleBar}
              artifactsCwd={gitCwd}
              onNewThreadInProject={handleNewThreadInActiveProject}
              {...(activeDraftLogicalProjectKey
                ? { onOpenProjectSettings: handleOpenDraftProjectSettings }
                : {})}
            />
          </header>
        )}

        {/* Main content area with optional plan sidebar */}
        <div className="relative flex min-h-0 min-w-0 flex-1">
          {/* Chat column */}
          <ChatCanvas
            composerOverlayElement={isDraftHeroState ? null : composerOverlayElement}
            data-chat-workspace-drop-target="true"
            onDragEnter={workspaceFileDropHandlers.onDragEnter}
            onDragOver={workspaceFileDropHandlers.onDragOver}
            onDragLeave={workspaceFileDropHandlers.onDragLeave}
            onDrop={workspaceFileDropHandlers.onDrop}
          >
            {isWorkspaceFileDragActive ? (
              <div
                className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]"
                data-chat-workspace-drop-overlay="true"
              >
                <div
                  role="status"
                  className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg"
                >
                  <PaperclipIcon className="size-4 text-primary" aria-hidden="true" />
                  Drop files to attach
                </div>
              </div>
            ) : null}
            {/* Banners overlay the timeline; it reserves their measured height above the first row. */}
            <div
              ref={timelineBannerOverlayRef}
              className="chat-banner-lane pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col"
            >
              <ProviderStatusBanner
                status={visibleProviderStatus}
                onDismiss={() => setDismissedProviderStatusBannerKey(providerStatusBannerKey)}
                onOpenProviderSetup={openProviderSetup}
              />
              <ThreadErrorBanner
                error={timelineThreadError}
                contextLimitRecovery={contextLimitRecovery}
                errorClass={
                  localServerError === null && visibleThreadError === serverRuntimeError
                    ? (serverRuntime?.lastErrorClass ?? null)
                    : null
                }
                errorCode={
                  localServerError === null && visibleThreadError === serverRuntimeError
                    ? (latestFailureItem?.failure.code ?? null)
                    : null
                }
                workspaceMissingRecovery={
                  localServerError === null && visibleThreadError === serverRuntimeError
                    ? workspaceMissingRecovery
                    : undefined
                }
                onContinue={
                  resumableRunId !== null &&
                  canOperateThread &&
                  localServerError === null &&
                  visibleThreadError === serverRuntimeError
                    ? () => void resumeWithComposerModel()
                    : undefined
                }
                continueBusy={continueBusy}
                onSwitchModel={failureRecovery?.onSwitchModel}
                onDismiss={() => {
                  setThreadError(activeThread.id, null);
                  dismissThreadErrorBannerForSession(threadErrorBannerKey);
                  setThreadErrorBannerDismissTick((tick) => tick + 1);
                }}
              />
              {threadPlanView !== null ||
              activeThreadBlocker !== null ||
              threadPullRequests.length > 0 ||
              threadOrigin !== null ||
              timelineWorkingFolder !== null ? (
                <ThreadProgressDock>
                  <ThreadHeaderLine>
                    <ThreadMetaRow
                      key={`meta:${activeThread.id}`}
                      origin={threadOrigin}
                      folder={timelineWorkingFolder}
                      run={activeThreadShell?.latestRun ?? null}
                      awaitingPerson={
                        timelineRunHealth?.state === "waiting"
                          ? (timelineRunHealth.awaitingPerson ?? null)
                          : null
                      }
                      pullRequests={threadPullRequests}
                      onOpenPullRequest={(url) => {
                        // In the viewer overlay the pull request opens there, in front.
                        if (viewerOverlayInFront() && openThreadChangeRequest(PLAIN_CLICK, url))
                          return;
                        void openThreadLink(url).catch(() => undefined);
                      }}
                    />
                    {threadPlanView !== null ? (
                      <ThreadPlanCard
                        key={activeThread.id}
                        plan={threadPlanView}
                        onOpenPath={
                          availableEditors.length > 0 ? (path) => void openThreadPath(path) : null
                        }
                        onOpenDocument={(path) =>
                          // An absolute host path: the viewer ignores cwd for it.
                          openFileInFront({
                            environmentId: activeThread.environmentId,
                            threadRef: scopeThreadRef(activeThread.environmentId, activeThread.id),
                            cwd: "",
                            path,
                            line: undefined,
                          })
                        }
                        onLinkIncrement={threadIncrementActions?.link ?? null}
                        onUnlinkIncrement={threadIncrementActions?.unlink ?? null}
                        status={threadPlanStatus}
                      />
                    ) : null}
                  </ThreadHeaderLine>
                  {activeThreadBlocker !== null ? (
                    <ThreadBlockerNote blocker={activeThreadBlocker} />
                  ) : null}
                </ThreadProgressDock>
              ) : null}
            </div>
            {/* Messages Wrapper */}
            <div className="relative flex min-h-0 flex-1 flex-col bg-background">
              {/* Messages — LegendList handles virtualization and scrolling internally */}
              <TimelineActionContexts
                computerUseRetry={
                  canOperateThread && !transcriptOnly ? retryAfterComputerUsePermission : null
                }
                shellRunTarget={
                  canOperateThread && !transcriptOnly && !paintOnlyDisplayedTimeline
                    ? shellRunTarget
                    : null
                }
              >
                <MessagesTimeline
                  contextLimitRecovery={
                    paintOnlyDisplayedTimeline ? undefined : contextLimitRecovery
                  }
                  failureRecovery={paintOnlyDisplayedTimeline ? undefined : timelineFailureRecovery}
                  citationRequest={paintOnlyDisplayedTimeline ? null : citationRequest}
                  citationHistoryLoading={threadDetailLoading}
                  {...(!paintOnlyDisplayedTimeline
                    ? {
                        onCiteAssistantText: citeAssistantText,
                      }
                    : {})}
                  isWorking={!paintOnlyDisplayedTimeline && isWorking}
                  runlessWorkActive={runlessWorkStartedAt !== null}
                  activeTurnInProgress={
                    !paintOnlyDisplayedTimeline && (isWorking || !latestRunSettled)
                  }
                  isCompacting={!paintOnlyDisplayedTimeline && isCompacting}
                  activeTurnStartedAt={paintOnlyDisplayedTimeline ? null : activeWorkStartedAt}
                  runHealth={paintOnlyDisplayedTimeline ? null : timelineRunHealth}
                  activeHost={paintOnlyDisplayedTimeline ? null : timelineActiveHost}
                  workingPlan={paintOnlyDisplayedTimeline ? null : threadPlanView}
                  {...(canInterruptRunningThread && !paintOnlyDisplayedTimeline
                    ? { onStopStalledRun: onInterrupt, onContinueStalledRun }
                    : {})}
                  worktreeSetup={paintOnlyDisplayedTimeline ? null : worktreeSetup}
                  onCancelWorktreeSetup={onCancelWorktreeSetup}
                  {...(paintOnlyDisplayedTimeline
                    ? {}
                    : { retryableWorkspacePreparationRunIds, onRetryWorkspacePreparation })}
                  threadSettled={serverThreadSettled}
                  {...(draftId ? { onWorktreeSetupWorkLocally } : {})}
                  {...(onOpenWorktreeSetupTerminal ? { onOpenWorktreeSetupTerminal } : {})}
                  isPreparingWorktree={!paintOnlyDisplayedTimeline && isPreparingWorktree}
                  listRef={legendListRef}
                  timelineEntries={displayedTimeline.entries}
                  providerStatuses={
                    environmentById.get(
                      displayedThreadTarget?.environmentId ?? activeThread.environmentId,
                    )?.serverConfig?.providers ?? EMPTY_PROVIDERS
                  }
                  runs={paintOnlyDisplayedTimeline ? [] : (serverProjection?.runs ?? [])}
                  recoveryRuns={paintOnlyDisplayedTimeline ? [] : (serverProjection?.runs ?? [])}
                  recoveryItems={
                    paintOnlyDisplayedTimeline ? [] : (serverProjection?.turnItems ?? [])
                  }
                  latestRun={paintOnlyDisplayedTimeline ? null : activeActivityRun}
                  runningRunId={paintOnlyDisplayedTimeline ? null : activeRunningTurnId}
                  turnDiffSummaries={
                    paintOnlyDisplayedTimeline ? EMPTY_HELD_TURN_DIFF_SUMMARIES : turnDiffSummaries
                  }
                  activeThreadEnvironmentId={
                    displayedThreadTarget?.environmentId ?? activeThread.environmentId
                  }
                  routeThreadKey={displayedTimelineKey}
                  displayThreadKey={displayedTimelineKey}
                  onOpenTurnDiff={paintOnlyDisplayedTimeline ? noopHeldTurnDiff : onOpenTurnDiff}
                  subagentParent={paintOnlyDisplayedTimeline ? null : timelineSubagentParent}
                  providerSessions={
                    paintOnlyDisplayedTimeline
                      ? EMPTY_HELD_PROVIDER_SESSIONS
                      : (serverProjection?.providerSessions ?? EMPTY_HELD_PROVIDER_SESSIONS)
                  }
                  onOpenThread={onOpenRelatedThread}
                  collapseLongReports={collapseLongReports}
                  reportProjectId={collapseLongReports ? (activeProject?.id ?? null) : null}
                  reportFallbackTitle={activeThread.title}
                  onForkFromRun={paintOnlyDisplayedTimeline ? async () => {} : onForkFromRun}
                  onRollbackCheckpoint={(input) => {
                    if (!paintOnlyDisplayedTimeline) void onRollbackCheckpoint(input);
                  }}
                  supportsConversationRollback={
                    !paintOnlyDisplayedTimeline && supportsConversationRollback
                  }
                  onRevertToTurnCount={
                    paintOnlyDisplayedTimeline ? noopHeldRevert : onRevertTimelineTurn
                  }
                  {...(!paintOnlyDisplayedTimeline
                    ? { onUseArtifactTemplate: useArtifactTemplate }
                    : {})}
                  isRevertingCheckpoint={isRevertingCheckpoint}
                  onImageExpand={onExpandTimelineImage}
                  onFileOpen={paintOnlyDisplayedTimeline ? noopHeldAttachment : openFileAttachment}
                  onFileDownload={
                    paintOnlyDisplayedTimeline ? noopHeldAttachment : downloadFileAttachment
                  }
                  markdownCwd={
                    paintOnlyDisplayedTimeline
                      ? (heldPaintContext?.markdownCwd ?? undefined)
                      : (gitCwd ?? undefined)
                  }
                  resolvedTheme={resolvedTheme}
                  timestampFormat={timestampFormat}
                  workspaceRoot={
                    paintOnlyDisplayedTimeline
                      ? (heldPaintContext?.workspaceRoot ?? undefined)
                      : activeWorkspaceRoot
                  }
                  skills={
                    activeProviderStatus
                      ? resolveProviderSkillsForCwd(activeProviderStatus, gitCwd)
                      : EMPTY_PROVIDER_SKILLS
                  }
                  anchorMessageId={paintOnlyDisplayedTimeline ? null : timelineAnchorMessageId}
                  onAnchorReady={onTimelineAnchorReady}
                  onAnchorSizeChanged={onTimelineAnchorSizeChanged}
                  contentInsetEndAdjustment={composerTimelineInset}
                  contentInsetStart={timelineBannerOverlayHeight}
                  liveFollowEnabled={!paintOnlyDisplayedTimeline && timelineLiveFollowEnabled}
                  onIsAtEndChange={onIsAtEndChange}
                  onContentOverflowChange={setTimelineOverflows}
                  onToolOutputCollapsedAtEnd={onToolOutputCollapsedAtEnd}
                  onManualNavigation={cancelTimelineLiveFollowForUserNavigation}
                  cancelPositionRestoreRef={cancelPositionRestoreRef}
                  hideEmptyPlaceholder={
                    isDraftHeroState || threadDetailLoading || threadOrigin !== null
                  }
                  topFadeEnabled={!hasTimelineTopBanner}
                  {...(paintOnlyDisplayedTimeline || threadHistoryControls === undefined
                    ? {}
                    : { historyControls: threadHistoryControls })}
                />
              </TimelineActionContexts>

              {/* scroll to end pill — shown when user has scrolled away from the live edge */}
              {showScrollToBottom && (
                <div
                  className="chat-scroll-to-bottom pointer-events-none absolute z-30 flex justify-center py-1.5"
                  style={{ bottom: scrollToEndClearance + 4 }}
                >
                  <JumpToLatestButton
                    onPointerDown={(event) => event.preventDefault()}
                    onJump={() => {
                      composerRef.current?.restoreAfterTimelineReachedEnd();
                      scrollToEnd(true);
                    }}
                  />
                </div>
              )}
            </div>

            {/* Input bar — centered for an empty draft, docked after sending. */}
            <div
              ref={setComposerOverlayElement}
              inert={isRevertingCheckpoint || transcriptOnly}
              hidden={transcriptOnly}
              data-chat-composer-overlay="true"
              className={
                isDraftHeroState
                  ? "pointer-events-none absolute inset-0 z-20 flex items-center"
                  : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
              }
            >
              <div ref={draftHeroTransitionGroupRef} className="chat-composer-lane w-full">
                <div
                  data-chat-composer-stack="true"
                  className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-content-max-width)"
                >
                  {isDraftHeroState ? (
                    <div className="absolute inset-x-0 bottom-full">
                      <div
                        className="pb-4 group-has-data-[composer-shoulder-tab]/composer-stack:pb-0"
                        style={
                          forceExpandedMobileComposer
                            ? { viewTransitionName: MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME }
                            : undefined
                        }
                      >
                        <DraftHeroHeadline
                          draftId={draftId}
                          activeProjectRef={activeProjectTarget}
                          activeProjectTitle={activeProject?.title ?? null}
                          disabled={
                            envLocked ||
                            isSendBusy ||
                            backgroundSubmissionPending ||
                            isEnvironmentChanging
                          }
                          sendInFlightRef={sendInFlightRef}
                        />
                      </div>
                    </div>
                  ) : null}
                  {projectDraftSendGuard.notice}
                  <div
                    ref={draftHeroComposerAnchorRef}
                    className="relative z-10"
                    style={
                      forceExpandedMobileComposer
                        ? { viewTransitionName: MOBILE_COMPOSER_VIEW_TRANSITION_NAME }
                        : undefined
                    }
                  >
                    <ComposerSurface.Shell
                      contextStrip={showComposerContextStrip || showComposerModelStrip}
                    >
                      <ComposerSurface.Host
                        inert={isSavingQueuedEdit}
                        aria-busy={isSavingQueuedEdit}
                      >
                        <div className="relative z-10">
                          {routeKind === "draft" && draftId && composerMounted ? (
                            <DraftMachinePicker
                              key={draftId}
                              draftId={draftId}
                              disabled={envLocked || isSendBusy || backgroundSubmissionPending}
                              sendInFlightRef={sendInFlightRef}
                              onPendingChange={onDraftMachinePendingChange}
                              autoEnvironmentLabel={autoEnvironmentLabel}
                              onAutoEnvironment={
                                canAutoBalanceEnvironments &&
                                loadBalancingSettings.loadBalancingEnabled
                                  ? onAutoEnvironment
                                  : undefined
                              }
                            />
                          ) : null}
                          {showProviderSubagentBar ? (
                            <ProviderSubagentBar
                              provider={selectedProviderEntry ?? null}
                              showInstanceBadge={
                                selectedProviderEntry !== undefined &&
                                shouldShowInstanceBadge(
                                  selectedProviderEntry,
                                  providerInstanceEntries,
                                )
                              }
                              modelLabel={providerSubagentModelLabel}
                              effortLabel={providerSubagentEffortLabel}
                              status={providerSubagentStatus}
                              step={providerSubagentStep}
                              onOpenParent={
                                parentThreadLink
                                  ? () => onOpenRelatedThread(parentThreadLink.threadId)
                                  : null
                              }
                            />
                          ) : null}
                          <QuestionLiveStatus announcement={answerAnnouncement} />
                          {!composerMounted ? null : (
                            <ChatComposer
                              allowManualCodexCredits={!routesViaCoordinator(projectRouting)}
                              canOperateThread={canOperateThread}
                              reportedModelSelection={reportedModelSelection}
                              limitFallbackFrom={pairing?.original ?? null}
                              limitNextTurn={threadNextTurn}
                              limitFallbackOrder={threadFallbackOrder}
                              modelStateHeader={modelStateHeader}
                              multipleModelSelections={multipleModelSelections}
                              supportsMultipleModels={
                                serverConfig?.environment.capabilities.requiredWorktreeBootstrap ===
                                true
                              }
                              onMultipleModelSelectionsChange={setMultipleModelSelections}
                              composerRef={composerRef}
                              composerDraftTarget={composerDraftTarget}
                              environmentId={environmentId}
                              attachmentUploadsCapabilityKnown={attachmentUploadsCapabilityKnown}
                              supportsAttachmentUploads={supportsAttachmentUploads}
                              supportsQuestionAttachments={supportsQuestionAttachments}
                              maxFileAttachmentBytes={maxFileAttachmentBytes}
                              routeKind={routeKind}
                              routeThreadRef={routeThreadTarget}
                              draftId={draftId}
                              activeThreadId={activeThreadId}
                              activeThreadEnvironmentId={activeThread?.environmentId}
                              activeThread={activeThread}
                              activeThreadShell={activeThreadShell}
                              promptHistoryMessages={timelineMessages}
                              isServerThread={isServerThread}
                              isLocalDraftThread={isLocalDraftThread}
                              forceExpandedOnMobile={
                                forceExpandedMobileComposer && isDraftHeroState
                              }
                              projectSelectionRequired={
                                isLocalDraftThread && activeProject === null
                              }
                              phase={phase}
                              canInterrupt={canInterruptRunningThread}
                              isConnecting={isConnecting}
                              isSendBusy={isSendBusy || isSavingQueuedEdit || isResuming}
                              canResume={resumableRunId !== null || hasHeldQueuedRuns}
                              isRevertingCheckpoint={isRevertingCheckpoint}
                              sendDisabledReason={
                                !canOperateThread
                                  ? "This connection cannot change threads."
                                  : isEnvironmentChanging
                                    ? "Preparing machine"
                                    : isRevertingCheckpoint
                                      ? "Rewinding conversation"
                                      : feedbackUploading
                                        ? "Sending feedback"
                                        : threadDetailLoading
                                          ? "Messages loading"
                                          : worktreeSetupBlocksSend
                                            ? "Preparing worktree"
                                            : projectCloneSendBlockReason
                              }
                              isPreparingWorktree={isPreparingWorktree}
                              queuedRunsControl={
                                isServerThread && activeThread ? (
                                  <QueuedRunsControl
                                    ref={queuedRunsControlRef}
                                    steerShortcutLabel={shortcutLabelForCommand(
                                      keybindings,
                                      "thread.steerQueuedMessage",
                                      { context: { terminalFocus: false } },
                                    )}
                                    editShortcutLabel={shortcutLabelForCommand(
                                      keybindings,
                                      "thread.editQueuedMessage",
                                      { context: { composerFocus: true } },
                                    )}
                                    environmentId={activeThread.environmentId}
                                    threadId={activeThread.id}
                                    optimisticMessages={optimisticUserMessages}
                                    editingRunId={editingQueuedRun?.runId ?? null}
                                    onEditQueuedRun={beginEditingQueuedRun}
                                    onCancelEdit={cancelEditingQueuedRun}
                                    onResumeHeld={
                                      hasHeldQueuedRuns && canOperateThread
                                        ? () => void onResume()
                                        : undefined
                                    }
                                    resumeBusy={
                                      isSendBusy ||
                                      isResuming ||
                                      isConnecting ||
                                      threadDetailLoading ||
                                      isRevertingCheckpoint
                                    }
                                    actionsUnavailableReason={queuedActionsUnavailableReason}
                                  />
                                ) : null
                              }
                              bannerItems={composerBannerItems}
                              // With attachments or contexts aboard the pick just inserts the
                              // text, so it sends as a prompt like the typed path would.
                              onUsageLimitsCommand={
                                usageLimitsOffered &&
                                usageLimitsKey !== null &&
                                !composerHasNonPromptContent
                                  ? openUsageLimits
                                  : undefined
                              }
                              onAppCommand={appCommandsOffered ? runAppCommand : undefined}
                              environmentUnavailable={activeEnvironmentUnavailableState}
                              activePendingApproval={activePendingApproval}
                              pendingApprovals={pendingApprovals}
                              pendingUserInputs={pendingUserInputs}
                              answerProblem={shownAnswerProblem}
                              onDismissAnswerProblem={dismissAnswerProblem}
                              activePendingProgress={activePendingProgress}
                              activePendingResolvedAnswers={activePendingResolvedAnswers}
                              activePendingIsResponding={activePendingIsResponding}
                              activePendingDraftAnswers={activePendingDraftAnswers}
                              activePendingQuestionIndex={activePendingQuestionIndex}
                              respondingRequestIds={respondingRequestIds}
                              showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                              activeProposedPlan={activeProposedPlan}
                              threadSyncPhase={
                                activeEnvironmentUnavailable ? null : threadSyncPhase
                              }
                              runtimeMode={runtimeMode}
                              interactionMode={interactionMode}
                              lockedProvider={modelPickerLockedProvider}
                              providerStatuses={providerStatuses as ServerProvider[]}
                              providerCatalogKnown={serverConfig !== null}
                              activeProjectDefaultModelSelection={
                                activeProjectDefaultModelSelection
                              }
                              activeThreadModelSelection={activeThread?.modelSelection}
                              activeContextWindow={activeContextWindow}
                              activeTasksProgress={activeComposerTasksProgress}
                              activeTaskSteps={activeComposerTaskSteps}
                              compactThreadUnavailable={compactThreadUnavailable}
                              compactDisabled={compactDisabled}
                              compactDisabledReason={compactDisabledReason}
                              resolvedTheme={resolvedTheme}
                              settings={settings}
                              keybindings={keybindings}
                              terminalOpen={Boolean(terminalUiState.terminalOpen)}
                              gitCwd={gitCwd}
                              pullRequestProjectId={
                                supportsPullRequests ? (activeProject?.id ?? null) : null
                              }
                              pullRequestRepository={
                                supportsPullRequests ? activeProjectRepository : null
                              }
                              restingControlsHost={restingComposerControlsHost}
                              restingControlsHaveLeadingContext={
                                mountComposerContextStrip &&
                                (isGitRepo || showComposerEnvironmentIndicator)
                              }
                              onRestingControlsVisibilityChange={setRestingComposerControlsVisible}
                              getTimelineScrollableNode={getTimelineScrollableNode}
                              isTimelineAtLogicalEnd={isTimelineAtLogicalEnd}
                              timelineOverflows={timelineOverflows}
                              onComposerOverlayHeightChange={publishComposerOverlayHeight}
                              onRestingChange={onComposerRestingChange}
                              promptRef={promptRef}
                              composerImagesRef={composerImagesRef}
                              composerFilesRef={composerFilesRef}
                              composerTerminalContextsRef={composerTerminalContextsRef}
                              onPageScrollKeyDown={onComposerPageScrollKeyDown}
                              onPageScrollKeyUp={onComposerPageScrollKeyUp}
                              onPageScrollRelease={onComposerPageScrollRelease}
                              onCompactContext={onCompactContext}
                              onSend={(event, mode, intent, credit) =>
                                onSend(event, mode, intent, undefined, credit)
                              }
                              onResume={() => void resumeWithComposerModel()}
                              onInterrupt={onInterrupt}
                              onImplementPlanInNewThread={onImplementPlanInNewThread}
                              onRespondToApproval={onRespondToApproval}
                              onSelectActivePendingUserInputOption={
                                onSelectActivePendingUserInputOption
                              }
                              onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
                              onDismissActivePendingUserInput={onDismissUserInput}
                              onPreviousActivePendingUserInputQuestion={
                                onPreviousActivePendingUserInputQuestion
                              }
                              onProviderModelSelect={onProviderModelSelect}
                              onOpenProviderSetup={openProviderSetup}
                              getModelDisabledReason={getModelDisabledReason}
                              toggleInteractionMode={toggleInteractionMode}
                              handleRuntimeModeChange={handleRuntimeModeChange}
                              handleInteractionModeChange={handleInteractionModeChange}
                              focusComposer={focusComposer}
                              scheduleComposerFocus={scheduleComposerFocus}
                              setThreadError={setThreadError}
                              onExpandImage={onExpandTimelineImage}
                              onFileOpen={openFileAttachment}
                              editingQueuedAttachments={composerEditingQueuedAttachments}
                              onRemoveEditingQueuedAttachment={removeEditingQueuedAttachment}
                            />
                          )}
                        </div>
                      </ComposerSurface.Host>
                      <div className="min-h-0">
                        <div
                          data-terminal-open={terminalUiState.terminalOpen ? "true" : undefined}
                          className="relative z-0"
                        >
                          {mountComposerModelStrip ? (
                            <ComposerSurface.ContextStrip
                              data-composer-model-strip="true"
                              aria-hidden={showComposerModelStrip ? undefined : true}
                              inert={showComposerModelStrip ? undefined : true}
                              className={cn(
                                "ps-2 group-data-model-strip-transition/composer-surface:before:backdrop-blur-(--glass-blur) group-data-model-strip-transition/composer-surface:before:bg-(--chat-composer-glass-surface)/(--glass-opacity)",
                                !showComposerModelStrip &&
                                  "pointer-events-none invisible absolute inset-x-0 top-full",
                              )}
                            >
                              <div
                                ref={setRestingComposerControlsHost}
                                className="min-w-0 flex-1"
                              />
                            </ComposerSurface.ContextStrip>
                          ) : null}
                          {mountComposerContextStrip && (
                            <div className="pointer-events-auto">
                              <BranchToolbar
                                forceNewWorktree={multipleModelSelections !== null}
                                ref={branchToolbarRef}
                                environmentId={activeThread.environmentId}
                                threadId={activeThread.id}
                                showGitControls={isGitRepo}
                                {...(routeKind === "draft" && draftId ? { draftId } : {})}
                                onEnvModeChange={onEnvModeChange}
                                startFromOrigin={startFromOrigin}
                                onStartFromOriginChange={onStartFromOriginChange}
                                envMode={envMode}
                                {...(canOverrideServerThreadEnvMode
                                  ? {
                                      activeThreadBranchOverride: activeThreadBranch,
                                      onActiveThreadBranchOverrideChange:
                                        setPendingServerThreadBranch,
                                    }
                                  : {})}
                                envLocked={envLocked}
                                onComposerFocusRequest={scheduleComposerFocus}
                                {...(canCheckoutPullRequestIntoThread
                                  ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                                  : {})}
                                {...(hasMultipleEnvironments ? { onEnvironmentChange } : {})}
                                autoEnvironmentLabel={autoEnvironmentLabel}
                                onAutoEnvironment={
                                  draftId &&
                                  !envLocked &&
                                  canAutoBalanceEnvironments &&
                                  loadBalancingSettings.loadBalancingEnabled
                                    ? onAutoEnvironment
                                    : undefined
                                }
                                availableEnvironments={logicalProjectEnvironments}
                                composerControlsHostRef={setRestingComposerControlsHost}
                                contextStripVisible={showComposerContextStrip}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </ComposerSurface.Shell>
                    <div
                      aria-hidden
                      className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                    />
                  </div>
                </div>
              </div>
            </div>

            {canOperatePreview && activeThreadTarget && activeEnvironmentServerBrowser ? (
              <PreviewSessionSync threadRef={activeThreadTarget} />
            ) : null}
            {activeThreadTarget &&
            activePreviewMiniPlayer &&
            previewMiniPlayerVisible &&
            (activePreviewMiniPlayer.source.kind === "device" || canOperatePreview) ? (
              <ThreadPreviewMiniPlayer
                key={`${activeThreadKey}:${previewMiniPlayerSourceKey(activePreviewMiniPlayer.source)}`}
                threadRef={activeThreadTarget}
                miniPlayer={activePreviewMiniPlayer}
              />
            ) : null}

            <AlertDialog open={branchRestoreConfirmOpen} onOpenChange={setBranchRestoreConfirmOpen}>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Switch to{" "}
                    <code className="font-medium">
                      {localCheckoutBranchMismatch?.threadBranch ?? ""}
                    </code>
                    ?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    You have uncommitted changes. They'll carry over to the other branch, or block
                    the switch if they conflict.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                  <Button
                    variant="default"
                    disabled={!canWriteSourceControl}
                    onClick={() => {
                      setBranchRestoreConfirmOpen(false);
                      void handleSwitchCheckoutToThread();
                    }}
                  >
                    Switch branch
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>

            <ThreadDetailsPanel {...threadDetailsPanelProps} />

            {pullRequestDialogState ? (
              <PullRequestThreadDialog
                key={pullRequestDialogState.key}
                open
                environmentId={activeThread.environmentId}
                threadId={activeThread.id}
                cwd={activeProject?.workspaceRoot ?? null}
                initialReference={pullRequestDialogState.initialReference}
                onOpenChange={(open) => {
                  if (!open) {
                    closePullRequestDialog();
                  }
                }}
                onPrepared={handlePreparedPullRequestThread}
              />
            ) : null}
          </ChatCanvas>
          {/* end chat column */}
        </div>
        {/* end horizontal flex container */}

        {mountedTerminalThreadRefs.map(({ key: mountedThreadKey, threadRef: mountedThreadRef }) => (
          <PersistentThreadTerminalDrawer
            key={mountedThreadKey}
            threadRef={mountedThreadRef}
            threadId={mountedThreadRef.threadId}
            active={mountedThreadKey === activeThreadKey}
            launchContext={
              mountedThreadKey === activeThreadKey ? (activeTerminalLaunchContext ?? null) : null
            }
            focusRequestId={mountedThreadKey === activeThreadKey ? terminalFocusRequestId : 0}
            splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
            splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
            newShortcutLabel={newTerminalShortcutLabel ?? undefined}
            closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
            keybindings={keybindings}
            onAddTerminalContext={addTerminalContextToDraft}
          />
        ))}
      </div>

      {rightPanelPresent && !shouldUsePlanSidebarSheet && activeThreadTarget ? (
        <RightPanelTabs
          mode="inline"
          open={rightPanelOpen}
          keybindings={keybindings}
          getShortcutContext={getShortcutContext}
          maximized={rightPanelMaximized}
          inlineSize={previewPanelInlineSize}
          surfaces={renderedRightPanelSurfaces}
          environmentId={activeThreadTarget.environmentId}
          activeSurfaceId={renderedRightPanelSurface?.id ?? null}
          pendingSurfaceIds={pendingFileSurfaceIds}
          previewSessions={activePreviewState.sessions}
          desktopByTabId={activePreviewState.desktopByTabId}
          previewRuntimeTabId={resolvePreviewRuntimeTabId}
          terminalLabelsById={activeTerminalLabelsById}
          onActivate={activateRightPanelSurface}
          onCloseSurface={closeRightPanelSurface}
          onRenameDevice={(surfaceId, title) => {
            if (activeThreadTarget)
              useRightPanelStore.getState().renameDevice(activeThreadTarget, surfaceId, title);
          }}
          onCloseOtherSurfaces={closeOtherRightPanelSurfaces}
          onCloseSurfacesToRight={closeRightPanelSurfacesToRight}
          onCloseAllSurfaces={closeAllRightPanelSurfaces}
          onCopyFilePath={copyRightPanelFilePath}
          onAddBrowser={() => createBrowserSurface()}
          onAddBrowserInProfile={createBrowserSurface}
          onAddTerminal={addTerminalSurface}
          onAddDiff={addDiffSurface}
          onAddFiles={addFilesSurface}
          onAddPullRequest={addPullRequestSurface}
          onAddPullRequests={addPullRequestsSurface}
          onAddDevice={addDeviceSurface}
          browserAvailable={canOperatePreview && browserAvailable}
          terminalAvailable={activeProject !== null && canOperateTerminal}
          diffAvailable={isServerThread && isGitRepo}
          filesAvailable={activeProject !== null}
          pullRequestAvailable={pullRequestSurfaceAvailable}
          pullRequestsAvailable={pullRequestsSurfaceAvailable}
          deviceAvailable={activeThreadTarget !== null}
        >
          {rightPanelContent}
        </RightPanelTabs>
      ) : null}
      {rightPanelPresent && shouldUsePlanSidebarSheet && activeThreadTarget ? (
        <RightPanelSheet
          animationDurationMs={panelAnimationsActive ? panelAnimationDurationMs : 0}
          open={rightPanelOpen}
          onClose={closePreviewPanel}
        >
          <RightPanelTabs
            mode="sheet"
            open={rightPanelOpen}
            keybindings={keybindings}
            getShortcutContext={getShortcutContext}
            inlineSize={previewPanelInlineSize}
            // Same effective inset as the closed-state titlebar controls
            // (pr-3 in the tab bar plus this pixel equals the absolute
            // right inset plus mr-px), so the cluster does not creep when
            // the sheet opens.
            layoutControls={
              rightPanelOpen ? (
                <div className="mr-px flex items-center">{panelToggleControls}</div>
              ) : null
            }
            surfaces={renderedRightPanelSurfaces}
            environmentId={activeThreadTarget.environmentId}
            activeSurfaceId={renderedRightPanelSurface?.id ?? null}
            pendingSurfaceIds={pendingFileSurfaceIds}
            previewSessions={activePreviewState.sessions}
            desktopByTabId={activePreviewState.desktopByTabId}
            previewRuntimeTabId={resolvePreviewRuntimeTabId}
            terminalLabelsById={activeTerminalLabelsById}
            onActivate={activateRightPanelSurface}
            onCloseSurface={closeRightPanelSurface}
            onRenameDevice={(surfaceId, title) => {
              if (activeThreadTarget)
                useRightPanelStore.getState().renameDevice(activeThreadTarget, surfaceId, title);
            }}
            onCloseOtherSurfaces={closeOtherRightPanelSurfaces}
            onCloseSurfacesToRight={closeRightPanelSurfacesToRight}
            onCloseAllSurfaces={closeAllRightPanelSurfaces}
            onCopyFilePath={copyRightPanelFilePath}
            onAddBrowser={() => createBrowserSurface()}
            onAddBrowserInProfile={createBrowserSurface}
            onAddTerminal={addTerminalSurface}
            onAddDiff={addDiffSurface}
            onAddFiles={addFilesSurface}
            onAddPullRequest={addPullRequestSurface}
            onAddPullRequests={addPullRequestsSurface}
            onAddDevice={addDeviceSurface}
            browserAvailable={canOperatePreview && browserAvailable}
            terminalAvailable={activeProject !== null && canOperateTerminal}
            diffAvailable={isServerThread && isGitRepo}
            filesAvailable={activeProject !== null}
            pullRequestAvailable={pullRequestSurfaceAvailable}
            pullRequestsAvailable={pullRequestsSurfaceAvailable}
            deviceAvailable={activeThreadTarget !== null}
          >
            {rightPanelContent}
          </RightPanelTabs>
        </RightPanelSheet>
      ) : null}

      <AlertDialog
        open={pendingRevert !== null && pendingRevert.routeThreadKey === routeThreadKey}
        onOpenChange={(open) => {
          if (!open) setPendingRevert(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Edit from here?</AlertDialogTitle>
            <AlertDialogDescription>
              Rewind chat to before this message. Your prompt and attachments return to the
              composer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (!pendingRevert || pendingRevert.routeThreadKey !== routeThreadKey) return;
                setPendingRevert(null);
                void onRevertToTurnCount(pendingRevert.turnCount, pendingRevert.messageId, true);
              }}
            >
              Revert files too
            </Button>
            <Button
              onClick={() => {
                if (!pendingRevert || pendingRevert.routeThreadKey !== routeThreadKey) return;
                setPendingRevert(null);
                void onRevertToTurnCount(pendingRevert.turnCount, pendingRevert.messageId, false);
              }}
            >
              Revert and keep changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <LinkPullRequestDialogHost />
      <LinkIncrementDialogHost />
      {expandedImage && (
        <ExpandedImageDialog
          key={expandedImageKey(expandedImage)}
          preview={expandedImage}
          onClose={closeExpandedImage}
          // A thread's media opens beside the thread, so it can be steered meanwhile.
          threadRef={isServerThread ? routeThreadTarget : null}
        />
      )}
    </div>
  );
}

/** Keeps the thread's preview tabs synced while no browser panel is mounted. */
function PreviewSessionSync(props: { readonly threadRef: ScopedThreadRef }) {
  usePreviewSession(props.threadRef);
  return null;
}
