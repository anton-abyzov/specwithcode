/*
 * Synthetic data only: the production ChatComposer with an Opus 5.5 thread whose
 * Claude model offers Ultracode as its own toggle beside reasoning effort.
 * `?case=on` Medium with Ultracode on; `?case=off` Medium alone;
 * `?case=legacy` a selection saved when Ultracode was an effort level.
 * `?theme=dark` the theme.
 */
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { useComposerDraftStore } from "../../src/composerDraftStore";
import { ChatComposer, type ChatComposerHandle } from "../../src/components/chat/ChatComposer";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../../src/composerDraftStore";
import type { TerminalContextDraft } from "../../src/lib/terminalContext";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { ToastProvider, AnchoredToastProvider } from "../../src/components/ui/toast";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const environmentId = EnvironmentId.make("env-fixture");
const threadId = ThreadId.make("thread-fixture");
const threadRef = scopeThreadRef(environmentId, threadId);

const claude = ProviderInstanceId.make("claudeAgent");
// What the server sends for Opus 5.5 once Ultracode leaves the effort list.
const capabilities = {
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra High" },
        { id: "max", label: "Max" },
      ],
    },
    {
      id: "ultracode",
      label: "Ultracode",
      description: "Multi-agent workflows on every task, at any effort",
      type: "boolean",
    },
  ],
};
const providers = [
  {
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-28T00:00:00.000Z",
    slashCommands: [],
    skills: [],
    instanceId: claude,
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities }],
  },
] as unknown as ServerProvider[];
const settings = DEFAULT_UNIFIED_SETTINGS;
const OPTIONS: Record<string, ModelSelection["options"]> = {
  on: [
    { id: "effort", value: "medium" },
    { id: "ultracode", value: true },
  ],
  off: [{ id: "effort", value: "medium" }],
  legacy: [{ id: "effort", value: "ultracode" }],
};
const thread = {
  instanceId: claude,
  model: "claude-opus-5-5",
  options: OPTIONS[params.get("case") ?? "on"] ?? OPTIONS.on,
} as ModelSelection;
useComposerDraftStore.getState().setModelSelection(threadRef, thread, { explicit: true });

function Harness() {
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const composerRef = useRef<ChatComposerHandle | null>(null);
  useEffect(() => {
    document.body.dataset.fixtureReady = "true";
  }, []);
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-end gap-4 p-6">
      <section className="space-y-3">
        <div className="ms-auto w-fit max-w-[80%] rounded-2xl bg-secondary px-4 py-2 text-sm text-foreground">
          Audit the release scripts and fix what is broken.
        </div>
      </section>
      <ChatComposer
        composerDraftTarget={threadRef}
        environmentId={environmentId}
        canOperateThread
        attachmentUploadsCapabilityKnown
        supportsAttachmentUploads
        supportsQuestionAttachments
        maxFileAttachmentBytes={20 * 1024 * 1024}
        routeKind="server"
        routeThreadRef={threadRef}
        draftId={null}
        multipleModelSelections={null}
        supportsMultipleModels={false}
        onMultipleModelSelectionsChange={() => {}}
        activeThreadId={threadId}
        activeThreadEnvironmentId={environmentId}
        activeThread={undefined}
        activeThreadShell={null}
        promptHistoryMessages={[]}
        isServerThread
        isLocalDraftThread={false}
        forceExpandedOnMobile={false}
        projectSelectionRequired={false}
        phase="ready"
        canInterrupt={false}
        isConnecting={false}
        isSendBusy={false}
        canResume={false}
        sendDisabledReason={null}
        isPreparingWorktree={false}
        bannerItems={[]}
        environmentUnavailable={null}
        activePendingApproval={null}
        pendingApprovals={[]}
        pendingUserInputs={[]}
        activePendingProgress={null}
        activePendingResolvedAnswers={null}
        activePendingIsResponding={false}
        activePendingDraftAnswers={{}}
        activePendingQuestionIndex={0}
        respondingRequestIds={[]}
        showPlanFollowUpPrompt={false}
        activeProposedPlan={null}
        activeTasksProgress={null}
        activeTaskSteps={null}
        threadSyncPhase={null}
        runtimeMode="full-access"
        interactionMode="default"
        lockedProvider={null}
        providerStatuses={providers}
        providerCatalogKnown
        activeProjectDefaultModelSelection={thread}
        activeThreadModelSelection={thread}
        reportedModelSelection={null}
        limitFallbackFrom={null}
        activeContextWindow={null}
        compactThreadUnavailable
        compactDisabled
        compactDisabledReason={null}
        resolvedTheme={dark ? "dark" : "light"}
        settings={settings}
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        terminalOpen={false}
        gitCwd="/Users/fixture/project"
        pullRequestProjectId={null}
        pullRequestRepository={null}
        restingControlsHost={null}
        restingControlsHaveLeadingContext={false}
        onRestingControlsVisibilityChange={() => {}}
        getTimelineScrollableNode={() => null}
        isTimelineAtLogicalEnd={() => true}
        timelineOverflows={false}
        onComposerOverlayHeightChange={() => {}}
        onRestingChange={() => {}}
        promptRef={promptRef}
        composerImagesRef={composerImagesRef}
        composerFilesRef={composerFilesRef}
        composerTerminalContextsRef={composerTerminalContextsRef}
        composerRef={composerRef}
        onPageScrollKeyDown={() => {}}
        onPageScrollKeyUp={() => {}}
        onPageScrollRelease={() => {}}
        editingQueuedAttachments={null}
        onRemoveEditingQueuedAttachment={() => {}}
        onCompactContext={() => {}}
        onSend={(event) => event?.preventDefault()}
        onResume={() => {}}
        onInterrupt={() => {}}
        onImplementPlanInNewThread={() => {}}
        onRespondToApproval={async () => {}}
        onSelectActivePendingUserInputOption={() => {}}
        onAdvanceActivePendingUserInput={() => {}}
        onDismissActivePendingUserInput={() => {}}
        onPreviousActivePendingUserInputQuestion={() => {}}
        onProviderModelSelect={(instanceId, model) =>
          useComposerDraftStore
            .getState()
            .setModelSelection(threadRef, { instanceId, model }, { explicit: true })
        }
        onOpenProviderSetup={() => {}}
        getModelDisabledReason={() => null}
        toggleInteractionMode={() => {}}
        handleRuntimeModeChange={() => {}}
        handleInteractionModeChange={() => {}}
        focusComposer={() => composerRef.current?.focusAtEnd()}
        scheduleComposerFocus={() => composerRef.current?.focusAtEnd()}
        setThreadError={() => {}}
        onExpandImage={() => {}}
        onFileOpen={() => {}}
      />
    </main>
  );
}

const router = createRouter({
  history: createMemoryHistory(),
  routeTree: createRootRoute({
    component: () => (
      <ToastProvider>
        <AnchoredToastProvider>
          <TooltipProvider>
            <Harness />
          </TooltipProvider>
        </AnchoredToastProvider>
      </ToastProvider>
    ),
  }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
