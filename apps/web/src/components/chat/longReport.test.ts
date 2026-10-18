import { describe, expect, it } from "vite-plus/test";

import {
  asksForReport,
  MAX_REPORT_LINES,
  MAX_REPORT_WORDS,
  MIN_REQUESTED_REPORT_WORDS,
  shouldCollapseReport,
} from "./longReport";

const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => `Line ${index + 1}.`).join("\n");
const words = (count: number) => Array.from({ length: count }, () => "word").join(" ");

describe("shouldCollapseReport", () => {
  it("leaves empty and short replies alone", () => {
    expect(shouldCollapseReport("")).toBe(false);
    expect(shouldCollapseReport("   \n  ")).toBe(false);
    expect(shouldCollapseReport("Done. Fixed the login bug and added a test.")).toBe(false);
  });

  it("keeps a direct answer of a few hundred words inline", () => {
    // The answer that showed up as "Report · 380 words": a few paragraphs and a list.
    const answer = [
      "Yes. Both machines dropped because the relay token expired at midnight.",
      "",
      `${words(150)}.`,
      "",
      "- Reconnected M1 and M3.",
      "- Restarted the relay.",
      "- The UI froze because the host list waited on the dead socket.",
      "",
      `${words(200)}.`,
      "",
      "| Machine | State |",
      "| --- | --- |",
      "| M1 | online |",
    ].join("\n");
    expect(shouldCollapseReport(answer)).toBe(false);
    expect(shouldCollapseReport(lines(20))).toBe(false);
    expect(shouldCollapseReport("a".repeat(3_000))).toBe(false);
    expect(shouldCollapseReport("## Summary\nAll good.\n## Next\nNothing.")).toBe(false);
  });

  it("collapses a reply past the word limit", () => {
    expect(shouldCollapseReport(words(MAX_REPORT_WORDS))).toBe(false);
    expect(shouldCollapseReport(words(MAX_REPORT_WORDS + 1))).toBe(true);
  });

  it("collapses a reply with several headed sections", () => {
    expect(shouldCollapseReport("# Summary\nOk.\n## Changes\nSome.\n## Next\nNone.")).toBe(true);
  });

  it("collapses a reply well past a screen of lines", () => {
    expect(shouldCollapseReport(lines(MAX_REPORT_LINES))).toBe(false);
    expect(shouldCollapseReport(lines(MAX_REPORT_LINES + 1))).toBe(true);
  });

  it("ignores headings inside code blocks", () => {
    const fenced = "Run this:\n```sh\n# one\n# two\n# three\n| a | b |\n|---|---|\n```";
    expect(shouldCollapseReport(fenced)).toBe(false);
  });

  it("shows a requested report as a card once it has some substance", () => {
    expect(shouldCollapseReport(words(MIN_REQUESTED_REPORT_WORDS), { requested: true })).toBe(true);
    expect(shouldCollapseReport(words(MIN_REQUESTED_REPORT_WORDS), { requested: false })).toBe(
      false,
    );
    expect(shouldCollapseReport("Nothing to report.", { requested: true })).toBe(false);
  });
});

describe("asksForReport", () => {
  it("recognizes requests for a report or a document", () => {
    expect(asksForReport("Write me a report on the outage")).toBe(true);
    expect(asksForReport("Can you do a write-up of the release?")).toBe(true);
    expect(asksForReport("Audit the auth flow")).toBe(true);
    expect(asksForReport("Put it in a document")).toBe(true);
  });

  it("ignores ordinary questions", () => {
    expect(asksForReport("Why did the machines disconnect?")).toBe(false);
    expect(asksForReport("")).toBe(false);
    expect(asksForReport(null)).toBe(false);
    expect(asksForReport("Reported by Anton")).toBe(false);
  });
});
