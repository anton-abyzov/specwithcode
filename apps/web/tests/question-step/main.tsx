import { useState } from "react";
import { createRoot } from "react-dom/client";
import { RuntimeRequestId } from "@specweave-studio/contracts";
import { ComposerBanner } from "../../src/components/chat/ComposerBanner";
import { ComposerPendingUserInputPanel } from "../../src/components/chat/ComposerPendingUserInputPanel";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../src/pendingUserInput";
import type { PendingUserInput } from "../../src/session-logic";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

// Mirrors the reported card: four multi-select questions, the first one long
// enough to scroll.
const posts = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    label: `${prefix}${String(index + 1).padStart(2, "0")} Post ${index + 1} Nov ${index + 3} 6 PM`,
    description: `ep${index + 1} 9:16 https://postiz.example.com/p/fixture${index + 1}`,
  }));
const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("ask-user:step-fixture"),
  createdAt: "2026-10-22T14:35:00.000Z",
  responseCapability: "message",
  responseMode: "message",
  dismissible: true,
  questions: [
    ["TikTok + IG", "Which TikTok and Instagram posts should go out?", posts("P", 9)],
    ["YouTube", "Which Shorts should go out?", posts("Y", 3)],
    ["LinkedIn", "Which LinkedIn posts should go out?", posts("L", 3)],
    ["X", "Which X posts should go out?", posts("X", 2)],
  ].map(([header, question, options], index) => ({
    id: `q${index + 1}`,
    header: header as string,
    question: question as string,
    multiSelect: true,
    allowCustomAnswer: true,
    options: options as { label: string; description: string }[],
  })),
};

function Fixture() {
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [submitted, setSubmitted] = useState<string>("waiting");
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  return (
    <TooltipProvider>
      <main className="mx-auto max-w-2xl p-6" data-fixture="step">
        <ComposerBanner.Root>
          <ComposerPendingUserInputPanel
            pendingUserInputs={[prompt]}
            respondingRequestIds={[]}
            answers={answers}
            questionIndex={questionIndex}
            onToggleOption={(questionId, value) => {
              const question = prompt.questions.find((entry) => entry.id === questionId)!;
              setAnswers((current) => ({
                ...current,
                [questionId]: togglePendingUserInputOptionSelection(
                  question,
                  current[questionId],
                  value,
                ),
              }));
            }}
            onAdvance={() => {
              if (!progress.isLastQuestion) {
                setQuestionIndex(progress.questionIndex + 1);
                return;
              }
              const resolved = buildPendingUserInputAnswers(prompt.questions, answers);
              if (resolved) setSubmitted(JSON.stringify(resolved));
            }}
            onPrevious={() => setQuestionIndex(Math.max(progress.questionIndex - 1, 0))}
            onDismiss={() => setSubmitted("dismissed")}
            onReplyInChat={() => document.getElementById("composer")?.focus()}
          />
        </ComposerBanner.Root>
        <textarea
          id="composer"
          placeholder="Reply in chat…"
          className="relative z-10 block h-20 w-full rounded-2xl border bg-background p-3 text-sm"
        />
        <p data-fixture-result className="mt-2 text-xs text-muted-foreground">
          {submitted}
        </p>
      </main>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
