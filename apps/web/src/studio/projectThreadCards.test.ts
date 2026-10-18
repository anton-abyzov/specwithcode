import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  threadCardActions,
  threadCardConflict,
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
  it("offers nothing it has no data for: the card itself opens the thread", () => {
    expect(kinds({ thread: thread(), git: null, pullRequest: null, canChange: true })).toEqual([]);
  });
  it("offers Create PR for unshipped work without an open pull request", () => {
    const changed = git({ hasWorkingTreeChanges: true });
    expect(kinds({ thread: thread(), git: changed, pullRequest: null, canChange: true })).toEqual([
      "create_pr",
    ]);
    expect(kinds({ thread: thread(), git: changed, pullRequest: null, canChange: false })).toEqual(
      [],
    );
    const open = { url: "u", number: 3, state: "open" as const };
    expect(
      threadCardActions({ thread: thread(), git: changed, pullRequest: open, canChange: true }),
    ).toEqual([{ kind: "view_pr", ...open }]);
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
    ).toEqual(["create_pr", "view_pr"]);
  });
});

const conflictingLink = (
  mergeability: "mergeable" | "conflicting" | "unknown" | undefined,
  watchConflicting?: boolean,
  state: "open" | "merged" = "open",
) =>
  ({
    host: "github.com",
    repository: "acme/atlas",
    number: 288,
    url: "https://github.com/acme/atlas/pull/288",
    source: "created",
    linkedAt: "2026-10-17T00:00:00Z",
    snapshot: {
      state,
      isDraft: false,
      title: "Thread provider",
      headBranch: "claude/thread-inherit",
      baseBranch: "main",
      updatedAt: "2026-10-17T05:00:00Z",
      syncedAt: "2026-10-17T05:10:00Z",
      ...(mergeability === undefined ? {} : { mergeability }),
    },
    stack: null,
    ...(watchConflicting === undefined
      ? {}
      : { watch: { conflicting: watchConflicting } as never }),
  }) as unknown as EnvironmentThreadShell["pullRequests"][number];

describe("threadCardConflict", () => {
  const conflict = {
    headBranch: "claude/thread-inherit",
    baseBranch: "main",
    syncedAt: "2026-10-17T05:10:00Z",
  };
  it("follows the host's mergeability on the linked pull request", () => {
    expect(threadCardConflict(conflictingLink("conflicting"))).toEqual(conflict);
    expect(threadCardConflict(conflictingLink("mergeable"))).toBeNull();
    expect(threadCardConflict(conflictingLink(undefined))).toBeNull();
  });
  it("keeps the watch's verdict while the host is still computing, never over a clean answer", () => {
    expect(threadCardConflict(conflictingLink("unknown", true))).toEqual(conflict);
    expect(threadCardConflict(conflictingLink(undefined, true))).toEqual(conflict);
    expect(threadCardConflict(conflictingLink("unknown", false))).toBeNull();
    expect(threadCardConflict(conflictingLink("mergeable", true))).toBeNull();
  });
  it("says nothing once the pull request is no longer open", () => {
    expect(threadCardConflict(conflictingLink("conflicting", true, "merged"))).toBeNull();
  });
  it("rides on the card's pull request", () => {
    expect(
      threadCardPullRequest(thread({ pullRequests: [conflictingLink("conflicting")] }), null),
    ).toEqual({
      url: "https://github.com/acme/atlas/pull/288",
      number: 288,
      state: "open",
      conflict,
    });
  });
});

describe("threadCardActions with a conflicting pull request", () => {
  const pullRequest = threadCardPullRequest(
    thread({ pullRequests: [conflictingLink("conflicting")] }),
    null,
  );
  const kinds = (overrides: Partial<Parameters<typeof threadCardActions>[0]> = {}) =>
    threadCardActions({
      thread: thread(),
      git: null,
      pullRequest,
      canChange: true,
      ...overrides,
    }).map((action) => action.kind);
  it("leads with Resolve conflicts, beside View PR", () => {
    expect(kinds()).toEqual(["resolve_conflicts", "view_pr"]);
    expect(
      threadCardActions({ thread: thread(), git: null, pullRequest, canChange: true })[0],
    ).toMatchObject({
      kind: "resolve_conflicts",
      number: 288,
      conflict: { headBranch: "claude/thread-inherit", baseBranch: "main" },
    });
  });
  it("is not offered to someone who cannot change source control there", () => {
    expect(kinds({ canChange: false })).toEqual(["view_pr"]);
  });
  it("waits while the thread's agent is working", () => {
    expect(kinds({ working: true })).toEqual(["view_pr"]);
  });
  it("stays hidden after a request until a newer host read still reports the conflict", () => {
    expect(kinds({ resolveRequestedFor: "2026-10-17T05:10:00Z" })).toEqual(["view_pr"]);
    expect(kinds({ resolveRequestedFor: "2026-10-17T04:00:00Z" })).toEqual([
      "resolve_conflicts",
      "view_pr",
    ]);
  });
  it("offers nothing to resolve on a clean pull request", () => {
    const clean = threadCardPullRequest(
      thread({ pullRequests: [conflictingLink("mergeable")] }),
      null,
    );
    expect(
      threadCardActions({ thread: thread(), git: null, pullRequest: clean, canChange: true }).map(
        (action) => action.kind,
      ),
    ).toEqual(["view_pr"]);
  });
});
