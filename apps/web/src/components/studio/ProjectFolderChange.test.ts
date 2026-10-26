import { describe, expect, it } from "vite-plus/test";

import {
  changedSummary,
  layoutSummary,
  nestedProjectsSummary,
  planningSummary,
  refusalSummary,
  worktreeSourceSummary,
} from "./ProjectFolderChange";

describe("folder check summaries", () => {
  it("describes each layout with a bounded list of repositories", () => {
    expect(
      layoutSummary({
        kind: "single",
        rootIsRepository: true,
        repositories: [],
        repositoryCount: 0,
        truncated: false,
      }),
    ).toBe("One Git repository.");
    expect(
      layoutSummary({
        kind: "umbrella",
        rootIsRepository: false,
        repositories: [
          "repositories/a/one",
          "repositories/a/two",
          "repositories/b/three",
          "repositories/b/four",
        ],
        repositoryCount: 4,
        truncated: false,
      }),
    ).toBe(
      "Umbrella workspace (repositories/<owner>/<repo>) with 4 repositories: repositories/a/one, repositories/a/two, repositories/b/three and 1 more.",
    );
  });

  it("asks for confirmation only when plan cards would read other increments", () => {
    const base = { currentRoot: "/Users/me/umb/repositories/a/one" };
    expect(planningSummary(base)).toBeNull();
    expect(
      planningSummary({
        ...base,
        planning: {
          currentRoot: "/Users/me/umb",
          currentIncrements: 1,
          targetRoot: "/Users/me/umb",
          targetIncrements: 1,
          brokenLinks: [],
          changes: false,
        },
      }),
    ).toBeNull();
    expect(
      planningSummary({
        ...base,
        planning: {
          currentRoot: "/Users/me/umb",
          currentIncrements: 40,
          targetRoot: null,
          targetIncrements: 0,
          brokenLinks: ["0007-auth"],
          changes: true,
        },
      }),
    ).toEqual({
      change: "Plan cards read 40 increments in ~/umb now and would read none.",
      broken: '1 linked increment would show "not found": 0007-auth.',
      undo: "Nothing is deleted or rewritten. To go back, change the folder to ~/umb/repositories/a/one again.",
    });
  });

  it("builds the result line from the check the change was applied with", () => {
    const base = {
      currentRoot: "/umb/repositories/a/one",
      targetRoot: "/umb",
      threadCount: 3,
      keptInPlaceCount: 0,
      reboundWorktreeCount: 0,
    };
    expect(changedSummary(base)).toBe(
      "The project now uses /umb. Its threads run there from their next turn. To undo, change the folder back to /umb/repositories/a/one.",
    );
    expect(changedSummary({ ...base, threadCount: 0, reboundWorktreeCount: 1 })).toBe(
      "The project now uses /umb. New threads run there. 1 thread checkout inside the old folder now points at the same place in the new one. To undo, change the folder back to /umb/repositories/a/one.",
    );
    expect(changedSummary({ ...base, keptInPlaceCount: 1 })).toBe(
      "The project now uses /umb. 1 thread keeps running in /umb/repositories/a/one; the coordinator and new threads use /umb. To undo, change the folder back to /umb/repositories/a/one. Changing it back does not move the kept threads.",
    );
  });

  it("falls back to a plain reason when a refusal has no detail", () => {
    expect(refusalSummary({})).toBeNull();
    expect(refusalSummary({ refusal: { reason: "folder_not_directory", detail: " " } })).toBe(
      "This path is a file, not a folder.",
    );
  });

  it("mentions deleted projects only when one overlaps", () => {
    expect(nestedProjectsSummary({})).toBeNull();
    expect(nestedProjectsSummary({ nestedProjects: [] })).toBeNull();
    expect(
      nestedProjectsSummary({
        nestedProjects: [
          {
            id: "p" as never,
            title: "Umb",
            workspaceRoot: "/umb",
            relation: "contains",
            deleted: false,
          },
        ],
      }),
    ).toBe(
      'Other projects overlap this folder: "Umb" (contains it). They keep their own folders and threads.',
    );
  });

  it("names a deleted project that used exactly this folder", () => {
    expect(
      nestedProjectsSummary({
        nestedProjects: [
          {
            id: "g" as never,
            title: "Gone",
            workspaceRoot: "/umb",
            relation: "same",
            deleted: true,
          },
        ],
      }),
    ).toBe(
      'Other projects overlap this folder: "Gone" (used this folder, deleted). They keep their own folders and threads. A deleted project\'s threads, memory and routines do not come back with this change.',
    );
  });

  it("says a non-repository umbrella needs a repository for new worktrees", () => {
    const layout = {
      kind: "nested" as const,
      rootIsRepository: false,
      repositories: ["a"],
      repositoryCount: 1,
      truncated: false,
    };
    expect(worktreeSourceSummary({ sameRepository: false, layout })).toBe(
      "This folder is not a Git repository itself, so new worktree threads and routines need a repository chosen for them.",
    );
    expect(worktreeSourceSummary({ sameRepository: false })).toBeNull();
  });
});
