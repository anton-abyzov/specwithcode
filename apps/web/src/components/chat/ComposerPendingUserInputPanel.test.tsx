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
