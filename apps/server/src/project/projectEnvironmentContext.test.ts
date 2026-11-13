import { describe, expect, it } from "@effect/vitest";

import type { ProjectRepositoryDiscovery } from "./ProjectRepositoryDiscovery.ts";
import { projectEnvironmentContext, worktreeSwitchLine } from "./projectEnvironmentContext.ts";

const root = "/work/umb";
const clone = (name: string, extra: Partial<ProjectRepositoryDiscovery["found"][number]> = {}) => ({
  relativePath: `repositories/acme/${name}`,
  path: `${root}/repositories/acme/${name}`,
  name,
  origin: `acme/${name}`,
  branch: "main",
  defaultBranch: "main",
  inSpecweave: false,
  state: "available" as const,
  noRemote: false,
  threadWorktrees: 0,
  ...extra,
});
const discovery = (
  patch: Partial<ProjectRepositoryDiscovery> = {},
): ProjectRepositoryDiscovery => ({
  root,
  kind: "umbrella",
  rootIsRepository: true,
  separateClones: true,
  found: [
    clone("app", { repositoryId: "saved-app" }),
    clone("tool", { origin: null, noRemote: true, branch: null }),
  ],
  foundMore: 0,
  truncated: false,
  skippedLinks: [],
  redundantEntries: [
    { repositoryId: "saved-app", reason: "found_clone" },
    { repositoryId: "never-cloned", reason: "no_folder" },
  ],
  ...patch,
});

describe("projectEnvironmentContext", () => {
  it("shows one list: no redundant saved entries, no approved folders inside the project folder", () => {
    const text = projectEnvironmentContext({
      kind: "code",
      workspaceRoot: root,
      environment: {
        additionalFolders: [`${root}/repositories/acme/app`, "/elsewhere/docs"],
        repositories: [
          {
            id: "saved-app",
            url: "https://github.com/acme/app.git",
            localPath: `${root}/repositories/acme/app`,
          },
          { id: "never-cloned", url: "https://github.com/acme/app.git", localPath: null },
          { id: "outside", url: "https://github.com/acme/site.git", localPath: "/elsewhere/site" },
        ],
      },
      discovery: discovery(),
      usesWorktrees: false,
    });
    const [json, ...rest] = text.split("\n");
    expect(JSON.parse(json!)).toEqual({
      kind: "code",
      workspaceRoot: root,
      additionalFolders: ["/elsewhere/docs"],
      repositories: [
        { id: "outside", url: "https://github.com/acme/site.git", localPath: "/elsewhere/site" },
      ],
    });
    expect(rest[0]).toBe(
      "Use worktrees is off for this project: threads work in the project folder, on whatever branch is checked out there.",
    );
    expect(rest.join("\n")).toContain(
      "- app: repositories/acme/app (acme/app, on main, saved as saved-app)",
    );
    expect(rest.join("\n")).toContain(
      "- tool: repositories/acme/tool (no remote, so no pull request, no branch checked out)",
    );
    expect(text).not.toContain("never-cloned");
  });
});

describe("worktreeSwitchLine", () => {
  it("says what a new thread gets for each folder and switch", () => {
    expect(worktreeSwitchLine({ discovery: discovery(), usesWorktrees: true })).toBe(
      "Use worktrees is on for this project: a new thread gets its own folder with a worktree of each repository its task names by path, and adds others with studio_worktree_add_repository.",
    );
    expect(
      worktreeSwitchLine({
        discovery: discovery({ kind: "single", separateClones: false, found: [] }),
        usesWorktrees: true,
      }),
    ).toBe(
      "Use worktrees is on for this project: a new thread gets its own worktree of the project folder's repository.",
    );
    for (const usesWorktrees of [true, false, null])
      expect(
        worktreeSwitchLine({
          discovery: discovery({
            kind: "plain",
            rootIsRepository: false,
            separateClones: false,
            found: [],
          }),
          usesWorktrees,
        }),
      ).toBe("This folder holds no Git repository, so threads work in the folder.");
    // Not a repository and no clone of its own, even with a repository saved outside it.
    expect(
      worktreeSwitchLine({
        discovery: discovery({ kind: "nested", rootIsRepository: false, separateClones: false }),
        usesWorktrees: true,
      }),
    ).toBe(
      "The project folder is not a Git repository and holds no clone of its own, so threads work in the folder.",
    );
    expect(worktreeSwitchLine({ discovery: discovery(), usesWorktrees: null })).toBeNull();
    expect(worktreeSwitchLine({ discovery: null, usesWorktrees: true })).toBeNull();
  });
});
