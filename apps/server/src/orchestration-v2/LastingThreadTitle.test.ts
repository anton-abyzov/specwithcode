import { assert, describe, it } from "@effect/vitest";

import { lastingThreadTitle } from "./LastingThreadTitle.ts";

describe("lastingThreadTitle", () => {
  it("drops a deadline or time window from the end of a title", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["Release all platforms in 3 hours", "Release all platforms"],
      ["Release all platforms within the next 30 min", "Release all platforms"],
      ["Ship the Linux build in under an hour", "Ship the Linux build"],
      ["Fix update dialog by Friday", "Fix update dialog"],
      ["Fix update dialog before tomorrow", "Fix update dialog"],
      ["Land open PRs until 5pm", "Land open PRs"],
      ["Land open PRs today", "Land open PRs"],
      ["Fix sign-in, ASAP", "Fix sign-in"],
      ["Release all platforms in 3 hours today.", "Release all platforms"],
    ];
    for (const [title, expected] of cases) {
      assert.strictEqual(lastingThreadTitle(title), expected, title);
    }
  });

  it("keeps a title whose time words are its subject", () => {
    const titles = [
      "Update now button stays disabled",
      "Fix 3 hours of missing usage history",
      "Today view loads slowly",
      "Sessions expire after 24 hours of idle",
      "Thread naming rules",
      "Cut cold start time in half",
    ];
    for (const title of titles) {
      assert.strictEqual(lastingThreadTitle(title), title, title);
    }
  });

  it("keeps a title that would be left with one word", () => {
    assert.strictEqual(lastingThreadTitle("Release in 3 hours"), "Release in 3 hours");
    assert.strictEqual(lastingThreadTitle("  Deploy today "), "Deploy today");
  });
});
