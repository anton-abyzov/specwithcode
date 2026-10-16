import { describe, expect, it } from "vite-plus/test";

import { queuedAgeLabel, queuedRunOneLine } from "./queuedRunSummary";

describe("queuedRunOneLine", () => {
  it("prefers the notification's own summary", () => {
    expect(queuedRunOneLine("## Report\n\nLong body", "Release 1.0.31 shipped")).toBe(
      "Release 1.0.31 shipped",
    );
  });
  it("reads a Markdown report as its first plain line", () => {
    const text = "```sh\nnpm test\n```\n\n## **Outcome:** all 12 checks pass\n- [x] item";
    expect(queuedRunOneLine(text)).toBe("Outcome: all 12 checks pass");
    expect(queuedRunOneLine("---\n> See [the PR](https://x/1) for `details`")).toBe(
      "See the PR for details",
    );
  });
  it("clips a long line", () => {
    const line = queuedRunOneLine("word ".repeat(80));
    expect(line.length).toBe(160);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("queuedAgeLabel", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  it.each([
    [now - 20_000, "queued just now"],
    [now - 12 * 60_000, "queued 12 min"],
    [now - 125 * 60_000, "queued 2 h 5 min"],
    [now - 120 * 60_000, "queued 2 h"],
    [now - 50 * 3_600_000, "queued 2 d"],
  ])("labels %s as %s", (at, label) => {
    expect(queuedAgeLabel(at, now)).toBe(label);
  });
  it("is null without a time", () => {
    expect(queuedAgeLabel(null, now)).toBeNull();
  });
});
