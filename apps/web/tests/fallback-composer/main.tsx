/*
 * Synthetic data only: the production ChatComposer as the October 23 report shows it.
 * A usage limit moved the thread from Claude Code · Opus 5.5 to Codex · GPT-6.1-Sol
 * (27% left), Opus has room again, effort Low, Full access; the picker states the fallback. `?case=running` this turn runs on Codex while the saved model
 * is Opus; `?case=same` (or `idle`) nothing to add; `?case=next` the next message goes
 * to Opus, picked by hand while the thread is on Codex; `?case=long` the thread is on a
 * long custom Codex model id, nothing else to add. `?theme=dark` the theme;
 * `?width=` the column width in px, in a desktop-sized window, as a narrow chat pane is.
 * `?surface=design` puts the composer in the design editor's thread column (the real
 * BoundThreadPane); `?surface=coordinator` renders the real CoordinatorModelPicker in
 * the coordinator composer's footer markup instead; `?surface=details` puts it in the
 * production ChatComposer's toolbar, as the project's coordinator details pane does.
 */
import { useEffect, useRef, useState } from "react";
import { useComposerDraftStore } from "../../src/composerDraftStore";
import { NO_PROVIDER_MODEL_SELECTION } from "../../src/providerInstances";
import { fallbackChain, fallbackStatusHeader } from "../../src/components/chat/fallbackStatus";
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
import { BoundThreadPane } from "../../src/components/design/editor/BoundThreadPane";
import { CoordinatorModelPicker } from "../../src/components/studio/shell/CoordinatorModelPicker";
import { ProjectMessageRoutingContext } from "../../src/studio/projectMessageRouting";
import { fixtureEnvironment } from "./environments";
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
const LONG_MODEL = "gpt-6.1-sol-codex-max-2026-10-01-preview";
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
// `?tier=fast` or `?tier=standard` adds Codex's Service Tier at Medium effort, as the
// October 25 report shows it.
const tier = params.get("tier");
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
      currentValue: tier ? "medium" : "low",
    },
    ...(tier
      ? [
          {
            id: "serviceTier",
            label: "Service Tier",
            type: "select",
            options: [
              { id: "default", label: "Standard", isDefault: true },
              { id: "priority", label: "Fast", description: "2x speed, increased usage" },
            ],
            currentValue: tier === "fast" ? "priority" : "default",
          },
        ]
      : []),
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
          usedPercent: params.get("case") === "draft-seeded" ? 100 : 4,
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
      { slug: LONG_MODEL, name: LONG_MODEL, isCustom: true, capabilities: reasoning },
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
  options: tier
    ? [
        { id: "reasoningEffort", value: "medium" },
        { id: "serviceTier", value: tier === "fast" ? "priority" : "default" },
      ]
    : [{ id: "reasoningEffort", value: "low" }],
} as ModelSelection;
const long = { ...sol, model: LONG_MODEL } as ModelSelection;

const scenarios: Record<
  string,
  { thread: ModelSelection; running: ModelSelection | null; fallbackFrom: ModelSelection | null }
> = {
  fallback: { thread: sol, running: null, fallbackFrom: opus },
  "fallback-room": { thread: sol, running: null, fallbackFrom: opus },
  running: { thread: opus, running: sol, fallbackFrom: null },
  same: { thread: sol, running: null, fallbackFrom: null },
  idle: { thread: sol, running: null, fallbackFrom: null },
  next: { thread: sol, running: null, fallbackFrom: null },
  long: { thread: long, running: null, fallbackFrom: null },
  // A new chat with no project default: the thread holds only the placeholder.
  // `draft` nothing picked; `draft-picked` GPT-6.1-Sol picked by hand.
  draft: { thread: NO_PROVIDER_MODEL_SELECTION, running: null, fallbackFrom: null },
  "draft-picked": { thread: NO_PROVIDER_MODEL_SELECTION, running: null, fallbackFrom: null },
  // A new chat on a machine whose default seeds Opus, which is at its limit, with
  // GPT-6.1-Sol picked by hand (the October 26 ministorm report).
  "draft-seeded": { thread: opus, running: null, fallbackFrom: null },
  // Devin's GPT-6.1 Sol standing in for Codex's: the same model name on another provider.
  twin: {
    thread: { instanceId: devin, model: "gpt-6-1-sol-medium" } as ModelSelection,
    running: null,
    fallbackFrom: sol,
  },
};
const scenarioName = params.get("case") ?? "fallback";
const surface = params.get("surface") ?? "thread";
fixtureEnvironment(environmentId, providers);
if (scenarioName === "next") {
  useComposerDraftStore.getState().setModelSelection(threadRef, opus, { explicit: true });
}
const isDraft = scenarioName.startsWith("draft");
if (scenarioName === "draft-picked" || scenarioName === "draft-seeded") {
  useComposerDraftStore.getState().setModelSelection(threadRef, sol, { explicit: true });
}

const scenario = scenarios[scenarioName] ?? scenarios.fallback!;
const hasRoom = scenarioName === "fallback-room";
const onBack = () => {
  document.body.dataset.backClicked = "true";
};
// The picker owns the way back now; the thread shows no banner for it.
const bannerItems: never[] = [];
const twin = scenarioName === "twin";
const pickLabel = twin
  ? { provider: "Codex", model: "GPT-6.1-Sol", full: "Codex · GPT-6.1-Sol" }
  : { provider: "Claude Code", model: "Opus 5.5", full: "Claude Code · Opus 5.5" };
const runningLabel = twin
  ? { provider: "Devin", model: "GPT-6.1 Sol", full: "Devin · GPT-6.1 Sol" }
  : { provider: "Codex", model: "GPT-6.1-Sol", full: "Codex · GPT-6.1-Sol" };
const modelStateHeader = scenario.fallbackFrom
  ? fallbackStatusHeader({
      pick: pickLabel,
      pickModel: twin ? "Codex" : "Opus 5.5",
      running: runningLabel,
      launched: false,
      hasRoom,
      resetLabel: "3:40 PM",
      chain: fallbackChain({
        pick: { ...scenario.fallbackFrom, label: pickLabel },
        running: { ...scenario.thread, label: runningLabel },
        order: [
          {
            ...sol,
            label: { provider: "Codex", model: "GPT-6.1-Sol", full: "Codex · GPT-6.1-Sol" },
            unavailable: null,
          },
          {
            instanceId: devin,
            model: "gpt-6-1-sol-medium",
            label: { provider: "Devin", model: "GPT-6.1 Sol", full: "Devin · GPT-6.1 Sol" },
            unavailable: "unverified",
          },
        ],
      }),
      onBack,
    })
  : null;
// `host=strip` gives a collapsed composer a resting-controls strip above it, as ChatView
// mounts for a thread with a branch or environment; without one it rests inline.
const stripHost = params.get("host") === "strip";

function Composer() {
  const [restingHost, setRestingHost] = useState<HTMLDivElement | null>(null);
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const composerRef = useRef<ChatComposerHandle | null>(null);
  return (
    <div className="@container/composer-surface">
      {stripHost ? (
        <div className="flex h-8 w-full min-w-0 items-center ps-2" data-fixture-resting-strip>
          <div ref={setRestingHost} className="min-w-0 flex-1" />
        </div>
      ) : null}
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
        isServerThread={!isDraft}
        isLocalDraftThread={isDraft}
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
        activeProjectDefaultModelSelection={isDraft ? null : opus}
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
        restingControlsHost={stripHost ? restingHost : null}
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
  );
}

const width = Number(params.get("width") ?? 900);

/** The design editor's split: the thread column beside the canvas, as DesignEditor lays it out. */
function DesignSurface() {
  return (
    <main className="flex h-screen min-h-0 bg-background" data-fixture-design>
      <section
        aria-label="Design thread"
        data-testid="design-thread"
        className="flex min-h-0 min-w-0 shrink-0 flex-col border-r border-border/70"
        style={{ width }}
        data-fixture-composer
      >
        <BoundThreadPane
          binding={{ environmentId, threadId }}
          environmentId={environmentId}
          machine={() => null}
          renderChat={() => (
            <div className="flex min-h-0 flex-1 flex-col justify-end px-3 pb-3">
              <Composer />
            </div>
          )}
          onStartThread={async () => {}}
          onOpenThere={() => {}}
          canStart
        />
      </section>
      <section aria-label="Canvas" className="min-w-0 flex-1 bg-muted/40" />
    </main>
  );
}

/**
 * The coordinator composer's footer (CoordinatorComposer, CoordinatorComposerControls)
 * as markup with its real classes, around the real CoordinatorModelPicker.
 */
function coordinatorRunning() {
  return scenarioName === "fallback"
    ? {
        value: sol,
        returnsTo: "Claude Code",
        offPick: true,
        reason: "Opus 5.5 hit its usage limit and resets at 3:40 PM.",
      }
    : scenarioName === "running"
      ? { value: sol, returnsTo: null }
      : null;
}

function FixtureCoordinatorModelPicker() {
  // Holds picks, so switching the Fast tier re-renders the control.
  const [value, setValue] = useState<ModelSelection>(
    scenarioName === "fallback" || scenarioName === "running"
      ? opus
      : scenarioName === "long"
        ? long
        : sol,
  );
  return (
    <CoordinatorModelPicker
      environmentId={environmentId}
      value={value}
      running={coordinatorRunning()}
      disabled={false}
      saving={false}
      onChange={setValue}
      onOpenSettings={() => {}}
    />
  );
}

/**
 * The project's coordinator details pane: the production ChatComposer with the
 * coordinator's model and effort in its toolbar (ProjectWorkspaceSurface routing).
 */
function DetailsSurface() {
  return (
    <ProjectMessageRoutingContext
      value={{
        coordinatorThreadId: threadId,
        coordinatorModelControls: <FixtureCoordinatorModelPicker />,
        send: async () => {},
        openCoordinator: () => {},
        openThread: () => false,
      }}
    >
      <main
        className="flex min-h-screen flex-col justify-end gap-4 p-4"
        style={{ width }}
        data-fixture-composer
      >
        <Composer />
      </main>
    </ProjectMessageRoutingContext>
  );
}

function CoordinatorSurface() {
  return (
    <main className="flex min-h-screen flex-col justify-end p-4" style={{ width }}>
      <form className="sws-composer" data-fixture-composer onSubmit={(e) => e.preventDefault()}>
        <div className="sws-composer-card">
          <textarea aria-label="Message the coordinator" placeholder="Ask the coordinator" />
          <button className="sws-send" aria-label="Send to coordinator" type="submit">
            ↑
          </button>
        </div>
        <div className="sws-composer-foot">
          <span className="sws-composer-meta">
            <button type="button" className="sws-icon-button sws-attach" aria-label="Attach files">
              +
            </button>
          </span>
          <div
            className="sws-composer-controls @container/composer-surface"
            data-coordinator-composer-controls=""
          >
            <FixtureCoordinatorModelPicker />
            <span className="sws-access-pick">
              <button type="button" className="sws-access-trigger" aria-label="Access: Full access">
                Full access
              </button>
            </span>
          </div>
        </div>
      </form>
    </main>
  );
}

function Harness() {
  useEffect(() => {
    document.body.dataset.fixtureReady = "true";
  }, []);
  if (surface === "design") return <DesignSurface />;
  if (surface === "coordinator") return <CoordinatorSurface />;
  if (surface === "details") return <DetailsSurface />;
  return (
    <main
      className="flex min-h-screen flex-col justify-end gap-4 p-4"
      style={{ width }}
      data-fixture-composer
    >
      <Composer />
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
