// Synthetic data only: no server, account, provider or store.
import { RuntimeRequestId, ThreadId, TurnItemId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { createRoot } from "react-dom/client";

import { ComposerBanner } from "../../src/components/chat/ComposerBanner";
import { DecisionCard, type AnsweredQuestionItem } from "../../src/components/chat/DecisionCard";
import {
  ComposerPendingUserInputPanel,
  type QuestionTextRenderer,
} from "../../src/components/chat/ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../src/session-logic";
import { applyThemePalette } from "../../src/themePalette";
import "../../src/components/studio/shell/shell.css";
import "./fixture.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

// The cards the project tools send, worded as ProjectActionRequests.describe words them.
const approval = (id: string, question: string): PendingUserInput => ({
  requestId: RuntimeRequestId.make(id),
  responseCapability: "live",
  createdAt: "2026-10-17T05:41:00.000Z",
  dismissible: false,
  questions: [
    {
      id: "approval",
      header: "Approval",
      question,
      options: [
        { label: "Approve", description: "SpecWithCode makes the change and tells the agent." },
        { label: "Decline", description: "Nothing changes." },
      ],
      multiSelect: false,
      allowCustomAnswer: false,
    },
  ],
});

const deletion = (id: string, title: string, reason: string) =>
  approval(
    id,
    `Delete the project "${title}" and its 1 thread?\n\nThis cannot be undone. Project memory, plans and routines are removed; source folders and Git branches stay. Archiving keeps everything instead.\n\nReason: ${reason}`,
  );

const cases: Array<{ id: string; inputs: PendingUserInput[] }> = [
  {
    id: "queued-deletes",
    inputs: [
      deletion(
        "d1",
        "141 provider verification copilot-0889",
        'Leftover from the 1.0.41 provider verification script (Oct 17). Holds one archived test thread "141 exact provider echo" only.',
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        deletion(`d${index + 2}`, "140 provider verification grok", "Leftover."),
      ),
    ],
  },
  {
    id: "long-reason",
    inputs: [
      deletion(
        "long",
        "A project whose name is long enough to wrap twice in a narrow side panel",
        "The agent explains at length why it wants this: ".concat(
          "the folder moved, the threads are archived, and nothing references it. ".repeat(8),
        ),
      ),
    ],
  },
  {
    id: "folder-change",
    inputs: [
      approval(
        "folder",
        'Change the folder of the project "specweave" from /Users/someone/Projects/github/specweave-umb/repositories/anton-abyzov/specweave to /Users/someone/Projects/github/specweave?\n\nBoth folders are checkouts of github.com/anton-abyzov/specweave. Its 12 threads, memory and history stay with the project and run in the new folder from their next turn.\n\nReason: The checkout moved.',
      ),
    ],
  },
];

// Stands in for ChatMarkdown: one paragraph per blank-line block.
const renderText: QuestionTextRenderer = (text) =>
  text.split(/\n\s*\n/).map((paragraph, index) => (
    <p key={paragraph} className={index > 0 ? "mt-1.5" : undefined}>
      {paragraph}
    </p>
  ));

function Case({ id, inputs }: { id: string; inputs: PendingUserInput[] }) {
  return (
    <section data-case={id} className="w-full">
      <ComposerBanner.Dock>
        <ComposerBanner.Column>
          <ComposerBanner.Attachment>
            <ComposerBanner.Root data-chat-composer-top-drawer="true" variant="info">
              <ComposerPendingUserInputPanel
                pendingUserInputs={inputs}
                respondingRequestIds={[]}
                answers={{}}
                questionIndex={0}
                onToggleOption={() => {}}
                onAdvance={() => {}}
                onDismiss={() => {}}
                renderText={renderText}
              />
            </ComposerBanner.Root>
          </ComposerBanner.Attachment>
          <div
            data-composer-stand-in
            className="relative z-10 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-placeholder"
          >
            <div className="min-h-10">Choose an option above</div>
            <div className="mt-2 text-xs text-muted-foreground">Claude Opus 5.5 · High</div>
          </div>
        </ComposerBanner.Column>
      </ComposerBanner.Dock>
    </section>
  );
}

// The answered "Decision" from the SpecWeave rethink thread, as the timeline shows it.
const answeredAt = DateTime.makeUnsafe(new Date().toISOString());
const decision = (answeredByThreadId?: string): AnsweredQuestionItem =>
  ({
    id: TurnItemId.make("turn-item:decision"),
    threadId: ThreadId.make("thread-rethink"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: answeredAt,
    completedAt: answeredAt,
    updatedAt: answeredAt,
    type: "user_input_request",
    requestId: RuntimeRequestId.make("ask-user:rethink"),
    responseMode: "message",
    questions: [
      {
        id: "name",
        header: "Name",
        question:
          "Should SpecWeave keep its product, npm package and repo name, with only the method renamed in the docs? Research: specweave-rethink-2026-10-17.md",
        options: [{ label: "Keep SpecWeave" }, { label: "Rename everything" }],
      },
      {
        id: "method",
        header: "Method",
        question:
          'Which name should the docs use for the method instead of "spec-driven development"?',
        options: [
          { label: "Spec-first development" },
          { label: "Increment-driven development" },
          { label: "Intent-first development" },
        ],
      },
    ],
    questionAnswer: {
      requestId: "ask-user:rethink",
      answers: { name: "Keep SpecWeave", method: "Intent-first development" },
      attachmentsByQuestionId: {},
      ...(answeredByThreadId === undefined ? {} : { answeredByThreadId }),
    },
  }) as AnsweredQuestionItem;

createRoot(document.getElementById("root")!).render(
  <main className="flex flex-col gap-10 p-4">
    {cases.map((item) => (
      <Case key={item.id} {...item} />
    ))}
    <section data-case="decision-resting" className="flex flex-col gap-3">
      <DecisionCard item={decision()} />
      <DecisionCard item={decision("thread-coordinator")} />
    </section>
    <section data-case="decision-open">
      <DecisionCard item={decision()} defaultExpanded />
    </section>
  </main>,
);
