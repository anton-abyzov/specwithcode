import { describe, expect, it } from "vite-plus/test";

import {
  reportFileName,
  reportIncrementCandidates,
  reportKey,
  reportKeyFromFileName,
  reportSummary,
  reportThreadKey,
  reportTitle,
  reportWordCount,
} from "./threadReport.ts";

describe("thread report helpers", () => {
  it("keys a report by thread and normalized text", () => {
    expect(reportKey("t1", "Body\r\n")).toBe(reportKey("t1", "  Body"));
    expect(reportKey("t1", "Body")).not.toBe(reportKey("t2", "Body"));
    expect(reportKey("t1", "Body")).not.toBe(reportKey("t1", "Other"));
    expect(reportKey("t1", "Body").startsWith(`${reportThreadKey("t1")}-`)).toBe(true);
  });

  it("titles a report by its heading, its first line, or the fallback", () => {
    expect(reportTitle("## **Budget** review\n\nBody", "Thread")).toBe("Budget review");
    expect(reportTitle("Tests pass.\n\nMore", "Thread")).toBe("Tests pass");
    expect(reportTitle(`${"word ".repeat(30)}`, "Review cycle 2")).toBe("Review cycle 2");
    expect(reportTitle("", "")).toBe("Report");
    expect(reportTitle("- Finding 1\n- Finding 2", "Review 0973")).toBe("Review 0973");
    expect(reportTitle("| a | b |\n| --- | --- |", "Audit")).toBe("Audit");
    expect(reportTitle("Ran the migration.\n\n```bash\n# run it\nnpm run migrate\n```", "T")).toBe(
      "Ran the migration",
    );
  });

  it("summarizes the first prose paragraph as plain text", () => {
    const text = [
      "# Title",
      "",
      "```ts",
      "const x = 1;",
      "",
      "const y = 2;",
      "```",
      "",
      "No **critical** findings; see [the PR](https://example.com).",
    ].join("\n");
    expect(reportSummary(text)).toBe("No critical findings; see the PR.");
    expect(reportSummary(`${"a".repeat(400)}`, 20)).toHaveLength(20);
  });

  it("counts words", () => {
    expect(reportWordCount("# Hi there\n\n- one, two | 3")).toBe(5);
  });

  it("finds increment candidates in the title, branch and named folders", () => {
    expect(
      reportIncrementCandidates({
        title: "Review cycle 2 of 0973",
        branch: "inc/0974-export",
        text: "Saved in .specweave/increments/0975-csv and 1999 rows.",
      }),
    ).toEqual([
      { kind: "number", value: "0973" },
      { kind: "folder", value: "0974-export" },
      { kind: "folder", value: "0975-csv", fromText: true },
    ]);
  });

  it("finds increment numbers and folders past 9999", () => {
    expect(
      reportIncrementCandidates({
        title: "Review 10001",
        branch: "inc/10002-export",
        text: "Saved in .specweave/increments/10003-csv.",
      }),
    ).toEqual([
      { kind: "number", value: "10001" },
      { kind: "folder", value: "10002-export" },
      { kind: "folder", value: "10003-csv", fromText: true },
    ]);
  });

  it("names files by day, title and key, and reads the key back", () => {
    const name = reportFileName({
      savedAt: "2026-10-12T07:30:00.000Z",
      title: "Review: cycle 2 of 0973!",
      threadId: "t1",
      text: "Body",
    });
    expect(name).toBe(`2026-10-12-review-cycle-2-of-0973-${reportKey("t1", "Body")}.md`);
    expect(reportKeyFromFileName(name)).toBe(reportKey("t1", "Body"));
    expect(reportKeyFromFileName("spec.md")).toBeNull();
  });
});
