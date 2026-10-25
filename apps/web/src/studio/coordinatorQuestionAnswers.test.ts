import { RuntimeRequestId, type OrchestrationV2TurnItem } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  answeredQuestionsByMessageId,
  isRecordedQuestionAnswer,
  isSettledRequestRefusal,
  noteRefusedQuestionAnswer,
  questionAnswerCommandId,
  questionAskerLabel,
} from "./coordinatorQuestionAnswers";

const card = (requestId: string, answeredInChat?: boolean) =>
  ({
    type: "user_input_request",
    requestId,
    questions: [],
    questionAnswer: {
      requestId,
      answers: { q1: "Tall" },
      ...(answeredInChat === undefined ? {} : { answeredInChat }),
    },
  }) as unknown as OrchestrationV2TurnItem;

describe("questionAskerLabel", () => {
  it("names the coordinator, else the thread, never the person", () => {
    expect(questionAskerLabel({ threadId: "project-coordinator:atlas", title: "Atlas" })).toBe(
      "Coordinator",
    );
    expect(questionAskerLabel({ threadId: "thread-1", title: "Atlas", isCoordinator: true })).toBe(
      "Coordinator",
    );
    expect(questionAskerLabel({ threadId: "thread-1", title: " Fix the header " })).toBe(
      "Fix the header",
    );
    expect(questionAskerLabel({ threadId: "thread-1", title: "  " })).toBe("This thread's agent");
  });
});

describe("answeredQuestionsByMessageId", () => {
  it("folds a card answer and keeps a chat reply as the person's message", () => {
    const answered = answeredQuestionsByMessageId([
      card("ask-1"),
      card("ask-2", true),
      { type: "user_input_request", requestId: "ask-3", questions: [] } as never,
    ]);
    expect(answered.get("async-answer:ask-1")?.folded).toBe(true);
    expect(answered.get("async-answer:ask-2")?.folded).toBe(false);
    expect(answered.has("async-answer:ask-3")).toBe(false);
  });
});

describe("questionAnswerCommandId", () => {
  const requestId = RuntimeRequestId.make("ask-1");
  const id = (answers: Record<string, unknown>, files: Record<string, string[]> = {}) =>
    questionAnswerCommandId({ requestId, answers, attachmentIdsByQuestionId: files });

  it("is the same command for the same answer, so a resend replays it", () => {
    expect(id({ q1: "Tall", q2: ["A", "B"] })).toBe(id({ q2: ["A", "B"], q1: "Tall" }));
    expect(id({ q1: "Tall" })).toMatch(/^answer:ask-1:/);
  });

  it("is a new command for a changed answer or other files", () => {
    expect(id({ q1: "Tall" })).not.toBe(id({ q1: "Compact" }));
    expect(id({ q1: "Tall" }, { q1: ["file-a"] })).not.toBe(id({ q1: "Tall" }, { q1: ["file-b"] }));
  });

  it("is a new command after the host refused the answer", () => {
    const refusedId = RuntimeRequestId.make("ask-refused");
    const answer = () =>
      questionAnswerCommandId({
        requestId: refusedId,
        answers: { q1: "Tall" },
        attachmentIdsByQuestionId: {},
      });
    const first = answer();
    noteRefusedQuestionAnswer(refusedId);
    expect(answer()).not.toBe(first);
    expect(answer()).toBe(answer());
  });
});

describe("isSettledRequestRefusal", () => {
  it("matches only the host's settled refusal for this request", () => {
    expect(isSettledRequestRefusal("Runtime request ask-1 is resolved.", "ask-1")).toBe(true);
    expect(isSettledRequestRefusal("Runtime request ask-1 is cancelled.", "ask-1")).toBe(true);
    expect(isSettledRequestRefusal("Runtime request ask-2 is resolved.", "ask-1")).toBe(false);
    expect(isSettledRequestRefusal("Network error", "ask-1")).toBe(false);
  });
});

describe("isRecordedQuestionAnswer", () => {
  const shot = { type: "image", name: "shot.png" };
  const notes = { type: "file", name: "notes.md" };
  const line = (file: { type: string; name: string }) =>
    `Attached ${file.type} ${JSON.stringify(file.name)}: ${JSON.stringify(`/attachments/${file.name}`)}`;
  const resolved = (answers: Record<string, unknown>, status = "resolved") => [
    { id: "ask-0", status: "pending" },
    { id: "ask-1", status, answers },
  ];
  const recorded = (answers: Record<string, unknown>, sent: Record<string, unknown>, files = {}) =>
    isRecordedQuestionAnswer(resolved(answers), "ask-1", sent, files);

  it("is the same words on a resolved request, with the lines the host added for these files", () => {
    expect(recorded({ q1: "Tall" }, { q1: "Tall" })).toBe(true);
    expect(
      recorded(
        { q1: `Tall\n\n${line(shot)}\n${line(notes)}` },
        { q1: "Tall" },
        { q1: [shot, notes] },
      ),
    ).toBe(true);
    expect(recorded({ q1: line(shot) }, { q1: "" }, { q1: [shot] })).toBe(true);
    expect(recorded({ q1: line(shot), q2: "B" }, { q2: "B" }, { q1: [shot] })).toBe(true);
    expect(recorded({ q1: ["A", "B", line(shot)] }, { q1: ["A", "B"] }, { q1: [shot] })).toBe(true);
  });

  it("is not the same words without this send's files, or with another's", () => {
    // Someone else answered "Tall" with no file; this send carried one.
    expect(recorded({ q1: "Tall" }, { q1: "Tall" }, { q1: [shot] })).toBe(false);
    // Someone else attached a file; this send carried none.
    expect(recorded({ q1: `Tall\n\n${line(shot)}` }, { q1: "Tall" })).toBe(false);
    expect(recorded({ q1: `Tall\n\n${line(notes)}` }, { q1: "Tall" }, { q1: [shot] })).toBe(false);
    expect(recorded({ q1: `Tall\n\n${line(shot)}` }, { q1: "Tall" }, { q1: [shot, notes] })).toBe(
      false,
    );
  });

  it("does not take typed words that start with Attached for the host's file lines", () => {
    expect(recorded({ q1: "Tall\n\nAttached the mockups below." }, { q1: "Tall" })).toBe(false);
    expect(
      recorded({ q1: "Tall\n\nAttached the mockups below." }, { q1: "Tall" }, { q1: [shot] }),
    ).toBe(false);
    expect(recorded({ q1: "Attached is the link" }, { q1: "" }, { q1: [shot] })).toBe(false);
  });

  it("is not another answer, an unsettled request or a closed one", () => {
    expect(recorded({ q1: "Compact" }, { q1: "Tall" })).toBe(false);
    expect(recorded({ q1: "Tall, then" }, { q1: "Tall" })).toBe(false);
    expect(recorded({ q1: "Tall" }, { q1: "Tall", q2: "B" })).toBe(false);
    expect(recorded({ q1: ["A", "C"] }, { q1: ["A", "B"] })).toBe(false);
    expect(
      isRecordedQuestionAnswer(resolved({ q1: "Tall" }, "cancelled"), "ask-1", { q1: "Tall" }),
    ).toBe(false);
    expect(isRecordedQuestionAnswer([{ id: "ask-1", status: "resolved" }], "ask-1", {})).toBe(
      false,
    );
    expect(isRecordedQuestionAnswer(undefined, "ask-1", { q1: "Tall" })).toBe(false);
    expect(isRecordedQuestionAnswer(resolved({ q1: "Tall" }), "ask-0", { q1: "Tall" })).toBe(false);
  });
});
