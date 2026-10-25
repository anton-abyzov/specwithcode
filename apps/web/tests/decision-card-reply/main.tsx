/* Synthetic data only: the production ChatComposer with an ask_user card, no host. */
import { useCallback, useEffect, useRef, useState } from "react";
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
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { ChatComposer, type ChatComposerHandle } from "../../src/components/chat/ChatComposer";
import {
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../src/composerDraftStore";
import type { TerminalContextDraft } from "../../src/lib/terminalContext";
import {
  getUploadedAttachments,
  useAttachmentUploadStore,
} from "../../src/lib/attachmentUploadQueue";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../src/pendingUserInput";
import { planQuestionChatReply } from "../../src/questionChatReply";
import { useWorkspaceFileDropHandlers } from "../../src/components/chat/workspaceFileDrop";
import type { PendingUserInput } from "../../src/session-logic";
import { DecisionCard, type AnsweredQuestionItem } from "../../src/components/chat/DecisionCard";
import {
  QuestionLiveStatus,
  useLiveAnnouncement,
  useQuestionSettleAnnouncements,
} from "../../src/components/chat/questionLiveStatus";
import {
  answerProblemFor,
  settleQuestionAnswer,
  shownAnswerProblem,
  type AnswerProblem,
} from "../../src/components/chat/questionSendOutcome";
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
const providers: ServerProvider[] = [
  {
    instanceId: claude,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-20T00:00:00.000Z",
    models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities: {} }],
    slashCommands: [],
    skills: [],
  },
];
const modelSelection = { instanceId: claude, model: "claude-opus-5-5" };

const question: PendingUserInput = {
  requestId: RuntimeRequestId.make("ask-user:fixture"),
  createdAt: new Date().toISOString(),
  responseCapability: "message",
  responseMode: "message",
  dismissible: true,
  questions: [
    {
      id: "q1",
      header: "Layout",
      question: "Which header layout should the settings page use?",
      multiSelect: false,
      allowCustomAnswer: true,
      options: [
        { label: "Compact", description: "One row with the title and actions.", recommended: true },
        { label: "Tall", description: "Title row plus a description row." },
      ],
    },
  ],
} as PendingUserInput;

// Fixture uploads finish at once; the host is not part of this check.
useComposerDraftStore.subscribe((state) => {
  const uploads = useAttachmentUploadStore.getState().uploadsByImageId;
  const next = { ...uploads };
  let changed = false;
  for (const draft of Object.values(state.draftsByThreadKey)) {
    for (const attachment of [...(draft?.images ?? []), ...(draft?.files ?? [])]) {
      if (next[attachment.id]) continue;
      next[attachment.id] = {
        status: "ready",
        environmentId,
        attachmentId: `uploaded-${attachment.id}`,
      };
      changed = true;
    }
  }
  if (changed) useAttachmentUploadStore.setState({ uploadsByImageId: next });
});

type Response = {
  answers: Record<string, unknown>;
  attachments: unknown;
  answeredInChat: boolean;
};
declare global {
  interface Window {
    __fixture: {
      responses: Response[];
      /** "refused": the host turns the next answer down, as a handoff fence does. */
      next: "ok" | "refused";
      showQuestion: (show: boolean) => void;
      threadDraft: () => { prompt: string; images: number } | null;
    };
  }
}
window.__fixture = {
  responses: [],
  next: "ok",
  showQuestion: () => {},
  threadDraft: () => {
    const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
    return draft ? { prompt: draft.prompt, images: draft.images.length } : null;
  },
};

/** What the server records once the answer is accepted (see Orchestrator). */
function answeredItem(response: Response): AnsweredQuestionItem {
  const at = DateTime.makeUnsafe(Date.now());
  return {
    id: TurnItemId.make("turn-item:fixture"),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type: "user_input_request",
    requestId: question.requestId,
    responseMode: "message",
    questions: question.questions,
    questionAnswer: {
      requestId: question.requestId,
      answers: response.answers,
      attachmentsByQuestionId: {},
      ...(response.answeredInChat ? { answeredInChat: true } : {}),
    },
  } as AnsweredQuestionItem;
}

function Harness() {
  const [pendingUserInputs, setPendingUserInputs] = useState<PendingUserInput[]>(
    params.get("question") === "off" ? [] : [question],
  );
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [sent, setSent] = useState<{
    response: Response;
    text: string;
    images: ComposerImageAttachment[];
  } | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  // As ChatView does, with its shared rules: why an answer was not sent shows
  // against the composer, not the thread, and a live status reads the outcome.
  const [answerProblem, setAnswerProblem] = useState<AnswerProblem | null>(null);
  const [announcement, announce] = useLiveAnnouncement();
  const pendingIds = pendingUserInputs.map((input) => input.requestId);
  const settle = useQuestionSettleAnnouncements(
    `${environmentId}:${threadId}`,
    pendingIds,
    announce,
  );
  const reason = (text: string) =>
    setAnswerProblem({ threadId, requestId: question.requestId, text });
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const active = pendingUserInputs[0] ?? null;
  window.__fixture.showQuestion = (show) => setPendingUserInputs(show ? [question] : []);

  const progress = active ? derivePendingUserInputProgress(active.questions, answers, 0) : null;
  const resolved = active ? buildPendingUserInputAnswers(active.questions, answers) : null;

  const respond = useCallback(
    (response: Response, text: string, images: ComposerImageAttachment[]) => {
      setAnswerProblem(null);
      settle.claim(question.requestId);
      window.__fixture.responses.push(response);
      const refused = window.__fixture.next === "refused";
      window.__fixture.next = "ok";
      const problem = settleQuestionAnswer({
        result: refused
          ? {
              kind: "refused",
              message: "The thread is handing off to another machine. Send it again shortly.",
            }
          : { kind: "sent" },
        requestId: question.requestId,
        answers: response.answers,
        files: {},
        heldInBox: true,
        runtimeRequests: () => [],
        settle,
        announce,
        onLanded: () => {},
        onSettledElsewhere: () => false,
      });
      if (problem !== null) {
        setAnswerProblem(
          answerProblemFor({
            threadId,
            requestId: question.requestId,
            problem,
            pendingRequestIds: [question.requestId],
          }),
        );
        return false;
      }
      setSent({ response, text, images });
      setPendingUserInputs([]);
      return true;
    },
    [announce, settle],
  );

  // The same decision ChatView.onSend makes while a card waits.
  const send = useCallback(() => {
    const questionInput = active?.questions[0];
    if (!questionInput) return;
    const reply = planQuestionChatReply({
      draft: useComposerDraftStore.getState().getComposerDraft(threadRef),
      allowCustomAnswer: questionInput.allowCustomAnswer,
      supportsQuestionAttachments: true,
    });
    if (reply.kind === "blocked") {
      reason(reply.reason);
      return;
    }
    if (reply.kind === "reply") {
      const uploaded = getUploadedAttachments({
        environmentId,
        images: [...reply.images, ...reply.files],
      });
      if (!uploaded) return;
      const delivered = respond(
        {
          answers: { [questionInput.id]: reply.text },
          attachments: { [questionInput.id]: uploaded },
          answeredInChat: true,
        },
        reply.text,
        [...reply.images],
      );
      // A refused answer stays in the box with its files.
      if (!delivered) return;
      promptRef.current = "";
      useComposerDraftStore.getState().clearComposerContent(threadRef);
      composerRef.current?.resetCursorState({ cursor: 0 });
      return;
    }
    if (resolved) respond({ answers: resolved, attachments: {}, answeredInChat: false }, "", []);
  }, [active, resolved, respond]);

  // ChatView's drop target: files dropped on the thread land in the composer.
  const drop = useWorkspaceFileDropHandlers({
    setDragActive: useCallback(() => {}, []),
    addFiles: useCallback((files: File[]) => composerRef.current?.addDroppedFiles(files), []),
    addFolders: useCallback(() => {}, []),
  });

  useEffect(() => {
    document.body.dataset.fixtureReady = "true";
  }, []);

  return (
    <main
      data-fixture-drop-target
      onDragEnter={drop.onDragEnter}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      className="mx-auto flex min-h-screen max-w-3xl flex-col justify-end gap-4 p-6"
    >
      <section data-fixture-timeline className="space-y-3">
        <div className="ms-auto w-fit max-w-[80%] rounded-2xl bg-secondary px-4 py-2 text-sm text-foreground">
          Make the settings page header match the rest of the app.
        </div>
        {sent ? (
          <>
            <DecisionCard item={answeredItem(sent.response)} renderText={(text) => text} />
            {sent.response.answeredInChat ? (
              <div
                data-fixture-chat-reply
                className="ms-auto flex w-fit max-w-[80%] flex-col items-end gap-2"
              >
                {sent.images.map((image) => (
                  <img
                    key={image.id}
                    src={image.previewUrl}
                    alt={image.name}
                    className="h-16 w-16 rounded-lg border border-border/80 object-cover"
                  />
                ))}
                {sent.text ? (
                  <div className="rounded-2xl bg-secondary px-4 py-2 text-sm text-foreground">
                    {sent.text}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
        {threadError ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {threadError}
          </p>
        ) : null}
      </section>
      <QuestionLiveStatus announcement={announcement} />
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
        phase="running"
        canInterrupt={false}
        isConnecting={false}
        isSendBusy={false}
        canResume={false}
        sendDisabledReason={null}
        isPreparingWorktree={false}
        bannerItems={[]}
        answerProblem={shownAnswerProblem(answerProblem, threadId, pendingIds)}
        onDismissAnswerProblem={() => setAnswerProblem(null)}
        environmentUnavailable={null}
        activePendingApproval={null}
        pendingApprovals={[]}
        pendingUserInputs={pendingUserInputs}
        activePendingProgress={progress}
        activePendingResolvedAnswers={resolved}
        activePendingIsResponding={false}
        activePendingDraftAnswers={answers}
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
        activeProjectDefaultModelSelection={modelSelection}
        activeThreadModelSelection={modelSelection}
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
        onSend={(event) => {
          event?.preventDefault();
          if (active) send();
        }}
        onResume={() => {}}
        onInterrupt={() => {}}
        onImplementPlanInNewThread={() => {}}
        onRespondToApproval={async () => {}}
        onSelectActivePendingUserInputOption={(questionId, value) => {
          const q = active?.questions.find((entry) => entry.id === questionId);
          if (!q) return;
          setAnswers((current) => ({
            ...current,
            [questionId]: togglePendingUserInputOptionSelection(q, current[questionId], value),
          }));
        }}
        onAdvanceActivePendingUserInput={send}
        onDismissActivePendingUserInput={() => setPendingUserInputs([])}
        onPreviousActivePendingUserInputQuestion={() => {}}
        onProviderModelSelect={() => {}}
        onOpenProviderSetup={() => {}}
        getModelDisabledReason={() => null}
        toggleInteractionMode={() => {}}
        handleRuntimeModeChange={() => {}}
        handleInteractionModeChange={() => {}}
        focusComposer={() => composerRef.current?.focusAtEnd()}
        scheduleComposerFocus={() => composerRef.current?.focusAtEnd()}
        setThreadError={(_threadId, error) => setThreadError(error)}
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
