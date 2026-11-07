import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import {
  GitCommandError,
  GitManagerError,
  type OrchestrationV2Run,
  type ThreadPullRequestLink,
} from "@specweave-studio/contracts";

import {
  branchReadyForPullRequest,
  checkoutSignature,
  failureNotice,
  linkedPullRequestDecision,
  latestStartedRun,
  mergeStep,
  threadFinished,
} from "./ThreadFinishActionService.ts";

// Built at runtime so secret scanners do not flag these test fixtures.
const FAKE_GITHUB_TOKEN_1 = "ghp" + "_" + "abcdefghijklmnopqrstuvwxyz0123";
const FAKE_GITHUB_TOKEN_2 = "ghp" + "_" + "abcdefghijklmnopqrstuvwxyz0123456789";

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

const link = (
  number: number,
  repository: string,
  headBranch: string,
  state: "open" | "merged" | "closed",
  linkedAt: string,
): ThreadPullRequestLink =>
  ({
    host: "github.com",
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    source: "agent",
    linkedAt,
    snapshot: { state, headBranch, baseBranch: "main" },
    stack: null,
  }) as unknown as ThreadPullRequestLink;

describe("linked pull requests", () => {
  // The 1209 thread after the repository move: its worktree branch merged in the old repository,
  // and its work continued on another branch in the new one.
  const merged1209 = link(
    1430,
    "anton-abyzov/specwithcode-dev",
    "feat/1209-skill-authoring",
    "merged",
    "2026-11-05T22:55:29.777Z",
  );
  const open1248 = link(
    26,
    "anton-abyzov/specwithcode",
    "feat/1248-skill-management",
    "open",
    "2026-11-07T04:42:13.711Z",
  );

  it("treats a branch whose pull request merged in any repository as landed", () => {
    expect(linkedPullRequestDecision([merged1209, open1248], "feat/1209-skill-authoring")).toEqual({
      type: "landed",
    });
    expect(
      linkedPullRequestDecision(
        [link(3, "o/r", "feat/x", "closed", "2026-11-01T00:00:00Z")],
        "feat/x",
      ),
    ).toEqual({ type: "landed" });
  });

  it("reuses an open pull request instead of opening another", () => {
    expect(linkedPullRequestDecision([open1248], "feat/1248-skill-management")).toEqual({
      type: "open",
      link: open1248,
      onBranch: true,
    });
    expect(linkedPullRequestDecision([open1248], "feat/other")).toEqual({
      type: "open",
      link: open1248,
      onBranch: false,
    });
  });

  it("prefers the branch's own open pull request over an older closed one", () => {
    const reopened = link(9, "o/r", "feat/x", "open", "2026-11-02T00:00:00Z");
    expect(
      linkedPullRequestDecision(
        [link(3, "o/r", "feat/x", "closed", "2026-11-01T00:00:00Z"), reopened],
        "feat/x",
      ),
    ).toEqual({ type: "open", link: reopened, onBranch: true });
  });

  it("proceeds only when nothing is linked", () => {
    expect(linkedPullRequestDecision([], "feat/x")).toEqual({ type: "none" });
  });
});

describe("checkoutSignature", () => {
  const state = { refName: "feat/x", hasUpstream: true, aheadCount: 0, aheadOfDefaultCount: 4 };

  it("stays the same until the branch, upstream or commits change", () => {
    expect(checkoutSignature("/w", state)).toBe(checkoutSignature("/w", { ...state }));
    expect(checkoutSignature("/w", state)).not.toBe(checkoutSignature("/other", state));
    expect(checkoutSignature("/w", state)).not.toBe(
      checkoutSignature("/w", { ...state, refName: "feat/y" }),
    );
    expect(checkoutSignature("/w", state)).not.toBe(
      checkoutSignature("/w", { ...state, aheadOfDefaultCount: 5 }),
    );
    expect(checkoutSignature("/w", state)).not.toBe(
      checkoutSignature("/w", { ...state, aheadCount: 1 }),
    );
  });
});

describe("failureNotice", () => {
  it("says what to do when the branch has no history in common with the base", () => {
    const error = new GitManagerError({
      operation: "runPrStep",
      cwd: "/w",
      detail:
        "Branch feat/1209-skill-authoring shares no commits with main, so there is nothing to propose into it.",
    });
    const [summary] = failureNotice("Could not open a pull request", error, {
      branch: "feat/1209-skill-authoring",
      worktree: "/w",
    }).split("\n");
    expect(summary).toBe(
      "Could not open a pull request: feat/1209-skill-authoring has no history in common with main. Rebase it onto main, or link this thread's pull request.",
    );
  });

  it("drops the Git manager prefix from the summary line", () => {
    const error = new GitManagerError({
      operation: "runPrStep",
      cwd: "/w",
      detail: "Current branch has not been pushed. Push before creating a PR.",
    });
    const message = failureNotice("Could not open a pull request", error, {
      branch: "b",
      worktree: "/w",
    });
    expect(message.split("\n")[0]).toBe(
      "Could not open a pull request: Current branch has not been pushed. Push before creating a PR.",
    );
    expect(message).toContain("Operation: runPrStep");
  });

  it("scrubs URL credentials while retaining the full automatic PR failure", () => {
    const error = new GitCommandError({
      operation: "GitVcsDriver.readRangeContext.diffStat",
      command: "git",
      cwd: "/tmp/wt",
      exitCode: 128,
      detail: `fatal: fixture range failure https://fixture-user:fixture-password-${"x".repeat(220)}@example.invalid/repo?token=fixture-query-token&branch=develop ${"diagnostic-context ".repeat(350)}END-OF-FULL-DIAGNOSTIC`,
    });
    const message = failureNotice("Could not open a pull request", error, {
      branch: "ops/watch",
      worktree: "/tmp/wt",
    });
    expect(message).not.toContain("fixture-password-");
    expect(message).not.toContain("fixture-query-token");
    expect(message).toContain("token=[redacted]&branch=develop diagnostic-context");
    expect(message).toContain("Operation: GitVcsDriver.readRangeContext.diffStat");
    expect(message).toContain("Exit code: 128");
    expect(message.length).toBeGreaterThan(4_000);
    expect(message.endsWith("END-OF-FULL-DIAGNOSTIC")).toBe(true);
  });

  it.each([
    `${"x".repeat(170)}https://user:demo-fake-secret@github.com/example`,
    `${"x".repeat(177)} ${FAKE_GITHUB_TOKEN_2}`,
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
      new Error(`push failed\nfatal: https://user:${FAKE_GITHUB_TOKEN_1}@github.com/x`),
      { branch: "b", worktree: "/w" },
    );
    expect(leaked).toContain("fatal:");
    expect(leaked).not.toContain(FAKE_GITHUB_TOKEN_1);
  });
});
