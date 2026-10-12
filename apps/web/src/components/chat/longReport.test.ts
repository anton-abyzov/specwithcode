import { describe, expect, it } from "vite-plus/test";

import { MAX_REPORT_LENGTH, MAX_REPORT_LINES, shouldCollapseReport } from "./longReport";

const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => `Line ${index + 1}.`).join("\n");

describe("shouldCollapseReport", () => {
  it("leaves empty and short reports alone", () => {
    expect(shouldCollapseReport("")).toBe(false);
    expect(shouldCollapseReport("   \n  ")).toBe(false);
    expect(shouldCollapseReport("Done. Fixed the login bug and added a test.")).toBe(false);
    expect(shouldCollapseReport(lines(MAX_REPORT_LINES))).toBe(false);
  });

  it("does not count blank lines between paragraphs", () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `Paragraph ${i}.`).join("\n\n");
    expect(shouldCollapseReport(paragraphs)).toBe(false);
  });

  it("collapses many lines", () => {
    expect(shouldCollapseReport(lines(MAX_REPORT_LINES + 1))).toBe(true);
  });

  it("collapses long text on few lines", () => {
    expect(shouldCollapseReport("a".repeat(MAX_REPORT_LENGTH + 1))).toBe(true);
  });

  it("treats any markdown table as long", () => {
    expect(shouldCollapseReport("Results:\n\n| Model | Price |\n| --- | ---: |\n| A | 1 |")).toBe(
      true,
    );
  });

  it("treats several headings as long", () => {
    expect(shouldCollapseReport("# Summary\nOk.\n## Changes\nSome.\n## Next\nNone.")).toBe(true);
    expect(shouldCollapseReport("## Summary\nAll good.")).toBe(false);
  });

  it("ignores headings and tables inside code blocks", () => {
    const fenced = "Run this:\n```sh\n# one\n# two\n# three\n| a | b |\n|---|---|\n```";
    expect(shouldCollapseReport(fenced)).toBe(false);
  });
});
