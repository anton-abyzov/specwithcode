import { describe, expect, it } from "vite-plus/test";

import {
  type FolderLayout,
  holdsSeparateClones,
  recommendedWorkspace,
  workspaceGuidance,
  worktreesCutFromLayout,
  worktreesSettingRecommendation,
  worktreesSwitchDiffers,
} from "./folderLayoutGuidance";

const layout = (overrides: Partial<FolderLayout> = {}): FolderLayout => ({
  kind: "single",
  rootIsRepository: true,
  repositories: [],
  repositoryCount: 0,
  truncated: false,
  separateClones: false,
  ...overrides,
});
const umbrella = layout({
  kind: "umbrella",
  repositories: ["repositories/acme/api", "repositories/acme/web", "repositories/acme/ui"],
  repositoryCount: 3,
  separateClones: true,
});
const services = layout({
  kind: "nested",
  rootIsRepository: false,
  repositories: ["billing", "gateway"],
  repositoryCount: 2,
  separateClones: true,
});

describe("workspace recommendation by folder layout", () => {
  it("recommends worktrees for an umbrella, also when its root is no repository", () => {
    expect(recommendedWorkspace(umbrella)).toBe("worktree");
    expect(recommendedWorkspace({ ...umbrella, rootIsRepository: false })).toBe("worktree");
    expect(workspaceGuidance(umbrella)?.detail).toBe(
      "This folder holds 3 repositories. Each thread gets its own folder and a worktree of only the repositories it changes.",
    );
  });

  it("recommends worktrees for sibling service clones", () => {
    expect(recommendedWorkspace(services)).toBe("worktree");
    expect(workspaceGuidance(services)?.title).toBe("Several repositories: worktrees recommended");
  });

  it("recommends worktrees for one Git repository, submodules included", () => {
    expect(recommendedWorkspace(layout())).toBe("worktree");
    const submodules = layout({ kind: "nested", repositories: ["libs/x"], repositoryCount: 1 });
    expect(holdsSeparateClones(submodules)).toBe(false);
    expect(recommendedWorkspace(submodules)).toBe("worktree");
  });

  it("recommends nothing for a plain folder", () => {
    expect(recommendedWorkspace(layout({ kind: "plain", rootIsRepository: false }))).toBeNull();
    expect(workspaceGuidance(layout({ kind: "plain", rootIsRepository: false }))).toBeNull();
  });

  it("counts only an umbrella when an older server omits separateClones", () => {
    const { separateClones: _omitted, ...older } = umbrella;
    expect(holdsSeparateClones(older)).toBe(true);
    // Older servers count submodules as checkouts: one repo with a submodule stays one repo.
    const { separateClones: _none, ...submodule } = layout({
      kind: "nested",
      repositories: ["libs/x"],
      repositoryCount: 1,
    });
    expect(holdsSeparateClones(submodule)).toBe(false);
    expect(recommendedWorkspace(submodule)).toBe("worktree");
  });

  it("does not call one Git repository with a single stray clone multi-repository", () => {
    const stray = layout({
      kind: "nested",
      repositories: ["venv/src/pkg"],
      repositoryCount: 1,
      separateClones: true,
    });
    expect(holdsSeparateClones(stray)).toBe(false);
    expect(recommendedWorkspace(stray)).toBe("worktree");
  });

  it("recommends nothing when the walk stopped before finding any clone", () => {
    expect(recommendedWorkspace(layout({ truncated: true }))).toBeNull();
    expect(recommendedWorkspace({ ...umbrella, truncated: true })).toBe("worktree");
  });

  it("words the settings line, with what on means in a folder of clones", () => {
    expect(worktreesSettingRecommendation(umbrella)).toEqual({
      on: true,
      detail: "Each thread gets its own folder and a worktree of only the repositories it changes.",
      text: "Recommended for this folder: on. Each thread gets its own folder and a worktree of only the repositories it changes.",
    });
    expect(worktreesSettingRecommendation(layout())).toEqual({
      on: true,
      detail: null,
      text: "Recommended for this folder: on.",
    });
    expect(
      worktreesSettingRecommendation(layout({ kind: "plain", rootIsRepository: false })),
    ).toBeNull();
  });

  it("says what the switch acts on", () => {
    expect(worktreesCutFromLayout(umbrella)).toBe(
      "Worktrees are cut from the 3 repositories in this folder.",
    );
    expect(worktreesCutFromLayout(layout())).toBe(
      "Worktrees are cut from this folder's repository.",
    );
    expect(worktreesCutFromLayout(layout({ kind: "plain", rootIsRepository: false }))).toBe(
      "This folder holds no Git repository, so threads work in the folder.",
    );
  });

  it("names a switch that differs from the folder's recommendation, and nothing when they agree", () => {
    expect(worktreesSwitchDiffers(umbrella, false)).toEqual({
      recommendedOn: true,
      text: "Use worktrees is off. Recommended for this folder: on.",
      offer: "Also turn Use worktrees on",
    });
    expect(worktreesSwitchDiffers(umbrella, true)).toBeNull();
    expect(
      worktreesSwitchDiffers(layout({ kind: "plain", rootIsRepository: false }), true),
    ).toBeNull();
  });
});
