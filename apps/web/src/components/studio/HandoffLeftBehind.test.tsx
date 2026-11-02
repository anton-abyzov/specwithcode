import { describe, expect, it } from "vite-plus/test";
import { leftBehindLine } from "./HandoffLeftBehind";

const repository = {
  path: "/repo",
  name: "repo",
  branch: "main",
  unpushedCommits: 0,
  uncommittedChanges: 0,
  branchesAhead: 0,
  branchesWithoutUpstream: 0,
};

describe("what a move leaves behind", () => {
  it("names unpushed commits, uncommitted changes and other branches in plain words", () => {
    expect(
      leftBehindLine({
        ...repository,
        unpushedCommits: 2,
        uncommittedChanges: 1,
        branchesAhead: 1,
        branchesWithoutUpstream: 3,
      }),
    ).toBe(
      "2 unpushed commits on main, 1 uncommitted change, 1 other branch ahead, 3 local-only branches",
    );
  });

  it("says when a branch has no upstream, since none of its commits can reach Git", () => {
    expect(leftBehindLine({ ...repository, branch: "fix/x", unpushedCommits: null })).toBe(
      "fix/x has no upstream",
    );
  });
});
