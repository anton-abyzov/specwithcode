import { describe, expect, it } from "vite-plus/test";

import {
  questionAnswerLabels,
  questionAnswerMessageText,
  questionAnswerProviderText,
  questionAnswerRequestId,
} from "./questionAnswerText.ts";

describe("question answer text", () => {
  it("numbers headers two questions share", () => {
    expect(
      questionAnswerLabels([{ header: "Question" }, { header: "Scope" }, { header: "Question" }]),
    ).toEqual(["Question 1", "Scope", "Question 3"]);
    expect(questionAnswerLabels([{ header: "  " }])).toEqual(["Question"]);
  });

  it("keeps a single answer as written and labels a card's several answers", () => {
    expect(questionAnswerMessageText([{ label: "Layout", answer: "Tall", files: [] }], 1)).toBe(
      "Tall",
    );
    // An optional second question left unanswered still labels the first.
    expect(questionAnswerMessageText([{ label: "Layout", answer: "Tall", files: [] }], 2)).toBe(
      "Layout: Tall",
    );
    expect(
      questionAnswerMessageText(
        [
          { label: "Layout", answer: "", files: [{ name: "a.png" }, { name: "b.png" }] },
          { label: "Notes", answer: "line one\nline two", files: [] },
        ],
        2,
      ),
    ).toBe("Layout: a.png, b.png\n\nNotes:\nline one\nline two");
  });

  it("puts the agent's questions before the answer only for the provider", () => {
    expect(
      questionAnswerProviderText([{ header: "Binding", question: "Which repository?" }], ""),
    ).toBe(
      "The user answered the question you asked with ask_user.\nYou asked: Binding: Which repository?\nTheir answer:\n(The answer is in the attached files.)",
    );
  });

  it("reads the request id only from an answer's message id", () => {
    expect(questionAnswerRequestId("async-answer:ask-user:t:k")).toBe("ask-user:t:k");
    expect(questionAnswerRequestId("async-answer:")).toBeNull();
    expect(questionAnswerRequestId("message:1")).toBeNull();
  });
});
