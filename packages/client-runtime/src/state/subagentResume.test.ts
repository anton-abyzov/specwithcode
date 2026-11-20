import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { subagentExecutionStatus } from "./models.ts";

// Seen November 18, 2026: a subagent's parent record went interrupted at
// 13:47:29.719 when its first run moved into its worktree, and its
// continuation started at 13:47:33.224.
describe("a delegated child that moved into its worktree", () => {
  const record = {
    status: "interrupted" as const,
    completedAt: DateTime.makeUnsafe("2026-11-18T13:47:29.719Z"),
  };
  const childShell = (activityStartedAt: string, status: "running" | "completed") =>
    ({
      environmentId: "machine-a",
      executionMachineId: "machine-a",
      executionState: "running",
      runtime: {
        status,
        activeRunId: status === "running" ? "run-2" : null,
        activityStartedAt,
      },
      latestRun: {
        runId: "run-2",
        status,
        requestedAt: "2026-11-18T13:47:29.788Z",
        startedAt: "2026-11-18T13:47:33.224Z",
        completedAt: status === "running" ? null : "2026-11-18T14:30:00.000Z",
      },
    }) as never;

  it("reads running while its continuation runs, not Stopped", () => {
    expect(
      subagentExecutionStatus({
        record,
        thread: childShell("2026-11-18T13:47:33.224Z", "running"),
      }),
    ).toBe("running");
  });

  it("keeps the receipt when nothing ran after it", () => {
    expect(
      subagentExecutionStatus({
        record,
        thread: childShell("2026-11-18T13:46:14.703Z", "running"),
      }),
    ).toBe("interrupted");
  });
});
