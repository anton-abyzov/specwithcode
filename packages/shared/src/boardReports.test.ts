import { describe, expect, it } from "vite-plus/test";

import {
  bestBoardReport,
  boardReportGroup,
  boardReportRelative,
  orderBoardReports,
} from "./boardReports.ts";

const at = (relative: string) => `/p/.specweave/increments/1451-office/reports/${relative}`;

describe("boardReportGroup", () => {
  it.each([
    ["parity.md", "report"],
    ["research.md", "report"],
    ["mockup.html", "report"],
    ["deck.pptx", "report"],
    ["plan.pdf", "report"],
    ["mockup.png", "image"],
    ["screens/toast-on-m4.png", "image"],
    ["mockup.svg", "image"],
    ["reviews/review-gpt-6.2-sol-1.md", "review"],
    ["review-round-2.md", "review"],
    ["review-gemini-4-neon.md", "review"],
    ["reviews/notes.txt", "review"],
    ["task-T-01.txt", "evidence"],
    ["verify.json", "evidence"],
    ["verify.md", "evidence"],
    ["copilot-acp-probe-shell.log", "evidence"],
    ["gaps.py", "evidence"],
    ["probe.mjs", "evidence"],
  ] as const)("%s is %s", (relative, group) => {
    expect(boardReportGroup(at(relative))).toBe(group);
  });

  it("reads Windows paths", () => {
    expect(boardReportGroup("C:\\p\\.specweave\\increments\\1-a\\reports\\reviews\\x.md")).toBe(
      "review",
    );
    expect(boardReportRelative("C:\\p\\inc\\reports\\screens\\a.png")).toBe("screens/a.png");
  });
});

describe("orderBoardReports", () => {
  it("puts real reports first and keeps the given order inside a group", () => {
    // Newest first, as the server lists them: the task log is the newest file.
    const listed = [
      "task-T-01.txt",
      "parity.md",
      "reviews/review-sol.md",
      "older.md",
      "mockup.png",
      "verify.json",
    ].map((relative) => ({ path: at(relative), name: relative }));
    expect(orderBoardReports(listed).map((report) => report.name)).toEqual([
      "parity.md",
      "older.md",
      "reviews/review-sol.md",
      "mockup.png",
      "task-T-01.txt",
      "verify.json",
    ]);
    expect(bestBoardReport(listed)?.name).toBe("parity.md");
  });

  it("opens evidence only when nothing else exists", () => {
    const only = [{ path: at("task-T-01.txt") }, { path: at("task-T-02.txt") }];
    expect(bestBoardReport(only)?.path).toBe(at("task-T-01.txt"));
    expect(bestBoardReport([])).toBeNull();
  });
});
