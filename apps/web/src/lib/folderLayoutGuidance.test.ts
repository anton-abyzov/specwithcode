import { describe, expect, it } from "vite-plus/test";

import {
  type FolderLayout,
  holdsSeparateClones,
  recommendedWorkspace,
  workspaceGuidance,
  worktreesSettingRecommendation,
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
  it("recommends the current checkout for an umbrella, also when its root is a repository", () => {
    expect(recommendedWorkspace(umbrella)).toBe("local");
    expect(recommendedWorkspace({ ...umbrella, rootIsRepository: false })).toBe("local");
    expect(workspaceGuidance(umbrella)?.detail).toContain("an umbrella holding 3 repositories");
  });

  it("recommends the current checkout for sibling service clones", () => {
    expect(recommendedWorkspace(services)).toBe("local");
    expect(workspaceGuidance(services)?.detail).toContain(
      "a multi-repository folder holding 2 repositories",
    );
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

  it("explains a non-Git umbrella without talking about worktrees of the folder", () => {
    const detail = workspaceGuidance({ ...umbrella, rootIsRepository: false })?.detail ?? "";
    expect(detail).toContain("not a Git repository itself");
    expect(detail).not.toContain("A worktree of the folder");
  });

  it("recommends nothing when the walk stopped before finding any clone", () => {
    expect(recommendedWorkspace(layout({ truncated: true }))).toBeNull();
    expect(recommendedWorkspace({ ...umbrella, truncated: true })).toBe("local");
  });

  it("words the settings line as on or off", () => {
    expect(worktreesSettingRecommendation(umbrella)).toMatch(/^Recommended for this folder: off\./);
    expect(worktreesSettingRecommendation(layout())).toMatch(/^Recommended for this folder: on\./);
    expect(worktreesSettingRecommendation({ ...umbrella, truncated: true })).toContain(
      "3 or more repositories",
    );
  });
});
