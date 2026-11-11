import { describe, expect, it } from "vite-plus/test";

import { shellReportedBlocker } from "./ProjectionStore.ts";

const text = "Done so far.\n\n**Blockers:** Pair Chrome, or skip the check?";
const reportedAt = "2026-11-02T10:00:00.000Z";

describe("shellReportedBlocker", () => {
  it("holds the question while the report is the last word", () => {
    expect(
      shellReportedBlocker({ text, reportedAt, latestUserMessageAt: "2026-11-02T09:00:00.000Z" }),
    ).toContain("Pair Chrome");
  });

  it("clears once the person replies", () => {
    expect(
      shellReportedBlocker({ text, reportedAt, latestUserMessageAt: "2026-11-02T10:00:01.000Z" }),
    ).toBeNull();
  });

  it("clears on a server continuation too: any later user-role message ends it", () => {
    // The message a subscription change sends a limit-blocked thread is
    // stamped at or after the report it answers.
    expect(shellReportedBlocker({ text, reportedAt, latestUserMessageAt: reportedAt })).toBeNull();
  });

  it("holds a report with no message before it", () => {
    expect(shellReportedBlocker({ text, reportedAt, latestUserMessageAt: null })).toContain(
      "Pair Chrome",
    );
  });
});
