import { describe, expect, it } from "vite-plus/test";

import {
  parseIncrementReviewPolicy,
  parseReviewRecordHeader,
  reviewPolicyAccepts,
} from "./reviewPolicy.ts";

describe("parseIncrementReviewPolicy", () => {
  it("reads a family with a model, depth and requirement, and stops at the next heading", () => {
    const spec = [
      "# 1324 Demo",
      "",
      "## Review",
      "- Reviewer: openai (gpt-6.1-sol)",
      "- **Depth**: deep   # Sol at xhigh",
      "- Required: yes",
      "",
      "## Tasks",
      "- Required: no",
    ].join("\n");
    expect(parseIncrementReviewPolicy(spec)).toEqual({
      family: "openai",
      model: "gpt-6.1-sol",
      depth: "deep",
      required: true,
    });
  });

  it("reads a bare model id, cross-family and a section with only Required", () => {
    expect(parseIncrementReviewPolicy("## Review\n- Reviewer: claude-opus-5-5\n")).toEqual({
      family: "claude",
      model: "claude-opus-5-5",
    });
    expect(parseIncrementReviewPolicy("## Review\n- Reviewer: cross-family\n")).toEqual({
      family: "cross-family",
    });
    expect(parseIncrementReviewPolicy("## Review\n- Required: yes\n")).toEqual({
      family: "cross-family",
      required: true,
    });
  });

  it("returns null without a section or with an empty one", () => {
    expect(parseIncrementReviewPolicy("# T\n\n## Approach\n")).toBeNull();
    expect(parseIncrementReviewPolicy("## Review\n\nSomething else.\n")).toBeNull();
  });
});

describe("review records", () => {
  it("parses the record line SpecWeave writes and drops a head that is not a commit", () => {
    const header =
      "<!-- specweave review: reviewer=gpt-6.1-sol model=gpt-6.1-sol family=openai author=claude depth=deep repo=repositories/acme/app base=abc1234 head=3f9a2c1d at=2026-11-13T21:00:00Z -->\n# Review";
    expect(parseReviewRecordHeader(header)).toEqual({
      reviewer: "gpt-6.1-sol",
      model: "gpt-6.1-sol",
      family: "openai",
      author: "claude",
      depth: "deep",
      repo: "repositories/acme/app",
      head: "3f9a2c1d",
      at: "2026-11-13T21:00:00Z",
    });
    expect(
      parseReviewRecordHeader("<!-- specweave review: reviewer=codex family=openai head=HEAD -->")
        ?.head,
    ).toBeNull();
    expect(parseReviewRecordHeader("# Review\nVerdict: ship")).toBeNull();
  });

  it("accepts by family, pinned model and cross-family against the author", () => {
    expect(reviewPolicyAccepts({ family: "cross-family" }, { family: "openai" }, "claude")).toBe(
      true,
    );
    expect(reviewPolicyAccepts({ family: "cross-family" }, { family: "claude" }, "claude")).toBe(
      false,
    );
    expect(
      reviewPolicyAccepts({ family: "openai" }, { family: "openai", model: "gpt-6-luna" }, null),
    ).toBe(true);
    expect(
      reviewPolicyAccepts(
        { family: "openai", model: "gpt-6.1-sol" },
        { family: "openai", model: "gpt-6-luna" },
        "claude",
      ),
    ).toBe(false);
  });
});
