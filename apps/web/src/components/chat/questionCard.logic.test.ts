import { describe, expect, it } from "vite-plus/test";

import {
  deriveDecision,
  deriveQuestionStep,
  linkifyQuestionPaths,
  presentQuestionOption,
  questionOptionIndexForKey,
  questionOptionLetter,
  splitQuestionText,
} from "./questionCard.logic";

describe("splitQuestionText", () => {
  it("keeps the first paragraph as the headline and the rest as details", () => {
    expect(
      splitQuestionText(
        'Delete the project "140 provider verification grok" and its 1 thread?\n\nThis cannot be undone.\n\nReason: Leftover test project.',
      ),
    ).toEqual({
      headline: 'Delete the project "140 provider verification grok" and its 1 thread?',
      details: "This cannot be undone.\n\nReason: Leftover test project.",
    });
  });

  it("has no details for a one-paragraph question", () => {
    expect(splitQuestionText("Which approach?\n")).toEqual({
      headline: "Which approach?",
      details: null,
    });
  });
});

describe("question card options", () => {
  it("letters options and maps letter or number keys back to them", () => {
    expect([0, 1, 2].map(questionOptionLetter)).toEqual(["A", "B", "C"]);
    expect(questionOptionIndexForKey("b", 3)).toBe(1);
    expect(questionOptionIndexForKey("C", 3)).toBe(2);
    expect(questionOptionIndexForKey("2", 3)).toBe(1);
    expect(questionOptionIndexForKey("d", 3)).toBe(-1);
    expect(questionOptionIndexForKey("Enter", 3)).toBe(-1);
  });

  it("reads Recommended from the flag or a label suffix", () => {
    expect(
      presentQuestionOption({ label: "Waitlist", description: "x", recommended: true }),
    ).toEqual({
      label: "Waitlist",
      description: "x",
      recommended: true,
    });
    expect(
      presentQuestionOption({ label: "Waitlist wording (Recommended)", description: "" }),
    ).toEqual({
      label: "Waitlist wording",
      description: null,
      recommended: true,
    });
    expect(presentQuestionOption({ label: "Leave", description: "Leave" }).description).toBeNull();
  });
});

describe("linkifyQuestionPaths", () => {
  it("wraps bare file paths in code so they become links", () => {
    expect(linkifyQuestionPaths("See /Users/me/report.md.")).toBe("See `/Users/me/report.md`.");
    expect(linkifyQuestionPaths("Edit ~/Projects/app/src/a.ts now")).toBe(
      "Edit `~/Projects/app/src/a.ts` now",
    );
  });

  it("leaves code spans, links and URLs alone", () => {
    const text = "Open `/a/b.md` or [doc](/a/b.md) at https://x.com/a/b";
    expect(linkifyQuestionPaths(text)).toBe(text);
  });
});

describe("deriveDecision", () => {
  const questions = [
    {
      id: "q1",
      question: "Clear regenerable caches?",
      options: [
        { label: "Clear caches", description: "Frees space" },
        { label: "Leave as is", description: "Nothing changes" },
      ],
    },
  ];

  it("matches the answer to its lettered option", () => {
    expect(
      deriveDecision(questions, {
        requestId: "r",
        answers: { q1: "Leave as is" },
        attachmentsByQuestionId: {},
      }),
    ).toEqual([
      {
        id: "q1",
        question: "Clear regenerable caches?",
        choices: [{ letter: "B", label: "Leave as is" }],
      },
    ]);
  });

  it("keeps a typed reply without a letter", () => {
    expect(
      deriveDecision(questions, {
        requestId: "r",
        answers: { q1: "Only the Xcode ones" },
        attachmentsByQuestionId: {},
      })[0]?.choices,
    ).toEqual([{ letter: null, label: "Only the Xcode ones" }]);
  });
});

describe("deriveQuestionStep", () => {
  const base = {
    questionIndex: 0,
    questionCount: 4,
    selectedCount: 0,
    isLastQuestion: false,
    canAdvance: false,
    isComplete: false,
    isResponding: false,
  };

  it("offers Next once something is picked on an earlier question", () => {
    expect(deriveQuestionStep(base)).toEqual({
      label: "Next",
      isSubmit: false,
      enabled: false,
      selection: "None selected yet",
    });
    expect(deriveQuestionStep({ ...base, selectedCount: 3, canAdvance: true })).toMatchObject({
      label: "Next",
      enabled: true,
      selection: "3 selected",
    });
  });

  it("submits on the last question only when every question is answered", () => {
    const last = { ...base, questionIndex: 3, isLastQuestion: true, canAdvance: true };
    expect(deriveQuestionStep(last)).toMatchObject({
      label: "Submit answers",
      isSubmit: true,
      enabled: false,
    });
    expect(deriveQuestionStep({ ...last, isComplete: true }).enabled).toBe(true);
    expect(
      deriveQuestionStep({ ...last, questionCount: 1, questionIndex: 0, isComplete: true }).label,
    ).toBe("Submit");
  });

  it("holds the step while the answer is being sent", () => {
    expect(deriveQuestionStep({ ...base, canAdvance: true, isResponding: true })).toMatchObject({
      label: "Submitting…",
      enabled: false,
    });
  });
});
