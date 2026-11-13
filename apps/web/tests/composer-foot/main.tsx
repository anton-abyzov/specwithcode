/*
 * Synthetic data only: the composer's bottom line as Anton reported it on November 13,
 * 2026. A project on m4 (rose) whose coordinator runs there, with a thread on linux-box
 * (blue) open beside it. The real CoordinatorComposer with the real machine chip, voice
 * menu and model picker, and the real ChatComposer with its machine chip, model chip,
 * voice, attach and skills, inside the real ComposerSurface.
 * `?scene=window` both panes side by side (a desktop window), `?scene=thread` or
 * `?scene=coordinator` one pane at the window's width (a phone or a narrow window),
 * `?banner=1` a "Resume with less context" banner above the thread's message box,
 * `?state=` the coordinator's run state (idle, background, working, waiting, failed),
 * `?theme=dark` the theme.
 */
import { useRef, useState } from "react";
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
import { ComposerSurface } from "../../src/components/chat/ComposerSurface";
import { CoordinatorComposer } from "../../src/components/studio/CoordinatorComposer";
import { ComposerVoiceMenu } from "../../src/components/studio/ComposerVoiceMenu";
import { OrchestratorSwitcher } from "../../src/components/studio/OrchestratorSwitcher";
import { CoordinatorModelPicker } from "../../src/components/studio/shell/CoordinatorModelPicker";
import { Tip } from "../../src/components/studio/shell/Tip";
import { runtimeModeConfig, runtimeModeOptions } from "../../src/components/chat/runtimeModeConfig";
import { getProjectCoordinatorComposer } from "../../src/studio/projectCoordinatorComposer";
import { useComposerDraftStore } from "../../src/composerDraftStore";
import { THREAD_TONE_LABELS, type ThreadTone } from "../../src/studio/shellModel";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../../src/composerDraftStore";
import type { TerminalContextDraft } from "../../src/lib/terminalContext";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { ToastProvider, AnchoredToastProvider } from "../../src/components/ui/toast";
import { applyThemePalette } from "../../src/themePalette";
import { fixtureProviders } from "./environments";
import "./fixture.css";

const FullAccessIcon = runtimeModeConfig["full-access"].icon;

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
const scene = params.get("scene") ?? "window";
const banner = params.get("banner") === "1";
const tone = (params.get("state") ?? "background") as ThreadTone;

const NOW = Date.parse("2026-11-13T19:00:00Z");
Date.now = () => NOW;
const iso = (ms: number) => new Date(ms).toISOString();

const m4 = EnvironmentId.make("env-m4");
const linuxMini = EnvironmentId.make("env-lm");
const threadId = ThreadId.make("thread-sweep");
const threadRef = scopeThreadRef(linuxMini, threadId);
const claude = ProviderInstanceId.make("claudeAgent");
const providers = [
  {
    enabled: true,
    installed: true,
    version: "fixture",
    status: "ready",
    auth: { status: "authenticated", type: "subscription" },
    checkedAt: iso(NOW),
    slashCommands: [],
    skills: Array.from({ length: 50 }, (_, index) => ({
      name: `skill-${index + 1}`,
      description: "A fixture skill",
      path: `/skills/skill-${index + 1}/SKILL.md`,
      enabled: true,
    })),
    instanceId: claude,
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities: {} }],
  },
] as unknown as ServerProvider[];
fixtureProviders(providers);
const opus = { instanceId: claude, model: "claude-opus-5-5" } as ModelSelection;
const coordinatorDraft = getProjectCoordinatorComposer(m4, "specweave");

const dictation = {
  available: true,
  active: false,
  phase: "idle",
  start: () => {},
  stop: () => {},
  consentOpen: false,
} as never;
const call = {
  available: true,
  active: false,
  unavailableReason: null,
  start: () => {},
  end: () => {},
  consentOpen: false,
} as never;

/** Words only for the states that need the person, as ProjectWorkspaceSurface does. */
const STATE_WORDS: ReadonlySet<ThreadTone> = new Set<ThreadTone>(["waiting", "failed"]);

function CoordinatorPane() {
  const [model, setModel] = useState<ModelSelection>(opus);
  return (
    <section
      className="project-coordinator sws-coordinator machine-pane"
      data-machine-color="rose"
      aria-label="Project coordinator"
      data-project-pane="coordinator"
    >
      <div className="fixture-pane-head">specweave</div>
      <div className="fixture-conversation">
        Composer footer shows model and machine first. Working on it now.
      </div>
      <CoordinatorComposer
        composer={coordinatorDraft}
        threadRef={null}
        environmentId={m4}
        cwd="/Users/fixture/specweave"
        sendBlocked={false}
        missingModel={null}
        canAttach
        uploadsSupported
        maxFileBytes={20 * 1024 * 1024}
        sending={false}
        placeholder="Ask the coordinator a question or start a task…"
        hostReachable
        promptLabel="Message the project coordinator"
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        isPhoneKeyboard={false}
        sendShortcut="enter"
        onAppCommand={null}
        provider={null}
        onSend={async () => {}}
        onError={() => {}}
        status={null}
        notices={null}
        meta={
          <>
            <OrchestratorSwitcher
              identity={{ color: "rose", icon: "laptop" } as never}
              label="m4"
              connected
              statusDetail=""
              current="env-m4:specweave"
              copies={[
                {
                  key: "env-m4:specweave",
                  machine: "m4",
                  folder: "/Users/fixture/specweave",
                  role: "coordinator",
                  canStart: false,
                },
                {
                  key: "env-lm:specweave",
                  machine: "linux-box",
                  folder: "/home/fixture/specweave",
                  role: "workers",
                  canStart: true,
                },
              ]}
              unknown={[]}
              savedMachineMissing={false}
              onView={() => {}}
              onMove={() => {}}
              onStart={null}
              onAllowWorkers={null}
              onAdd={() => {}}
            />
            <span className="sws-composer-aside" data-composer-aside="">
              <ComposerVoiceMenu dictation={dictation} call={call} shortcut={null} />
              <Tip label={`${THREAD_TONE_LABELS[tone]}. Coordinator status: show its latest message`}>
                <button type="button" className="sws-state" data-tone={tone}>
                  <span className="sws-dot" data-tone={tone} aria-hidden />
                  <span className={STATE_WORDS.has(tone) ? undefined : "sr-only"} data-state-label="">
                    {THREAD_TONE_LABELS[tone]}
                  </span>
                </button>
              </Tip>
            </span>
          </>
        }
        controls={
          <div
            className="sws-composer-controls @container/composer-surface"
            data-coordinator-composer-controls=""
          >
            <CoordinatorModelPicker
              environmentId={m4}
              value={model}
              running={null}
              disabled={false}
              saving={false}
              onChange={setModel}
              onOpenSettings={() => {}}
            />
            {/* CoordinatorAccessPicker's markup without its settings hooks; shell.css
                turns it into the dial alone in a tight toolbar. */}
            <span
              className="sws-access-pick inline-flex flex-wrap items-center gap-1 text-xs"
              data-runtime-mode="full-access"
            >
              <span className="sws-access-field">
                <FullAccessIcon className="sws-access-icon" data-access-icon="" />
                <select
                  aria-label="Project permissions"
                  className="sws-model-trigger sws-access-trigger max-w-48 bg-transparent"
                  defaultValue="full-access"
                >
                  {runtimeModeOptions.map((mode) => (
                    <option key={mode} value={mode}>
                      {runtimeModeConfig[mode].label}
                    </option>
                  ))}
                </select>
              </span>
            </span>
          </div>
        }
        modelFallback={false}
      />
    </section>
  );
}

function ThreadComposer() {
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const composerRef = useRef<ChatComposerHandle | null>(null);
  return (
    <ComposerSurface.Shell machineColor="blue">
      <ComposerSurface.Host>
        <div className="relative z-10">
          <ChatComposer
            composerDraftTarget={threadRef}
            environmentId={linuxMini}
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
            activeThreadEnvironmentId={linuxMini}
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
            bannerItems={
              banner
                ? [
                    {
                      id: "resume",
                      variant: "default",
                      priority: "activity",
                      content: (
                        <div className="px-3 py-2 text-xs text-muted-foreground">
                          Resume with less context · 169k tokens from earlier
                        </div>
                      ),
                    },
                  ]
                : []
            }
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
            activeThreadModelSelection={opus}
            reportedModelSelection={null}
            limitFallbackFrom={null}
            modelStateHeader={null}
            activeContextWindow={null}
            compactThreadUnavailable
            compactDisabled
            compactDisabledReason={null}
            resolvedTheme={dark ? "dark" : "light"}
            settings={DEFAULT_UNIFIED_SETTINGS}
            keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
            terminalOpen={false}
            gitCwd="/home/fixture/specweave"
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
            machine={{
              kind: "linux",
              label: "linux-box",
              short: "LM",
              tip: "Runs on linux-box (Ubuntu, Linux).",
              warning: null,
              color: "blue",
              isThisMachine: false,
            }}
          />
        </div>
      </ComposerSurface.Host>
    </ComposerSurface.Shell>
  );
}

function ThreadPane() {
  return (
    <aside
      className="project-thread-pane sws-threads machine-pane"
      data-machine-color="blue"
      aria-label="Thread Sweep stale active increments"
      data-project-pane="threads"
    >
      <div className="fixture-pane-head">Sweep stale active increments</div>
      <div className="fixture-conversation">The five done increments stayed open.</div>
      <div className="fixture-thread-composer">
        <ThreadComposer />
      </div>
    </aside>
  );
}

function Page() {
  return (
    <main className="fixture-window" data-scene={scene}>
      {scene === "thread" ? null : <CoordinatorPane />}
      {scene === "coordinator" ? null : <ThreadPane />}
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
            <Page />
          </TooltipProvider>
        </AnchoredToastProvider>
      </ToastProvider>
    ),
  }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
