/* Synthetic data only: the coordinator column of a project page, with the real
   question hook, card, composer, requests dialog and decision rows. The host is
   the harness: it settles the request and records the answer the way the
   Orchestrator does (only the person's words, answeredInChat from a chat send). */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  type ChatAttachment,
  type OrchestrationV2ThreadProjection,
  type UserInputQuestion,
} from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import * as DateTime from "effect/DateTime";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";
import ChatMarkdown from "../../src/components/ChatMarkdown";
import { CoordinatorComposer } from "../../src/components/studio/CoordinatorComposer";
import {
  CoordinatorDecisionRow,
  CoordinatorQuestionCard,
  focusCoordinatorPrompt,
} from "../../src/components/studio/CoordinatorQuestionCard";
import { ProjectCoordinatorDetails } from "../../src/components/studio/ProjectCoordinatorDetails";
import { ProjectThreadChip } from "../../src/components/studio/ProjectThreadCards";
import { useCoordinatorQuestion } from "../../src/components/studio/useCoordinatorQuestion";
import {
  QuestionLiveStatus,
  useLiveAnnouncement,
} from "../../src/components/chat/questionLiveStatus";
import {
  answeredQuestionsByMessageId,
  COORDINATOR_ASKER,
} from "../../src/studio/coordinatorQuestionAnswers";
import { getProjectCoordinatorComposer } from "../../src/studio/projectCoordinatorComposer";
import type { ProjectMessageRouting } from "../../src/studio/projectMessageRouting";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { ToastProvider, AnchoredToastProvider } from "../../src/components/ui/toast";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
/** `?blocked`: the coordinator's composer cannot send, so the dialog takes the answer. */
const blocked = params.has("blocked");
/** `?questions=2`: a card with two questions, answered one at a time. */
const twoQuestions = params.get("questions") === "2";

const environmentId = EnvironmentId.make("env-fixture");
const coordinatorId = ThreadId.make("project-coordinator:atlas");
const coordinatorRef = scopeThreadRef(environmentId, coordinatorId);
const requestId = RuntimeRequestId.make("ask-user:app-binding");
const cwd = "/scratch/atlas";
const at = (minute: number) => DateTime.makeUnsafe(Date.parse(`2026-10-23T21:${minute}:00Z`));

const questions: UserInputQuestion[] = [
  {
    id: "binding",
    header: "App binding",
    question: "Which repository binding should workers push to?",
    options: [
      { label: "Registered binding", description: "The project's own repository record" },
      { label: "Ad-hoc checkout", description: "A folder outside the binding" },
    ],
    allowCustomAnswer: true,
  },
  ...(twoQuestions
    ? [
        {
          id: "branch",
          header: "Branch",
          question: "Which branch prefix should the workers use?",
          options: [
            { label: "fix/", description: "Bug fixes" },
            { label: "feat/", description: "Features" },
          ],
          allowCustomAnswer: true,
        } satisfies UserInputQuestion,
      ]
    : []),
];

const worker = {
  id: "worker-skills",
  environmentId,
  projectId: "atlas",
  title: "Consolidate the skills",
  createdBy: "agent",
  runtime: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  settledOverride: null,
  lineage: { relationshipToParent: null },
  pullRequests: [],
  archivedAt: null,
  deletedAt: null,
  updatedAt: "2026-10-23T21:00:00Z",
  modelSelection: { instanceId: "claude-native", model: "claude-opus-5-5" },
} as unknown as EnvironmentThreadShell;

type Message = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly author: "you" | "coordinator" | "worker";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
};
const opening: Message[] = [
  {
    id: "m1",
    role: "user",
    author: "you",
    text: "Bind the app repository so workers can push their branches.",
  },
  { id: "m2", role: "user", author: "worker", text: "Done. The PR is green." },
  {
    id: "m3",
    role: "assistant",
    author: "coordinator",
    text: "One decision before I bind it: which repository binding should the workers push to?",
  },
];

type Outcome = "ok" | "settled" | "interrupted";
type Response = Record<string, unknown>;
declare global {
  interface Window {
    __fixture: {
      responses: Response[];
      /** What the host does with the next answer. */
      next: Outcome;
      prompt: () => string;
      attachments: () => number;
      /** Another window answers the question; this page sends nothing. */
      settleElsewhere: () => void;
    };
  }
}
const composer = getProjectCoordinatorComposer(environmentId, "atlas");
window.__fixture = {
  responses: [],
  next: "ok",
  prompt: () => composer.getSnapshot().prompt,
  attachments: () => composer.getSnapshot().attachments.length,
  settleElsewhere: () => {},
};

function Harness() {
  const [status, setStatus] = useState<"pending" | "resolved" | "cancelled">(
    params.has("answered") ? "resolved" : "pending",
  );
  const [answer, setAnswer] = useState<Response | null>(null);
  const [messages, setMessages] = useState<Message[]>(opening);
  const [error, setError] = useState<string | null>(null);
  // `?dialog`: the requests dialog opened, as the overview's request row opens it.
  const [dialog, setDialog] = useState(params.has("dialog"));

  // The host: refuse, drop or take the answer; a taken one settles the request.
  useEffect(() => {
    window.__respond = (input) => {
      window.__fixture.responses.push(input);
      const outcome = window.__fixture.next;
      window.__fixture.next = "ok";
      if (outcome === "interrupted") return outcome;
      // "settled": another window answered first, with an option; this answer is refused.
      const taken =
        outcome === "settled" ? { requestId, answers: { binding: "Registered binding" } } : input;
      const answers = taken.answers as Record<string, string | string[]>;
      const words = questions
        .map((question) => {
          const value = answers[question.id];
          const text = Array.isArray(value) ? value.join(", ") : (value ?? "");
          return questions.length === 1 ? text : `${question.header}: ${text}`;
        })
        .join("\n\n");
      const files = Object.values(
        ((taken as Response).attachmentsByQuestionId ?? {}) as Record<string, ChatAttachment[]>,
      ).flat();
      setTimeout(() => {
        setAnswer(taken);
        setStatus("resolved");
        setMessages((current) => [
          ...current,
          {
            id: `async-answer:${requestId}`,
            role: "user",
            author: "you",
            text: words,
            attachments: files,
          },
        ]);
      }, 120);
      return outcome;
    };
    window.__dismiss = () => setStatus("cancelled");
    window.__fixture.settleElsewhere = () => {
      setAnswer({ requestId, answers: { binding: "Registered binding" } });
      setStatus("resolved");
    };
    document.body.dataset.fixtureReady = "true";
  }, []);

  const projection = useMemo(
    () =>
      ({
        thread: { id: coordinatorId },
        runtimeRequests: [
          {
            id: requestId,
            kind: "user_input",
            status,
            responseCapability: { type: "message" },
            createdAt: at(10),
            ...(answer ? { answers: answer.answers } : {}),
          },
        ],
        turnItems: [
          {
            id: "turn-item:ask",
            threadId: coordinatorId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: status === "pending" ? "waiting" : "completed",
            title: null,
            startedAt: at(10),
            completedAt: status === "pending" ? null : at(12),
            updatedAt: at(12),
            type: "user_input_request",
            requestId,
            responseMode: "message",
            questions,
            ...(answer
              ? {
                  questionAnswer: {
                    requestId,
                    answers: answer.answers,
                    attachmentsByQuestionId: {},
                    ...(answer.answeredInChat ? { answeredInChat: true } : {}),
                  },
                }
              : {}),
          },
        ],
      }) as unknown as OrchestrationV2ThreadProjection,
    [answer, status],
  );
  const composerProblem = blocked
    ? "The coordinator's model is not available on this machine. Choose another model."
    : null;
  const [announcement, announce] = useLiveAnnouncement();
  const question = useCoordinatorQuestion({
    environmentId,
    coordinatorId,
    projection,
    composer,
    supportsQuestionAttachments: true,
    disabled: false,
    composerCanAnswer: composerProblem === null,
    reportError: setError,
    retireError: (message) => setError((current) => (current === message ? null : current)),
    announce,
  });
  const answered = useMemo(
    () => answeredQuestionsByMessageId(projection.turnItems),
    [projection.turnItems],
  );
  const send = useCallback(
    async (text: string, attachments: ReadonlyArray<ChatAttachment> | undefined) => {
      setError(null);
      if (question) return question.answerFromDraft(text, attachments);
      setMessages((current) => [
        ...current,
        {
          id: `m${current.length + 1}`,
          role: "user",
          author: "you",
          text,
          ...(attachments ? { attachments } : {}),
        },
      ]);
    },
    [question],
  );
  const routing = useMemo<ProjectMessageRouting>(
    () => ({
      coordinatorThreadId: coordinatorId,
      send: async () => {},
      openCoordinator: () => {},
      openThread: () => true,
      coordinatorQuestion: question
        ? {
            question,
            composer,
            environmentId,
            cwd,
            uploadsSupported: true,
            canAttach: true,
            maxFileBytes: 20 * 1024 * 1024,
            composerProblem,
          }
        : null,
    }),
    [composerProblem, question],
  );
  const answersInChat = question?.composerCanAnswer === true;

  return (
    <div className="fixture-page project-coordinator sws-coordinator" data-fixture-page>
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <h1 className="text-sm font-semibold">Atlas Studio</h1>
        {/* The status chip: while the composer can answer, it goes there; else the dialog. */}
        <button
          type="button"
          className="sws-state"
          data-fixture-chip
          data-opens={question && answersInChat ? "answer" : "coordinator-review"}
          onClick={() => {
            if (question && answersInChat && focusCoordinatorPrompt()) return;
            setDialog(true);
          }}
        >
          {question ? "Needs input" : "Idle"}
        </button>
      </header>
      <div className="project-conversation" aria-label="Coordinator conversation">
        {messages.map((message) => {
          const decision = answered.get(message.id) ?? null;
          return (
            <Fragment key={message.id}>
              {decision ? (
                <CoordinatorDecisionRow
                  item={decision.item}
                  askedBy={COORDINATOR_ASKER}
                  cwd={cwd}
                  threadRef={coordinatorRef}
                />
              ) : null}
              {decision?.folded ? null : (
                <article
                  className={`project-message project-message-${message.role}`}
                  data-fixture-message={message.author}
                >
                  <h3>
                    {message.author === "worker"
                      ? "Message from a worker"
                      : message.author === "coordinator"
                        ? "Coordinator"
                        : "You"}
                  </h3>
                  {message.author === "worker" ? (
                    // The markup MessageThreadLink renders for a project thread.
                    <span className="project-message-source">
                      <span className="project-message-source-prefix">Sent by</span>{" "}
                      <ProjectThreadChip thread={worker} label={worker.title} onOpen={() => {}} />
                    </span>
                  ) : null}
                  {message.attachments?.length ? (
                    <p className="text-xs" data-fixture-files>
                      {message.attachments.map((file) => file.name).join(", ")}
                    </p>
                  ) : null}
                  <ChatMarkdown
                    text={message.text}
                    cwd={cwd}
                    threadRef={coordinatorRef}
                    isStreaming={false}
                    lineBreaks={message.role === "user"}
                  />
                </article>
              )}
            </Fragment>
          );
        })}
      </div>
      <QuestionLiveStatus announcement={announcement} />
      <CoordinatorComposer
        composer={composer}
        threadRef={null}
        environmentId={environmentId}
        cwd={cwd}
        sendBlocked={composerProblem !== null}
        missingModel={null}
        canAttach
        uploadsSupported
        maxFileBytes={20 * 1024 * 1024}
        sending={false}
        placeholder={
          question
            ? "Answer the coordinator: type, paste or attach, then send"
            : "Ask the coordinator a question or start a task…"
        }
        promptLabel={
          question ? "Your answer to the coordinator's question" : "Message the project coordinator"
        }
        question={
          question ? (
            <CoordinatorQuestionCard
              question={question}
              environmentId={environmentId}
              cwd={cwd}
              onAnswerElsewhere={() => setDialog(true)}
            />
          ) : null
        }
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        isPhoneKeyboard={false}
        sendShortcut="enter"
        onAppCommand={null}
        provider={null}
        onSend={send}
        onError={setError}
        status={
          <>
            {composerProblem ? (
              <p className="project-muted" role="status">
                {composerProblem}
              </p>
            ) : null}
            {error ? <p role="alert">{error}</p> : null}
          </>
        }
        notices={null}
        meta={null}
        controls={null}
        modelFallback={false}
      />
      {dialog ? (
        <ProjectCoordinatorDetails
          environmentId={environmentId}
          threadId={coordinatorId}
          routing={routing}
          onClose={() => setDialog(false)}
        />
      ) : null}
    </div>
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
