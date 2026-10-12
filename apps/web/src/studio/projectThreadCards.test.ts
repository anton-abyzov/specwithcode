import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  threadCardActions,
  threadCardPullRequest,
  threadCardStatus,
  threadHasUnshippedWork,
} from "./projectThreadCards";

function thread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: "worker",
    environmentId: "host",
    projectId: "atlas",
    title: "Worker",
    branch: "feature",
    worktreePath: null,
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    pullRequests: [],
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    updatedAt: "2026-10-11T00:00:00Z",
    ...overrides,
  } as EnvironmentThreadShell;
}

type Git = NonNullable<Parameters<typeof threadHasUnshippedWork>[1]>;
function git(overrides: Partial<Git> = {}): Git {
  return {
    isRepo: true,
    refName: "feature",
    isDefaultRef: false,
    hasPrimaryRemote: true,
    hasWorkingTreeChanges: false,
    aheadCount: 0,
    pr: null,
    ...overrides,
  } as Git;
}

const link = (state: "open" | "merged" | "closed", isDraft = false) =>
  ({
    host: "github.com",
    repository: "acme/atlas",
    number: 7,
    url: "https://github.com/acme/atlas/pull/7",
    source: "created",
    linkedAt: "2026-10-11T00:00:00Z",
    snapshot: { state, isDraft, title: "Change", updatedAt: "2026-10-11T00:00:00Z" },
  }) as unknown as EnvironmentThreadShell["pullRequests"][number];

describe("threadCardStatus", () => {
  it("says what the thread wants or does, and calls a finished turn done", () => {
    expect(threadCardStatus(thread())).toEqual({ tone: "idle", label: "Idle" });
    expect(threadCardStatus(thread({ latestRun: { status: "completed" } as never }))).toEqual({
      tone: "done",
      label: "Done",
    });
    expect(threadCardStatus(thread({ hasPendingUserInput: true }))).toMatchObject({
      tone: "waiting",
    });
    expect(threadCardStatus(thread({ settledOverride: "settled" }))).toEqual({
      tone: "resolved",
      label: "Resolved",
    });
    expect(threadCardStatus(thread({ runtime: { status: "running" } as never })).tone).toBe(
      "working",
    );
  });
});

describe("threadCardPullRequest", () => {
  it("prefers the pull request the thread linked", () => {
    expect(threadCardPullRequest(thread({ pullRequests: [link("open", true)] }), null)).toEqual({
      url: "https://github.com/acme/atlas/pull/7",
      number: 7,
      state: "draft",
    });
  });
  it("falls back to the one the thread's branch has on the host", () => {
    const pr = {
      number: 9,
      title: "Branch PR",
      url: "https://github.com/acme/atlas/pull/9",
      baseRef: "main",
      headRef: "feature",
      state: "merged",
    } as const;
    expect(threadCardPullRequest(thread(), git({ pr }))).toEqual({
      url: pr.url,
      number: 9,
      state: "merged",
    });
    expect(threadCardPullRequest(thread({ branch: "other" }), git({ pr }))).toBeNull();
  });
});

describe("threadHasUnshippedWork", () => {
  it("counts uncommitted changes and commits the default branch does not have", () => {
    expect(threadHasUnshippedWork(thread(), git({ hasWorkingTreeChanges: true }), null)).toBe(true);
    expect(threadHasUnshippedWork(thread(), git({ aheadOfDefaultCount: 2 }), null)).toBe(true);
    expect(
      threadHasUnshippedWork(
        thread(),
        git({ branchChanges: { baseRef: "main", insertions: 4, deletions: 0 } }),
        null,
      ),
    ).toBe(true);
    expect(threadHasUnshippedWork(thread(), git(), null)).toBe(false);
  });
  it("needs a branch of its own with a remote, still checked out", () => {
    const changed = { hasWorkingTreeChanges: true };
    expect(threadHasUnshippedWork(thread(), git({ ...changed, isDefaultRef: true }), null)).toBe(
      false,
    );
    expect(
      threadHasUnshippedWork(thread(), git({ ...changed, hasPrimaryRemote: false }), null),
    ).toBe(false);
    expect(threadHasUnshippedWork(thread(), git({ ...changed, refName: "other" }), null)).toBe(
      false,
    );
    expect(threadHasUnshippedWork(thread(), null, null)).toBe(false);
  });
  it("counts only new work after a pull request merged", () => {
    const merged = { url: "u", number: 1, state: "merged" as const };
    expect(threadHasUnshippedWork(thread(), git({ aheadOfDefaultCount: 3 }), merged)).toBe(false);
    expect(threadHasUnshippedWork(thread(), git({ aheadCount: 1 }), merged)).toBe(true);
  });
});

describe("threadCardActions", () => {
  const kinds = (input: Parameters<typeof threadCardActions>[0]) =>
    threadCardActions(input).map((action) => action.kind);
  it("always offers to view the thread, and nothing it has no data for", () => {
    expect(kinds({ thread: thread(), git: null, pullRequest: null, canChange: true })).toEqual([
      "view_thread",
    ]);
  });
  it("offers Create PR for unshipped work without an open pull request", () => {
    const changed = git({ hasWorkingTreeChanges: true });
    expect(kinds({ thread: thread(), git: changed, pullRequest: null, canChange: true })).toEqual([
      "view_thread",
      "create_pr",
    ]);
    expect(kinds({ thread: thread(), git: changed, pullRequest: null, canChange: false })).toEqual([
      "view_thread",
    ]);
    const open = { url: "u", number: 3, state: "open" as const };
    expect(
      threadCardActions({ thread: thread(), git: changed, pullRequest: open, canChange: true }),
    ).toEqual([{ kind: "view_thread" }, { kind: "view_pr", ...open }]);
  });
  it("offers both after a pull request closed and new work arrived", () => {
    const closed = { url: "u", number: 3, state: "closed" as const };
    expect(
      kinds({
        thread: thread(),
        git: git({ hasWorkingTreeChanges: true }),
        pullRequest: closed,
        canChange: true,
      }),
    ).toEqual(["view_thread", "create_pr", "view_pr"]);
  });
});
