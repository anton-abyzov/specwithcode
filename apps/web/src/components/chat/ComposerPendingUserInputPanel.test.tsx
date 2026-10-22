import { RuntimeRequestId } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("request-1"),
  responseCapability: "live" as const,
  createdAt: "2026-08-15T00:00:00.000Z",
  questions: [
    {
      id: "question-1",
      header: "Approach",
      question: "Which approach should the migration take?",
      options: [
        { label: "Incremental", description: "Move one module at a time" },
        { label: "Big bang", description: "Move everything in one release" },
      ],
      multiSelect: false,
    },
  ],
  dismissible: true,
};

function renderPanel(pendingUserInput: PendingUserInput = prompt) {
  return renderToStaticMarkup(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[pendingUserInput]}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={() => {}}
      onAdvance={() => {}}
      onDismiss={() => {}}
    />,
  );
}

describe("ComposerPendingUserInputPanel", () => {
  it("shows an approval's consequences and reason below its question, and how many wait", () => {
    const approval = (id: string): PendingUserInput => ({
      ...prompt,
      requestId: RuntimeRequestId.make(id),
      dismissible: false,
      questions: [
        {
          id: "approval",
          header: "Approval",
          question:
            'Delete the project "140 provider verification grok" and its 1 thread?\n\nThis cannot be undone.\n\nReason: Leftover test project.',
          options: [{ label: "Approve", description: "SpecWithCode makes the change." }],
          multiSelect: false,
          allowCustomAnswer: false,
        },
      ],
    });
    const markup = renderToStaticMarkup(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[approval("a"), approval("b"), approval("c")]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={() => {}}
        onAdvance={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(markup).toContain('data-pending-user-input-waiting="2"');
    expect(markup).toContain("2 more requests are waiting");
    const details = markup.match(/<div[^>]*data-question-details[^>]*>([\s\S]*?)<\/div>/)?.[1];
    expect(details).toContain("This cannot be undone.");
    expect(details).toContain("Reason: Leftover test project.");
    expect(markup).toContain(
      'aria-label="Delete the project &quot;140 provider verification grok&quot; and its 1 thread?"',
    );
  });

  it("renders the header as a disclosure control for the question body", () => {
    const markup = renderPanel();

    const toggle = markup.match(/<button[^>]*data-pending-user-input-toggle="[^"]*"[^>]*>/)?.[0];
    expect(toggle).toBeDefined();
    expect(toggle).toContain('data-pending-user-input-toggle="expanded"');
    expect(toggle).toContain('aria-expanded="true"');
    expect(toggle).toContain('type="button"');

    const controlledId = toggle?.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controlledId).toBeDefined();
    expect(markup).toMatch(new RegExp(`<div[^>]*\\sid="${controlledId}"`));
  });

  it("offers dismiss only for async questions", () => {
    expect(renderPanel()).toContain("data-pending-user-input-dismiss");
    expect(renderPanel({ ...prompt, dismissible: false })).not.toContain(
      "data-pending-user-input-dismiss",
    );
  });

  it("starts expanded so the question and its options are visible", () => {
    const markup = renderPanel();

    expect(markup).toContain("Approach");
    expect(markup).toContain("Which approach should the migration take?");
    expect(markup).toContain("Incremental");
    expect(markup).toContain("Big bang");
  });
});

describe("ComposerPendingUserInputPanel question card", () => {
  it("letters the options, badges the recommended one and offers reply in chat", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          {
            ...prompt,
            questions: [
              {
                ...prompt.questions[0]!,
                options: [
                  {
                    label: "Incremental",
                    description: "Move one module at a time",
                    recommended: true,
                  },
                  {
                    label: "Big bang (Recommended)",
                    description: "Move everything in one release",
                  },
                  { label: "Wait", description: "Wait" },
                ],
              },
            ],
          },
        ]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={() => {}}
        onAdvance={() => {}}
        onDismiss={() => {}}
        onReplyInChat={() => {}}
      />,
    );

    expect(markup).toContain('data-question-option="A"');
    expect(markup).toContain('data-question-option="B"');
    expect(markup).toContain('data-question-option="C"');
    expect(markup).toContain('role="radiogroup"');
    expect(markup.match(/data-question-recommended/g)).toHaveLength(2);
    expect(markup).not.toContain("(Recommended)");
    expect(markup).toContain("data-question-reply-in-chat");
  });

  it("hides reply in chat when there is nowhere to reply", () => {
    expect(renderPanel()).not.toContain("data-question-reply-in-chat");
  });
});

describe("ComposerPendingUserInputPanel multi-select step", () => {
  const multi: PendingUserInput = {
    ...prompt,
    questions: [
      { ...prompt.questions[0]!, id: "q1", multiSelect: true },
      { ...prompt.questions[0]!, id: "q2", header: "Rollout", multiSelect: true },
    ],
  };
  const render = (props: {
    pendingUserInput?: PendingUserInput;
    answers?: Record<string, { selectedOptionValues?: string[] }>;
    questionIndex?: number;
    withPrevious?: boolean;
  }) =>
    renderToStaticMarkup(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[props.pendingUserInput ?? multi]}
        respondingRequestIds={[]}
        answers={props.answers ?? {}}
        questionIndex={props.questionIndex ?? 0}
        onToggleOption={() => {}}
        onAdvance={() => {}}
        onPrevious={props.withPrevious === false ? undefined : () => {}}
        onDismiss={() => {}}
        onReplyInChat={() => {}}
      />,
    );
  const nextButton = (markup: string) =>
    markup.match(/<button[^>]*data-question-step-next="[^"]*"[^>]*>/)?.[0];

  it("puts a disabled Next beside the choices until one is picked", () => {
    const markup = render({});
    expect(markup).toContain("data-question-step");
    expect(markup).toContain("None selected yet");
    expect(nextButton(markup)).toContain('data-question-step-next="next"');
    expect(nextButton(markup)).toContain(`disabled=""`);
    expect(markup).not.toContain("data-question-step-back");
    // Reply in chat moves into the footer instead of a second line.
    expect(markup.match(/data-question-reply-in-chat/g)).toHaveLength(1);
  });

  it("enables Next with a count once options are picked", () => {
    const markup = render({
      answers: { q1: { selectedOptionValues: ["Incremental", "Big bang"] } },
    });
    expect(markup).toContain("2 selected");
    expect(nextButton(markup)).not.toContain(`disabled=""`);
    expect(nextButton(markup)).toMatch(/aria-keyshortcuts="(Meta|Control)\+Enter"/);
  });

  it("offers Back and Submit answers on the last question", () => {
    const markup = render({
      questionIndex: 1,
      answers: {
        q1: { selectedOptionValues: ["Incremental"] },
        q2: { selectedOptionValues: ["Big bang"] },
      },
    });
    expect(markup).toContain("data-question-step-back");
    expect(nextButton(markup)).toContain('data-question-step-next="submit"');
    expect(nextButton(markup)).not.toContain(`disabled=""`);
    expect(markup).toContain("Submit answers");
  });

  it("leaves single-select cards and hosts with their own buttons alone", () => {
    expect(render({ pendingUserInput: prompt })).not.toContain("data-question-step");
    expect(render({ withPrevious: false })).not.toContain("data-question-step");
  });
});
