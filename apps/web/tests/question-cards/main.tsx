import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { RuntimeRequestId, ThreadId, TurnItemId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import ChatMarkdown from "../../src/components/ChatMarkdown";
import { ComposerBanner } from "../../src/components/chat/ComposerBanner";
import {
  ComposerPendingUserInputPanel,
  type QuestionTextRenderer,
} from "../../src/components/chat/ComposerPendingUserInputPanel";
import { DecisionCard, type AnsweredQuestionItem } from "../../src/components/chat/DecisionCard";
import { linkifyQuestionPaths } from "../../src/components/chat/questionCard.logic";
import { togglePendingUserInputOptionSelection } from "../../src/pendingUserInput";
import type { PendingUserInput } from "../../src/session-logic";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { ToastProvider, AnchoredToastProvider } from "../../src/components/ui/toast";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
document.body.style.backgroundColor = dark ? "#1f1f1f" : "#fafafa";

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("ask-user:fixture"),
  createdAt: "2026-10-15T14:35:00.000Z",
  responseCapability: "message",
  responseMode: "message",
  dismissible: true,
  questions: [
    {
      id: "q1",
      header: "Pricing",
      question: "Change the Private skills card on https://spec-weave.com/pricing to a waitlist?",
      multiSelect: false,
      allowCustomAnswer: true,
      options: [
        {
          label: "Waitlist wording",
          description:
            "The card says Pro and Team are coming soon and links to the waitlist; see `docs/pricing.md`.",
          recommended: true,
        },
        {
          label: "Turn on checkout",
          description:
            "Hosted private publishing gets finished and switched on in vskill-platform so new buyers can pay $20 or $30 a seat.",
        },
        {
          label: "Leave as is",
          description: "The pricing page keeps linking to plans nobody can buy yet.",
        },
      ],
    },
  ],
};

const at = DateTime.makeUnsafe(Date.now() - 4 * 86_400_000);
const answered = {
  id: TurnItemId.make("turn-item:fixture"),
  threadId: ThreadId.make("thread-fixture"),
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
  requestId: RuntimeRequestId.make("ask-user:answered"),
  responseMode: "message",
  questions: [
    {
      id: "q1",
      header: "Disk",
      question: "Clear regenerable caches on the M4 to free disk space?",
      options: [
        { label: "Clear caches", description: "Frees about 40 GB", recommended: true },
        { label: "Leave as is", description: "Nothing changes" },
      ],
    },
  ],
  questionAnswer: {
    requestId: "ask-user:answered",
    answers: { q1: "Clear caches" },
    attachmentsByQuestionId: {},
  },
} as AnsweredQuestionItem;

const renderText: QuestionTextRenderer = (text, variant) => (
  <ChatMarkdown
    text={linkifyQuestionPaths(text)}
    cwd="/Users/fixture/project"
    className={
      variant === "question"
        ? "text-sm leading-snug text-foreground"
        : "text-xs leading-snug text-muted-foreground"
    }
  />
);

function Fixture() {
  const [answers, setAnswers] = useState({});
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <TooltipProvider>
          <main className="mx-auto max-w-2xl space-y-6 p-6">
            <section data-fixture="decision">
              <DecisionCard item={answered} renderText={(text) => text} />
            </section>
            <section data-fixture="pending" className="space-y-0">
              <ComposerBanner.Root>
                <ComposerPendingUserInputPanel
                  pendingUserInputs={[prompt]}
                  respondingRequestIds={[]}
                  answers={answers}
                  questionIndex={0}
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
                  onAdvance={() => setPicked("advanced")}
                  onDismiss={() => setPicked("dismissed")}
                  onReplyInChat={() => document.getElementById("composer")?.focus()}
                  renderText={renderText}
                />
              </ComposerBanner.Root>
              <textarea
                id="composer"
                placeholder="Steer this thread…"
                className="relative z-10 block h-20 w-full rounded-2xl border bg-background p-3 text-sm"
              />
              <p data-fixture-result className="mt-2 text-xs text-muted-foreground">
                {picked ?? "waiting"}
              </p>
            </section>
          </main>
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
