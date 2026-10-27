import { describe, expect, it } from "vite-plus/test";

import {
  linkedWorktreeGitDir,
  onlyDependencyIgnores,
  ORPHAN_WORKTREE_IDLE_MS,
  orphanWorktreeRemovable,
  type OrphanWorktreeFacts,
} from "./orphanWorktrees.ts";

const finished: OrphanWorktreeFacts = {
  branch: "fix/done",
  hasWorkingTreeChanges: false,
  onlyDependencyIgnores: true,
  unpushedCommits: 0,
  pullRequestState: "merged",
  integratedInDefault: false,
  idleMs: ORPHAN_WORKTREE_IDLE_MS,
};

describe("orphan worktree removal", () => {
  it("removes a clean, pushed worktree whose PR merged and that sat idle a day", () => {
    expect(orphanWorktreeRemovable(finished)).toBe(true);
  });

  it("removes a closed PR's worktree only when nothing is unpushed", () => {
    expect(orphanWorktreeRemovable({ ...finished, pullRequestState: "closed" })).toBe(true);
    expect(
      orphanWorktreeRemovable({ ...finished, pullRequestState: "closed", unpushedCommits: 1 }),
    ).toBe(false);
  });

  it("removes a squash-merged branch with local commits only when its content is on main", () => {
    expect(orphanWorktreeRemovable({ ...finished, unpushedCommits: 2 })).toBe(false);
    expect(
      orphanWorktreeRemovable({ ...finished, unpushedCommits: 2, integratedInDefault: true }),
    ).toBe(true);
  });

  it("keeps work that may still be in progress", () => {
    expect(orphanWorktreeRemovable({ ...finished, pullRequestState: "open" })).toBe(false);
    expect(orphanWorktreeRemovable({ ...finished, pullRequestState: null })).toBe(false);
    expect(orphanWorktreeRemovable({ ...finished, hasWorkingTreeChanges: true })).toBe(false);
    expect(orphanWorktreeRemovable({ ...finished, onlyDependencyIgnores: false })).toBe(false);
    expect(orphanWorktreeRemovable({ ...finished, idleMs: Number.NaN })).toBe(false);
    expect(orphanWorktreeRemovable({ ...finished, idleMs: Infinity })).toBe(false);
    expect(orphanWorktreeRemovable({ ...finished, idleMs: ORPHAN_WORKTREE_IDLE_MS - 1 })).toBe(
      false,
    );
  });

  it("removes a detached review checkout only when its commit is on a remote", () => {
    const detached = { ...finished, branch: null, pullRequestState: null };
    expect(orphanWorktreeRemovable(detached)).toBe(true);
    expect(orphanWorktreeRemovable({ ...detached, unpushedCommits: 1 })).toBe(false);
  });

  it("treats only dependency installs as safe ignored files", () => {
    expect(onlyDependencyIgnores("")).toBe(true);
    expect(onlyDependencyIgnores("node_modules/\0apps/web/node_modules/\0")).toBe(true);
    expect(onlyDependencyIgnores("node_modules/\0.env\0")).toBe(false);
    expect(onlyDependencyIgnores(".cache/\0")).toBe(false);
  });

  it("reads the gitdir of a linked worktree only", () => {
    expect(linkedWorktreeGitDir("gitdir: /repo/.git/worktrees/fix-done\n")).toBe(
      "/repo/.git/worktrees/fix-done",
    );
    expect(linkedWorktreeGitDir("gitdir: ../.git/modules/sub\n")).toBeNull();
    expect(linkedWorktreeGitDir("not a gitdir file")).toBeNull();
  });
});
