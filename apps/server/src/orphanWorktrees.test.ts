import { describe, expect, it } from "vite-plus/test";

import {
  linkedWorktreeGitDir,
  newestReflogEntryMs,
  onlyDependencyIgnores,
  onlyRebuildableUntracked,
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
    // A pnpm workspace link, Finder files, build info and hook shims rebuild.
    expect(
      onlyDependencyIgnores(
        "node_modules\0.DS_Store\0.repos/ref/.DS_Store\0apps/desktop/tsconfig.tsbuildinfo\0.vite-hooks/_/\0",
      ),
    ).toBe(true);
    expect(onlyDependencyIgnores(".DS_Store\0.env.local\0")).toBe(false);
    expect(onlyDependencyIgnores("data/.DS_Store.bak\0")).toBe(false);
    // A file ignored inside a tracked build or coverage folder is listed by itself.
    expect(onlyDependencyIgnores("build/.env.prod\0")).toBe(false);
    for (const folder of [
      "build",
      "dist",
      "coverage",
      ".generated",
      ".turbo",
      ".vite",
      ".docusaurus",
    ])
      expect(onlyDependencyIgnores(`${folder}/\0`)).toBe(false);
    expect(onlyDependencyIgnores("reports/x/coverage/a.log\0")).toBe(false);
    expect(onlyDependencyIgnores(".vite-hooks/pre-push\0")).toBe(false);
  });

  it("treats only the hook installer's folder as safe untracked output", () => {
    expect(onlyRebuildableUntracked("")).toBe(true);
    expect(onlyRebuildableUntracked(".vite-hooks/_/\0")).toBe(true);
    expect(onlyRebuildableUntracked(".vite-hooks/_/\0notes.md\0")).toBe(false);
    expect(onlyRebuildableUntracked("apps/.vite-hooks/\0")).toBe(false);
    expect(onlyRebuildableUntracked(".vite-hooks/pre-push\0")).toBe(false);
  });

  it("reads the newest reflog entry's own time, not the file's", () => {
    const zero = "0".repeat(40);
    const reflog = `${zero} ${"a".repeat(40)} Dev <d@example.invalid> 1793059439 -0400\tcommit: one\n${"a".repeat(40)} ${"b".repeat(40)} Dev <d@example.invalid> 1793160038 +0000\tcheckout: moving\n`;
    expect(newestReflogEntryMs(reflog)).toBe(1793160038000);
    expect(
      newestReflogEntryMs(`${zero} ${"c".repeat(40)} Dev <d@example.invalid> 1793170000 +0000\n`),
    ).toBe(1793170000000);
    expect(newestReflogEntryMs("")).toBeNull();
    expect(newestReflogEntryMs("garbage\n")).toBeNull();
  });

  it("reads the gitdir of a linked worktree only", () => {
    expect(linkedWorktreeGitDir("gitdir: /repo/.git/worktrees/fix-done\n")).toBe(
      "/repo/.git/worktrees/fix-done",
    );
    expect(linkedWorktreeGitDir("gitdir: ../.git/modules/sub\n")).toBeNull();
    expect(linkedWorktreeGitDir("not a gitdir file")).toBeNull();
  });
});
