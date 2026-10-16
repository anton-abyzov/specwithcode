import { RuntimeRequestId, ThreadId, TurnItemId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DecisionCard, formatDecisionTime, type AnsweredQuestionItem } from "./DecisionCard";

const at = DateTime.makeUnsafe("2026-10-10T18:35:00.000Z");

function item(answer: Partial<AnsweredQuestionItem["questionAnswer"]>): AnsweredQuestionItem {
  return {
    id: TurnItemId.make("turn-item:ask"),
    threadId: ThreadId.make("thread-1"),
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
    requestId: RuntimeRequestId.make("ask-user:1"),
    responseMode: "message",
    questions: [
      {
        id: "q1",
        header: "Disk",
        question: "Clear regenerable caches on the M4 to free disk space?",
        options: [
          { label: "Clear caches", description: "Frees space", recommended: true },
          { label: "Leave as is", description: "Nothing changes" },
        ],
      },
    ],
    questionAnswer: {
      requestId: "ask-user:1",
      answers: { q1: "Clear caches" },
      attachmentsByQuestionId: {},
      ...answer,
    },
  } as AnsweredQuestionItem;
}

describe("DecisionCard", () => {
  it("shows the question, the lettered choice and who chose", () => {
    const markup = renderToStaticMarkup(<DecisionCard item={item({})} />);
    expect(markup).toContain("Decision");
    expect(markup).toContain("Clear regenerable caches on the M4 to free disk space?");
    expect(markup).toContain("Clear caches");
    expect(markup).toMatch(/>A<\/span>/);
    expect(markup).toContain("You chose");
    expect(markup).toContain('dateTime="2026-10-10T18:35:00.000Z"');
  });

  it("names an agent answer and a typed reply", () => {
    const markup = renderToStaticMarkup(
      <DecisionCard
        item={item({ answers: { q1: "Only Xcode caches" }, answeredByThreadId: "thread-2" })}
      />,
    );
    expect(markup).toContain("Only Xcode caches");
    expect(markup).toContain("An agent replied");
  });
});

describe("formatDecisionTime", () => {
  const now = new Date(2026, 9, 15, 12, 0);
  it("uses the time today, the weekday this week and the date before", () => {
    expect(formatDecisionTime(new Date(2026, 9, 15, 9, 5), now)).toMatch(/9:05/);
    expect(formatDecisionTime(new Date(2026, 9, 10, 9, 5), now)).toMatch(/Sat/);
    expect(formatDecisionTime(new Date(2026, 9, 1, 9, 5), now)).toMatch(/Oct/);
  });
});
