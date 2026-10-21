import { describe, expect, it } from "vite-plus/test";

import { layoutSummary, planningSummary } from "./ProjectFolderChange";

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
});
