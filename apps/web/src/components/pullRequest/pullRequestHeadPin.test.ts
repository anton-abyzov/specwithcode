import { describe, expect, it } from "vite-plus/test";

import { mergeHeadPin, seenPullRequestHead } from "./pullRequestHeadPin";

describe("seenPullRequestHead", () => {
  it("keeps the first painted head, cached or fresh, when a read brings a newer one", () => {
    const first = seenPullRequestHead(null, "env:1", "a".repeat(40));
    expect(seenPullRequestHead(first, "env:1", "b".repeat(40))).toBe(first);
  });

  it("starts over for another pull request", () => {
    const first = seenPullRequestHead(null, "env:1", "a".repeat(40));
    expect(seenPullRequestHead(first, "env:2", "c".repeat(40))).toEqual({
      key: "env:2",
      sha: "c".repeat(40),
    });
  });

  it("takes the first head that is painted at all", () => {
    const pending = seenPullRequestHead(null, "env:1", undefined);
    expect(seenPullRequestHead(pending, "env:1", "a".repeat(40)).sha).toBe("a".repeat(40));
  });
});

describe("mergeHeadPin", () => {
  it("pins merges and auto-merge to the shown head", () => {
    expect(mergeHeadPin("merge", "abc1234")).toEqual({ expectedHeadSha: "abc1234" });
    expect(mergeHeadPin("enable-auto-merge", "abc1234")).toEqual({ expectedHeadSha: "abc1234" });
  });

  it("leaves other actions and an unknown head alone", () => {
    expect(mergeHeadPin("close", "abc1234")).toEqual({});
    expect(mergeHeadPin("merge", undefined)).toEqual({});
  });
});
