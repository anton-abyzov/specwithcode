import { describe, expect, it } from "vite-plus/test";

import { defersPullRequestWatchToParent } from "./pullRequestWatchPolicy.ts";

describe("defersPullRequestWatchToParent", () => {
  const thread = (parentThreadId: string | null, relationshipToParent: string | null) => ({
    projectId: "project-1",
    lineage: { parentThreadId, relationshipToParent },
  });

  it("lets a top-level thread and a coordinator's worker watch", () => {
    expect(defersPullRequestWatchToParent(thread(null, null))).toBe(false);
    expect(
      defersPullRequestWatchToParent(thread("project-coordinator:project-1", "subagent")),
    ).toBe(false);
  });

  it("defers for a thread's own subagent and for another project's coordinator", () => {
    expect(defersPullRequestWatchToParent(thread("thread-1", "subagent"))).toBe(true);
    expect(
      defersPullRequestWatchToParent(thread("project-coordinator:project-2", "subagent")),
    ).toBe(true);
  });
});
