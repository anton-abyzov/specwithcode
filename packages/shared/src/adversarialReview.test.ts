import * as DateTime from "effect/DateTime";
import {
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  defaultReviewerChain,
  describeReviewerOrder,
  resolveReviewer,
  reviewerChain,
} from "./adversarialReview.ts";
import { newestOfFamily, tierModelFor } from "./modelTiers.ts";

const now = Date.parse("2026-11-04T08:00:00.000Z");
const fresh = DateTime.formatIso(DateTime.makeUnsafe(now));

function provider(
  id: string,
  driver: string,
  slugs: ReadonlyArray<string>,
  used: number | null,
  over: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: fresh,
    version: null,
    models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    ...(used === null
      ? {}
      : {
          usageLimits: {
            checkedAt: fresh,
            windows: [
              {
                id: "seven_day",
                kind: "weekly",
                label: "Weekly",
                usedPercent: used,
                resetsAt: "2026-11-06T00:00:00.000Z",
              },
            ],
          },
        }),
    ...over,
  };
}

const sel = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

const claude = provider("claudeAgent", "claudeAgent", ["claude-opus-5-5", "claude-fable-5-1"], 20);
const codex = provider("codex", "codex", ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"], 30);
const copilot = provider(
  "copilot",
  "acpRegistry",
  ["claude-opus-5.5", "gpt-6.1-sol", "auto"],
  null,
  { iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg" },
);
const muse = provider("muse", "muse", ["muse-wonder-1.0", "muse-wonder-full-1.0"], 10);
const providers = [claude, codex, copilot, muse];
const author = sel("claudeAgent", "claude-opus-5-5");

describe("tierModelFor", () => {
  it("uses the built-in regular and frontier models", () => {
    expect(tierModelFor(claude, "regular")).toBe("claude-opus-5-5");
    // The literal names Fable 5.2; a provider still on 5.1 keeps its newest Fable.
    expect(tierModelFor(claude, "frontier")).toBe("claude-fable-5-1");
    expect(tierModelFor(codex, "regular")).toBe("gpt-6.1-sol");
    expect(tierModelFor(codex, "frontier")).toBe("gpt-6-astra");
    expect(tierModelFor(muse, "frontier")).toBe("muse-wonder-full-1.0");
  });

  it("follows a built-in default to the newest listed release of its family", () => {
    const newer = provider(
      "claudeAgent",
      "claudeAgent",
      [
        "claude-opus-5-5",
        "claude-fable-5-1",
        "claude-fable-5-2",
        "claude-fable-6",
        "claude-haiku-4-5-20251001",
      ],
      20,
    );
    expect(tierModelFor(newer, "frontier")).toBe("claude-fable-6");
    expect(tierModelFor(newer, "regular")).toBe("claude-opus-5-5");
    expect(tierModelFor(newer, "frontier", { claudeAgent: { frontier: "claude-fable-5-1" } })).toBe(
      "claude-fable-5-1",
    );
    expect(newestOfFamily(newer, "gpt-6-astra")).toBeUndefined();
    // A provider without its own entry (Copilot) still follows the Fable family.
    const borrowed = provider(
      "copilot",
      "acpRegistry",
      ["claude-opus-5.5", "claude-fable-5.1"],
      null,
    );
    expect(tierModelFor(borrowed, "frontier")).toBe("claude-fable-5.1");
    expect(newestOfFamily(muse, "muse-wonder-1.0")).toBe("muse-wonder-1.0");
  });

  it("prefers the person's choice for the instance, then for the driver", () => {
    expect(tierModelFor(codex, "regular", { codex: { regular: "gpt-6-luna" } })).toBe("gpt-6-luna");
    expect(
      tierModelFor(codex, "regular", {
        codex: { regular: "gpt-6-luna" },
        [codex.instanceId]: { regular: "gpt-6-astra" },
      }),
    ).toBe("gpt-6-astra");
  });

  it("borrows another driver's tier model on a provider without its own", () => {
    expect(tierModelFor(copilot, "regular")).toBe("gpt-6.1-sol");
  });

  it("falls back from frontier to regular and never returns an unlisted model", () => {
    const small = provider("codex-2", "codex", ["gpt-6.1-sol"], 0);
    expect(tierModelFor(small, "frontier")).toBe("gpt-6.1-sol");
    expect(tierModelFor(provider("codex-3", "codex", ["gpt-6-luna"], 0), "regular")).toBe(
      undefined,
    );
  });
});

describe("reviewerChain", () => {
  it("puts other families first and the author's family last", () => {
    expect(defaultReviewerChain({ providers, tier: "regular" })).toEqual([
      sel("codex", "gpt-6.1-sol"),
      sel("copilot", "gpt-6.1-sol"),
      sel("muse", "muse-wonder-1.0"),
      sel("claudeAgent", "claude-opus-5-5"),
    ]);
  });

  it("follows each named reviewer with the same model on other providers", () => {
    expect(
      reviewerChain({ providers, reviewers: [sel("codex", "gpt-6.1-sol")], tier: "regular" }),
    ).toEqual([sel("codex", "gpt-6.1-sol"), sel("copilot", "gpt-6.1-sol")]);
  });
});

describe("resolveReviewer", () => {
  it("picks Codex Sol for work Claude did", () => {
    const result = resolveReviewer({
      providers,
      author,
      reviewers: [],
      tier: "regular",
      nowMs: now,
    });
    expect(result.reviewer).toEqual(sel("codex", "gpt-6.1-sol"));
    expect(result.authorFamily).toBe("claude");
    expect(result.skipped).toEqual([]);
  });

  it("falls through to Sol on Copilot when Codex is limited", () => {
    const result = resolveReviewer({
      providers,
      author,
      reviewers: [sel("codex", "gpt-6.1-sol"), sel("muse", "muse-wonder-1.0")],
      tier: "regular",
      nowMs: now,
      limitedInstanceIds: new Set(["codex"]),
    });
    // Copilot reports no usage, so a Muse with verified room is not preferred over it:
    // the order is the person's, and Copilot is ready.
    expect(result.reviewer).toEqual(sel("copilot", "gpt-6.1-sol"));
    expect(result.skipped).toEqual([{ selection: sel("codex", "gpt-6.1-sol"), reason: "limited" }]);
  });

  it("never reviews Claude work with Claude through Copilot", () => {
    const result = resolveReviewer({
      providers: [claude, copilot],
      author,
      reviewers: [sel("copilot", "claude-opus-5.5")],
      tier: "regular",
      nowMs: now,
    });
    expect(result.reviewer).toBe(null);
    expect(result.skipped).toEqual([
      { selection: sel("copilot", "claude-opus-5.5"), reason: "same-family" },
      { selection: sel("claudeAgent", "claude-opus-5-5"), reason: "same-family" },
    ]);
  });

  it("reviews Codex work with Claude", () => {
    const result = resolveReviewer({
      providers: [claude, codex],
      author: sel("codex", "gpt-6.1-sol"),
      reviewers: [],
      tier: "regular",
      nowMs: now,
    });
    expect(result.reviewer).toEqual(sel("claudeAgent", "claude-opus-5-5"));
  });

  it("uses frontier models when asked and skips signed-out and excluded entries", () => {
    const result = resolveReviewer({
      providers: [claude, { ...codex, auth: { status: "unauthenticated" } }, muse],
      author,
      reviewers: [],
      tier: "frontier",
      excludedModels: [{ model: "muse-wonder-full-1.0" }],
      nowMs: now,
    });
    expect(result.reviewer).toBe(null);
    expect(result.skipped.map((skip) => skip.reason)).toEqual([
      "signed-out",
      "excluded",
      "same-family",
    ]);
  });

  it("passes over an agent of unknown billing unless the person listed it", () => {
    const unknown = {
      ...codex,
      models: codex.models.map((model) => ({ ...model, billing: "unknown" as const })),
    };
    const listed = sel("codex", "gpt-6.1-sol");
    const byDefault = resolveReviewer({
      providers: [claude, unknown, muse],
      author,
      reviewers: [],
      tier: "regular",
      nowMs: now,
    });
    expect(byDefault.reviewer).toEqual(sel("muse", "muse-wonder-1.0"));
    expect(byDefault.skipped).toEqual([{ selection: listed, reason: "unknown-billing" }]);
    const named = resolveReviewer({
      providers: [claude, unknown, muse],
      author,
      reviewers: [listed],
      tier: "regular",
      nowMs: now,
    });
    expect(named.reviewer).toEqual(listed);
  });

  it("never lets a model of no known family review itself on another provider", () => {
    const local = provider("local", "opencode", ["qwen3.6-35b"], 5);
    const mirror = provider("mirror", "acpRegistry", ["qwen3.6-35b"], 5);
    const result = resolveReviewer({
      providers: [local, mirror, codex],
      author: sel("local", "qwen3.6-35b"),
      reviewers: [sel("mirror", "qwen3.6-35b"), sel("codex", "gpt-6.1-sol")],
      tier: "regular",
      nowMs: now,
    });
    expect(result.authorFamily).toBe("other");
    expect(result.reviewer).toEqual(sel("codex", "gpt-6.1-sol"));
    // The mirror's entry brings the author's own instance in after it.
    expect(result.skipped).toEqual([
      { selection: sel("mirror", "qwen3.6-35b"), reason: "same-family" },
      { selection: sel("local", "qwen3.6-35b"), reason: "same-family" },
    ]);
  });
});

describe("describeReviewerOrder", () => {
  it("groups the same model on other providers under its step, with statuses", () => {
    const view = describeReviewerOrder({
      providers: [
        claude,
        {
          ...codex,
          ...provider(
            "codex",
            "codex",
            codex.models.map((m) => m.slug),
            100,
          ),
        },
        copilot,
        muse,
      ],
      reviewers: [],
      tier: "regular",
      nowMs: now,
    });
    expect(view.isDefault).toBe(true);
    expect(
      view.groups.map((group) => ({
        primary: [group.primary.selection.instanceId, group.primary.status, group.primary.family],
        alternates: group.alternates.map((step) => [step.selection.instanceId, step.status]),
      })),
    ).toEqual([
      { primary: ["codex", "full", "openai"], alternates: [["copilot", "ready"]] },
      { primary: ["muse", "ready", "meta"], alternates: [] },
      { primary: ["claudeAgent", "ready", "claude"], alternates: [["copilot", "ready"]] },
    ]);
    expect(view.groups[0]!.primary.resetAt).toBe(Date.parse("2026-11-06T00:00:00.000Z"));
  });

  it("marks unknown billing unless listed, and keeps a set order as written", () => {
    const unknown = {
      ...codex,
      models: codex.models.map((model) => ({ ...model, billing: "unknown" as const })),
    };
    const byDefault = describeReviewerOrder({
      providers: [claude, unknown],
      reviewers: [],
      tier: "regular",
      nowMs: now,
    });
    expect(byDefault.groups[0]!.primary.status).toBe("unknown-billing");
    // A harder reason shows instead, but the agent is still one nobody consented to.
    const signedOut = describeReviewerOrder({
      providers: [claude, { ...unknown, auth: { status: "unauthenticated" } }],
      reviewers: [],
      tier: "regular",
      nowMs: now,
    });
    expect(signedOut.groups[0]!.primary.status).toBe("signed-out");
    expect(signedOut.groups[0]!.primary.unconsented).toBe(true);
    const named = describeReviewerOrder({
      providers: [claude, unknown],
      reviewers: [sel("claudeAgent", "claude-opus-5-5"), sel("codex", "gpt-6.1-sol")],
      tier: "regular",
      nowMs: now,
    });
    expect(named.isDefault).toBe(false);
    expect(
      named.groups.map((group) => [group.primary.selection.instanceId, group.primary.status]),
    ).toEqual([
      ["claudeAgent", "ready"],
      ["codex", "ready"],
    ]);
  });

  it("says when a listed provider is gone from this machine", () => {
    const view = describeReviewerOrder({
      providers: [claude],
      reviewers: [sel("gone", "gpt-6.1-sol")],
      tier: "regular",
      nowMs: now,
    });
    expect(view.groups[0]!.primary.status).toBe("missing");
  });
});

describe("reviewerOrderGroups", () => {
  it("keeps a listed model in its own place instead of as an earlier alternate", () => {
    const view = describeReviewerOrder({
      providers,
      reviewers: [
        sel("codex", "gpt-6.1-sol"),
        sel("copilot", "gpt-6.1-sol"),
        sel("claudeAgent", "claude-opus-5-5"),
      ],
      tier: "regular",
      nowMs: now,
    });
    expect(
      view.groups.map((group) => [
        `${group.primary.selection.instanceId}/${group.primary.selection.model}`,
        group.alternates.map((step) => `${step.selection.instanceId}/${step.selection.model}`),
      ]),
    ).toEqual([
      ["codex/gpt-6.1-sol", []],
      ["copilot/gpt-6.1-sol", []],
      ["claudeAgent/claude-opus-5-5", ["copilot/claude-opus-5.5"]],
    ]);
  });
});
