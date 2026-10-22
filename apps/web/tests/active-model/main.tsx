import { threadModelIdentity } from "@specweave-studio/shared/threadModelIdentity";
import { ThreadModelBadge } from "../../src/components/studio/shell/ModelBadge";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../src/providerInstances";
import { useComposerDraftStore } from "../../src/composerDraftStore";
/*
 * Synthetic data only: the production ChatComposer with its model chip, no host.
 * `?case=fallback` a usage limit moved the thread from Opus to Gemini; `?case=running`
 * this turn runs on Gemini while the saved preference is Opus;
 * `?case=stale` retains an old explicit draft; manual scenarios preserve the next-send choice.
 * `?case=same` nothing to add. `?theme=dark` the theme.
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
const gemini = ProviderInstanceId.make("acpRegistry_gemini");
const base = {
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-22T00:00:00.000Z",
  slashCommands: [],
  skills: [],
} as const;
const providers = [
  {
    ...base,
    instanceId: claude,
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities: {} }],
  },
  {
    ...base,
    instanceId: gemini,
    driver: ProviderDriverKind.make("acpRegistry"),
    displayName: "Gemini CLI",
    models: [{ slug: "default", name: "Default", isCustom: false, capabilities: {} }],
  },
] as unknown as ServerProvider[];
const opus = { instanceId: claude, model: "claude-opus-5-5" } as ModelSelection;
const geminiDefault = { instanceId: gemini, model: "default" } as ModelSelection;

// A non-default instance only counts once settings configure it, as on a real host.
const settings = {
  ...DEFAULT_UNIFIED_SETTINGS,
  providerInstances: {
    ...DEFAULT_UNIFIED_SETTINGS.providerInstances,
    [gemini]: { driver: "acpRegistry", enabled: true, config: { agentId: "gemini" } },
  },
} as typeof DEFAULT_UNIFIED_SETTINGS;

const scenarios: Record<
  string,
  { thread: ModelSelection; running: ModelSelection | null; fallbackFrom: ModelSelection | null }
> = {
  "running-manual": { thread: opus, running: geminiDefault, fallbackFrom: null },
  "running-manual-active": { thread: opus, running: geminiDefault, fallbackFrom: null },
  manual: { thread: opus, running: null, fallbackFrom: null },
  stale: { thread: geminiDefault, running: null, fallbackFrom: opus },
  fallback: { thread: geminiDefault, running: null, fallbackFrom: opus },
  running: { thread: opus, running: geminiDefault, fallbackFrom: null },
  same: { thread: opus, running: opus, fallbackFrom: null },
};
const scenario = scenarios[params.get("case") ?? "fallback"] ?? scenarios.fallback!;

const identity = threadModelIdentity({
  thread: scenario.thread,
  running: scenario.running,
  fallbackFrom: scenario.fallbackFrom,
});
const entries = new Map(
  applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings).map((entry) => [
    entry.instanceId,
    entry,
  ]),
);
if (params.get("case") === "stale")
  useComposerDraftStore.getState().setModelSelection(threadRef, opus, { explicit: true });
if (params.get("case") === "manual")
  useComposerDraftStore.getState().setModelSelection(threadRef, geminiDefault, { explicit: true });
if (params.get("case") === "running-manual")
  useComposerDraftStore.getState().setModelSelection(threadRef, opus, { explicit: true });
if (params.get("case") === "running-manual-active")
  useComposerDraftStore.getState().setModelSelection(threadRef, geminiDefault, { explicit: true });
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
      <div data-list-model className="flex items-center gap-2">
        <ThreadModelBadge
          thread={{ modelSelection: scenario.thread, modelIdentity: identity }}
          entries={entries}
        />
      </div>
      <section className="space-y-3">
        <div className="ms-auto w-fit max-w-[80%] rounded-2xl bg-secondary px-4 py-2 text-sm text-foreground">
          Make the settings page header match the rest of the app.
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
        phase={scenario.running ? "running" : "ready"}
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
        activeProjectDefaultModelSelection={opus}
        activeThreadModelSelection={scenario.thread}
        reportedModelSelection={scenario.running}
        limitFallbackFrom={scenario.fallbackFrom}
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
