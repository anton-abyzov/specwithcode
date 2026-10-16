import { describe, expect, it } from "vite-plus/test";

import { buildFixCheckPrompt, buildReviewPullRequestPrompt } from "./codeReview.logic";
import { pullRequestReadiness } from "./pullRequestReadiness.logic";

const pr = {
  number: 42,
  title: "Add the thing",
  url: "https://github.com/acme/app/pull/42",
  headBranch: "feat/thing",
  baseBranch: "main",
};

describe("buildFixCheckPrompt", () => {
  it("fences the failing log so backticks inside it cannot close the block", () => {
    const prompt = buildFixCheckPrompt({
      ...pr,
      checkName: "test",
      checkUrl: "https://github.com/acme/app/actions/runs/1/job/2",
      log: "expected ``` to equal 1",
      logTruncated: true,
      logSource: "GitHub Actions job 2",
    });
    expect(prompt).toContain("````text\nexpected ``` to equal 1\n````");
    expect(prompt).toContain("GitHub Actions job 2");
    expect(prompt).toContain("last lines only");
    expect(prompt).toContain("push to the pull request's branch");
  });

  it("says how to read the log when the host returned none", () => {
    const prompt = buildFixCheckPrompt({
      ...pr,
      checkName: "lint",
      checkUrl: null,
      log: null,
      logTruncated: false,
      logSource: null,
    });
    expect(prompt).toContain("gh run view <run-id> --log-failed");
    expect(prompt).not.toContain("```");
  });
});

describe("buildReviewPullRequestPrompt", () => {
  it("asks for a read-only review of the named branches", () => {
    const prompt = buildReviewPullRequestPrompt({ ...pr, title: "Line one\nline two" });
    expect(prompt).toContain('"Line one line two"');
    expect(prompt).toContain("`feat/thing` into `main`");
    expect(prompt).toContain("read-only review");
  });
});

describe("pullRequestReadiness", () => {
  const base = {
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    checks: [],
    outcomes: [],
    requestedReviewers: 0,
  };

  it("is ready when nothing blocks and nothing is pending", () => {
    const readiness = pullRequestReadiness({
      ...base,
      checks: [{ name: "ci", status: "success", description: null, url: null }],
      outcomes: [{ outcome: "approved", stale: false }],
    });
    expect(readiness.headline).toBe("Ready to merge");
    expect(readiness.items.map((item) => item.tone)).toEqual(["done", "done", "done"]);
  });

  it("is blocked by a failing check, a change request or a conflict", () => {
    expect(
      pullRequestReadiness({
        ...base,
        checks: [{ name: "ci", status: "failure", description: null, url: null }],
      }).tone,
    ).toBe("blocked");
    expect(
      pullRequestReadiness({ ...base, outcomes: [{ outcome: "changes-requested", stale: false }] })
        .tone,
    ).toBe("blocked");
    expect(pullRequestReadiness({ ...base, mergeability: "conflicting" }).tone).toBe("blocked");
  });

  it("waits on running checks and requested reviewers", () => {
    const readiness = pullRequestReadiness({
      ...base,
      checks: [{ name: "ci", status: "pending", description: null, url: null }],
      requestedReviewers: 2,
    });
    expect(readiness.headline).toBe("Almost ready");
    expect(readiness.items[1]?.label).toBe("Waiting on 2 reviewers");
  });

  it("has nothing to get ready once merged", () => {
    expect(pullRequestReadiness({ ...base, state: "merged" })).toEqual({
      headline: "Merged",
      tone: "done",
      items: [],
    });
  });
});
