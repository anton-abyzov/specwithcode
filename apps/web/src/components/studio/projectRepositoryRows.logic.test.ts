import { describe, expect, it } from "vite-plus/test";
import type { ProjectFoundRepository } from "@specweave-studio/contracts";
import {
  absentRowHint,
  cloneFolderError,
  defaultCloneFolder,
  insideProjectFolder,
  olderServerLine,
  orderedRows,
  redundantEntriesLine,
  repositoriesLead,
  repositoryRowStatus,
  repositoryRowSummary,
  resolveCloneFolder,
  skippedLinkLine,
  worktreesCutFrom,
} from "./projectRepositoryRows.logic";

export const row = (overrides: Partial<ProjectFoundRepository> = {}): ProjectFoundRepository => ({
  relativePath: "repositories/acme/api",
  path: "/work/repositories/acme/api",
  name: "api",
  origin: "acme/api",
  branch: "main",
  defaultBranch: "main",
  inSpecweave: false,
  state: "available",
  noRemote: false,
  threadWorktrees: 0,
  ...overrides,
});
const seven = Array.from({ length: 7 }, (_, index) =>
  row({ relativePath: `repositories/acme/r${index}`, name: `r${index}` }),
);

describe("repository list wording", () => {
  it("says what the folder holds", () => {
    expect(repositoriesLead({ found: seven, rootIsRepository: true })).toBe(
      "This folder holds 7 Git repositories. Threads can use any of them. The agent picks the ones a task changes, and the thread gets its own worktree of only those.",
    );
    expect(repositoriesLead({ found: [row()], foundMore: 0 })).toContain(
      "This folder holds 1 Git repository.",
    );
    expect(repositoriesLead({ found: seven, foundMore: 60, foundTruncated: true })).toContain(
      "67 or more Git repositories",
    );
    expect(repositoriesLead({ found: [], rootIsRepository: true })).toBe(
      "This project is one Git repository: the project folder.",
    );
    expect(repositoriesLead({ found: [] })).toBe("This folder holds no Git repository.");
    // A repository that still needs cloning is listed, not counted as held.
    expect(repositoriesLead({ found: [row(), row({ state: "absent" })] })).toContain("holds 1 Git");
  });

  it("says what the Use worktrees switch acts on", () => {
    expect(worktreesCutFrom({ found: seven })).toBe(
      "Worktrees are cut from the 7 repositories in this folder.",
    );
    expect(worktreesCutFrom({ found: [], rootIsRepository: true })).toBe(
      "Worktrees are cut from this folder's repository.",
    );
    expect(worktreesCutFrom({ found: [] })).toBe(
      "This folder holds no Git repository, so threads work in the folder.",
    );
  });

  it("gives each row one status and only the buttons it needs", () => {
    expect(repositoryRowStatus(row())).toEqual({
      label: "Available",
      tone: "ok",
      note: null,
      actions: ["details"],
    });
    expect(repositoryRowStatus(row({ noRemote: true, origin: null })).note).toBe(
      "no remote, so no pull request",
    );
    expect(repositoryRowStatus(row({ state: "absent", inSpecweave: true }))).toMatchObject({
      label: "Not on this machine",
      actions: ["clone"],
    });
    expect(repositoryRowStatus(row({ state: "missing", repositoryId: "x" }))).toMatchObject({
      label: "Folder missing",
      actions: ["clone_again", "remove"],
    });
    for (const state of ["available", "absent", "missing"] as const)
      expect(repositoryRowStatus(row({ state })).label).not.toMatch(/unknown|mismatch/iu);
  });

  it("summarises a row and orders clones first", () => {
    expect(repositoryRowSummary(row({ branch: null, threadWorktrees: 2 }))).toBe(
      "repositories/acme/api · acme/api · no branch checked out · 2 thread worktrees",
    );
    expect(repositoryRowSummary(row({ threadWorktrees: 1 }))).toBe(
      "repositories/acme/api · acme/api · on main · 1 thread worktree",
    );
    expect(repositoryRowSummary(row({ state: "absent", branch: null }))).toBe(
      "repositories/acme/api · acme/api",
    );
    expect(absentRowHint(row({ state: "absent", inSpecweave: true }))).toBe(
      "SpecWeave lists it at repositories/acme/api. Clone puts it there.",
    );
    expect(
      orderedRows([
        row({ state: "missing", name: "c" }),
        row({ state: "absent", name: "b" }),
        row(),
      ]).map((item) => item.state),
    ).toEqual(["available", "absent", "missing"]);
  });

  it("names skipped links and saved entries no longer needed", () => {
    expect(
      skippedLinkLine({
        path: "repositories/a/specweave-studio",
        target: "repositories/a/specwithcode-dev",
      }),
    ).toEqual({ name: "specweave-studio", rest: "is a link to specwithcode-dev." });
    expect(skippedLinkLine({ path: "out", target: null }).rest).toBe(
      "is a link to a repository outside this folder.",
    );
    const saved = [
      { id: "a", url: "https://github.com/acme/specwithcode-dev.git" },
      { id: "b", url: "git@github.com:acme/specwithcode.git" },
    ];
    expect(
      redundantEntriesLine(
        [
          { repositoryId: "a", reason: "found_clone" },
          { repositoryId: "b", reason: "no_folder" },
        ],
        saved,
      ),
    ).toEqual({
      text: "2 saved entries from before are no longer needed: specwithcode-dev (its folder is in the list) and specwithcode (no folder).",
      button: "Remove both",
      ids: ["a", "b"],
    });
    expect(
      redundantEntriesLine([{ repositoryId: "a", reason: "found_clone" }], saved),
    ).toMatchObject({
      text: expect.stringContaining("1 saved entry from before is no longer needed"),
      button: "Remove",
    });
    // An entry already removed from the draft is not named again.
    expect(redundantEntriesLine([{ repositoryId: "gone", reason: "no_folder" }], saved)).toBeNull();
    expect(olderServerLine("studio")).toBe(
      "Update SpecWithCode on studio to find the repositories in this folder.",
    );
  });

  it("places a new clone inside the project folder", () => {
    expect(defaultCloneFolder("https://github.com/acme/tool.git", seven)).toBe(
      "repositories/acme/tool",
    );
    expect(defaultCloneFolder("git@github.com:acme/tool.git", [])).toBe("tool");
    expect(
      defaultCloneFolder("https://github.com/acme/tool", [row({ relativePath: "apps/api" })]),
    ).toBe("tool");
    expect(defaultCloneFolder("nope", [])).toBe("");
    expect(resolveCloneFolder("/work/umb/", "repositories/acme/tool")).toBe(
      "/work/umb/repositories/acme/tool",
    );
    expect(resolveCloneFolder("/work/umb", "/elsewhere/tool")).toBe("/elsewhere/tool");
    expect(resolveCloneFolder("C:\\work\\umb", "repositories/acme/tool")).toBe(
      "C:\\work\\umb\\repositories\\acme\\tool",
    );
    expect(cloneFolderError("repositories/acme/tool")).toBeNull();
    expect(cloneFolderError("")).not.toBeNull();
    expect(cloneFolderError("~/tool")).toContain("~ is not expanded");
    expect(cloneFolderError("../tool")).not.toBeNull();
    expect(cloneFolderError("https://github.com/acme/tool")).toBe("This is a folder, not a URL.");
    expect(insideProjectFolder("/work/umb", "/work/umb/repositories/x")).toBe(true);
    expect(insideProjectFolder("/work/umb", "/work/umb")).toBe(true);
    expect(insideProjectFolder("/work/umb", "/work/umbrella")).toBe(false);
    expect(insideProjectFolder("C:\\work\\umb", "C:\\work\\umb\\api")).toBe(true);
  });
});
