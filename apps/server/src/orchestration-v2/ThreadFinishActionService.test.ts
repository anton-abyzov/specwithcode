import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { GitCommandError, type OrchestrationV2Run } from "@specweave-studio/contracts";

import {
  branchReadyForPullRequest,
  failureNotice,
  latestStartedRun,
  mergeStep,
  threadFinished,
} from "./ThreadFinishActionService.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const run = (
  ordinal: number,
  status: OrchestrationV2Run["status"],
  completedAt: string | null = null,
): OrchestrationV2Run =>
  ({
    id: `run-${ordinal}`,
    ordinal,
    status,
    completedAt: completedAt === null ? null : at(completedAt),
  }) as unknown as OrchestrationV2Run;

const cleanBranch = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feat/x",
  hasWorkingTreeChanges: false,
  aheadOfDefaultCount: 2,
  pr: null,
} as const;

describe("thread finish action", () => {
  it("treats a thread as finished only when its last turn completed and nothing waits", () => {
    expect(threadFinished([run(1, "completed", "2026-10-15T10:00:00Z")])).toBe(true);
    expect(threadFinished([run(1, "completed", "2026-10-15T10:00:00Z"), run(2, "queued")])).toBe(
      false,
    );
    expect(threadFinished([run(1, "completed", "2026-10-15T10:00:00Z"), run(2, "running")])).toBe(
      false,
    );
    expect(
      threadFinished([
        run(1, "completed", "2026-10-15T10:00:00Z"),
        run(2, "interrupted", "2026-10-15T11:00:00Z"),
      ]),
    ).toBe(false);
    expect(threadFinished([])).toBe(false);
  });

  it("picks the run that ended last, ignoring queued and rolled back runs", () => {
    const runs = [
      run(1, "completed", "2026-10-15T12:00:00Z"),
      run(2, "failed", "2026-10-15T11:00:00Z"),
      run(3, "rolled_back", "2026-10-15T13:00:00Z"),
    ];
    expect(latestStartedRun(runs)?.id).toBe("run-1");
  });

  it("proposes only a clean feature branch with commits or an open PR", () => {
    expect(branchReadyForPullRequest(cleanBranch, "feat/x")).toBe(true);
    expect(branchReadyForPullRequest({ ...cleanBranch, isDefaultRef: true }, "feat/x")).toBe(false);
    expect(
      branchReadyForPullRequest({ ...cleanBranch, hasWorkingTreeChanges: true }, "feat/x"),
    ).toBe(false);
    expect(branchReadyForPullRequest({ ...cleanBranch, refName: "other" }, "feat/x")).toBe(false);
    expect(branchReadyForPullRequest({ ...cleanBranch, aheadOfDefaultCount: 0 }, "feat/x")).toBe(
      false,
    );
    expect(branchReadyForPullRequest({ ...cleanBranch, hasPrimaryRemote: false }, "feat/x")).toBe(
      false,
    );
  });

  it("merges a ready PR, hands a pending one to auto-merge and refuses a broken one", () => {
    const base = { number: 123, state: "open", baseBranch: "develop" } as const;
    expect(mergeStep({ ...base, checksState: "passing", mergeability: "mergeable" })).toEqual({
      type: "merge",
    });
    expect(mergeStep({ ...base, checksState: null, mergeability: "mergeable" })).toEqual({
      type: "merge",
    });
    expect(mergeStep({ ...base, checksState: "pending", mergeability: "mergeable" })).toEqual({
      type: "auto-merge",
    });
    expect(mergeStep({ ...base, checksState: "passing", mergeability: "unknown" })).toEqual({
      type: "auto-merge",
    });
    expect(mergeStep({ ...base, checksState: "failing", mergeability: "mergeable" })).toEqual({
      type: "done",
      notice: "blocked",
      message: "Checks failed on #123; not merging into develop",
    });
    expect(
      mergeStep({ ...base, checksState: "passing", mergeability: "conflicting" }),
    ).toMatchObject({ type: "done", notice: "blocked" });
    expect(mergeStep({ ...base, state: "merged" })).toEqual({
      type: "done",
      notice: "merged",
      message: "Merged #123 into develop",
    });
  });
});

describe("failureNotice", () => {
  it.each([
    `${"x".repeat(170)}https://user:demo-fake-secret@github.com/example`,
    `${"x".repeat(177)} ghp_abcdefghijklmnopqrstuvwxyz0123456789`,
  ])("redacts credentials before shortening the summary", (detail) => {
    const message = failureNotice("Could not open a pull request", new Error(detail), {
      branch: "ops/watch",
      worktree: "/tmp/wt",
    });
    expect(message).not.toContain("demo-fake-secret");
    expect(message).not.toContain("ghp_");
    expect(message.split("\n")[0]).toContain("[redacted]");
  });

  it("preserves diagnostics beyond 4,000 characters for inspection and copying", () => {
    const detail = `Push rejected\n${"remote: diagnostic context\n".repeat(200)}fatal: final actionable reason`;
    const message = failureNotice("Could not open a pull request", new Error(detail), {
      branch: "ops/watch",
      worktree: "/tmp/wt",
    });
    expect(message).toContain(detail);
    expect(message.endsWith("fatal: final actionable reason")).toBe(true);
  });

  it("keeps a one-line summary and the full Git diagnostics, without credentials", () => {
    const error = new GitCommandError({
      operation: "GitVcsDriver.readRangeContext.diffStat",
      command: "git",
      cwd: "/tmp/wt",
      exitCode: 128,
      detail:
        "Git command exited with a non-zero status.: fatal: origin/main...HEAD: no merge base",
    });
    const message = failureNotice("Could not open a pull request", error, {
      branch: "ops/watch",
      worktree: "/tmp/wt",
    });
    const [summary, ...rest] = message.split("\n");
    expect(summary).toContain("Could not open a pull request: Git command failed in");
    expect(rest.join("\n")).toContain("Branch: ops/watch");
    expect(rest.join("\n")).toContain("Exit code: 128");
    expect(message).toContain("fatal: origin/main...HEAD: no merge base");

    const leaked = failureNotice(
      "Could not open a pull request",
      new Error("push failed\nfatal: https://user:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x"),
      { branch: "b", worktree: "/w" },
    );
    expect(leaked).toContain("fatal:");
    expect(leaked).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
  });
});
