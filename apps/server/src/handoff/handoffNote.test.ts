import { describe, expect, it } from "@effect/vitest";
import { HANDOFF_NOTE_MAX_WORDS } from "@specweave-studio/contracts";

import { capHandoffNote, fallbackHandoffNote, handoffTranscript } from "./handoffNote.ts";

const countWords = (note: { done: string; next: string; openQuestions: string }) =>
  `${note.done} ${note.next} ${note.openQuestions}`.split(/\s+/).filter(Boolean).length;

describe("handoffTranscript", () => {
  it("keeps the latest twelve messages, oldest first, and clips long ones", () => {
    const messages = Array.from({ length: 15 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: index === 14 ? "x".repeat(2_500) : `message ${index}`,
    }));
    const transcript = handoffTranscript(messages);
    expect(transcript).not.toContain("message 2\n");
    expect(transcript.startsWith("Assistant: message 3")).toBe(true);
    expect(transcript).toContain(`User: ${"x".repeat(2_000)} [...]`);
  });
});

describe("capHandoffNote", () => {
  it("leaves a short note alone", () => {
    const note = { done: "Fixed the parser.", next: "Run the tests.", openQuestions: "" };
    expect(capHandoffNote(note)).toEqual(note);
  });

  it("trims Done first and keeps Next", () => {
    const long = Array.from({ length: 200 }, (_, index) => `w${index}`).join(" ");
    const capped = capHandoffNote({
      done: long,
      next: "Open the pull request.",
      openQuestions: "",
    });
    expect(countWords(capped)).toBe(HANDOFF_NOTE_MAX_WORDS);
    expect(capped.next).toBe("Open the pull request.");
  });

  it("trims Next only when the other fields are gone", () => {
    const long = Array.from({ length: 200 }, () => "n").join(" ");
    const capped = capHandoffNote({ done: "a b", next: long, openQuestions: "c" }, 10);
    expect(capped).toEqual({ done: "", next: "n n n n n n n n n n", openQuestions: "" });
  });
});

describe("fallbackHandoffNote", () => {
  it("builds Done and Next from the latest reply and request", () => {
    const note = fallbackHandoffNote(
      [
        { role: "user", text: "Add the lease. Then test it." },
        { role: "assistant", text: "Added the lease and its epoch. Tests next." },
      ],
      "2026-10-20T14:00:00.000Z",
    );
    expect(note.done).toBe("Latest reply: Added the lease and its epoch.");
    expect(note.next).toBe("Continue the latest request: Add the lease.");
    expect(note.createdAt).toBe("2026-10-20T14:00:00.000Z");
  });

  it("asks to read the thread when there is no request", () => {
    expect(fallbackHandoffNote([], "2026-10-20T14:00:00.000Z").next).toBe(
      "Read the thread and continue.",
    );
  });
});
