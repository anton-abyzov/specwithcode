import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId } from "@specweave-studio/contracts";

import {
  incrementReviewRepos,
  parseIncrementReviewPolicy,
  parseReviewRecordHeader,
  resolveIncrementReviewPolicy,
  reviewConstrainedRule,
  reviewPolicyAccepts,
  registeredReviewRepos,
  reviewPolicySatisfied,
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

describe("review policy evidence (Sol review, November 13, 2026)", () => {
  it("compares canonical families: a Fable author is Claude, an unclassified reviewer never counts", () => {
    expect(reviewPolicyAccepts({ family: "cross-family" }, { family: "claude" }, "fable")).toBe(
      false,
    );
    expect(reviewPolicyAccepts({ family: "cross-family" }, { family: "unknown" }, "claude")).toBe(
      false,
    );
    expect(reviewPolicyAccepts({ family: "cross-family" }, { family: "cursor" }, "claude")).toBe(
      false,
    );
    // A record whose model belongs to another family than it claims.
    expect(
      reviewPolicyAccepts(
        { family: "openai" },
        { family: "openai", model: "claude-opus-5-5" },
        "claude",
      ),
    ).toBe(false);
  });

  it("matches a pinned model across provider spellings and needs a deep review for a deep policy", () => {
    expect(
      reviewPolicyAccepts(
        { family: "claude", model: "claude-opus-5-5" },
        { family: "claude", model: "claude-opus-5.5" },
        "openai",
      ),
    ).toBe(true);
    const deep = { family: "openai" as const, depth: "deep" as const };
    expect(reviewPolicyAccepts(deep, { family: "openai", depth: "standard" }, "claude")).toBe(
      false,
    );
    expect(reviewPolicyAccepts(deep, { family: "openai" }, "claude")).toBe(false);
    expect(reviewPolicyAccepts(deep, { family: "openai", depth: "deep" }, "claude")).toBe(true);
  });

  it("decodes percent-encoded header values and ignores an invalid time", () => {
    const header = parseReviewRecordHeader(
      "<!-- specweave review: reviewer=codex family=openai repo=repositories/acme/My%20App at=yesterday -->",
    );
    expect(header?.repo).toBe("repositories/acme/My App");
    expect(header?.at).toBeNull();
  });

  it("layers the spec over review.policy over review.crossModel", () => {
    expect(
      resolveIncrementReviewPolicy({
        spec: "## Review\n- Depth: deep\n",
        config: { policy: { reviewer: "openai", required: true } },
      }),
    ).toEqual({ family: "openai", depth: "deep", required: true });
    expect(
      resolveIncrementReviewPolicy({
        spec: "## Review\n- Reviewer: google\n- Required: no\n",
        config: { policy: { reviewer: "openai", required: true } },
      }),
    ).toEqual({ family: "google", required: false });
    expect(resolveIncrementReviewPolicy({ spec: "# T\n", config: { crossModel: true } })).toEqual({
      family: "cross-family",
      required: true,
    });
    expect(resolveIncrementReviewPolicy({ spec: null, config: null })).toBeNull();
  });

  it("judges the newest matching record in every repository", () => {
    const policy = { family: "openai" as const };
    const record = (repo: string, verdict: "ship" | "fix first") => ({
      family: "openai",
      model: "gpt-6.1-sol",
      depth: "deep",
      author: "claude",
      repo,
      verdict,
    });
    const app = "repositories/acme/app";
    const api = "repositories/acme/api";
    // Newest first: a newer fix first outranks an older ship.
    expect(
      reviewPolicySatisfied(
        policy,
        [record(app, "fix first"), record(app, "ship")],
        [app],
        "claude",
      ),
    ).toBe(false);
    expect(reviewPolicySatisfied(policy, [record(app, "ship")], [app, api], "claude")).toBe(false);
    expect(
      reviewPolicySatisfied(
        policy,
        [record(app, "ship"), record(api, "ship")],
        [app, api],
        "claude",
      ),
    ).toBe(true);
    expect(
      incrementReviewRepos(
        "- AC: AC-01 | Files: repositories/acme/app/src/a.ts, .specweave/x.md, scripts/b.sh | Test: t",
      ),
    ).toEqual([".", app]);
  });

  it("keeps underscores inside a model id and reads bold Files fields", () => {
    expect(parseIncrementReviewPolicy("## Review\n- Reviewer: openai (gpt_6_1_sol)\n")).toEqual({
      family: "openai",
      model: "gpt_6_1_sol",
    });
    expect(
      parseIncrementReviewPolicy("## Review\n- **Reviewer**: **openai** (`gpt-6.1-sol`)\n"),
    ).toEqual({ family: "openai", model: "gpt-6.1-sol" });
    expect(
      incrementReviewRepos("- **AC**: AC-01 | **Files**: repositories/acme/app/a.ts | **Test**: t"),
    ).toEqual(["repositories/acme/app"]);
  });

  it("a pinned review model narrows the limit rule to that model, across spellings", () => {
    const copilot = ProviderInstanceId.make("copilot");
    const providers = [
      {
        instanceId: copilot,
        models: [
          { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", isCustom: false, capabilities: null },
          { slug: "gpt-6-luna", name: "GPT-6 Luna", isCustom: false, capabilities: null },
          { slug: "claude-opus-5.5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
        ],
      },
    ];
    expect(
      reviewConstrainedRule(
        { providerLimitExcludedModels: [] },
        { reviewFamily: "openai", reviewModel: "gpt_6_1_sol" },
        providers,
      ).providerLimitExcludedModels,
    ).toEqual([
      { instanceId: copilot, model: "gpt-6-luna" },
      { instanceId: copilot, model: "claude-opus-5.5" },
    ]);
  });

  it("owns task Files by registered repositories first, like specweave", () => {
    const registered = registeredReviewRepos(
      {
        workspace: { repos: [{ path: "apps/web" }, { path: "/work/umb/libs/core" }] },
        umbrella: { childRepos: [{ path: "../outside" }] },
      },
      "/work/umb",
    );
    expect(registered).toEqual(["apps/web", "libs/core", "../outside"]);
    expect(
      incrementReviewRepos(
        "- AC: AC-01 | Files: apps/web/src/a.ts, libs/core/**/*.ts, repositories/x/*/a.ts, README.md | Test: t",
        registered,
      ),
    ).toEqual([".", "apps/web", "libs/core"]);
  });

  it("reads legacy Files Affected lists (Sol round 4)", () => {
    expect(
      incrementReviewRepos(
        "### T-001 API\n**Files Affected**:\n- `repositories/acme/api/a.ts`\n\n**Test Plan**:\n- `repositories/acme/other/not-a-file.ts`\n\n### T-002 App\n**Files Affected**:\n- `repositories/acme/app/b.ts`\n",
      ),
    ).toEqual(["repositories/acme/api", "repositories/acme/app"]);
  });

  it("normalizes task paths and keeps registered sibling checkouts (Sol round 3)", () => {
    const registered = registeredReviewRepos(
      {
        workspace: { repos: [{ path: "./libs/core/" }, { path: "/work/sibling" }] },
        umbrella: { childRepos: [{ path: "../outside" }] },
      },
      "/work/umb",
    );
    expect(registered).toEqual(["libs/core", "../sibling", "../outside"]);
    expect(
      incrementReviewRepos(
        "- AC: AC-01 | Files: ./libs/core/src/a.ts, ../outside/src/a.ts, ../sibling/x/../b.ts | Test: t",
        registered,
      ),
    ).toEqual(["../outside", "../sibling", "libs/core"]);
    // Unregistered paths outside the project, absolute paths and globs that
    // hide a registered owner are left out, as specweave refuses them.
    expect(
      incrementReviewRepos(
        "- AC: AC-01 | Files: ../elsewhere/a.ts, /tmp/a.ts, libs/*/a.ts, docs/./x.md | Test: t",
        registered,
      ),
    ).toEqual(["."]);
  });

  it("narrows a review thread's limit rule to its reviewer's family", () => {
    const providers = [
      {
        instanceId: ProviderInstanceId.make("copilot"),
        models: [
          { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", isCustom: false, capabilities: null },
          { slug: "claude-opus-5.5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
        ],
      },
    ];
    const rule = { providerLimitExcludedModels: [{ model: "gpt-6-luna" }] };
    expect(reviewConstrainedRule(rule, null, providers)).toBe(rule);
    expect(
      reviewConstrainedRule(rule, { reviewFamily: "openai" }, providers)
        .providerLimitExcludedModels,
    ).toEqual([
      { model: "gpt-6-luna" },
      { instanceId: ProviderInstanceId.make("copilot"), model: "claude-opus-5.5" },
    ]);
  });
});
