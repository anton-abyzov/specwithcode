/*
 * Synthetic data only: the production ChatComposer as the October 23 report shows it.
 * A usage limit moved the thread from Claude Code · Opus 5.5 to Codex · GPT-6.1-Sol
 * (27% left), Opus has room again, effort Low, Full access, and the "Continuing on"
 * pairing notice above. `?case=running` this turn runs on Codex while the saved model
 * is Opus; `?case=same` nothing to add. `?theme=dark` the theme; `?width=` the column
 * width in px, in a desktop-sized window, as a narrow chat pane is.
 */
import { useEffect, useRef } from "react";
import { useComposerDraftStore } from "../../src/composerDraftStore";
import { limitFallbackPairingBannerItem } from "../../src/components/chat/UsageLimitRecoveryBanner";
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
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
// The default "system" theme, as most people run it; the runner sets prefers-color-scheme too.
document.documentElement.classList.toggle("dark", dark);

const NOW = Date.parse("2026-10-23T15:00:00Z");
Date.now = () => NOW;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const environmentId = EnvironmentId.make("env-fixture");
const threadId = ThreadId.make("thread-fixture");
const threadRef = scopeThreadRef(environmentId, threadId);

const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");
const devin = ProviderInstanceId.make("acpRegistry_devin");
const base = {
  enabled: true,
  installed: true,
  version: "fixture",
  status: "ready",
  auth: { status: "authenticated", type: "subscription" },
  checkedAt: iso(NOW),
  slashCommands: [],
  skills: [],
} as const;
const reasoning = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "low",
    },
  ],
};
const providers = [
  {
    ...base,
    instanceId: claude,
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities: {} }],
    usageLimits: {
      checkedAt: iso(NOW - 120_000),
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 4,
          resetsAt: iso(NOW + 4 * HOUR),
        },
      ],
    },
  },
  {
    ...base,
    instanceId: codex,
    driver: ProviderDriverKind.make("codex"),
    models: [
      { slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", isCustom: false, capabilities: reasoning },
    ],
    usageLimits: {
      checkedAt: iso(NOW - 120_000),
      windows: [
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 73,
          resetsAt: iso(NOW + 3 * HOUR),
        },
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 12,
          resetsAt: iso(NOW + 100 * HOUR),
        },
      ],
    },
  },
  {
    ...base,
    instanceId: devin,
    driver: ProviderDriverKind.make("acpRegistry"),
    displayName: "Devin",
    acpRegistryAgentId: "devin",
    models: [
      { slug: "gpt-6-1-sol-medium", name: "GPT-6.1 Sol", isCustom: false, capabilities: {} },
    ],
  },
] as unknown as ServerProvider[];
const opus = { instanceId: claude, model: "claude-opus-5-5" } as ModelSelection;
const sol = {
  instanceId: codex,
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "low" }],
} as ModelSelection;

const scenarios: Record<
  string,
  { thread: ModelSelection; running: ModelSelection | null; fallbackFrom: ModelSelection | null }
> = {
  fallback: { thread: sol, running: null, fallbackFrom: opus },
  "fallback-room": { thread: sol, running: null, fallbackFrom: opus },
  running: { thread: opus, running: sol, fallbackFrom: null },
  same: { thread: sol, running: null, fallbackFrom: null },
  // Devin's GPT-6.1 Sol standing in for Codex's: the same model name on another provider.
  twin: {
    thread: { instanceId: devin, model: "gpt-6-1-sol-medium" } as ModelSelection,
    running: null,
    fallbackFrom: sol,
  },
};
const scenarioName = params.get("case") ?? "fallback";
const scenario = scenarios[scenarioName] ?? scenarios.fallback!;
const hasRoom = scenarioName === "fallback-room";
const onBack = () => {
  document.body.dataset.backClicked = "true";
};
const pairingBanner = scenario.fallbackFrom
  ? limitFallbackPairingBannerItem({
      id: "limit-pairing",
      original: scenarioName === "twin" ? "Codex · GPT-6.1-Sol" : "Claude Code · Opus 5.5",
      originalModel: scenarioName === "twin" ? "Codex" : "Opus 5.5",
      resetAt: NOW + HOUR,
      hasRoom,
      onBack,
      onDismiss: () => {},
    })
  : null;
const bannerItems = pairingBanner ? [pairingBanner] : [];
const modelStateHeader = scenario.fallbackFrom
  ? {
      title: "Fallback for Claude Code · Opus 5.5",
      detail: hasRoom
        ? "Opus 5.5 hit its usage limit and has room again."
        : "Opus 5.5 hit its usage limit and resets at 3:40 PM.",
      back: {
        label: "Back to Opus 5.5",
        onClick: onBack,
        disabledReason: hasRoom ? null : "Available at 3:40 PM",
      },
    }
  : null;
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
    <main
      className="flex min-h-screen flex-col justify-end gap-4 p-4"
      style={{ width: Number(params.get("width") ?? 900) }}
      data-fixture-composer
    >
      <div className="@container/composer-surface">
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
          bannerItems={bannerItems}
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
          modelStateHeader={modelStateHeader}
          activeContextWindow={null}
          compactThreadUnavailable
          compactDisabled
          compactDisabledReason={null}
          resolvedTheme={dark ? "dark" : "light"}
          settings={DEFAULT_UNIFIED_SETTINGS}
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
      </div>
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
