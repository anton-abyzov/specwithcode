import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { RuntimeRequestId } from "@specweave-studio/contracts";
import { ComposerBanner } from "../../src/components/chat/ComposerBanner";
import { ComposerPendingUserInputPanel } from "../../src/components/chat/ComposerPendingUserInputPanel";
import { QueuedRunsControl } from "../../src/components/chat/QueuedRunsControl";
import { JumpToLatestButton } from "../../src/components/chat/JumpToLatestButton";
import { measureScrollToEndClearance } from "../../src/components/composerFooterLayout";
import { togglePendingUserInputOptionSelection } from "../../src/pendingUserInput";
import type { PendingUserInput } from "../../src/session-logic";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { ToastProvider, AnchoredToastProvider } from "../../src/components/ui/toast";
import { applyThemePalette } from "../../src/themePalette";
import { fixtureWorkflow } from "./stubs/thread-workflows";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
const threadKey = params.get("thread") ?? "thread-onboarding";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const queuedAt = new Date(Date.now() - 20_000).toISOString();
const row = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  run: { id: `run:${id}`, userMessageId: `message:${id}`, requestedAt: queuedAt },
  text,
  attachments: [],
  ...extra,
});
fixtureWorkflow.current = {
  activeRun: { id: "run:active" },
  canPromoteToSteer: false,
  canReorder: true,
  waitReason: "turn",
  steerUnavailableReason:
    "No provider turn is running right now, so there is nothing to steer into.",
  queuedRuns: [
    row(
      "delegated",
      'Delegated task "Chrome sign-in step" finished: the extension pairs on first run and the key step now reads the saved key.',
      { automatic: true, createdBy: "agent" },
    ),
    ...(params.get("queue") === "mixed"
      ? [row("mine", "Also check the Windows key path before you pick.", { createdBy: "user" })]
      : []),
  ],
};

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("ask-user:first-feature"),
  createdAt: "2026-11-18T14:35:00.000Z",
  responseCapability: "message",
  responseMode: "message",
  dismissible: true,
  questions: [
    {
      id: "q1",
      header: "First feature",
      question:
        "Which first-feature step should a new user see after Chrome and the API key are set up, and should it run before or after the machine list?\n\nThe current flow shows the machine list first, then an empty project, which leaves people unsure what to do next.",
      multiSelect: false,
      allowCustomAnswer: true,
      options: [
        {
          label: "Guided first feature",
          description:
            "After the key step, open a short guide that writes one small feature in a sample project, then shows the machine list. Most new users finish it in under five minutes.",
          recommended: true,
        },
        {
          label: "Machine list first",
          description:
            "Keep today's order: machines, then an empty project with a hint card. Least work, but the empty project is where most people stop.",
        },
        {
          label: "Skip both",
          description:
            "Drop the guide and the machine list from first run and land in the coordinator with a single suggested prompt. Fastest, but nothing explains machines.",
        },
      ],
    },
  ],
};

const messages = Array.from({ length: 14 }, (_, index) =>
  index % 3 === 0
    ? {
        id: `message-${index}`,
        role: "user" as const,
        text: [
          "Let's rethink onboarding: Chrome first, then keys.",
          "What happens on a machine with no Chrome profile?",
          "OK, and the key step on Windows?",
          "Show me the first-feature options.",
          "Go with the shorter copy.",
        ][(index / 3) % 5]!,
      }
    : {
        id: `message-${index}`,
        role: "assistant" as const,
        text: `Step ${index}: the onboarding flow checks the signed-in Chrome profile, pairs the extension and then asks for the provider key. On a fresh machine it reads the saved key from the keychain before asking, so most people only confirm it. I updated the copy on the key card and the Access list so each line names what it grants.`,
      },
);

function Fixture() {
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState("waiting");
  const overlayRef = useRef<HTMLDivElement>(null);
  const [clearance, setClearance] = useState(0);
  const [overlayHeight, setOverlayHeight] = useState(0);

  // The same measurement ChatView runs whenever its composer overlay resizes.
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const update = () => {
      const height = Math.ceil(overlay.getBoundingClientRect().height);
      setOverlayHeight(height);
      setClearance(measureScrollToEndClearance(overlay, height));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(overlay);
    if (overlay.parentElement) observer.observe(overlay.parentElement);
    return () => observer.disconnect();
  }, []);

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <TooltipProvider>
          <div className="flex h-dvh flex-col bg-background text-foreground" data-fixture-panel>
            <header className="flex h-11 shrink-0 items-center border-b border-border px-4 text-sm font-medium">
              <span className="truncate">Onboarding rethink: Chrome and keys</span>
            </header>
            <div className="relative flex min-h-0 flex-1 flex-col" data-fixture-panel-body>
              <div className="relative flex min-h-0 flex-1 flex-col bg-background">
                <div
                  className="messages-timeline-scroll min-h-0 flex-1 overflow-y-auto px-4 pt-4"
                  data-fixture-timeline
                  style={{ paddingBottom: overlayHeight + 16 }}
                >
                  <div className="mx-auto flex max-w-3xl flex-col gap-4">
                    {messages.map((message) =>
                      message.role === "user" ? (
                        <p
                          key={message.id}
                          className="ms-auto max-w-[80%] rounded-2xl bg-muted px-3 py-2 text-sm"
                        >
                          {message.text}
                        </p>
                      ) : (
                        <p
                          key={message.id}
                          className="text-sm leading-relaxed"
                          data-fixture-message
                        >
                          {message.text}
                        </p>
                      ),
                    )}
                  </div>
                </div>
                <div
                  className="chat-scroll-to-bottom pointer-events-none absolute z-30 flex justify-center py-1.5"
                  style={{ bottom: clearance + 4 }}
                  data-fixture-jump
                >
                  <JumpToLatestButton onJump={() => setResult("jumped")} />
                </div>
              </div>
              <div
                ref={overlayRef}
                data-chat-composer-overlay="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
              >
                <div className="chat-composer-lane w-full">
                  <div
                    data-chat-composer-stack="true"
                    className="pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-content-max-width)"
                  >
                    <ComposerBanner.Dock>
                      <ComposerBanner.Column>
                        <QueuedRunsControl
                          environmentId={"environment:fixture" as never}
                          threadId={"thread:fixture" as never}
                          optimisticMessages={[]}
                          editingRunId={null}
                          onEditQueuedRun={() => undefined}
                          onCancelEdit={() => undefined}
                        />
                        <ComposerBanner.Attachment>
                          <ComposerBanner.Root data-chat-composer-top-drawer="true" variant="info">
                            <ComposerPendingUserInputPanel
                              pendingUserInputs={[prompt]}
                              respondingRequestIds={[]}
                              answers={answers}
                              questionIndex={0}
                              collapseKey={threadKey}
                              askedBy="Onboarding rethink: Chrome and keys"
                              onToggleOption={(questionId, value) => {
                                setAnswers((current) => ({
                                  ...current,
                                  [questionId]: togglePendingUserInputOptionSelection(
                                    prompt.questions[0]!,
                                    undefined,
                                    value,
                                  ),
                                }));
                              }}
                              onAdvance={() => setResult("advanced")}
                              onDismiss={() => setResult("dismissed")}
                              onReplyInChat={() => document.getElementById("composer")?.focus()}
                            />
                          </ComposerBanner.Root>
                        </ComposerBanner.Attachment>
                      </ComposerBanner.Column>
                    </ComposerBanner.Dock>
                    <div
                      data-chat-composer-main-surface="true"
                      className="relative z-10 rounded-2xl border border-border bg-card p-3 shadow-sm"
                    >
                      <textarea
                        id="composer"
                        placeholder="Steer this thread…"
                        className="block h-14 w-full resize-none bg-transparent text-sm outline-none"
                      />
                      <p data-fixture-result className="text-2xs text-muted-foreground">
                        {result}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="h-3" />
              </div>
            </div>
          </div>
        </TooltipProvider>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

const router = createRouter({
  history: createMemoryHistory(),
  routeTree: createRootRoute({ component: Fixture }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
